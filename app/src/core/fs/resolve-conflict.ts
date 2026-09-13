/**
 * Resolving a conflict. Spec §13.5.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * §13.5: *"Resolution is a v1 requirement, not a later nicety: two-pane mine/theirs with Keep Mine
 * / Keep Theirs / Keep Both, ending with one file at the canonical path and the loser moved to
 * app-private archive."*
 *
 * `conflict.ts` writes the rescue file. This module is what ends the situation — and until it
 * existed, the app could create conflict artifacts and had no way to clear one, which is a state
 * that only accumulates.
 *
 * ---
 *
 * ## The one operation in this build that removes a file from the user's tree
 *
 * Keep Mine and Keep Theirs both end with a loser, and the loser leaves the user's folder for an
 * app-private archive. That is a removal, however carefully it is dressed — so the ordering is not
 * negotiable and is the whole design of `archiveFile` below:
 *
 *   1. copy the bytes into the archive
 *   2. **read them back and verify the hash matches what was archived**
 *   3. only then unlink the original
 *
 * A failure at step 1 or 2 leaves everything exactly as it was. There is no path in which the
 * original is removed before its content is proven to exist somewhere else. This is the same
 * reasoning as the atomic write — the irreversible act happens last, after everything that can fail
 * has failed.
 */

import { randomBytes } from 'node:crypto'
import { constants, promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isConflictArtifact, isMarkdown } from '../grammar'
import {
  errnoOf,
  readFileBytes,
  walkAndVerify,
  type RegisteredRoot,
} from './containment'
import { hashBytes, loadDocument } from './document'
import { exclusiveRename, suggestFreeName } from './rename'
import { checkStagingArea } from './staging'
import { saveDocument } from './write'

/**
 * Which version the user chose.
 *
 * **`both` is an interpretation and is flagged rather than assumed.** §13.5's sentence — "ending
 * with one file at the canonical path and the loser moved to app-private archive" — describes Keep
 * Mine and Keep Theirs, and cannot describe Keep Both, which by definition ends with two files.
 * What this module does for `both`: the canonical file is left alone and **the artifact is renamed
 * to an ordinary sibling name**. That matters beyond tidiness — a conflict artifact is
 * grammar-excluded everywhere except Files (§13.5), so an artifact kept as-is would be a document
 * the user chose to keep and can never see on a board or in an inbox.
 */
export type ConflictChoice = 'mine' | 'theirs' | 'both'

export interface ConflictResolution {
  readonly choice: ConflictChoice
  /** Where the surviving document is. The editor retargets here — §13.5. */
  readonly canonical: readonly string[]
  /** Present for `both`: the artifact's new ordinary name, no longer grammar-excluded. */
  readonly keptAlongside?: readonly string[]
  /** Present when something was archived: the absolute path, for the log. */
  readonly archived?: string
}

/**
 * Ends a conflict.
 *
 * `archiveRoot` is app-private storage outside every registered folder — validated on every call by
 * the same `checkStagingArea` the copy engine uses, so a folder registered after startup cannot
 * turn the archive into a location inside the user's tree.
 */
export async function resolveConflict(
  root: RegisteredRoot,
  canonical: readonly string[],
  artifact: readonly string[],
  choice: ConflictChoice,
  archiveRoot: string,
  allRoots: readonly RegisteredRoot[],
  /** Test-only seam; see `ArchiveOptions.readBack`. */
  readBack?: (path: string) => Promise<Buffer>,
): Promise<Result<ConflictResolution>> {
  const shape = await checkPair(root, canonical, artifact)
  if (!shape.ok) return shape

  const archiveOk = checkStagingArea(archiveRoot, allRoots)
  if (!archiveOk.ok) return archiveOk

  switch (choice) {
    case 'theirs': return keepTheirs(root, canonical, artifact, archiveRoot, readBack)
    case 'mine': return keepMine(root, canonical, artifact, archiveRoot, readBack)
    case 'both': return keepBoth(root, canonical, artifact)
  }
}

/**
 * Both paths must be what they claim, and they must be **siblings**.
 *
 * The sibling rule is not tidiness. Without it, a caller could pair any conflict artifact with any
 * document and this function would archive the second one — a data-loss primitive reachable by
 * getting one argument wrong. A rescue file is always written beside the file it rescues
 * (`conflict.ts`), so the constraint costs nothing legitimate.
 */
async function checkPair(
  root: RegisteredRoot,
  canonical: readonly string[],
  artifact: readonly string[],
): Promise<Result<null>> {
  const canonicalName = canonical[canonical.length - 1]
  const artifactName = artifact[artifact.length - 1]
  if (canonicalName === undefined || artifactName === undefined) {
    return fail(ErrorCode.PATH_EMPTY, 'both paths are required')
  }
  if (!isMarkdown(canonicalName) || !isMarkdown(artifactName)) {
    return fail(ErrorCode.NOT_MARKDOWN, 'both paths must be markdown documents')
  }
  if (!isConflictArtifact(artifactName)) {
    return fail(ErrorCode.NOT_MARKDOWN, 'the second path is not a conflict artifact')
  }
  if (isConflictArtifact(canonicalName)) {
    return fail(ErrorCode.NOT_MARKDOWN, 'the canonical path is itself a conflict artifact')
  }
  if (
    canonical.length !== artifact.length ||
    // Escaped, never literal. A raw NUL renders as nothing in every editor and cannot be
    // grepped — the mutation sweep reported an ANCHOR MISSING here for exactly that reason, which
    // is the second time in this session. `mutation-lock.ts` carries the same note.
    canonical.slice(0, -1).join('\u0000') !== artifact.slice(0, -1).join('\u0000')
  ) {
    return fail(ErrorCode.PATH_TRAVERSAL, 'a conflict is resolved only against its own sibling')
  }

  for (const path of [canonical, artifact]) {
    const found = await walkAndVerify(root, path)
    if (!found.ok) return found
    if (found.value === null) return fail(ErrorCode.IO_FAILED, 'one of the two files is missing')
    if (found.value.kind !== 'file') {
      return fail(ErrorCode.NOT_REGULAR_FILE, 'both paths must be regular files')
    }
  }
  return ok(null)
}

/** Keep what is at the canonical path; the rescue file is archived. */
async function keepTheirs(
  root: RegisteredRoot,
  canonical: readonly string[],
  artifact: readonly string[],
  archiveRoot: string,
  readBack?: (path: string) => Promise<Buffer>,
): Promise<Result<ConflictResolution>> {
  const archived = await archiveFile(root, artifact, archiveRoot, readBack ? { readBack } : {})
  if (!archived.ok) return archived
  return ok({ choice: 'theirs', canonical: [...canonical], archived: archived.value })
}

/**
 * The rescued edit becomes canonical; what was there is archived.
 *
 * The order matters and is the reverse of what reads naturally. The canonical file's **current**
 * content is the loser, so it is archived *before* it is overwritten — archiving afterwards would
 * archive the winner and lose the loser, which is the mistake this whole module exists to avoid.
 *
 * The overwrite goes through `saveDocument`, so it inherits the atomic write, the size assertion
 * and the hash check rather than reimplementing them. `confirmedTruncation` is passed because the
 * user has just been shown both versions side by side and chosen — asking again would be asking
 * about a decision already made.
 */
async function keepMine(
  root: RegisteredRoot,
  canonical: readonly string[],
  artifact: readonly string[],
  archiveRoot: string,
  readBack?: (path: string) => Promise<Buffer>,
): Promise<Result<ConflictResolution>> {
  const mine = await readFileBytes(root, artifact)
  if (!mine.ok) return mine

  const archived = await archiveFile(
    root, canonical, archiveRoot, { keepOriginal: true, ...(readBack ? { readBack } : {}) },
  )
  if (!archived.ok) return archived

  const loaded = await loadDocument(root, canonical)
  if (!loaded.ok) return loaded

  const saved = await saveDocument(
    root, canonical, loaded.value.baseline, mine.value, { confirmedTruncation: true },
  )
  if (!saved.ok) return saved

  // The artifact has done its job — its content is now the document. Archived rather than left
  // behind, because a leftover artifact keeps showing in the "Needs attention" list forever.
  const artifactArchived = await archiveFile(
    root, artifact, archiveRoot, readBack ? { readBack } : {},
  )
  if (!artifactArchived.ok) return artifactArchived

  return ok({ choice: 'mine', canonical: [...canonical], archived: archived.value })
}

/**
 * Keep both: the canonical file is untouched and the artifact becomes an ordinary document.
 *
 * Renamed through `exclusiveRename` — the same verb every user-facing move uses — so a name that
 * gets taken in the meantime is refused by the kernel rather than overwritten.
 */
async function keepBoth(
  root: RegisteredRoot,
  canonical: readonly string[],
  artifact: readonly string[],
): Promise<Result<ConflictResolution>> {
  const parent = canonical.slice(0, -1)
  const canonicalName = canonical[canonical.length - 1] as string

  const free = await suggestFreeName(root, parent, canonicalName)
  if (!free.ok) return free

  const destination = [...parent, free.value]
  const moved = await exclusiveRename(root, artifact, destination)
  if (!moved.ok) return moved

  return ok({ choice: 'both', canonical: [...canonical], keptAlongside: destination })
}

interface ArchiveOptions {
  /** True when the original must survive — used where the caller overwrites it immediately after. */
  readonly keepOriginal?: boolean
  /**
   * How the archived copy is read back for verification. Injectable, and only for tests.
   *
   * **The sweep is why this exists.** Deleting the hash comparison below left every test green,
   * because the only archive failure a test could stage was a directory it could not write to —
   * which fails at the *open*, long before the verification. The check that stands between a
   * lying write and the unlink of a user's only copy had no proof at all.
   *
   * The seam can only make verification *stricter* from the caller's side: it supplies bytes to
   * compare against, and a mismatch refuses. It cannot skip the comparison or reach the unlink.
   */
  readonly readBack?: (path: string) => Promise<Buffer>
}

/**
 * Copies a file into the app-private archive and then removes the original.
 *
 * **The only place that unlinks a file inside a registered root WITHOUT putting it back** — and the
 * qualifier is the whole distinction, added 2026-08-16 because this read *"the only place in this
 * build that unlinks a file inside a registered root"* and that is false: `rename.ts` unlinks twice
 * in `linkAndUnlink`, and `write.ts` unlinks its temp.
 *
 * Those two are safe for a reason this one cannot borrow. A rename's unlink happens **after** the
 * destination link exists, so the file is in two places and one name is being removed; a temp's
 * unlink removes something no one has ever seen. Here the original is genuinely leaving, so the
 * ordering below is the entire safety argument rather than a formality — and a reader who believed
 * the old sentence would look for that argument nowhere else and find the real unlinks unexamined.
 *
 * The ordering:
 *
 *   1. read the original's bytes
 *   2. write them into the archive, exclusively, and `fsync`
 *   3. **read the archived copy back and compare hashes**
 *   4. only then unlink the original
 *
 * Step 3 is the one that would be tempting to skip. Without it, a write that reported success and
 * stored something else — a failing drive, a full volume — is followed by an unlink of the only
 * good copy. With it, the unlink is reached solely when the content is provably somewhere else.
 *
 * The archive name carries a timestamp and random suffix so two archived versions of the same
 * document never collide, and the original's name so a person can find it.
 */
async function archiveFile(
  root: RegisteredRoot,
  segments: readonly string[],
  archiveRoot: string,
  options: ArchiveOptions = {},
): Promise<Result<string>> {
  const bytes = await readFileBytes(root, segments)
  if (!bytes.ok) return bytes

  const name = segments[segments.length - 1] as string
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = join(archiveRoot, `${stamp}-${randomBytes(4).toString('hex')}-${name}`)

  let handle
  try {
    await fsp.mkdir(archiveRoot, { recursive: true })
    handle = await fsp.open(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    )
  } catch (error) {
    return fail(ErrorCode.IO_FAILED, `could not create the archive copy: ${errnoOf(error) ?? '?'}`)
  }

  try {
    let written = 0
    while (written < bytes.value.length) {
      const { bytesWritten } = await handle.write(
        bytes.value, written, bytes.value.length - written, written,
      )
      if (bytesWritten === 0) break
      written += bytesWritten
    }
    await handle.sync()
  } catch (error) {
    const code = errnoOf(error)
    return fail(
      code === 'ENOSPC' || code === 'EDQUOT' ? ErrorCode.DISK_FULL : ErrorCode.IO_FAILED,
      `could not write the archive copy: ${code ?? 'unknown'}`,
    )
  } finally {
    await handle.close().catch(() => { /* the verification below is what decides */ })
  }

  // Step 3. Read it back from disk rather than trusting the write — the whole point is that the
  // next step is irreversible.
  let archivedBytes: Buffer
  try {
    archivedBytes = await (options.readBack ?? fsp.readFile)(destination)
  } catch (error) {
    return fail(ErrorCode.IO_FAILED, `could not read the archive copy back: ${errnoOf(error) ?? '?'}`)
  }
  if (hashBytes(archivedBytes) !== hashBytes(bytes.value)) {
    return fail(
      ErrorCode.WRITE_SIZE_MISMATCH,
      'the archived copy does not match the original — the original has not been touched',
    )
  }

  if (options.keepOriginal === true) return ok(destination)

  try {
    await fsp.unlink(join(root.absolutePath, ...segments))
  } catch (error) {
    // The archive copy exists and is verified, so nothing is lost — but the user now has both, and
    // saying so is better than reporting a clean resolution that left a file behind.
    return fail(
      ErrorCode.IO_FAILED,
      `archived to ${destination}, but the original could not be removed: ${errnoOf(error) ?? '?'}`,
    )
  }
  return ok(destination)
}
