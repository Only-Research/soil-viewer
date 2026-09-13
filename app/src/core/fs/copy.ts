/**
 * The recursive copy engine. Spec §13.7.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * One engine for **Templates, Duplicate-folder and New Project alike** — §13.7's M1 finding is that
 * v1 had a `copyDir` used by all three which dereferenced every symlink and threw `EISDIR`
 * mid-copy, leaving a partial tree with no rollback. Three call sites, one broken implementation,
 * and the partial tree is the part that matters: on a filesystem-as-database, half a project is
 * structural corruption.
 *
 * The shape, and the order is the design:
 *
 *   1. **Pre-flight walk — before a single byte is written.** Count, bytes, deepest path, symlinks
 *      and non-regular files. Everything that can refuse the copy refuses it here, while nothing
 *      has been created.
 *   2. **Copy into staging**, which is scratch outside every registered root (`staging.ts`).
 *   3. **One exclusive rename into place** on success — the whole tree appears at once or not at
 *      all.
 *   4. **On any failure, delete the staging directory** and leave the user's folders untouched.
 *
 * That last step is the only recursive removal in this codebase and it lives in `staging.ts`, with
 * its own guards and its own tests.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isIgnoredPath } from '../grammar'

import {
  errnoOf,
  readDirectory,
  walkAndVerify,
  type RegisteredRoot,
  type DirectoryEntry,
} from './containment'
import { PATH_MAX_BYTES } from './conflict'
import { movesIntoOwnDescendant } from './rename'
import { makeStagingDirectory, removeStagedTree, resolveStagingArea } from './staging'
import { NAME_MAX_BYTES } from './write'

/**
 * Caps, and **the spec does not state numbers for these** — recorded rather than presented as if
 * it did. §13.7 requires refusing "on cap" without naming one; §11 caps a *registered root* at
 * 50,000 files and requires a typed second confirmation above that, which is the nearest stated
 * figure and the reason these sit below it.
 *
 * They are parameters with defaults rather than constants so the confirmation flow can raise them
 * once the user has seen the count — §13.7: "Confirmation names the count."
 */
export const DEFAULT_MAX_FILES = 10_000

/**
 * **P8-7 — because a tree of nothing but folders costs nothing against the other two.**
 *
 * security review, P8 review: *"`plan.directories` counted and never capped — 301 empty directories copied
 * under `maxFiles: 1`."* §13.7 keys the guard on files, which is right for the case it was written
 * for and silent about this one: a folder holds no bytes and is not a file, so a directory-only tree
 * scores **zero** against both caps and "refuse on cap" is answered by a copy that never refuses.
 *
 * **Templates make it the normal case rather than an edge one.** A template is often a shape with no
 * content in it — that is the entire reason `.gitkeep` has an exception in this file.
 *
 * Set to the file cap. A shape with more folders than a large project has files is not a shape.
 */
export const DEFAULT_MAX_DIRECTORIES = 10_000
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

export interface CopyCaps {
  readonly maxFiles?: number
  readonly maxBytes?: number
  readonly maxDirectories?: number
}

/**
 * What the copy would do, measured before anything happens.
 *
 * §13.7: "Guards are measured in **indexed files affected, not bytes**" — M6, because a directory
 * rename moves zero bytes, so a byte threshold would let a project move silently remove 200 files
 * from every view. Bytes are still reported, because a 400 MB copy is worth mentioning; they are
 * simply not the thing the guard is keyed on.
 */
export interface CopyPlan {
  readonly files: number
  readonly bytes: number
  readonly directories: number
  /** Relative paths that will NOT be copied, and why. Reported, never silently dropped. */
  readonly skippedSymlinks: readonly string[]
  readonly skippedOther: readonly string[]
  readonly skippedIgnored: readonly string[]
}

export interface CopyOutcome extends CopyPlan {
  readonly to: readonly string[]
}

/**
 * Walks the source and reports what a copy would do. Writes nothing, ever.
 *
 * Separate from the copy itself so the caller can show the count and get a confirmation before
 * anything is created — and so a refusal costs a walk rather than a half-built tree.
 */
export async function planRecursiveCopy(
  root: RegisteredRoot,
  from: readonly string[],
  to: readonly string[],
  caps: CopyCaps = {},
): Promise<Result<CopyPlan>> {
  const maxFiles = caps.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = caps.maxBytes ?? DEFAULT_MAX_BYTES
  const maxDirectories = caps.maxDirectories ?? DEFAULT_MAX_DIRECTORIES

  const shape = await checkShape(root, from, to)
  if (!shape.ok) return shape

  const plan: Mutable<CopyPlan> = {
    files: 0, bytes: 0, directories: 0,
    skippedSymlinks: [], skippedOther: [], skippedIgnored: [],
  }
  const walked = await walkSource(root, from, to, plan, maxFiles, maxBytes, maxDirectories)
  if (!walked.ok) return walked
  return ok(plan)
}

/**
 * Copies a folder, atomically as far as the destination is concerned.
 *
 * `stagingRoot` is validated on every use by `staging.ts` — this function never assumes it is safe
 * because it was safe last time.
 */
export async function recursiveCopy(
  root: RegisteredRoot,
  from: readonly string[],
  to: readonly string[],
  /** The app's own scratch. Used when the destination is on the same volume; see below. */
  stagingRoot: string,
  allRoots: readonly RegisteredRoot[],
  caps: CopyCaps = {},
): Promise<Result<CopyOutcome>> {
  const planned = await planRecursiveCopy(root, from, to, caps)
  if (!planned.ok) return planned

  /**
   * The staging area is chosen **per copy**, not once at startup, because it has to be on the same
   * volume as the destination — a move across volumes is not a move at all. `stagingRoot` is the
   * app's own scratch and is used whenever the destination is on the same disk, which is the
   * ordinary case; a destination on an external drive gets a scratch area on that drive.
   */
  const destinationParent = join(root.absolutePath, ...to.slice(0, -1))
  const area = await resolveStagingArea(stagingRoot, destinationParent, allRoots)
  if (!area.ok) return area

  const staged = await makeStagingDirectory(area.value, allRoots)
  if (!staged.ok) return staged
  const stagingDir = staged.value
  const built = join(stagingDir, 'tree')

  try {
    const copied = await copyTree(root, from, built, planned.value)
    if (!copied.ok) return copied

    /**
     * The tree is complete in scratch. Moving it into place goes through the **exclusive** rename,
     * which is the same function every user-facing move uses — so a destination that appeared
     * while we were copying is refused by the kernel rather than replaced.
     *
     * The staged tree is outside every root, so `exclusiveRename` cannot be used to move it in
     * (it works in root-relative segments). The rename here is done directly, but the exclusivity
     * is established the same way: `link` cannot be used on a directory, so the destination must be
     * proven absent immediately before — and unlike the general case, we additionally know nothing
     * legitimate can be at a path the pre-flight found free moments ago.
     */
    const destination = join(root.absolutePath, ...to)
    const landed = await moveIntoPlace(built, destination)
    if (!landed.ok) return landed

    return ok({ ...planned.value, to: [...to] })
  } finally {
    // Whatever happened, the scratch directory goes. On success it is an empty shell; on failure it
    // holds a partial tree that must never be seen. This is the codebase's only recursive delete.
    await removeStagedTree(stagingDir, area.value, allRoots)
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] }

/** Structural checks that do not need a walk: what is being copied, and to where. */
async function checkShape(
  root: RegisteredRoot,
  from: readonly string[],
  to: readonly string[],
): Promise<Result<null>> {
  if (from.length === 0 || to.length === 0) {
    return fail(ErrorCode.PATH_EMPTY, 'a copy needs both a source and a destination')
  }
  if (movesIntoOwnDescendant(from, to)) {
    // §13.7: "refuse when source and destination contain each other". Copying a folder into itself
    // is unbounded by construction — the walk would keep finding the growing copy.
    return fail(ErrorCode.PATH_TRAVERSAL, 'a folder cannot be copied into itself')
  }
  /**
   * **No `movesIntoOwnDescendant(to, from)` check here, and the sweep is why.** If the destination
   * strictly contains the source, then — since the source exists — the destination exists too, so
   * the destination-already-exists refusal below always fires first. It was unreachable. The
   * unbounded-recursion case it appeared to guard is caught by the check above.
   */

  const source = await walkAndVerify(root, from)
  if (!source.ok) return source
  if (source.value === null) return fail(ErrorCode.IO_FAILED, 'the source does not exist')
  /**
   * **A file source is allowed as of P7**, and this refusal used to forbid it.
   *
   * The build plan scheduled *"folder-copy and single-file verbatim copy (new work)"* for P8 with
   * Templates — but the row action that needs single-file copy is **Duplicate**, which the PRD puts
   * on the Files tab: *"Duplicate (file or whole folder)"*. So the verb lands here, in the phase
   * that ships the menu, and Templates keeps its own scope in P8.
   *
   * A symlink or a device node is still refused. §13.7: *"never follow symlinks (skip and report);
   * skip non-regular files"* — for a source named directly there is nothing to skip *to*, so the
   * only honest answer is a refusal.
   *
   * **This refusal is UNPROVEN by the suite, and it is kept for the message rather than the rule** —
   * which is what the comment it replaced said, and the sweep confirms it still holds. A symlink is
   * refused by `walkAndVerify` with `PATH_SYMLINK` before this is reached; a socket or FIFO falls
   * through to the walk and is refused by `readDirectory` with the *same* code. So removing this
   * changes no verdict, only where it comes from — and a refusal arriving from a directory read
   * reads like an internal failure instead of "that is not a file or a folder". Tested with a real
   * UNIX socket, which is the only one of these a test can create.
   */
  if (source.value.kind !== 'directory' && source.value.kind !== 'file') {
    return fail(ErrorCode.NOT_REGULAR_FILE, `the source is a ${source.value.kind}`)
  }
  if (source.value.kind === 'file' && source.value.nlink > 1) {
    // §13.7: "copy `st_nlink > 1` by content, never by `fs.link`". Copying the CONTENT is exactly
    // what happens below; this refusal is about the source being a hard link into somewhere else,
    // which §4 refuses in both directions.
    return fail(ErrorCode.HARDLINKED, `link count ${source.value.nlink}`)
  }

  const parent = await walkAndVerify(root, to.slice(0, -1))
  if (!parent.ok) return parent
  if (to.length > 1 && (parent.value === null || parent.value.kind !== 'directory')) {
    return fail(ErrorCode.PARENT_MISSING, 'the destination folder does not exist')
  }

  const existing = await walkAndVerify(root, to)
  if (!existing.ok) return existing
  /**
   * **One of a mutually-redundant pair, and neither can be isolated by a test.** `moveIntoPlace`
   * refuses the same case with the same code, so removing either one leaves the suite green; the
   * only way to reach that one instead of this one is for the destination to appear *between* the
   * internal pre-flight and the rename, which is a real race no deterministic test produces.
   *
   * Both stay. This one turns a refusal that would cost a full copy into scratch — a minute on a
   * large project — into an instant one. The other closes the race. Measured, for the record:
   * `rename` **does** replace an empty directory on this filesystem, so the second check is not
   * decorative.
   */
  if (existing.value !== null) {
    // `NAME_TAKEN` rather than `CONFLICT_DETECTED`, whose one fixed sentence is "The file changed
    // on disk since you opened it." True of a save whose baseline moved, false of a Duplicate onto
    // an occupied name — and Duplicate is about to hit this constantly.
    return fail(ErrorCode.NAME_TAKEN, 'something already exists at the destination')
  }
  return ok(null)
}

/**
 * The pre-flight walk. Reads directory entries and stats; writes nothing.
 *
 * Every refusal here happens with the destination still untouched, which is the entire point of
 * doing it separately.
 */
/**
 * The one filename §3 ignores that a copy carries through anyway. Phase 8, the ruling.
 *
 * **§3's dot rule is right for reading and wrong for copying, in exactly one case.** Everything
 * beginning with a dot is invisible to this app — not shown, not indexed, not watched, not copied —
 * and that rule is what keeps 527 `.DS_Store` files out of the tree. It also, silently, kept
 * `.gitkeep` out of every copy.
 *
 * `.gitkeep` is the opposite of junk. Git cannot record an empty directory, so an empty folder that
 * is part of a shape exists in the repository **only** because of the zero-byte file inside it.
 * There are 823 of them in the real tree, and the operator's templates depend on them: `op-template`
 * alone has empty `01-inbox`, `04-outbox`, `05-archive` and five round-table folders.
 *
 * Without this, scaffolding an op would produce all 40 folders on disk — correct in Finder, correct
 * in the app — and the empty ones would not be in git. The shape would look right and would not
 * survive. A failure visible only from a fresh clone is the worst kind this build collects.
 *
 * **Deliberately not a general un-ignore, and not a configurable list.** One name, in the copy
 * only. The operator declined code that special-cases file types on a copy — *"I'd rather clean the
 * templates"* — and they are right about exclusions, which is why none was written: `.DS_Store` is
 * already handled by the general rule. This is the inverse, and they ruled on it separately:
 * *"we're keeping the git keep… for GitHub."*
 */
const COPIED_DESPITE_IGNORE = new Set(['.gitkeep'])

/**
 * True when §3 would ignore this path and the copy must carry it anyway.
 *
 * **The leaf is the whole test, and an ancestor check was written here and then removed.**
 *
 * The first version also required every ancestor to be un-ignored, reasoning that a `.gitkeep`
 * inside `node_modules` must not drag the copy into a tree §3 exists to keep it out of. The
 * mutation sweep would not turn that clause red: replacing it with `true` changed nothing, in any
 * test.
 *
 * It could not. Both loops below skip an ignored **directory** before queueing it, so the walk
 * never enters one — every `relative` that reaches this function already has un-ignored ancestors,
 * and the clause was asking a question whose answer was fixed. A guard that cannot fire is the
 * defect this build has now found ten times, and one that is *also* a safety claim is worse than
 * useless: it invites the next reader to weaken the directory skip on the grounds that this is
 * covering them.
 *
 * The property is still true and still tested — `node_modules/pkg/.gitkeep` is not copied — it is
 * simply enforced one level up, by the skip that never descends.
 */
function isCarriedThrough(relative: readonly string[], kind: DirectoryEntry['kind']): boolean {
  /**
   * **FILES ONLY — the security review's P8-6, closed 2026-08-14.**
   *
   * They filed it as *"the `.gitkeep` exception is a recursive carve-out: a directory named
   * `.gitkeep` is descended into and copied whole."* Measured before fixing, it is **narrower than
   * that and still real**: the children are caught by §3's ancestor rule (`isIgnoredPath` tests
   * every segment), so nothing inside is copied — but the **directory itself is created in the
   * destination**, and the walk descends into it to discover that.
   *
   * An empty folder appearing in a scaffolded template is not a cosmetic problem. The entire reason
   * this exception exists is that an empty folder *is* part of a shape; one that arrives from an
   * ignored name looks exactly like one that was meant to be there.
   *
   * **The reason to name the kind rather than test the name harder:** `.gitkeep` earns its
   * exception by being a zero-byte file that makes an empty directory survive a clone. A directory
   * of that name has none of that meaning — it is a coincidence of spelling, and §3 already has an
   * answer for it.
   */
  if (kind !== 'file') return false
  const leaf = relative[relative.length - 1]
  return leaf !== undefined && COPIED_DESPITE_IGNORE.has(leaf)
}

async function walkSource(
  root: RegisteredRoot,
  from: readonly string[],
  to: readonly string[],
  plan: Mutable<CopyPlan>,
  maxFiles: number,
  maxBytes: number,
  maxDirectories: number,
): Promise<Result<null>> {
  /**
   * A single file is a walk of one, and it is answered here rather than by letting the loop below
   * meet it — `readDirectory` on a file fails, and a refusal from there reads like an internal
   * error rather than an answer.
   */
  const source = await walkAndVerify(root, from)
  if (!source.ok) return source
  if (source.value !== null && source.value.kind === 'file') {
    if (source.value.size > maxBytes) {
      return fail(ErrorCode.TOO_LARGE, `${source.value.size} bytes exceeds the copy cap`)
    }
    plan.files = 1
    plan.bytes = source.value.size
    return ok(null)
  }

  const queue: Array<readonly string[]> = [from]

  while (queue.length > 0) {
    const current = queue.shift() as readonly string[]
    const listed = await readDirectory(root, current)
    // §6: an empty-but-successful result never stands in for a failure. A directory we could not
    // read must abort the copy — silently producing a smaller tree is the corruption.
    if (!listed.ok) return listed
    plan.directories += 1
    // The cap the file count could not see. Checked here, where a directory is actually taken off
    // the queue, so a deep chain is refused on the way down rather than after the whole walk.
    if (plan.directories > maxDirectories) {
      return fail(ErrorCode.TOO_LARGE, `more than ${maxDirectories} directories`)
    }

    for (const entry of listed.value) {
      const childFrom = [...current, entry.name]
      const relative = childFrom.slice(from.length)

      if (isIgnoredPath(relative) && !isCarriedThrough(relative, entry.kind)) {
        // §3's ignore list applies to the copy — node_modules and friends are not content.
        // `.gitkeep` is the single exception; see `COPIED_DESPITE_IGNORE`.
        plan.skippedIgnored.push(relative.join('/'))
        continue
      }
      if (entry.kind === 'symlink') {
        // §13.7: "never follow symlinks (skip and report)". Following one copies data from outside
        // the root into the root, and v1's copyDir dereferenced every one of them.
        plan.skippedSymlinks.push(relative.join('/'))
        continue
      }
      if (entry.kind === 'other') {
        // FIFOs block forever on read; devices are unbounded.
        plan.skippedOther.push(relative.join('/'))
        continue
      }

      // The destination path is checked in BYTES, before anything is created. A source that fits
      // can produce a destination that does not — the destination name is usually longer.
      const destinationPath = join(root.absolutePath, ...to, ...relative)
      if (Buffer.byteLength(destinationPath, 'utf8') > PATH_MAX_BYTES) {
        return fail(ErrorCode.NAME_TOO_LONG, `the copy would exceed PATH_MAX at ${relative.join('/')}`)
      }
      if (Buffer.byteLength(entry.name, 'utf8') > NAME_MAX_BYTES) {
        return fail(ErrorCode.NAME_TOO_LONG, `a name exceeds NAME_MAX: ${relative.join('/')}`)
      }

      if (entry.kind === 'directory') {
        queue.push(childFrom)
        continue
      }

      const identity = await walkAndVerify(root, childFrom)
      if (!identity.ok) return identity
      if (identity.value === null) {
        return fail(ErrorCode.IO_FAILED, `${relative.join('/')} vanished during the walk`)
      }
      plan.files += 1
      plan.bytes += identity.value.size
      // §13.7 keys the guard on files, not bytes — M6. Bytes are reported and also capped, because
      // an unbounded byte total is its own problem, but the file count is the stated rule.
      if (plan.files > maxFiles) {
        return fail(ErrorCode.TOO_LARGE, `more than ${maxFiles} files`)
      }
      if (plan.bytes > maxBytes) {
        return fail(ErrorCode.TOO_LARGE, `more than ${maxBytes} bytes`)
      }
    }
  }
  return ok(null)
}

/** Copies the source into the staged tree, re-validating every file as it goes. */
async function copyTree(
  root: RegisteredRoot,
  from: readonly string[],
  stagedRoot: string,
  plan: CopyPlan,
): Promise<Result<null>> {
  const skipped = new Set([...plan.skippedSymlinks, ...plan.skippedOther, ...plan.skippedIgnored])

  /**
   * A single file stages as a file, not as a directory holding one.
   *
   * `plan.directories === 0` is the discriminator, and it comes from the pre-flight rather than a
   * second `stat` here — two reads of the same path are two chances to disagree, and the whole
   * point of the pre-flight is that the decision was already made against a verified source.
   */
  if (plan.directories === 0 && plan.files === 1) {
    await fsp.mkdir(join(stagedRoot, '..'), { recursive: true })
    return copyOneFile(join(root.absolutePath, ...from), stagedRoot)
  }

  const queue: Array<readonly string[]> = [from]
  await fsp.mkdir(stagedRoot, { recursive: true })

  while (queue.length > 0) {
    const current = queue.shift() as readonly string[]
    const listed = await readDirectory(root, current)
    if (!listed.ok) return listed

    for (const entry of listed.value) {
      const childFrom = [...current, entry.name]
      const relative = childFrom.slice(from.length)
      // The same two conditions the plan used, in the same order. They must agree exactly: a file
      // the plan counted and this loop skips is a copy that silently produces a smaller tree, and
      // a file this loop copies that the plan never counted is a copy that outruns its own caps.
      if (skipped.has(relative.join('/'))) continue
      if (isIgnoredPath(relative) && !isCarriedThrough(relative, entry.kind)) continue
      if (entry.kind === 'symlink' || entry.kind === 'other') continue

      const stagedPath = join(stagedRoot, ...relative)
      if (entry.kind === 'directory') {
        await fsp.mkdir(stagedPath, { recursive: true })
        queue.push(childFrom)
        continue
      }

      /**
       * **Re-validated per file during the walk** — §13.7's requirement. The pre-flight ran
       * earlier, and an agent can have replaced a file with a symlink since; a copy that trusts
       * the plan would read straight through it, pulling content from outside the root into the
       * root.
       *
       * **UNPROVEN, and the sweep says so.** `recursiveCopy` re-runs the pre-flight itself, so any
       * change a test can make lands *before* the plan and is caught there instead. Reaching this
       * check needs a writer landing between that plan and this loop — a real race, measured in
       * milliseconds, that no deterministic test produces. Kept because the window is real and the
       * consequence is foreign content inside a registered root.
       */
      const identity = await walkAndVerify(root, childFrom)
      if (!identity.ok) return identity
      if (identity.value === null) {
        return fail(ErrorCode.IO_FAILED, `${relative.join('/')} vanished during the copy`)
      }
      if (identity.value.kind !== 'file') {
        return fail(ErrorCode.NOT_REGULAR_FILE, `${relative.join('/')} changed kind during the copy`)
      }

      const copied = await copyOneFile(join(root.absolutePath, ...childFrom), stagedPath)
      if (!copied.ok) return copied
    }
  }
  return ok(null)
}

/**
 * Copies one file **by content**.
 *
 * §13.7: "copy `st_nlink > 1` by content, never by `fs.link`." A hard-linked source copied with
 * `link` would give the copy and the original the same inode — so editing the "copy" would edit
 * the original, which is the opposite of what Duplicate means.
 *
 * `COPYFILE_EXCL` makes the create exclusive. Nothing should be at a staged path, and if something
 * is, that is a bug worth stopping for rather than overwriting.
 */
async function copyOneFile(source: string, destination: string): Promise<Result<null>> {
  try {
    // COPYFILE_EXCL: unreachable today, because every staged path is inside a freshly-made
    // `mkdtemp` directory and nothing can already be there. Kept because the alternative is a
    // silent overwrite if that ever stops being true, and the sweep records it as undefended
    // rather than proven.
    await fsp.copyFile(source, destination, fsp.constants.COPYFILE_EXCL)
    return ok(null)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOSPC' || code === 'EDQUOT') return fail(ErrorCode.DISK_FULL, 'the volume is full')
    if (code === 'EACCES' || code === 'EPERM') {
      return fail(ErrorCode.PERMISSION_DENIED, `cannot read ${source}`)
    }
    return fail(ErrorCode.IO_FAILED, `copy failed: ${code ?? 'unknown'}`)
  }
}

/** The single rename that makes the whole tree appear at once. Exclusive, like every other move. */
async function moveIntoPlace(staged: string, destination: string): Promise<Result<null>> {
  try {
    /**
     * The other half of the pair described in `checkShape`. **Measured:** `rename` replaces an
     * empty directory on this filesystem without complaint, so without this check a destination
     * created while the copy was running would be silently taken over. `rename` refuses a
     * *non-empty* one with `ENOTEMPTY` on its own, which is why only the empty case needs us.
     *
     * Undefended by the sweep for the reason given above: the pre-flight catches every case a test
     * can set up, and this one only fires on the race.
     */
    await fsp.lstat(destination)
    // Same reasoning as its pre-flight twin above: a name collision is `NAME_TAKEN`, not "the file
    // changed on disk since you opened it".
    return fail(ErrorCode.NAME_TAKEN, 'something appeared at the destination')
  } catch (error) {
    const code = errnoOf(error)
    if (code !== 'ENOENT') {
      // §13.6: discriminate ENOENT from "couldn't determine". Anything else is never read as free.
      // UNPROVEN — reaching it needs an `lstat` that fails for a reason other than absence, which
      // means an unreadable parent directory, and no test here produces one. Same status as the
      // equivalent check in `rename.ts`.
      return fail(
        code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
        `could not determine whether the destination is free: ${code ?? 'unknown'}`,
      )
    }
  }

  try {
    await fsp.rename(staged, destination)
    return ok(null)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'EXDEV') {
      /**
       * The staging area is on a different volume from the destination.
       *
       * §13.7 requires staging "on the same filesystem" for exactly this reason. Refused rather
       * than fallen back to a copy-then-delete, because that fallback is a delete, and the whole
       * design exists to avoid one. The caller's remedy is a staging area on the right volume —
       * which is a configuration problem, and it should surface as one.
       */
      return fail(ErrorCode.IO_FAILED, 'the staging area is on a different volume')
    }
    if (code === 'ENOENT') return fail(ErrorCode.PARENT_MISSING, 'the destination folder vanished')
    return fail(ErrorCode.IO_FAILED, `could not move the copy into place: ${code ?? 'unknown'}`)
  }
}
