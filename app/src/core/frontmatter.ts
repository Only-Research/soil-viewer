/**
 * Where a document's frontmatter block begins and ends. **One definition, for every reader.**
 *
 * ## Why this is its own module
 *
 * Two parts of the app need to know what frontmatter is, and they need to agree.
 *
 * - `title.ts` skips it, so a document's display title is its first *heading* rather than the first
 *   line of its YAML (FT-8).
 * - The editor renders it as a collapsed properties block (§12) — **never as a thematic break plus
 *   a setext heading**, which is what the old app did to 944 files and, as it turns out, what
 *   `@lezer/markdown` produces by default. Measured 2026-08-08: `---\ntitle: x\n---` parses as
 *   `HorizontalRule` followed by `SetextHeading2`. The parser is not wrong — that is what those
 *   characters mean in CommonMark, and it is exactly why the old app's regenerator printed them
 *   back that way. Nothing is damaged here, because nothing regenerates; but the *render* would
 *   reproduce the old bug's appearance on half the tree if it took the parse at face value.
 *
 * §6 says of the markdown predicate that "divergence is a build failure". This is the same
 * sentence about frontmatter: two definitions is a document that is frontmatter to one half of the
 * app and a heading to the other.
 *
 * ## The rules, unchanged from `title.ts` where they were first written
 *
 * Frontmatter opens with **exactly `---` on the very first line** — anywhere else those characters
 * are a thematic break or a setext underline. It closes with `---` or `...`, YAML's two document
 * terminators. Trailing spaces and tabs are allowed on either.
 *
 * A trailing CR is stripped before matching. That is not cosmetic: `line-endings.ts` keeps the CR
 * of a CRLF file in the buffer as ordinary text, so `"---\r"` is what a CRLF document's first line
 * actually contains, and a matcher that missed it would fail to recognise frontmatter in every
 * CRLF file while working perfectly in the tests.
 */

/** Frontmatter opens with exactly `---` on the first line. */
const FRONTMATTER_OPEN = /^---[ \t]*$/
/** It closes with `---` or YAML's `...`. */
const FRONTMATTER_CLOSE = /^(---|\.\.\.)[ \t]*$/

/** A line as it appears in the buffer, minus the CR a CRLF document leaves on the end. */
function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * The three possible answers, kept distinct because the callers act differently on the third.
 *
 * **`unterminated` is not the same as `none`**, and collapsing them would be a behaviour change in
 * `title.ts`: an opening `---` with no close means the rest of the document is YAML, so there is no
 * heading to find and guessing one from a YAML key is FT-8. Reported as its own state so each
 * caller decides rather than inheriting whatever the other one wanted.
 */
export type FrontmatterScan =
  | { readonly kind: 'none' }
  | { readonly kind: 'closed'; readonly closeLine: number }
  | { readonly kind: 'unterminated' }

/** Scans lines — already split, CR still attached — for a leading frontmatter block. */
export function scanFrontmatter(lines: readonly string[]): FrontmatterScan {
  const first = lines[0]
  if (first === undefined || !FRONTMATTER_OPEN.test(withoutCarriageReturn(first))) {
    return { kind: 'none' }
  }
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_CLOSE.test(withoutCarriageReturn(lines[i] ?? ''))) {
      return { kind: 'closed', closeLine: i }
    }
  }
  return { kind: 'unterminated' }
}

/** Character offsets of a document's frontmatter block, or `null` when there is no closed block. */
export interface FrontmatterSpan {
  /** Offset of the opening `---`. Always 0 — carried so callers never assume it. */
  readonly from: number
  /** Offset just past the opening delimiter line's text, excluding its newline. */
  readonly openTo: number
  /** Offset of the closing delimiter's first character. */
  readonly closeFrom: number
  /** Offset just past the closing delimiter's text, excluding its newline. */
  readonly to: number
}

/**
 * The same scan, in character offsets, for the editor.
 *
 * Offsets are into the text **exactly as given** — CRs included — because that is what the buffer
 * holds and what a decoration range is measured in. A span computed against CR-stripped text would
 * be wrong by one character per line in every CRLF document, which is the sort of off-by-N that
 * renders as formatting drifting away from the thing it formats.
 */
export function frontmatterSpan(text: string): FrontmatterSpan | null {
  const lines = text.split('\n')
  const scan = scanFrontmatter(lines)
  if (scan.kind !== 'closed') return null

  let offset = 0
  let openTo = 0
  let closeFrom = 0
  for (let i = 0; i <= scan.closeLine; i++) {
    const line = lines[i] ?? ''
    if (i === 0) openTo = offset + line.length
    if (i === scan.closeLine) closeFrom = offset
    offset += line.length + 1 // the newline the split consumed
  }

  return {
    from: 0,
    openTo,
    closeFrom,
    to: closeFrom + (lines[scan.closeLine] ?? '').length,
  }
}
