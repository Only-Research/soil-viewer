/**
 * The pane for everything the editor will not open. §9, §12's FT-11.
 *
 * `pane-state.ts` decides which of the four states a file gets; this draws them. DOM construction
 * only — `el()` has no parameter that accepts markup, and every filename here was written by an
 * agent.
 */

import { append, clear, el } from '../dom'
import type { WireEntry } from '../../contract/wire'
import { paneStateFor } from './pane-state'

export interface PaneOptions {
  /** §9's byte endpoint for a file, or `null` before a session exists. */
  readonly fileUrl: (rootId: string, segments: readonly string[]) => string | null
  /** Fetches a small text file's contents for the read-only view. Rejects on failure. */
  readonly readText: (entry: WireEntry) => Promise<string>
}

/**
 * Builds the pane for one entry.
 *
 * Returns an element rather than mounting, so the caller owns placement and this owns nothing —
 * the same shape as `createTreeView`.
 */
export function buildNonEditingPane(entry: WireEntry, options: PaneOptions): HTMLElement {
  const pane = el('div', { className: 'pane' })

  const header = el('div', { className: 'pane-header' })
  append(header, el('div', { className: 'pane-name', text: entry.name }))
  append(header, el('div', { className: 'pane-path', text: entry.segments.join('/') }))
  append(pane, header)

  const body = el('div', { className: 'pane-body' })
  append(pane, body)

  const state = paneStateFor(entry)
  const source = options.fileUrl(entry.rootId, entry.segments)

  /**
   * A missing URL is its own state, and it is NOT rendered as an empty `<img>`.
   *
   * A browser resolves `src=""` against the current page and fetches it, so an empty source is a
   * request for the app's own shell dressed as a picture. §6's rule about empty results standing in
   * for failures, in the one place it produces a network request rather than a wrong screen.
   */
  if ((state.kind === 'image' || state.kind === 'pdf') && source === null) {
    append(body, el('p', { className: 'pane-note', text: 'Not connected yet — try again in a moment.' }))
    return pane
  }

  if (state.kind === 'image' && source !== null) {
    // `<img>` only. §9: "Images only via `<img>`. No preview ever navigates the top frame."
    append(body, el('img', {
      className: 'pane-image',
      attributes: { src: source, alt: entry.name },
    }))
    return pane
  }

  if (state.kind === 'pdf' && source !== null) {
    /**
     * §9, verbatim: *"PDFs render only in `<iframe sandbox>` **without** `allow-scripts` and
     * **without** `allow-same-origin`."*
     *
     * `sandbox=""` — the empty value is the maximally restrictive one and is what must be written.
     * Omitting the attribute is not sandboxing; `sandbox` with any token starts granting things
     * back. The frame's own response also carries `Content-Security-Policy: sandbox`, so the
     * restriction holds even if this attribute is ever edited away.
     */
    append(body, el('iframe', {
      className: 'pane-frame',
      attributes: { src: source, sandbox: '', title: entry.name },
    }))
    return pane
  }

  if (state.kind === 'text') {
    const pre = el('pre', { className: 'pane-text', text: 'Loading…' })
    append(body, pre)
    void options.readText(entry).then(
      // `textContent` through `setText`, never markup — this is file content from the tree.
      contents => { pre.textContent = contents },
      () => { clear(pre); pre.textContent = 'This file could not be read.' },
    )
    return pane
  }

  /**
   * The unsupported state. **One sentence and no download button** — the ruling.
   *
   * The way out is the row menu, which will carry Reveal in Finder from P12 and Copy Path before
   * that. Nothing is offered here, because a pane that offers nothing is honest and a pane that
   * offers a download is a file the app said it could not show and then handed over anyway.
   */
  append(body, el('p', {
    className: 'pane-note',
    text: state.kind === 'unsupported' ? state.reason : 'This kind of file cannot be shown here.',
  }))
  return pane
}
