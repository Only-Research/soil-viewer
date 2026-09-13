/**
 * **What the live preview paints, decided as data.** Spec §12.
 *
 * ## The shape, and why it is a pure function
 *
 * CodeMirror decorations need a `DecorationSet`, which needs `@codemirror/view`, which needs a DOM.
 * vitest runs on the `node` environment and adding jsdom would be a new dependency — an escalation
 * to the operator rather than a convenience. So the *decision* — which ranges get hidden, which get
 * styled, and what happens where the cursor is — is this function, and it is a plain array in and a
 * plain array out. The view layer turns the plan into decorations and does nothing else.
 *
 * That split is not a testing trick. It is the same reason `editorExtensions()` is exported apart
 * from `createEditor`: **the part that can be wrong about a document should be provable without a
 * browser**, and the part that needs a browser should be too small to be wrong.
 *
 * ## The one rule that makes this an editor and not a preview
 *
 * **A decoration never changes the document.** Hiding is `Decoration.replace`, which conceals a
 * range visually and leaves every byte where it was. There is no path from here to the buffer —
 * this function cannot reach it, and the plan it returns has no operation that could. §12's *"the
 * buffer is the file's text"* is preserved by the fact that the rendering layer has no way to
 * write.
 *
 * ## Frontmatter does not come from the tree, deliberately
 *
 * `@lezer/markdown` parses a frontmatter block as `HorizontalRule` followed by `SetextHeading2` —
 * measured 2026-08-08. That is correct CommonMark and it is also, precisely, the shape the old app
 * rendered 944 files into. Nothing is damaged, because nothing regenerates; but taking the parse at
 * face value would reproduce the old bug's *appearance* on half of the user's tree.
 *
 * So the frontmatter span comes from `core/frontmatter.ts` — the same rule `title.ts` uses — and
 * **every tree node inside that span is discarded.** Doing it in the tree instead would mean a
 * block parser that must scan forward for a closing delimiter and cannot rewind if there is none,
 * which turns an unterminated `---` into a document-swallowing properties block. The span is
 * computable from the text; the parser does not need to be involved.
 */

import type { SyntaxNode, Tree } from '@lezer/common'

import { frontmatterSpan } from '../../core/frontmatter'

/** A range in the document, in characters. */
export interface Range {
  readonly from: number
  readonly to: number
}

export type PlannedDecoration =
  /** Conceal a range — syntax marks the reader does not need to see. Never deletes. */
  | { readonly kind: 'hide'; readonly from: number; readonly to: number }
  /** Style a range inline. */
  | { readonly kind: 'mark'; readonly from: number; readonly to: number; readonly className: string }
  /**
   * Style every line the range covers.
   *
   * **`to` is carried because blocks span lines**, and the first version of this type did not have
   * it. A table, a fenced code block and a blockquote are each one node covering many lines, so a
   * single line decoration at the node's start styled the header row of a table and left its body
   * in the prose font. Caught in the browser; no unit test of the plan could see it, because the
   * plan was right and the rendering of it was not.
   */
  | { readonly kind: 'line'; readonly from: number; readonly to: number; readonly className: string }
  /**
   * Conceal a range and draw a glyph where it was. **The document is not touched** — this is
   * `Decoration.replace` with a widget, the same concealment as `hide` with something painted in
   * the gap, and the bytes stay exactly where they are.
   *
   * It exists for one thing: a list's `-` becoming a bullet. `hide` alone cannot do it, because a
   * bullet that is not in the file has to be drawn by something, and putting the character *in* the
   * file is the one thing this editor may never do.
   */
  | {
    readonly kind: 'swap'
    readonly from: number
    readonly to: number
    /** What to draw. Never inserted into the document. */
    readonly glyph: string
    readonly className: string
  }

/**
 * Tree node names whose *content* gets an inline style, and the class it gets.
 *
 * Written against a parse of every construct rather than from memory — a node name that does not
 * exist is a rule that silently never fires, which is this build's most familiar failure wearing
 * a stylesheet.
 */
const INLINE_STYLES: Readonly<Record<string, string>> = {
  Emphasis: 'cm-soil-em',
  StrongEmphasis: 'cm-soil-strong',
  Strikethrough: 'cm-soil-strike',
  InlineCode: 'cm-soil-code',
  /**
   * The language written after the opening backticks. Kept on screen — Typora shows it too — but
   * styled as a label rather than as the first line of the code, since with the backticks concealed
   * it would otherwise read as a stray word sitting inside the box.
   */
  CodeInfo: 'cm-soil-fence-lang',
}

/** Block node names whose lines get a class. */
const BLOCK_STYLES: Readonly<Record<string, string>> = {
  ATXHeading1: 'cm-soil-h1',
  ATXHeading2: 'cm-soil-h2',
  ATXHeading3: 'cm-soil-h3',
  ATXHeading4: 'cm-soil-h4',
  ATXHeading5: 'cm-soil-h5',
  ATXHeading6: 'cm-soil-h6',
  SetextHeading1: 'cm-soil-h1',
  SetextHeading2: 'cm-soil-h2',
  Blockquote: 'cm-soil-quote',
  FencedCode: 'cm-soil-fence',
  CodeBlock: 'cm-soil-fence',
  /** §12: tables are styled monospace, aligned, edited as pipes. No editable grid, ever. */
  Table: 'cm-soil-table',
}

/**
 * Marker nodes that are concealed when the cursor is elsewhere.
 *
 * **`CodeMark` was deliberately absent until 2026-08-26, and the reason it is here now is that the
 * reason it was absent stopped being true.** The old note read: *"it delimits a fenced block, and
 * hiding the fence makes it impossible to see where code begins and ends while editing it."* That
 * was correct while a fenced block was drawn with side borders only — the backticks were the only
 * thing marking its ends.
 *
 * The block now closes: `cm-soil-fence-top` and `cm-soil-fence-bottom` put a real border and a
 * rounded corner on the first and last lines, so the box itself shows where the code starts and
 * stops. The marker became redundant in the same change that made it removable.
 *
 * This covers inline backticks too, which is the same construct and the same node name. Both match
 * the operator's standard: *"Typora is the gold standard we're aiming for across everything"* — and
 * Typora shows neither.
 */
const HIDDEN_MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  /**
   * **The `>` of a blockquote.** Added 2026-08-26 — the operator had been reading them as literal text
   * since the editor shipped.
   *
   * The bar and the indent were already there: `cm-soil-quote` has drawn them since P6, so a quote
   * has always *looked* like a quote and also carried a stray `>` at the head of every line. Hiding
   * the mark is the whole of the change, and the mark reaches through the space behind it for the
   * same reason a heading's does — see `concealedTo`.
   */
  'QuoteMark',
  'CodeMark',
])

/**
 * Block nodes whose FIRST and LAST lines get their own class on top of the block's.
 *
 * A line decoration styles one line, so a multi-line block drawn with `border-inline` alone has open
 * ends — it reads as a column, not a box. These two classes are what close it: the top and bottom
 * borders and the rounded corners land on exactly one line each.
 *
 * It is also what made hiding the backticks safe. See `HIDDEN_MARKS`.
 */
const BLOCK_ENDS: Readonly<Record<string, readonly [string, string]>> = {
  FencedCode: ['cm-soil-fence-top', 'cm-soil-fence-bottom'],
  CodeBlock: ['cm-soil-fence-top', 'cm-soil-fence-bottom'],
}

/**
 * Bullet markers, and the glyph drawn where they were.
 *
 * **Only these three.** An ordered list's marker is `1.`, and the number is *content* — Typora
 * leaves it on screen and so does this. Concealing it would take away the one thing that tells a
 * reader whether they are looking at step four or step nine.
 */
const BULLET_MARKERS = new Set(['-', '*', '+'])
const BULLET_GLYPH = '\u25CF'

/**
 * **A task list's `[ ]` and `[x]`, drawn as boxes.** Ruled 2026-08-26: *"checkboxes still x's."*
 *
 * The same `swap` the bullet uses, which is the whole reason this was small \u2014 the machinery for
 * drawing a glyph the document does not contain already existed, and this is one more entry.
 *
 * **The box is drawn, not clickable, and the distinction is deliberate rather than unfinished.**
 * Ticking one by clicking would mean the display layer writing to the document, and `decorations.ts`
 * holds the opposite as a rule: *"nothing here can change the document\u2026 there is no transaction
 * dispatched from this file, and that is what keeps \u00A712's 'the buffer is the file's text' true no
 * matter what the preview does."* Breaking that is a change worth making on its own terms, with its
 * own care, not smuggled in beside a glyph. Ticking a box today means editing the line, which is
 * what every other construct in this editor asks of you.
 *
 * Checked state is read from the marker's own text, because `TaskMarker` covers both \u2014 verified
 * against a real parse rather than assumed: `- [x] done` yields `ListMark "-"`, `Task "[x] done"`,
 * `TaskMarker "[x]"`.
 */
const TASK_CHECKED_GLYPH = '\u2611'
const TASK_UNCHECKED_GLYPH = '\u2610'

/**
 * Link plumbing — hidden **only inside a link that has somewhere to go.**
 *
 * The distinction was found by a test, and it matters far more than links do. CommonMark parses
 * *any* bracketed text as a shortcut reference link: `[draft]`, `[TODO]`, `[a, b]` in a YAML value,
 * all of them arrive as `Link` with two `LinkMark` children and no destination. Hiding LinkMark
 * unconditionally would render `[draft]` as `draft` — **the document would appear to have lost
 * characters it still contains**, which is the precise experience the old app gave and the reason
 * nobody noticed for months.
 *
 * The case that exposed it was `[[wiki link]]`, 5.4% of the real tree: the inner `[wiki link]`
 * parses as a shortcut link, so hiding its marks left one unbalanced bracket pair on screen.
 *
 * The rule: a `Link` or `Image` earns concealment only when it contains a `URL` child. Everything
 * else renders exactly as typed, which is §19's principle — *a construct the renderer doesn't style
 * is displayed unstyled, never damaged.*
 */
const LINK_PLUMBING = new Set(['LinkMark', 'URL'])

/** Ranges of links that have a destination, and whose plumbing may therefore be concealed. */
function linksWithDestinations(tree: Tree): Range[] {
  const ranges: Range[] = []
  tree.iterate({
    enter: node => {
      if (node.name !== 'Link' && node.name !== 'Image') return true
      for (let child = node.node.firstChild; child !== null; child = child.nextSibling) {
        if (child.name === 'URL') {
          ranges.push({ from: node.from, to: node.to })
          break
        }
      }
      return true
    },
  })
  return ranges
}

function overlaps(a: Range, b: Range): boolean {
  return a.from < b.to && b.from < a.to
}

/**
 * Is this `ListMark` the dash of a task item?
 *
 * Asked of the tree rather than of the text, because `- [x]` and `- \[x\]` and a line merely
 * *beginning* with a bracket are three different documents and only the parser can tell them apart.
 * A task item is a `ListItem` with a `Task` child; the mark's parent is that item.
 */
function isTaskItem(mark: SyntaxNode): boolean {
  const item = mark.parent
  if (item === null) return false
  for (let child = item.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === 'Task') return true
  }
  return false
}

/**
 * Builds the plan.
 *
 * `revealed` is the set of ranges — in practice, the lines the cursor and selection touch — where
 * raw markdown is shown as typed. §12: *"raw markdown is revealed only on the line the cursor
 * occupies"*. Styling still applies there; only the concealment lifts, so a line does not jump
 * between two typographic treatments as the caret enters it.
 */
export function planDecorations(
  text: string,
  tree: Tree,
  revealed: readonly Range[] = [],
): PlannedDecoration[] {
  const plan: PlannedDecoration[] = []
  const isRevealed = (from: number, to: number): boolean =>
    revealed.some(r => overlaps({ from, to }, r))

  /**
   * The frontmatter block, from the shared rule rather than from the tree. Its lines are styled as
   * a properties block and **everything the parser found inside it is ignored** — which is what
   * stops half the tree rendering as a thematic break plus a giant heading made of the user's own
   * metadata.
   */
  const frontmatter = frontmatterSpan(text)
  if (frontmatter !== null) {
    plan.push({ kind: 'mark', from: frontmatter.from, to: frontmatter.to, className: 'cm-soil-frontmatter' })
    // The delimiters themselves are noise once the block is visibly a block, unless the cursor is
    // in there — in which case the user is editing YAML and needs to see its fences.
    if (!isRevealed(frontmatter.from, frontmatter.to)) {
      plan.push({ kind: 'hide', from: frontmatter.from, to: frontmatter.openTo })
      plan.push({ kind: 'hide', from: frontmatter.closeFrom, to: frontmatter.to })
    }
  }
  const insideFrontmatter = (from: number, to: number): boolean =>
    frontmatter !== null && from < frontmatter.to && frontmatter.from <= from && to <= frontmatter.to

  const linkable = linksWithDestinations(tree)
  const inALinkWithADestination = (from: number, to: number): boolean =>
    linkable.some(r => r.from <= from && to <= r.to)

  /**
   * **How far a hidden mark actually reaches**, and for a heading that is further than the mark.
   *
   * ruled 2026-08-22: *"the titles are indenting, which looks weird… it should be very flat."*
   *
   * `# Heading` parses as a `HeaderMark` covering the `#` and nothing else, so hiding the node hides
   * the hash and leaves **the space behind it** — and every heading in the document sits one space
   * further right than every paragraph. It is small, it is on every heading at once, and it reads as
   * the app being slightly out of true rather than as a bug.
   *
   * **The rendering path already had this right**, which is what makes it a defect rather than a
   * preference: `markdown.ts` trims exactly this whitespace and says why — *"that space is
   * punctuation rather than the first character of the heading."* The editor simply never did the
   * same, and `editor.css` opens by claiming there is one surface and no second stylesheet to
   * disagree with. This is the two paths disagreeing.
   *
   * **It reaches FORWARD only, and a start-of-line guard was written here and then deleted.** The
   * worry was the closing `##` in `## Heading ##` — that eating the space in front of it would pull
   * the last word into the hidden range. It cannot: this only ever extends `to`, never `from`, so
   * the space before a closing mark is never in reach. Mutation proved the guard changed nothing,
   * and a line that cannot fail is one more thing to read and believe.
   */
  const REACHES_THROUGH_SPACE = new Set(['HeaderMark', 'QuoteMark', 'ListMark'])
  const concealedTo = (name: string, to: number, source: string): number => {
    if (!REACHES_THROUGH_SPACE.has(name)) return to
    let reach = to
    while (reach < source.length && (source[reach] === ' ' || source[reach] === '\t')) reach += 1
    return reach
  }

  tree.iterate({
    enter: node => {
      const { name, from, to } = node
      if (insideFrontmatter(from, to)) return false

      const block = BLOCK_STYLES[name]
      if (block !== undefined) plan.push({ kind: 'line', from, to, className: block })

      /**
       * Zero-length ranges, deliberately: the renderer turns a `line` plan into one decoration per
       * line the range covers, so `from..from` is exactly the first line and `to..to` exactly the
       * last. A one-line block gets both, which is correct — it is its own top and bottom.
       */
      const ends = BLOCK_ENDS[name]
      if (ends !== undefined) {
        plan.push({ kind: 'line', from, to: from, className: ends[0] })
        plan.push({ kind: 'line', from: to, to, className: ends[1] })
      }

      const inline = INLINE_STYLES[name]
      if (inline !== undefined) plan.push({ kind: 'mark', from, to, className: inline })

      /**
       * **A list's `-` becomes a bullet; its `1.` is left alone.**
       *
       * ruled 2026-08-22, describing Typora: *"it runs out the numbers and the bullets are
       * circles."* Both halves are the rule — the number is content and stays.
       *
       * The marker is read out of the source rather than from the node name, because `ListMark`
       * covers both kinds and only its text tells them apart. Nothing is written: the range is
       * concealed and a glyph is painted over the gap, so `-` is still the character in the file.
       *
       * Deliberately NOT reaching through the trailing space, unlike a heading or a quote mark. The
       * space after `-` is what separates the bullet from the first word, and a heading has no
       * equivalent because its mark is removed entirely rather than replaced.
       */
      if (name === 'ListMark' && !isRevealed(from, to)
        && BULLET_MARKERS.has(text.slice(from, to))) {
        /**
         * **A task line gets a box, not a box AND a bullet.** Caught by looking at a screenshot:
         * every checkbox arrived with a dot in front of it, because a task item is an ordinary list
         * item that happens to contain a `Task`, so both rules fired on the same line.
         *
         * The dash still goes — it is syntax either way — it just goes silently, leaving the
         * checkbox as the line's only marker. Typora draws it the same way.
         */
        if (isTaskItem(node.node)) {
          plan.push({ kind: 'hide', from, to: concealedTo('ListMark', to, text) })
          return true
        }
        plan.push({ kind: 'swap', from, to, glyph: BULLET_GLYPH, className: 'cm-soil-bullet' })
        return true
      }

      /**
       * The checkbox. Its state comes from the marker's own text — `[x]` and `[X]` are both checked
       * in GFM — and anything else is treated as unchecked rather than guessed at, so a marker this
       * code does not recognise draws an empty box instead of vanishing.
       */
      if (name === 'TaskMarker' && !isRevealed(from, to)) {
        const checked = text.slice(from, to).toLowerCase() === '[x]'
        plan.push({
          kind: 'swap',
          from,
          to,
          glyph: checked ? TASK_CHECKED_GLYPH : TASK_UNCHECKED_GLYPH,
          className: checked ? 'cm-soil-task cm-soil-task-done' : 'cm-soil-task',
        })
        return true
      }

      const concealable = HIDDEN_MARKS.has(name)
        || (LINK_PLUMBING.has(name) && inALinkWithADestination(from, to))
      if (concealable && !isRevealed(from, to)) {
        plan.push({ kind: 'hide', from, to: concealedTo(name, to, text) })
      }
      return true
    },
  })

  return plan
}
