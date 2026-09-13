import { markdownLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'

import {
  planDecorations,
  type PlannedDecoration,
  type Range,
} from '../../../src/client/editor/plan-decorations'

const planFor = (text: string, revealed: readonly Range[] = []): PlannedDecoration[] =>
  planDecorations(text, markdownLanguage.parser.parse(text), revealed)

const hidden = (plan: readonly PlannedDecoration[], text: string): string[] =>
  plan.filter(d => d.kind === 'hide').map(d => text.slice(d.from, d.to))

const classes = (plan: readonly PlannedDecoration[]): string[] =>
  plan.flatMap(d => (d.kind === 'hide' ? [] : [d.className]))

describe('the live preview plan', () => {
  /**
   * **The marker AND the space behind it.** Changed 2026-08-22, and the old expectation was `['#']`.
   *
   * the operator: *"the titles are indenting, which looks weird… it should be very flat."* Hiding the
   * hash alone leaves its trailing space standing, so every heading sits one space right of every
   * paragraph — small, present on every heading at once, and reading as the app being out of true
   * rather than as a bug.
   *
   * **The renderer already trimmed exactly this** and says why: *"that space is punctuation rather
   * than the first character of the heading."* `editor.css` opens by claiming there is one surface
   * and no second path to disagree with. This was the two paths disagreeing.
   */
  it('hides a heading marker AND the space behind it, so the title starts flat', () => {
    const text = '# Title\n'
    const plan = planFor(text)
    expect(hidden(plan, text)).toEqual(['# '])
    expect(classes(plan)).toContain('cm-soil-h1')
  })

  it('takes every space when a heading is written with several', () => {
    const text = '#   Roomy\n'
    expect(hidden(planFor(text), text)).toEqual(['#   '])
  })

  /**
   * **No mutation reddens this one, and that is stated rather than implied.** The reach only ever
   * extends forwards, so the space before a closing mark is never in danger — a guard written for
   * exactly this was deleted once mutation showed it changed nothing. The case is kept because it
   * pins the direction: making the reach bidirectional would break it.
   */
  it('does not eat the space in FRONT of a closing marker', () => {
    const text = '# Title #\n'
    expect(hidden(planFor(text), text), 'the closing hash hides alone')
      .toEqual(['# ', '#'])
  })

  it('leaves a hash that is not a heading alone', () => {
    const text = 'a # b\n'
    expect(hidden(planFor(text), text)).toEqual([])
  })

  it('reveals the raw syntax on the line the cursor is on, but keeps the styling', () => {
    const text = '# Title\n'
    // §12: the styling must not lift with the concealment, or the line changes size as the caret
    // enters it and the document jumps under the user's hands.
    const plan = planFor(text, [{ from: 0, to: 7 }])
    expect(hidden(plan, text)).toEqual([])
    expect(classes(plan)).toContain('cm-soil-h1')
  })

  it('reveals only the cursor’s line, not its neighbours', () => {
    const text = '# One\n## Two\n'
    const plan = planFor(text, [{ from: 0, to: 5 }])
    expect(hidden(plan, text)).toEqual(['## '])
  })

  it('hides emphasis, strong and strikethrough markers and styles what they wrap', () => {
    const text = 'some *italic* and **bold** and ~~struck~~ text\n'
    const plan = planFor(text)
    expect(hidden(plan, text)).toEqual(['*', '*', '**', '**', '~~', '~~'])
    expect(classes(plan)).toEqual(
      expect.arrayContaining(['cm-soil-em', 'cm-soil-strong', 'cm-soil-strike']),
    )
  })

  /**
   * **REVERSED 2026-08-26, and the old assertion is quoted here rather than deleted.**
   *
   * This used to read *"styles inline code without hiding the fence of a code block"*, asserting
   * `hidden(plan, fenced)` was empty, under the comment: *"the fence delimiters stay visible:
   * hiding them makes it impossible to see where code begins and ends while editing it."*
   *
   * That was true of a block drawn with side borders only — the backticks were the only thing
   * marking its ends. The block now closes: the planner puts `cm-soil-fence-top` and
   * `cm-soil-fence-bottom` on its first and last lines, so the border says where the code starts
   * and stops. The reason for showing them went away in the same change that hid them.
   *
   * the operator's standard, 2026-08-26: *"Typora is the gold standard we're aiming for across
   * everything"* — and Typora shows neither the fence nor the inline backticks.
   */
  it('hides the backticks of a fenced block, and closes the box in their place', () => {
    const fenced = '```js\nconst x = 1\n```\n'
    const plan = planFor(fenced)

    expect(hidden(plan, fenced)).toEqual(['```', '```'])
    expect(classes(plan)).toContain('cm-soil-fence')
    // The ends are what make hiding the delimiters safe, so they are asserted together with it.
    expect(classes(plan)).toContain('cm-soil-fence-top')
    expect(classes(plan)).toContain('cm-soil-fence-bottom')
  })

  /** The language stays on screen, as a label rather than as the code's first line. */
  it('keeps a fenced block’s language and styles it as a label', () => {
    expect(classes(planFor('```js\nconst x = 1\n```\n'))).toContain('cm-soil-fence-lang')
  })

  /** Inline code is the same node name, and Typora hides its backticks too. */
  it('hides inline backticks and styles what they wrap', () => {
    const text = 'call `fn()` here\n'
    const plan = planFor(text)
    expect(classes(plan)).toContain('cm-soil-code')
    expect(hidden(plan, text)).toEqual(['`', '`'])
  })

  /**
   * A one-line block is its own top and bottom. Worth pinning because the natural implementation —
   * one class at the start, one at the end — is exactly the shape that would drop one of them.
   */
  it('gives a one-line indented block both ends', () => {
    const plan = planFor('    indented code\n')
    expect(classes(plan)).toContain('cm-soil-fence-top')
    expect(classes(plan)).toContain('cm-soil-fence-bottom')
  })

  it('shows a link’s text and hides its plumbing', () => {
    const text = 'an [inline](http://example.com) link\n'
    const plan = planFor(text)
    expect(hidden(plan, text)).toEqual(['[', ']', '(', 'http://example.com', ')'])
  })

  it('styles a table for monospace and never proposes a grid', () => {
    const text = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    const plan = planFor(text)
    expect(classes(plan)).toContain('cm-soil-table')
    /**
     * §12: an editable grid is the one feature that reintroduces markdown regeneration. Nothing in
     * a plan can restructure anything — the operations are hide, mark, line and swap.
     *
     * **`swap` was added to this list in 2026-08-26 rather than left off it.** It draws a glyph the
     * document does not contain, which sounds like the exception; it is not. It conceals a range and
     * paints beside it, exactly as `hide` does, and carries the glyph as data rather than writing it
     * anywhere. Leaving it out would have made this assertion pass by accident on a table — which
     * contains no lists — while quietly ceasing to be the general claim it reads as.
     */
    expect(plan.every(d => ['hide', 'mark', 'line', 'swap'].includes(d.kind))).toBe(true)
  })

  it('NEVER hides brackets around ordinary prose — the case the wikilink exposed', () => {
    /**
     * CommonMark parses any bracketed text as a shortcut reference link, so `[draft]` arrives as a
     * `Link` with two `LinkMark` children and no destination. Concealing those would render
     * `[draft]` as `draft`: **the document would look like it had lost characters it still
     * contains**, which is exactly the experience the old app gave and the reason nobody noticed
     * for months.
     *
     * Bracketed prose is common in an agent-written tree, so this is the general case and the
     * wikilink below is one instance of it.
     */
    for (const text of [
      'a note marked [draft] here\n',
      'see [TODO] and [WIP]\n',
      'a reference-style [link][1] with no inline url\n',
      'array-ish prose [a, b] in a sentence\n',
    ]) {
      expect(hidden(planFor(text), text), text).toEqual([])
    }
  })

  it('still hides the plumbing of a link that has somewhere to go', () => {
    const text = 'an [inline](http://example.com) link and an ![image](pic.png)\n'
    expect(hidden(planFor(text), text)).toEqual([
      '[', ']', '(', 'http://example.com', ')',
      '![', ']', '(', 'pic.png', ')',
    ])
  })

  it('leaves a construct it does not know about completely alone', () => {
    // §19: "A construct the renderer doesn't style is displayed unstyled — it is never damaged."
    // Wikilinks are not GFM and the parser produces no node for them; 5.4% of the real tree has
    // them, so this is a real case rather than a hypothetical.
    const text = 'a [[wiki link]] here\n'
    expect(hidden(planFor(text), text)).toEqual([])
  })
})

/**
 * The 944-file case. Half of the user's tree carries frontmatter, and `@lezer/markdown` parses it as
 * `HorizontalRule` + `SetextHeading2` — the exact shape the old app rendered those files into.
 */
describe('frontmatter is a properties block, never a rule plus a heading', () => {
  const DOC = '---\ntitle: Test Doc\ntags: [a, b]\n---\n\n# Heading\n\nBody.\n'

  it('claims the whole block and discards what the parser found inside it', () => {
    const blockEnd = DOC.indexOf('---\n\n') + 3
    const plan = planFor(DOC)

    const frontmatter = plan.find(d => d.kind === 'mark' && d.className === 'cm-soil-frontmatter')
    expect(frontmatter, 'the block is claimed').toBeDefined()
    expect(frontmatter?.from).toBe(0)
    expect(frontmatter?.kind === 'mark' ? frontmatter.to : -1).toBe(blockEnd)

    /**
     * **The 944-file assertion.** Left to the tree, this block is a `HorizontalRule` followed by a
     * `SetextHeading2` — so without the override, `cm-soil-h2` lands here and the user's YAML is
     * drawn as a giant heading, which is what the old app's output looked like.
     *
     * Everything inside the block, other than the block's own decorations, must be nothing.
     */
    const inside = plan
      .filter(d => d !== frontmatter && d.from < blockEnd)
      .filter(d => !(d.kind === 'hide' && (d.to === blockEnd || d.from === 0)))
    expect(inside, 'nothing inside frontmatter is decorated from the tree').toEqual([])
  })

  it('does not treat the bracketed YAML value as a link', () => {
    // `tags: [a, b]` parses as a Link, which is why the old regenerator escaped the brackets and
    // wrote `\[a, b\]` back to disk. Nothing inside the block may be hidden as link plumbing.
    const text = DOC
    expect(hidden(planFor(text), text).join('')).not.toContain('[')
  })

  it('still styles the real heading that follows the block', () => {
    expect(classes(planFor(DOC))).toContain('cm-soil-h1')
  })

  it('leaves an ordinary thematic break alone', () => {
    // `---` in the middle of a document is a rule, not frontmatter — the distinction the old app
    // could not make.
    const text = '# Title\n\n---\n\nMore.\n'
    const plan = planFor(text)
    expect(classes(plan)).not.toContain('cm-soil-frontmatter')
  })

  it('does not claim an unterminated block', () => {
    // An opening `---` with no close is a thematic break followed by content. Swallowing the
    // document into a properties block would be worse than the bug this replaces.
    const text = '---\nnot really frontmatter\n\n# Heading\n'
    expect(classes(planFor(text))).not.toContain('cm-soil-frontmatter')
  })

  it('recognises frontmatter in a CRLF document', () => {
    // The CR lives in the buffer as ordinary text, so `"---\r"` is what line one actually holds.
    // A matcher that missed it would fail on every CRLF file while passing every test.
    const text = '---\r\ntitle: x\r\n---\r\n\r\n# H\r\n'
    expect(classes(planFor(text))).toContain('cm-soil-frontmatter')
  })

  it('closes on YAML’s `...` terminator as well as `---`', () => {
    const text = '---\ntitle: x\n...\n\n# H\n'
    expect(classes(planFor(text))).toContain('cm-soil-frontmatter')
  })
})

/**
 * **THE DRAWN-MARKER PASS.** Ruled 2026-08-22 and again on 08-26.
 *
 * Two constructs were rendering their own syntax as prose: a blockquote showed the `>` at the head
 * of every line, and a list showed a bare `-`. Both had been that way since the editor shipped, and
 * both are the last thing standing between this editor and the one they actually uses.
 *
 * The rules are not symmetrical, and the asymmetry is the point: **a quote mark is removed, a bullet
 * marker is replaced, and an ordered marker is left completely alone.** The number in `1.` is
 * content — it tells the reader they are on step nine rather than step four — and Typora leaves it
 * on screen for that reason.
 */
describe('quote marks are removed, bullets are drawn, numbers are left alone', () => {
  const swaps = (plan: readonly PlannedDecoration[]): { covered: string; glyph: string }[] =>
    plan.flatMap(d => (d.kind === 'swap' ? [{ covered: `${d.from}-${d.to}`, glyph: d.glyph }] : []))

  /**
   * The mark AND the space behind it, for the reason a heading's does: hiding `>` alone leaves every
   * quoted line sitting one space further right than the prose around it, which reads as the app
   * being slightly out of true rather than as a bug.
   *
   * MUTATION: drop `QuoteMark` from `REACHES_THROUGH_SPACE`. Must redden.
   */
  it('conceals a blockquote marker together with the space behind it', () => {
    const text = '> quoted line\n'
    expect(hidden(planFor(text), text)).toContain('> ')
  })

  /** The bar and the indent were always there; only the character was wrong. */
  it('still styles the quote line, so the bar survives the concealment', () => {
    expect(classes(planFor('> quoted line\n'))).toContain('cm-soil-quote')
  })

  /** Both levels, because a nested quote is two marks and hiding one leaves a lopsided line. */
  it('conceals every level of a nested blockquote', () => {
    const text = '> > twice quoted\n'
    expect(hidden(planFor(text), text).filter(s => s.startsWith('>'))).toHaveLength(2)
  })

  /**
   * MUTATION: return the `-` through the ordinary `hide` path instead of swapping. Must redden —
   * concealing a bullet without drawing one leaves the list with no marker at all.
   */
  it('draws a bullet where a dash was, and does not merely hide it', () => {
    const text = '- first\n- second\n'
    const plan = planFor(text)
    expect(swaps(plan).map(s => s.glyph)).toEqual(['●', '●'])
    expect(hidden(plan, text)).not.toContain('-')
  })

  /** `*` and `+` are the same construct wearing different characters. */
  it('draws a bullet for every bullet marker CommonMark allows', () => {
    expect(swaps(planFor('* star\n'))).toHaveLength(1)
    expect(swaps(planFor('+ plus\n'))).toHaveLength(1)
  })

  /**
   * **The number stays.** This is the half of the operator's description that is easiest to lose while
   * implementing the other half.
   *
   * MUTATION: swap every `ListMark` regardless of its text. Must redden.
   */
  it('leaves an ordered list\'s number completely alone', () => {
    const text = '1. first\n2. second\n'
    const plan = planFor(text)
    expect(swaps(plan)).toHaveLength(0)
    expect(hidden(plan, text)).not.toContain('1.')
    expect(hidden(plan, text)).not.toContain('2.')
  })

  /**
   * §12: raw markdown is shown on the line the cursor occupies. A bullet that stayed drawn while its
   * own line was being edited would hide the character the person is trying to delete.
   */
  it('shows the real characters on the line the cursor is on', () => {
    const text = '- item\n> quote\n'
    const onTheBullet = planFor(text, [{ from: 0, to: 6 }])
    expect(swaps(onTheBullet)).toHaveLength(0)
    expect(hidden(onTheBullet, text)).not.toContain('- ')
  })

  /**
   * **The checkbox.** Ruled 2026-08-26: *"checkboxes still x's."*
   *
   * The same `swap` the bullet uses — the machinery already existed, which is why this was one entry
   * rather than a build. State comes from the marker's own text because `TaskMarker` covers both.
   *
   * MUTATION: draw the checked glyph unconditionally. Must redden.
   */
  it('draws a box for a task marker, ticked or not', () => {
    const plan = planFor('- [ ] todo\n- [x] done\n')
    /**
     * **Two glyphs, not four.** A task line gets a box and NOT a bullet — found by looking at a
     * screenshot, where every checkbox arrived with a dot in front of it because a task item is an
     * ordinary list item that happens to contain a `Task`, so both rules fired on the same line.
     * The dash is still concealed; it just goes silently.
     *
     * MUTATION: draw the bullet on task items too. Must redden.
     */
    expect(swaps(plan).map(s => s.glyph)).toEqual(['\u2610', '\u2611'])
  })

  /** `[X]` is checked in GFM too, and reading the text case-sensitively would miss it. */
  it('treats an upper-case X as checked', () => {
    const plan = planFor('- [X] done\n')
    expect(swaps(plan).map(s => s.glyph)).toContain('\u2611')
  })

  /**
   * A ticked box takes its own class as well, so the stylesheet can mark it done without the
   * planner deciding what "done" looks like.
   */
  it('marks a ticked box with its own class', () => {
    expect(classes(planFor('- [x] done\n'))).toContain('cm-soil-task cm-soil-task-done')
    expect(classes(planFor('- [ ] todo\n'))).toContain('cm-soil-task')
  })

  /** The raw brackets come back under the caret, like every other concealed marker. */
  it('shows the real brackets on the line the cursor is on', () => {
    const text = '- [x] done\n'
    expect(swaps(planFor(text, [{ from: 0, to: text.length }]))).toHaveLength(0)
  })

  /**
   * **The document is never touched, asserted structurally rather than trusted.**
   *
   * A `swap` is the first decoration in this build that puts a character on screen which is not in
   * the file, so the invariant is worth pinning where it cannot drift: every planned range lies
   * inside the text, and the glyph is carried beside the range rather than substituted into it.
   */
  it('never plans a range outside the document', () => {
    const text = '- item\n\n> quote\n\n1. numbered\n'
    for (const d of planFor(text)) {
      expect(d.from).toBeGreaterThanOrEqual(0)
      expect(d.to).toBeLessThanOrEqual(text.length)
      expect(d.to).toBeGreaterThanOrEqual(d.from)
    }
  })
})
