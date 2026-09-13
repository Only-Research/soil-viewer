/**
 * Loading an editable document, and the baseline every write is measured against.
 *
 * Spec §13.2, §13.4, §6. Core layer: no HTTP, no browser, no third-party code.
 *
 * This module exists to close **C2, the cheapest total-loss path in the whole build**, and the one
 * the old code shipped a cousin of:
 *
 *   a read fails → the editor mounts on an empty document → one keystroke → autosave →
 *   the on-disk mtime is unchanged so the conflict check passes → a 400-line file is permanently
 *   empty.
 *
 * §13.2 states the rule as **"no save without a load"**. A rule phrased that way is satisfied by
 * remembering it, and this build has now watched enough controls be correct-and-unreached to
 * distrust that. So the rule is expressed in the type system instead: a write requires a
 * `DocumentBaseline`, and **the only way to obtain one is to complete a successful load**. A
 * caller who skipped the read has nothing to pass, and the program does not compile.
 *
 * The write half lands later in this phase. The baseline is defined here, with the load, because
 * §13.4 requires it be captured **from the descriptor that was actually read** — not re-`stat`ed
 * from the path afterwards, which would adopt whatever an agent wrote in between as our own
 * starting point.
 */

import { createHash } from 'node:crypto'
import type { promises as fsp } from 'node:fs'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isMarkdown } from '../grammar'
import {
  openFileForRead,
  readAllBytes,
  type RegisteredRoot,
  type VerifiedHandle,
} from './containment'

/**
 * Spec §6 and §12. The largest file the editor will open.
 *
 * **Lives in Core, not in the server's limits file, and that is a layering fix rather than a
 * preference.** §6 makes this a rule about documents — which files are editable, and therefore
 * which files may be written — and Core is where the write gate enforces it. Core cannot import
 * from an adapter, so a copy in the server layer would have been a second number free to drift
 * from this one; §6 says of the markdown predicate that "divergence is a build failure", and the
 * same reasoning applies to the size that decides whether an edit is even possible.
 * `server/limits.ts` re-exports this and derives the body cap from it.
 *
 * Distinct from `MAX_READ_BYTES` (25 MB, spec §4), which bounds *any* read — a 10 MB file is
 * readable for indexing and is not editable.
 */
// See `core/limits.ts`: the client needs this number and must not import this module for it.
export { MAX_EDITABLE_BYTES } from '../limits'
import { MAX_EDITABLE_BYTES } from '../limits'

/**
 * **§12's editability gate, and the only copy of it.** A `.md` file is editable if and only if its
 * bytes decode as valid UTF-8 **with no NUL**. Returns the reason it is not, or `null`.
 *
 * ## Why it lives in Core, next to `MAX_EDITABLE_BYTES`
 *
 * Same reasoning, and it is a layering rule rather than a preference: §6 and §12 make this a rule
 * about *documents* — which files may be opened, and therefore which files may be written. Core is
 * where the write gate enforces it, Core cannot import from an adapter, and a copy in the server
 * layer would be a second answer free to drift from this one. §6 says of the markdown predicate
 * that "divergence is a build failure"; this is the same sentence about content.
 *
 * ## The two halves are independent, and only one of them was here
 *
 * **Found 2026-08-08, opening P6.** The load path in `services.ts` implemented the UTF-8 half and
 * not the NUL half — and **NUL is a perfectly legal code point**, so a NUL-bearing file decoded,
 * re-encoded byte-identically, passed, and was editable.
 *
 * That is the *identical* defect P5's corpus found in the harness's `classify` on 2026-08-07, in
 * shipped app code rather than in the instrument. Both were found the same way, and it is not by
 * reading the function: the function did exactly what its name and its comment said. It took going
 * back to the **rule** and comparing it, clause by clause, against what the code tests.
 *
 * So the two checks are written as two, named for the two clauses:
 *
 * - **The round trip** is the operational form of "valid UTF-8". It is stronger than a validity
 *   test and it is the property the app actually depends on: the wire carries a *string*
 *   (`file.load` decodes, `file.save` re-encodes), so a file whose bytes do not survive that trip
 *   would be silently rewritten by the act of opening and saving it. Invalid sequences decode to
 *   U+FFFD and re-encode to something else entirely.
 * - **NUL** survives the round trip perfectly well and is banned for a different reason: it makes
 *   the file binary. Nothing about the first check implies the second, which is exactly how one of
 *   them came to be missing without anything looking wrong.
 *
 * ## Called from both `loadDocument` and `saveDocument`
 *
 * The load gate alone stops a bad file being *opened*. It does not stop bad content being
 * *written*: a client that loads an ordinary document, gets its hash, and saves back content
 * containing a NUL turns a clean markdown file into one the app can no longer open. **That path
 * was open until this function existed** — `saveDocument`'s sequence gated the name, the size and
 * the truncation, and never the bytes.
 *
 * There is deliberately **no second copy at the transport edge.** `services.ts` used to carry its
 * own round-trip check; keeping it as defence in depth would have made this one's refusal
 * unreachable in tests — the P4 gate found a branch dead exactly that way, where a mutation
 * removing the live check came back green because a duplicate above it caught the case. One gate,
 * called twice, each call site with a test that fails without it.
 */
export function editabilityRefusal(bytes: Buffer): string | null {
  if (bytes.includes(0)) return 'this file contains a NUL byte, so it is not editable text'
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    return 'this file is not valid UTF-8 and cannot be edited without changing its bytes'
  }
  return null
}

/**
 * The phantom brand that makes a baseline unforgeable.
 *
 * Declared and never exported, so no other module can name it, and therefore no other module can
 * write an object literal that satisfies `DocumentBaseline`. It has no runtime existence at all —
 * it costs nothing and appears in no output.
 *
 * **What this does and does not defend.** It is a compile-time guarantee against *our own future
 * code taking a shortcut* — a builder three months from now who has a path and a byte count and
 * would otherwise assemble a plausible baseline by hand. That is the realistic threat: this build's
 * signature failure is a control that is correct and never reached. It is **not** a defence against
 * an attacker, who by definition is not running our compiler; anyone executing arbitrary code
 * inside this process has already won and does not need to forge a struct.
 */
declare const DOCUMENT_BASELINE: unique symbol

/**
 * What a document looked like when we read it — the token a later write is checked against.
 *
 * Spec §13.4: capture `(dev, ino, size, nanosecond mtime, SHA-256 of bytes)`, and **a conflict
 * exists if and only if the content hash differs.** The timestamps are carried because they are
 * useful to report and to compare with `!=`; they are never ordered.
 *
 * mtime is the wrong token for the decision and is ambiguous *in the direction that loses data*.
 * The decisive case: **`mv` preserves mtime**, so an agent's `mv draft.md notes.md` hands the path
 * an *older* timestamp — under a `>` comparison no conflict fires and the app writes over a
 * completely different file. Four more ways it fails are in §13.4, including that false positives
 * are equally harmful: an agent rewriting identical bytes would spawn a permanent conflict artifact,
 * and on the user's tree that is the *common* case, not the exotic one.
 */
export interface DocumentBaseline {
  readonly [DOCUMENT_BASELINE]: true
  readonly dev: bigint
  readonly ino: bigint
  readonly size: number
  readonly mtimeNs: bigint
  /** Lowercase hex SHA-256 of the exact bytes read. The only thing a conflict decision consults. */
  readonly sha256: string
}

/** A document that was fully read, with the baseline proving it. */
export interface LoadedDocument {
  readonly rootId: string
  readonly segments: readonly string[]
  /** The exact bytes on disk. Never a decoded string — see `hashBytes`. */
  readonly bytes: Buffer
  readonly baseline: DocumentBaseline
}

/**
 * SHA-256 of bytes, lowercase hex.
 *
 * **Bytes, never a decoded string**, and that is a data-safety rule rather than an efficiency one.
 * Hashing a decoded string would make the hash agree across encodings that differ on disk — a file
 * whose line endings or Unicode normalization changed would hash identically and no conflict would
 * fire. A round-trip through a string is precisely how the old editor rewrote 1,610 files, and P5's
 * harness compares bytes for the same reason.
 */
export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Builds the baseline. The single place the brand is applied, and the reason it is a cast.
 *
 * `DOCUMENT_BASELINE` is `declare`d, so it exists only in the type system and cannot appear in an
 * object literal. The cast attaches a property that is never written and never read at runtime.
 */
function brandBaseline(fields: Omit<DocumentBaseline, typeof DOCUMENT_BASELINE>): DocumentBaseline {
  return fields as DocumentBaseline
}

/**
 * **The only way to obtain a `DocumentBaseline`, and it demands evidence.**
 *
 * The write path needs to produce a baseline too, so the factory has to be exported — and an
 * exported factory taking plain fields would hand back exactly the forgery the brand exists to
 * prevent. So it takes a **live descriptor** and the **exact bytes**, derives every field from
 * them, and refuses if they disagree. A caller cannot invent a baseline without first opening a
 * real file whose size already matches the content it is claiming.
 *
 * **The size comparison here is spec §13.2's C3 assertion**, and folding it into the factory is
 * deliberate: on the write path this runs on the temp descriptor after `fsync` and before the
 * rename, so a short write on a full disk cannot produce a baseline, and a step that cannot produce
 * a baseline cannot proceed to the rename. Written as a separate step in the caller it would be a
 * check someone could later reorder or drop; here it is the thing standing between a truncated temp
 * and good content.
 *
 * On the read path it cannot fire — `readAllBytes` already refused a short read and
 * `confirmUnchangedDuringRead` already proved the size held — which is why the code it returns is
 * named for the path where it can.
 */
export async function baselineFrom(
  file: fsp.FileHandle,
  bytes: Buffer,
): Promise<Result<DocumentBaseline>> {
  let stat
  try {
    stat = await file.stat({ bigint: true })
  } catch {
    return fail(ErrorCode.IO_FAILED, 'fstat failed while taking a baseline')
  }
  if (Number(stat.size) !== bytes.length) {
    return fail(
      ErrorCode.WRITE_SIZE_MISMATCH,
      `the descriptor reports ${Number(stat.size)} bytes, the content is ${bytes.length}`,
    )
  }
  return ok(brandBaseline({
    dev: stat.dev,
    ino: stat.ino,
    size: bytes.length,
    mtimeNs: stat.mtimeNs,
    sha256: hashBytes(bytes),
  }))
}

/**
 * Loads a markdown document for editing, with the baseline a later write will be checked against.
 *
 * Order matters and each step is refusing something specific:
 *
 * 1. **The markdown gate, first and server-side.** §6: `isMarkdown()` is the one extension test in
 *    the codebase, and write and append accept only paths satisfying it **regardless of what the
 *    client asked**. Checked before the file is even opened, because "the UI only offers `.md`" is
 *    exactly the reasoning that let the old app write wherever it was pointed.
 * 2. **`openFileForRead`**, which is P1's and carries all of §4: containment re-verified after
 *    composition, no symlinked segment, `O_NOFOLLOW`, regular files only, `nlink === 1`, the 25 MB
 *    read cap, and the TOCTOU close — the descriptor's own `(dev, ino)` must equal what the walk
 *    checked.
 * 3. **The editable cap**, taken from the descriptor's `fstat` rather than from a directory listing.
 * 4. **The read**, which fails rather than truncates: a short read is `SHORT_READ`, never a smaller
 *    success. That is the read half of C2.
 * 5. **A second `fstat` on the same descriptor, after the read.** See below — this is the step that
 *    is easy to leave out and it is the one that makes the baseline mean what it says.
 * 6. **§12's editability gate**, on the bytes, once the read is known to be whole — valid UTF-8
 *    with no NUL. See `editabilityRefusal`, which is also called on the write path.
 *
 * The handle is always closed, including on every failure path.
 */
export async function loadDocument(
  root: RegisteredRoot,
  segments: readonly string[],
): Promise<Result<LoadedDocument>> {
  const fileName = segments[segments.length - 1]
  if (fileName === undefined || !isMarkdown(fileName)) {
    return fail(ErrorCode.NOT_MARKDOWN, 'only markdown documents are editable')
  }

  const opened = await openFileForRead(root, segments)
  if (!opened.ok) return opened
  const handle = opened.value

  try {
    if (handle.size > MAX_EDITABLE_BYTES) {
      return fail(
        ErrorCode.TOO_LARGE,
        `${handle.size} bytes exceeds the ${MAX_EDITABLE_BYTES}-byte editable cap`,
      )
    }

    const read = await readAllBytes(handle)
    if (!read.ok) return read

    const settled = await confirmUnchangedDuringRead(handle)
    if (!settled.ok) return settled

    // §12's gate, on the bytes that were actually read and after the read is known to be whole.
    // Running it earlier would judge a buffer that might still be torn.
    const refusal = editabilityRefusal(read.value)
    if (refusal !== null) return fail(ErrorCode.NOT_EDITABLE, refusal)

    // Taken from the descriptor after the read has been proved intact, not from the open's stat —
    // so the baseline describes the moment we finished reading rather than the moment we started.
    const baseline = await baselineFrom(handle.file, read.value)
    if (!baseline.ok) return baseline

    return ok({
      rootId: root.id,
      segments: [...segments],
      bytes: read.value,
      baseline: baseline.value,
    })
  } finally {
    await handle.file.close()
  }
}

/**
 * Re-`fstat`s the descriptor after the read and refuses if the file moved underneath it.
 *
 * **Why this is not paranoia.** `readAllBytes` issues a sequence of `read(2)` calls against one
 * descriptor. If something rewrites the file *in place* between the first and last of them — an
 * agent using a plain `open`/`write`, which is the common case for a script that does not know
 * about atomic writes — the buffer is a **mix of the old file and the new one**. It is the right
 * length, it decodes, and nothing above notices.
 *
 * That torn buffer would then be hashed into the baseline, and the hash would match nothing that
 * has ever existed on disk. The consequence is not a failed save; it is worse. At save time the
 * on-disk hash differs from the baseline, so a conflict fires correctly — but the "mine" side of
 * the two-pane resolution (§13.5) is a document **half of which the user never saw**, and Keep Mine
 * writes it over the real file. The control works and the data is still wrong.
 *
 * A concurrent *atomic* replace cannot cause this: `rename` gives the new bytes a new inode and our
 * descriptor keeps reading the old one, which is a complete and coherent file. So this check is
 * aimed squarely at in-place writers, which is what agents editing this tree actually are.
 *
 * `size` and `mtimeNs` are compared for **inequality only**, never ordered — §13.4's rule, and it
 * matters here too: a writer that restores the mtime, or a clock that stepped backwards over NTP or
 * a wake, would slip past a `>` comparison. `(dev, ino)` is re-checked as well; it cannot change on
 * an open descriptor, and asserting it costs nothing and documents the assumption.
 *
 * Returns the confirmed post-read `mtimeNs`.
 *
 * Exported for its own tests. The interleaving it defends against is inherently racy to reproduce
 * end-to-end, and a control this quiet should not be certified only by a rig that has to win a
 * race — particularly the "never ordered" rule, which a rig using a forward-moving clock cannot
 * distinguish from a `>` comparison at all.
 */
export async function confirmUnchangedDuringRead(handle: VerifiedHandle): Promise<Result<bigint>> {
  let after
  try {
    after = await handle.file.stat({ bigint: true })
  } catch {
    return fail(ErrorCode.IO_FAILED, 'fstat after read failed')
  }

  if (after.dev !== handle.dev || after.ino !== handle.ino) {
    return fail(ErrorCode.IDENTITY_CHANGED, 'descriptor identity changed during the read')
  }
  if (Number(after.size) !== handle.size || after.mtimeNs !== handle.mtimeNs) {
    return fail(ErrorCode.CHANGED_DURING_READ, 'the file was written while it was being read')
  }
  return ok(after.mtimeNs)
}
