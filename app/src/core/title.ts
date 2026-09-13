/**
 * First-heading extraction for the index. Spec §5.
 *
 * **Why this is a hand-written scanner and not `@lezer/markdown`.** Spec §19 names one parser
 * for the whole app, and this is not a violation of it: §19 governs the *renderer and editor*,
 * which share a syntax tree so they can never disagree about a document. This runs in the
 * server, where spec §2 permits **zero third-party runtime dependencies** — `@lezer/markdown`
 * is a client bundle package and the Core may not import it. §5 specifies the algorithm
 * directly for that reason, and it also has to stay cheap across 10,000 files reading only the
 * first 64 KiB of each.
 *
 * Two named bugs from the old code that this must not repeat:
 * - **The code-fence heading bug.** A `#` inside a fenced block became the card title.
 * - **The frontmatter bug (FT-8).** 602 real files open with `---`, and a YAML comment is a
 *   `#` at line start — so the old scanner turned YAML comments into titles.
 */

/** Spec §5: "first-heading extraction reads at most 64 KiB". */
export const TITLE_SCAN_BYTES = 64 * 1024

/** Spec §5: "truncates the title to 200 chars". */
export const MAX_TITLE_CHARS = 200

import { scanFrontmatter } from './frontmatter'

/** An ATX heading: up to 3 leading spaces, 1–6 `#`, then a space/tab or end of line.
 *  CommonMark requires that separator — `#hashtag` is a paragraph, not a heading. */
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/

/** A fence: up to 3 leading spaces, then 3+ backticks or 3+ tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** A setext underline: `=` or `-` runs under a paragraph line. */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/

/**
 * A thematic break: three or more `-`, `*` or `_`, optionally spaced. It is a block-level
 * element, so it can never be paragraph content — which matters because a `---` divider with
 * nothing above it would otherwise be swept into the next setext heading's text.
 */
const THEMATIC_BREAK = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/


/**
 * Strips an ATX closing sequence: `## Title ##` → `Title`. CommonMark only treats trailing
 * `#`s as a closing sequence when preceded by a space, so `# C#` keeps its `#`.
 */
function stripATXClosing(text: string): string {
  const match = /^(.*?)[ \t]+#+[ \t]*$/.exec(text)
  return (match?.[1] ?? text).trim()
}

function truncate(title: string): string {
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title
}

/**
 * Decodes the scan window. A byte window may cut a multi-byte character in half; that is
 * acceptable for a display title and never touches the file. This is display-only —
 * spec §5: "The index is authoritative for display only."
 */
export function decodeScanWindow(bytes: Buffer): string {
  const window = bytes.length > TITLE_SCAN_BYTES ? bytes.subarray(0, TITLE_SCAN_BYTES) : bytes
  let text = window.toString('utf8')
  // A UTF-8 BOM would otherwise sit in front of `---` or `#` and defeat both detectors.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

/**
 * Returns the first markdown heading's text, or null when the document has none.
 *
 * Null means "no heading" — the caller falls back to the filename. It never means "read
 * failed": spec §6 forbids an empty-but-successful result standing in for a failure, so a
 * failed read is reported by the caller as a failure and never reaches this function.
 */
export function extractTitle(content: string): string | null {
  const lines = content.split('\n')
  let index = 0

  // 1. Frontmatter. **The rule itself lives in `frontmatter.ts`**, moved there 2026-08-08 when the
  //    editor needed the same definition: two definitions would make a document frontmatter to one
  //    half of the app and a heading to the other. Behaviour here is unchanged.
  const scan = scanFrontmatter(lines)
  // An unterminated block means the whole scan window is frontmatter. Returning null is
  // correct: there is no heading here, and guessing one from YAML is exactly FT-8.
  if (scan.kind === 'unterminated') return null
  if (scan.kind === 'closed') index = scan.closeLine + 1

  let openFence: { marker: string; length: number } | null = null
  // The lines of the paragraph currently being accumulated. A setext heading's content is the
  // WHOLE preceding paragraph, not just the line above the underline — keeping only the last
  // line would silently truncate a two-line title.
  let paragraph: string[] = []

  for (; index < lines.length; index++) {
    const raw = (lines[index] ?? '').replace(/\r$/, '')

    // 2. Fenced code. Checked before everything else so a `#` inside a fence can never win.
    const fence = FENCE.exec(raw)
    if (fence) {
      const marker = fence[1] ?? ''
      const char = marker[0] ?? '`'
      if (openFence === null) {
        // An info string may not contain a backtick on a backtick fence (CommonMark).
        const info = fence[2] ?? ''
        if (char === '`' && info.includes('`')) {
          if (raw.trim().length > 0) paragraph.push(raw.trim())
          continue
        }
        openFence = { marker: char, length: marker.length }
      } else if (char === openFence.marker && marker.length >= openFence.length) {
        openFence = null
      }
      paragraph = []
      continue
    }
    if (openFence !== null) continue

    // 3. Indented code — 4+ leading spaces, and only when it is not continuing a paragraph.
    if (paragraph.length === 0 && /^(?: {4}|\t)/.test(raw)) continue

    // 4. ATX heading.
    const atx = ATX.exec(raw)
    if (atx) {
      const text = stripATXClosing((atx[2] ?? '').trim())
      return text.length > 0 ? truncate(text) : null
    }

    // 5. Setext heading — an underline directly beneath a paragraph line.
    if (paragraph.length > 0 && SETEXT.test(raw)) {
      const text = paragraph.join(' ').trim()
      if (text.length > 0) return truncate(text)
    }

    // 6. A thematic break. Reached only when there is no paragraph above it — otherwise the
    //    setext branch already consumed it as an underline. It ends the block and is never
    //    text, so it must not be accumulated.
    if (THEMATIC_BREAK.test(raw)) {
      paragraph = []
      continue
    }

    if (raw.trim().length > 0) paragraph.push(raw.trim())
    else paragraph = []
  }

  return null
}

/**
 * The title the index stores: the first heading, or the filename with its extension removed.
 * Spec §5 uses the filename fallback for cloud placeholders; it is the general fallback too,
 * because a card with no title is unusable and an empty string is not a title.
 */
export function titleFor(fileName: string, content: string | null): string {
  const heading = content === null ? null : extractTitle(content)
  if (heading !== null) return heading
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  return truncate(base.length > 0 ? base : fileName)
}
