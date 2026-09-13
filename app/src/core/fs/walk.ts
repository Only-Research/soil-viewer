/**
 * Streaming tree walk. Spec §5.
 *
 * Yields entries as it finds them so a cold index of 10,000 files streams and never blocks
 * first paint (§5's budget). Nothing is accumulated into an array here — the caller decides
 * what to keep.
 *
 * **Why this does not call `readDirectory` per directory.** That function re-walks every
 * segment from the root down on each call, which is the right cost for a *client-supplied*
 * path and the wrong cost for a controlled descent: it would make indexing O(files × depth)
 * `lstat` calls. The containment guarantee is preserved differently and just as strictly —
 * the descent starts at a verified root, every child path is composed from a parent this walk
 * already verified, and **a symlinked entry is never descended into**, so the walk cannot
 * leave the tree. A client path never reaches this function.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isIgnoredSegment } from '../grammar'
import { errnoOf, walkAndVerify, type EntryKind, type RegisteredRoot } from './containment'

export interface WalkedEntry {
  readonly segments: string[]
  readonly name: string
  readonly kind: EntryKind
  readonly size: number
  readonly mtimeNs: bigint
  readonly dev: bigint
  readonly ino: bigint
  readonly nlink: number
  /**
   * True when the file reports a size but has no allocated blocks — the signature of a cloud
   * placeholder that has not been downloaded.
   *
   * Spec §5: "Never force-materialize a dataless placeholder during indexing" — v1's title
   * extraction would have force-downloaded the entire tree on first index. macOS marks these
   * with `SF_DATALESS` in `st_flags`, which **Node does not expose** (verified on 24.14.0:
   * no `flags` field on Stats, no `UF_`/`SF_` constants). `blocks === 0` with `size > 0` is
   * the portable signal that remains, and it is checked before any read is attempted.
   */
  readonly likelyDataless: boolean
}

export interface WalkProblem {
  readonly segments: string[]
  readonly code: ErrorCode
  readonly detail: string
}

export interface WalkEvent {
  readonly entry?: WalkedEntry
  readonly problem?: WalkProblem
}

function toEntry(segments: string[], name: string, stat: {
  mode: bigint; size: bigint; blocks: bigint; mtimeNs: bigint; dev: bigint; ino: bigint; nlink: bigint
}, kind: EntryKind): WalkedEntry {
  const size = Number(stat.size)
  return {
    segments,
    name,
    kind,
    size,
    mtimeNs: stat.mtimeNs,
    dev: stat.dev,
    ino: stat.ino,
    nlink: Number(stat.nlink),
    likelyDataless: kind === 'file' && size > 0 && Number(stat.blocks) === 0,
  }
}

/**
 * Walks a subtree, yielding one event per entry.
 *
 * Problems are yielded rather than thrown, so one unreadable directory does not abort the
 * index of everything else — but they are never silently swallowed either. Spec §6: an
 * empty-but-successful result never stands in for a failure.
 */
export async function* walkSubtree(
  root: RegisteredRoot,
  startSegments: readonly string[] = [],
): AsyncGenerator<WalkEvent> {
  // The one full containment check: verify the starting point the ordinary way. Everything
  // below it is reached by descent from here.
  const start = await walkAndVerify(root, startSegments)
  if (!start.ok) {
    yield { problem: { segments: [...startSegments], code: start.code, detail: start.detail ?? '' } }
    return
  }
  if (start.value === null) {
    yield { problem: { segments: [...startSegments], code: ErrorCode.IO_FAILED, detail: 'start path does not exist' } }
    return
  }
  if (start.value.kind !== 'directory') {
    yield { problem: { segments: [...startSegments], code: ErrorCode.NOT_REGULAR_FILE, detail: 'start path is not a directory' } }
    return
  }

  // Explicit stack rather than recursion: a pathological tree must not blow the call stack,
  // and this keeps the generator's memory proportional to depth, not to file count.
  const stack: string[][] = [[...startSegments]]

  while (stack.length > 0) {
    const dirSegments = stack.pop()
    if (dirSegments === undefined) break

    const absolute = dirSegments.length === 0
      ? root.absolutePath
      : join(root.absolutePath, ...dirSegments)

    let dirents
    try {
      dirents = await fsp.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      const code = errnoOf(error)
      yield {
        problem: {
          segments: dirSegments,
          code: code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
          detail: `readdir failed: ${code ?? 'unknown'}`,
        },
      }
      continue
    }

    for (const dirent of dirents) {
      // Spec §3: ignore rules evaluate against whole segments of the folder-relative path.
      // Applied here so an ignored directory is never walked at all, rather than walked and
      // filtered — 527 .DS_Store and 823 .gitkeep in the real tree were walked under v1.
      if (isIgnoredSegment(dirent.name)) continue

      const segments = [...dirSegments, dirent.name]
      const childAbsolute = join(absolute, dirent.name)

      // A symlink is recorded and never followed. Spec §4 shows them with their own glyph;
      // descending would take the walk out of the tree.
      if (dirent.isSymbolicLink()) {
        yield {
          entry: {
            segments, name: dirent.name, kind: 'symlink',
            size: 0, mtimeNs: 0n, dev: 0n, ino: 0n, nlink: 1, likelyDataless: false,
          },
        }
        continue
      }

      let stat
      try {
        stat = await fsp.lstat(childAbsolute, { bigint: true })
      } catch (error) {
        const code = errnoOf(error)
        // A file that vanished between readdir and lstat is normal in a live tree, not a
        // fault. Anything else is reported.
        if (code !== 'ENOENT') {
          yield {
            problem: {
              segments,
              code: code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
              detail: `lstat failed: ${code ?? 'unknown'}`,
            },
          }
        }
        continue
      }

      // Re-checked from the lstat rather than trusted from the dirent: between readdir and
      // now, the entry could have been replaced.
      const isDirectory = dirent.isDirectory() && stat.isDirectory()
      const kind: EntryKind = stat.isSymbolicLink()
        ? 'symlink'
        : isDirectory
          ? 'directory'
          : stat.isFile()
            ? 'file'
            : 'other'

      if (kind === 'symlink') continue // swapped under us; refuse rather than follow

      yield { entry: toEntry(segments, dirent.name, stat, kind) }
      if (kind === 'directory') stack.push(segments)
    }
  }
}

/** Collects a walk into arrays. Convenience for tests and for bounded reconciliation of a
 *  small subtree — never used for a cold index, which must stream. */
export async function collectWalk(
  root: RegisteredRoot,
  startSegments: readonly string[] = [],
): Promise<Result<{ entries: WalkedEntry[]; problems: WalkProblem[] }>> {
  const entries: WalkedEntry[] = []
  const problems: WalkProblem[] = []
  for await (const event of walkSubtree(root, startSegments)) {
    if (event.entry) entries.push(event.entry)
    if (event.problem) problems.push(event.problem)
  }
  // A failure to even start is reported as a failure, not as an empty tree.
  if (entries.length === 0 && problems.length === 1 && problems[0]?.segments.length === startSegments.length) {
    const only = problems[0]
    return fail(only.code, only.detail)
  }
  return ok({ entries, problems })
}
