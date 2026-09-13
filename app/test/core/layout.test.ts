import { describe, expect, it } from 'vitest'

import { DESKTOP_MEDIA_QUERY, DESKTOP_MIN_WIDTH_PX, layoutModeFor } from '../../src/core/layout'

/**
 * Spec §18.1. The boundary is the whole content of this module, so the tests are about the boundary
 * and about the one thing a reader could get wrong: which side of 768 is which.
 */
describe('layoutModeFor -- one number, and 768 belongs to the desktop', () => {
  it('places the breakpoint pixel itself on the desktop side', () => {
    // The off-by-one that a CSS min-width query and a JS comparison drift apart on. Asserted at the
    // exact pixel rather than at 400 and 1200, which would pass under either reading.
    expect(layoutModeFor(DESKTOP_MIN_WIDTH_PX - 1)).toBe('mobile')
    expect(layoutModeFor(DESKTOP_MIN_WIDTH_PX)).toBe('desktop')
  })

  it('calls a phone mobile and a laptop desktop', () => {
    expect(layoutModeFor(390)).toBe('mobile')   // iPhone, the target
    expect(layoutModeFor(767)).toBe('mobile')
    expect(layoutModeFor(1440)).toBe('desktop')
  })

  it('fails towards mobile on a width it cannot read', () => {
    // The fail-safe direction, and the reason is asymmetric: mobile offers strictly fewer gestures,
    // so guessing wrong towards it costs a tap. Guessing wrong towards desktop would offer a drag
    // on a touch screen -- and §18.5 removed that gesture because a mis-drag moves a real file.
    expect(layoutModeFor(Number.NaN)).toBe('mobile')
    expect(layoutModeFor(Number.POSITIVE_INFINITY)).toBe('mobile')
    expect(layoutModeFor(-1)).toBe('mobile')
    expect(layoutModeFor(0)).toBe('mobile')
  })

  it('the media query is BUILT from the constant, so CSS and script cannot drift', () => {
    // The failure this forecloses: the number edited in one place and left in the other. Asserted
    // by construction rather than by comparing two literals, which would drift identically.
    expect(DESKTOP_MEDIA_QUERY).toBe(`(min-width: ${DESKTOP_MIN_WIDTH_PX}px)`)
    expect(DESKTOP_MEDIA_QUERY).toContain('min-width')
  })
})
