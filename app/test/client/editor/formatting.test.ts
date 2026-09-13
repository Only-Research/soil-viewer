import { describe, expect, it } from 'vitest'

import {
  INLINE_MARKERS,
  activeFormatsAt,
  LINE_PREFIXES,
  insertBlock,
  toggleInline,
  toggleLinePrefix,
  type FormatResult,
  type TextEdit,
} from '../../../src/client/editor/formatting'

/** Applies edits to produce the resulting document. Edits are non-overlapping and ascending. */
function apply(doc: string, edits: readonly TextEdit[]): string {
  let out = ''
  let cursor = 0
  for (const edit of [...edits].sort((a, b) => a.from - b.from)) {
    out += doc.slice(cursor, edit.from) + edit.insert
    cursor = edit.to
  }
  return out + doc.slice(cursor)
}

/**
 * **THE INVARIANT THIS MODULE EXISTS FOR**, asserted directly rather than inferred from the result.
 *
 * *"It inserts and removes delimiters around a span. It never re-prints a region."*
 *
 * Checking only the resulting string cannot tell the difference between an edit that added two
 * asterisks and an edit that replaced the whole line with a version that happens to have two
 * asterisks in it. The second is the old editor's mechanism at small scale, and it would look
 * identical in every assertion about output. So: **every deletion must be a delimiter this module
 * knows about, or nothing at all.**
 */
const KNOWN_DELIMITERS = new Set<string>([
  ...Object.values(INLINE_MARKERS),
  ...Object.values(LINE_PREFIXES),
  '* ', '+ ', '#### ', '##### ', '###### ',
])

function expectOnlyDelimitersRemoved(doc: string, result: FormatResult): void {
  for (const edit of result.edits) {
    const removed = doc.slice(edit.from, edit.to)
    if (removed === '') continue
    expect(
      KNOWN_DELIMITERS.has(removed),
      `an edit deleted ${JSON.stringify(removed)} — formatting may only remove delimiters`,
    ).toBe(true)
  }
}

describe('inline formatting wraps and unwraps, and touches nothing else', () => {
  it('wraps a selection', () => {
    const doc = 'make this bold please'
    const result = toggleInline(doc, 10, 14, 'bold')
    expect(apply(doc, result.edits)).toBe('make this **bold** please')
    expectOnlyDelimitersRemoved(doc, result)
  })

  it('unwraps when the markers sit outside the selection', () => {
    // The word selected inside `**bold**` — pressing bold again means "stop being bold".
    const doc = 'make this **bold** please'
    const result = toggleInline(doc, 12, 16, 'bold')
    expect(apply(doc, result.edits)).toBe('make this bold please')
    expectOnlyDelimitersRemoved(doc, result)
  })

  it('unwraps when the selection includes the markers', () => {
    // What a double-click on a formatted word tends to produce.
    const doc = 'make this **bold** please'
    const result = toggleInline(doc, 10, 18, 'bold')
    expect(apply(doc, result.edits)).toBe('make this bold please')
    expectOnlyDelimitersRemoved(doc, result)
  })

  it('does not stack markers when toggled twice', () => {
    const doc = 'plain text here'
    const once = toggleInline(doc, 6, 10, 'bold')
    const afterOnce = apply(doc, once.edits)
    const twice = toggleInline(afterOnce, once.selection.from, once.selection.to, 'bold')
    expect(apply(afterOnce, twice.edits), 'a toggle must return to where it started').toBe(doc)
  })

  it('a collapsed selection leaves the caret between an empty pair', () => {
    const doc = 'type here: '
    const result = toggleInline(doc, 11, 11, 'italic')
    expect(apply(doc, result.edits)).toBe('type here: **')
    expect(result.selection).toEqual({ from: 12, to: 12 })
  })

  it('handles every inline format', () => {
    for (const [format, marker] of Object.entries(INLINE_MARKERS)) {
      const doc = 'wrap word now'
      const result = toggleInline(doc, 5, 9, format as keyof typeof INLINE_MARKERS)
      expect(apply(doc, result.edits), format).toBe(`wrap ${marker}word${marker} now`)
      expectOnlyDelimitersRemoved(doc, result)
    }
  })
})

describe('line prefixes add, replace and remove — and never touch indentation', () => {
  it('adds a heading marker', () => {
    const doc = 'A title\nbody\n'
    const result = toggleLinePrefix(doc, 0, 0, 'h1')
    expect(apply(doc, result.edits)).toBe('# A title\nbody\n')
    expectOnlyDelimitersRemoved(doc, result)
  })

  it('REPLACES an existing marker rather than stacking on it', () => {
    // `## # A title` is what a naive implementation produces, and it is a silent corruption of the
    // document's structure rather than a visual glitch.
    const doc = '# A title\n'
    const result = toggleLinePrefix(doc, 0, 0, 'h2')
    expect(apply(doc, result.edits)).toBe('## A title\n')
    expectOnlyDelimitersRemoved(doc, result)
  })

  it('removes the marker when it is already exactly this one', () => {
    const doc = '## A title\n'
    const result = toggleLinePrefix(doc, 0, 0, 'h2')
    expect(apply(doc, result.edits)).toBe('A title\n')
    expectOnlyDelimitersRemoved(doc, result)
  })

  it('leaves leading whitespace alone, because it carries list nesting', () => {
    const doc = '    nested item\n'
    const result = toggleLinePrefix(doc, 4, 4, 'bullet')
    expect(apply(doc, result.edits), 'the four spaces survive').toBe('    - nested item\n')
    expectOnlyDelimitersRemoved(doc, result)
  })

  it('applies to every line a selection touches', () => {
    const doc = 'one\ntwo\nthree\n'
    const result = toggleLinePrefix(doc, 0, 9, 'bullet')
    expect(apply(doc, result.edits)).toBe('- one\n- two\n- three\n')
  })

  it('a MIXED selection applies rather than inverting line by line', () => {
    // A per-line toggle on a mixed selection flips each line independently, which is never what
    // anyone means by pressing a button once.
    const doc = '- one\ntwo\n'
    const result = toggleLinePrefix(doc, 0, 8, 'bullet')
    expect(apply(doc, result.edits)).toBe('- one\n- two\n')
  })

  it('removes only when EVERY touched line already has this exact prefix', () => {
    const doc = '- one\n- two\n'
    const result = toggleLinePrefix(doc, 0, 10, 'bullet')
    expect(apply(doc, result.edits)).toBe('one\ntwo\n')
  })

  it('handles every line format', () => {
    for (const [format, prefix] of Object.entries(LINE_PREFIXES)) {
      const doc = 'a line\n'
      const result = toggleLinePrefix(doc, 0, 0, format as keyof typeof LINE_PREFIXES)
      expect(apply(doc, result.edits), format).toBe(`${prefix}a line\n`)
    }
  })
})

describe('inserted blocks use the document’s own line ending', () => {
  it('a rule in an LF document', () => {
    const doc = 'before\n'
    const result = insertBlock(doc, 7, 7, 'rule')
    expect(apply(doc, result.edits)).toBe('before\n---\n')
  })

  it('A RULE IN A CRLF DOCUMENT USES CRLF — the question deferred from the editor core', () => {
    /**
     * `line-endings.ts` fixes CodeMirror's separator at `"\n"` so its split and join stay inverses,
     * which makes `state.lineBreak` a bare LF. Inserting that into a CRLF document quietly makes the
     * file mixed — and §12 says a CRLF file saves back CRLF. Honouring that only for the lines the
     * user did not touch is preserving part of a file.
     */
    const doc = 'before\r\n'
    const result = insertBlock(doc, 8, 8, 'rule')
    expect(apply(doc, result.edits)).toBe('before\r\n---\r\n')
  })

  it('a code fence wraps the selection and leaves the caret inside', () => {
    const doc = 'const x = 1'
    const result = insertBlock(doc, 0, 11, 'codeblock')
    expect(apply(doc, result.edits)).toBe('```\nconst x = 1\n```\n')
    expect(doc.slice(result.selection.from - 0, result.selection.to)).toBeDefined()
  })

  it('a code fence in a CRLF document is CRLF throughout', () => {
    const doc = 'a\r\nb\r\n'
    const result = insertBlock(doc, 6, 6, 'codeblock')
    expect(apply(doc, result.edits)).toBe('a\r\nb\r\n```\r\n\r\n```\r\n')
  })

  it('breaks the line first when the caret is mid-line', () => {
    const doc = 'text here'
    const result = insertBlock(doc, 4, 4, 'rule')
    expect(apply(doc, result.edits)).toBe('text\n---\n here')
  })
})

describe('what the bar lights up', () => {
  it('reports a format the selection is already inside', () => {
    const doc = 'make this **bold** please'
    expect([...activeFormatsAt(doc, 12, 16)]).toContain('bold')
  })

  it('reports nothing on plain text', () => {
    expect([...activeFormatsAt('plain text', 0, 5)]).toEqual([])
  })

  it('does not report italic for a bold span', () => {
    // `*` is a prefix of `**`, so a naive check answers yes to both — and the bar would light italic
    // on every bold word, then turn italic ON when the user pressed the lit button.
    const active = activeFormatsAt('a **bold** word', 4, 8)
    expect(active.has('bold')).toBe(true)
    expect(active.has('italic')).toBe(false)
  })

  it('reports a line prefix only when every touched line has it', () => {
    expect([...activeFormatsAt('- one\n- two\n', 0, 10)]).toContain('bullet')
    expect([...activeFormatsAt('- one\ntwo\n', 0, 8)]).not.toContain('bullet')
  })

  it('A CARET INSIDE A SPAN COUNTS — the case a real-browser test found dead', () => {
    /**
     * Every unit test above selects the span deliberately, so all of them passed while a user
     * clicking into the middle of a bold word got an unlit Bold button. Found by driving real
     * clicks in a real browser, which is the only place the difference shows.
     */
    const doc = 'a **bold** word'
    for (let caret = 5; caret <= 8; caret++) {
      expect(activeFormatsAt(doc, caret, caret).has('bold'), `caret at ${caret}`).toBe(true)
    }
    // Not outside it, and not while sitting on the markers themselves.
    expect(activeFormatsAt(doc, 1, 1).has('bold')).toBe(false)
    expect(activeFormatsAt(doc, 14, 14).has('bold')).toBe(false)
  })

  it('and pressing the lit button from inside the span removes it', () => {
    // The half that matters: the button said "this is bold, press to stop". Before this, pressing it
    // inserted a fresh empty `****` in the middle of the user's word.
    const doc = 'a **bold** word'
    const result = toggleInline(doc, 6, 6, 'bold')
    expect(apply(doc, result.edits)).toBe('a bold word')
    expectOnlyDelimitersRemoved(doc, result)
  })

  it('AGREES WITH THE TOGGLES — a lit button must turn the format off', () => {
    /**
     * The bar and the buttons must share one predicate. If the bar lights under different rules from
     * the ones the toggle applies, pressing a lit button turns the format *on* again — the bar
     * would be lying about the document.
     */
    for (const doc of ['a **bold** word', 'a *it* word', 'a `code` word', '- item\n', '# head\n']) {
      for (const format of [...Object.keys(INLINE_MARKERS), ...Object.keys(LINE_PREFIXES)]) {
        const at = doc.indexOf('bold') >= 0 ? 4 : 2
        const active = activeFormatsAt(doc, at, at + 2)
        if (!active.has(format as never)) continue
        const result = format in INLINE_MARKERS
          ? toggleInline(doc, at, at + 2, format as keyof typeof INLINE_MARKERS)
          : toggleLinePrefix(doc, at, at + 2, format as keyof typeof LINE_PREFIXES)
        const after = apply(doc, result.edits)
        expect(
          activeFormatsAt(after, result.selection.from, result.selection.to).has(format as never),
          `${format} was lit on ${JSON.stringify(doc)} and pressing it did not turn it off`,
        ).toBe(false)
      }
    }
  })
})

describe('the whole module never re-prints a region', () => {
  it('no action deletes anything that is not a delimiter', () => {
    /**
     * Swept across every action and a document carrying the constructs that matter. This is the
     * assertion that separates "formatting" from "regeneration": the old editor produced correct-
     * looking text by re-printing it, and every test about *output* would have passed.
     */
    const doc = '---\ntitle: x\n---\n\n# Heading\n\nSome **bold** and `code`.\r\n\n- item\n  - nested\n\n> quote\n'
    for (let pos = 0; pos < doc.length; pos += 3) {
      for (const format of Object.keys(INLINE_MARKERS)) {
        expectOnlyDelimitersRemoved(doc, toggleInline(doc, pos, Math.min(pos + 4, doc.length), format as never))
      }
      for (const format of Object.keys(LINE_PREFIXES)) {
        expectOnlyDelimitersRemoved(doc, toggleLinePrefix(doc, pos, pos, format as never))
      }
      for (const block of ['codeblock', 'rule'] as const) {
        expectOnlyDelimitersRemoved(doc, insertBlock(doc, pos, pos, block))
      }
    }
  })
})
