/**
 * Wires §18.2's rule to real scrolling surfaces. The decision itself lives in
 * `core/chrome-retreat.ts`; this module only measures, asks, and publishes.
 *
 * **The split is the same one `layout-mode.ts` makes and for the same reason.** What is hard here
 * is not attaching a listener, it is the rule — and a rule embedded in an event handler can only be
 * tested by producing scroll events, which means a browser, which means it is tested at the density
 * a browser test can afford rather than at the density the rule needs.
 *
 * **The state is published as `data-chrome` on the root element**, exactly as the layout mode is, so
 * CSS moves the bars and nothing else has to know. There is no second path and no component decides
 * for itself whether it is hidden — §18.1's rule, applied to the other attribute.
 */

import {
  INITIAL_RETREAT,
  reduceRetreat,
  type ChromeState,
  type RetreatState,
} from '../core/chrome-retreat'
import { onDocument, setRootAttribute } from './dom'

export const CHROME_ATTRIBUTE = 'data-chrome'

/**
 * What a scrolling surface has to be able to tell us. An interface rather than `HTMLElement` so a
 * test can hand this a plain object, and so nothing here can reach for a DOM API by accident.
 */
export interface ScrollSurface {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/**
 * The seam. **A single listener on the document, at capture, rather than one per scroll container.**
 *
 * `scroll` does not bubble, so the usual instinct is to enumerate the scrolling elements and bind
 * each — and that is the arrangement this build has been bitten by repeatedly: a control wired to a
 * list, a new member arriving later, and nothing anywhere reporting the omission. §18.2 says *"one
 * mechanic, everywhere"*, and a list of three selectors is a mechanic in three places that happens
 * to agree today. The capture phase reaches a non-bubbling event on any element, so a surface added
 * next month is covered by construction rather than by remembering.
 *
 * The over-reach that buys is real and bounded: a menu scrolling its own items also arrives here.
 * That is precisely what §18.2's overlay clause refuses, so it is answered by the rule rather than
 * by the plumbing.
 */
export interface ScrollSeam {
  readonly onScroll: (listener: (surface: ScrollSurface) => void) => void
}

function documentScroll(): ScrollSeam {
  return {
    onScroll: listener => {
      onDocument(
        'scroll',
        event => {
          const target = event.target
          // `document` itself fires this when the page scrolls, and it has no scroll geometry.
          if (!(target instanceof Element)) return
          listener(target)
        },
        // `capture` is what reaches a non-bubbling event; `passive` keeps the browser from waiting
        // on this handler before it paints the next frame of a scroll.
        { capture: true, passive: true },
      )
    },
  }
}

export interface ChromeRetreatOptions {
  /**
   * Whether a menu, sheet or dialog is open. §18.2 forbids retreating while one is.
   *
   * A callback rather than a flag because the answer is a DOM question the shell already knows how
   * to ask — `main.tsx` has asked a narrower version as `blockedByOverlay` since P7 — and repeating
   * the selector list here would give the app two answers to one question.
   */
  readonly overlayOpen: () => boolean
  /** The height retreating would give back. Measured, not assumed: it differs by layout. */
  readonly chromeHeight: () => number
  /** §18.2 is a phone rule. Above the breakpoint the bars stay put. */
  readonly isMobile: () => boolean
  readonly seam?: ScrollSeam
}

export interface ChromeRetreat {
  /**
   * Puts the chrome back and forgets where the reader was.
   *
   * **Called on every tab change and every screen change, and that is not housekeeping.** The
   * anchor is a position on the surface being scrolled; carrying it across to a different surface
   * compares a scroll position in the Tasks board against one in the file tree, which is a number
   * with no meaning. The visible symptom would be a bar that hides the instant you arrive.
   */
  readonly reset: () => void
  /** For tests, and for callers that need to know without reading the DOM. */
  readonly state: () => ChromeState
}

export function startChromeRetreat(options: ChromeRetreatOptions): ChromeRetreat {
  let state: RetreatState = INITIAL_RETREAT

  const publish = (): void => { setRootAttribute(CHROME_ATTRIBUTE, state.chrome) }

  const reset = (): void => {
    state = INITIAL_RETREAT
    publish()
  }

  const seam = options.seam ?? documentScroll()

  seam.onScroll(surface => {
    // Desktop keeps its chrome. Checked per event rather than at bind time, because the layout can
    // change under a bound listener — a phone rotating into landscape is 844 px and crosses the
    // breakpoint, and a listener that decided at boot would carry a phone rule onto a desktop
    // layout with nothing to say so.
    if (!options.isMobile()) {
      if (state.chrome !== 'present') reset()
      return
    }

    state = reduceRetreat(state, {
      scrollTop: surface.scrollTop,
      scrollHeight: surface.scrollHeight,
      clientHeight: surface.clientHeight,
      chromeHeight: options.chromeHeight(),
      overlayOpen: options.overlayOpen(),
    })
    publish()
  })

  publish()

  return { reset, state: () => state.chrome }
}
