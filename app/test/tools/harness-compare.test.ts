import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * The harness's pass/fail rule. Phase 5, acceptance condition 4.
 *
 * **The instrument is tested by the app's suite on purpose.** The harness used to live outside
 * `app/` with no tests at all — which is how ten of its scripts came to read from a directory that
 * no longer existed, with only one of them failing loudly enough to notice. An instrument nothing
 * checks is an instrument whose reports are believed rather than known. It now sits in
 * `test/harness/` beside the gate that uses it, so it is inside the tree the suite and the
 * typechecker already cover.
 *
 * The question every test here asks is not "does this work" but **"can this instrument report a
 * pass that is false?"** — because a harness that scores too high is worse than one that crashes.
 */
const require_ = createRequire(import.meta.url)
const compare = require_('../harness/compare.cjs') as {
  NOT_EDITABLE: string
  isValidUtf8: (bytes: Buffer) => boolean
  classify: (bytes: Buffer) => string
  survived: (bytes: Buffer, output: unknown) => boolean | null
  tally: (records: { path: string; bytes: Buffer; output: unknown }[]) => {
    total: number
    identical: string[]
    changed: string[]
    notEditable: string[]
    errored: string[]
    roundTrippable: number
    percentIdentical: number | null
  }
}

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8')

describe('the comparison is byte-exact where a string comparison is not', () => {
  it('THE ONE THAT MATTERS: two different invalid byte sequences are not equal', () => {
    /**
     * **The entire reason for byte comparison, and the only case where it differs from the old
     * one.** UTF-8 is injective on valid input, so for every ordinary file a decoded comparison and
     * a byte comparison agree — the build plan's stated example (line endings) is caught by both.
     *
     * Invalid bytes are the exception: they decode to U+FFFD, so **different** byte sequences
     * decode to the **same** string. The real tree has two such files, and §12 requires the app to
     * refuse them rather than round-trip them — which is exactly what a decoded comparison cannot
     * distinguish from mangling them.
     */
    const a = Buffer.from([0x23, 0x20, 0xff, 0x0a])
    const b = Buffer.from([0x23, 0x20, 0xfe, 0x0a])

    expect(a.equals(b), 'the bytes differ').toBe(false)
    expect(
      a.toString('utf8') === b.toString('utf8'),
      'and the OLD comparison called them the same file',
    ).toBe(true)

    expect(compare.classify(a)).toBe(compare.NOT_EDITABLE)
    expect(compare.classify(b)).toBe(compare.NOT_EDITABLE)
  })

  it('THE OTHER HALF OF §12: a NUL-bearing file is refused too, and it is valid UTF-8', () => {
    /**
     * **Found by building the corpus, not by testing the classifier.**
     *
     * §12's gate is *"valid UTF-8 **with no NUL**"* and `classify` checked only the first half. NUL
     * is a perfectly legal code point, so a NUL-bearing file is valid UTF-8 and sailed into the
     * round-trip denominator — where a compliant editor **refusing it, as required,** would have
     * been scored as a failure to round-trip. The harness would have marked correct behaviour wrong,
     * on one of exactly two files the clause was written for.
     *
     * No unit test of the classifier could have caught this: the classifier did precisely what its
     * name and its doc comment said. It took adding the two byte-level probes and printing the
     * denominator, and seeing one of them excluded and the other not.
     */
    const withNul = Buffer.concat([utf8('# Grading\n\ncolumn'), Buffer.from([0x00]), utf8('\n')])

    expect(compare.isValidUtf8(withNul), 'it IS valid UTF-8 — that is the trap').toBe(true)
    expect(compare.classify(withNul), 'and it is still not editable').toBe(compare.NOT_EDITABLE)
    expect(compare.survived(withNul, withNul.toString('utf8')), 'so it is never scored').toBeNull()
  })

  it('refuses to score a file it could not honestly give the editor', () => {
    /**
     * The driver hands the editor a **string**, so the lossy decode happens before the editor is
     * involved. For invalid bytes the harness would be measuring its own decoder and reporting the
     * result as a fact about the editor. `null` is the honest answer, and the tally counts these in
     * their own bucket.
     */
    const invalid = Buffer.from([0xff, 0xfe])
    expect(compare.survived(invalid, invalid.toString('utf8'))).toBeNull()
  })

  it('compares WHAT WOULD BE WRITTEN, not what the editor holds in memory', () => {
    /**
     * **Found by a mutation sweep that came back green on the headline change of this phase.**
     * Reverting `survived` to a decoded comparison broke nothing — because with the invalid-UTF-8
     * guard in front of it, the two agree on every valid file, exactly as the brief argued. The
     * byte comparison was doing no work that any test could see.
     *
     * They differ in one place, and it is this. A lone surrogate has no UTF-8 encoding: writing it
     * produces the replacement character's bytes. So an editor emitting `\uD800` over a file whose
     * bytes are `EF BF BD` **would leave that file byte-identical on disk** — the round trip
     * succeeded — while a string comparison calls it changed, because the two strings differ.
     *
     * A false failure is the safe direction, and it is still a wrong number in the report this
     * build treats as authoritative. The rule is: **compare the bytes that would land on disk.**
     */
    const replacementBytes = Buffer.from([0xef, 0xbf, 0xbd])
    const loneSurrogate = '\uD800'

    expect(Buffer.from(loneSurrogate, 'utf8').equals(replacementBytes), 'it encodes to those bytes')
      .toBe(true)
    expect(
      loneSurrogate === replacementBytes.toString('utf8'),
      'and the decoded comparison calls it a different file',
    ).toBe(false)

    expect(compare.survived(replacementBytes, loneSurrogate), 'the file survives on disk').toBe(true)
  })

  it('a valid file that comes back unchanged passes', () => {
    const bytes = utf8('# Notes\n\nordinary content\n')
    expect(compare.survived(bytes, '# Notes\n\nordinary content\n')).toBe(true)
  })

  it('catches a changed line ending — which the old comparison also caught', () => {
    // Stated because the build plan's justification named this case, and it was never the hole.
    // Recording it as a passing test is cheaper than leaving the wrong reason on the record.
    const crlf = utf8('# Notes\r\nline two\r\n')
    expect(compare.survived(crlf, '# Notes\nline two\n')).toBe(false)
  })

  it('catches a BOM that was dropped, and one that was added', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('# Notes\n')])
    expect(compare.survived(withBom, '# Notes\n'), 'BOM dropped').toBe(false)
    expect(compare.survived(utf8('# Notes\n'), '﻿# Notes\n'), 'BOM added').toBe(false)
  })

  it('catches NFC/NFD normalisation, which is invisible on screen', () => {
    // é as one code point versus e + combining acute. Identical to the eye, different bytes, and
    // the exact thing an editor that "cleans up" text does silently.
    const nfc = utf8(`r${String.fromCodePoint(0x00e9)}sum\n`)
    const nfd = `r${String.fromCodePoint(0x0065, 0x0301)}sum\n`
    expect(compare.survived(nfc, nfd)).toBe(false)
  })

  it('an editor that errored is a failure, never a pass', () => {
    const bytes = utf8('# Notes\n')
    expect(compare.survived(bytes, null)).toBe(false)
    expect(compare.survived(bytes, undefined)).toBe(false)
  })
})

describe('THE DENOMINATOR CANNOT SILENTLY SHRINK', () => {
  const record = (path: string, bytes: Buffer, output: unknown) => ({ path, bytes, output })

  it('every file lands in exactly one bucket, and they sum to the total', () => {
    const tally = compare.tally([
      record('a.md', utf8('# A\n'), '# A\n'),
      record('b.md', utf8('# B\n'), '# B changed\n'),
      record('c.md', Buffer.from([0xff]), '�'),
      record('d.md', utf8('# D\n'), null),
    ])
    expect(tally.total).toBe(4)
    expect(tally.identical).toEqual(['a.md'])
    expect(tally.changed).toEqual(['b.md'])
    expect(tally.notEditable).toEqual(['c.md'])
    expect(tally.errored).toEqual(['d.md'])
  })

  it('THE ONE THAT MATTERS: the percentage excludes what was never measured', () => {
    /**
     * The not-UTF-8 files are not failures — §12 requires the app to refuse them, so refusing is
     * correct — and they are not passes, because the editor was never given their actual bytes.
     * Counting them either way puts a number on a measurement that did not happen, **and the
     * direction it usually moves is up**, which is why the mistake survives review.
     */
    const tally = compare.tally([
      record('a.md', utf8('# A\n'), '# A\n'),
      record('b.md', Buffer.from([0xff]), '�'),
    ])
    expect(tally.roundTrippable, 'the invalid file is out of the denominator').toBe(1)
    expect(tally.percentIdentical, 'and the survivor is 100% of what was measured').toBe(100)
    expect(tally.notEditable, 'while still being reported by name').toEqual(['b.md'])
  })

  /**
   * **The closing assertion in `tally` is UNREACHABLE BY CONSTRUCTION, and is recorded as such
   * rather than counted as coverage.**
   *
   * Every record in that loop hits `continue` or one of the two terminal branches, so no record can
   * fall through all four buckets today. The check exists as insurance against a future edit that
   * adds a bucket and forgets it — the direction that mistake moves the percentage is *up*, which
   * is why it survives review.
   *
   * My first draft of this file had a test claiming to exercise it. It passed — on a `TypeError`
   * from reading `.bytes` off an `undefined` array element, never reaching the assertion at all.
   * A test that passes for the wrong reason on an instrument is worse than no test, because the
   * instrument's whole job is to be believed. Same status as the short-write assertions in
   * `conflict.ts` and `config-store.ts`: believed correct, not known to fire, and said out loud.
   */
  it.skip('a file that fell through every bucket throws — UNREACHABLE, see the note above', () => {
    // Intentionally skipped rather than deleted: the assertion is real, and a reader finding it
    // uncovered should find this explanation rather than assume an oversight.
  })
})
