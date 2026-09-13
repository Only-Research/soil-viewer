import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createRowMenus } from '../../src/client/files/row-menu'
import { type ViewportSeam, startLayoutMode } from '../../src/client/layout-mode'
import type { RowAction } from '../../src/client/files/row-actions'
import {
  FakeElement, documentListeners, installFakeDocument, removeFakeDocument,
} from '../support/fake-dom'

/**
 * Spec §18.6 -- **the button stays put and the menu moves.**
 *
 * A dropdown anchored to a `⋯` near the top of a phone screen puts every choice where the thumb is
 * not, and clamping only promises the menu is *on* screen rather than *reachable*.
 *
 * **Scoped to the sheet path deliberately.** The desktop dropdown measures itself and asks the real
 * window for its size, which a fake document cannot answer honestly -- and a stubbed answer would
 * make this a test of the stub. That path is driven end to end in `files-tab.spec.ts`; what is
 * unit-testable here is the branch, which is the thing that was added.
 */

const ACTIONS: readonly RowAction[] = [
  { id: 'rename', label: 'Rename', mutating: true },
  { id: 'move', label: 'Move', mutating: true },
]

/** A viewport whose answer the test chooses. `false` is below 768 px, so: mobile. */
const viewport = (desktop: boolean): ViewportSeam => ({
  matches: () => desktop,
  onChange: () => { /* no rotation in these cases */ },
})

const openOn = (parent: FakeElement): void => {
  createRowMenus(parent as unknown as HTMLElement).open({
    anchor: { x: 40, y: 12 },
    actions: ACTIONS,
    onChoose: () => { /* not the subject here */ },
    subject: 'notes.md',
  })
}

const menuIn = (parent: FakeElement): FakeElement | undefined =>
  parent.children.find(child => (child.getAttribute('class') ?? '').includes('row-menu'))

describe('§18.6 -- on a phone the menu comes up from the bottom edge', () => {
  beforeEach(() => { installFakeDocument() })
  afterEach(() => { removeFakeDocument() })

  it('marks the menu as a sheet below the breakpoint', () => {
    startLayoutMode(viewport(false))
    const parent = new FakeElement('div')
    openOn(parent)

    const menu = menuIn(parent)
    expect(menu, 'the menu was never mounted').toBeDefined()
    expect(menu?.getAttribute('class')).toContain('row-menu-sheet')
  })

  it('gives a sheet NO inline position at all', () => {
    /**
     * Not cosmetic. The dropdown path writes `left`/`top` inline, and an element that carried a
     * stale pair from a previous open would sit half off the screen while still *looking* like a
     * sheet in the markup. Positioning a sheet entirely from the stylesheet is what makes that
     * impossible rather than merely unlikely.
     */
    startLayoutMode(viewport(false))
    const parent = new FakeElement('div')
    openOn(parent)

    expect(menuIn(parent)?.getAttribute('style') ?? null).toBeNull()
  })

  it('does not mark it as a sheet at or above the breakpoint', () => {
    // The control. Without it, a build that made EVERY menu a sheet would pass the case above.
    startLayoutMode(viewport(true))
    const parent = new FakeElement('div')
    // The desktop path measures itself against the real window, which a fake document has not got.
    // What is asserted is the branch: it must not take the sheet route.
    let threw = false
    try { openOn(parent) } catch { threw = true }

    const menu = menuIn(parent)
    const classes = menu?.getAttribute('class') ?? ''
    expect(threw || !classes.includes('row-menu-sheet'), 'desktop took the sheet path').toBe(true)
  })

  it('an ARMED scroll does not dismiss a sheet', async () => {
    /**
     * The scroll rule exists because a dropdown is positioned against a row that a scroll moves out
     * from under it. A sheet is positioned against the bottom edge of the screen, which no scroll
     * moves -- so closing it would dismiss a menu that was still exactly where it belonged, and on
     * a phone the scroll that did it would most likely be a thumb resting on the list behind.
     *
     * **The wait for the arming timer is the entire test, and the first version did not have it.**
     * `armedForScroll` is set in a `setTimeout(…, 0)` so that the focus-scroll which *opening* the
     * menu provokes cannot immediately close it. Firing the scroll synchronously therefore hit an
     * unarmed listener and the menu survived **for the wrong reason** -- a sweep that made a scroll
     * dismiss the sheet stayed green. Caught by that sweep rather than by reading it.
     */
    startLayoutMode(viewport(false))
    const parent = new FakeElement('div')
    openOn(parent)
    expect(menuIn(parent)).toBeDefined()

    await new Promise(resolve => setTimeout(resolve, 0))

    const scroll = documentListeners().find(entry => entry.type === 'scroll')
    expect(scroll, 'nothing listens for scroll').toBeDefined()

    scroll?.handler(new Event('scroll'))
    expect(menuIn(parent), 'the sheet was dismissed by a scroll').toBeDefined()
  })

  it('still closes on Escape, because that is not the anchored-position rule', () => {
    startLayoutMode(viewport(false))
    const parent = new FakeElement('div')
    openOn(parent)

    const keydown = documentListeners().find(entry => entry.type === 'keydown')
    keydown?.handler({ key: 'Escape' } as unknown as Event)
    expect(menuIn(parent), 'Escape left the sheet open').toBeUndefined()
  })
})
