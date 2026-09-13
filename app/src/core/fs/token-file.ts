/**
 * The token file. Spec §7, token properties 3 and 4.
 *
 * The two per-listener tokens were printed to stdout at startup, "for a human wiring something up by
 * hand" — and the same spec's LaunchAgent recipe redirects stdout to a file, at launchd's umask.
 * Property 4 says a token is never written to any log. The deployment the spec itself prescribes
 * wrote both tokens to one. Found 2026-09-02 by the security reviewer.
 *
 * So the tokens go here instead: one file in the state directory, mode `0600` from creation
 * (property 3), rewritten on every start because the tokens are per-process. The startup banner
 * prints this file's path and nothing else. A human wiring by hand reads the file; the client never
 * needs it — it obtains its own credential from `POST /api/session.start`.
 *
 * Temp-and-rename through `createTemp`, the path a document save takes: the file is never observable
 * half-written or with looser permissions, and a pre-planted symlink at the temp name is refused
 * rather than followed. Lives in `src/core/fs` because spec §2 confines filesystem access here.
 */

import { promises as fsp } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { errnoOf } from './containment'
import { createTemp, syncDirectory } from './write'

/** Writes `lines`, one per line, to `absolutePath` at `0600`, replacing whatever was there. */
export async function writeTokenFile(
  absolutePath: string,
  lines: readonly string[],
): Promise<Result<void>> {
  if (!isAbsolute(absolutePath)) {
    return fail(ErrorCode.INVALID_ROOT, 'token file path must be absolute')
  }
  for (const line of lines) {
    // The same rule the logs apply: a line that can span two lines is a file that can be forged.
    if (line.includes('\n') || line.includes('\r')) {
      return fail(ErrorCode.IO_FAILED, 'token line contains a newline')
    }
  }
  const bytes = Buffer.from(lines.map(line => `${line}\n`).join(''), 'utf8')
  const directory = dirname(absolutePath)

  const temp = await createTemp(directory, basename(absolutePath))
  if (!temp.ok) return temp
  const { handle, path: tempPath } = temp.value

  let synced = false
  try {
    let written = 0
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written)
      if (bytesWritten === 0) break
      written += bytesWritten
    }
    if (written !== bytes.length) {
      return fail(ErrorCode.IO_FAILED, `token file short write: ${written} of ${bytes.length} bytes`)
    }
    await handle.sync()
    synced = true
  } catch (error) {
    return fail(ErrorCode.IO_FAILED, `token file write failed: ${errnoOf(error) ?? 'unknown'}`)
  } finally {
    await handle.close().catch(() => { /* the descriptor is what matters; a failed close is not */ })
    // Best effort, as in `write.ts`: a half-written temp is removed rather than left for a reader.
    if (!synced) await fsp.unlink(tempPath).catch(() => { /* gone, or the sweep will take it */ })
  }

  try {
    await fsp.rename(tempPath, absolutePath)
    await syncDirectory(directory)
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => { /* gone, or the sweep will take it */ })
    return fail(ErrorCode.IO_FAILED, `token file rename failed: ${errnoOf(error) ?? 'unknown'}`)
  }
  return ok(undefined)
}
