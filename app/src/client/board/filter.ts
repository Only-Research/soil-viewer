/**
 * The filter, shared. PRD: *"filter bar (one filter mechanism shared across all tabs)"*.
 *
 * **One mechanism, in one module, because the PRD asks for one** — and because the alternative is
 * three search boxes that disagree about whether matching is case-sensitive, whether it looks at
 * the path as well as the name, and what an empty query means. This build has a standing lesson
 * about the same rule implemented twice.
 *
 * ## Why it exists now
 *
 * The Projects board opens with every project in Unfiled — sixty-six of them against the mock, and
 * a similar number against the real soil. Filing them by dragging each one across a long scroll is
 * a chore nobody performs, so the board would stay unfiled and the three columns that matter would
 * stay empty. The fix is not bulk-moving sixty-six cards; it is **finding the three you care
 * about**, at which point one drag is nothing.
 *
 * ## The matching rule, stated once
 *
 * Case-insensitive, accent-preserving, substring, **and every term must match somewhere**. Typing
 * `cider line` finds `cider-line` because the hyphen is not a word the query has to reproduce, and
 * typing `orchard 02-projects` finds an orchard project by its location — the fields are joined
 * before matching rather than searched one at a time, so a query can span a name and a breadcrumb.
 *
 * Deliberately **not** fuzzy. A fuzzy matcher that returns sixty-six ranked results for `x` is a
 * filter that never gets you to a short list, which is the one thing this has to do.
 */

/**
 * Splits a query into terms, on whitespace **and on the separators soil names use**. No operators,
 * nothing to learn.
 *
 * Splitting on `-`, `_` and `/` as well as space is what makes `cider-line`, `cider line` and
 * `02-projects/field-review` all behave the way a person expects. The first version split on whitespace
 * only and the hyphenated spelling stopped matching — you could find `cider-line` by typing
 * `cider line` but not by typing its actual name, which is the more likely thing to type.
 */
export function termsOf(query: string): string[] {
  return query.toLocaleLowerCase().split(/[\s\-_/]+/).filter(term => term.length > 0)
}

/**
 * True when every term appears somewhere in `fields`.
 *
 * An empty query matches everything, which is what makes the field safe to leave alone: a filter
 * that hid things until you typed would be a filter that lost your board.
 *
 * **Separators become term boundaries on both sides — they are never deleted.** `cider-line` is
 * findable by `cider line` and by `cider-line`, because each splits into the same two terms. What
 * this deliberately does not do is *collapse* them: `ciderline` stays a single term and finds
 * nothing, because treating it as a match would promise a kind of search this is not doing.
 */
export function matchesFilter(fields: readonly string[], query: string): boolean {
  const terms = termsOf(query)
  if (terms.length === 0) return true
  // The haystack is split the same way, so a term and the text it came from meet on equal ground.
  const haystack = fields.join(' ').toLocaleLowerCase().replace(/[\s\-_/]+/g, ' ')
  return terms.every(term => haystack.includes(term))
}
