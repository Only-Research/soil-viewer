import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LAYOUT_ATTRIBUTE, type ViewportSeam, currentMode, isMobile, onLayoutChange, startLayoutMode,
} from '../../src/client/layout-mode'
import { installFakeDocument, removeFakeDocument } from '../support/fake-dom'

/**
 * Spec §18.1 -- the layout mode, and the property that matters is not "it reads a media query" but
 * **"everything reads the same answer."** The attribute on the root is that shared answer; a test
 * that only checked `currentMode()` would pass on a build where CSS saw something else.
 */

/** A viewport under the test's control. `set` moves it and fires the change, as a real one does. */
function fakeViewport(desktop: boolean): ViewportSeam & { set: (next: boolean) => void } {
  let matches = desktop
  let onChange: (() => void) | null = null
  return {
    matches: () => matches,
    onChange: (listener) => { onChange = listener },
    set: (next: boolean) => { matches = next; onChange?.() },
  }
}

const publishedMode = (): string | null =>
  document.documentElement.getAttribute(LAYOUT_ATTRIBUTE)

describe('the layout mode is decided once and published where everything can read it', () => {
  beforeEach(() => { installFakeDocument() })
  afterEach(() => { removeFakeDocument() })

  it('publishes the mode to the root element, not only to its own callers', () => {
    startLayoutMode(fakeViewport(false))
    expect(currentMode()).toBe('mobile')
    expect(publishedMode()).toBe('mobile')
  })

  it('publishes desktop when the viewport is wide', () => {
    startLayoutMode(fakeViewport(true))
    expect(currentMode()).toBe('desktop')
    expect(publishedMode()).toBe('desktop')
  })

  it('returns the settled mode, so the caller need not ask again', () => {
    expect(startLayoutMode(fakeViewport(true))).toBe('desktop')
    expect(startLayoutMode(fakeViewport(false))).toBe('mobile')
  })

  it('follows the viewport when the phone is rotated, and republishes', () => {
    const viewport = fakeViewport(false)
    startLayoutMode(viewport)
    expect(publishedMode()).toBe('mobile')

    viewport.set(true)
    expect(currentMode()).toBe('desktop')
    expect(publishedMode()).toBe('desktop')
    expect(isMobile()).toBe(false)

    viewport.set(false)
    expect(currentMode()).toBe('mobile')
    expect(publishedMode()).toBe('mobile')
  })

  it('tells its listeners, but only when the answer actually changed', () => {
    /**
     * The redraw this guards. §18.4 rebuilds Files as two screens on a layout change; a listener
     * that fired on every re-evaluation would tear down and rebuild the pane on any resize event
     * the browser felt like emitting -- losing scroll position, which §18.4 makes a requirement.
     */
    const viewport = fakeViewport(false)
    const seen: string[] = []
    onLayoutChange(mode => seen.push(mode))
    startLayoutMode(viewport)

    viewport.set(false)          // same answer, re-evaluated
    expect(seen).toEqual([])

    viewport.set(true)
    expect(seen).toEqual(['desktop'])

    viewport.set(true)           // same answer again
    expect(seen).toEqual(['desktop'])

    viewport.set(false)
    expect(seen).toEqual(['desktop', 'mobile'])
  })

  it('binds to a MediaQueryList that only carries the deprecated addListener', () => {
    /**
     * Safari carried `addListener` alone for years, and this app's whole point is being used from
     * the user's phone. A binding that silently stopped responding to rotation on the one browser
     * that matters would read as a rendering bug rather than a missing API.
     */
    let registered: (() => void) | null = null
    const legacy = {
      matches: false,
      addListener: (listener: () => void) => { registered = listener },
    } as unknown as MediaQueryList

    const seam: ViewportSeam = {
      matches: () => legacy.matches,
      onChange: (listener) => {
        if (typeof legacy.addEventListener === 'function') legacy.addEventListener('change', listener)
        else if (typeof legacy.addListener === 'function') legacy.addListener(listener)
      },
    }

    startLayoutMode(seam)
    expect(registered).not.toBeNull()
  })
})
