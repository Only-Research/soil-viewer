/**
 * Append-only line writer. The first write path in this build.
 *
 * It lives in `src/core/fs` because spec §2 confines filesystem access to this directory, and it
 * exists in Phase 2 because build-plan §3 says so explicitly: *"The mutation log is the only file
 * write in this phase, to app storage outside every registered folder — it is not an exception to
 * 'no file writes yet,' it is the reason that phrase is now gone."*
 *
 * **It cannot write inside a registered root, and that is enforced rather than documented.** Spec
 * §7 requires the mutation log to live outside every registered folder; a log that could be written
 * into the user's tree would be a write path into their files wearing a different name, in a phase
 * whose whole discipline is that no such path exists yet.
 *
 * **A failed write must fail the operation** (§7). So every failure is returned, never swallowed,
 * and the caller is expected to abort. A log that silently stops recording is worse than no log:
 * it converts "no incident" from an observation into an assumption.
 *
 * **It has a size cap, and at the cap it refuses rather than rotates.** Added 2026-09-02, after the
 * unauthenticated session route was found able to grow this file by about a gigabyte a day. Every
 * record ever written stays; the app never deletes or renames a log. The reasoning is on
 * `MAX_LOG_BYTES` in `server/limits.ts`.
 */

import { constants, promises as fsp } from 'node:fs'
import { isAbsolute } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isWithin, splitSegments } from '../paths'
import { errnoOf, type RegisteredRoot } from './containment'

/**
 * Owner read/write only. Created with this mode rather than adjusted afterwards, so there is no
 * window in which the file exists with looser permissions — the same rule spec §7 sets for the
 * token file, applied here because this log records every path the operator opens.
 */
const LOG_MODE = 0o600

export interface AppendLog {
  readonly path: string
  /** Appends one line. Returns a failure rather than throwing; the caller must abort on it. */
  readonly append: (line: string) => Promise<Result<void>>
}

export interface AppendLogOptions {
  /**
   * The size the file may not grow past, in bytes. **Required rather than defaulted**: an optional
   * boundary is one a caller forgets, and a forgotten one here is an unbounded log. Production
   * passes `MAX_LOG_BYTES`; a test passes whatever makes the cap reachable.
   */
  readonly maxBytes: number
}

/**
 * Opens an append-only log at an absolute path, refusing any path inside a registered root.
 *
 * The roots are passed in rather than read from a module-level registry on purpose: a containment
 * check that reaches for global state is one that silently weakens when the state is empty, and
 * "no roots registered yet" is exactly the state at startup when this is created.
 */
export async function openAppendLog(
  absolutePath: string,
  roots: readonly RegisteredRoot[],
  options: AppendLogOptions,
): Promise<Result<AppendLog>> {
  if (!isAbsolute(absolutePath)) {
    return fail(ErrorCode.INVALID_ROOT, 'log path must be absolute')
  }

  const target = splitSegments(absolutePath)
  for (const root of roots) {
    const rootSegments = splitSegments(root.absolutePath)
    // Whole-segment comparison — spec §5. A raw prefix test would treat `/soil-logs` as inside
    // `/soil`, which is the `/soil/notes` vs `/soil/notes-old` bug the spec cites.
    //
    // BOTH directions are checked. Inside-a-root is the obvious one; contains-a-root matters
    // because a log at `/Users/x` with a root at `/Users/x/notes` would put the log file in a
    // directory that the walker enumerates, and the case-sensitivity flag comes from that root's
    // own probe rather than being guessed globally (spec §4).
    const ci = root.caseInsensitive
    if (isWithin(rootSegments, target, ci) || isWithin(target, rootSegments, ci)) {
      return fail(
        ErrorCode.PATH_ESCAPES_ROOT,
        'the mutation log may not live inside, or contain, a registered folder',
      )
    }
  }

  // O_APPEND makes each write atomic against other appenders at the OS level, so a second process
  // cannot interleave half a line. O_CREAT|O_WRONLY, never O_TRUNC: this file is append-only and
  // is designed never to be rewritten.
  let handle
  try {
    handle = await fsp.open(
      absolutePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
      LOG_MODE,
    )
  } catch (error) {
    const code = errnoOf(error)
    return fail(
      code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
      `could not open log: ${code ?? 'unknown'}`,
    )
  }

  const append = async (line: string): Promise<Result<void>> => {
    // One trailing newline, and the line itself must not contain one — a record that can span two
    // lines is a record that can be forged by anything that reaches a newline into a field.
    if (line.includes('\n') || line.includes('\r')) {
      return fail(ErrorCode.IO_FAILED, 'log line contains a newline')
    }
    try {
      // The cap, measured on the descriptor rather than counted in memory, so bytes another process
      // appended — `O_APPEND` permits it — and bytes already there at open are counted too. One
      // `fstat` beside an `fsync` is not the expensive call on this path.
      const { size } = await handle.stat()
      if (size + Buffer.byteLength(line, 'utf8') + 1 > options.maxBytes) {
        return fail(
          ErrorCode.LOG_FULL,
          `${absolutePath} has reached its ${options.maxBytes}-byte cap — move it aside and restart`,
        )
      }
      await handle.write(`${line}\n`, null, 'utf8')
      // Durability matters more than throughput here: this log is the only evidence that anything
      // happened, and a crash that loses the last entries loses exactly the ones that matter.
      await handle.sync()
      return ok(undefined)
    } catch (error) {
      return fail(ErrorCode.IO_FAILED, `log write failed: ${errnoOf(error) ?? 'unknown'}`)
    }
  }

  return ok({ path: absolutePath, append })
}


/**
 * Creates a directory and its parents if they are missing.
 *
 * Here rather than in the entry point because spec §2 confines filesystem access to this directory,
 * and the lint rule caught the entry point importing `node:fs/promises` directly — correctly. The
 * app's own state directory is still a directory on the user's disk, and "it is only mkdir" is the
 * reasoning that puts the second filesystem call somewhere else.
 */
export async function ensureDirectory(absolutePath: string): Promise<Result<void>> {
  if (!isAbsolute(absolutePath)) {
    return fail(ErrorCode.INVALID_ROOT, 'state directory path must be absolute')
  }
  try {
    await fsp.mkdir(absolutePath, { recursive: true })
    return ok(undefined)
  } catch (error) {
    const code = errnoOf(error)
    return fail(
      code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
      `could not create ${absolutePath}: ${code ?? 'unknown'}`,
    )
  }
}
