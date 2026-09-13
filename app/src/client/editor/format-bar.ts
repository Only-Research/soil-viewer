/**
 * The formatting bar. Spec §12, PRD's editor contract.
 *
 * ## Two rules that are easy to get wrong and both matter
 *
 * **It acts on `mousedown`, never `click`.** A `click` fires after the browser has already moved
 * focus, which collapses the selection — so a user who selects a word and presses Bold gets the
 * markers around an empty caret position instead of around their word. `preventDefault` on
 * `mousedown` stops the focus change before it happens and the selection survives. The PRD names
 * this directly: *"the formatting bar acts on mousedown (never steals the selection)"*.
 *
 * **It tracks the caret live**, and it does so through `activeFormatsAt` — the *same* predicate the
 * buttons apply. A bar lit by different rules from the ones its buttons use is a bar that lies, and
 * pressing a lit button would turn the format on again.
 *
 * ## What it is not allowed to do
 *
 * Construct DOM only — `createElement`, `textContent`, `setAttribute`. §8's rule, lint-enforced
 * across `src/`. And nothing here computes an edit: every action goes through `formatting.ts`,
 * which returns minimal edits and is proven not to re-print a region.
 *
 * **No emoji, per annex §C.** The labels are text.
 */

import type { EditorView } from '@codemirror/view'

import { el } from '../dom'
import {
  INLINE_MARKERS,
  LINE_PREFIXES,
  activeFormatsAt,
  insertBlock,
  toggleInline,
  toggleLinePrefix,
  type FormatResult,
} from './formatting'

type Action =
  | { readonly kind: 'inline'; readonly format: keyof typeof INLINE_MARKERS }
  | { readonly kind: 'line'; readonly format: keyof typeof LINE_PREFIXES }
  | { readonly kind: 'block'; readonly format: 'codeblock' | 'rule' }

interface Button {
  readonly label: string
  readonly title: string
  readonly action: Action
}

/** The bar's contents, in order. Build plan §3's P6 row names exactly this set. */
const BUTTONS: readonly Button[] = [
  { label: 'B', title: 'Bold', action: { kind: 'inline', format: 'bold' } },
  { label: 'I', title: 'Italic', action: { kind: 'inline', format: 'italic' } },
  { label: 'S', title: 'Strikethrough', action: { kind: 'inline', format: 'strike' } },
  { label: 'code', title: 'Inline code', action: { kind: 'inline', format: 'code' } },
  { label: 'H1', title: 'Heading 1', action: { kind: 'line', format: 'h1' } },
  { label: 'H2', title: 'Heading 2', action: { kind: 'line', format: 'h2' } },
  { label: 'H3', title: 'Heading 3', action: { kind: 'line', format: 'h3' } },
  { label: 'list', title: 'Bullet list', action: { kind: 'line', format: 'bullet' } },
  { label: '1.', title: 'Numbered list', action: { kind: 'line', format: 'ordered' } },
  { label: 'quote', title: 'Blockquote', action: { kind: 'line', format: 'quote' } },
  { label: 'block', title: 'Code block', action: { kind: 'block', format: 'codeblock' } },
  { label: 'rule', title: 'Horizontal rule', action: { kind: 'block', format: 'rule' } },
]

/** The name a button's active state is keyed on, or null for the ones that cannot be "on". */
function activeName(action: Action): string | null {
  return action.kind === 'block' ? null : action.format
}

function resultFor(action: Action, doc: string, from: number, to: number): FormatResult {
  switch (action.kind) {
    case 'inline': return toggleInline(doc, from, to, action.format)
    case 'line': return toggleLinePrefix(doc, from, to, action.format)
    case 'block': return insertBlock(doc, from, to, action.format)
  }
}

/**
 * Applies an action to the view.
 *
 * One transaction, carrying the minimal edits and the resulting selection together — so undo takes
 * the whole action back in a step, and the caret never lands somewhere the user did not ask for.
 */
export function applyAction(view: EditorView, action: Action): void {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc.toString()
  const result = resultFor(action, doc, from, to)

  view.dispatch({
    changes: result.edits.map(edit => ({ from: edit.from, to: edit.to, insert: edit.insert })),
    // CodeMirror's shape is `{anchor, head}`; ours is `{from, to}`. Converted here rather than
    // making the pure module speak CodeMirror's vocabulary.
    selection: { anchor: result.selection.from, head: result.selection.to },
    // The buffer changed because the user asked it to; scroll to where they now are.
    scrollIntoView: true,
  })
  view.focus()
}

export interface FormatBar {
  readonly element: HTMLElement
  /** Recompute the lit buttons. Called on every selection or document change. */
  readonly refresh: (doc: string, from: number, to: number) => void
}

export function createFormatBar(view: EditorView): FormatBar {
  const element = el('div', { className: 'format-bar', attributes: { role: 'toolbar' } })
  const buttons: { node: HTMLElement; name: string | null }[] = []

  for (const button of BUTTONS) {
    const node = el('button', {
      className: 'format-bar-button',
      text: button.label,
      attributes: { type: 'button', title: button.title, 'aria-label': button.title },
    })

    /**
     * `mousedown` with `preventDefault`, and this is the whole reason the bar works.
     *
     * On `click` the browser has already moved focus to the button, which collapses the selection in
     * the editor — so the action would wrap an empty caret rather than the user's words. Preventing
     * the default on `mousedown` stops the focus change before it happens.
     */
    node.addEventListener('mousedown', event => {
      event.preventDefault()
      applyAction(view, button.action)
    })

    element.appendChild(node)
    buttons.push({ node, name: activeName(button.action) })
  }

  return {
    element,
    refresh: (doc, from, to) => {
      const active = activeFormatsAt(doc, from, to)
      for (const { node, name } of buttons) {
        // `toggle` with an explicit second argument, so the class tracks the state rather than
        // flipping — a bar that inverts on every keystroke is worse than one that never updates.
        node.classList.toggle('is-active', name !== null && active.has(name as never))
      }
    },
  }
}
