/**
 * What the right-hand pane shows for a file the editor will not open. Spec §9, §12's FT-11.
 *
 * Pure: an entry in, a state out. No DOM, no fetching.
 *
 * **ruled 2026-08-09, and it removed a state rather than adding one:**
 *
 *   *"videos don't need to display inline nor do they need to offer a download, they can just show,
 *   cannot display this file or something; then the user can do the view in finder by clicking the
 *   dots next to it."*
 *
 * So there are three outcomes and **"download" is not one of them.** The pane displays the thing,
 * reads the thing, or says plainly that it cannot show this kind of file. The row menu is where a
 * person goes from there.
 *
 * *This does not change the §9 endpoint*, which still answers `application/octet-stream` with an
 * attachment disposition for anything unrecognised — that pairing is a security control, and it is
 * what stops a file being treated as a document by anything fetching the URL directly. What changes
 * is that the app never builds a link to it. The endpoint's attachment path becomes reachable only
 * by someone typing the address, which is exactly who it defends against.
 *
 * **The editor's refusals land here too** (FT-11), always with a reason. §12 makes an unopenable
 * `.md` a *state*, not a failure: a file that is not valid UTF-8, holds a NUL, or is over the 2 MiB
 * editable cap is a perfectly good file the editor is not allowed to touch, and saying so is the
 * whole job of this pane.
 */

import { MAX_EDITABLE_BYTES } from '../../core/limits'
import { servingDecisionFor } from '../../core/file-serving'
import type { WireEntry } from '../../contract/wire'

export type PaneState =
  /** An image, shown with `<img>`. §9's allowlist decided this, not the client. */
  | { readonly kind: 'image' }
  /**
   * A PDF, shown in `<iframe sandbox>` — **without `allow-scripts` and without
   * `allow-same-origin`** (§9). The sandboxing is the view's obligation; this only says a PDF may
   * be shown.
   */
  | { readonly kind: 'pdf' }
  /** FT-10's read-only plain-text pane. `.txt`, `.json`, `.yml`, `.csv`, `LICENSE`. */
  | { readonly kind: 'text' }
  /**
   * Cannot be shown, and the pane says so in these words. `reason` is for the person, not a log —
   * it appears on screen.
   */
  | { readonly kind: 'unsupported'; readonly reason: string }

/**
 * Why the editor will not open this markdown file, or `null` when it will.
 *
 * Separated from `paneStateFor` because the *client* can only ever guess at two of §12's three
 * conditions: it knows the size, and it does not know whether the bytes decode. The server's
 * `NOT_EDITABLE` refusal is authoritative and arrives later — this is what the tree can say from a
 * row alone, before anything is fetched.
 */
export function markdownRefusal(entry: WireEntry): string | null {
  if (entry.contentUnavailable) {
    // §5's cloud placeholder. Never an empty document — that is C2's whole subject.
    return 'This file has not been downloaded to this Mac yet.'
  }
  if (entry.size > MAX_EDITABLE_BYTES) {
    return `This file is ${Math.round(entry.size / (1024 * 1024))} MB, which is too large to edit here.`
  }
  return null
}

/**
 * The pane's state for an entry the editor will not open.
 *
 * **The serving decision is `core/file-serving.ts`'s, not a second list here.** §9's allowlist
 * already answers "what may this be shown as", and a client-side copy would be a second control
 * that drifts — the failure F4.5 names and the reason §9 has no deny-list either. What this adds is
 * only the mapping from that decision to a *pane*, which is the one thing the server has no opinion
 * about.
 */
export function paneStateFor(entry: WireEntry): PaneState {
  if (entry.contentUnavailable) {
    return { kind: 'unsupported', reason: 'This file has not been downloaded to this Mac yet.' }
  }

  const decision = servingDecisionFor(entry.name, entry.size)

  if (decision.kind === 'inline') {
    return decision.contentType === 'application/pdf' ? { kind: 'pdf' } : { kind: 'image' }
  }
  if (decision.kind === 'text') return { kind: 'text' }

  /**
   * Everything else. **One sentence, and it does not name a format.**
   *
   * "This kind of file cannot be shown here" is true of a video, a zip, a keynote and an `.svg`
   * alike, and listing what *is* supported would be a second copy of §9's allowlist living in a
   * string. The person's next move is the same in every case.
   */
  return { kind: 'unsupported', reason: 'This kind of file cannot be shown here.' }
}
