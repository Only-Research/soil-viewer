/**
 * Per-target mutation locks. Spec §13.8.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * §13.8: *"Mutations are serialized per target path server-side."* The failures it names are not
 * exotic — they are two taps:
 *
 *   - **Double-tap Duplicate creates two files that each found the name free.** Both check, both
 *     see nothing, both create. Exclusive create does not help: they pick *different* names, and
 *     each one is individually correct.
 *   - **A row action against a path an agent just replaced renames the wrong file**, while obeying
 *     every other rule.
 *
 * **WIRED — and this block said the opposite until 2026-08-16.** It read *"NOT YET WIRED INTO THE
 * MUTATION PATHS"*, which told a reader that an accepted §13.6 risk was currently unaccepted. There
 * are nine `locks.withLock` sites in `server/services.ts`, and `entry.rename` builds both parent
 * keys and calls `exclusiveRename` **inside** the lock — precisely the condition the old text said
 * was unmet.
 *
 * The wiring is at the route layer rather than inside each Core function, which is what the original
 * reasoning asked for: that is where one mutation begins and ends, and taking the lock inside Core
 * would serialize the halves of a compound operation separately.
 *
 * **What IS still open, found by the sweep on 2026-08-16 and recorded in
 * `build/sweep-findings-2026-08-16.md` §7:** the call sites use two key namespaces that can never
 * collide. `file.save`, `chatroom.append` and `conflict.resolve` lock the **file** path;
 * `entry.rename`, `card.move`, `entry.create` and `entry.copy` lock the **parent folder**. So a save
 * and a rename of the same file do not serialize against each other, and §13.8's *"mutations are
 * serialized per target path"* does not hold across that pair.
 *
 * the operator ruled it a rare edge case — it needs two of their own clients acting on one file inside the
 * few milliseconds of `writeThroughTemp` — and deprioritised it, which is agreed rather than
 * overruled. It is not free to leave: `append.ts`'s re-open-by-path is safe only while that window
 * stays shut.
 */

import { foldCase, toNFC } from '../text'
import { type RegisteredRoot } from './containment'

/**
 * The key that decides whether two operations are touching the same thing.
 *
 * **Getting this wrong does not produce a deadlock or an error — it produces silence.** Two
 * operations on one file take two different locks, run concurrently, and the serialization simply
 * is not there. So the key has to fold the same things the filesystem folds:
 *
 *   - **NFC**, always. `café.md` composed and decomposed are two strings and one file (§4).
 *   - **case**, but only on a case-insensitive root, and using the same `foldCase` the rest of the
 *     build uses rather than `toLowerCase`. On a case-*sensitive* volume `Notes.md` and `notes.md`
 *     really are two files and must not share a lock.
 *
 * **Deliberately NOT `grammarKey`**, which is the obvious thing to reach for and is wrong here: it
 * strips numeric prefixes, so `01-intro.md` and `02-intro.md` would collapse to one key. That is
 * harmless for grammar — the numbers are ordering, not identity — and here it would serialize two
 * unrelated files, which is a performance bug rather than a safety one but would also mislead
 * anyone reading the lock's behaviour.
 *
 * Segments are joined with NUL because it is the one byte a path cannot contain, so no combination
 * of names can forge another combination's key.
 */
export function lockKeyFor(root: RegisteredRoot, segments: readonly string[]): string {
  const fold = (segment: string): string =>
    root.caseInsensitive ? foldCase(toNFC(segment)) : toNFC(segment)
  // Written as an ESCAPE, never as a literal. A raw NUL byte in source renders as nothing — or as
  // an ordinary space — in every editor, so a key joined on a space and one joined on NUL look
  // identical while behaving differently. The retained-buffer tests were bitten by exactly this
  // and say so in their own header; the first draft of this line had the literal.
  return [root.id, ...segments.map(fold)].join('\u0000')
}

export interface MutationLocks {
  /**
   * Runs `work` with every named key held, releasing them however `work` ends.
   *
   * Multiple keys are for operations with more than one target — a move touches the source's
   * parent and the destination's parent, and holding only one of them serializes only half of it.
   */
  withLock<T>(keys: readonly string[], work: () => Promise<T>): Promise<T>
  /** Keys currently held or queued. Zero at rest — the assertion that this does not leak. */
  readonly size: number
}

interface Entry {
  /** Resolves when the last queued holder releases. */
  tail: Promise<void>
  /** Holders plus waiters. The entry is dropped when this reaches zero. */
  waiting: number
}

export function createMutationLocks(): MutationLocks {
  const entries = new Map<string, Entry>()

  /**
   * Claims a place in one key's queue, **synchronously**, and returns the wait and the release.
   *
   * The synchronous part is the whole point and a failing test is what produced it. When
   * acquisition was `async` — awaiting key A before even asking for key B — another caller could
   * take B in the gap, so a two-key operation could be overtaken by a one-key operation that
   * arrived later. Mutual exclusion still held, but the ordering was surprising, and "surprising
   * but technically safe" is how a lock ends up being reasoned about wrongly later.
   *
   * Enqueueing on every key in one synchronous step closes the gap: nothing else runs between the
   * first key and the last, because nothing else *can* — this is single-threaded, and there is no
   * await in the middle.
   */
  function enqueue(key: string): { waitFor: Promise<void>; release: () => void } {
    let entry = entries.get(key)
    if (entry === undefined) {
      entry = { tail: Promise.resolve(), waiting: 0 }
      entries.set(key, entry)
    }
    entry.waiting += 1

    const previous = entry.tail
    let signal!: () => void
    const mine = new Promise<void>(resolve => { signal = resolve })
    entry.tail = previous.then(() => mine)

    let released = false
    const release = (): void => {
      /**
       * Guarded because a double release would decrement `waiting` twice, drop the entry while a
       * holder is still running, and let the next caller create a fresh lock for a file that is
       * already being written — two holders at once, arriving through the mechanism meant to
       * prevent exactly that.
       *
       * **UNPROVEN, and labelled rather than counted.** The sweep shows this green: `release` is
       * never handed outside this module and `withLock` calls each one exactly once, so no test can
       * reach a second call. It is a guard against a future refactor that exposes or re-invokes it,
       * and the failure it would prevent is silent, so it stays.
       */
      if (released) return
      released = true
      signal()
      const current = entries.get(key)
      if (current === undefined) return
      current.waiting -= 1
      // Dropped at zero so a long-running process does not accumulate one entry per file it has
      // ever touched. Safe because the decrement and the delete happen in the same synchronous
      // step as any concurrent `enqueue`'s lookup — nothing can be holding a stale entry.
      if (current.waiting === 0) entries.delete(key)
    }

    return { waitFor: previous, release }
  }

  return {
    async withLock<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
      /**
       * **Sorted, and that is the deadlock argument.** Two concurrent moves, one going A→B and one
       * going B→A, would otherwise take their locks in opposite orders and wait on each other
       * forever. Acquiring in a total order makes that impossible for any number of keys.
       *
       * Deduplicated because a rename within one folder names the same parent twice, and taking a
       * lock twice from the same holder waits on itself — a one-participant deadlock.
       */
      const ordered = [...new Set(keys)].sort()
      // Every queue position claimed before the first await — see `enqueue`.
      const claims = ordered.map(enqueue)
      const releases = claims.map(claim => claim.release)
      try {
        for (const claim of claims) await claim.waitFor
        return await work()
      } finally {
        // Reverse order for symmetry; correctness does not depend on it, but a lock trace that
        // nests cleanly is far easier to read when something does go wrong.
        for (const release of releases.reverse()) release()
      }
    },
    get size(): number {
      return entries.size
    },
  }
}

