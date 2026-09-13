/**
 * **The harness's way in.** P5's contract, one line:
 *
 *     window.RT.run(input: string) => { out: string }
 *
 * The instrument hands this a file's text and byte-compares what comes back. P6's gate is the
 * number it produces, so what this file must guarantee is not that it works — it is that **it is
 * measuring the editor the app ships.**
 *
 * ## Why there is no configuration in this file
 *
 * It imports `createEditor` and passes it a document. That is the whole implementation, and the
 * absence is the point: a harness entry that assembled its own extension list would certify an
 * editor nobody uses, and the gate would be evidence of nothing while looking like evidence of
 * everything. `create-editor.ts` is the single constructor; this file is not allowed to become a
 * second one.
 *
 * A test asserts that this module names no CodeMirror extension of its own.
 *
 * ## What the round trip actually exercises
 *
 * Mount the real editor on the input, read the buffer back, tear it down. That covers document
 * construction, the line-separator configuration, and every extension the app runs — which is
 * where the damage would be, since §12 removed the serialization step that damaged the old one.
 *
 * **It does not touch a file**, and that limit is stated rather than left to be discovered: the
 * decode at `file.load`, the transport, the re-encode at `file.save` and the atomic write are each
 * proven separately, and the test that proves the chain is P6's item 11.
 */

import { el } from './dom'
import { createEditor } from './editor/create-editor'

export interface RoundTripResult {
  readonly out: string
}

declare global {
  interface Window {
    RT: { run: (input: string) => RoundTripResult }
  }
}

/**
 * One editor per call, mounted into a detached element.
 *
 * Detached rather than in the document body: the harness runs thousands of files and a surface
 * that lays out and paints each one is measuring the browser's rendering speed rather than the
 * editor's fidelity. Decorations are still computed — `ViewPlugin` runs on state, not on paint —
 * so the live preview is exercised either way.
 */
export function roundTrip(input: string): RoundTripResult {
  // `el` rather than `document.createElement`: §8's DOM-construction rule is lint-enforced across
  // all of `src/`, and the harness is not exempt from the app's rules just because it is an
  // instrument. Caught by lint on the first run of this file.
  const host = el('div')
  const editor = createEditor({ doc: input, parent: host })
  try {
    return { out: editor.text() }
  } finally {
    editor.destroy()
  }
}

/**
 * **The readiness signal is `window.RT` itself.** An earlier version also stamped a
 * `data-rt-ready` attribute on the document element; it was removed rather than reworked, because
 * two signals for one condition is two things that can disagree — and the driver would then be
 * free to wait on the one that is set first. The driver waits for `window.RT.run` to be a function,
 * which is true exactly when a round trip can be performed.
 */
window.RT = { run: roundTrip }
