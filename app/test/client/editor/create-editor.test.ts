import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorExtensions } from '../../../src/client/editor/create-editor'
import { LINE_SEPARATOR } from '../../../src/client/editor/line-endings'

/**
 * **The configuration the app actually ships, not a hand-assembled stand-in.**
 *
 * `createEditor` itself needs a DOM and cannot run here — vitest is on the `node` environment and
 * adding jsdom would be a new dependency, which is an escalation to the operator rather than a
 * convenience. That constraint is why `editorExtensions()` is exported separately: `EditorState` is
 * pure, so the byte-level property can be proven against the real extension list without a browser,
 * and the browser only has to prove the parts that genuinely need one.
 *
 * The distinction that makes this test worth having: a suite that builds its own `EditorState` with
 * `lineSeparator` set by hand proves that CodeMirror can be configured correctly. This proves that
 * **it is**.
 */
describe('the shipped extension list', () => {
  const stateFor = (doc: string): EditorState =>
    EditorState.create({ doc, extensions: editorExtensions() })

  it('sets the line separator that makes split and join inverses', () => {
    expect(stateFor('a').facet(EditorState.lineSeparator)).toBe(LINE_SEPARATOR)
  })

  it('round-trips every hazard byte-for-byte through the real configuration', () => {
    const hazards = [
      'a\nb\nc\n',
      'a\r\nb\r\nc\r\n',
      'a\rb\rc\r',
      'a\r\nb\nc\r\n',
      'a\nb',
      '﻿# BOM at the start\n',
      'hard break  \nnext\n',
      '',
      'a\n\r',
      '# Title\n\n---\ntitle: not frontmatter, a rule\n---\n',
      '---\ntitle: real frontmatter\ntags: [a, b]\n---\n\n# Heading\n\nBody.\n',
      '| a | b |\n|---|---|\n| 1 | 2 |\n',
      '```js\nconst x = "```"\n```\n',
      '- [ ] task\n- [x] done\n',
      'text with a footnote[^1]\n\n[^1]: the note\n',
      '<div align="center">raw html</div>\n',
      '日本語 — 🌱 emoji and an em dash\n',
      'trailing blanks   \n\n\n',
    ]
    for (const input of hazards) {
      expect(stateFor(input).doc.toString(), JSON.stringify(input)).toBe(input)
    }
  })

  it('the frontmatter case specifically — 944 files, and the byte count is the tell', () => {
    /**
     * The old editor turned this exact shape into a thematic break plus a level-two heading with
     * the fields collapsed onto one line and the brackets escaped: **86 bytes in, 87 out**. That
     * single transformation is the largest category of damage in the whole corpus.
     */
    const frontmatter = '---\ntitle: Test Doc\ntype: note\nstatus: active\ntags: [a, b]\n---\n\n# Heading\n\nBody text.\n'
    const out = stateFor(frontmatter).doc.toString()
    expect(out).toBe(frontmatter)
    expect(Buffer.byteLength(out, 'utf8')).toBe(Buffer.byteLength(frontmatter, 'utf8'))
    expect(out).not.toContain('\\[')
    expect(out).not.toMatch(/^## /m)
  })

  it('a document is never shorter or longer than what went in', () => {
    // The blunt property, asserted in bytes rather than characters: an editor that "cleans" a
    // document changes its length, and length is the cheapest thing to check.
    for (const input of ['a\r\nb\r\n', '﻿x', 'a  \n', 'a\n\n\n']) {
      expect(Buffer.byteLength(stateFor(input).doc.toString(), 'utf8')).toBe(
        Buffer.byteLength(input, 'utf8'),
      )
    }
  })
})
