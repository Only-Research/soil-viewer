/**
 * The atomic write. Spec §13.2 (C3), §13.3, §13.4.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * **This is the module the rebuild exists for.** The previous version destroyed 1,610 of 1,611
 * files, and every rule below is here because a specific way of losing a file was found and closed.
 * The shape to keep in mind while reading: it is not enough for each step to be correct — the
 * sequence has to be correct, and **every failure must land before the rename**, because the rename
 * is the only irreversible instant in it.
 *
 * The sequence, and the rename is deliberately the very last thing:
 *
 *   1. markdown gate → 2. size cap → 3. **§12's editability gate on the incoming bytes** →
 *   4. truncation guard → 5. open the destination and prove it is still the file we loaded, by
 *   hash → 6. writability pre-check → 7. create the temp exclusively in the destination's own
 *   directory → 8. write, checking the count → 9. `fsync` → 10. `fstat` and assert the size →
 *   11. reapply mode → 12. take the new baseline from the temp descriptor → 13. close →
 *   14. **rename** → 15. `fsync` the directory.
 *
 * **Accepted and recorded, on the ruling of 2026-08-08: a save drops the file's Finder tags
 * and any other extended attributes.** §13.3 asks for them to be reapplied. Node exposes no xattr
 * API at all — three routes were measured, including seeding the temp with `copyFile`, which
 * carries the mode but not the attributes. The only ways through are shell execution (§10, banned
 * and a whole class of holes) or a native dependency (§2, zero third-party runtime code). Asked
 * directly, the operator's answer was *"we don't ever use tags so whatever best supports that"*. So the
 * mode is preserved, the attributes are not, and this is a decision rather than an oversight.
 */

import { randomBytes } from 'node:crypto'
import { constants, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isMarkdown } from '../grammar'
import {
  errnoOf,
  openFileForRead,
  readAllBytes,
  type RegisteredRoot,
} from './containment'
import {
  MAX_EDITABLE_BYTES,
  baselineFrom,
  confirmUnchangedDuringRead,
  editabilityRefusal,
  hashBytes,
  type DocumentBaseline,
} from './document'

/**
 * `NAME_MAX` on APFS and HFS+, **in bytes, not characters**. Spec §13.5.
 *
 * A temp name is the basename plus 21 bytes of decoration, so a file whose own name is already
 * near the limit produces a temp path that cannot be created. In v1 the equivalent overflow hit
 * the *conflict* file and the consequence was the worst kind: `ENAMETOOLONG`, and **the edit it
 * existed to rescue was gone**.
 */
// The value lives in `core/limits.ts` so the client can read it without importing this module,
// which pulls in node:fs. Re-exported here because every caller in this layer expects it here.
export { NAME_MAX_BYTES } from '../limits'
import { NAME_MAX_BYTES } from '../limits'

/** `.<basename>.tmp-<16 hex>` — §13.3, and on §3's ignore list so the indexer never sees one. */
const TEMP_PREFIX = '.'
const TEMP_INFIX = '.tmp-'
const TEMP_RANDOM_BYTES = 8

/**
 * How many times to retry a temp name that collided.
 *
 * A collision means 64 bits of CSPRNG output repeated, so in practice this never runs twice; the
 * retry exists because `O_EXCL` can also lose to a *deliberately* pre-placed file, and giving up
 * after one attempt would let anything that can write to the directory deny saves indefinitely.
 */
const TEMP_ATTEMPTS = 8

/**
 * The one seam in this module, and it exists because two failures cannot be produced on demand.
 *
 * A genuinely full disk is the case §13.2's C3 rule is written for: `write(2)` reports success,
 * the file is short, and a `rename` would put a truncated file over good content. Producing it for
 * real needs a mounted volume of a fixed small size — a change to the machine, and one the command
 * sandbox refuses anyway. So the *temp opener* is injectable, and the tests hand back a descriptor
 * that writes short or fails `ENOSPC`.
 *
 * **What this seam can and cannot bypass.** It supplies the descriptor and nothing else. Every
 * check in this module happens either before it (markdown, cap, truncation, conflict, writability)
 * or after it on whatever it returns (the size assertion, which is inside `baselineFrom`). A caller
 * passing a strange opener can make their own write fail; they cannot make it skip a guard or reach
 * the rename with unverified content.
 *
 * The kernel side is separately known rather than assumed: `O_CREAT|O_EXCL|O_NOFOLLOW` refusing a
 * pre-placed symlink, and `rename` refusing an immutable destination, were both measured on this
 * machine before this module was written.
 */
export type TempOpener = (directory: string, fileName: string) => Promise<Result<OpenTemp>>

/**
 * `fsync` on the containing directory. Injected for one reason: **the interesting case is when it
 * fails**, and a volume that refuses it cannot be conjured on the machine running the tests.
 */
export type DirectorySync = (directory: string) => Promise<void>

export interface SaveOptions {
  /**
   * The user has seen the truncation warning and said yes. Spec §13.2.
   *
   * Deliberately not a "force" flag: it disables exactly one check, and the caller re-issues the
   * identical save with it set. Nothing else in this module can be bypassed.
   */
  readonly confirmedTruncation?: boolean
}

/**
 * How much of the file a save would remove before §13.2's guard fires.
 *
 * Reported so the caller can name the loss — "this will remove 380 lines" — rather than asking
 * "are you sure?" about a number the user cannot see.
 */
export interface TruncationDetail {
  readonly wasBytes: number
  readonly willBeBytes: number
}

/**
 * Saves new bytes over an existing document, atomically, and returns the new baseline.
 *
 * **A `DocumentBaseline` is required and cannot be constructed** — the only source is a completed
 * `loadDocument`. That is §13.2's "no save without a load" expressed as a type: a caller that
 * skipped the read has nothing to pass here.
 *
 * This verb only ever *replaces* an existing file. Creating a new one is a different operation with
 * different semantics (§13.6's exclusive create) and lives elsewhere; keeping them apart is what
 * stops a save from quietly becoming a create when the file it meant to replace has vanished.
 */
export async function saveDocument(
  root: RegisteredRoot,
  segments: readonly string[],
  baseline: DocumentBaseline,
  bytes: Buffer,
  options: SaveOptions = {},
  openTemp: TempOpener = createTemp,
  syncDir: DirectorySync = syncDirectory,
): Promise<Result<DocumentBaseline>> {
  const fileName = segments[segments.length - 1]
  if (fileName === undefined || !isMarkdown(fileName)) {
    return fail(ErrorCode.NOT_MARKDOWN, 'only markdown documents are writable')
  }
  if (bytes.length > MAX_EDITABLE_BYTES) {
    return fail(ErrorCode.TOO_LARGE, `${bytes.length} bytes exceeds the editable cap`)
  }

  /**
   * §12's gate on the way **in**, and it was missing until 2026-08-08.
   *
   * The gate on `loadDocument` stops a non-editable file being opened. It does nothing about
   * content arriving here: a caller that loads an ordinary document, gets its hash, and saves back
   * bytes containing a NUL **turns a clean markdown file into one this app can never open again**.
   * The sequence above gated the name, the size and the truncation, and never the content.
   *
   * "The editor cannot type a NUL" is not the answer. That is the same reasoning `loadDocument`'s
   * own comment names as the thing that let the old app write wherever it was pointed — a property
   * of the client asserted as a property of the server, which is also the shape of the retracted
   * `MAX_STREAMS_PER_CLIENT` claim in M-thread item 27.
   */
  const refusal = editabilityRefusal(bytes)
  if (refusal !== null) return fail(ErrorCode.NOT_EDITABLE, refusal)

  const truncation = truncationCheck(baseline.size, bytes.length)
  if (truncation !== null && options.confirmedTruncation !== true) {
    return fail(
      ErrorCode.TRUNCATION_BLOCKED,
      `${truncation.wasBytes} bytes would become ${truncation.willBeBytes}`,
    )
  }

  // Proving the destination is still what was loaded. This re-runs the whole of §4 — containment,
  // symlinks, hard links, regular-file, and the TOCTOU identity close — before anything is written.
  const verified = await verifyDestination(root, segments, baseline)
  if (!verified.ok) return verified

  return writeThroughTemp(root, segments, fileName, bytes, verified.value.mode, openTemp, syncDir)
}

/** §13.2's truncation guard: zero bytes, or under half. Returns null when the save is ordinary. */
export function truncationCheck(wasBytes: number, willBeBytes: number): TruncationDetail | null {
  // An empty file legitimately stays empty — that is not a truncation, it is a no-op, and blocking
  // it would make an empty note unsaveable.
  if (wasBytes === 0) return null
  // `< wasBytes / 2` and not `<=`: exactly half is the boundary §13.2 names, and the guard fires
  // *below* it. Written as a multiplication to keep the comparison in integers.
  //
  // A `willBeBytes === 0 ||` clause stood here and has been REMOVED: `wasBytes` is already known
  // to be non-zero, so zero always satisfies the halving test and the clause could never fire on
  // its own. It read as the rule's most important case while carrying none of it — the same shape
  // as the constants this build has found dead by construction elsewhere, and the kind of line a
  // later reader cites as coverage. Zero is still blocked; the test below pins that.
  if (willBeBytes * 2 < wasBytes) return { wasBytes, willBeBytes }
  return null
}

interface VerifiedDestination {
  /** The destination's permission bits, to be reapplied to the temp before the rename. */
  readonly mode: number
}

/**
 * Confirms the file at the path is byte-for-byte the one the caller loaded, and that we can write.
 *
 * The hash is read **fresh from the descriptor**, never from the index — §13.4 (F4.6). An index is
 * a cache, and a cache that is one event behind turns "the file changed" into "no conflict".
 */
async function verifyDestination(
  root: RegisteredRoot,
  segments: readonly string[],
  baseline: DocumentBaseline,
): Promise<Result<VerifiedDestination>> {
  const opened = await openFileForRead(root, segments)
  if (!opened.ok) return opened
  const handle = opened.value

  try {
    /**
     * **The inode is deliberately NOT consulted here, and a first draft of this function got it
     * wrong.** It refused when `(dev, ino)` differed from the baseline, which reads as prudent and
     * is the exact false positive §13.4 warns about:
     *
     *   "false positives are equally harmful — an agent rewriting identical bytes would spawn a
     *   permanent conflict artifact, which on this tree is the *common* case."
     *
     * Any agent that writes safely — read, modify, write a temp, rename — moves the inode on every
     * single save, **including when it changes nothing**. Under an inode check, a formatter that
     * finds nothing to fix would make the open document unsavable, and each refusal spawns a
     * conflict file that nothing in this app can ever delete.
     *
     * §13.4 is unambiguous about the test: *"A conflict exists if and only if the content hash
     * differs."* If a genuinely different file was moved into the path, its bytes differ and the
     * hash catches it. If the bytes are identical, then what the user is about to overwrite is
     * exactly what they were shown, and the inode underneath it is not their concern.
     *
     * `(dev, ino)` stays in the baseline because §13.4 requires capturing it and because §13.8's
     * row actions — rename, move, duplicate — do need object identity rather than content. It is
     * the *save* verb that must not use it.
     */
    const current = await readAllBytes(handle)
    if (!current.ok) return current
    const settled = await confirmUnchangedDuringRead(handle)
    if (!settled.ok) return settled

    if (hashBytes(current.value) !== baseline.sha256) {
      // §13.4: "A conflict exists if and only if the content hash differs." Not mtime, which `mv`
      // moves backwards; not size, which an equal-length edit leaves alone.
      return fail(ErrorCode.CONFLICT_DETECTED, 'the file changed since it was loaded')
    }

    const stat = await handle.file.stat()
    const writable = await checkWritable(composePath(root, segments))
    if (!writable.ok) return writable

    return ok({ mode: stat.mode & 0o7777 })
  } finally {
    await handle.file.close()
  }
}

/**
 * Asks the kernel whether this file can be written, and distinguishes *why* it cannot.
 *
 * §13.2 requires checking "mode and the `uchg`/`schg` flags explicitly", because `rename(2)`
 * **succeeds over a non-writable file** when the parent is writable — so nothing later in this
 * sequence would catch it, and the user would be typing into a document they can never save.
 *
 * Node cannot read `st_flags`; the flag is invisible to `stat`, measured on this machine. But
 * `access(W_OK)` sees it, and the two failures arrive as different errnos:
 *
 *   - `EACCES` → the permission bits deny it (a Get Info change)
 *   - `EPERM`  → an immutable flag (`chflags nouchg`)
 *
 * **This is a pre-check for a good error message, not the protection.** `access` answers about a
 * path at a moment and is a textbook TOCTOU; the actual protection is that the kernel refuses the
 * `rename` with `EPERM` too — also measured. So a race here costs a worse error, never a lost file.
 */
async function checkWritable(absolute: string): Promise<Result<null>> {
  try {
    await fsp.access(absolute, constants.W_OK)
    return ok(null)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'EPERM') {
      return fail(ErrorCode.FILE_IMMUTABLE, 'the file is locked with an immutable flag')
    }
    if (code === 'EACCES') {
      return fail(ErrorCode.PERMISSION_DENIED, 'the file is not writable')
    }
    return fail(ErrorCode.IO_FAILED, `writability check failed: ${code ?? 'unknown'}`)
  }
}

/** Composed the same way `containment` composes it: `join`, never `resolve`. Spec §4. */
function composePath(root: RegisteredRoot, segments: readonly string[]): string {
  return join(root.absolutePath, ...segments)
}

/**
 * Builds a temp name that fits, in bytes.
 *
 * The decoration is 21 bytes: a leading dot, `.tmp-`, and 16 hex characters. If the basename plus
 * that decoration exceeds `NAME_MAX`, the **basename** is trimmed — never the random suffix, which
 * is what makes the name unpredictable and therefore un-pre-placeable.
 *
 * Trimmed on a byte boundary that does not split a UTF-8 sequence, because the filesystem counts
 * bytes and a split sequence produces a name no one can type.
 */
export function tempNameFor(basename: string, random: string): Result<string> {
  const decorationBytes = TEMP_PREFIX.length + TEMP_INFIX.length + random.length
  const budget = NAME_MAX_BYTES - decorationBytes
  if (budget <= 0) return fail(ErrorCode.NAME_TOO_LONG, 'no room for a temp name')

  let base = basename
  if (Buffer.byteLength(base, 'utf8') > budget) {
    const truncated = Buffer.from(base, 'utf8').subarray(0, budget)
    // Drop any trailing bytes that form an incomplete UTF-8 sequence.
    base = truncated.toString('utf8').replace(/�+$/u, '')
    if (base.length === 0) return fail(ErrorCode.NAME_TOO_LONG, 'name does not fit')
  }
  return ok(`${TEMP_PREFIX}${base}${TEMP_INFIX}${random}`)
}

/**
 * Everything after the destination is verified: temp, write, fsync, assert, rename, fsync dir.
 *
 * The temp lives **in the destination's own directory** (§13.3, F7.3). v1 said "same filesystem but
 * not inside a watched folder", which is unsatisfiable on an external drive: it produces `EXDEV`,
 * and the builder then falls back to a non-atomic write — the exact thing the rule forbids.
 */
async function writeThroughTemp(
  root: RegisteredRoot,
  segments: readonly string[],
  fileName: string,
  bytes: Buffer,
  mode: number,
  openTemp: TempOpener,
  syncDir: DirectorySync,
): Promise<Result<DocumentBaseline>> {
  const destination = composePath(root, segments)
  const directory = dirname(destination)

  const opened = await openTemp(directory, fileName)
  if (!opened.ok) return opened
  const { handle, path: tempPath } = opened.value

  let renamed = false
  let leaveForSweep = false
  try {
    // 1. Write, checking the returned count. A short write that is not noticed here becomes a
    //    truncated file at step 3 — and if step 3 were also missing, a truncated file on disk.
    let written = 0
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written)
      // A volume that is full stops making progress. A merely SHORT write is ordinary POSIX and
      // the loop above handles it by calling again — conflating the two is how a full-disk mock
      // ends up proving nothing.
      if (bytesWritten === 0) break
      written += bytesWritten
    }
    /**
     * **There is deliberately no `written !== bytes.length` check here.**
     *
     * One stood in this spot and the mutation sweep found it undefended — not because it was
     * untested, but because it was *unreachable as a distinct outcome*: `baselineFrom` fstats the
     * descriptor a few lines below and refuses the identical case with the identical code, so
     * deleting this check left every test green. A second check that no test can tell apart from
     * the first is not defence in depth; it is a line a later reader cites as coverage.
     *
     * The single assertion lives in `baselineFrom`, where it is structural: it cannot be reordered
     * away, because without a baseline there is nothing to return and the rename below is
     * unreachable.
     */

    // 2. fsync. Without this the rename can be durable while the CONTENT is not — the crash window
    //    that leaves a correctly-named empty file.
    await handle.sync()

    // 3. The destination's permission bits carry over. The temp was created 0600 so that nothing
    //    can read a half-written document; this restores what the file actually had. Does not
    //    touch mtime, so it cannot disturb the baseline taken next.
    await handle.chmod(mode)

    // 4. The new baseline, from the TEMP descriptor, after fsync and before the rename — §13.4.
    //    Re-`stat`ing the destination after the rename would adopt an agent's interleaved write as
    //    our own starting point, which is how a conflict silently stops firing.
    //
    //    **This is also where the C3 size assertion lives.** `baselineFrom` fstats the descriptor
    //    and refuses if it disagrees with the byte count, so a short write on a full disk cannot
    //    produce a baseline — and without a baseline this function cannot reach the rename below.
    //    The assertion is structural rather than a step that could be reordered away.
    const next = await baselineFrom(handle, bytes)
    if (!next.ok) return next

    // 5. Close before renaming. The rename is the first irreversible act in this function and
    //    everything that could fail has now failed.
    await handle.close()

    try {
      // REPLACE-RENAME — §13.6, and this is the *only* place in the codebase permitted to call a
      // plain `rename(2)`. It clobbers by design, and it is safe here for one reason: the thing it
      // clobbers was identified by (dev, ino) and hash moments ago. Every user-facing rename uses
      // exclusive semantics instead.
      await fsp.rename(tempPath, destination)
      renamed = true
    } catch (error) {
      return renameFailure(errnoOf(error))
    }

    /**
     * 6. `fsync` the DIRECTORY, so the rename itself survives a power loss. Without it the entry
     *    can be lost while both files' contents are durable — leaving the old content in place,
     *    which is the safe direction, but leaving the temp behind and the save silently undone.
     *
     * **A FAILURE HERE NO LONGER FAILS THE SAVE. Changed 2026-08-16; this reverses a decision that
     * was made deliberately, so the old argument is answered rather than deleted.**
     *
     * It read: *"A failure here is reported rather than swallowed — the data is on disk either way,
     * but the caller has been told the save is durable and that would no longer be strictly true."*
     * Every clause of that is correct. It stops one step short of asking what the caller **does**
     * with the failure.
     *
     * The rename on line above has already happened. The bytes are at the path, complete, with the
     * right permissions. Reporting `IO_FAILED` for that is not a cautious answer, it is a **false
     * one** — and the client believes it: it keeps the buffer dirty, never advances its hash, and
     * re-sends against a baseline the disk has moved past. That bred one byte-identical conflict
     * artifact per retry until `services.ts` was taught that identical bytes are not a conflict.
     *
     * **And the failure is not rare on the volume that has it — it is total.** A filesystem that
     * refuses `fsync` on a directory descriptor refuses every one, so *every save* on that disk
     * reports failure while working perfectly. That is not a durability caveat, it is an app that
     * says "Not saved" forever, on an external or network drive, which is exactly where the code
     * already expects to meet this.
     *
     * So the trade is: a **false failure on every save** against a **weaker guarantee that the
     * directory entry survives a power cut in the window before the next flush**. The file's
     * *contents* are already `fsync`ed at step 2 either way; what is at risk is only the rename's
     * durability, and only until the OS flushes the directory on its own.
     *
     * **Swallowed here rather than made a third outcome**, because `Result` has two and widening it
     * would put a "saved, probably" state in front of a person for a distinction they cannot act
     * on. If this ever needs to be visible, the place is the server's mutation log — which already
     * records every write and is where an operational fact belongs — not the type a save returns.
     */
    try {
      await syncDir(directory)
    } catch {
      // Deliberately empty; see above. The save succeeded, and it is reported as it happened.
    }

    return ok(next.value)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOSPC' || code === 'EDQUOT') {
      // §13.2: "ENOSPC/EDQUOT → sticky named error, buffer retained, temp left for the sweep,
      // never renamed." Left rather than cleaned up because the startup sweep owns orphaned temps
      // and because an unlink on a full volume is one more call that can fail while we are already
      // handling a failure.
      leaveForSweep = true
      return fail(ErrorCode.DISK_FULL, 'the volume is full')
    }
    return fail(ErrorCode.IO_FAILED, `write failed: ${code ?? 'unknown'}`)
  } finally {
    // The handle is closed on the success path before the rename; closing twice is harmless and
    // closing on every failure path is what stops a descriptor leaking on a retry loop.
    await handle.close().catch(() => { /* already closed, or the failure we are reporting */ })
    if (!renamed && !leaveForSweep) {
      // Nothing was renamed, so the destination is untouched and the temp is litter. A failure to
      // remove it is not worth converting a real error into a different one — the sweep collects
      // anything left behind.
      await fsp.unlink(tempPath).catch(() => { /* the sweep will take it */ })
    }
  }
}

function renameFailure(code: string | undefined): Result<DocumentBaseline> {
  if (code === 'EPERM' || code === 'EACCES') {
    // The kernel refusing the rename is the *real* protection behind `checkWritable` — reached
    // when the flag or the mode changed between the pre-check and here.
    return fail(ErrorCode.FILE_IMMUTABLE, 'the destination refused to be replaced')
  }
  if (code === 'ENOENT') {
    return fail(ErrorCode.PARENT_MISSING, 'the destination directory vanished mid-write')
  }
  return fail(ErrorCode.IO_FAILED, `rename failed: ${code ?? 'unknown'}`)
}

export interface OpenTemp {
  readonly handle: fsp.FileHandle
  readonly path: string
}

/**
 * Creates the temp exclusively, retrying only on a genuine collision.
 *
 * `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600. The `O_NOFOLLOW` matters even though the name is random:
 * §13.3 names the attack — a predictable temp path pre-created as a symlink by an agent would
 * redirect the user's document somewhere else entirely.
 *
 * **One measured detail that would otherwise become a wrong check:** when the path exists as a
 * symlink, this fails **`EEXIST`, not `ELOOP`** — `O_EXCL` wins over `O_NOFOLLOW`. Code that
 * detected the redirect by testing for `ELOOP` would never fire. The defence is the refusal itself,
 * and the retry below simply picks a new name.
 */
export async function createTemp(directory: string, fileName: string): Promise<Result<OpenTemp>> {
  let lastCode: string | undefined
  for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt++) {
    const named = tempNameFor(fileName, randomBytes(TEMP_RANDOM_BYTES).toString('hex'))
    if (!named.ok) return named

    const tempPath = join(directory, named.value)
    try {
      const handle = await fsp.open(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        0o600,
      )
      return ok({ handle, path: tempPath })
    } catch (error) {
      lastCode = errnoOf(error)
      if (lastCode === 'EEXIST') continue
      if (lastCode === 'ENOENT') {
        // §13.3: "Writes never create directories. A write whose parent doesn't exist fails
        // loudly." This is the loud part — no `mkdir`, no recovery, a named refusal.
        return fail(ErrorCode.PARENT_MISSING, 'the destination directory does not exist')
      }
      if (lastCode === 'ENOSPC' || lastCode === 'EDQUOT') {
        return fail(ErrorCode.DISK_FULL, 'the volume is full')
      }
      if (lastCode === 'EACCES' || lastCode === 'EPERM') {
        return fail(ErrorCode.PERMISSION_DENIED, 'cannot create a temp file in that directory')
      }
      return fail(ErrorCode.IO_FAILED, `temp create failed: ${lastCode ?? 'unknown'}`)
    }
  }
  return fail(ErrorCode.IO_FAILED, `temp name collided ${TEMP_ATTEMPTS} times (${lastCode ?? '?'})`)
}

/**
 * `fsync` on the directory, so the rename survives a power loss.
 *
 * Opened read-only: macOS refuses `O_WRONLY` on a directory, and `fsync` on a read-only descriptor
 * is the documented way to do this.
 *
 * **This throws, and its one caller catches.** The paragraph that used to sit here argued the
 * opposite — that a failure should be reported — and the reversal, with the whole argument, is at
 * the call site in `writeThroughTemp`, because that is where the rename it is protecting has
 * already happened and where the reasoning can be checked against it.
 */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
