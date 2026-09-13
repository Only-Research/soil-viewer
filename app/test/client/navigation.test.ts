import { describe, expect, it } from 'vitest'

import { MAX_HISTORY, createNavigation, type Location } from '../../src/client/navigation'

const at = (rootId: string, ...segments: string[]): Location => ({ rootId, segments })
const names = (rootId: string): string => (rootId === 'soil' ? 'notes' : rootId)

describe('tabs', () => {
  it('opens, activates and closes', () => {
    const nav = createNavigation()
    nav.openTab('files')
    nav.openTab('tasks')
    expect(nav.activeTab()).toBe('tasks')
    nav.activate('files')
    expect(nav.activeTab()).toBe('files')
    nav.closeTab('files')
    expect(nav.tabs().map(t => t.id)).toEqual(['tasks'])
  })

  it('activates a remaining tab when the active one closes', () => {
    // A null active tab with tabs still open is a state the UI has to special-case, and every
    // state the UI special-cases is one it eventually gets wrong.
    const nav = createNavigation()
    nav.openTab('a')
    nav.openTab('b')
    nav.closeTab('b')
    expect(nav.activeTab()).toBe('a')
  })

  it('goes to null active only when the last tab closes', () => {
    const nav = createNavigation()
    nav.openTab('only')
    nav.closeTab('only')
    expect(nav.activeTab()).toBeNull()
  })

  it('re-opening an existing tab activates it rather than resetting it', () => {
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('soil', 'a'))
    nav.openTab('tasks')
    nav.openTab('files')
    expect(nav.activeTab()).toBe('files')
    expect(nav.locationOf('files')).toEqual(at('soil', 'a'))
  })
})

describe('history', () => {
  it('walks back and forward', () => {
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('soil'))
    nav.go('files', at('soil', '02-projects'))
    nav.go('files', at('soil', '02-projects', 'field-review'))

    expect(nav.back('files')).toBe(true)
    expect(nav.locationOf('files')).toEqual(at('soil', '02-projects'))
    expect(nav.forward('files')).toBe(true)
    expect(nav.locationOf('files')).toEqual(at('soil', '02-projects', 'field-review'))
  })

  it('reports false rather than throwing at the ends', () => {
    const nav = createNavigation()
    nav.openTab('files')
    expect(nav.back('files')).toBe(false)
    expect(nav.forward('files')).toBe(false)
    nav.go('files', at('soil'))
    expect(nav.forward('files')).toBe(false)
  })

  it('does not record navigating to where you already are', () => {
    // Otherwise clicking the current breadcrumb fills the back stack with copies of one place.
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('soil', 'a'))
    nav.go('files', at('soil', 'a'))
    nav.go('files', at('soil', 'a'))
    expect(nav.tabs()[0]?.back).toHaveLength(0)
  })

  it('discards the forward stack on a new navigation', () => {
    // The branch you had gone back from no longer exists once you take a different one.
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('soil', 'a'))
    nav.go('files', at('soil', 'b'))
    nav.back('files')
    nav.go('files', at('soil', 'c'))
    expect(nav.forward('files')).toBe(false)
  })

  it('is BOUNDED — an ever-growing back stack is a leak in a long-lived app', () => {
    const nav = createNavigation()
    nav.openTab('files')
    for (let i = 0; i < MAX_HISTORY * 3; i++) nav.go('files', at('soil', `f${i}`))
    expect(nav.tabs()[0]?.back.length).toBeLessThanOrEqual(MAX_HISTORY)
  })

  it('drops the OLDEST entry when bounded, so recent history still works', () => {
    const nav = createNavigation()
    nav.openTab('files')
    for (let i = 0; i < MAX_HISTORY + 5; i++) nav.go('files', at('soil', `f${i}`))
    nav.back('files')
    expect(nav.locationOf('files')).toEqual(at('soil', `f${MAX_HISTORY + 3}`))
  })

  it('keeps each tab\'s history separate', () => {
    const nav = createNavigation()
    nav.openTab('a')
    nav.openTab('b')
    nav.go('a', at('soil', 'one'))
    nav.go('b', at('soil', 'two'))
    expect(nav.back('a')).toBe(false)
    expect(nav.locationOf('b')).toEqual(at('soil', 'two'))
  })
})

describe('breadcrumbs — A30/A31', () => {
  it('starts at the folder and walks the segments', () => {
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('soil', '02-projects', 'field-review'))

    expect(nav.crumbs('files', names)).toEqual([
      { label: 'notes', location: at('soil') },
      { label: '02-projects', location: at('soil', '02-projects') },
      { label: 'field-review', location: at('soil', '02-projects', 'field-review') },
    ])
  })

  it('is built from segments and a name lookup, never from a path', () => {
    // Spec §6 keeps absolute paths off the wire, so the client never has one — and a breadcrumb
    // built from a path is how one would leak back into the UI.
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('soil', 'a', 'b'))
    const rendered = JSON.stringify(nav.crumbs('files', names))
    expect(rendered).not.toContain('/Users')
    expect(rendered.startsWith('[{"label":"notes"')).toBe(true)
  })

  it('is empty for a tab with no location', () => {
    const nav = createNavigation()
    nav.openTab('files')
    expect(nav.crumbs('files', names)).toEqual([])
  })

  it('gives the root crumb an empty segment list, not a null', () => {
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('soil', 'a'))
    expect(nav.crumbs('files', names)[0]?.location.segments).toEqual([])
  })
})

describe('forgetting a deregistered folder', () => {
  it('clears the current location that pointed at it', () => {
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('soil', 'a'))
    nav.forgetRoot('soil')
    expect(nav.locationOf('files')).toBeNull()
  })

  it('purges it from the back and forward stacks', () => {
    // Otherwise Back walks into a folder the operator disconnected, and the failure reads as a bug
    // rather than as the intended consequence of disconnecting it.
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('soil', 'a'))
    nav.go('files', at('soil', 'b'))
    nav.go('files', at('other', 'x'))
    nav.back('files')

    nav.forgetRoot('soil')
    const tab = nav.tabs()[0]
    expect(tab?.back.some(l => l.rootId === 'soil')).toBe(false)
    expect(tab?.forward.some(l => l.rootId === 'soil')).toBe(false)
  })

  it('falls back to a surviving location rather than blanking the tab', () => {
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('other', 'kept'))
    nav.go('files', at('soil', 'going'))
    nav.forgetRoot('soil')
    expect(nav.locationOf('files')).toEqual(at('other', 'kept'))
  })

  it('leaves other folders untouched', () => {
    const nav = createNavigation()
    nav.openTab('files')
    nav.go('files', at('other', 'x'))
    nav.forgetRoot('soil')
    expect(nav.locationOf('files')).toEqual(at('other', 'x'))
  })
})

describe('unknown tabs are ignored rather than crashing', () => {
  it('go, back, forward and crumbs all tolerate an unknown id', () => {
    const nav = createNavigation()
    expect(() => nav.go('nope', at('soil'))).not.toThrow()
    expect(nav.back('nope')).toBe(false)
    expect(nav.forward('nope')).toBe(false)
    expect(nav.crumbs('nope', names)).toEqual([])
    expect(nav.locationOf('nope')).toBeNull()
  })
})
