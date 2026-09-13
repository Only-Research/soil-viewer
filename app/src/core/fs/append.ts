/**
 * **THE ONE WRITE IN THIS BUILD THAT IS NOT A TEMP-AND-RENAME.** Spec §14.
 *
 * Every other write goes through `writeThroughTemp`: write a temp file, verify, rename over the
 * target. That is what makes a save atomic and what makes a crash mid-write leave the original
 * intact. An append deliberately does not, and the spec says why in one clause:
 *
 * > *"under the per-inode lock, re-read the tail, recompute the number, and **append with
 * > `O_APPEND` directly** — no temp+rename, which is also what preserves the kernel's append
 * > atomicity."*
 *
 * Temp-and-rename would be **worse** here, and not by a little. It reads the whole file, adds a
 * message, and writes the result back — so a message an agent appended in the meantime is inside
 * the bytes that get overwritten, and posting from the phone would silently delete it. `O_APPEND`
 * has the kernel place the write at the current end of file as one operation; nothing that arrived
 * first can be lost by something that arrives second.
 *
 * ## Appends are exempt from conflict detection, and that is counterintuitive
 *
 * > *"An append does not depend on prior bytes; that is what makes it an append. Under v1's rule,
 * > an agent posting while the phone appends would send the phone's message to a conflict sibling,
 * > and the conversation becomes two files with two composers and broken numbering."*
 *
 * So there is no `expectedHash` in this function's signature, and its absence is the feature. What
 * replaces it is the lock plus the re-read: the number is computed from the bytes that are there at
 * the moment of writing, not from the bytes the client last saw.
 *
 * ## What is still enforced
 *
 * Everything §4 and §12 enforce about *where* and *what*. The file must be inside the root, reached
 * through no symlink, a regular file, not hard-linked, markdown by the one predicate, and the bytes
 * being added must pass §12's editability gate — a NUL appended into a conversation makes the file
 * unopenable by this app forever, and would arrive from the same composer as everything else.
 *
 * **The file must already exist.** An append does not create: the composer only appears on a
 * conversation somebody is reading, so a create here would mean the client named a path that was
 * not on screen.
 */

import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isMarkdown } from '../grammar'
import { openFileForRead, readAllBytes, type RegisteredRoot } from './containment'
import { editabilityRefusal } from './document'

export interface AppendOutcome {
  /** The bytes the file held **before** this append — what the number was computed from. */
  readonly existing: string
  /** The size after the append, for the caller to report. */
  readonly size: number
}

/**
 * Reads a document's current bytes and appends `addition` to it, under the caller's lock.
 *
 * **The read and the append are one operation only because the caller holds the lock.** This
 * function does not take it: §13.8's rule is that the route layer owns a mutation's beginning and
 * end, and taking the lock here would serialize the halves of a compound operation separately —
 * which is the same gap in a different shape, and `mutation-lock.ts` says so in its own header.
 */
/**
 * Opens the verified path for appending. **Injected, and the injection is the only way the guards
 * below can be tested at all.**
 *
 * Every check on the re-open defends the window between the read closing its descriptor and this
 * opening a new one — and the read refuses symlinks, hard links and missing files *first*, so a test
 * driving `appendToDocument` from outside can never reach any of them. Measured, not assumed: with
 * no seam, removing `O_NOFOLLOW`, the identity re-check, the `nlink` re-check **and** the short-write
 * guard each left all nine tests green.
 *
 * That is the same instrument `write.ts` uses for its `openTemp` and the one the security review's ruling of
 * 2026-08-16 required for §4's controls, over the objection that they *"cannot be provoked from a
 * test"* — which is true of a race and false of a seam.
 */
export type AppendOpener = (path: string) => Promise<FileHandle>

/** The real one. Exported so a test can change the filesystem and then delegate to it. */
export const openForAppend: AppendOpener = path =>
  open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)

export async function appendToDocument(
  root: RegisteredRoot,
  segments: readonly string[],
  addition: string,
  openHandle: AppendOpener = openForAppend,
): Promise<Result<AppendOutcome>> {
  const fileName = segments[segments.length - 1]
  if (fileName === undefined || !isMarkdown(fileName)) {
    return fail(ErrorCode.NOT_MARKDOWN, 'only markdown documents can be appended to')
  }

  const bytes = Buffer.from(addition, 'utf8')
  /**
   * §12's gate on the way in, on the bytes being added. `saveDocument` learned this the hard way —
   * its own comment records that the gate on the way *out* did nothing about content arriving, and
   * that a caller saving a NUL turns a clean markdown file into one the app can never open again.
   * An append is the same door with a smaller opening.
   */
  const refusal = editabilityRefusal(bytes)
  if (refusal !== null) return fail(ErrorCode.NOT_EDITABLE, refusal)

  /**
   * The existing bytes are read through the **same** guarded reader the editor uses, so containment,
   * symlink refusal, hard-link refusal, the regular-file check and the torn-read check all apply
   * exactly as they do on the load path. Re-implementing any of that here would be a second opinion
   * about what is safe to open.
   */
  const opened = await openFileForRead(root, segments)
  if (!opened.ok) return opened
  /**
   * **The identity of the file that was verified**, captured before the descriptor is released so
   * the re-open below can be checked against it. `VerifiedHandle` carries these precisely so a
   * caller need not re-`stat` to know what it was given.
   */
  const verified = { dev: opened.value.dev, ino: opened.value.ino }
  let existing
  try {
    existing = await readAllBytes(opened.value)
  } finally {
    // `finally`, so a failed read still releases the descriptor. A conversation is the surface
    // somebody posts to all day; leaking one handle per attempt exhausts the process eventually.
    await opened.value.file.close()
  }
  if (!existing.ok) return existing

  const before = existing.value.toString('utf8')

  /**
   * `O_APPEND` positions every write at the current end of file, so two appends arriving together
   * produce both messages in some order rather than one overwriting the other — and a message an
   * agent added between the read above and this write is still there underneath the new one.
   *
   * ## Explicit flags, and no `O_CREAT`. Changed 2026-08-16 — the security review's ruling on the sweep.
   *
   * This read `open(path, 'a')`. Node's `'a'` is `O_WRONLY | O_CREAT | O_APPEND` — **no
   * `O_NOFOLLOW`** — and the comment here argued the create was unreachable because
   * `openFileForRead` had already refused a missing file. That is check-then-act stated as a
   * guarantee. A flag that is never wanted is not defended by reasoning; it is deleted.
   *
   * **This is the only write open in the build that opens an EXISTING path**, which is why
   * `O_NOFOLLOW` is load-bearing here and was correctly recorded as redundant elsewhere: every
   * other write open carries `O_CREAT | O_EXCL`, and exclusive create refuses a final-component
   * symlink with `EEXIST` on its own. There is no `O_EXCL` here to win first.
   */
  let handle
  try {
    handle = await openHandle(join(root.absolutePath, ...segments))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ELOOP is the final component having become a symlink between the read and here. An attack
    // signal, and named as one rather than folded into a generic I/O failure.
    if (code === 'ELOOP') return fail(ErrorCode.PATH_SYMLINK, 'became a symlink before append')
    return fail(ErrorCode.IO_FAILED, `append could not open the file: ${code ?? 'unknown'}`)
  }

  try {
    /**
     * **The re-opened path is proven to be the file that was verified, before a byte is written.**
     *
     * §4: *"all I/O goes through that descriptor, never a re-opened path."* This function cannot
     * obey that literally — the verified descriptor is `O_RDONLY` and cannot be appended through —
     * so it does the next thing: re-opens, then proves the identity matches.
     *
     * **The window is not hypothetical and needs no attacker.** `chatroom.append` takes the lock on
     * the *file* path; `entry.rename` and `card.move` take theirs on the *parent folder*. The two
     * key namespaces cannot collide, so an ordinary rename by the operator's own other client is not
     * serialized against this append and can land in exactly this gap. The operator deprioritised
     * closing the namespace split, correctly — this is what makes that safe to leave.
     *
     * `nlink` too: the read handle checked it, and the file this opened is not proven to be that
     * file until the comparison above succeeds.
     */
    const stat = await handle.stat({ bigint: true })
    if (stat.dev !== verified.dev || stat.ino !== verified.ino) {
      return fail(ErrorCode.IDENTITY_CHANGED, 'the file was replaced before the append')
    }
    if (Number(stat.nlink) > 1) {
      return fail(ErrorCode.HARDLINKED, `link count ${Number(stat.nlink)}`)
    }

    /**
     * **Looped, like the other four writes in this build.** A short write is ordinary POSIX; under
     * `O_APPEND` the remainder is still placed at the new end of file, so calling again is correct
     * and the loop has the same shape as `write.ts`'s. A volume that is full stops making progress
     * rather than writing short repeatedly, which is why zero breaks rather than spins.
     */
    let written = 0
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written)
      if (bytesWritten === 0) break
      written += bytesWritten
    }
    if (written !== bytes.length) {
      return fail(ErrorCode.IO_FAILED, `append wrote ${written} of ${bytes.length} bytes`)
    }
    // Flushed before the lock is released. A conversation that reported a message as posted and
    // then lost it to a power cut is the one failure this surface must not have.
    await handle.sync()
    const after = await handle.stat()
    return ok({ existing: before, size: after.size })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return fail(ErrorCode.IO_FAILED, `append failed: ${code ?? 'unknown'}`)
  } finally {
    await handle.close()
  }
}
