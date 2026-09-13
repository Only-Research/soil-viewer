/**
 * The filesystem watcher. Spec §5.
 *
 * Three rules from §5 shape everything here, and each exists because of a specific failure:
 *
 * 1. **No polling, stated mechanically.** v1's "no polling" was satisfiable by a 30-second
 *    timer, so §5 replaced it with: *no timer may trigger a filesystem read of more than one
 *    path*. The only timers in this file are the coalescing flush (reads one path per changed
 *    path, event-driven) and the sleep detector (reads nothing at all).
 *
 * 2. **Echo dedup keys on the exact `(path, size, mtimeNs)` the app wrote — never a time
 *    window.** A window would swallow a real agent change that happened to land inside it,
 *    which in this tree is not hypothetical: agents write to the soil constantly.
 *
 * 3. **Reconciliation is scheduled defensively**, because Node's `fs.watch({recursive:true})`
 *    does not surface FSEvents' `MustScanSubDirs` / `UserDropped` / `KernelDropped` — the exact
 *    signals that mean *rescan* (M11). Under §2's zero-dependency rule the server cannot see
 *    them. If defensive scheduling proves insufficient in daily use, that is an escalation
 *    under §2, never a silent downgrade of correctness.
 */

import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

import { isIgnoredSegment } from '../grammar'
import { errnoOf, type RegisteredRoot } from './containment'

/** Spec §5: "Watcher-storm coalescing: a `git checkout` or an agent writing 500 files is
 *  coalesced, **250 ms window**, not one reindex per event." */
export const COALESCE_MS = 250

/** Spec §5's backoff ceiling, reused for watcher restarts. */
export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 60_000

/** How often the sleep detector wakes. It performs NO filesystem access — it only compares
 *  clocks — so it is not polling under §5's definition. */
const SLEEP_CHECK_MS = 10_000

/** A gap this much larger than the interval means the machine was asleep, not merely busy. */
const SLEEP_GAP_FACTOR = 3

export type ReconcileReason =
  | 'watcher-error'
  | 'watcher-restart'
  | 'wake-from-sleep'
  | 'index-contradiction'

export interface WatcherCallbacks {
  /** Coalesced batch of changed paths, relative to the root. Never fires for ignored paths,
   *  and never for a change this app made itself. */
  readonly onChanged: (segments: string[][]) => void
  /** A subtree must be re-read. `segments` is empty for the whole root. */
  readonly onReconcileNeeded: (segments: string[], reason: ReconcileReason) => void
}

/**
 * Where raw change events come from. Production uses `fs.watch`; tests supply a fake.
 *
 * This seam exists because the OS is not always available to ask. `fs.watch` is denied inside
 * the Claude Code sandbox — it fails with a misleading `EMFILE` even though the descriptor
 * limit is over a million, while `watchFile`'s stat polling works and the same call succeeds
 * immediately outside the sandbox (diagnosed 2026-08-06). Rather than leave every coalescing,
 * dedup and ignore rule untestable in that environment, the *logic* is separated from the
 * *source*: everything below this interface is provable anywhere, and only the source itself
 * needs a real kernel.
 *
 * It also removes a class of flakiness — FSEvents latency is not ours to control, and timing
 * assertions built on it are unreliable by construction.
 */
export interface WatchSource {
  start(onEvent: (relativePath: string) => void, onError: (error: unknown) => void): void
  stop(): void
}

/** The production source: Node's recursive `fs.watch`. */
export function nodeWatchSource(absolutePath: string): WatchSource {
  let watcher: FSWatcher | null = null
  return {
    start(onEvent, onError) {
      try {
        // No `encoding` option is passed, so Node types `filename` as `string | null` — there
        // is no Buffer branch to handle here, and writing one made TypeScript narrow it to
        // `never`.
        watcher = watch(absolutePath, { recursive: true, persistent: false }, (_type, filename) => {
          if (filename !== null) onEvent(filename)
        })
        watcher.on('error', onError)
      } catch (error) {
        onError(error)
      }
    },
    stop() {
      watcher?.close()
      watcher = null
    },
  }
}

export interface WatcherOptions {
  readonly coalesceMs?: number
  /** Injectable for tests so the sleep path can be exercised without sleeping. */
  readonly now?: () => number
  /** Injectable for tests. Production uses SLEEP_CHECK_MS; a test cannot wait ten seconds per
   *  assertion, and the detector's logic is the same at any interval. */
  readonly sleepCheckMs?: number
  /** Injectable event source. Defaults to `fs.watch` over the root. */
  readonly source?: WatchSource
}

interface OwnWrite {
  readonly size: number
  readonly mtimeNs: bigint
}

export class TreeWatcher {
  readonly #root: RegisteredRoot
  readonly #callbacks: WatcherCallbacks
  readonly #coalesceMs: number
  readonly #now: () => number
  readonly #sleepCheckMs: number
  readonly #source: WatchSource

  #flushTimer: NodeJS.Timeout | null = null
  #sleepTimer: NodeJS.Timeout | null = null
  #restartTimer: NodeJS.Timeout | null = null
  #backoffMs = BACKOFF_MIN_MS
  #watcherIsOpen = false
  #lastTick = 0
  #stopped = false

  /** Pending changed paths, keyed by joined segments so a storm collapses to one entry each. */
  readonly #pending = new Map<string, string[]>()

  /**
   * What this app wrote, and exactly what the file looked like afterwards. Cleared when the
   * matching echo arrives, so a record never outlives its event and cannot mask a later real
   * change to the same path.
   */
  readonly #ownWrites = new Map<string, OwnWrite>()

  constructor(root: RegisteredRoot, callbacks: WatcherCallbacks, options: WatcherOptions = {}) {
    this.#root = root
    this.#callbacks = callbacks
    this.#coalesceMs = options.coalesceMs ?? COALESCE_MS
    this.#now = options.now ?? Date.now
    this.#sleepCheckMs = options.sleepCheckMs ?? SLEEP_CHECK_MS
    this.#source = options.source ?? nodeWatchSource(root.absolutePath)
  }

  /**
   * Records a write this app just performed, so the watcher event it causes is recognised as
   * an echo and dropped. Spec §5 — the key is the exact `(path, size, mtimeNs)`, so a
   * *different* subsequent write to the same path is NOT masked.
   */
  noteOwnWrite(segments: readonly string[], size: number, mtimeNs: bigint): void {
    this.#ownWrites.set(segments.join('/'), { size, mtimeNs })
  }

  start(): void {
    this.#stopped = false
    this.#openWatcher()
    this.#lastTick = this.#now()
    this.#sleepTimer = setInterval(() => this.#checkForSleep(), this.#sleepCheckMs)
    this.#sleepTimer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    this.#source.stop()
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    if (this.#sleepTimer) clearInterval(this.#sleepTimer)
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#flushTimer = null
    this.#sleepTimer = null
    this.#restartTimer = null
    this.#pending.clear()
  }

  #openWatcher(): void {
    // `failedDuringStart` exists because `nodeWatchSource.start()` calls `onError`
    // SYNCHRONOUSLY when `fs.watch` throws — the documented EMFILE case, and ordinary
    // descriptor exhaustion. Resetting the backoff unconditionally after `start()` therefore
    // ran AFTER the error handler had just doubled it, so the backoff never grew:
    // BACKOFF_MAX_MS was unreachable and a persistently failing watcher requested a
    // whole-root reconcile roughly once a second, forever. That is the minefield map's
    // "synchronous full-vault rescan" trap wearing async clothes.
    let failedDuringStart = false
    this.#source.start(
      relative => this.#onRawEvent(relative),
      error => {
        failedDuringStart = true
        this.#onWatcherError(error)
      },
    )
    this.#watcherIsOpen = !failedDuringStart
    if (!failedDuringStart) this.#backoffMs = BACKOFF_MIN_MS
  }

  #onWatcherError(error: unknown): void {
    if (this.#stopped) return
    this.#watcherIsOpen = false
    this.#source.stop()

    // The index may have missed changes while the watcher was down, and there is no signal
    // telling us which. Reconcile the whole root rather than assume nothing happened.
    this.#callbacks.onReconcileNeeded([], 'watcher-error')

    const delay = this.#backoffMs
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS)
    this.#restartTimer = setTimeout(() => {
      if (this.#stopped) return
      this.#openWatcher()
      // Only ask for a reconcile if the reopen actually succeeded. Asking after a failed
      // reopen doubled the whole-root scans per cycle for no new information — the failure
      // path already requested one above.
      if (this.#watcherIsOpen) this.#callbacks.onReconcileNeeded([], 'watcher-restart')
    }, delay)
    this.#restartTimer.unref?.()
    void errnoOf(error)
  }

  /**
   * Detects that the machine slept. Spec §5 requires reconciliation on wake, and FSEvents
   * delivers nothing for changes made while asleep.
   *
   * This timer reads no files — it compares clocks. §5's no-polling rule bans a timer that
   * triggers a filesystem read of more than one path; a tick that finds no gap does nothing
   * at all.
   */
  #checkForSleep(): void {
    const now = this.#now()
    const elapsed = now - this.#lastTick
    this.#lastTick = now
    if (elapsed > this.#sleepCheckMs * SLEEP_GAP_FACTOR) {
      this.#callbacks.onReconcileNeeded([], 'wake-from-sleep')
    }
  }

  /** Exposed so a caller that meets a path contradicting the index can demand a bounded
   *  re-read of exactly that subtree — spec §5's fifth reconciliation trigger. */
  requestReconcile(segments: string[], reason: ReconcileReason = 'index-contradiction'): void {
    this.#callbacks.onReconcileNeeded(segments, reason)
  }

  #onRawEvent(relative: string): void {
    if (this.#stopped || relative.length === 0) return

    const segments = relative.split('/').filter(s => s.length > 0)
    if (segments.length === 0) return

    // Spec §3: ignore rules evaluate against whole segments. Dropping here means a storm of
    // .DS_Store writes never reaches the coalescer at all.
    if (segments.some(isIgnoredSegment)) return

    this.#pending.set(segments.join('/'), segments)
    this.#scheduleFlush()
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null
      void this.#flush()
    }, this.#coalesceMs)
    this.#flushTimer.unref?.()
  }

  async #flush(): Promise<void> {
    if (this.#stopped || this.#pending.size === 0) return
    const batch = [...this.#pending.values()]
    this.#pending.clear()

    const real: string[][] = []
    for (const segments of batch) {
      if (await this.#isOwnEcho(segments)) continue
      real.push(segments)
    }
    if (real.length > 0) this.#callbacks.onChanged(real)
  }

  /**
   * True when this event is the app hearing its own write.
   *
   * Compares the file's CURRENT `(size, mtimeNs)` against what we recorded writing. If they
   * match exactly, this is the echo. If they differ, something changed the file again after
   * we wrote it — a real event, and the stale record is dropped so it cannot mask anything
   * further.
   */
  async #isOwnEcho(segments: string[]): Promise<boolean> {
    const key = segments.join('/')
    const recorded = this.#ownWrites.get(key)
    if (recorded === undefined) return false

    try {
      const stat = await fsp.lstat(join(this.#root.absolutePath, ...segments), { bigint: true })
      const matches = Number(stat.size) === recorded.size && stat.mtimeNs === recorded.mtimeNs
      this.#ownWrites.delete(key)
      return matches
    } catch {
      // The file is gone, or unreadable. Either way this is not a confirmable echo, so it is
      // treated as a real event — failing toward telling the user something happened.
      this.#ownWrites.delete(key)
      return false
    }
  }
}
