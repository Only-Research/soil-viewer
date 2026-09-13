/**
 * Line endings, and **the single most dangerous thing CodeMirror does to a document.**
 *
 * Spec §12: *"line endings preserved exactly (a CRLF file saves back CRLF)"*. The build plan named
 * silent line-ending normalization as the failure a decoded comparison would miss. It turns out the
 * risk was never in our comparison — it is in the library, by default, and it is the reason this
 * module exists before any editor code does.
 *
 * ## What was measured, 2026-08-08, on `@codemirror/state` 6.7.1
 *
 * `Text` splits a document into lines on the way in and joins them on `toString()`. **The join is
 * hard-wired to `"\n"`.** `EditorState.lineSeparator` controls only the *split*. So the two are
 * inverses for exactly one setting, and every other setting silently rewrites the file:
 *
 * | `lineSeparator` | inputs corrupted, of ten |
 * |---|---|
 * | unset — the default, and what every CodeMirror example uses | **4** |
 * | `"\r\n"` | 2 |
 * | `"\r"` | 4 |
 * | **`"\n"`** | **0** |
 *
 * The default splits on `\n`, `\r\n` *and* `\r`, then joins with `\n`. A CRLF file loaded into a
 * stock CodeMirror and saved back **is a different file**, on every line, with no error and nothing
 * to see. That is the 1,610-file mechanism, arriving from a dependency rather than from our code —
 * and it would have sailed through every unit test in this repository, because our tests hand
 * strings to functions and this happens inside the editor.
 *
 * ## The design, and why it is a constant rather than a setting
 *
 * `LINE_SEPARATOR` is `"\n"` **always**. Not detected, not configurable, not per-document. The
 * moment it can vary, it can vary wrongly, and the failure is invisible. With it fixed, split and
 * join are exact inverses and the round trip is byte-perfect for every input measured — pure CRLF,
 * mixed CRLF and LF, classic-Mac lone CR, a stray CR at end of file, and a file with no newline at
 * all.
 *
 * **The consequence, stated plainly: the CR of a CRLF file lives in the buffer as an ordinary
 * character at the end of a line.** It is text, like every other byte. That is not a workaround —
 * it is §12's *"the buffer is the file's text"* holding literally, and it is what makes the
 * alternative unnecessary. The alternative was to strip CRs on load and re-add them on save, which
 * is a **serialization step**: the exact category of thing §12 abolishes, unprovable for a
 * mixed-ending file, and one more place a document can be rewritten by code that means well.
 *
 * What is left over is cosmetic and handled elsewhere: a trailing CR is invisible in the DOM, and
 * the editor does not load `highlightSpecialChars`, which would draw it as a red dot on every line.
 */

/**
 * **The only line separator this editor ever configures.** See above — any other value makes
 * CodeMirror's split and join stop being inverses.
 */
export const LINE_SEPARATOR = '\n'

/** The three endings a real file uses. */
export type LineEnding = '\n' | '\r\n' | '\r'

/**
 * The ending a **newly typed** line should use, derived from what the document already does.
 *
 * This is a separate question from preservation, and only this one is a judgement call. Existing
 * bytes are safe either way — they are never re-joined. But `state.lineBreak` follows
 * `lineSeparator`, so with the constant above every Enter would insert a bare LF, and adding a line
 * to a CRLF file would quietly make it a mixed-ending file. §12 says a CRLF file saves back CRLF;
 * honouring that for the lines the user adds, and not only the ones they leave alone, is the
 * difference between preserving a file and preserving the parts of it nobody touched.
 *
 * Ties and empty documents go to LF: it is what every file in this tree uses, and a guess that
 * matches the corpus is better than a guess that matches nothing.
 */
export function dominantLineEnding(text: string): LineEnding {
  let crlf = 0
  let lf = 0
  let cr = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r') {
      if (text[i + 1] === '\n') { crlf++; i++ } else { cr++ }
    } else if (ch === '\n') {
      lf++
    }
  }

  // Strictly greater, so a tie falls through to the LF default rather than to whichever branch
  // happens to be written first — a comparison that decides by source order is a coin flip nobody
  // knows they are tossing.
  if (crlf > lf && crlf > cr) return '\r\n'
  if (cr > lf && cr > crlf) return '\r'
  return '\n'
}
