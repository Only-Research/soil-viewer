import { describe, expect, it } from 'vitest'

import { MONOGRAM_SLOTS, monogramFor } from '../../src/core/monogram'

/**
 * **The monogram rules, without a browser.** Packet §4.7.
 *
 * Every case here is a real folder shape from the soil or a real filesystem allowance, not a
 * hypothetical: numbered grammar folders, hyphenated project names, a name that is only digits, a
 * name with no letters at all.
 */

describe('initials', () => {
  it('drops the soil\'s numeric grammar prefix, which says nothing about the contents', () => {
    // `01` is the ordering. Taking it as the initials would give every inbox in the soil the same
    // mark, which is the one outcome that makes the whole column pointless.
    expect(monogramFor('01-inbox').initials).toBe('IN')
    expect(monogramFor('99-inbox-main').initials).toBe('IM')
    expect(monogramFor('02-work').initials).toBe('WO')
  })

  it('takes one letter from each of two words, and two from a single word', () => {
    expect(monogramFor('cider-line').initials).toBe('CL')
    expect(monogramFor('orchard').initials).toBe('OR')
  })

  it('keeps digits that are a name rather than a prefix', () => {
    // No separator after the digits, so there is nothing to suggest they are grammar.
    expect(monogramFor('2026').initials).toBe('20')
  })

  it('handles the separators the soil actually uses, not whitespace alone', () => {
    expect(monogramFor('cold_store').initials).toBe('CS')
    expect(monogramFor('bin.logistics').initials).toBe('BL')
    expect(monogramFor('press repair').initials).toBe('PR')
  })

  it('never returns an empty string, because an empty circle reads as a fault', () => {
    expect(monogramFor('').initials).toBe('·')
    expect(monogramFor('   ').initials).toBe('·')
    // A folder legitimately called `01-` — grammar and nothing else.
    expect(monogramFor('01-').initials).toBe('·')
  })

  it('counts an astral character as one, rather than splitting a surrogate pair', () => {
    // Emoji folder names are legal on this filesystem. Half a surrogate pair renders as U+FFFD.
    const initials = monogramFor('🌱garden').initials
    expect([...initials]).toHaveLength(2)
    expect(initials.includes('�')).toBe(false)
  })
})

describe('the colour slot', () => {
  it('names a slot the stylesheet actually defines', () => {
    for (const label of ['01-inbox', 'orchard', 'cider-line', '99-inbox-main', '', '2026']) {
      const { slot } = monogramFor(label)
      expect(slot).toBeGreaterThanOrEqual(1)
      expect(slot).toBeLessThanOrEqual(MONOGRAM_SLOTS)
    }
  })

  it('is stable for the same name, or the colour would change on every render', () => {
    expect(monogramFor('orchard').slot).toBe(monogramFor('orchard').slot)
  })

  it('ignores capitalisation, so a case-only rename keeps its colour', () => {
    expect(monogramFor('Orchard').slot).toBe(monogramFor('orchard').slot)
  })

  /**
   * **Hashed on the stem, not on the initials.** Two folders sharing initials must still be able to
   * differ in colour, or the mark stops distinguishing them exactly when it matters most.
   *
   * Asserted as "these two specific names differ" rather than as a property, because a hash is
   * allowed to collide and a general claim would be false.
   */
  it('does not collapse two names that share initials', () => {
    expect(monogramFor('cider-line').initials).toBe(monogramFor('crop-log').initials)
    expect(monogramFor('cider-line').slot).not.toBe(monogramFor('crop-log').slot)
  })
})
