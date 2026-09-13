import { describe, expect, it } from 'vitest'

import {
  INITIAL_RETREAT,
  RETREAT_AFTER_PX,
  RETURN_AFTER_PX,
  TOP_ZONE_PX,
  reduceRetreat,
  retreatCanRevealAnything,
  type RetreatState,
  type Scroll,
} from '../../src/core/chrome-retreat'

/**
 * §18.2's rule, exercised with scroll sequences rather than by eye.
 *
 * The cases that matter here are the ones a hand cannot produce on purpose: a momentum decay that
 * arrives as forty tiny deltas, a rubber-band that scrolls *up* with no gesture behind it, and a
 * surface that only overflows because the bar is on it. Each of those is a bar that flickers, and a
 * flickering bar reads as a broken app rather than as a tuning problem.
 */

const CHROME = 36

/** A tall surface: 3,000 px of content in a 700 px window. */
const tall = (scrollTop: number, over: Partial<Scroll> = {}): Scroll => ({
  scrollTop,
  scrollHeight: 3_000,
  clientHeight: 700,
  chromeHeight: CHROME,
  overlayOpen: false,
  ...over,
})

/** Feeds a sequence and returns the final state. */
const run = (from: RetreatState, positions: readonly number[], over: Partial<Scroll> = {}): RetreatState =>
  positions.reduce((state, top) => reduceRetreat(state, tall(top, over)), from)

/** Every state the sequence passed through, for the flicker assertions. */
const trace = (from: RetreatState, positions: readonly number[]): readonly string[] => {
  const seen: string[] = []
  positions.reduce((state, top) => {
    const next = reduceRetreat(state, tall(top))
    seen.push(next.chrome)
    return next
  }, from)
  return seen
}

describe('the chrome starts on screen', () => {
  it('is present before anything has scrolled', () => {
    expect(INITIAL_RETREAT.chrome).toBe('present')
  })

  it('stays present inside the top zone', () => {
    expect(run(INITIAL_RETREAT, [0, TOP_ZONE_PX]).chrome).toBe('present')
  })

  it('stays present while rubber-banding above the top, where scrollTop goes negative', () => {
    // iOS produces this with no gesture that means "come back" — but it is not a gesture that
    // means "go away" either, and the top of the content is where the chrome belongs.
    expect(run(INITIAL_RETREAT, [0, -40, -12, 0]).chrome).toBe('present')
  })
})

describe('scrolling down into content', () => {
  // Anchored explicitly rather than scrolled into place. Reaching 200 by scrolling is itself a
  // commitment well past the threshold, so a sequence that walked there would retreat on the way
  // and the nudge under test would never be the thing measured.
  const parkedAt200: RetreatState = { chrome: 'present', at: 200 }

  it('retreats once the reader has committed', () => {
    expect(reduceRetreat(parkedAt200, tall(200 + RETREAT_AFTER_PX)).chrome).toBe('retreated')
  })

  it('does not retreat on a nudge short of the threshold', () => {
    expect(reduceRetreat(parkedAt200, tall(200 + RETREAT_AFTER_PX - 1)).chrome).toBe('present')
  })

  it('retreats exactly once across a long continuous scroll', () => {
    // 0 → 1,200 in 20 px steps. A rule that measured against the previous sample rather than the
    // turning point would be re-deciding on every frame; this asserts it settles.
    const positions = Array.from({ length: 61 }, (_, i) => i * 20)
    const states = trace(INITIAL_RETREAT, positions)
    const flips = states.filter((s, i) => i > 0 && s !== states[i - 1]).length
    expect(flips).toBe(1)
    expect(states.at(-1)).toBe('retreated')
  })

  it('does not flicker while momentum decays in ever-smaller steps', () => {
    // The tail of a flick: still descending, but each step is under the return threshold. Nothing
    // here is an upward movement, so nothing here may bring the bar back.
    const after = run(INITIAL_RETREAT, [0, 300])
    expect(after.chrome).toBe('retreated')
    const decay = [308, 314, 318, 321, 323, 324, 325, 325]
    expect(trace(after, decay).every(s => s === 'retreated')).toBe(true)
  })
})

describe('any upward scroll brings it back', () => {
  it('returns on a small flick from deep in the document, without reaching the top', () => {
    // The clause this is here for: "must not require reaching the top". A bar that only returns at
    // scroll-zero is a bar you cannot reach from the middle of a long document.
    const deep = run(INITIAL_RETREAT, [0, 400, 1_200])
    expect(deep.chrome).toBe('retreated')
    expect(reduceRetreat(deep, tall(1_200 - RETURN_AFTER_PX)).chrome).toBe('present')
  })

  it('measures the flick from the deepest point rather than from where the retreat began', () => {
    // Without the anchor tracking downward, this 6 px flick would be compared against a position
    // 800 px earlier and would never register.
    const deep = run(INITIAL_RETREAT, [0, 400, 600, 900, 1_200])
    expect(reduceRetreat(deep, tall(1_194)).chrome).toBe('present')
  })

  it('ignores an upward movement smaller than the return threshold', () => {
    const deep = run(INITIAL_RETREAT, [0, 400, 1_200])
    expect(reduceRetreat(deep, tall(1_200 - (RETURN_AFTER_PX - 1))).chrome).toBe('retreated')
  })

  it('having returned, retreats again only on a fresh downward commitment', () => {
    const back = run(INITIAL_RETREAT, [0, 400, 1_200, 1_150])
    expect(back.chrome).toBe('present')
    expect(reduceRetreat(back, tall(1_150 + RETREAT_AFTER_PX - 1)).chrome).toBe('present')
    expect(reduceRetreat(back, tall(1_150 + RETREAT_AFTER_PX)).chrome).toBe('retreated')
  })
})

describe('it never hides while a menu, sheet or dialog is open', () => {
  it('stays present through a scroll that would otherwise retreat it', () => {
    expect(run(INITIAL_RETREAT, [0, 200, 400], { overlayOpen: true }).chrome).toBe('present')
  })

  it('comes back the moment an overlay opens over a retreated bar', () => {
    const hidden = run(INITIAL_RETREAT, [0, 400])
    expect(hidden.chrome).toBe('retreated')
    expect(reduceRetreat(hidden, tall(400, { overlayOpen: true })).chrome).toBe('present')
  })

  it('does not retreat on the first scroll after the overlay closes, without a fresh commitment', () => {
    // The anchor moved with the overlay, so closing it does not leave a stale 400 px of "movement"
    // banked up ready to fire.
    const held = run(INITIAL_RETREAT, [0, 400, 600], { overlayOpen: true })
    expect(reduceRetreat(held, tall(600 + RETREAT_AFTER_PX - 1)).chrome).toBe('present')
  })
})

describe('a screen short enough that hiding reveals nothing', () => {
  const shallow = (scrollTop: number, scrollHeight: number): Scroll => ({
    scrollTop,
    scrollHeight,
    clientHeight: 700,
    chromeHeight: CHROME,
    overlayOpen: false,
  })

  it('never retreats when the overflow is no larger than the chrome itself', () => {
    // 700 + 36: the only reason anything is below the fold is the bar. Hide it and the page fits.
    const state = [0, 20, 36].reduce(
      (s, top) => reduceRetreat(s, shallow(top, 700 + CHROME)),
      INITIAL_RETREAT,
    )
    expect(state.chrome).toBe('present')
  })

  it('retreats once the overflow exceeds the chrome by any amount', () => {
    const state = [0, 20, 40].reduce(
      (s, top) => reduceRetreat(s, shallow(top, 700 + CHROME + 1)),
      INITIAL_RETREAT,
    )
    expect(state.chrome).toBe('retreated')
  })

  it('answers the question directly, either way', () => {
    expect(retreatCanRevealAnything(shallow(0, 700 + CHROME))).toBe(false)
    expect(retreatCanRevealAnything(shallow(0, 700 + CHROME + 1))).toBe(true)
  })
})

describe('a reset does not claim to know where the reader is', () => {
  /**
   * **The browser tests found this and these did not, which is the reason it is written down here.**
   *
   * `reset()` runs on every tab change and every screen change. It used to set the anchor to 0 — a
   * statement about the surface, and a false one: leave Files scrolled to 400, switch to Tasks and
   * come back, and the first scroll event measures 400 against 0. Four hundred pixels of movement
   * nobody made, and the chrome goes on the first flick.
   *
   * A reset knows the bars belong on screen. It does not know the scroll position, and `null` is
   * how it says so.
   */
  it('starts with no anchor at all rather than with a claim of zero', () => {
    expect(INITIAL_RETREAT.at).toBeNull()
  })

  it('adopts the first reading after a reset without deciding anything', () => {
    const adopted = reduceRetreat(INITIAL_RETREAT, tall(400))
    expect(adopted.chrome).toBe('present')
    expect(adopted.at).toBe(400)
  })

  it('then retreats only on a real movement from that adopted position', () => {
    const adopted = reduceRetreat(INITIAL_RETREAT, tall(400))
    expect(reduceRetreat(adopted, tall(400 + RETREAT_AFTER_PX - 1)).chrome).toBe('present')
    expect(reduceRetreat(adopted, tall(400 + RETREAT_AFTER_PX)).chrome).toBe('retreated')
  })

  it('survives the round trip that produced the bug: scroll, leave, return, flick', () => {
    const scrolled = run(INITIAL_RETREAT, [0, 200, 400])
    expect(scrolled.chrome).toBe('retreated')
    // Leaving and returning is a reset, and the tree is still sitting at 400.
    const returned = reduceRetreat(INITIAL_RETREAT, tall(400))
    expect(returned.chrome).toBe('present')
    // A small flick either way from there does not hide anything.
    expect(reduceRetreat(returned, tall(405)).chrome).toBe('present')
    expect(reduceRetreat(returned, tall(395)).chrome).toBe('present')
  })
})

describe('measurements nobody can trust', () => {
  it('resolves a non-finite scroll position to present', () => {
    expect(reduceRetreat(INITIAL_RETREAT, tall(Number.NaN)).chrome).toBe('present')
    expect(reduceRetreat({ chrome: 'retreated', at: 400 }, tall(Number.NaN)).chrome).toBe('present')
  })

  it('resolves a non-finite size to present, rather than to a hidden bar', () => {
    // The fail-safe direction: a bar that is wrongly present costs 36 px, a bar that is wrongly
    // hidden is a person who cannot find the way back to the tabs.
    expect(retreatCanRevealAnything(tall(0, { scrollHeight: Number.NaN }))).toBe(false)
    expect(retreatCanRevealAnything(tall(0, { clientHeight: Number.POSITIVE_INFINITY }))).toBe(false)
    expect(retreatCanRevealAnything(tall(0, { chromeHeight: Number.NaN }))).toBe(false)
  })
})
