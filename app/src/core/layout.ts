/**
 * Which layout the app is in. Spec §18.1.
 *
 * **One number, decided in one place.** §18.1: *"No component reads the viewport for itself; the
 * layout mode is decided in one place and read from there. Two components disagreeing about what
 * 'mobile' means is a bug with no single site to fix."*
 *
 * That is not a style preference. The mobile layout is not a skin — it changes which surfaces exist
 * (§18.4's two screens), which gestures are offered (§18.5's absent drag), and where a menu opens
 * (§18.6's sheet). A component that decided for itself could offer a drag on a surface the layout
 * says has none.
 *
 * **No imports, deliberately**, so this is reachable from Core, the client and a test without
 * dragging anything behind it — the same rule `core/limits.ts` follows and for the same reason.
 *
 * **The annex's 900 px minimum viewport is void** — contradiction #5, an iPhone is 390 pt and the
 * PRD never overrode it.
 */

/**
 * The width at which the desktop layout begins. **Below this is mobile; at it and above is desktop.**
 *
 * Stated as the first desktop pixel rather than the last mobile one because that is how a CSS
 * `min-width` query reads, and the CSS and the TypeScript must not disagree about which side 768
 * falls on. An iPad in portrait is 768 pt and gets the desktop layout, which is the intent: it has
 * the room for a tree and a document at once.
 */
export const DESKTOP_MIN_WIDTH_PX = 768

/** The media query the client binds to. Written once, here, so CSS and script cannot drift. */
export const DESKTOP_MEDIA_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH_PX}px)`

export type LayoutMode = 'mobile' | 'desktop'

/**
 * The mode for a given viewport width.
 *
 * A non-finite or negative width resolves to **mobile**, which is the fail-safe direction: the
 * mobile layout offers strictly fewer gestures and hides nothing a person needs, so guessing wrong
 * towards it costs a tap. Guessing wrong towards desktop would offer a drag on a touch screen.
 */
export function layoutModeFor(width: number): LayoutMode {
  if (!Number.isFinite(width)) return 'mobile'
  return width >= DESKTOP_MIN_WIDTH_PX ? 'desktop' : 'mobile'
}
