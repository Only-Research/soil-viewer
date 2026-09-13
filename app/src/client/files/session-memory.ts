/**
 * Remembering where you were. PRD, §15, and F9.2.
 *
 * PRD: *"Remembers between sessions: last open file, active tab, sidebar collapsed/expanded, and
 * the expanded-folder set. (All new work — the old app only remembered window size.)"*
 *
 * **Per-client storage, never the server's config.** §15: *"File truth is server-side; view state is
 * per-client. Which file is open, active tab, sidebar state live in each client's own storage.
 * 'Live everywhere' means the *files* are live, not the cursor."* the user's Mac and their phone are
 * meant to be looking at different things at once, and a shared cursor would make one yank the
 * other around.
 *
 * `localStorage`, and this is the one place in the client where that is right. §13.8 sends
 * *retained buffers* to IndexedDB **on quota grounds** — a large buffer throws against
 * `localStorage`'s ~5 MB and is dropped silently. View state is a few hundred bytes and is
 * re-derivable from nothing worse than a lost scroll position. The two decisions are not in tension;
 * they are about different sizes of thing, and the spec's reasoning for one does not carry to the
 * other.
 *
 * ## Everything read back is untrusted
 *
 * F9.2: *"Restored view state is untrusted input: re-validate every path through §4, discard
 * unknown folder ids, discard corrupt or >256 KB blobs."*
 *
 * The client cannot run §4 — that is a server-side checker over real inodes — so what it does
 * instead is **refuse to construct anything a path could hide in**, and let the server validate
 * whatever survives. A restored path is only ever handed back to `tree.children` or `file.load`,
 * which validate `(rootId, segments)` at the contract boundary like any other request. The checks
 * here exist so that a corrupt blob cannot *become* a request in the first place.
 */

/** The smallest surface of `Storage` this needs. Injected so tests need no browser. */
export interface KeyValueStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export interface ViewState {
  /** The file the editor had open, or `null`. */
  readonly openFile: { readonly rootId: string; readonly segments: readonly string[] } | null
  /** Row keys of the folders that were expanded. Opaque strings — see `tree-model.rowKey`. */
  readonly expanded: readonly string[]
  /**
   * The name this device posts to a chatroom under — §7's viewer identity, §14's message author.
   *
   * **Per-client, like everything else in this file.** §15 already establishes that view state is
   * per-client because *"the user's Mac and their phone are meant to be looking at different things"*,
   * and the same reasoning holds harder here: the name is how a reader tells one voice from
   * another, and syncing it would mean the phone and the Mac could not be told apart in a
   * conversation they both post to.
   *
   * `null` until somebody has posted once, which is when it is asked for.
   */
  readonly viewer: string | null
  /**
   * **A33 — the tab the person was last on.** Annex A33 quotes the PRD's promise: *"last file,
   * active tab, sidebar state, expanded folders."* Three of those four are here; this is the third.
   *
   * **The phone is why it is worth remembering at all.** On the Mac a reload is rare. An installed
   * web app on iOS is suspended and resumed constantly, and every resume dropped the person back on
   * Files however long they had been living on Tasks.
   *
   * **The fourth — "sidebar state" — has no referent in this app and is void rather than owed.**
   * That promise assumed a collapsible sidebar; §18.4 replaced it with two screens on the phone and
   * a fixed sidebar on the desktop, so there is no state to remember. Recorded here rather than left
   * as a gap somebody re-opens.
   *
   * A **name**, not an index. Tabs have been reordered once already, and an index would silently
   * restore a different tab after the next reorder.
   */
  readonly activeTab: string | null
}

/** Long enough for a name, short enough that it is a name — F9.2 treats this as untrusted input. */
export const MAX_VIEWER_NAME = 64

/** The same reasoning, for a tab id. Every real one is under ten characters. */
export const MAX_TAB_NAME = 64

export const EMPTY_VIEW_STATE: ViewState =
  { openFile: null, expanded: [], viewer: null, activeTab: null }

/** F9.2's cap, verbatim. A blob larger than this is discarded unread rather than parsed. */
export const MAX_STATE_BYTES = 256 * 1024

/** One key, so a future second key is a deliberate act rather than an accident. */
const STORAGE_KEY = 'soil-viewer.view-state.v1'

/**
 * A cap on how many expanded folders are remembered.
 *
 * Not arbitrary: every restored key provokes at most one `tree.children` request, so an unbounded
 * set is an unbounded burst of requests at startup — from a value that lives in storage anything
 * with devtools can edit. The tree's own `MAX_VISIBLE_ROWS` bounds what can be *drawn*; this bounds
 * what can be *asked for*.
 */
export const MAX_REMEMBERED_EXPANDED = 500

/**
 * A path segment that could not be a path.
 *
 * The client cannot run §4, so this refuses the shapes that would let a restored string mean
 * something other than one name: empty, a dot-segment, or anything carrying a separator. The
 * contract's own `pathSegment` refuses the same set at the boundary — this is the earlier, cheaper
 * refusal, so a corrupt blob never becomes a request.
 */
function segmentIsSafe(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\u0000')
}

/**
 * Reads the remembered state, discarding anything that is not exactly what it should be.
 *
 * `knownRoots` is the folder ids the server just reported. A remembered file in a folder that has
 * since been deregistered is dropped — F9.2's *"discard unknown folder ids"* — rather than becoming
 * a request for a root that no longer exists.
 */
export function readViewState(
  store: KeyValueStore | undefined,
  knownRoots: readonly string[],
): ViewState {
  if (store === undefined) return EMPTY_VIEW_STATE

  let raw: string | null
  try {
    raw = store.getItem(STORAGE_KEY)
  } catch {
    // Safari throws on `localStorage` access in some privacy modes. A view state that cannot be
    // read is not an error worth showing anyone — it is a session that starts fresh.
    return EMPTY_VIEW_STATE
  }
  if (raw === null) return EMPTY_VIEW_STATE

  // Length before parse. F9.2's cap exists so a large blob is discarded *unread*, and parsing it to
  // find out how big it is would be doing the expensive thing the cap prevents.
  if (raw.length > MAX_STATE_BYTES) {
    try { store.removeItem(STORAGE_KEY) } catch { /* nothing better to do */ }
    return EMPTY_VIEW_STATE
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_VIEW_STATE
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_VIEW_STATE

  const record =
    parsed as { openFile?: unknown; expanded?: unknown; viewer?: unknown; activeTab?: unknown }
  const roots = new Set(knownRoots)

  let openFile: ViewState['openFile'] = null
  const candidate = record.openFile
  if (typeof candidate === 'object' && candidate !== null) {
    const file = candidate as { rootId?: unknown; segments?: unknown }
    if (
      typeof file.rootId === 'string'
      && roots.has(file.rootId)
      && Array.isArray(file.segments)
      && file.segments.length > 0
      && file.segments.every(segmentIsSafe)
    ) {
      openFile = { rootId: file.rootId, segments: [...file.segments] }
    }
  }

  const expanded = Array.isArray(record.expanded)
    ? record.expanded.filter((key): key is string => typeof key === 'string')
      .slice(0, MAX_REMEMBERED_EXPANDED)
    : []

  /**
   * Validated like everything else here, and it earns it: this string is written into the operator's
   * files as a message author, so a value from storage — which anything with devtools can edit —
   * reaching the append route unchecked would put arbitrary text into their tree. The server trims and
   * refuses empty; this refuses the shapes that are not names at all.
   */
  const named = record.viewer
  const viewer = typeof named === 'string'
    && named.trim() !== ''
    && named.length <= MAX_VIEWER_NAME
    && !named.includes('\n')
    ? named.trim()
    : null

  /**
   * **Validated against the tabs that exist, by the caller — not here.** This module has no idea
   * what a tab is, and inventing a list of names in it would be a second place that has to be
   * updated when the tabs change. What it can refuse is the shapes that are not a tab name at all:
   * a non-string, an empty string, and anything long enough to be a payload rather than a label.
   */
  const tab = record.activeTab
  const activeTab = typeof tab === 'string' && tab.length > 0 && tab.length <= MAX_TAB_NAME
    ? tab
    : null

  return { openFile, expanded, viewer, activeTab }
}

/**
 * Writes the state, and **never throws**.
 *
 * A quota failure or a privacy mode that refuses storage must not break the app: the cost is a
 * session that does not remember where it was, which is the state every session started in until
 * this module existed. §13.8 requires a quota failure be a *blocking error* for a retained buffer,
 * because that is an unsaved edit; this is a scroll position.
 */
export function writeViewState(store: KeyValueStore | undefined, state: ViewState): void {
  if (store === undefined) return
  try {
    /**
     * **`viewer` was missing from this object, and the reader has validated it since P7.**
     *
     * Found 2026-08-15 while adding `activeTab` for annex A33. The chatroom name is passed in by the
     * caller, carefully validated on the way back out, and was **never written** — so the name a
     * person posts under was forgotten on every reload, and the elaborate validation on the read
     * path was guarding a key that could not exist.
     *
     * **It went unnoticed because the round-trip test covered the open file and the expansion set
     * and nothing else.** `session-memory.test.ts` had eleven cases; `viewer` appeared in them only
     * as `null` in a fixture, so every one of them passed against a writer that dropped it. A field
     * that is only ever asserted at its default value is not covered — it is present. Both it and
     * `activeTab` now have their own round-trip case.
     *
     * Written explicitly field by field rather than spreading `state`, so a field added to
     * `ViewState` does not silently start persisting — every key on disk is one someone chose.
     */
    store.setItem(STORAGE_KEY, JSON.stringify({
      openFile: state.openFile,
      expanded: state.expanded.slice(0, MAX_REMEMBERED_EXPANDED),
      viewer: state.viewer,
      activeTab: state.activeTab,
    }))
  } catch {
    /* Out of quota, or storage refused. Nothing here is worth interrupting anyone over. */
  }
}
