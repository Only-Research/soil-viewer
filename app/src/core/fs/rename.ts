/**
 * Exclusive rename — every user-visible Rename, Move, Duplicate, archive-move and template
 * placement. Spec §13.6.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * **The whole module exists because v1 called plain `rename(2)` here.** That call succeeds over an
 * existing file and destroys it: no error, no confirmation, no trace, one tap, in an app whose
 * headline promise is that nothing is ever destroyed. Measured on this machine before writing a
 * line of this file — a plain rename over an occupied path left the destination's content gone and
 * returned success.
 *
 * §13.6 resolves v1's contradiction (it mandated both "rename into place" *and* "exclusive rename"
 * without distinguishing them) by naming two modes:
 *
 *   - **Replace-rename** — *only* the atomic-write temp→destination, where the destination's
 *     identity was verified moments earlier. It clobbers by design. It lives in `write.ts` and
 *     nowhere else.
 *   - **Exclusive rename** — everything a person can trigger. That is this module. **No path
 *     outside the atomic-write sequence may call `rename(2)` without exclusive semantics.**
 *
 * **How exclusivity is achieved with zero dependencies.** `RENAME_EXCL` is a macOS syscall flag
 * Node does not expose — measured three times now, and Node offers no `renamex_np` either. So:
 *
 *   - **files:** `link(src, dest)` then `unlink(src)`. `link` fails `EEXIST` from the kernel,
 *     which is exactly the atomic exclusive create needed — also measured here, along with the
 *     confirmation that the occupied file kept its own bytes.
 *   - **directories:** `lstat(dest)` must throw `ENOENT`, then `rename`. This one keeps a residual
 *     TOCTOU window. §13.6 accepts it on a single-user machine and requires it be bounded by the
 *     per-parent mutation lock. **That lock is a later unit of this phase and is not here yet** —
 *     stated rather than implied away.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isMarkdown } from '../grammar'
import {
  errnoOf,
  walkAndVerify,
  type EntryIdentity,
  type RegisteredRoot,
} from './containment'

/**
 * The last segment of a path. Never `''` — every caller below has already refused an empty path.
 *
 * `?? ''` rather than a non-null assertion: `noUncheckedIndexedAccess` is on, and an assertion here
 * would be the one place in this file where the type system is told to stop checking.
 */
const nameOf = (segments: readonly string[]): string => segments[segments.length - 1] ?? ''

/** What moved, and what kind of thing it was. */
export interface RenameOutcome {
  readonly from: readonly string[]
  readonly to: readonly string[]
  readonly kind: 'file' | 'directory'
  /** True when this was a case-only rename on a case-insensitive volume. */
  readonly caseOnly: boolean
}

/**
 * Moves or renames a file or directory, refusing rather than replacing anything at the destination.
 *
 * The order below is not arbitrary — each step refuses something the next step could not detect.
 */
export async function exclusiveRename(
  root: RegisteredRoot,
  from: readonly string[],
  to: readonly string[],
): Promise<Result<RenameOutcome>> {
  if (from.length === 0 || to.length === 0) {
    return fail(ErrorCode.PATH_EMPTY, 'a rename needs both a source and a destination')
  }

  const source = await walkAndVerify(root, from)
  if (!source.ok) return source
  if (source.value === null) {
    return fail(ErrorCode.IO_FAILED, 'the source no longer exists')
  }
  /**
   * **No symlink check here, and that is not an omission.** One stood in this spot; the mutation
   * sweep showed it unreachable. `walkAndVerify` refuses *any* symlinked segment — including the
   * final one — with `PATH_SYMLINK` before this function sees a result, so the branch could never
   * be entered. A second guard that cannot fire is one a later reader trusts.
   *
   * `other` — FIFOs, devices, sockets — still arrives here and is still refused below.
   */
  if (source.value.kind !== 'file' && source.value.kind !== 'directory') {
    return fail(ErrorCode.NOT_REGULAR_FILE, `the source is a ${source.value.kind}`)
  }
  if (source.value.kind === 'file' && source.value.nlink > 1) {
    // §4 refuses hard links in both directions: a second name for this inode may sit anywhere on
    // the volume, including outside every root, and `link` here would make a third.
    return fail(ErrorCode.HARDLINKED, `link count ${source.value.nlink}`)
  }

  /**
   * **FT-5 — a rename may not cross the editability boundary.** Spec §12:
   *
   *   *"Renames across the editability boundary are refused (FT-5): `photo.png` → `photo.md` would
   *   make a PNG editable, and one keystroke would rewrite it."*
   *
   * **Files only.** A directory has no extension, and `notes` → `notes.md` on a *folder* produces a
   * folder with a misleading name, not an editable document — refusing it would be a false positive
   * on a rename people legitimately make.
   *
   * **Why it lives here rather than at the two service call sites.** §13.6 defines this function as
   * the verb behind *"every user-visible Rename, Move, Duplicate, archive-move and template
   * placement"*, which is precisely FT-5's scope. Two copies at the call sites is how the old
   * codebase ended up with four copies of the containment check, and `lab-foundation-audit.md`
   * names that as a trap to stay out of.
   *
   * **The two directions are not equally dangerous, and both are refused anyway.** Non-markdown →
   * markdown is the one with teeth, and it is the one the spec names. Markdown → non-markdown only
   * makes a file uneditable, which loses nothing. The rule is written symmetrically because the
   * spec states it symmetrically, and because "refuse a rename that changes whether this is a
   * document" is a sentence a person can hold — whereas the asymmetric version needs the reader to
   * reconstruct which direction was the dangerous one.
   *
   * *This is a second line of defence, not the only one.* §12's editability gate already refuses to
   * open a renamed PNG, on both the load and the save path, because its bytes are not valid UTF-8.
   * FT-5 is the earlier, cheaper refusal: it stops the misleading file existing at all.
   */
  if (source.value.kind === 'file' && isMarkdown(nameOf(from)) !== isMarkdown(nameOf(to))) {
    return fail(
      ErrorCode.EDITABILITY_BOUNDARY,
      `renaming ${nameOf(from)} to ${nameOf(to)} would change whether it is an editable document`,
    )
  }

  const descendant = movesIntoOwnDescendant(from, to)
  if (descendant) {
    // §13.7. Moving a folder inside itself detaches the subtree from the filesystem — and since
    // folders **are** the database here, that is structural corruption rather than a bad UX.
    return fail(ErrorCode.PATH_TRAVERSAL, 'a folder cannot be moved inside itself')
  }

  const parent = await walkAndVerify(root, to.slice(0, -1))
  if (!parent.ok) return parent
  if (to.length > 1 && (parent.value === null || parent.value.kind !== 'directory')) {
    // §13.3: writes never create directories, and that applies to the destination of a move.
    return fail(ErrorCode.PARENT_MISSING, 'the destination folder does not exist')
  }

  const destination = await walkAndVerify(root, to)
  if (!destination.ok) return destination

  const sourcePath = join(root.absolutePath, ...from)
  const destinationPath = join(root.absolutePath, ...to)

  if (destination.value !== null) {
    if (isSameObject(source.value, destination.value)) {
      /**
       * A case-only rename on a case-insensitive volume — `notes.md` → `Notes.md`. **The
       * destination IS the source**, so every exclusive mechanism refuses it: `link` returns
       * `EEXIST` against the file itself, and an `lstat`-must-be-`ENOENT` check fails too. v1
       * permitted case-only rename while also mandating exclusive rename, which on APFS meant it
       * could not work at all.
       *
       * Detected by `(dev, ino)`, **never by comparing the strings** — the string comparison would
       * need to know the volume's case-folding rules, which vary by filesystem and by normalization
       * form, and getting it wrong in the permissive direction destroys a file.
       *
       * This volume is case-insensitive: measured, not assumed.
       */
      return renameDirectly(sourcePath, destinationPath, from, to, source.value.kind, true)
    }
    return fail(
      ErrorCode.NAME_TAKEN,
      `something already exists at the destination (${destination.value.kind})`,
    )
  }

  return source.value.kind === 'file'
    ? linkAndUnlink(sourcePath, destinationPath, from, to)
    : renameDirectoryExclusively(sourcePath, destinationPath, from, to)
}

/** Same filesystem object, by identity rather than by name. Spec §4 and §13.6. */
function isSameObject(a: EntryIdentity, b: EntryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * True when `to` sits inside `from`.
 *
 * Whole-segment comparison, the same rule §5 states for containment: a raw prefix test would call
 * `notes-archive` a descendant of `notes`, and refusing a legitimate move is the *better* of the
 * two errors here — but the same sloppiness in a containment check is what lets a path escape.
 * One rule, applied the same way everywhere.
 */
export function movesIntoOwnDescendant(from: readonly string[], to: readonly string[]): boolean {
  if (to.length <= from.length) return false
  return from.every((segment, index) => segment === to[index])
}

/**
 * The file case: `link` then `unlink`.
 *
 * `link` is the exclusive create. The kernel refuses `EEXIST` if anything is at the destination —
 * there is no window in which we check and then act, which is what makes this safe where an
 * `lstat`-then-`rename` is not.
 *
 * **The ordering matters on failure.** If `link` succeeds and `unlink` fails, the file exists under
 * both names with a link count of two — visible, recoverable, and nothing lost. The reverse order
 * would delete the source before the destination existed.
 */
async function linkAndUnlink(
  sourcePath: string,
  destinationPath: string,
  from: readonly string[],
  to: readonly string[],
): Promise<Result<RenameOutcome>> {
  try {
    await fsp.link(sourcePath, destinationPath)
  } catch (error) {
    return linkFailure(errnoOf(error))
  }

  try {
    await fsp.unlink(sourcePath)
  } catch (error) {
    // The destination now exists and holds the content. Undo the half-move rather than leave two
    // names silently — and if the undo also fails, say so plainly instead of reporting success.
    const undone = await fsp.unlink(destinationPath).then(() => true, () => false)
    return fail(
      ErrorCode.IO_FAILED,
      undone
        ? `could not remove the source: ${errnoOf(error) ?? 'unknown'}`
        : `left under BOTH names — remove one by hand: ${errnoOf(error) ?? 'unknown'}`,
    )
  }

  return ok({ from: [...from], to: [...to], kind: 'file', caseOnly: false })
}

function linkFailure(code: string | undefined): Result<RenameOutcome> {
  if (code === 'EEXIST') {
    // The control working. §13.6: collisions are refused with a named error offering an
    // auto-suffixed alternative — the alternative is the caller's to offer, the refusal is ours.
    return fail(ErrorCode.NAME_TAKEN, 'something already exists at the destination')
  }
  if (code === 'ENOENT') return fail(ErrorCode.PARENT_MISSING, 'the destination folder vanished')
  if (code === 'EXDEV') {
    // A hard link cannot cross volumes. Inside one registered root this should be impossible, and
    // if it happens the honest answer is a refusal rather than a silent fall back to copy+delete —
    // which is a delete, and nothing here deletes.
    return fail(ErrorCode.IO_FAILED, 'the destination is on another volume')
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return fail(ErrorCode.PERMISSION_DENIED, 'not permitted to create the destination')
  }
  if (code === 'ENAMETOOLONG') return fail(ErrorCode.NAME_TOO_LONG, 'the filesystem refused the name')
  return fail(ErrorCode.IO_FAILED, `link failed: ${code ?? 'unknown'}`)
}

/**
 * The directory case: prove the destination is absent, then `rename`.
 *
 * `link` does not work on directories, so this is the one place the exclusivity is checked rather
 * than enforced by the kernel — a real TOCTOU window, accepted by §13.6 on a single-user machine
 * and to be bounded by the per-parent lock when that lands.
 *
 * **Recorded as unproven, from the mutation sweep.** Deleting this check leaves every test green,
 * because `walkAndVerify` in the caller has already refused an occupied destination — so by the
 * time execution arrives here the destination is known absent, and the only thing this re-check
 * adds is a *narrower window* between the look and the rename. That narrowing is real and is what
 * §13.6 asks for, but no test can observe it: proving it needs a writer landing inside a window
 * measured in microseconds. Kept deliberately, labelled honestly.
 *
 * **The `ENOENT` discrimination is the load-bearing part.** §13.6: "Collision checks discriminate
 * `ENOENT` from 'couldn't determine': any non-`ENOENT` error (e.g. `EACCES`) aborts. It is never
 * treated as a free destination." A `try { lstat } catch { proceed }` reads as equivalent and is
 * not: an `EACCES` on the parent would be read as "nothing there" and the `rename` that follows
 * would clobber whatever is actually there.
 */
async function renameDirectoryExclusively(
  sourcePath: string,
  destinationPath: string,
  from: readonly string[],
  to: readonly string[],
): Promise<Result<RenameOutcome>> {
  try {
    await fsp.lstat(destinationPath)
    return fail(ErrorCode.NAME_TAKEN, 'something already exists at the destination')
  } catch (error) {
    const code = errnoOf(error)
    if (code !== 'ENOENT') {
      return fail(
        code === 'EACCES' || code === 'EPERM'
          ? ErrorCode.PERMISSION_DENIED
          : ErrorCode.IO_FAILED,
        `could not determine whether the destination is free: ${code ?? 'unknown'}`,
      )
    }
  }
  return renameDirectly(sourcePath, destinationPath, from, to, 'directory', false)
}

/** The bare `rename`, reached only after exclusivity has been established some other way. */
async function renameDirectly(
  sourcePath: string,
  destinationPath: string,
  from: readonly string[],
  to: readonly string[],
  kind: 'file' | 'directory',
  caseOnly: boolean,
): Promise<Result<RenameOutcome>> {
  try {
    await fsp.rename(sourcePath, destinationPath)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      return fail(ErrorCode.NAME_TAKEN, 'the destination is not empty')
    }
    if (code === 'ENOENT') return fail(ErrorCode.PARENT_MISSING, 'the destination folder vanished')
    if (code === 'EACCES' || code === 'EPERM') {
      return fail(ErrorCode.PERMISSION_DENIED, 'not permitted to move that')
    }
    return fail(ErrorCode.IO_FAILED, `rename failed: ${code ?? 'unknown'}`)
  }
  return ok({ from: [...from], to: [...to], kind, caseOnly })
}

/**
 * Offers a free name next to a taken one: `notes.md` → `notes-2.md`, `notes-3.md`, …
 *
 * §13.6 requires a collision be refused "with a named error offering an auto-suffixed alternative".
 * Suggesting a name is all this does — it never moves anything, and the caller re-issues an
 * ordinary exclusive rename, which is what keeps the exclusivity in one place.
 *
 * The suggestion is a *hint*, not a reservation: nothing stops the name being taken between the
 * suggestion and the retry, and that retry is exclusive too, so the worst case is another refusal.
 */
export async function suggestFreeName(
  root: RegisteredRoot,
  parentSegments: readonly string[],
  fileName: string,
  limit = 100,
): Promise<Result<string>> {
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''

  for (let n = 2; n < limit + 2; n++) {
    const candidate = `${base}-${n}${ext}`
    if (Buffer.byteLength(candidate, 'utf8') > 255) {
      return fail(ErrorCode.NAME_TOO_LONG, 'no suffixed name fits')
    }
    const found = await walkAndVerify(root, [...parentSegments, candidate])
    // Same discrimination as above: only a definite "nothing is there" counts as free.
    if (!found.ok) return found
    if (found.value === null) return ok(candidate)
  }
  return fail(ErrorCode.IO_FAILED, `no free name found after ${limit} attempts`)
}
