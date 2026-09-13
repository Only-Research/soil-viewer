/**
 * Opening a validated file for streaming. Spec §2, §4, §9.
 *
 * **This module exists because of a layering rule, and the rule is right.** `GET /file` was written
 * with `createReadStream` in `src/server`, and the lint refused it: *"Filesystem access lives only
 * in `src/core/fs` — everything else takes a validated handle."*
 *
 * That is not a formality. The server layer knows about HTTP and nothing about containment; the
 * moment it can open a path itself, the §4 checker becomes something a route has to remember to
 * call rather than something it cannot avoid. Here the two are one operation: this function walks
 * and verifies, and hands back a stream **or** a refusal. There is no way to get the stream without
 * the check having run.
 */

import { constants, createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { walkAndVerify, type RegisteredRoot } from './containment'

/**
 * `O_RDONLY | O_NOFOLLOW`, in the shape `createReadStream` will take.
 *
 * **A cast, and the proof it is safe lives in a test rather than in the type.** Node's
 * `stringToFlags` returns a numeric argument unchanged, so the number reaches `open(2)` — but
 * `@types/node` declares `flags` as `string`, so the types cannot express what the runtime accepts.
 *
 * The alternative was `fsp.open` with real numeric flags and `createReadStream({ fd })`, which is
 * type-clean and **async** — and `open()` here is deliberately synchronous because `file-route.ts`
 * calls it after the response head is written. Changing that is the route-shape question the security review's
 * ruling holds open; it is not something to smuggle in as a typing workaround.
 *
 * So the cast stands and `read-bytes.test.ts` fires it instead of reasoning about it: without the
 * flag the symlink is followed, with it the open fails `ELOOP`, both asserted in the same run. If
 * that ever stops holding, the test goes red rather than the protection going quiet.
 */
// Exported ONLY so the test can assert the constant this module actually uses. A test that
// rebuilds the flags itself proves the kernel honours a combination, not that we pass it —
// and blanking this line left that test green, which is how it was found.
export const NOFOLLOW_READ = (constants.O_RDONLY | constants.O_NOFOLLOW) as unknown as string

/** A file that has been verified, with the facts a response needs about it. */
export interface OpenedForReading {
  readonly size: number
  readonly name: string
  /**
   * Opens the bytes. Called after the response head is written, so that a failure to open cannot
   * arrive after a `200` — and takes the range because a partial response must not read the whole
   * file to serve a slice of it.
   */
  readonly open: (range?: { readonly start: number; readonly end: number }) => Readable
}

/**
 * Verifies a path and returns the means to read it.
 *
 * The `stat` and the later `open` are two operations on one path, so a file replaced between them
 * is served with the new content under the old length. That window is the reason the response is
 * built from **this** `size` and the stream is bounded by it: a mismatch truncates or short-reads
 * rather than confusing the client's byte count, and §9's whole subject is bytes arriving intact.
 */
export async function openForReading(
  root: RegisteredRoot,
  segments: readonly string[],
): Promise<Result<OpenedForReading>> {
  const entry = await walkAndVerify(root, segments)
  if (!entry.ok) return entry
  if (entry.value === null) return fail(ErrorCode.IO_FAILED, 'no such file')
  if (entry.value.kind !== 'file') return fail(ErrorCode.NOT_REGULAR_FILE, 'not a regular file')

  /**
   * **`st_nlink > 1` is refused here, and this was missing until 2026-08-16.** The security review's N1.
   *
   * §4's own header states the case in its own words: *"`ln ~/.ssh/id_ed25519 /soil/notes.md`
   * passes every other check."* It passed this one. `openFileForRead` refuses a hard link twice —
   * on the `lstat` and again on the descriptor — and `copy.ts` and `rename.ts` refuse it, and
   * **nothing on this path did, nor anything downstream in `file-route.ts`.**
   *
   * So `GET /file` served any file on the volume that anything able to write inside a registered
   * folder had linked into one. **No race to win**: one `link(2)`, then an ordinary request. §1
   * grants a tailnet caller reads *inside a registered folder*; a hard link is not a grant, and the
   * byte route was serving what the JSON route refuses. That divergence also falsifies the premise
   * the P7 gate accepted the ticket-in-URL widening on — *"anything holding the ticket can already
   * read the same bytes via `file.load`"* — which it could not.
   *
   * Reproduced before it was fixed, with both controls in the same run: an honest file served, the
   * same linked file refused by `loadDocument`, and the probe returning the decoy's bytes.
   */
  if (entry.value.nlink > 1) {
    return fail(ErrorCode.HARDLINKED, `link count ${entry.value.nlink}`)
  }

  const absolute = join(root.absolutePath, ...segments)
  const name = segments[segments.length - 1] ?? ''

  return ok({
    size: entry.value.size,
    name,
    /**
     * **`O_NOFOLLOW` on the deferred open**, because this opens a *path* rather than the descriptor
     * the walk verified — the same defect shape as `append.ts`, one file away.
     *
     * The walk `lstat`ed every segment and refused a symlinked one, but that was a different
     * operation on the same path, and this open happens later. The flag makes the kernel refuse if
     * the final component has become a symlink in between, which is the half of the window that can
     * be closed without moving where the response head is written.
     *
     * **What is NOT closed, stated rather than left for a reader to discover:** a `(dev, ino)`
     * re-check against the walked identity. That needs the open to happen *before* the head is
     * committed — `open()` returns a `Readable` synchronously and `file-route.ts` calls it after
     * `writeHead` on purpose — so it is a route-shape change rather than a patch, and the security review's ruling
     * of 2026-08-16 requires that shape to come back to them. The residual is a file *replaced* (not
     * symlinked, not linked) between the walk and the open, which `size` already bounds.
     */
    open: range => createReadStream(absolute, {
      flags: NOFOLLOW_READ,
      ...(range === undefined ? {} : { start: range.start, end: range.end }),
    }),
  })
}
