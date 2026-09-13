/**
 * The one place that decides whether the app is in its mobile or desktop layout. Spec §18.1.
 *
 * **The decision is published as an attribute on the root element**, `data-layout="mobile"` or
 * `"desktop"`, and everything else reads that — CSS through an attribute selector, script through
 * `currentMode()`. There is deliberately no second path: a component calling `matchMedia` for itself
 * is the drift §18.1 forbids, and it would be invisible until the two disagreed.
 *
 * **Why an attribute rather than only a media query.** CSS alone would be enough for *appearance*,
 * and appearance is not what changes here. §18.4 makes Files two screens instead of one, §18.5
 * removes a gesture, §18.6 moves where a menu opens. Those are decisions script has to make, and a
 * media query that only CSS can see would leave script guessing at the viewport separately.
 *
 * **The listener is bound once and never removed**, which is correct rather than lazy: this is the
 * app shell, it lives as long as the document, and a layout mode that stopped tracking the viewport
 * would strand a rotated phone in the wrong layout with nothing to say so.
 */

import { DESKTOP_MEDIA_QUERY, type LayoutMode, layoutModeFor } from '../core/layout'
import { setRootAttribute } from './dom'

export const LAYOUT_ATTRIBUTE = 'data-layout'

type Listener = (mode: LayoutMode) => void

const listeners = new Set<Listener>()
let mode: LayoutMode = 'mobile'

/**
 * The seam. Named rather than inlined so a test can drive a layout change without a real viewport,
 * and so the fallback below has somewhere honest to live.
 */
export interface ViewportSeam {
  readonly matches: () => boolean
  readonly onChange: (listener: () => void) => void
}

/**
 * The browser's own answer.
 *
 * **`addEventListener` on the MediaQueryList, not the deprecated `addListener`** — but the fallback
 * is kept because Safari carried the old name alone for years and this app's whole point is being
 * used from the user's phone. A layout that silently stopped responding to rotation on the one
 * browser that matters would look like a rendering bug, not a missing API.
 */
function browserViewport(): ViewportSeam {
  const query = window.matchMedia(DESKTOP_MEDIA_QUERY)
  return {
    matches: () => query.matches,
    onChange: (listener) => {
      if (typeof query.addEventListener === 'function') query.addEventListener('change', listener)
      else if (typeof query.addListener === 'function') query.addListener(listener)
    },
  }
}

/** The mode right now. Never derived by the caller — §18.1's single site. */
export function currentMode(): LayoutMode {
  return mode
}

export function isMobile(): boolean {
  return mode === 'mobile'
}

/**
 * Run when the layout mode *changes*, not when it is merely re-evaluated.
 *
 * Subscribing does not fire immediately: a caller that needs the current mode has `currentMode()`,
 * and a listener that also fired on subscribe would run before the caller finished building the
 * thing it was about to update.
 */
export function onLayoutChange(listener: Listener): void {
  listeners.add(listener)
}

/**
 * Bind the layout mode to the viewport and publish it. Call once, at boot, before anything reads it.
 *
 * Returns the mode it settled on, so the caller need not immediately ask again.
 */
export function startLayoutMode(seam: ViewportSeam = browserViewport()): LayoutMode {
  const settle = (): void => {
    const next: LayoutMode = seam.matches() ? 'desktop' : 'mobile'
    if (next === mode) return
    mode = next
    publish()
    for (const listener of listeners) listener(next)
  }

  mode = seam.matches() ? 'desktop' : 'mobile'
  publish()
  seam.onChange(settle)
  return mode
}

function publish(): void {
  setRootAttribute(LAYOUT_ATTRIBUTE, mode)
}

/**
 * The width-based answer, for the one caller that has a width rather than a media query.
 *
 * Re-exported rather than re-derived, so there is no second definition of where 768 falls.
 */
export { layoutModeFor }
