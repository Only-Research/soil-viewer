/**
 * When the chrome retreats and when it comes back. Spec §18.2.
 *
 * > *"Every persistent bar on the phone hides when you scroll down into content and returns the
 * > moment you scroll up. One mechanic, everywhere."* — ruled 2026-08-13: *"I don't love a
 * > persistent anything on an app these days if we can help it."*
 *
 * **Pure, and in Core, for the same reason `overlays.ts` is pure geometry.** This is exactly the
 * class of behaviour that gets tuned by eye on one device and regresses on the next: a threshold
 * that feels right on a long document flickers on a short one, and a rule that works scrolling with
 * a thumb misbehaves under momentum. A function that takes scroll positions can be handed a
 * thousand of them in a millisecond, including the ones a human cannot produce on purpose.
 *
 * **Reachable from `src/client`, so it may use only what both runtimes have** — no `node:*`, no
 * `Buffer`, no `process`. `conventions/sandbox-and-verification.md` records why that constraint is
 * invisible to the unit suite and has to be held by hand.
 */

/** Present means the bars are on screen. Retreated means they are off it. */
export type ChromeState = 'present' | 'retreated'

/**
 * One reading of a scrolling surface.
 *
 * `chromeHeight` is an input rather than a constant because it is what makes "reveals nothing"
 * decidable — see `retreatCanRevealAnything` — and because the phone's chrome is not the desktop's.
 */
export interface Scroll {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly chromeHeight: number
  /** §18.2: *"It never hides while a menu, sheet or dialog is open."* */
  readonly overlayOpen: boolean
}

/**
 * `at` is the anchor the next movement is measured from — the turning point of the current run,
 * not the previous sample. Measuring against the previous sample would make the thresholds below
 * depend on how often the browser fires `scroll`, which differs between a thumb flick and a
 * momentum decay, and would make the same gesture behave differently on the same device.
 *
 * **`null` means "no anchor yet — adopt the next reading and decide nothing".** That state exists
 * because of a bug the browser tests found and these unit tests did not: `reset()` used to set the
 * anchor to **0**, which is a claim about the surface, and it was false. Leave the Files tab
 * scrolled to 400, come back, and the first scroll event measures 400 against 0 — four hundred
 * pixels of movement that nobody made — and the chrome vanishes on the first flick. A reset knows
 * the bars should be present; it does not know where the reader is, and pretending otherwise put a
 * fabricated gesture into the rule.
 */
export interface RetreatState {
  readonly chrome: ChromeState
  readonly at: number | null
}

export const INITIAL_RETREAT: RetreatState = { chrome: 'present', at: null }

/**
 * How far down you must commit before the chrome goes.
 *
 * Large enough that a tap that nudges the page, or the settling of a momentum scroll, does not
 * count as "scrolling down into content".
 */
export const RETREAT_AFTER_PX = 24

/**
 * How far up brings it back. §18.2: *"Returning must be immediate and must not require reaching the
 * top. Any upward scroll brings the chrome back."*
 *
 * Four pixels rather than zero, and the distinction is worth stating because zero looks more
 * faithful to that sentence and is not. iOS rubber-banding at the bottom of a document produces a
 * genuine upward delta with no upward gesture behind it; at zero the bar reappears every time a
 * scroll settles against the end of the content. Four pixels is below the threshold of an
 * intentional movement, so it is still "any upward scroll" to the hand, and it is above the noise.
 */
export const RETURN_AFTER_PX = 4

/**
 * The band at the top of the content where the chrome is unconditionally present.
 *
 * Also the guard for a negative `scrollTop`, which iOS produces while rubber-banding past the top.
 */
export const TOP_ZONE_PX = 8

/**
 * §18.2: *"it never hides on a screen short enough that hiding it reveals nothing."*
 *
 * **The precise reading, and it is sharper than a magic minimum.** Retreating gains exactly
 * `chromeHeight` of room. If the surface cannot scroll further than that, then the only reason
 * there is anything below the fold **is the chrome itself** — hide it and the content fits. So the
 * scroll that would trigger the hide is an artifact of the bar's own presence, and the bar would
 * spend its life flickering out and back over a few pixels of overflow it created.
 *
 * A non-finite measurement resolves to "no", which is the fail-safe direction: the failure of a
 * hidden bar is that a person cannot find their way back to the tabs, and the failure of a present
 * one is that it takes up 36 px.
 */
export function retreatCanRevealAnything(scroll: Scroll): boolean {
  const { scrollHeight, clientHeight, chromeHeight } = scroll
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return false
  if (!Number.isFinite(chromeHeight)) return false
  return scrollHeight - clientHeight > chromeHeight
}

/**
 * The next state, given the last one and a fresh reading.
 *
 * The order of the three overrides is the order §18.2 states them in, and it is load-bearing: an
 * open sheet wins over everything, including a scroll that would otherwise retreat, because a sheet
 * that scrolls its own content must not take the chrome with it.
 */
export function reduceRetreat(state: RetreatState, scroll: Scroll): RetreatState {
  const { scrollTop } = scroll

  // A measurement nobody can trust resolves to present, for the reason above.
  if (!Number.isFinite(scrollTop)) return { chrome: 'present', at: state.at }

  if (scroll.overlayOpen) return { chrome: 'present', at: scrollTop }
  if (!retreatCanRevealAnything(scroll)) return { chrome: 'present', at: scrollTop }
  if (scrollTop <= TOP_ZONE_PX) return { chrome: 'present', at: scrollTop }

  // No anchor yet: this reading establishes one and decides nothing. See `RetreatState`.
  if (state.at === null) return { chrome: 'present', at: scrollTop }

  const moved = scrollTop - state.at

  if (state.chrome === 'present') {
    if (moved >= RETREAT_AFTER_PX) return { chrome: 'retreated', at: scrollTop }
    // Still present. If this reading is *above* the anchor, the anchor becomes the new high-water
    // mark, so a later downward run is measured from where it actually began rather than from a
    // point the reader has since scrolled past.
    return { chrome: 'present', at: moved < 0 ? scrollTop : state.at }
  }

  if (-moved >= RETURN_AFTER_PX) return { chrome: 'present', at: scrollTop }
  // Still retreated, and still descending: track the deepest point, so that after a long scroll a
  // small upward flick is measured from where the reader stopped rather than from the top.
  return { chrome: 'retreated', at: moved > 0 ? scrollTop : state.at }
}
