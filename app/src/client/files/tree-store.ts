/**
 * What the Files tree knows, and how it finds out. No DOM.
 *
 * `tree-model.ts` turns state into rows; this holds the state and fills it. Split so the view
 * layer has nothing to decide: it draws `visibleRows(...)` and reports clicks back.
 *
 * **Children are fetched lazily, once, per folder.** The PRD's floor is 10,000 markdown files, and
 * fetching the whole tree to draw the top of it is the shape that makes a 10,000-file workspace
 * feel broken. A folder's children arrive when it is first expanded and are then cached until
 * something on disk says otherwise.
 *
 * **An in-flight fetch is not repeated.** Expand, collapse, expand again inside a second is an
 * ordinary double-click, and it must produce one request. `#inFlight` is what makes that true —
 * without it a slow disk turns an impatient user into a queue of identical reads.
 */

import type { WireEntry } from '../../contract/wire'
import { ancestorKeys, rowKey } from './tree-model'

/** How the store talks to the server. Injected so tests need no network and no session. */
export interface TreeGateway {
  /** `tree.children`. Rejects or resolves with the rows; a failure must not be an empty list. */
  readonly children: (rootId: string, segments: readonly string[]) => Promise<readonly WireEntry[]>
}

/** Told when something changed, so the view can redraw. */
export type TreeListener = () => void

export interface TreeStore {
  readonly rootIds: () => readonly string[]
  readonly setRoots: (rootIds: readonly string[]) => void
  readonly childrenOf: (rootId: string, segments: readonly string[]) => readonly WireEntry[] | undefined
  readonly expanded: () => ReadonlySet<string>
  readonly isExpanded: (key: string) => boolean
  /** Expand or collapse, fetching on first expand. */
  readonly toggle: (entry: WireEntry) => Promise<void>
  /**
   * Expand every folder containing this path, fetching as needed. PRD's auto-expand.
   *
   * **`open` expands the target itself as well**, for a jump that lands on a folder — a project, a
   * board, an inbox folder. Ruled 2026-08-19, testing *"View in Files"* on the Projects tab:
   * *"that doesn't work. It just jumps you to files, but it doesn't select or show on screen the
   * selected folder."* You jump to a folder to see inside it, not to admire where it sits.
   *
   * Defaulted off, so the two callers that jump to a **file** keep the behaviour they have: opening
   * a document's parent folder is right, expanding the document is meaningless.
   */
  readonly revealPath: (
    rootId: string,
    segments: readonly string[],
    options?: { readonly open?: boolean },
  ) => Promise<void>
  /** Restore an expansion set from a previous session, fetching what it names. */
  readonly restoreExpanded: (keys: Iterable<string>) => Promise<void>
  /** A folder's cached children are stale. Refetch if it is expanded, drop the cache if not. */
  readonly invalidate: (rootId: string, segments: readonly string[]) => Promise<void>
  /** The last error, for the view to show. Cleared by the next successful fetch of that folder. */
  readonly errorAt: (key: string) => string | undefined
  readonly subscribe: (listener: TreeListener) => () => void
}

export interface TreeStoreOptions {
  readonly gateway: TreeGateway
  /** Reported rather than thrown — a folder that will not list is a row with a problem, not a crash. */
  readonly onError?: (key: string, reason: string) => void
}

export function createTreeStore(options: TreeStoreOptions): TreeStore {
  const children = new Map<string, readonly WireEntry[]>()
  const errors = new Map<string, string>()
  const expanded = new Set<string>()
  const inFlight = new Map<string, Promise<void>>()
  const listeners = new Set<TreeListener>()
  let roots: readonly string[] = []
  /** Read through a function so `restoreExpanded` sees whatever `setRoots` last stored. */
  const roots_ = (): readonly string[] => roots

  const announce = (): void => { for (const listener of listeners) listener() }

  /**
   * Fetches a folder's children unless a fetch is already running for it.
   *
   * Returns the shared promise rather than a fresh one, so several callers awaiting the same folder
   * all resolve when the single request lands. **Never resolves to a list on failure** — the cache
   * is left absent and the error recorded, because a cached `[]` is indistinguishable from an empty
   * folder and §6's rule is that an empty result never stands in for a failure.
   */
  const fetchChildren = (rootId: string, segments: readonly string[]): Promise<void> => {
    const key = rowKey(rootId, segments)
    const running = inFlight.get(key)
    if (running !== undefined) return running

    const request = options.gateway.children(rootId, segments)
      .then(rows => {
        children.set(key, rows)
        errors.delete(key)
      })
      .catch((thrown: unknown) => {
        const reason = thrown instanceof Error ? thrown.message : 'could not read that folder'
        errors.set(key, reason)
        // The cache stays ABSENT rather than empty. `childrenLoaded` on the row then reads false,
        // and the view shows a problem instead of a folder that appears to hold nothing.
        children.delete(key)
        options.onError?.(key, reason)
      })
      .finally(() => {
        inFlight.delete(key)
        announce()
      })

    inFlight.set(key, request)
    return request
  }

  /** Expands one key, fetching if its children are not held. */
  const expand = async (rootId: string, segments: readonly string[]): Promise<void> => {
    const key = rowKey(rootId, segments)
    expanded.add(key)
    // Announced before the await so the row opens immediately and shows its pending state, rather
    // than the tree appearing frozen for the length of a disk read.
    announce()
    if (!children.has(key)) await fetchChildren(rootId, segments)
  }

  return {
    rootIds: () => roots,

    setRoots: rootIds => {
      roots = [...rootIds]
      // Each registered folder's own children are the top level, so they are fetched eagerly —
      // there is no row to click to open them.
      for (const rootId of roots) void fetchChildren(rootId, [])
      announce()
    },

    childrenOf: (rootId, segments) => children.get(rowKey(rootId, segments)),

    expanded: () => expanded,
    isExpanded: key => expanded.has(key),

    toggle: async entry => {
      if (entry.kind !== 'directory') return
      const key = rowKey(entry.rootId, entry.segments)
      if (expanded.has(key)) {
        expanded.delete(key)
        /**
         * **Collapsing keeps the cache.** Re-expanding a folder should be instant, and the watcher
         * invalidates anything that actually changed. Dropping it here would turn every collapse
         * into a future round trip and make the tree feel slower the more it is used.
         */
        announce()
        return
      }
      await expand(entry.rootId, entry.segments)
    },

    revealPath: async (rootId, segments, revealOptions) => {
      /**
       * Sequential, not parallel, and that is required rather than tidy: a folder's children have
       * to arrive before its child folder is known to exist. Firing them together would expand
       * keys for paths that may not be there.
       */
      for (const key of ancestorKeys(rootId, segments)) expanded.add(key)
      if (revealOptions?.open === true) expanded.add(rowKey(rootId, segments))
      announce()

      for (let depth = 0; depth < segments.length; depth += 1) {
        const at = segments.slice(0, depth)
        if (!children.has(rowKey(rootId, at))) await fetchChildren(rootId, at)
      }

      /**
       * **The target's OWN children, and only when it is being opened.**
       *
       * The loop above stops one short — it fetches every ancestor, because that is all the old
       * behaviour needed. Expanding the target without this leaves it marked open with nothing
       * under it, which is the exact failure `restoreExpanded` below records having shipped once:
       * *"folders marked open with nothing under them, because nobody had asked for their
       * children."* Same trap, same file, two months apart.
       */
      if (revealOptions?.open === true && !children.has(rowKey(rootId, segments))) {
        await fetchChildren(rootId, segments)
      }
    },

    restoreExpanded: async keys => {
      /**
       * **This function's comment used to say it fetched, and it did not.**
       *
       * It added the keys to the expanded set and announced — so a restored session showed folders
       * marked open with nothing under them, because nobody had asked for their children. The
       * docstring on the interface said *"fetching what it names"* the whole time. That is this
       * build's most-recorded failure shape (*the comment says the right thing while the mechanism
       * does the other thing*), and the tests here missed it because they asserted that the KEYS
       * were held rather than that the rows appeared.
       *
       * **Restored view state is untrusted input** (F9.2). The keys came from this browser's own
       * storage, which anything with devtools can edit — so each is parsed rather than trusted, its
       * root must be one the server just reported, and the fetch it provokes goes through
       * `tree.children`, which validates `(rootId, segments)` at the contract boundary like every
       * other request. A key naming a folder that has been deleted or renamed simply finds nothing.
       */
      const roots = new Set(roots_())
      const wanted: Array<{ rootId: string; segments: string[] }> = []

      for (const key of keys) {
        expanded.add(key)
        // `rowKey` joins with NUL, which is the one byte a macOS filename cannot contain — so this
        // split is unambiguous, and that is precisely why NUL was chosen as the separator.
        const [rootId, ...segments] = key.split('\u0000')
        if (rootId === undefined || !roots.has(rootId)) continue
        wanted.push({ rootId, segments })
      }
      announce()

      /**
       * Shallowest first, so a parent's children arrive before its child folder is asked for.
       * Sorted rather than assumed: the stored order is whatever a `Set` iterated in months ago.
       */
      wanted.sort((a, b) => a.segments.length - b.segments.length)
      for (const target of wanted) {
        if (!children.has(rowKey(target.rootId, target.segments))) {
          await fetchChildren(target.rootId, target.segments)
        }
      }
    },

    invalidate: async (rootId, segments) => {
      const key = rowKey(rootId, segments)
      if (expanded.has(key) || segments.length === 0) {
        await fetchChildren(rootId, segments)
        return
      }
      children.delete(key)
      announce()
    },

    errorAt: key => errors.get(key),

    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
