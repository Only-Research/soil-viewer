/**
 * The overlay contracts — context menus and modals. Annex A8 and A35.
 *
 * Both are geometry-and-keyboard logic with no DOM in them, which is deliberate: these are the
 * behaviours that get "fixed" by eye and then regress the moment a window is a different size or a
 * key arrives in a different order. Pure functions can be handed a hundred viewports and every key
 * sequence in a millisecond.
 */

/* ------------------------------------------------------------------------------------------------
 * A8 — Context menus clamp to the viewport
 * --------------------------------------------------------------------------------------------- */

/** The annex's value: `8px inset, self-measuring`. */
export const VIEWPORT_INSET = 8

export interface Size { readonly width: number; readonly height: number }
export interface Point { readonly x: number; readonly y: number }

/**
 * Places a menu near a point, clamped inside the viewport with the annex's 8px inset.
 *
 * **Self-measuring** is the load-bearing word: the menu's own size is an input, not an assumption.
 * A fixed offset works until a menu has eleven items instead of four, and then the last one is
 * under the edge of the screen where nobody can click it.
 *
 * When a menu is larger than the viewport it is pinned to the inset rather than centred or allowed
 * to overflow. Something has to give, and losing the *bottom* of a menu you can scroll to is better
 * than losing the top, which is where the first item lives.
 */
export function clampToViewport(anchor: Point, menu: Size, viewport: Size): Point {
  const maxX = viewport.width - menu.width - VIEWPORT_INSET
  const maxY = viewport.height - menu.height - VIEWPORT_INSET

  return {
    // `Math.max(inset, …)` last so it wins when the menu is bigger than the viewport: the pin to
    // the top-left inset beats the clamp to a negative maximum.
    x: Math.max(VIEWPORT_INSET, Math.min(anchor.x, maxX)),
    y: Math.max(VIEWPORT_INSET, Math.min(anchor.y, maxY)),
  }
}

/* ------------------------------------------------------------------------------------------------
 * A35 — Modal keyboard contract
 * --------------------------------------------------------------------------------------------- */

/** The annex's value: autofocus at 50ms. */
export const MODAL_AUTOFOCUS_MS = 50

export type ModalOutcome =
  | { readonly kind: 'confirmed'; readonly value: string }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'ignored' }

export interface ModalState {
  readonly value: string
  /** False while the value is empty — A35: "confirm disabled while empty". */
  readonly canConfirm: boolean
}

export interface ModalKey {
  readonly key: string
  /** A modifier means the key belongs to the browser or the OS, not to this contract. */
  readonly withModifier?: boolean
  /** True when the keystroke came from inside a multi-line field. */
  readonly multiline?: boolean
}

/**
 * The whole A35 contract: **Enter confirms, Escape dismisses, confirm is disabled while empty.**
 *
 * Trimmed before the emptiness test, because a name of three spaces is empty in every sense that
 * matters — it produces a file nobody can find and a row that looks blank.
 */
export function modalState(value: string): ModalState {
  return { value, canConfirm: value.trim().length > 0 }
}

export function handleModalKey(state: ModalState, event: ModalKey): ModalOutcome {
  // A modified keystroke is not ours. Cmd-Enter, Ctrl-Escape and friends belong to the browser or
  // to whatever field has focus, and swallowing them makes the modal feel like it has stolen the
  // keyboard.
  if (event.withModifier === true) return { kind: 'ignored' }

  if (event.key === 'Escape') return { kind: 'dismissed' }

  if (event.key === 'Enter') {
    // Enter inside a multi-line field inserts a newline; it does not submit. Confirming here would
    // make it impossible to type a second line, which is a bug that reads as the app being broken.
    if (event.multiline === true) return { kind: 'ignored' }
    // Confirm disabled while empty means Enter does NOTHING while empty — not "confirms with an
    // empty value". A disabled button that the keyboard bypasses is not disabled.
    if (!state.canConfirm) return { kind: 'ignored' }
    return { kind: 'confirmed', value: state.value.trim() }
  }

  return { kind: 'ignored' }
}

/** Backdrop click dismisses, exactly as Escape does — A35 lists them together. */
export function handleBackdropClick(): ModalOutcome {
  return { kind: 'dismissed' }
}

/* ------------------------------------------------------------------------------------------------
 * A34 — Focus ring
 * --------------------------------------------------------------------------------------------- */

/**
 * The focus ring, from the annex verbatim: teal border plus a `0 0 0 2px rgba(91,159,166,0.1)` halo.
 *
 * Exported as values rather than written into a stylesheet by hand so the halo and the border
 * cannot drift apart, and so a test can assert the annex's exact numbers rather than a screenshot.
 */
export const FOCUS_RING = {
  borderColor: '#5b9fa6',
  halo: '0 0 0 2px rgba(91,159,166,0.1)',
} as const
