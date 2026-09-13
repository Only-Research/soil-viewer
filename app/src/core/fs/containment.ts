/**
 * The containment module. Spec §4.
 *
 * **The boundary is the `src/core/fs/` DIRECTORY, not this single file.** Everything OUTSIDE the
 * directory takes an already-verified handle, and that is what the lint partition and the meta-gate
 * enforce.
 *
 * **EIGHTEEN of the nineteen modules in here import `node:fs`** — counted 2026-08-16. This said
 * *"four modules… this one, `walk.ts`, `watcher.ts` and `registration.ts`"*, which was true when it
 * was written at Phase 1 and has been wrong for every phase since. It was itself a correction, made
 * 2026-08-06 after the fresh-eyes review found the original claim — sole importer in the codebase —
 * false. **A count is the wrong shape for this comment**: it goes stale on the next file and nothing
 * reports it. What matters is the partition, which has not changed.
 *
 * The lab trap it guards against — *four copies of the containment check* — is still genuinely
 * absent: there is one `walkAndVerify` and no inline duplicate of it. **This used to name
 * `validateRelativePath` alongside it; that function is dead** — nothing in `src/` calls it, the
 * live segment rule is `segmentFault`, and the security review's G6 of 2026-08-16 has it deleted once its test
 * corpus is re-pointed. What the other modules do is compose and `stat` paths of their own, which is
 * why each is documented where it departs. If that ever grows into a second checker, the trap is
 * back.
 *
 * The wall this module builds:
 * - Every segment from the root down is `lstat`ed, and **a symlinked segment is refused, not
 *   resolved** (F4.1). Resolving is what makes TOCTOU exploitable.
 * - The target's `(dev, ino)` is recorded before opening, the open uses `O_NOFOLLOW`, and
 *   `fstat` on the resulting descriptor must return the same pair. A swap between the check
 *   and the open is caught rather than trusted.
 * - **All I/O goes through that descriptor, never a re-opened path.**
 * - Every file read is `S_ISREG` — a FIFO hangs the server forever and `/dev/zero` is
 *   unbounded memory — and `st_nlink > 1` is refused in both directions, because
 *   `ln ~/.ssh/id_ed25519 /soil/notes.md` passes every other check (F4.2).
 *
 * RESIDUAL, stated rather than hidden. `O_NOFOLLOW` protects only the FINAL path component.
 * An *intermediate* directory could in principle be swapped for a symlink between the walk
 * and the open. Closing that completely needs `openat(2)` walked segment-by-segment against
 * directory descriptors, and **Node exposes no `openat`** — verified on Node 24.14.0, along
 * with `RENAME_EXCL`'s absence, on 2026-08-06. The design spec §4 specifies is therefore the
 * strongest available in this runtime, and the window is bounded by a single-user machine
 * where an attacker capable of winning it already has local write access to the tree. If
 * `openat` ever lands in Node, this becomes closable and should be revisited — that is an
 * escalation under §2, not a silent acceptance.
 */

import { constants, promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isWithin, segmentErrorFor, segmentFault, splitSegments } from '../paths'

/** Spec §4: "Reads capped at 25 MB." */
export const MAX_READ_BYTES = 25 * 1024 * 1024

/**
 * A folder the user registered. Produced by registration (spec §5), which probes the volume's
 * case sensitivity and records its identity — neither is ever guessed.
 */
export interface RegisteredRoot {
  readonly id: string
  /**
   * Absolute, **as the operator gave it**. Established once at registration, never composed from
   * user input. This said "real path" until 2026-09-01 and was not one — nothing resolved it — so
   * a scope check built on it was comparing a string to itself. It stays verbatim on purpose: the
   * id, the displayed path and every config key are keyed to what was named.
   */
  readonly absolutePath: string
  /**
   * The same root after `realpath`. Differs whenever any ancestor is a symlink, which on macOS
   * includes ordinary paths under `/var` and `/tmp`. **This is the one to bound a scope against** —
   * `absolutePath` says what was asked for, this says where it goes.
   */
  readonly resolvedPath: string
  /** Probed at registration, per root. Spec §4. */
  readonly caseInsensitive: boolean
  /** Volume identity, verified before every mutation. Spec §5. */
  readonly dev: bigint
  readonly rootIno: bigint
}

/**
 * A descriptor that has passed every check in this module, plus the identity it was verified
 * against. Spec §4: file identity is `(dev, ino)` from a descriptor — never a path string,
 * because overlapping roots, case variants and NFC/NFD all produce two strings for one inode.
 */
export interface VerifiedHandle {
  readonly file: fsp.FileHandle
  readonly dev: bigint
  readonly ino: bigint
  readonly size: number
  readonly mtimeNs: bigint
  /** Retained so a caller can echo it back for conflict detection without re-statting. */
  readonly relativeSegments: readonly string[]
}

/** What a path is, without following symlinks. Spec §4 shows symlinks; it never traverses them. */
export type EntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface EntryIdentity {
  readonly kind: EntryKind
  readonly dev: bigint
  readonly ino: bigint
  readonly size: number
  readonly nlink: number
  readonly mtimeNs: bigint
  /**
   * Allocated blocks, and it is here for one reason: **a file reporting a size with none of them
   * is a cloud placeholder that has not been downloaded.**
   *
   * §5 forbids force-materializing one during indexing — v1's title extraction would have pulled
   * the entire tree down out of iCloud on first index. macOS marks these with `SF_DATALESS` in
   * `st_flags`, which Node does not expose (verified on 24.14.0), so `blocks === 0` with `size > 0`
   * is the portable signal that remains. `walk.ts` has always read it; it is on the identity too
   * now so the single-entry reconcile can apply the same rule instead of a weaker one.
   */
  readonly blocks: number
}

function kindOf(mode: number): EntryKind {
  const type = mode & constants.S_IFMT
  if (type === constants.S_IFREG) return 'file'
  if (type === constants.S_IFDIR) return 'directory'
  if (type === constants.S_IFLNK) return 'symlink'
  return 'other'
}

/** Node reports ENOENT/EACCES/etc. on an error object; narrow it without an `any`. */
export function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

/**
 * Maps an errno to a code, keeping the distinctions that matter.
 *
 * EACCES/EPERM becomes PERMISSION_DENIED rather than a containment failure. Spec §5: a
 * background process meets EPERM on `~/Documents`, `~/Desktop`, iCloud and external volumes
 * **with no prompt at all**, and the app must enter a named "permission needed" state and
 * reconcile on grant. Reporting that as a bad path would send the operator looking for a corrupt
 * file when the fix is a macOS privacy setting.
 */
function ioFailureCode(errno: string | undefined): typeof ErrorCode.PERMISSION_DENIED | typeof ErrorCode.IO_FAILED {
  return errno === 'EACCES' || errno === 'EPERM'
    ? ErrorCode.PERMISSION_DENIED
    : ErrorCode.IO_FAILED
}

/**
 * Composes an absolute path from a root and already-validated segments.
 *
 * `join`, never `resolve`. Spec §4 forbids `path.resolve` on user input because
 * `path.resolve(root, '/etc/passwd')` silently discards the root and returns `/etc/passwd`.
 * `join` cannot do that.
 *
 * **What guarantees there is no `..` for `join` to collapse is the loop in `walkAndVerify` above** —
 * it runs `segmentFault` over every segment before this is reached, and all four call sites sit
 * behind it. So the property holds **locally, in this same function**, rather than depending on a
 * caller having remembered anything.
 *
 * **This used to credit `validateRelativePath`, which no product code calls** — corrected
 * 2026-08-16 on the security review's G6. The decision to use `join` was right and the reason given for it was
 * not, which is the worse of the two failures: a reader checking the argument would have checked it
 * against a function that never runs, found it convincing, and learned nothing. Record item 59's
 * rule is widened by that ruling — **a comment claiming a precondition must name the code that
 * establishes it**, not only a comment claiming test coverage.
 */
function composeAbsolute(root: RegisteredRoot, segments: readonly string[]): string {
  return segments.length === 0 ? root.absolutePath : join(root.absolutePath, ...segments)
}

/**
 * Re-verifies containment after composition. Spec §4 requires this even though the segments
 * were validated, because validation and composition are separate steps and only this check
 * proves the composed result actually landed inside the root.
 */
function composedPathIsContained(root: RegisteredRoot, absolute: string): boolean {
  return isWithin(
    splitSegments(root.absolutePath),
    splitSegments(absolute),
    root.caseInsensitive,
  )
}

/**
 * `lstat`s one path without following a final symlink.
 * Returns null for ENOENT; every other errno is a real failure and is surfaced.
 */
async function lstatIdentity(absolute: string): Promise<Result<EntryIdentity | null>> {
  try {
    const stat = await fsp.lstat(absolute, { bigint: true })
    return ok({
      kind: kindOf(Number(stat.mode)),
      dev: stat.dev,
      ino: stat.ino,
      size: Number(stat.size),
      nlink: Number(stat.nlink),
      mtimeNs: stat.mtimeNs,
      blocks: Number(stat.blocks),
    })
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return ok(null)
    // Spec §13.6: a non-ENOENT error is never treated as "free" or "absent".
    return fail(ioFailureCode(code), `lstat failed: ${code ?? 'unknown'}`)
  }
}

/**
 * Walks every segment from the root down, refusing any symlinked segment, and returns the
 * target's identity — or null when the target does not exist.
 *
 * Spec §4: "The checker `lstat`s **every segment from the root down** and refuses any
 * symlinked segment." Refusing rather than resolving is the whole design: a resolved symlink
 * is a path that was valid at check time and can point elsewhere by open time.
 *
 * The walk stops at the first missing segment and reports absence, so a caller creating a file
 * can tell "parent exists, target does not" from "parent is missing too".
 */
export async function walkAndVerify(
  root: RegisteredRoot,
  segments: readonly string[],
): Promise<Result<EntryIdentity | null>> {
  /**
   * **EVERY SEGMENT IS A SEGMENT, CHECKED BEFORE ANYTHING IS COMPOSED.**
   *
   * This function's whole guarantee is that it `lstat`s **every segment from the root down** and
   * refuses a symlinked one. That guarantee is false if a caller can put two path components into
   * one array element: `join` runs once per element, so `['link/secret.png']` collapses two
   * components into a single `lstat`, and `lstat` follows every component except the last. The
   * symlink in the middle is never seen.
   *
   * Demonstrated by the security review, 2026-08-09, and re-run by me before acting on it: bytes from outside the
   * registered root, served to a caller holding an ordinary session ticket. The JSON routes were
   * never exposed — `contract/validate.ts` refuses a separator in a segment — but the §9 byte
   * endpoint re-derived its own parsing from the query string and had no such check.
   *
   * So the rule lives in Core and runs **here**, at the chokepoint every path read or write passes
   * through, rather than at each route that remembers to ask.
   */
  for (const segment of segments) {
    const fault = segmentFault(segment)
    if (fault !== null) {
      return fail(segmentErrorFor(fault), `unusable path segment: ${fault}`)
    }
  }

  const absoluteTarget = composeAbsolute(root, segments)
  if (!composedPathIsContained(root, absoluteTarget)) {
    return fail(ErrorCode.PATH_ESCAPES_ROOT, 'composed path is outside the root')
  }

  // The root itself must be a real directory and must still be the volume we registered.
  const rootIdentity = await lstatIdentity(root.absolutePath)
  if (!rootIdentity.ok) return rootIdentity
  if (rootIdentity.value === null) {
    return fail(ErrorCode.IO_FAILED, 'registered root does not exist')
  }
  if (rootIdentity.value.kind !== 'directory') {
    return fail(ErrorCode.INVALID_ROOT, 'registered root is not a directory')
  }
  // Spec §5: verify volume identity rather than trusting the path. Never recreate a missing
  // root — writing into a phantom directory on the boot volume is silently shadowed the
  // moment the real drive returns.
  if (rootIdentity.value.ino !== root.rootIno || rootIdentity.value.dev !== root.dev) {
    return fail(ErrorCode.IDENTITY_CHANGED, 'registered root is not the volume registered')
  }

  let current = root.absolutePath
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment === undefined) return fail(ErrorCode.PATH_TRAVERSAL, 'empty segment')
    current = join(current, segment)

    const identity = await lstatIdentity(current)
    if (!identity.ok) return identity
    if (identity.value === null) return ok(null) // does not exist; not an error here

    const isLast = i === segments.length - 1
    if (identity.value.kind === 'symlink') {
      return fail(ErrorCode.PATH_SYMLINK, `symlinked segment at depth ${i + 1}`)
    }
    if (!isLast && identity.value.kind !== 'directory') {
      return fail(ErrorCode.NOT_REGULAR_FILE, 'a non-directory appears mid-path')
    }
    if (isLast) return ok(identity.value)
  }

  return ok(rootIdentity.value)
}

/**
 * Opens a regular file for reading, having verified every rule in §4.
 *
 * The caller MUST close the returned handle. Every read goes through the descriptor rather
 * than the path, so nothing that happens to the path afterwards can redirect the read.
 */
export async function openFileForRead(
  root: RegisteredRoot,
  segments: readonly string[],
): Promise<Result<VerifiedHandle>> {
  const walked = await walkAndVerify(root, segments)
  if (!walked.ok) return walked
  if (walked.value === null) {
    return fail(ErrorCode.IO_FAILED, 'target does not exist')
  }
  if (walked.value.kind !== 'file') {
    // FIFOs block forever on open/read; character devices are unbounded. Spec §4.
    return fail(ErrorCode.NOT_REGULAR_FILE, `target is a ${walked.value.kind}`)
  }
  // `ln ~/.ssh/id_ed25519 /soil/notes.md` passes containment, is a regular file, and is inside
  // the root. Link count is the only thing that catches it. Spec §4 refuses both directions.
  if (walked.value.nlink > 1) {
    return fail(ErrorCode.HARDLINKED, `link count ${walked.value.nlink}`)
  }

  const absolute = composeAbsolute(root, segments)
  let file: fsp.FileHandle
  try {
    // O_NOFOLLOW makes the kernel refuse if the final component became a symlink between the
    // walk above and this open. ELOOP here is an attack signal, not a bug.
    file = await fsp.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ELOOP') return fail(ErrorCode.PATH_SYMLINK, 'became a symlink before open')
    if (code === 'ENOENT') return fail(ErrorCode.IO_FAILED, 'vanished before open')
    return fail(ioFailureCode(code), `open failed: ${code ?? 'unknown'}`)
  }

  // The TOCTOU close: what we opened must be what we checked.
  try {
    const stat = await file.stat({ bigint: true })
    const kind = kindOf(Number(stat.mode))

    if (stat.dev !== walked.value.dev || stat.ino !== walked.value.ino) {
      await file.close()
      return fail(ErrorCode.IDENTITY_CHANGED, 'target changed between check and open')
    }
    if (kind !== 'file') {
      await file.close()
      return fail(ErrorCode.NOT_REGULAR_FILE, `descriptor is a ${kind}`)
    }
    // Re-checked on the descriptor rather than trusting the earlier lstat.
    if (Number(stat.nlink) > 1) {
      await file.close()
      return fail(ErrorCode.HARDLINKED, `link count ${Number(stat.nlink)}`)
    }
    if (Number(stat.size) > MAX_READ_BYTES) {
      await file.close()
      return fail(ErrorCode.TOO_LARGE, `${Number(stat.size)} bytes exceeds the 25 MB cap`)
    }

    return ok({
      file,
      dev: stat.dev,
      ino: stat.ino,
      size: Number(stat.size),
      mtimeNs: stat.mtimeNs,
      relativeSegments: [...segments],
    })
  } catch (error) {
    await file.close()
    return fail(ioFailureCode(errnoOf(error)), `fstat failed: ${errnoOf(error) ?? 'unknown'}`)
  }
}

/**
 * Reads a verified handle's full contents as bytes.
 *
 * Bytes, never a decoded string. Spec §9 serves bytes and never documents, and P5's harness
 * compares bytes rather than decoded text — a round-trip through a string is exactly how the
 * old editor rewrote 1,610 files.
 */
export async function readAllBytes(handle: VerifiedHandle): Promise<Result<Buffer>> {
  if (handle.size > MAX_READ_BYTES) {
    return fail(ErrorCode.TOO_LARGE, `${handle.size} bytes exceeds the 25 MB cap`)
  }
  try {
    // alloc, not allocUnsafe: a short read must never expose uninitialised process memory
    // as file content. The memset is negligible next to the disk I/O it accompanies.
    const buffer = Buffer.alloc(handle.size)
    let read = 0
    while (read < handle.size) {
      const { bytesRead } = await handle.file.read(buffer, read, handle.size - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    // A short read is a FAILURE, never a smaller success. The descriptor's own fstat promised
    // `handle.size`; getting less means the file was truncated or replaced mid-read. Spec §13.2
    // is explicit — "a failed **or partial** read renders a named error with editing disabled" —
    // and spec §6 forbids an empty-but-successful result standing in for a failure. Returning
    // the short buffer is the read half of the C2 total-loss path: the editor mounts an
    // apparently empty document, one keystroke autosaves, and the file is gone.
    if (read !== handle.size) {
      return fail(ErrorCode.SHORT_READ, `read ${read} of ${handle.size} bytes`)
    }
    return ok(buffer)
  } catch (error) {
    return fail(ioFailureCode(errnoOf(error)), `read failed: ${errnoOf(error) ?? 'unknown'}`)
  }
}

/**
 * Reads at most `maxBytes` from the start of a verified handle.
 *
 * Used by the indexer for title extraction, where spec §5 caps the read at 64 KiB. Reading a
 * bounded head rather than the whole file is what keeps a cold index of 10,000 files from
 * pulling their entire contents through memory.
 */
export async function readHead(handle: VerifiedHandle, maxBytes: number): Promise<Result<Buffer>> {
  const want = Math.min(handle.size, maxBytes)
  if (want === 0) return ok(Buffer.alloc(0))
  try {
    const buffer = Buffer.alloc(want)
    let read = 0
    while (read < want) {
      const { bytesRead } = await handle.file.read(buffer, read, want - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    // Same rule as readAllBytes. `want` is already bounded by the descriptor's own size, so a
    // short read here means the file shrank under us — not that we reached a legitimate end.
    // The caller (the indexer) turns this into contentUnavailable, never into a blank title.
    if (read !== want) {
      return fail(ErrorCode.SHORT_READ, `read ${read} of ${want} bytes`)
    }
    return ok(buffer)
  } catch (error) {
    return fail(ioFailureCode(errnoOf(error)), `read failed: ${errnoOf(error) ?? 'unknown'}`)
  }
}

/** Convenience: open, read, close. The handle never escapes, so it cannot be leaked. */
export async function readFileBytes(
  root: RegisteredRoot,
  segments: readonly string[],
): Promise<Result<Buffer>> {
  const opened = await openFileForRead(root, segments)
  if (!opened.ok) return opened
  try {
    return await readAllBytes(opened.value)
  } finally {
    await opened.value.file.close()
  }
}

/**
 * One directory's entries, with each entry's kind taken from the directory read itself rather
 * than a second `stat`. Symlinks are reported as symlinks and never followed — spec §4 shows
 * them in the tree with their own glyph, and FT-9's "clicking resolves" is a separate,
 * separately-contained navigation, not a silent traversal here.
 */
export interface DirectoryEntry {
  readonly name: string
  readonly kind: EntryKind
}

export async function readDirectory(
  root: RegisteredRoot,
  segments: readonly string[],
): Promise<Result<DirectoryEntry[]>> {
  const walked = await walkAndVerify(root, segments)
  if (!walked.ok) return walked
  if (walked.value === null) {
    return fail(ErrorCode.IO_FAILED, 'directory does not exist')
  }
  if (walked.value.kind !== 'directory') {
    return fail(ErrorCode.NOT_REGULAR_FILE, `target is a ${walked.value.kind}`)
  }

  const absolute = composeAbsolute(root, segments)
  try {
    const dirents = await fsp.readdir(absolute, { withFileTypes: true })
    return ok(dirents.map(entry => ({
      name: entry.name,
      kind: entry.isSymbolicLink()
        ? ('symlink' as const)
        : entry.isDirectory()
          ? ('directory' as const)
          : entry.isFile()
            ? ('file' as const)
            : ('other' as const),
    })))
  } catch (error) {
    // Spec §6: an empty-but-successful result never stands in for a failure. A directory we
    // could not read is an error, never an empty list.
    return fail(ioFailureCode(errnoOf(error)), `readdir failed: ${errnoOf(error) ?? 'unknown'}`)
  }
}

/**
 * The verified absolute path of an entry, or a failure. **Walk first, compose second — structurally.**
 *
 * Added 2026-08-14 for §10's Reveal in Finder, which is the first caller that needs an absolute path
 * to hand *outside* this process rather than a handle to read.
 *
 * **Why this exists rather than exporting `composeAbsolute`.** Composing is trivial and safe-looking;
 * composing *without having walked* is the whole vulnerability. An exported composer is an invitation
 * to call it alone, and §10's requirement — *"check the realpath, never the client string"* — would
 * then depend on every future caller remembering the order. Here the order is not rememberable: the
 * only way to get the string is through the walk that earns it.
 *
 * After `walkAndVerify` succeeds there is **no symlink anywhere in the composed path** — it `lstat`s
 * every segment from the root down and refuses a symlinked one — so the composed path *is* the real
 * path. That is what makes this safe to hand to a process that will resolve it again.
 *
 * A missing entry is a failure rather than a path, because revealing something that is not there is
 * a Finder window pointed at nothing.
 */
export async function resolveVerifiedPath(
  root: RegisteredRoot,
  segments: readonly string[],
): Promise<Result<string>> {
  const identity = await walkAndVerify(root, segments)
  if (!identity.ok) return identity
  if (identity.value === null) {
    return fail(ErrorCode.STALE_TARGET, 'that file is no longer there')
  }
  return ok(composeAbsolute(root, segments))
}
