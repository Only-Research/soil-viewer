/**
 * Builds and maintains the index from disk. Spec §5.
 *
 * Two entry points, and the difference between them is the whole design:
 * - `indexRoot` — the cold start. Streams, never accumulates, never blocks.
 * - `reconcileSubtree` — bounded recovery for ONE subtree.
 *
 * Spec §5 permits no routine full rebuild: "no mutation handler and no single watcher event
 * may trigger reindexing beyond the affected paths." Reconciliation is required — and only
 * permitted — on watcher error or restart, wake from sleep, re-registration, explicit refresh,
 * and whenever an operation meets a path that contradicts the index. It is deliberately not
 * callable per event.
 */

import { isMarkdown } from './grammar'
import { IndexStore, type IndexEntry } from './index-store'
import { TITLE_SCAN_BYTES, decodeScanWindow, titleFor } from './title'
import { openFileForRead, readHead, walkAndVerify, type RegisteredRoot } from './fs/containment'
import { detectCloudProvider } from './fs/registration'
import { walkSubtree, type WalkProblem, type WalkedEntry } from './fs/walk'

export interface IndexOptions {
  /**
   * Set for a root inside a cloud-sync folder. Titles come from filenames and **no file body
   * is ever read**, so indexing cannot trigger a download of the whole tree — the v1 failure
   * §5 names. The per-file `likelyDataless` check still applies underneath this.
   */
  readonly skipBodyReads?: boolean
}

export interface IndexProgress {
  readonly indexed: number
  readonly problems: number
}

/**
 * Turns one walked entry into an index row, reading a bounded head for the title when — and
 * only when — that is both useful and safe.
 */
async function toIndexEntry(
  root: RegisteredRoot,
  walked: WalkedEntry,
  options: IndexOptions,
): Promise<IndexEntry> {
  const markdown = walked.kind === 'file' && isMarkdown(walked.name)

  let content: string | null = null
  let contentUnavailable = false

  if (markdown) {
    if (options.skipBodyReads === true || walked.likelyDataless) {
      // Spec §5: a provider read is "not available offline" and NEVER an empty document.
      // Not reading at all is the strongest form of that guarantee.
      contentUnavailable = true
    } else {
      const opened = await openFileForRead(root, walked.segments)
      if (opened.ok) {
        try {
          const head = await readHead(opened.value, TITLE_SCAN_BYTES)
          if (head.ok) content = decodeScanWindow(head.value)
          else contentUnavailable = true
        } finally {
          await opened.value.file.close()
        }
      } else {
        // Refused for a real reason — a hard link, a permission failure, a symlink swap. The
        // row still exists so the file is visible; it is marked rather than silently blank.
        contentUnavailable = true
      }
    }
  }

  return {
    rootId: root.id,
    segments: walked.segments,
    name: walked.name,
    kind: walked.kind,
    title: titleFor(walked.name, content),
    size: walked.size,
    mtimeNs: walked.mtimeNs,
    dev: walked.dev,
    ino: walked.ino,
    isMarkdown: markdown,
    contentUnavailable,
  }
}

/**
 * Cold-start index. Streams: each entry is upserted as it is found and `onProgress` fires
 * periodically, so a caller can paint before the walk finishes.
 *
 * Spec §5's budget — "cold-start index of 10,000 files streams and never blocks first paint".
 */
export async function indexRoot(
  root: RegisteredRoot,
  store: IndexStore,
  options: IndexOptions = {},
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexProgress> {
  store.registerRootCasing(root.id, root.caseInsensitive)

  let indexed = 0
  const problems: WalkProblem[] = []

  for await (const event of walkSubtree(root, [])) {
    if (event.problem !== undefined) {
      problems.push(event.problem)
      continue
    }
    if (event.entry === undefined) continue

    store.upsert(await toIndexEntry(root, event.entry, options))
    indexed++

    // Yield to the event loop periodically. Without this a 50,000-file walk starves every
    // request behind it, which is "blocks first paint" by another name.
    if (indexed % 200 === 0) {
      onProgress?.({ indexed, problems: problems.length })
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  const final = { indexed, problems: problems.length }
  onProgress?.(final)
  return final
}

/**
 * Cold-start index with §5's cloud policy applied. **The only way a caller should index a root.**
 *
 * A cloud-sync root takes titles from filenames and never reads a body, so indexing cannot pull the
 * whole tree down out of iCloud — v1's failure. That decision was inline at the one call site that
 * existed, and the moment a second appeared (restoring roots at startup) it was a rule with two
 * copies free to disagree. One copy, and it lives beside the thing it configures.
 */
export function indexRegisteredRoot(
  root: RegisteredRoot,
  store: IndexStore,
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexProgress> {
  const options: IndexOptions = detectCloudProvider(root.absolutePath) === null
    ? {}
    : { skipBodyReads: true }
  return indexRoot(root, store, options, onProgress)
}

/**
 * Whether two rows say the same thing. `rootId` and `segments` are the key and are not compared.
 *
 * **This exists because "updated" used to mean "a row was already there", not "the row changed",**
 * and nothing had ever asked the difference — `ReconcileResult.updated` was returned and asserted
 * by no test in the build. It became load-bearing the moment live updates used it to decide whether
 * to tell the client to refetch: on a tree where agents write constantly, "a reconcile ran" is not
 * news and announcing it is making every client do work for nothing.
 *
 * Found by a test of mine written against the rule rather than against the implementation, which is
 * the only reason it was not shipped as "working".
 */
function sameRow(a: IndexEntry, b: IndexEntry): boolean {
  return a.name === b.name &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.isMarkdown === b.isMarkdown &&
    a.contentUnavailable === b.contentUnavailable
}

/**
 * Brings ONE index row into line with what is on disk. Spec §5's bounded case.
 *
 * **This exists because §5's sentence is narrow and `reconcileSubtree` is not:** *"no mutation
 * handler and no single watcher event may trigger reindexing beyond the affected paths."* A watcher
 * event for `notes.md` at the top of a root has `[]` as its parent, so reconciling the parent
 * subtree would walk the entire tree for one edited file — the "synchronous full-vault rescan" trap
 * `watcher.ts` warns about, arrived at by obeying a rule about not rescanning.
 *
 * So a file event reconciles exactly its own row, and only a *directory* event reconciles a subtree
 * — which is the affected path, not more than it.
 *
 * **Absence is a removal, and only when it is confirmed as absence.** `walkAndVerify` returns
 * `null` for ENOENT and a typed failure for anything else, and the difference is load-bearing: an
 * `EACCES` treated as "gone" would delete a row for a file that is still there. §13.6's rule about
 * never reading a non-ENOENT error as "free", applied to the index.
 */
export async function reconcileEntry(
  root: RegisteredRoot,
  store: IndexStore,
  segments: readonly string[],
  options: IndexOptions = {},
): Promise<ReconcileResult> {
  const nothing: ReconcileResult = { added: 0, updated: 0, unchanged: 0, removed: 0, problems: 0 }
  // The root itself is never a row. Reconciling "the whole root" is `reconcileSubtree([])`.
  if (segments.length === 0) return { ...nothing, problems: 1 }

  const identity = await walkAndVerify(root, segments)
  if (!identity.ok) return { ...nothing, problems: 1 }

  if (identity.value === null) {
    // Gone. Its descendants go with it — a directory can vanish between two events, and rows
    // beneath a path that no longer exists are rows nothing will ever correct.
    let removed = 0
    for (const entry of [...store.subtree(root.id, segments)]) {
      store.remove(root.id, entry.segments)
      removed++
    }
    return { ...nothing, removed }
  }

  const name = segments[segments.length - 1] ?? ''
  const walked: WalkedEntry = {
    segments: [...segments],
    name,
    kind: identity.value.kind,
    size: identity.value.size,
    mtimeNs: identity.value.mtimeNs,
    dev: identity.value.dev,
    ino: identity.value.ino,
    nlink: identity.value.nlink,
    likelyDataless:
      identity.value.kind === 'file' && identity.value.size > 0 && identity.value.blocks === 0,
  }
  // Through `toIndexEntry`, never around it: the title rule, the dataless rule and the
  // contentUnavailable rule are decided in one place, and a second copy here would be a second
  // place for them to drift.
  const entry = await toIndexEntry(root, walked, options)
  const previous = store.upsert(entry)
  const own: ReconcileResult = previous === undefined
    ? { ...nothing, added: 1 }
    : sameRow(previous, entry) ? { ...nothing, unchanged: 1 } : { ...nothing, updated: 1 }

  /**
   * **A directory reconciles its contents, and the routing lives HERE rather than in the caller.**
   *
   * The first version asked the *index* whether the path was a directory and routed on that answer,
   * which is wrong in the case that matters: a deleted directory is still a directory in the index,
   * so it went to `reconcileSubtree`, which correctly refuses to remove rows beneath a path it
   * could not read — and the whole subtree survived as ghost rows forever. Caught by a test written
   * against "a vanished directory takes its rows with it", not against the code.
   *
   * Routing on what is on disk, after the one `lstat` this function already does, cannot get that
   * wrong: absence is handled above and never reaches here.
   */
  if (identity.value.kind !== 'directory') return own

  const below = await reconcileSubtree(root, store, segments, options)
  return {
    added: own.added + below.added,
    updated: own.updated + below.updated,
    unchanged: own.unchanged + below.unchanged,
    removed: below.removed,
    problems: below.problems,
  }
}

export interface ReconcileResult {
  readonly added: number
  /** Rows whose content actually differs from what was there. **Not** rows that were re-seen. */
  readonly updated: number
  /** Rows re-seen and found identical. Separated so `added + updated + removed` means "news". */
  readonly unchanged: number
  readonly removed: number
  readonly problems: number
}

/**
 * Re-reads ONE subtree and makes the index match it. Spec §5.
 *
 * This is the recovery path that exists because Node's `fs.watch({recursive:true})` does not
 * surface FSEvents' `MustScanSubDirs` / `UserDropped` / `KernelDropped` flags — the exact
 * signals that mean *rescan*. Under §2's zero-dependency rule the server cannot see them, so
 * reconciliation is scheduled defensively instead. If that proves insufficient in daily use it
 * is an escalation under §2, never a silent downgrade of correctness.
 *
 * Bounded by construction: it walks only `segments` and only removes rows beneath `segments`.
 */
export async function reconcileSubtree(
  root: RegisteredRoot,
  store: IndexStore,
  segments: readonly string[],
  options: IndexOptions = {},
): Promise<ReconcileResult> {
  const seen = new Set<string>()
  let added = 0
  let updated = 0
  let unchanged = 0
  let problems = 0
  // A subtree we could not read must not be treated as an empty one — that would delete every
  // row beneath it (spec §6: no empty-but-successful stand-in for a failure). But the converse
  // matters just as much and was previously wrong: gating removal on "at least one entry was
  // seen" made a subtree that had legitimately EMPTIED indistinguishable from an unreadable
  // one, so its rows survived forever and every later reconcile of that path also saw empty
  // and also did nothing. A `git checkout` or an agent clearing a folder — both routine here —
  // left permanent ghost rows on the board.
  //
  // The walk already distinguishes the two: a directory we could not read yields a WalkProblem
  // AT THAT DIRECTORY. That, not the entry count, is the correct signal.
  //
  // CORRECTED 2026-08-06 by the P1 re-gate, which found the first version of this fix only half
  // right. It set one tree-wide `startFailed` boolean, and only when the problem was at the START
  // path — so a permission-denied directory NESTED anywhere below the start left the flag false
  // and every row beneath it was removed. On the whole-root reconcile (`segments: []`) — which is
  // exactly what a watcher error triggers — no directory is ever the start path, so the guard was
  // inert for the entire tree. EACCES on ~/Documents, ~/Desktop and iCloud arrives with no prompt
  // on macOS; this is a routine state, not an exotic one. "Unreadable means empty" is the precise
  // defect B4 was raised to close, and it survived one level down.
  //
  // A problem's segments name a path whose subtree state is UNKNOWN — a failed `readdir` (the
  // directory's contents are unknown) and a failed `lstat` (that child is unknown) are the same
  // fact at different depths. Removal is therefore withheld from every row at or beneath any such
  // path, and from nothing else. A failure at the start path makes every row unverified, which is
  // the old behaviour arriving as a special case rather than as a separate rule.
  const unverified: string[][] = []

  for await (const event of walkSubtree(root, segments)) {
    if (event.problem !== undefined) {
      problems++
      unverified.push([...event.problem.segments])
      continue
    }
    if (event.entry === undefined) continue

    const key = store.keyFor(root.id, event.entry.segments)
    seen.add(key)
    const entry = await toIndexEntry(root, event.entry, options)
    const previous = store.upsert(entry)
    if (previous === undefined) added++
    // `updated` counts rows that ACTUALLY CHANGED, not rows that were re-seen. See `sameRow`: the
    // distinction never mattered until live updates used this count to decide whether to tell the
    // client anything, and then it mattered on every reconcile of an unchanged tree.
    else if (!sameRow(previous, entry)) updated++
    else unchanged++
  }

  // Whole-segment comparison, never a string prefix — spec §5. `/soil/notes` must not be treated
  // as covering `/soil/notes-old`, which is the attribution bug the spec records from v1.
  const isAtOrUnder = (candidate: readonly string[], prefix: readonly string[]): boolean =>
    candidate.length >= prefix.length && prefix.every((part, i) => candidate[i] === part)

  let removed = 0
  for (const entry of store.subtree(root.id, segments)) {
    const key = store.keyFor(root.id, entry.segments)
    if (seen.has(key)) continue
    // The starting directory itself is not yielded by its own walk; keep it.
    if (entry.segments.length === segments.length) continue
    // Absent from a walk that could not see everything is not evidence of absence.
    if (unverified.some(prefix => isAtOrUnder(entry.segments, prefix))) continue
    store.remove(root.id, entry.segments)
    removed++
  }

  return { added, updated, unchanged, removed, problems }
}
