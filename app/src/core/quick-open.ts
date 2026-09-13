/**
 * **QUICK-OPEN.** Spec §16 — *"Type a few letters, jump to any file. The answer to 'stuff gets
 * buried.'"*
 *
 * the operator's complaint about the Tasks tab was the same sentence about a different surface:
 * *"everything is buried in 12 different folders."* The filter answered it for tasks; this answers
 * it for everything else.
 *
 * ## The security clause is the design, not a caveat on it
 *
 * §16, and F8.5 before it: ***"No regex is ever built from user input — that is a CPU DoS."***
 * A pattern assembled from typing is the classic way to turn a search box into a way to hang the
 * process, and this app's process is the thing holding the user's files open. So:
 *
 * - **The query is capped at 64 characters** before anything looks at it.
 * - **The scan is a linear subsequence walk.** One pass per candidate, one index per character, no
 *   backtracking. There is no input that makes it super-linear, which is the property a regex
 *   cannot offer.
 * - **A time budget bounds the whole search**, so a tree far larger than the one measured cannot
 *   make a keystroke expensive.
 * - **100 results.** Ranking beyond that is work nobody reads.
 *
 * ## Filename before path
 *
 * §16: *"Ranks filename before path."* Typing `chatroom` should find the file called `chatroom.md`
 * before every file that merely lives under a folder with that word in it — and this tree has 97 of
 * those. A single score over the whole path cannot express that, so the name is matched first and
 * the path only consulted when it does not hit.
 */

/** §16's cap, applied before the query is looked at rather than while it is used. */
export const MAX_QUERY = 64

/** §16's result cap. */
export const MAX_RESULTS = 100

/**
 * The whole search's budget, in milliseconds.
 *
 * **Checked between candidates, not inside the inner loop.** A per-character clock reading would
 * cost more than the comparison it guards; between candidates the granularity is one path's walk,
 * which is bounded by its own length.
 */
export const BUDGET_MS = 30

/**
 * How long the client waits after a keystroke before asking. **the security review's P11F-7.**
 *
 * Quick-open fired one request per keystroke. Harmless at 1,500 files — and it is the **multiplier
 * on P11F-2**, where the search's cost is dominated by a sort the time budget does not cover. Eight
 * characters typed at speed meant eight full searches, seven of whose answers nobody would ever see.
 *
 * **120 ms**, and the number is bounded on both sides rather than picked. Below roughly 150 ms a
 * pause does not read as lag, so this is invisible to the person typing; above about 100 ms it is
 * long enough that ordinary typing — 200 to 300 ms between characters when composing a search —
 * collapses a burst into one request rather than several.
 *
 * **It is here, in core, rather than in the panel**, because it is a property of the search's cost
 * and belongs beside the budget it protects. A constant living in the view is one nobody finds when
 * they are looking at why the search is expensive.
 */
export const QUERY_DEBOUNCE_MS = 120

export interface Candidate {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly name: string
}

export interface Hit<C extends Candidate = Candidate> {
  readonly candidate: C
  /** Lower is better. Composed so a name match always beats a path match — see `scoreOf`. */
  readonly score: number
  /** True when the query matched the filename rather than only the path. */
  readonly inName: boolean
}

/**
 * Whether `query` appears in `text` as a subsequence, and how tightly.
 *
 * Returns the number of characters skipped before and between matches, or `null` for no match — so
 * a lower number is a tighter match, and an exact prefix scores 0.
 *
 * **Case-folded with `toLowerCase` on both sides and nothing else.** Not `comparisonKey`: that is
 * the *identity* folding, which decides whether two names are the same file, and borrowing it here
 * would tie a search box to a rule about filesystem semantics. A search is allowed to be forgiving
 * in ways identity must never be.
 */
export function subsequenceScore(query: string, text: string): number | null {
  if (query === '') return 0
  const needle = query.toLowerCase()
  const hay = text.toLowerCase()

  let at = 0
  let skipped = 0
  for (const character of needle) {
    const found = hay.indexOf(character, at)
    if (found === -1) return null
    skipped += found - at
    at = found + 1
  }
  return skipped
}

/**
 * The score for one candidate, or `null` when it does not match at all.
 *
 * **A name match and a path match are different orders of magnitude, deliberately.** The path score
 * is offset past every reachable name score, so no amount of tightness in a path can outrank a
 * name — which is what §16's *"ranks filename before path"* means in practice, and it must be
 * structural rather than a tie-break, or a very tight path match beats a loose name match and the
 * file you typed the name of is on the second screen.
 */
const PATH_PENALTY = 1_000_000

export function scoreOf(query: string, candidate: Candidate, path?: string): Hit | null {
  const byName = subsequenceScore(query, candidate.name)
  if (byName !== null) {
    /**
     * **Shorter names win ties.** Typing `note` should offer `note.md` before
     * `note-on-the-thing.md`: both match with nothing skipped, and the one that is *mostly* the
     * query is more likely the one meant.
     */
    return { candidate, score: byName * 1_000 + candidate.name.length, inName: true }
  }

  const joined = path ?? candidate.segments.join('/')
  const byPath = subsequenceScore(query, joined)
  if (byPath === null) return null
  return { candidate, score: PATH_PENALTY + byPath * 1_000 + joined.length, inName: false }
}

export interface SearchOptions {
  /** Injected so the budget is reachable in a test without waiting for it. */
  readonly now?: () => number
  readonly budgetMs?: number
  readonly maxResults?: number
}

export interface SearchResult<C extends Candidate = Candidate> {
  readonly hits: readonly Hit<C>[]
  /** True when the budget stopped the scan before every candidate was seen. */
  readonly truncated: boolean
}

/**
 * Ranks `candidates` against `query`.
 *
 * **Everything about this is bounded**: the query by `MAX_QUERY`, the work by `budgetMs`, the
 * answer by `maxResults`. An empty query returns nothing rather than everything — a search box that
 * lists the entire tree the moment it opens is not a search, and on this tree it is 1,500 rows.
 */
export function search<C extends Candidate>(
  query: string,
  candidates: Iterable<C>,
  options: SearchOptions = {},
): SearchResult<C> {
  const trimmed = query.trim().slice(0, MAX_QUERY)
  if (trimmed === '') return { hits: [], truncated: false }

  const now = options.now ?? (() => performance.now())
  const budget = options.budgetMs ?? BUDGET_MS
  const limit = options.maxResults ?? MAX_RESULTS
  const startedAt = now()

  /**
   * **BOUNDED INSERT, and the budget now actually bounds the search.** (security review, P11 C2.)
   *
   * The first version collected *every* match and sorted at the end, on the reasoning that a sort
   * of the matches is cheap. Measured, it was 96–99% of the wall clock: 200,000 files answered in
   * 743ms with `truncated: false`, because the scan finished in 17ms and the sort then ran over
   * 200,000 hits — with a comparator calling `segments.join('/')` **twice per comparison**, some
   * seven million joins *after* the budget had stopped watching. The budget bounded the cheap half
   * and this file said, in as many words, that it bounded the whole search.
   *
   * Now nothing outside `limit` is ever kept. The list stays sorted by insertion, so the work per
   * match is a binary search plus a bounded splice, and the total is bounded by the cap rather than
   * by how many things happen to match.
   */
  const hits: Hit<C>[] = []
  let truncated = false

  for (const candidate of candidates) {
    if (now() - startedAt > budget) { truncated = true; break }
    /**
     * Joined **once per candidate**, not twice per comparison. It is needed for the path score and
     * again for the tie-break, and computing it here is what makes both free.
     */
    const path = candidate.segments.join('/')
    const hit = scoreOf(trimmed, candidate, path)
    if (hit === null) continue

    /**
     * **Ties break on the path**, so the order is stable across two identical searches — the index
     * is a Map and its iteration order is an implementation detail, which P9-7 already recorded
     * costing a board its determinism.
     */
    const worse = (at: number): boolean => {
      const other = hits[at]
      if (other === undefined) return false
      return other.score > hit.score
        || (other.score === hit.score && other.candidate.segments.join('/') > path)
    }

    // Everything already kept is better, and the list is full: this one cannot place.
    if (hits.length >= limit && !worse(limit - 1)) continue

    let low = 0
    let high = hits.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (worse(middle)) high = middle
      else low = middle + 1
    }
    hits.splice(low, 0, { ...hit, candidate })
    if (hits.length > limit) hits.pop()
  }

  return { hits, truncated }
}
