/**
 * The conflict artifact — the file that rescues an edit the save path refused. Spec §13.5.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * **The rule that shapes everything here:** *"If the conflict file cannot be written for any
 * reason, the buffer is retained client-side and the editor enters a blocking unsaved state. An
 * edit is never discarded because its rescue file failed."* So every function below returns a
 * typed failure and none of them throws — a rescue path that can throw is a rescue path that can
 * lose the thing it was rescuing.
 *
 * v1's conflict sibling was broken six ways and one of them **lost the edit it existed to save**.
 * The ones this module answers directly:
 *
 *   - `HHMM` granularity plus two 1-second autosaves meant the second conflict **clobbered the
 *     first**. Fixed by seconds plus a random suffix, and by exclusive create — which turns a
 *     collision into a retry instead of an overwrite.
 *   - names grew unbounded toward `NAME_MAX`, and on overflow the write failed `ENAMETOOLONG`
 *     **and the edit was gone**. Fixed by validating the generated name in bytes, before writing.
 *   - a conflict on a task in `02-next/` became a second card on the board that could never be
 *     removed, because nothing here deletes. Fixed in the grammar (P1) and depended on here: a
 *     conflict artifact never spawns a conflict child.
 */

import { randomBytes } from 'node:crypto'
import { constants, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import {
  CONFLICT_SUFFIX_ALPHABET,
  CONFLICT_SUFFIX_LENGTH,
  isConflictArtifact,
  isMarkdown,
} from '../grammar'
import { errnoOf, type RegisteredRoot } from './containment'
import { NAME_MAX_BYTES } from './write'

/**
 * `PATH_MAX` on macOS, **in bytes**. Spec §13.5 requires generated paths be validated against it.
 *
 * The deepest real path in the user's tree is 230 characters, so this is headroom rather than a
 * live constraint — but a conflict name adds 25 bytes to an already-deep path, and the failure it
 * would cause is the one §13.5 exists to prevent.
 */
export const PATH_MAX_BYTES = 1024

/**
 * How many times to retry a name that already exists.
 *
 * Spec §13.5: "exclusive create, retry with a fresh suffix, cap 50." Only the random suffix
 * changes between attempts — the timestamp is whatever second it is — so this is 50 draws from
 * 32⁴ = 1,048,576 possibilities.
 *
 * **An interpretation worth flagging rather than burying.** That sentence can also be read as a
 * cap on the *number of conflict artifacts per file*, which would be a different and stricter
 * rule. This module implements the plain reading — a retry cap — and therefore **does not bound
 * how many conflict artifacts a file can accumulate**. That matters because nothing in this app
 * deletes: an editor autosaving into a persistent conflict could grow the set indefinitely. It is
 * recorded as an open question rather than answered by inventing a limit the spec does not state.
 */
const NAME_ATTEMPTS = 50

/** Where the rescued edit landed, as folder-relative segments. */
export interface ConflictArtifact {
  readonly segments: readonly string[]
  readonly fileName: string
}

/** Injectable clock. Tests need a fixed second; production passes nothing. */
export type Clock = () => Date

/**
 * Injectable suffix generator, and it exists to make one specific failure reachable.
 *
 * The exclusive create is the control that stops a second conflict **overwriting the first** —
 * v1's clobber, which destroyed an edit inside the mechanism built to rescue edits. But with four
 * random base32 characters, two artifacts in the same second collide roughly once in a million
 * attempts, so a test using the real generator **never exercises the collision at all**: it passes
 * identically whether the create is exclusive or truncating.
 *
 * A mutation sweep found exactly that — removing `O_EXCL` left the whole suite green. So the
 * suffix is injectable, a test forces the collision, and the control is proven rather than
 * assumed. Production passes nothing and gets `randomBytes`.
 */
export type SuffixSource = () => string

/**
 * Formats the timestamp portion: `YYYYMMDD-HHMMSS`, in **local time**.
 *
 * Local rather than UTC because this name is read by a person deciding which of two versions is
 * theirs, and "the one from 14:32" only helps if 14:32 is the time they were sitting there. The
 * ordering property still holds — these sort correctly within a timezone, which is the only place
 * they are ever compared.
 */
export function conflictStamp(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(at.getFullYear(), 4)}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

/**
 * Four characters drawn from the alphabet **the grammar defines**, not a local one.
 *
 * P1 left this instruction in `grammar.ts` in capitals and it is worth repeating: generation and
 * detection drifting apart is not cosmetic. An artifact the grammar fails to recognise becomes a
 * task card that can never be removed — C5, the exact failure §13.5 was rewritten to eliminate.
 * Crockford's base32, for instance, includes digits this alphabet excludes, and picking it would
 * reintroduce C5 silently.
 *
 * `randomBytes`, never `Math.random` — the same rule §7 states for tokens, applied here because a
 * predictable name is one another process can pre-create and turn into a denial of the rescue.
 */
function randomSuffix(): string {
  const alphabet = CONFLICT_SUFFIX_ALPHABET
  // One byte per character, rejecting values that would bias the distribution toward the first
  // 8 letters. 256 is not a multiple of 32 — it is, in fact, exactly 8×32, so no rejection is
  // needed and the modulo is uniform. Stated because "% alphabet.length" is usually a bug.
  const bytes = randomBytes(CONFLICT_SUFFIX_LENGTH)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

/**
 * Splits a filename into the part before the final extension and the extension itself.
 *
 * The suffix goes **before** the extension so the artifact is still a `.md` file — otherwise it
 * would fall outside `isMarkdown()` and become unopenable in the app that created it, which is a
 * rescue file no one can read.
 */
function splitExtension(fileName: string): { base: string; ext: string } {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return { base: fileName, ext: '' }
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot) }
}

/**
 * Builds one candidate conflict name, validated in bytes.
 *
 * Trims the **base** if the result would exceed `NAME_MAX`, never the stamp or the suffix: the
 * stamp is what makes the name meaningful to a person and the suffix is what makes it unique. A
 * trimmed base still identifies the file; a trimmed suffix collides.
 */
export function conflictNameFor(fileName: string, at: Date, suffix: string): Result<string> {
  const { base, ext } = splitExtension(fileName)
  const decoration = `.conflict-${conflictStamp(at)}-${suffix}`
  const budget = NAME_MAX_BYTES - Buffer.byteLength(decoration + ext, 'utf8')
  if (budget <= 0) return fail(ErrorCode.NAME_TOO_LONG, 'no room for a conflict name')

  let trimmed = base
  if (Buffer.byteLength(trimmed, 'utf8') > budget) {
    trimmed = Buffer.from(trimmed, 'utf8').subarray(0, budget).toString('utf8')
      // Drop bytes left over from a split UTF-8 sequence rather than emit a name with a
      // replacement character in it, which no one can type and some tools mangle further.
      .replace(/�+$/u, '')
    if (trimmed.length === 0) return fail(ErrorCode.NAME_TOO_LONG, 'name does not fit')
  }
  return ok(`${trimmed}${decoration}${ext}`)
}

/**
 * Writes the rescued edit beside the file it conflicts with.
 *
 * Returns where it landed. **Never throws** — see the module note: an edit is never discarded
 * because its rescue file failed, so every failure must arrive as a value the caller can act on.
 */
export async function writeConflictArtifact(
  root: RegisteredRoot,
  segments: readonly string[],
  bytes: Buffer,
  clock: Clock = () => new Date(),
  suffixSource: SuffixSource = randomSuffix,
): Promise<Result<ConflictArtifact>> {
  const fileName = segments[segments.length - 1]
  if (fileName === undefined || !isMarkdown(fileName)) {
    return fail(ErrorCode.NOT_MARKDOWN, 'conflicts are only written beside markdown documents')
  }
  /**
   * §13.5: "A conflict file never spawns a conflict child."
   *
   * Without this, resolving a conflict badly — or an autosave against an open artifact — chains
   * names indefinitely, each one longer than the last, marching toward the `NAME_MAX` failure
   * whose consequence is a lost edit. It is also why the grammar excludes them everywhere.
   */
  if (isConflictArtifact(fileName)) {
    return fail(ErrorCode.NOT_MARKDOWN, 'a conflict artifact never spawns a conflict child')
  }

  const parent = segments.slice(0, -1)
  const directory = dirname(join(root.absolutePath, ...segments))
  const at = clock()

  let lastCode: string | undefined
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const named = conflictNameFor(fileName, at, suffixSource())
    if (!named.ok) return named

    const absolute = join(directory, named.value)
    if (Buffer.byteLength(absolute, 'utf8') > PATH_MAX_BYTES) {
      // Checked on the COMPOSED path, not just the name: a name that fits can still overflow at
      // the end of a deep tree, and that overflow is the v1 failure that lost the edit.
      return fail(ErrorCode.NAME_TOO_LONG, 'the conflict path exceeds PATH_MAX')
    }

    const written = await createExclusiveAndWrite(absolute, bytes)
    if (written.ok) {
      return ok({ segments: [...parent, named.value], fileName: named.value })
    }
    if (written.code !== ErrorCode.NAME_TOO_LONG && written.detail !== 'EEXIST') return written
    lastCode = written.detail
  }
  return fail(ErrorCode.IO_FAILED, `conflict name collided ${NAME_ATTEMPTS} times (${lastCode ?? '?'})`)
}

/**
 * Creates the artifact exclusively and writes it. No temp, and no rename.
 *
 * The atomic-write dance exists to protect **existing** content; there is none here. `O_EXCL`
 * already guarantees this file did not exist a moment ago, so the worst a crash mid-write can
 * leave is a partial rescue file — which is strictly better than no rescue file, and cannot
 * damage anything that was already on disk.
 *
 * `O_NOFOLLOW` still matters: the name is unpredictable but the *directory* may not be ours alone,
 * and writing an edit through a symlink someone else placed would put the user's work wherever
 * that link points.
 */
async function createExclusiveAndWrite(absolute: string, bytes: Buffer): Promise<Result<null>> {
  let handle
  try {
    handle = await fsp.open(
      absolute,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o644,
    )
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'EEXIST') return fail(ErrorCode.IO_FAILED, 'EEXIST')
    if (code === 'ENOENT') return fail(ErrorCode.PARENT_MISSING, 'the folder no longer exists')
    if (code === 'ENAMETOOLONG') return fail(ErrorCode.NAME_TOO_LONG, 'the filesystem refused the name')
    if (code === 'ENOSPC' || code === 'EDQUOT') return fail(ErrorCode.DISK_FULL, 'the volume is full')
    if (code === 'EACCES' || code === 'EPERM') {
      return fail(ErrorCode.PERMISSION_DENIED, 'cannot create a file in that folder')
    }
    return fail(ErrorCode.IO_FAILED, `conflict create failed: ${code ?? 'unknown'}`)
  }

  try {
    let written = 0
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written)
      if (bytesWritten === 0) break
      written += bytesWritten
    }
    await handle.sync()

    /**
     * The rescue file is worth nothing if it is short, and unlike the save path there is no
     * baseline factory standing behind this one — so the assertion is explicit here.
     *
     * **UNPROVEN, and recorded as such rather than counted as covered.** The mutation sweep shows
     * this check green: deleting it changes no test. It can only fire on a short write, which in
     * practice means `ENOSPC`, and reaching that for real needs a mounted fixed-size volume.
     * the operator ruled on 2026-08-08 that the disk-full rig is not worth building — *"I will always
     * have enough disk space"* — so the rig was dropped and this assertion was kept.
     *
     * It stays because it costs nothing and because a short write also means a filesystem that
     * accepted bytes without storing them — a failing external drive, not a full one. But it is
     * believed correct, not known to fire, and that distinction belongs in the file rather than in
     * someone's memory.
     */
    const stat = await handle.stat({ bigint: true })
    if (Number(stat.size) !== bytes.length) {
      return fail(
        ErrorCode.WRITE_SIZE_MISMATCH,
        `the rescue file is ${Number(stat.size)} bytes, the edit is ${bytes.length}`,
      )
    }
    return ok(null)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOSPC' || code === 'EDQUOT') return fail(ErrorCode.DISK_FULL, 'the volume is full')
    return fail(ErrorCode.IO_FAILED, `conflict write failed: ${code ?? 'unknown'}`)
  } finally {
    await handle.close().catch(() => { /* reporting the original failure matters more */ })
  }
}
