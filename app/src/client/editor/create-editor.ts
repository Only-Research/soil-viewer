/**
 * **The one place an editor is constructed.** Spec §12.
 *
 * ## Why a single factory, and why that is a gate condition rather than tidiness
 *
 * P6's gate is the harness reporting 100% byte-identical. The harness measures whatever editor the
 * page it loads happens to build — so if the harness entry point assembles its own configuration,
 * the gate certifies **a thing the app does not ship**, and the number is worse than no number
 * because it looks like evidence. The app's mount and the harness's mount call this function, and
 * a test asserts the harness entry contains no extension list of its own.
 *
 * ## No `basicSetup`
 *
 * `basicSetup` is the `codemirror` bundle's convenience export: roughly twenty extensions chosen
 * for a code editor. Three reasons it is not used, in increasing order of importance.
 *
 * 1. A controlled editor picks its own behaviour. Every line below is a decision.
 * 2. It pulls `@codemirror/autocomplete`, `@codemirror/lint` and `@codemirror/search` into the
 *    bundle whether or not they do anything — which is what makes the pinned set in `package.json`'s carried
 *    question ("drop the `codemirror` bundle?") answerable at all. Least privilege, applied to
 *    dependencies.
 * 3. **It includes `highlightSpecialChars`.** With CRLF handling as `line-endings.ts` describes it,
 *    the CR of a CRLF file is an ordinary character at the end of a line — and
 *    `highlightSpecialChars` draws a red dot on every one of them. The convenience bundle would
 *    have made every CRLF file look corrupted while being perfectly intact.
 *
 * ## What is deliberately absent
 *
 * There is **no serialization step, here or anywhere downstream**. `text()` returns the buffer.
 * Nothing walks a syntax tree and re-prints a document; nothing regenerates markdown from a
 * structure. That is the property the whole rebuild rests on, and the only way to keep it is for
 * there to be no code that could do it.
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, keymap } from '@codemirror/view'

import { livePreview } from './decorations'
import { LINE_SEPARATOR } from './line-endings'

import './editor.css'

export interface EditorHandle {
  /**
   * **The document's exact text.** Not a render, not a serialization — the buffer itself.
   *
   * What is written to disk is `Buffer.from(this, 'utf8')`, and §12's editability gate guarantees
   * that round trip is byte-exact for every file that could have been opened.
   */
  text: () => string
  /** Focus the surface. */
  focus: () => void
  /** Tear down. Called on every file switch — the editor is keyed on identity, not path. */
  destroy: () => void
  /** The underlying view, for the decoration and flush layers. Not for constructing a second one. */
  readonly view: EditorView
}

export interface EditorOptions {
  /** The file's text, exactly as it came off disk. */
  readonly doc: string
  /** Where to mount. */
  readonly parent: HTMLElement
  /** Called after every change that altered the document. Never on a pure selection move. */
  readonly onDocChanged?: (text: string) => void
}

/**
 * The extension list, as its own exported value so a test can assert what is and is not in it.
 *
 * Order matters to CodeMirror for precedence, not for correctness of the document — but
 * `lineSeparator` is first regardless, because it is the one whose absence rewrites files.
 */
export function editorExtensions(): Extension[] {
  return [
    /**
     * **THE LOAD-BEARING LINE.** See `line-endings.ts`: CodeMirror's `toString()` always joins with
     * `"\n"`, so this is the only value for which the split and the join are inverses. Unset — the
     * default, and what every example uses — four of ten measured hazard inputs come back as a
     * different file, silently, including every CRLF document.
     */
    EditorState.lineSeparator.of(LINE_SEPARATOR),

    /**
     * One parser for the whole app (§19): `@lezer/markdown` with the GFM set, which
     * `markdownLanguage` is. The read-only renderer in P7 walks the *same* tree, so the editor and
     * the renderer cannot disagree about what a document means — the disagreement that let 62% of
     * the old app's damaged files still look correct.
     *
     * `codeLanguages` is deliberately empty: highlighting inside a fence would mean shipping a
     * language bundle per language, and §12 scopes fenced code to plain monospace.
     */
    markdown({ base: markdownLanguage, codeLanguages: [] }),

    /**
     * The live preview. §12's *"formatting is rendered continuously; raw markdown is revealed only
     * on the line the cursor occupies"*. It paints over the buffer and cannot write to it — see
     * `decorations.ts`.
     */
    livePreview(),

    history(),
    drawSelection(),
    dropCursor(),

    /**
     * Long lines wrap rather than scroll horizontally. Prose, not code — and §18's phone layout has
     * nowhere to put a horizontal scrollbar.
     */
    EditorView.lineWrapping,

    /**
     * `markdownKeymap` first so its Enter — list and blockquote continuation — wins over the
     * default. **This is the behaviour `@codemirror/lang-markdown` 6.5.1 got wrong**, deleting part
     * of a lazily continued paragraph; 6.5.2 is pinned for the fix and the pin is load-bearing
     * rather than hygienic.
     */
    keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
  ]
}

/** Builds the editor. The only constructor in the app. */
export function createEditor(options: EditorOptions): EditorHandle {
  const { doc, parent, onDocChanged } = options

  const extensions = editorExtensions()
  if (onDocChanged !== undefined) {
    extensions.push(EditorView.updateListener.of(update => {
      // `docChanged` and not `changes.empty`: a selection move is not an edit, and treating it as
      // one is how an earlier app turned one note into nine archive copies.
      if (update.docChanged) onDocChanged(update.state.doc.toString())
    }))
  }

  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent,
  })

  return {
    text: () => view.state.doc.toString(),
    focus: () => { view.focus() },
    destroy: () => { view.destroy() },
    view,
  }
}
