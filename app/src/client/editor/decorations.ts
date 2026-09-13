/**
 * The plan, turned into CodeMirror decorations. **This is the only file in the editor that needs a
 * browser, and it is deliberately the smallest one.**
 *
 * Everything that decides *what* to paint lives in `plan-decorations.ts`, which is pure and covered
 * by 30 tests that run without a DOM. This file does the mechanical part: line starts, sort order,
 * and when to recompute. The split exists because vitest runs on the `node` environment and jsdom
 * would be a new dependency — so the rule is that anything which can be wrong about a *document*
 * belongs on the other side of it.
 *
 * **Nothing here can change the document.** `Decoration.replace` conceals a range visually and
 * leaves every byte in place; `mark` and `line` only add classes. There is no transaction dispatched
 * from this file, and that is what keeps §12's *"the buffer is the file's text"* true no matter what
 * the preview does.
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import {
  Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType,
} from '@codemirror/view'

import { el } from '../dom'
import { planDecorations, type Range } from './plan-decorations'

/** Concealment. An empty widget, so the range renders as nothing while still being there. */
const HIDDEN = Decoration.replace({})

/**
 * A glyph painted over a concealed range — today, the bullet that stands in for a list's `-`.
 *
 * **Built through `el`, not `document.createElement`.** The `document` global is an allowlist of one
 * in this codebase and `dom.ts` is the member; the lint refuses it here, and correctly. `el` also
 * sets text through `textContent`, so a glyph can never become markup even if one day it came from
 * somewhere less trustworthy than a constant in this file.
 *
 * **`eq` is not optional.** Without it CodeMirror treats every rebuild's widget as a different one
 * and replaces the DOM node on each keystroke — which on a list-heavy document is a visible flicker
 * and, worse, tears down and recreates a node the selection may be sitting against.
 */
class Glyph extends WidgetType {
  constructor(private readonly glyph: string, private readonly className: string) { super() }

  override eq(other: Glyph): boolean {
    return other.glyph === this.glyph && other.className === this.className
  }

  override toDOM(): HTMLElement {
    return el('span', { className: this.className, text: this.glyph })
  }

  /** Nothing to select inside a drawn glyph; the real character is in the document behind it. */
  override ignoreEvent(): boolean { return false }
}

/**
 * The lines the cursor and every selection range touch.
 *
 * §12 reveals raw markdown *by line*, not by character: a caret inside `**bold**` shows the whole
 * line's syntax, because revealing only the marker under the cursor makes the text jump sideways as
 * the caret crosses it. Whole selections count too — a user dragging across a heading is working
 * with its syntax.
 */
export function revealedRanges(state: EditorState): Range[] {
  const ranges: Range[] = []
  for (const selection of state.selection.ranges) {
    const first = state.doc.lineAt(selection.from)
    const last = selection.to === selection.from ? first : state.doc.lineAt(selection.to)
    ranges.push({ from: first.from, to: last.to })
  }
  return ranges
}

function buildDecorations(state: EditorState): DecorationSet {
  const plan = planDecorations(state.doc.toString(), syntaxTree(state), revealedRanges(state))

  /**
   * **`Decoration.set(…, true)` rather than `RangeSetBuilder`, and this was a real bug.**
   *
   * The first version used `RangeSetBuilder` with a hand-written sort by `from`. It threw on the
   * first real document — *"Ranges must be added sorted by `from` position and `startSide`"* — and
   * the whole preview silently vanished, because a crashing `ViewPlugin` is disabled rather than
   * fatal. Sorting by position is not sufficient: markdown nests, so a `mark` over `**bold**` and
   * the `hide` over its leading `**` begin at the same offset, and the builder also orders on
   * `startSide`, which is a property of the decoration rather than of the plan.
   *
   * `Decoration.set` with `sort: true` applies CodeMirror's own ordering, which is the only thing
   * that knows what the sides are. **The correct sort was not mine to write.**
   *
   * Worth recording where this was caught: every test of the planner passed, and passes still. The
   * planner was right. This layer is the one that needs a browser, which is exactly why the phase
   * does not treat a green unit suite as evidence that the editor works.
   */
  const ranges = plan.flatMap(d => {
    if (d.kind === 'line') {
      /**
       * **One decoration per line the block covers**, not one at its start.
       *
       * A line decoration must sit exactly at a line start or CodeMirror throws, and it styles
       * that line alone. Blocks span lines: a table, a fenced block and a blockquote are each one
       * node over many. The first version emitted a single decoration at the node's start, which
       * styled a table's header row and left its body in the prose font — visible immediately in a
       * browser and invisible to every unit test, because the plan was right.
       */
      const first = state.doc.lineAt(d.from).number
      const last = state.doc.lineAt(Math.min(d.to, state.doc.length)).number
      const lines = []
      for (let n = first; n <= last; n++) {
        lines.push(Decoration.line({ class: d.className }).range(state.doc.line(n).from))
      }
      return lines
    }
    // A zero-length range covers nothing and CodeMirror rejects it. It can arise from an empty
    // node, which is a parser detail rather than a fault here.
    if (d.to <= d.from) return []
    if (d.kind === 'hide') return [HIDDEN.range(d.from, d.to)]
    if (d.kind === 'swap') {
      return [
        Decoration.replace({ widget: new Glyph(d.glyph, d.className) }).range(d.from, d.to),
      ]
    }
    return [Decoration.mark({ class: d.className }).range(d.from, d.to)]
  })

  return Decoration.set(ranges, true)
}

/**
 * The live preview.
 *
 * Recomputed on a document change, a selection move, or a viewport change — the last because
 * CodeMirror only renders what is visible and a decoration set built for one viewport is missing
 * ranges for the next.
 *
 * **Recomputed over the whole document rather than the viewport**, which is the honest simple thing
 * and is recorded as such: on a 2 MiB file — the editable cap — this walks the entire tree on every
 * keystroke. If that turns out to be slow it is a real optimisation with a real risk (a viewport
 * window that clips a decoration mid-construct), and it should be made against a measurement rather
 * than a suspicion.
 */
export function livePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.state)
        }
      }
    },
    { decorations: plugin => plugin.decorations },
  )
}
