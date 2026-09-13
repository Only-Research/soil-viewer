/**
 * Navigation state and the breadcrumb strip. Annex A30/A31.
 *
 * A state machine rather than a pile of variables, because the bugs here are all *transition* bugs:
 * a breadcrumb that still shows the old folder, a back stack that grows forever, a tab whose
 * location survives the folder being deregistered.
 *
 * **View state is per-client and this is view state** (spec §15). Which file is open, which tab is
 * active, where the sidebar is — none of it is server truth, and none of it belongs in a file.
 * *"Live everywhere means the files are live, not the cursor."*
 */

export type TabId = string

export interface Location {
  readonly rootId: string
  readonly segments: readonly string[]
}

export interface Crumb {
  readonly label: string
  /** Where clicking it goes. The root crumb has an empty segment list, not a null. */
  readonly location: Location
}

export interface TabLocation {
  readonly id: TabId
  readonly location: Location | null
  /** Bounded — see MAX_HISTORY. */
  readonly back: readonly Location[]
  readonly forward: readonly Location[]
}

/**
 * How far back a tab remembers.
 *
 * Bounded because an unbounded array that only ever grows is a leak in a long-lived app, and this
 * one grows on every click. Fifty is well past what anyone uses and small enough to be free.
 */
export const MAX_HISTORY = 50

export interface Navigation {
  readonly tabs: () => readonly TabLocation[]
  readonly activeTab: () => TabId | null
  readonly openTab: (id: TabId) => void
  readonly closeTab: (id: TabId) => void
  readonly activate: (id: TabId) => void
  readonly go: (id: TabId, location: Location) => void
  readonly back: (id: TabId) => boolean
  readonly forward: (id: TabId) => boolean
  readonly locationOf: (id: TabId) => Location | null
  readonly crumbs: (id: TabId, rootName: (rootId: string) => string) => Crumb[]
  /** Drops every reference to a folder. Called when one is deregistered. */
  readonly forgetRoot: (rootId: string) => void
}

const sameLocation = (a: Location | null, b: Location | null): boolean => {
  if (a === null || b === null) return a === b
  return a.rootId === b.rootId
    && a.segments.length === b.segments.length
    && a.segments.every((s, i) => s === b.segments[i])
}

export function createNavigation(): Navigation {
  const tabs = new Map<TabId, { location: Location | null; back: Location[]; forward: Location[] }>()
  let active: TabId | null = null

  // Named `tabFor`, not `require`. The first draft called it `require` and the shell-injection ban
  // fired on every call — correctly. Shadowing `require` inside a `type: module` package is
  // confusing to a reader and indistinguishable from the real thing to a linter, and the rule is
  // right to be suspicious of both. Second time a security rule has caught ordinary code of mine
  // and been right; the answer is to say what is meant, not to exempt it.
  const tabFor = (id: TabId): { location: Location | null; back: Location[]; forward: Location[] } | undefined =>
    tabs.get(id)

  return {
    tabs: () => [...tabs.entries()].map(([id, t]) => ({
      id, location: t.location, back: [...t.back], forward: [...t.forward],
    })),

    activeTab: () => active,

    openTab: id => {
      if (tabs.has(id)) { active = id; return }
      tabs.set(id, { location: null, back: [], forward: [] })
      active = id
    },

    closeTab: id => {
      if (!tabs.delete(id)) return
      if (active === id) {
        // Activating the next remaining tab rather than leaving `active` dangling. A null active
        // tab with tabs still open is a state the UI has to special-case, and every state the UI
        // special-cases is one it eventually gets wrong.
        active = [...tabs.keys()][0] ?? null
      }
    },

    activate: id => { if (tabs.has(id)) active = id },

    go: (id, location) => {
      const tab = tabFor(id)
      if (tab === undefined) return
      // Navigating to where you already are is not a history entry. Otherwise clicking the current
      // breadcrumb fills the back stack with copies of the same place.
      if (sameLocation(tab.location, location)) return

      if (tab.location !== null) {
        tab.back.push(tab.location)
        if (tab.back.length > MAX_HISTORY) tab.back.shift()
      }
      // A new navigation discards the forward stack — the branch you had gone back from no longer
      // exists once you take a different one.
      tab.forward = []
      tab.location = location
    },

    back: id => {
      const tab = tabFor(id)
      const previous = tab?.back.pop()
      if (tab === undefined || previous === undefined) return false
      if (tab.location !== null) tab.forward.push(tab.location)
      tab.location = previous
      return true
    },

    forward: id => {
      const tab = tabFor(id)
      const next = tab?.forward.pop()
      if (tab === undefined || next === undefined) return false
      if (tab.location !== null) tab.back.push(tab.location)
      tab.location = next
      return true
    },

    locationOf: id => tabFor(id)?.location ?? null,

    /**
     * The breadcrumb strip. The first crumb is the folder itself; the rest are its segments.
     *
     * The label comes from `rootName`, a lookup the caller supplies, rather than from anything on
     * the location. Spec §6 keeps absolute paths off the wire, so the client never has one to
     * render — and a breadcrumb built from a path is how one would leak back into the UI.
     */
    crumbs: (id, rootName) => {
      const location = tabFor(id)?.location
      if (location === undefined || location === null) return []

      const out: Crumb[] = [{
        label: rootName(location.rootId),
        location: { rootId: location.rootId, segments: [] },
      }]
      for (let i = 0; i < location.segments.length; i++) {
        const segment = location.segments[i]
        if (segment === undefined) continue
        out.push({
          label: segment,
          location: { rootId: location.rootId, segments: location.segments.slice(0, i + 1) },
        })
      }
      return out
    },

    forgetRoot: rootId => {
      // A deregistered folder must not survive in a back stack. Otherwise Back walks into a folder
      // the operator disconnected, and the request fails in a way that reads as a bug rather than as
      // the intended consequence of disconnecting it.
      for (const tab of tabs.values()) {
        tab.back = tab.back.filter(l => l.rootId !== rootId)
        tab.forward = tab.forward.filter(l => l.rootId !== rootId)
        if (tab.location?.rootId === rootId) tab.location = tab.back.pop() ?? null
      }
    },
  }
}
