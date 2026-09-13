import { describe, expect, it } from 'vitest'

import {
  BUDGET_MS, MAX_QUERY, MAX_RESULTS, scoreOf, search, subsequenceScore, type Candidate,
} from '../../src/core/quick-open'

/**
 * **QUICK-OPEN.** Spec §16, and the answer to the operator's *"everything is buried in 12 different
 * folders"* for every surface the task filter does not cover.
 *
 * The cases are ordered by what outranks what. **The security clause first**, because §16 states it
 * as a hard rule rather than a quality: *"No regex is ever built from user input — that is a CPU
 * DoS."* A search box that can hang the process is a search box that can take the app holding
 * the user's files down with it.
 */

const file = (path: string): Candidate => {
  const segments = path.split('/')
  return { rootId: 'soil', segments, name: segments[segments.length - 1] ?? '' }
}

/**
 * Large enough that the scan always runs to completion, so a growth measurement measures the code
 * rather than the budget. Used only by the linearity case, which asserts `truncated === false` on
 * both sides so this can never silently stop being true.
 */
const UNCLAMPED_BUDGET_MS = 60_000

const TREE = [
  file('02-projects/cold-store-expansion/03-discovery/RT1/chatroom.md'),
  file('02-projects/cold-store-expansion/00-context/context.md'),
  file('02-projects/chatroom-protocol/00-context/notes.md'),
  file('01-internal/security/chatroom.md'),
  file('02-projects/orchard/note.md'),
  file('02-projects/orchard/note-on-the-thing.md'),
]

describe('§16 — nothing here can be made expensive by typing', () => {
  /**
   * **The cap is applied to the query, before anything walks it.** A 10,000-character paste is the
   * cheapest denial-of-service there is, and the guard has to be at the door rather than inside the
   * loop.
   */
  /**
   * **The cap asserted by what it changes, not by how fast it is.**
   *
   * A sweep removed `slice(0, MAX_QUERY)` and the timing case below stayed green — because a 50,000
   * character query of one letter bails out on the first character a path does not contain, so it
   * was fast either way. The test was measuring the early exit, not the cap.
   *
   * This one cannot: the candidate matches the query's **first 64 characters exactly** and nothing
   * after them. Capped, it is a hit. Uncapped, the trailing characters must also be found and it is
   * not. The assertion is the match, which is unambiguous.
   */
  it('uses only the first 64 characters of a query', () => {
    const within = 'a'.repeat(MAX_QUERY)
    const candidate = file(`somewhere/${within}.md`)
    expect(search(within, [candidate]).hits, 'the capped query should match').toHaveLength(1)
    expect(search(`${within}zzzz`, [candidate]),
      'everything past the cap must be ignored').toEqual(search(within, [candidate]))
  })

  it('caps the query, so a huge paste costs no more than a long word', () => {
    const huge = 'a'.repeat(50_000)
    const started = performance.now()
    const result = search(huge, TREE)
    expect(performance.now() - started, 'a 50k query took real time').toBeLessThan(50)
    expect(result.hits).toEqual([])
  })

  /**
   * **The pathological shape a regex would die on.** `a?a?a?…aaa…` against `aaaa…` is the classic
   * catastrophic-backtracking case; a subsequence walk does not backtrack at all, so it is simply a
   * linear pass. Asserted as a *time* bound because the property being claimed is about cost, not
   * about the answer.
   */
  it('answers a pathological query inside its budget', () => {
    const nasty = 'a'.repeat(MAX_QUERY)
    const haystack = Array.from({ length: 2_000 }, (_, at) => file(`${'a'.repeat(200)}/${at}.md`))
    const started = performance.now()
    search(nasty, haystack)
    expect(performance.now() - started).toBeLessThan(200)
  })

  it('stops when the budget is spent, and says it was truncated', () => {
    // A clock that jumps past the budget on its second reading — so the stop is provable without
    // waiting for it, which is how a control nobody can afford to watch fail goes unwatched.
    let reading = 0
    const now = (): number => { reading += 100; return reading }
    const result = search('note', TREE, { now, budgetMs: 10 })
    expect(result.truncated).toBe(true)
  })

  /**
   * **THE CASE THE SECURITY REVIEW'S C2 SAID WAS MISSING**, and it is the only shape that costs anything.
   *
   * The gate's previous test asserted `< 200`ms against a `BUDGET_MS` of **30**, on 2,000
   * candidates, in the branch that was already cheap — *"titled for a bound it does not assert."*
   * Meanwhile a query matching everything on 200,000 files took **743ms and reported
   * `truncated: false`**, because the scan finished in 17ms and the sort then ran unbounded.
   *
   * So: every candidate matches, the corpus is large, and the assertion is **total elapsed against
   * `BUDGET_MS` itself** — not a hand-picked larger number that a faster machine could satisfy
   * while the property stayed false.
   */
  it('bounds the WHOLE search when everything matches, not just the scan', () => {
    // Every path contains the query as a subsequence, so nothing is filtered out by matching.
    const everything = Array.from({ length: 50_000 }, (_, at) => file(`a/b/c/document-${at}.md`))
    const started = performance.now()
    const result = search('document', everything)
    const elapsed = performance.now() - started

    expect(result.hits).toHaveLength(MAX_RESULTS)
    /**
     * A small multiple of the budget, not the budget exactly: the bound governs the *scan*, and the
     * final candidate's insert is allowed to complete. What it forbids is the previous behaviour,
     * where the time after the budget was unbounded and grew with the corpus.
     */
    expect(elapsed, `${elapsed.toFixed(0)}ms for 50k matches`).toBeLessThan(BUDGET_MS * 8)
  })

  /**
   * **Linear is the floor; the defect was worse than linear.**
   *
   * The first version of this case asserted a 10× corpus costs less than 6× the time, and it
   * failed — correctly. The scan *must* look at every candidate, so ten times the candidates is ten
   * times the scan, and no design removes that. What the bounded insert removes is the
   * **super-linear** part: a sort over every match, outside the budget, with a comparator joining
   * paths twice per comparison.
   *
   * So the assertion is that 10× the matches costs no worse than **roughly** 10× — which a
   * `n log n` sort with a large constant does not satisfy. Written as a ratio rather than a
   * millisecond figure so a faster machine cannot make it pass while the property is false.
   */
  it('grows no worse than linearly as the number of matches grows', () => {
    /**
     * **Each side is the best of several samples, and that is what makes this a measurement rather
     * than a coin flip.** *(Corrected 2026-08-13, after it failed a full `npm run ci` at
     * `0.9ms -> 18.7ms` = 20.5 and then passed five times out of five in isolation.)*
     *
     * The property below is sound and is kept unchanged. The *instrument* was not: a single sample
     * of ~0.9 ms sits close enough to scheduling jitter that the denominator, not the code, decided
     * the verdict — the numerator would have had to be genuinely 10× worse to matter as much as one
     * preempted millisecond in `small`. Under a loaded machine it fails; alone it passes; nothing
     * about the code changed either way.
     *
     * **Minimum, not mean, and the reason is one-directional:** noise only ever *adds* time. A
     * preempted run is slower than the truth and never faster, so the fastest of N samples is the
     * closest estimate of the real cost, and a machine under load degrades both sides toward their
     * own clean floors rather than skewing the ratio.
     *
     * This is the same habit M44 named four times in two days — *a value read at a moment nothing
     * pinned* — arriving in the unit suite, which is the one that is supposed to be deterministic.
     * A gate with a coin flip in it teaches re-running rather than reading.
     */
    const corpus = (n: number) => Array.from({ length: n }, (_, at) => file(`a/b/document-${at}.md`))
    const time = (n: number): { ms: number; truncated: boolean } => {
      const items = corpus(n)
      const started = performance.now()
      // See UNCLAMPED below — the default budget makes this assertion measure the budget, not the code.
      const result = search('document', items, { budgetMs: UNCLAMPED_BUDGET_MS })
      return { ms: performance.now() - started, truncated: result.truncated }
    }
    const best = (n: number): { ms: number; truncated: boolean } => {
      const samples = Array.from({ length: 5 }, () => time(n))
      return {
        ms: Math.min(...samples.map(s => s.ms)),
        truncated: samples.some(s => s.truncated),
      }
    }

    time(5_000) // warm the JIT, so the first sample is not the outlier that sets the floor
    const small = best(5_000)
    const large = best(50_000)

    /**
     * **UNCLAMPED — and this assertion is the reason the case works at all.**
     *
     * Under the default 30 ms budget the scan *stops* at 30 ms, so `large` is bounded by the budget
     * no matter how bad the algorithm is, while `small` is free to grow. Measured 2026-08-13 with
     * the bounded insert removed — the exact regression this case exists to catch:
     *
     * ```
     * healthy    5k -> 1.9ms   50k -> 11.0ms  truncated=false   ratio 5.8
     * regressed  5k -> 5.4ms   50k -> 30.1ms  truncated=TRUE    ratio 5.6   <- LOWER
     * ```
     *
     * **The guard inverted under the condition it existed to detect**, and the assertion got
     * *easier* to satisfy the worse the code became. It survived that mutation five times out of
     * five, in this form and in its original single-sample form — so this was inherited, not
     * introduced by the sampling fix above.
     *
     * Asserting `truncated === false` is what stops it coming back: if a future budget change
     * clamps either side again, this fails loudly instead of quietly measuring nothing.
     */
    expect(small.truncated, 'the small corpus must run to completion, or the ratio is meaningless')
      .toBe(false)
    expect(large.truncated, 'the large corpus must run to completion — a clamped numerator inverts this test')
      .toBe(false)

    // Ten times the matches, so ~10 is the linear floor. Anything approaching 30 is the sort back.
    expect(
      large.ms / Math.max(small.ms, 0.5),
      `${small.ms.toFixed(1)}ms -> ${large.ms.toFixed(1)}ms`,
    ).toBeLessThan(18)
  })

  it('returns no more than the cap asks for', () => {
    const many = Array.from({ length: 500 }, (_, at) => file(`notes/note-${at}.md`))
    expect(search('note', many, { maxResults: 100 }).hits).toHaveLength(100)
  })

  /**
   * **An empty query returns nothing, not everything.** A box that lists the whole tree the moment
   * it opens is not a search — and on the user's tree that is 1,500 rows drawn on a keystroke.
   */
  it('returns nothing for an empty query', () => {
    expect(search('', TREE).hits).toEqual([])
    expect(search('   ', TREE).hits).toEqual([])
  })
})

describe('§16 — the filename ranks before the path', () => {
  /**
   * The sentence this is: *"ranks filename before path."* Typing `chatroom` in the user's soil must
   * offer the file called `chatroom.md` before every document that merely lives under a folder with
   * the word in it — and their tree has 97 of the former and a `chatroom-protocol` folder besides.
   */
  it('puts a file named for the query above one merely living under that name', () => {
    const hits = search('chatroom', TREE).hits
    expect(hits[0]?.candidate.name).toBe('chatroom.md')
    expect(hits[0]?.inName).toBe(true)
    // The protocol folder's note matches on path only, and comes after both real chatrooms.
    const protocolAt = hits.findIndex(hit => hit.candidate.name === 'notes.md')
    expect(protocolAt).toBeGreaterThan(1)
    expect(hits[protocolAt]?.inName).toBe(false)
  })

  /**
   * **Structural, not a tie-break.** A very tight path match must not outrank a loose name match,
   * or the file you typed the name of lands on the second screen. Asserted with a path that matches
   * *perfectly* against a name that matches sloppily.
   */
  it('never lets a tight path match outrank a loose name match', () => {
    const hits = search('ctx', [
      file('ctx/ctx/ctx.md'.replace(/ctx\.md$/, 'something.md')),
      file('elsewhere/c-o-n-t-e-x-t.md'),
    ]).hits
    expect(hits[0]?.inName, 'a path match came first').toBe(true)
  })

  /**
   * Typing `note` should offer `note.md` before `notes.md` before `note-on-the-thing.md`: all three
   * match with nothing skipped, and the one that is *mostly* the query is the likeliest to be meant.
   *
   * `notes.md` was missing from the first version of this expectation — it matches on the name too,
   * being the protocol folder's note. Corrected rather than excluded: a case that quietly drops a
   * legitimate match is a case that stops describing the ranking.
   */
  it('prefers the shorter name when two match equally well', () => {
    const hits = search('note', TREE).hits.filter(hit => hit.inName)
    expect(hits.map(hit => hit.candidate.name))
      .toEqual(['note.md', 'notes.md', 'note-on-the-thing.md'])
  })
})

describe('the matcher itself', () => {
  it('matches letters in order with gaps, and scores tightness', () => {
    expect(subsequenceScore('abc', 'abc')).toBe(0)
    expect(subsequenceScore('abc', 'axbxc')).toBe(2)
    expect(subsequenceScore('abc', 'acb')).toBeNull()
  })

  it('is case-insensitive in both directions', () => {
    expect(subsequenceScore('ABC', 'abc')).toBe(0)
    expect(subsequenceScore('abc', 'ABC')).toBe(0)
  })

  it('reports no match rather than a bad one', () => {
    expect(scoreOf('zzz', file('02-projects/orchard/note.md'))).toBeNull()
  })

  /**
   * **Stable across two identical searches.** The index is a Map and its iteration order is an
   * implementation detail — P9-7 already recorded that costing a board its determinism, and a
   * result list that reshuffles between keystrokes is worse there than on a board.
   */
  it('orders identically on repeated searches', () => {
    const once = search('o', TREE).hits.map(hit => hit.candidate.segments.join('/'))
    const twice = search('o', [...TREE].reverse()).hits.map(hit => hit.candidate.segments.join('/'))
    expect(once).toEqual(twice)
  })
})
