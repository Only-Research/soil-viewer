/**
 * **The formatting actions, as text edits.** Spec §12, PRD's editor contract.
 *
 * ## The rule this whole module is written to obey
 *
 * *It inserts and removes delimiters around a span. **It never re-prints a region.***
 *
 * This is the one place in the app that produces document text the user did not type, which makes
 * it the only place with regeneration-shaped risk. The old editor's damage came from taking a parsed
 * structure and printing it back; a formatting action that "normalises" the line it touches is the
 * same operation with a smaller blast radius, and it would be invisible — the file would look right.
 *
 * So every function here returns **minimal edits**: a `from`, a `to`, and what goes between. An edit
 * that spans more than the delimiters it is adding or removing is a bug in this module by
 * definition, and the tests assert on the edits rather than on the resulting string precisely so
 * that "it produced the right text" cannot hide "it rewrote the whole line to get there".
 *
 * ## Pure, and why that matters here more than elsewhere
 *
 * No CodeMirror, no DOM. The command layer turns these into transactions. That keeps the decision —
 * *which characters change* — provable in vitest, and leaves the browser layer with nothing to do
 * but apply them.
 */

import { dominantLineEnding, type LineEnding } from './line-endings'

/** A minimal change. `to === from` is an insertion; `insert === ''` is a deletion. */
export interface TextEdit {
  readonly from: number
  readonly to: number
  readonly insert: string
}

/** Where the selection should end up once the edits are applied. */
export interface FormatResult {
  readonly edits: readonly TextEdit[]
  /** The selection after the edit, in coordinates of the *original* document. Mapped by the caller. */
  readonly selection: { readonly from: number; readonly to: number }
}

/** The inline formats, and the delimiter each wraps a span in. */
export const INLINE_MARKERS = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
} as const

export type InlineFormat = keyof typeof INLINE_MARKERS

/**
 * Wraps or unwraps a span.
 *
 * **Unwrapping is checked first and is exact**: if the characters immediately outside the selection
 * are the marker, they are removed. That is what makes the action a toggle rather than a way to
 * accumulate `****bold****`, and it is why the check looks *outside* the selection — a user who
 * selects the word inside `**bold**` and presses bold again means "stop being bold".
 *
 * The selection is also allowed to *include* the markers, which is what a double-click on a
 * formatted word tends to produce. Both are handled; neither re-prints anything.
 */
export function toggleInline(
  doc: string,
  from: number,
  to: number,
  format: InlineFormat,
): FormatResult {
  const marker = INLINE_MARKERS[format]
  const width = marker.length

  // Case 1: the markers sit just outside the selection.
  if (doc.slice(from - width, from) === marker && doc.slice(to, to + width) === marker) {
    return {
      edits: [
        { from: from - width, to: from, insert: '' },
        { from: to, to: to + width, insert: '' },
      ],
      selection: { from: from - width, to: to - width },
    }
  }

  // Case 2: the selection includes the markers.
  if (
    to - from >= width * 2
    && doc.slice(from, from + width) === marker
    && doc.slice(to - width, to) === marker
  ) {
    return {
      edits: [
        { from, to: from + width, insert: '' },
        { from: to - width, to, insert: '' },
      ],
      selection: { from, to: to - width * 2 },
    }
  }

  /**
   * Case 3: the caret is **inside** a span without selecting it — unwrap the whole span.
   *
   * Must come before the wrap below, and must agree with `activeFormatsAt`, which lights the button
   * in exactly this situation. Without it, pressing a lit Bold inserted a fresh empty `****` in the
   * middle of the user's word — the button said "this is bold, press to stop" and did the opposite.
   */
  if (from === to) {
    const span = enclosingSpan(doc, from, marker)
    if (span !== null) {
      return {
        edits: [
          { from: span.from - width, to: span.from, insert: '' },
          { from: span.to, to: span.to + width, insert: '' },
        ],
        selection: { from: from - width, to: from - width },
      }
    }
  }

  // Case 4: not formatted — wrap it. A collapsed selection produces an empty pair with the caret
  // between them, which is what every editor does and what a user pressing bold before typing means.
  return {
    edits: [
      { from, to: from, insert: marker },
      { from: to, to, insert: marker },
    ],
    selection: { from: from + width, to: to + width },
  }
}

/** The block formats that work by putting a prefix on a line. */
export const LINE_PREFIXES = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  bullet: '- ',
  ordered: '1. ',
  quote: '> ',
} as const

export type LinePrefixFormat = keyof typeof LINE_PREFIXES

/**
 * Any prefix this module knows how to apply, as a pattern — so applying `h2` to an `h1` line
 * replaces the marker rather than stacking `## # `.
 *
 * Matched against the start of the line, after leading whitespace is left alone. **Leading
 * whitespace is never touched**: it carries list nesting, and "tidying" indentation is exactly the
 * kind of helpful rewrite this module exists to avoid.
 */
const ANY_PREFIX = /^(#{1,6} |- |\* |\+ |\d+\. |> )/

/** The line containing `pos`, as offsets into `doc`. */
function lineAt(doc: string, pos: number): { from: number; to: number } {
  const from = doc.lastIndexOf('\n', pos - 1) + 1
  const next = doc.indexOf('\n', pos)
  return { from, to: next === -1 ? doc.length : next }
}

/** Every line the range touches. */
function linesIn(doc: string, from: number, to: number): { from: number; to: number }[] {
  const lines = [lineAt(doc, from)]
  let cursor = lines[0] as { from: number; to: number }
  while (cursor.to < to) {
    cursor = lineAt(doc, cursor.to + 1)
    lines.push(cursor)
  }
  return lines
}

/**
 * Adds, replaces or removes a line prefix on every line the selection touches.
 *
 * Toggling is per-selection rather than per-line: if **every** touched line already carries this
 * exact prefix, the action removes it; otherwise it applies it everywhere. A per-line toggle on a
 * mixed selection inverts each line independently, which is never what anyone means.
 */
export function toggleLinePrefix(
  doc: string,
  from: number,
  to: number,
  format: LinePrefixFormat,
): FormatResult {
  const prefix = LINE_PREFIXES[format]
  const lines = linesIn(doc, from, to)

  const existing = lines.map(line => {
    const text = doc.slice(line.from, line.to)
    const indent = /^[ \t]*/.exec(text)?.[0] ?? ''
    const rest = text.slice(indent.length)
    const match = ANY_PREFIX.exec(rest)
    return { line, at: line.from + indent.length, current: match?.[0] ?? '' }
  })

  const allHaveIt = existing.every(entry => entry.current === prefix)

  /**
   * Minimal edits: the prefix span only, never the line.
   *
   * **Mutation-checked 2026-08-09.** Replacing this with a version that re-prints the whole line —
   * the old editor's mechanism at small scale — produces byte-identical output, and **every
   * assertion about the resulting text still passed.** Only `expectOnlyDelimitersRemoved` caught it.
   * That is why the tests for this module assert on the edits rather than on the result.
   */
  const edits = existing.map(entry => ({
    from: entry.at,
    to: entry.at + entry.current.length,
    insert: allHaveIt ? '' : prefix,
  }))

  // The selection moves by whatever the first line's prefix changed by, and grows or shrinks by the
  // total. Computed rather than guessed so a multi-line action does not leave the caret adrift.
  const firstDelta = (edits[0]?.insert.length ?? 0) - (existing[0]?.current.length ?? 0)
  const totalDelta = edits.reduce(
    (sum, edit, index) => sum + edit.insert.length - (existing[index]?.current.length ?? 0),
    0,
  )
  return { edits, selection: { from: from + firstDelta, to: to + totalDelta } }
}

/**
 * The span a caret sits *inside*, for one marker — or `null`.
 *
 * **Added 2026-08-09 after a real-browser test found the bar dead.** Both `toggleInline` and
 * `activeFormatsAt` originally only recognised a format when the selection matched the span exactly.
 * A user clicking into the middle of a bold word therefore got an unlit Bold button, and pressing it
 * inserted a fresh empty `****` inside their word rather than removing the bold. That is what
 * "tracks the caret live" has to mean, and no unit test saw it because every unit test selected the
 * span deliberately.
 *
 * Searches outward on **the caret's own line only**. An inline span cannot cross a blank line, and
 * scanning the whole document would let a stray asterisk pages away claim the caret.
 */
export function enclosingSpan(
  doc: string,
  pos: number,
  marker: string,
): { from: number; to: number } | null {
  const line = lineAt(doc, pos)
  const text = doc.slice(line.from, line.to)
  const at = pos - line.from

  const opening = text.lastIndexOf(marker, Math.max(0, at - 1))
  if (opening === -1) return null
  const closing = text.indexOf(marker, opening + marker.length)
  if (closing === -1) return null

  const from = line.from + opening + marker.length
  const to = line.from + closing
  // Strictly inside, and non-empty: a caret on the marker itself is not "in" the span, and an empty
  // `****` has no content to be inside of.
  return pos >= from && pos <= to && to > from ? { from, to } : null
}

/**
 * Which formats are already on, at a selection. Drives the bar's active states.
 *
 * The PRD requires the bar to *"track the caret live"*, and this is that question asked as a pure
 * function so the answer is testable without a browser. It is deliberately the **same predicate the
 * toggles use** — a bar that lights up under different rules from the ones the buttons apply is a
 * bar that lies, and pressing a lit button would then turn the format *on* again.
 */
export function activeFormatsAt(
  doc: string,
  from: number,
  to: number,
): Set<InlineFormat | LinePrefixFormat> {
  const active = new Set<InlineFormat | LinePrefixFormat>()

  for (const format of Object.keys(INLINE_MARKERS) as InlineFormat[]) {
    const marker = INLINE_MARKERS[format]
    const width = marker.length
    const outside = doc.slice(from - width, from) === marker && doc.slice(to, to + width) === marker
    const inside = to - from >= width * 2
      && doc.slice(from, from + width) === marker
      && doc.slice(to - width, to) === marker
    // And the case the bar is actually for: a caret sitting inside the span without selecting it.
    const enclosing = from === to && enclosingSpan(doc, from, marker) !== null
    if (outside || inside || enclosing) active.add(format)
  }

  /**
   * `*` is a prefix of `**`, so a bold span answers the italic check too. Asked *after* both, so the
   * decision is made on the full picture rather than by whichever ran first — the same reason
   * `dominantLineEnding` compares strictly rather than deciding by source order.
   */
  if (active.has('bold')) active.delete('italic')

  const lines = linesIn(doc, from, to)
  for (const format of Object.keys(LINE_PREFIXES) as LinePrefixFormat[]) {
    const prefix = LINE_PREFIXES[format]
    const all = lines.every(line => {
      const text = doc.slice(line.from, line.to)
      return text.slice((/^[ \t]*/.exec(text)?.[0] ?? '').length).startsWith(prefix)
    })
    if (all) active.add(format)
  }

  return active
}

/**
 * Inserts a fenced code block or a thematic break.
 *
 * **This is where the deferred line-ending question lands.** `line-endings.ts` fixes CodeMirror's
 * separator at `"\n"` so split and join stay inverses, which means `state.lineBreak` is `"\n"` and
 * anything inserted here would arrive as a bare LF. In a CRLF document that quietly makes the file
 * mixed — §12 says a CRLF file saves back CRLF, and honouring that only for the lines the user did
 * not touch is preserving part of a file.
 *
 * So inserted breaks use the document's **dominant** ending. Existing bytes are unaffected either
 * way; this is about the lines the user adds.
 */
export function insertBlock(
  doc: string,
  from: number,
  to: number,
  block: 'codeblock' | 'rule',
): FormatResult {
  const eol: LineEnding = dominantLineEnding(doc)
  const line = lineAt(doc, from)
  const atLineStart = from === line.from
  const lead = atLineStart ? '' : eol

  if (block === 'rule') {
    const text = `${lead}---${eol}`
    return {
      edits: [{ from, to, insert: text }],
      selection: { from: from + text.length, to: from + text.length },
    }
  }

  const selected = doc.slice(from, to)
  const opening = `${lead}\`\`\`${eol}`
  const closing = `${eol}\`\`\`${eol}`
  return {
    edits: [{ from, to, insert: `${opening}${selected}${closing}` }],
    // Caret just inside the fence, where the code goes.
    selection: { from: from + opening.length, to: from + opening.length + selected.length },
  }
}
