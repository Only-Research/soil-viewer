/**
 * New File and New Folder. Spec §13.3, §13.6.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * **The two rules that shape this whole module:**
 *
 * 1. **§13.3 — "Writes never create directories. A write whose parent doesn't exist fails loudly.
 *    Only explicit create-folder and move create directories."** This module *is* the explicit
 *    create-folder, so it is one of the two places allowed to `mkdir` — and it creates **exactly
 *    one level**, never `mkdir -p`. v1's rule was satisfiable while `mkdir -p` lived inside move,
 *    which is how a stale client could materialise a folder tree nobody asked for.
 *
 * 2. **§13.6's exclusivity — a create must never replace anything.** `O_CREAT|O_EXCL|O_NOFOLLOW`
 *    for a file, and for a directory `mkdir` is already exclusive: it fails `EEXIST` from the
 *    kernel rather than merging into an existing one. Neither needs the `link`/`unlink` dance
 *    `rename.ts` requires, because unlike rename, create has a genuinely exclusive syscall.
 *
 * **`O_NOFOLLOW` is UNPROVEN by the test suite, and it stays.** An agent that can guess the name —
 * and on this tree the names are predictable, that is the point of the grammar — can pre-place a
 * symlink at it pointing anywhere on disk, and without `O_NOFOLLOW` the app's first write lands
 * outside every registered folder.
 *
 * The mutation sweep removes it and nothing goes red, because `walkAndVerify` refuses *any*
 * symlinked segment with `PATH_SYMLINK` before the open is reached. Reaching the flag needs a
 * symlink placed **between** that check and this open — a real race, in the same category as the
 * per-file re-validation in `copy.ts`, which no deterministic test produces.
 *
 * Kept rather than deleted, on the distinction `open-items.md` draws: guards that cannot fire are
 * normally removed here, and the exception is where the window is real and the consequence is
 * unbounded. A write escaping every registered root is that consequence.
 *
 * *Measured in `write.ts`:* the combination fails **`EEXIST`, not `ELOOP`**, because `O_EXCL` wins
 * — so a guard written against `ELOOP` would defend nothing, and "name taken" is the truthful thing
 * to tell the user.
 *
 * **A new file is seeded with its own title**, per annex A5: *"New File: appends `.md`, seeds body
 * `# <name>`, opens immediately."*
 *
 * **CORRECTED 2026-08-09.** This was built empty first, with a comment arguing that *"a stub is
 * content the user did not write."* That reasoning was invented here and it loses to the annex on
 * the facts: a document's title in this tree **is its first heading** (`title.ts`), falling back to
 * the filename stem only when there is none. An empty file therefore shows a slug — `my-meeting-
 * notes` — where a seeded one shows `My Meeting Notes`, which is what the person actually typed.
 * The stub is not content they did not write; it is the only place their capitalisation survives.
 *
 * Caught while reading the annex for stage B's tree rules, which is late — an inherited requirement
 * was diverged from without the divergence being noticed, let alone argued.
 */

import { constants, promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { errnoOf, walkAndVerify, type RegisteredRoot } from './containment'

/** What was created, and where. */
export interface CreateOutcome {
  readonly segments: readonly string[]
  readonly kind: 'file' | 'directory'
}

/**
 * Creates one file or one folder inside an existing parent.
 *
 * `segments` is the **full** path of the thing to create, parent included — the same shape every
 * other verb in this layer takes. The name is expected to have been through `slug.ts` already;
 * this function does not slugify, because a function that both validates a name and creates a file
 * is one whose caller cannot preview the name before committing to it, and §13.6 requires that
 * preview.
 */
export async function createEntry(
  root: RegisteredRoot,
  segments: readonly string[],
  kind: 'file' | 'directory',
  /**
   * The body a new file starts with. Annex A5.
   *
   * Written through the same descriptor the exclusive create opened, so there is no window between
   * "the name is claimed" and "the file has its content" in which another writer sees an empty
   * document. Ignored for a directory.
   */
  content = '',
): Promise<Result<CreateOutcome>> {
  if (segments.length === 0) {
    return fail(ErrorCode.PATH_EMPTY, 'a create needs a path')
  }

  /**
   * The parent must already exist and be a directory. §13.3's "fails loudly".
   *
   * `walkAndVerify` is the §4 checker, so this also refuses a parent reached through a symlinked
   * segment and a parent outside the root — before anything is created, rather than after.
   */
  const parent = await walkAndVerify(root, segments.slice(0, -1))
  if (!parent.ok) return parent
  if (parent.value === null || parent.value.kind !== 'directory') {
    return fail(ErrorCode.PARENT_MISSING, 'the folder to create this in does not exist')
  }

  /**
   * **There is no "is the destination free?" check here, and its absence is the control.**
   *
   * One was written and the mutation sweep deleted it without turning anything red — correctly, and
   * for a better reason than redundancy. A pre-check is a time-of-check-to-time-of-use read: it
   * answers about a moment that has already passed, so under two concurrent creates it passes for
   * both. `O_EXCL` and a bare `mkdir` answer about *now*, atomically, and the kernel picks one
   * winner. The check was the weaker half of a pair and its presence invited the reader to think
   * the weaker half was doing the work.
   *
   * It also does not cost anything §13.6 asked for. That section requires collision checks
   * discriminate `ENOENT` from "couldn't determine" and never read a non-`ENOENT` error as a free
   * destination — a rule about *checks*. With no check, there is nothing to mis-classify: an
   * unreadable parent surfaces as `EACCES` from the syscall itself and maps to a permission
   * refusal, never to "the name was free".
   *
   * Proven by the concurrency tests in `create.test.ts`, which are the only ones that can tell the
   * two apart.
   */
  const absolute = join(root.absolutePath, ...segments)

  if (kind === 'directory') {
    try {
      // NOT recursive. §13.3 allows this module one level and no more; `{ recursive: true }` would
      // also silently succeed on an existing directory, losing the exclusivity above.
      await fsp.mkdir(absolute)
      return ok({ segments: [...segments], kind })
    } catch (thrown) {
      return failureFor(thrown, 'the folder could not be created')
    }
  }

  let handle
  try {
    handle = await fsp.open(
      absolute,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o644,
    )
  } catch (thrown) {
    return failureFor(thrown, 'the file could not be created')
  }
  // Closed in a `finally` rather than after the write: an open descriptor leaked here would hold
  // the file open for the life of the process, and this build has already been warned once by Node
  // about closing handles on garbage collection.
  try {
    if (content !== '') await handle.write(content, 0, 'utf8')
    return ok({ segments: [...segments], kind })
  } catch (thrown) {
    return failureFor(thrown, 'the file was created but could not be written')
  } finally {
    await handle.close()
  }
}

/** Maps a thrown errno to the refusal that names what actually happened. */
function failureFor(thrown: unknown, detail: string): Result<never> {
  const errno = errnoOf(thrown)
  if (errno === 'EEXIST') {
    // Also what a pre-placed symlink produces — `O_EXCL` beats `O_NOFOLLOW` to the error. "Name
    // taken" is the truthful thing to say to the user in both cases.
    return fail(ErrorCode.NAME_TAKEN, 'something already exists at that name')
  }
  if (errno === 'EACCES' || errno === 'EPERM' || errno === 'EROFS') {
    return fail(ErrorCode.PERMISSION_DENIED, detail)
  }
  if (errno === 'ENOSPC' || errno === 'EDQUOT') return fail(ErrorCode.DISK_FULL, detail)
  /**
   * **No `ENAMETOOLONG` branch, and that is not an omission.** One was written here and removed
   * the same hour, because a test proved it unreachable: `walkAndVerify` lstats the destination
   * before anything is created, and an over-long name fails there first — so the create's own open
   * never sees the errno. The user-facing guard is earlier still, in `slug.ts`, which refuses at
   * `NAME_MAX` in bytes with a message naming the limit.
   *
   * Kept as a note rather than as a branch, on this build's standing rule: a guard that cannot fire
   * is one a later reader trusts. Same reasoning as the absent symlink check in `rename.ts`.
   */
  return fail(ErrorCode.IO_FAILED, `${detail}: ${errno ?? 'unknown'}`)
}
