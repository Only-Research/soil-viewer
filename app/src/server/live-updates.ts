/**
 * Live updates: the watcher, the index, and the stream, finally connected. Spec §5 and §15.
 *
 * **Three components were each complete and reachable by nothing.** `TreeWatcher` was constructed
 * by no production module. `reconcileSubtree` was called by no production module. `broadcast` was
 * called by no production module. Each had its own tests and its own mutation sweep, and together
 * they did nothing at all — the phase brief carried the watcher as the single unwired component for
 * three phases while two more sat beside it.
 *
 * They land together because none of them works alone: a watcher with nothing to call, a reconciler
 * nothing triggers, and a broadcast with nothing to say.
 *
 * THE ORDER, and it is the whole design:
 *
 *   1. The watcher coalesces a storm into one batch (§5's 250 ms window).
 *   2. **The index is corrected first.** Broadcasting before reconciling would tell the client to
 *      refetch, and the refetch would be answered out of a stale index — a "live update" that
 *      delivers the old bytes, which is worse than no update because it looks like it worked.
 *   3. Only then does anything reach the stream, and only if the index actually changed.
 *
 * WHAT GETS REINDEXED IS BOUNDED, because §5 is explicit: *"no mutation handler and no single
 * watcher event may trigger reindexing beyond the affected paths."* A file event reconciles exactly
 * its own row (`reconcileEntry`); a directory event reconciles that directory's subtree. Nothing
 * walks a parent, and nothing walks the whole root except the four defensive triggers §5 names —
 * watcher error, watcher restart, wake from sleep, index contradiction.
 */

import { reconcileEntry, reconcileSubtree } from '../core/indexer'
import type { IndexStore } from '../core/index-store'
import { TreeWatcher, type ReconcileReason, type WatcherOptions } from '../core/fs/watcher'
import { detectCloudProvider } from '../core/fs/registration'
import type { RegisteredRoot } from '../core/fs/containment'
import type { StreamEvent } from './stream'

/**
 * The event the client already listens for. `live-stream.ts` knows `changed` and `resync` by name
 * and ignores anything else rather than guessing — so a new type invented here would be dropped in
 * silence, which is the failure this comment exists to prevent someone discovering later.
 */
export const CHANGED_EVENT = 'changed'

export interface ChangedPayload {
  readonly rootId: string
  /**
   * The paths whose index rows were corrected, folder-relative.
   *
   * **An empty array — not an empty list of arrays — means "everything under this root".** That is
   * what a defensive whole-root reconcile produces, and the client's answer is the same either way:
   * refetch whatever it is currently showing of this root.
   */
  readonly segments: readonly (readonly string[])[]
  readonly reason: 'watched' | ReconcileReason
}

export interface LiveUpdateOptions {
  readonly index: IndexStore
  readonly broadcast: (event: StreamEvent) => void
  /** Where a reconcile failure goes. Nothing is allowed to fail silently — the security review's S5. */
  readonly onProblem?: (at: string, detail: string) => void
  /**
   * Per-root watcher options. **A test seam and nothing else.**
   *
   * `fs.watch` is denied inside the Claude Code sandbox — it fails with a misleading `EMFILE` while
   * the descriptor limit is over a million (diagnosed 2026-08-06). Without an injectable source
   * every rule in this file would be unprovable in the environment it is written in.
   */
  readonly watcherOptionsFor?: (root: RegisteredRoot) => WatcherOptions
}

export interface LiveUpdates {
  readonly watch: (root: RegisteredRoot) => void
  readonly unwatch: (rootId: string) => void
  /**
   * Tells the watcher for this root that the app just wrote this file, so the event it causes is
   * recognised as an echo rather than announced as someone else's change. §5.
   */
  readonly noteOwnWrite: (
    rootId: string, segments: readonly string[], size: number, mtimeNs: bigint,
  ) => void
  /** Resolves when every queued reconcile has finished. For tests and for shutdown. */
  readonly settled: () => Promise<void>
  readonly stop: () => void
}

/** Whole-segment containment, never a string prefix — spec §5. `notes` does not cover `notes-old`. */
function isAtOrUnder(candidate: readonly string[], prefix: readonly string[]): boolean {
  return candidate.length >= prefix.length && prefix.every((part, i) => candidate[i] === part)
}

/**
 * Drops any path already covered by another in the same batch.
 *
 * A `git checkout` produces a directory event and events for the files inside it. Reconciling the
 * directory covers its whole subtree, so reconciling the children afterwards re-reads work already
 * done — and on a large project that is the difference between a bounded correction and a storm.
 */
export function withoutCoveredPaths(paths: readonly (readonly string[])[]): string[][] {
  const sorted = [...paths].sort((a, b) => a.length - b.length)
  const kept: string[][] = []
  for (const path of sorted) {
    if (kept.some(prefix => isAtOrUnder(path, prefix))) continue
    kept.push([...path])
  }
  return kept
}

export function createLiveUpdates(options: LiveUpdateOptions): LiveUpdates {
  const watchers = new Map<string, TreeWatcher>()

  /**
   * One promise chain per root.
   *
   * Two reconciles of the same tree running at once would interleave their `seen` sets and their
   * removals — the second could delete a row the first had just re-added. Per root rather than
   * global so an unrelated folder is not held up behind a large walk, which is the same reasoning
   * that keys §13.8's mutation lock on the path rather than on a constant.
   */
  const queues = new Map<string, Promise<unknown>>()

  const enqueue = (rootId: string, work: () => Promise<void>): void => {
    const previous = queues.get(rootId) ?? Promise.resolve()
    const next = previous.then(work, work).catch(error => {
      options.onProblem?.('live-updates', `reconcile failed: ${String(error)}`)
    })
    queues.set(rootId, next)
  }

  /** §5: a cloud root never has a body read during indexing, and that holds on the live path too. */
  const indexOptions = (root: RegisteredRoot) =>
    detectCloudProvider(root.absolutePath) === null ? {} : { skipBodyReads: true }

  const announce = (payload: ChangedPayload): void => {
    options.broadcast({ type: CHANGED_EVENT, data: payload })
  }

  const applyBatch = async (root: RegisteredRoot, batch: readonly string[][]): Promise<void> => {
    const changed: string[][] = []
    for (const segments of withoutCoveredPaths(batch)) {
      /**
       * One call, and it routes itself: a file reconciles its own row, a directory reconciles its
       * subtree, an absent path removes its rows. The routing is inside `reconcileEntry` because it
       * has to be decided from **disk**, not from the index — a deleted directory is still a
       * directory in the index, and asking the index sent it down the subtree path, where a walk
       * that cannot read the start correctly removes nothing and the rows survive forever.
       */
      const result = await reconcileEntry(root, options.index, segments, indexOptions(root))
      if (result.added + result.updated + result.removed > 0) changed.push([...segments])
    }

    /**
     * **Silence when nothing changed, and that is a rule rather than an optimisation.** The echo
     * dedup upstream is not perfect — a file touched with identical content produces a real event
     * — and a client told to refetch for a byte-identical file is being made to do work for
     * nothing, repeatedly, on a tree where agents write constantly.
     */
    if (changed.length > 0) {
      announce({ rootId: root.id, segments: changed, reason: 'watched' })
    }
  }

  const applyReconcile = async (
    root: RegisteredRoot, segments: readonly string[], reason: ReconcileReason,
  ): Promise<void> => {
    const result = await reconcileSubtree(root, options.index, segments, indexOptions(root))
    if (result.problems > 0) {
      options.onProblem?.(
        'live-updates',
        `${reason} reconcile of ${root.id}/${segments.join('/')} met ${result.problems} unreadable paths`,
      )
    }
    if (result.added + result.updated + result.removed === 0) return
    announce({ rootId: root.id, segments: [[...segments]], reason })
  }

  return {
    watch: root => {
      // Re-registering the same id must not leave two watchers on one tree, each announcing every
      // change twice and each holding a descriptor.
      watchers.get(root.id)?.stop()

      const watcher = new TreeWatcher(root, {
        onChanged: batch => { enqueue(root.id, () => applyBatch(root, batch)) },
        onReconcileNeeded: (segments, reason) => {
          enqueue(root.id, () => applyReconcile(root, segments, reason))
        },
      }, options.watcherOptionsFor?.(root) ?? {})

      watchers.set(root.id, watcher)
      watcher.start()
    },

    unwatch: rootId => {
      watchers.get(rootId)?.stop()
      watchers.delete(rootId)
      queues.delete(rootId)
    },

    noteOwnWrite: (rootId, segments, size, mtimeNs) => {
      watchers.get(rootId)?.noteOwnWrite(segments, size, mtimeNs)
    },

    settled: async () => {
      // Drained rather than awaited once: a reconcile can enqueue nothing new today, but waiting on
      // the chain as it stands is a promise about a snapshot, and this is used to decide a test has
      // finished. Loop until the chain stops moving.
      for (;;) {
        const pending = [...queues.values()]
        await Promise.all(pending)
        if ([...queues.values()].every((p, i) => p === pending[i]) &&
            queues.size === pending.length) return
      }
    },

    stop: () => {
      for (const watcher of watchers.values()) watcher.stop()
      watchers.clear()
      queues.clear()
    },
  }
}
