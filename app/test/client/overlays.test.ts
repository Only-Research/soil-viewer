import { describe, expect, it } from 'vitest'

import {
  FOCUS_RING, MODAL_AUTOFOCUS_MS, VIEWPORT_INSET, clampToViewport, handleBackdropClick,
  handleModalKey, modalState,
} from '../../src/client/overlays'

const viewport = { width: 1440, height: 900 }

describe('A8 — context menus clamp to the viewport', () => {
  it('places the menu at the anchor when there is room', () => {
    expect(clampToViewport({ x: 200, y: 300 }, { width: 180, height: 240 }, viewport))
      .toEqual({ x: 200, y: 300 })
  })

  it('pulls the menu back from the right edge, keeping the 8px inset', () => {
    const placed = clampToViewport({ x: 1400, y: 100 }, { width: 180, height: 240 }, viewport)
    // THE LITERAL, not the constant. All nineteen tests in this file scaled off `VIEWPORT_INSET`,
    // so setting it to 0 — deleting the feature — left every one green. Annex A8 says 8px.
    expect(VIEWPORT_INSET, 'annex A8: an 8px inset, self-measuring').toBe(8)
    expect(placed.x).toBe(1440 - 180 - VIEWPORT_INSET)
  })

  it('pulls the menu up from the bottom edge', () => {
    const placed = clampToViewport({ x: 100, y: 880 }, { width: 180, height: 240 }, viewport)
    expect(placed.y).toBe(900 - 240 - VIEWPORT_INSET)
  })

  it('is SELF-MEASURING — a taller menu is pulled up further', () => {
    // The load-bearing word in the annex. A fixed offset works until a menu has eleven items
    // instead of four, and then the last one sits under the edge where nobody can click it.
    const short = clampToViewport({ x: 100, y: 880 }, { width: 180, height: 120 }, viewport)
    const tall = clampToViewport({ x: 100, y: 880 }, { width: 180, height: 400 }, viewport)
    expect(tall.y).toBeLessThan(short.y)
  })

  it('never places the menu past the inset on the top or left', () => {
    const placed = clampToViewport({ x: -50, y: -50 }, { width: 180, height: 240 }, viewport)
    expect(placed).toEqual({ x: VIEWPORT_INSET, y: VIEWPORT_INSET })
  })

  it('pins a menu LARGER than the viewport to the top-left rather than centring or overflowing', () => {
    // Something has to give. Losing the bottom of a menu you can scroll to beats losing the top,
    // which is where the first item lives.
    const placed = clampToViewport({ x: 400, y: 400 }, { width: 2000, height: 2000 }, viewport)
    expect(placed).toEqual({ x: VIEWPORT_INSET, y: VIEWPORT_INSET })
  })

  it('handles a phone-sized viewport', () => {
    const phone = { width: 390, height: 844 }
    const placed = clampToViewport({ x: 380, y: 800 }, { width: 200, height: 300 }, phone)
    expect(placed.x).toBe(390 - 200 - VIEWPORT_INSET)
    expect(placed.y).toBe(844 - 300 - VIEWPORT_INSET)
    expect(placed.x).toBeGreaterThanOrEqual(VIEWPORT_INSET)
  })

  it('keeps the whole menu on screen for every corner', () => {
    const menu = { width: 220, height: 260 }
    for (const anchor of [
      { x: 0, y: 0 }, { x: 1440, y: 0 }, { x: 0, y: 900 }, { x: 1440, y: 900 },
    ]) {
      const placed = clampToViewport(anchor, menu, viewport)
      expect(placed.x).toBeGreaterThanOrEqual(VIEWPORT_INSET)
      expect(placed.y).toBeGreaterThanOrEqual(VIEWPORT_INSET)
      expect(placed.x + menu.width).toBeLessThanOrEqual(viewport.width - VIEWPORT_INSET)
      expect(placed.y + menu.height).toBeLessThanOrEqual(viewport.height - VIEWPORT_INSET)
    }
  })
})

describe('A35 — the modal keyboard contract', () => {
  it('disables confirm while empty, including whitespace-only', () => {
    // A name of three spaces is empty in every sense that matters: it produces a file nobody can
    // find and a row that looks blank.
    expect(modalState('').canConfirm).toBe(false)
    expect(modalState('   ').canConfirm).toBe(false)
    expect(modalState('\t\n').canConfirm).toBe(false)
    expect(modalState('notes').canConfirm).toBe(true)
  })

  it('Enter confirms with the trimmed value', () => {
    const outcome = handleModalKey(modalState('  notes.md  '), { key: 'Enter' })
    expect(outcome).toEqual({ kind: 'confirmed', value: 'notes.md' })
  })

  it('ENTER DOES NOTHING WHILE EMPTY — a disabled button the keyboard bypasses is not disabled', () => {
    expect(handleModalKey(modalState(''), { key: 'Enter' })).toEqual({ kind: 'ignored' })
    expect(handleModalKey(modalState('   '), { key: 'Enter' })).toEqual({ kind: 'ignored' })
  })

  it('Escape dismisses, empty or not', () => {
    expect(handleModalKey(modalState(''), { key: 'Escape' })).toEqual({ kind: 'dismissed' })
    expect(handleModalKey(modalState('notes'), { key: 'Escape' })).toEqual({ kind: 'dismissed' })
  })

  it('a backdrop click dismisses, exactly as Escape does', () => {
    expect(handleBackdropClick()).toEqual({ kind: 'dismissed' })
  })

  it('Enter inside a MULTILINE field inserts a newline rather than submitting', () => {
    // Confirming here makes it impossible to type a second line — a bug that reads as the app
    // being broken rather than as a keyboard decision.
    expect(handleModalKey(modalState('line one'), { key: 'Enter', multiline: true }))
      .toEqual({ kind: 'ignored' })
  })

  it('ignores a MODIFIED keystroke — the modal must not steal the keyboard', () => {
    // Cmd-Enter, Ctrl-Escape and friends belong to the browser or to the focused field. Swallowing
    // them makes the modal feel like it has taken over.
    expect(handleModalKey(modalState('notes'), { key: 'Enter', withModifier: true }))
      .toEqual({ kind: 'ignored' })
    expect(handleModalKey(modalState('notes'), { key: 'Escape', withModifier: true }))
      .toEqual({ kind: 'ignored' })
  })

  it('ignores every other key', () => {
    for (const key of ['a', 'Tab', 'ArrowDown', ' ', 'F5']) {
      expect(handleModalKey(modalState('notes'), { key }), key).toEqual({ kind: 'ignored' })
    }
  })

  it('autofocuses at the annex\'s 50ms', () => {
    expect(MODAL_AUTOFOCUS_MS).toBe(50)
  })
})

describe('A34 — the focus ring', () => {
  it('is the annex value verbatim', () => {
    // Asserted as exact numbers rather than by screenshot, so the halo and the border cannot drift
    // apart and a "small improvement" to either shows up as a failure.
    expect(FOCUS_RING.borderColor).toBe('#5b9fa6')
    expect(FOCUS_RING.halo).toBe('0 0 0 2px rgba(91,159,166,0.1)')
  })

  it('uses the same teal as the accent token', () => {
    expect(FOCUS_RING.borderColor).toBe('#5b9fa6')
    expect(FOCUS_RING.halo).toContain('91,159,166')
  })
})
