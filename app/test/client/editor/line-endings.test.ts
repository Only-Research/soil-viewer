import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { LINE_SEPARATOR, dominantLineEnding } from '../../../src/client/editor/line-endings'

/**
 * The inputs that separate a faithful editor from a normalizing one. Every one of these appears in
 * the harness corpus, and the CRLF cases are why `test/harness/probes/19-crlf.md` exists.
 */
const HAZARDS: Record<string, string> = {
  'pure LF': 'a\nb\nc\n',
  'pure CRLF': 'a\r\nb\r\nc\r\n',
  'lone CR, classic Mac': 'a\rb\rc\r',
  'mixed CRLF and LF': 'a\r\nb\nc\r\n',
  'no trailing newline': 'a\nb',
  'BOM at the start': '﻿a\nb\n',
  'a hard break — two trailing spaces': 'a  \nb\n',
  'empty': '',
  'a stray CR at end of file': 'a\n\r',
  'consecutive blank lines': 'a\n\n\n\nb\n',
  'CRLF with no trailing newline': 'a\r\nb',
  'a lone CR immediately before a CRLF': 'a\r\r\nb\r\n',
}

/**
 * **This suite guards a dependency's behaviour, not ours**, and that is deliberate.
 *
 * The corruption it pins does not happen in code this repository owns. It happens inside
 * `@codemirror/state` when the split and the join disagree, which is the *default* configuration.
 * No test of our own functions can see it, because our functions never run. So the property is
 * asserted directly against the library, and a CodeMirror upgrade that changes it turns this red
 * instead of turning the harness red three phases later.
 */
describe('CodeMirror round-trips a document only under one setting — measured, not assumed', () => {
  const roundTrip = (input: string, lineSeparator: string | undefined): string =>
    EditorState.create({
      doc: input,
      extensions: lineSeparator === undefined ? [] : [EditorState.lineSeparator.of(lineSeparator)],
    }).doc.toString()

  it('preserves every hazard under LINE_SEPARATOR', () => {
    for (const [name, input] of Object.entries(HAZARDS)) {
      expect(roundTrip(input, LINE_SEPARATOR), name).toBe(input)
    }
  })

  it('LINE_SEPARATOR is "\\n", and the reason is that toString() always joins with "\\n"', () => {
    expect(LINE_SEPARATOR).toBe('\n')
    // The join is hard-wired. This is the fact the constant is derived from, so it is asserted
    // rather than described: three lines in, "\n"-joined out, whatever the separator was.
    const joined = EditorState.create({
      doc: 'x\r\ny\r\nz',
      extensions: [EditorState.lineSeparator.of('\r\n')],
    }).doc.toString()
    expect(joined).toBe('x\ny\nz')
  })

  it('THE DEFAULT CONFIGURATION CORRUPTS FILES — the whole reason this module exists', () => {
    /**
     * Every CodeMirror example on the internet omits `lineSeparator`. This asserts what that costs,
     * so nobody deletes the setting as noise: a CRLF file loaded and saved by a stock editor comes
     * back as a different file, on every line, silently.
     */
    expect(roundTrip('a\r\nb\r\nc\r\n', undefined)).toBe('a\nb\nc\n')
    expect(roundTrip('a\rb\rc\r', undefined)).toBe('a\nb\nc\n')
    expect(roundTrip('a\r\nb\nc\r\n', undefined)).toBe('a\nb\nc\n')

    const corrupted = Object.entries(HAZARDS).filter(([, input]) => roundTrip(input, undefined) !== input)
    expect(corrupted.map(([name]) => name)).toEqual([
      'pure CRLF',
      'lone CR, classic Mac',
      'mixed CRLF and LF',
      'a stray CR at end of file',
      'CRLF with no trailing newline',
      'a lone CR immediately before a CRLF',
    ])
  })

  it('an edit to one line leaves every other byte alone, CR included', () => {
    const state = EditorState.create({
      doc: 'first\r\nsecond\r\nthird\r\n',
      extensions: [EditorState.lineSeparator.of(LINE_SEPARATOR)],
    })
    // The CR is the last character of the line's own text — this is what "the buffer is the file's
    // text" means in practice, and it is what the decoration layer has to know about.
    expect(state.doc.line(2).text).toBe('second\r')

    const line = state.doc.line(2)
    const edited = state.update({
      changes: { from: line.from, to: line.to - 1, insert: 'CHANGED' },
    })
    expect(edited.state.doc.toString()).toBe('first\r\nCHANGED\r\nthird\r\n')
  })
})

describe('which ending a newly typed line should use', () => {
  it('follows what the document already does', () => {
    expect(dominantLineEnding('a\r\nb\r\n')).toBe('\r\n')
    expect(dominantLineEnding('a\nb\n')).toBe('\n')
    expect(dominantLineEnding('a\rb\r')).toBe('\r')
  })

  it('follows the majority when a document is mixed', () => {
    expect(dominantLineEnding('a\r\nb\r\nc\r\nd\n')).toBe('\r\n')
    expect(dominantLineEnding('a\nb\nc\nd\r\n')).toBe('\n')
  })

  it('defaults to LF on a tie, an empty document, and one with no newline at all', () => {
    // A tie decided by source order is a coin flip nobody knows they are tossing.
    expect(dominantLineEnding('a\r\nb\n')).toBe('\n')
    expect(dominantLineEnding('')).toBe('\n')
    expect(dominantLineEnding('one line')).toBe('\n')
  })

  it('does not count the CR of a CRLF as a lone CR', () => {
    // The counting bug that would make every CRLF file look like a classic-Mac file.
    expect(dominantLineEnding('a\r\nb\r\nc\r\n')).not.toBe('\r')
  })

  it('handles a CR that is genuinely alone next to CRLFs', () => {
    // "\r\r\n" is a lone CR followed by a CRLF, not two CRLFs and not one CR.
    expect(dominantLineEnding('a\r\r\nb\r\nc\r\n')).toBe('\r\n')
  })
})
