import { describe, expect, it } from 'vitest'

import { matchesFilter, termsOf } from '../../src/client/board/filter'

/**
 * The shared filter. PRD: *"one filter mechanism shared across all tabs"* — so the rule lives in
 * one place and is asserted here rather than three times in three views.
 *
 * It exists because the Projects board opens with every project unfiled: sixty-six against the
 * mock. The job is to get from sixty-six to three in one line of typing.
 */
describe('what a query matches', () => {
  it('matches nothing typed by matching everything', () => {
    expect(matchesFilter(['cider-line'], '')).toBe(true)
    expect(matchesFilter(['cider-line'], '   ')).toBe(true)
  })

  it('matches a substring, ignoring case', () => {
    expect(matchesFilter(['Cider-Line'], 'cider')).toBe(true)
    expect(matchesFilter(['cider-line'], 'LINE')).toBe(true)
  })

  /**
   * **The one that makes it usable on this tree.** Soil folders are hyphenated, and nobody types
   * the hyphen when searching. Both spellings have to work.
   */
  it('finds a hyphenated name from spaced words, and from the hyphenated form', () => {
    expect(matchesFilter(['cider-line'], 'cider line')).toBe(true)
    expect(matchesFilter(['cider-line'], 'cider-line')).toBe(true)
  })

  /** Every term must match. Two terms narrow; they do not widen. */
  it('requires all terms, not any', () => {
    expect(matchesFilter(['cider-line'], 'cider press')).toBe(false)
    expect(matchesFilter(['cider-line press-shed'], 'cider press')).toBe(true)
  })

  /**
   * Fields are joined before matching, so a query can span a name and its breadcrumb — *"orchard
   * 02-projects"* is a reasonable thing to type and would fail if each field were searched alone.
   */
  it('matches across fields', () => {
    expect(matchesFilter(['orchard-ops', '02-projects'], 'orchard projects')).toBe(true)
  })

  it('is not fuzzy — a term that is not there does not match', () => {
    expect(matchesFilter(['cider-line'], 'cdr')).toBe(false)
  })

  /**
   * Separators are normalised on the **haystack** only. Doing it to the query too would make
   * `cider-line` and `ciderline` the same search, which is a different and wronger promise.
   */
  it('does not collapse the query itself', () => {
    expect(matchesFilter(['cider-line'], 'ciderline')).toBe(false)
  })

  it('splits a path on its slashes too', () => {
    expect(matchesFilter(['02-projects/field-review'], 'field review')).toBe(true)
  })

  it('reads terms off a query with any spacing', () => {
    expect(termsOf('  cider   line ')).toEqual(['cider', 'line'])
    expect(termsOf('')).toEqual([])
  })
})
