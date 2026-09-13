import { describe, expect, it } from 'vitest'

import { firstDifferingLine } from '../../src/client/files/conflict-view'

/**
 * The line number the pane shows, so a person is not asked to diff two documents by eye.
 *
 * Deliberately not a full diff — that is a feature with its own scope, and the question this screen
 * asks is "which of these two do you want", not "what exactly changed".
 */
describe('where two versions first differ', () => {
  it('reports the line, one-based, because that is how an editor counts', () => {
    expect(firstDifferingLine('a\nb\nc', 'a\nB\nc')).toBe(2)
    expect(firstDifferingLine('x', 'y')).toBe(1)
  })

  /**
   * §13.4 is explicit that this is the COMMON case on this tree: *"an agent rewriting identical
   * bytes would spawn a permanent conflict artifact"*. A person told "they differ" when they do not
   * stops believing the next one.
   */
  it('says null when the two are identical', () => {
    expect(firstDifferingLine('same\ntext\n', 'same\ntext\n')).toBeNull()
    expect(firstDifferingLine('', '')).toBeNull()
  })

  it('finds a difference in length, not only in content', () => {
    expect(firstDifferingLine('a\nb', 'a\nb\nc')).toBe(3)
    expect(firstDifferingLine('a\nb\nc', 'a\nb')).toBe(3)
  })

  it('notices a trailing newline, which is a real difference on disk', () => {
    // §12 preserves trailing-newline state exactly. A conflict over it is a real conflict.
    expect(firstDifferingLine('a\n', 'a')).toBe(2)
  })

  it('handles CRLF as content rather than normalising it away', () => {
    // The editor preserves line endings byte for byte; a screen that hid the difference would be
    // telling the person the files match when the bytes do not.
    expect(firstDifferingLine('a\r\nb', 'a\nb')).toBe(1)
  })

  it('reports the FIRST difference, not the last', () => {
    expect(firstDifferingLine('1\n2\n3\n4', '1\nX\n3\nY')).toBe(2)
  })
})
