import { describe, expect, it } from 'vitest'

import {
  bytesRemoved, groupDigits, truncationDetail, truncationHeadline, truncationWarning,
} from '../../../src/client/editor/truncation-prompt'

/**
 * §13.2's confirmation, which was specified, built on the server, and **never asked**.
 *
 * The sweep of 2026-08-16 found `DocumentSession.confirmTruncation` called by two tests and no
 * product code. What shipped instead was a banner that named the loss and offered no answer — and
 * because a blocked save never clears the dirty flag, deleting a long section on purpose made the
 * file unsaveable for the rest of the session.
 *
 * The wording is tested rather than eyeballed for the reason `restore-prompt.test.ts` gives about
 * its own: this sentence is the entire interface to a decision that deletes content, and a person
 * reads it once, quickly, while alarmed.
 *
 * The modal itself is covered by the e2e suite against real browsers, matching how the restore
 * prompt is split — appearance and event wiring belong where there is a real engine.
 */

describe('grouping digits without asking the environment', () => {
  /**
   * **`toLocaleString` was the obvious call and is the wrong one.** It reads the ambient locale, so
   * the same code renders `3,412` here and `3.412` on a machine set to German — which makes every
   * assertion below pass where it was written and fail somewhere else.
   */
  it('groups from the right, so the leading group is the short one', () => {
    expect(groupDigits(0)).toBe('0')
    expect(groupDigits(7)).toBe('7')
    expect(groupDigits(999)).toBe('999')
    expect(groupDigits(1_000)).toBe('1,000')
    // The case a left-to-right implementation gets wrong: it would produce `123,4`.
    expect(groupDigits(1_234)).toBe('1,234')
    expect(groupDigits(12_345)).toBe('12,345')
    expect(groupDigits(1_234_567)).toBe('1,234,567')
  })

  it('does not put a separator in front of the number', () => {
    // A modulo written without the `i > 0` guard emits one before the first digit of any exact
    // multiple of three digits.
    expect(groupDigits(100)).toBe('100')
    expect(groupDigits(123)).toBe('123')
  })
})

describe('how much is being lost', () => {
  it('is the difference between what is there and what would be left', () => {
    expect(bytesRemoved({ fileName: 'a.md', wasBytes: 4_000, willBeBytes: 588 })).toBe(3_412)
  })

  /**
   * **Never negative, and this is not defensive noise.** The dialog's whole sentence is "saving
   * would delete N bytes". If the numbers ever arrived the other way round — a growing file, a
   * detail object built by a future caller that swapped the fields — the sentence would read
   * "delete -600 bytes", which is a dialog telling somebody a falsehood about their document.
   */
  it('is zero rather than negative when the file would grow', () => {
    expect(bytesRemoved({ fileName: 'a.md', wasBytes: 100, willBeBytes: 700 })).toBe(0)
  })
})

describe('what the question says', () => {
  const summary = { fileName: 'subject.md', wasBytes: 4_000, willBeBytes: 588 }

  it('names the file and the loss, in bytes, grouped', () => {
    expect(truncationHeadline(summary))
      .toBe('Saving would delete 3,412 bytes from subject.md.')
  })

  /**
   * **Bytes, not characters, and the difference is not pedantry.** The two numbers are
   * `baseline.size` and `bytes.length` — both byte counts. One emoji is four bytes and one
   * character, so reporting a measured byte count as characters is simply a wrong number for any
   * file with an accent in it.
   */
  it('says bytes', () => {
    expect(truncationHeadline(summary)).toContain('bytes')
    expect(truncationHeadline(summary)).not.toContain('character')
  })

  it('says byte, singular, when exactly one would go', () => {
    expect(truncationHeadline({ fileName: 'a.md', wasBytes: 2, willBeBytes: 1 }))
      .toBe('Saving would delete 1 byte from a.md.')
  })

  /**
   * **The second sentence is the half that matters.** Somebody reading "this would delete most of
   * your file" needs to know immediately whether it already happened. It has not — the server
   * refused the write — and saying so is what makes this a question rather than an alarm.
   */
  it('states the proportion, and that nothing has happened yet', () => {
    expect(truncationWarning(summary))
      .toBe('That is 85% of the file. Nothing has been written — the copy on disk is still complete.')
  })

  /**
   * **Found by looking at the rendered dialog, not by a test — which is why this one exists.**
   *
   * Emptying a 1,652-byte file down to 4 read *"That is 100% of the file"*. `Math.round` was the
   * whole cause, and on a dialog whose only job is telling the truth about a deletion, a number that
   * says "everything" while something remains is the error that costs the most: a person who checks,
   * finds four bytes, and learns the dialog rounds stops believing the next one.
   */
  it('never says 100% while any bytes would survive', () => {
    expect(truncationWarning({ fileName: 'a.md', wasBytes: 1_652, willBeBytes: 4 }))
      .toContain('That is 99% of the file.')
  })

  it('says 100% only when the file really would be emptied', () => {
    expect(truncationWarning({ fileName: 'a.md', wasBytes: 1_652, willBeBytes: 0 }))
      .toContain('That is 100% of the file.')
  })

  /** The mirror at the other end: a rounding-down must not claim nothing is being lost. */
  it('never says 0% while any bytes would go', () => {
    expect(truncationWarning({ fileName: 'a.md', wasBytes: 100_000, willBeBytes: 99_999 }))
      .toContain('That is 1% of the file.')
  })

  it('still promises nothing was written when there is no proportion to state', () => {
    // An empty baseline cannot be divided by. The reassurance is the part that must survive.
    const warning = truncationWarning({ fileName: 'a.md', wasBytes: 0, willBeBytes: 0 })
    expect(warning).toBe('Nothing has been written — the copy on disk is still complete.')
    expect(warning).not.toContain('NaN')
    expect(warning).not.toContain('Infinity')
  })

  it('gives both figures, so the claim can be checked rather than taken', () => {
    expect(truncationDetail(summary)).toBe('4,000 bytes on disk → 588 bytes after saving.')
  })
})
