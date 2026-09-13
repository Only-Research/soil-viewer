/**
 * Copy Path. Spec §15, annex A26, and the user's daily workflow rather than a nicety.
 *
 * PRD: *"the open file carries a persistent copy-path affordance — one tap to hand a file's path to
 * an agent. This is a daily workflow, not a nicety."*
 *
 * ## What gets copied, and why it is not the absolute path
 *
 * §15 says *"copies the **absolute** path — what an agent needs"*. §6 says the API **never** emits
 * an absolute path, so the browser has never been told one. Those two cannot both be honoured
 * without opening a hole in §6, and the operator was asked which they wanted:
 *
 *   *"it's okay to do the shortcut… the agent can always grep, right? There's not gonna be two
 *   short paths that are going to be the same… it needs to show where it lives, doesn't need an
 *   absolute file path, but it needs to show high enough that we know where it is."*
 *
 * So: **the registered folder's name, then the path inside it.** `notes/02-projects/orchard/
 * notes.md`. That is not a disk path and no hole is opened — the folder's *name* is already on the
 * wire, and its location on disk is not.
 *
 * **The folder name is the part that makes it work**, and it is the part a relative path alone
 * would miss. The operator's reasoning holds inside one registered folder: two files rarely share a
 * relative path, and an agent can find one by grep. Across *several* registered folders it stops
 * holding — `01-inbox/note.md` could sit in two of them, and the copied text would name neither.
 * One extra segment removes the whole class.
 *
 * **Where it still cannot help:** two registered folders whose names are the same. The app permits
 * that — folders are identified by id, not by name — and the copied text would be identical for
 * both. Rare enough to accept, real enough to write down rather than discover.
 */

import type { WireEntry } from '../../contract/wire'

/** What `folders.list` gives back, reduced to what this needs. */
export interface FolderName {
  readonly id: string
  readonly name: string
}

/**
 * The text Copy Path puts on the clipboard.
 *
 * Falls back to the folder **id** when the name is unknown — an id is ugly and unambiguous, and a
 * path with its first segment silently missing is neither. §6's rule about empty results standing
 * in for failures, applied to a string.
 */
export function pathTextFor(entry: WireEntry, folders: readonly FolderName[]): string {
  const folder = folders.find(candidate => candidate.id === entry.rootId)
  return [folder?.name ?? entry.rootId, ...entry.segments].join('/')
}

/** Why a copy did not happen, in words a person can act on. §15's two accepted platform limits. */
export type CopyOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

export interface Clipboard {
  readonly writeText: (text: string) => Promise<void>
}

/**
 * How long to wait for the clipboard before calling it a refusal.
 *
 * **Because a clipboard write can simply never settle.** WebKit found this: with no user-gesture
 * permission, `navigator.clipboard.writeText` neither resolves nor rejects, so a `try/catch` around
 * it runs no branch at all and the confirmation never appears. That is the exact silent failure
 * §15's *"always confirms"* is written against — and it is worse than a refusal, because the person
 * then pastes whatever was on the clipboard before.
 *
 * Half a second: far longer than a real clipboard write, far shorter than a person waits before
 * pressing again.
 */
export const CLIPBOARD_DEADLINE_MS = 500

/**
 * Puts the path on the clipboard, and turns a refusal into a sentence rather than a rejection.
 *
 * §15 names two limits, **both accepted in 2026-07-29 and neither a bug**: the phone
 * copies to the *phone's* clipboard, and the window must be focused, because
 * `navigator.clipboard` requires a focused document and a browser cannot do what Electron's main
 * process could (A26). A server-side `pbcopy` would work and is **explicitly rejected** — it adds a
 * shell invocation, on a listener the phone can reach, for convenience.
 *
 * So an unfocused window produces "click the window first", not a silent failure. The one thing
 * this must never do is report success it did not have: the whole affordance is trusted in one
 * gesture, and a path that was not copied is a paste of whatever was there before.
 */
export async function copyPath(
  text: string,
  clipboard: Clipboard | undefined,
  /** Injected so a test can exercise the deadline without waiting for it. */
  deadlineMs = CLIPBOARD_DEADLINE_MS,
): Promise<CopyOutcome> {
  if (clipboard === undefined) {
    // No Clipboard API at all: an insecure context. On the tailnet that means HTTPS is not set up,
    // which is a real configuration answer rather than a mystery.
    return { ok: false, reason: 'Copying needs a secure connection (https).' }
  }

  const refused: CopyOutcome = { ok: false, reason: 'Click the window first, then copy again.' }

  /**
   * Raced against a deadline, so **every path produces an outcome**. There are three ways this can
   * go wrong and they do not look alike:
   *
   *   - it **rejects** — Chromium, without the gesture permission;
   *   - it **never settles** — WebKit, in the same situation;
   *   - it **throws synchronously**, before a promise exists at all.
   *
   * The third is why the call is inside a `try` rather than only its promise having a rejection
   * handler. A `.then(…, …)` on an expression that threw never runs, so an earlier version of this
   * function let the exception escape and the confirmation never appeared — the identical silent
   * nothing the deadline was added to prevent, one line further up. Found by WebKit, twice in a
   * row, on the same button.
   */
  let written: Promise<CopyOutcome>
  try {
    written = clipboard.writeText(text).then<CopyOutcome, CopyOutcome>(
      () => ({ ok: true, text }),
      () => refused,
    )
  } catch {
    return refused
  }
  const timeout = new Promise<CopyOutcome>(resolve => {
    setTimeout(() => { resolve(refused) }, deadlineMs)
  })
  return Promise.race([written, timeout])
}
