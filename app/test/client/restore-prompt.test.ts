import { describe, expect, it } from 'vitest'

import {
  restoreDetail, restoreHeadline, worthOffering, type RetainedSummary,
} from '../../src/client/files/restore-prompt'

/**
 * The wording and the offer rule for §13.8's restore question.
 *
 * The surface itself is proven in `test/e2e/retained-buffer.spec.ts`, in a real browser against a
 * real IndexedDB, for the reason this build keeps relearning: a screen that mounts and a screen
 * that *works* are different claims, and only one of them can be made from Node.
 *
 * What is asserted here is what a person reads. **The stale case is the one that has to be right**
 * — it is the only moment in the app where following the obvious button destroys someone else's
 * work, so the sentence has to say so before the button is pressed.
 */

const summary = (over: Partial<RetainedSummary> = {}): RetainedSummary => ({
  fileName: 'notes.md',
  retained: 'what I was typing',
  onDisk: 'what is there now',
  stale: false,
  ...over,
})

describe('whether to ask at all', () => {
  /**
   * **Identical text is a nag, not a rescue.** A buffer retained a keystroke before a successful
   * save holds exactly what is on disk. Asking "which of these two identical documents?" on every
   * open teaches a person to dismiss the question unread — and then the one that mattered gets
   * dismissed too. §13.4 makes the same argument about conflicts over byte-identical content.
   */
  it('does not ask when the retained text matches the file', () => {
    expect(worthOffering('same\ntext\n', 'same\ntext\n')).toBe(false)
  })

  it('asks when they differ', () => {
    expect(worthOffering('mine', 'theirs')).toBe(true)
  })

  /** A trailing newline is a real difference on disk, and §12 preserves it exactly. */
  it('treats a trailing newline as a difference worth asking about', () => {
    expect(worthOffering('a\n', 'a')).toBe(true)
  })

  it('asks when the file is now empty and the buffer is not', () => {
    expect(worthOffering('rescued text', '')).toBe(true)
  })
})

describe('what the question says', () => {
  it('names the file in the ordinary case', () => {
    expect(restoreHeadline(summary()))
      .toBe('You have unsaved changes to notes.md from earlier.')
  })

  it('says the file moved underneath when the identity no longer matches', () => {
    expect(restoreHeadline(summary({ stale: true })))
      .toBe('notes.md changed on disk while your edit was unsaved.')
  })

  it('points at the first line that differs', () => {
    expect(restoreDetail(summary({ retained: 'a\nb', onDisk: 'a\nB' })))
      .toContain('first differ at line 2')
  })

  /**
   * **THE SENTENCE THAT MATTERS.** In the stale case, "Use your unsaved version" replaces work
   * something else did while the edit sat unsaved — an agent, another device, the operator on their phone.
   * §13.8 forbids auto-replay for exactly this reason, and a question that does not name the
   * consequence is auto-replay with an extra click.
   */
  it('warns that keeping yours replaces what is on disk, but only when stale', () => {
    expect(restoreDetail(summary({ stale: true }))).toContain('will replace what is on disk now')
    expect(restoreDetail(summary({ stale: false }))).not.toContain('replace')
    expect(restoreDetail(summary({ stale: false }))).toContain('Nothing has been changed yet')
  })

  /**
   * Reachable: the identity token can match while the content differs — the file was rewritten with
   * the same size and mtime, or the buffer was retained and the file restored from a backup. Saying
   * "they differ" when they do not is how a person stops believing the next message.
   */
  it('says so plainly when the two are identical', () => {
    expect(restoreDetail(summary({ retained: 'x', onDisk: 'x' })))
      .toContain('The two versions are identical')
  })
})
