/**
 * **THE ONE OPEN DOCUMENT, AND WHERE IT IS DRAWN — held together, so they cannot disagree.**
 *
 * There is exactly one live `DocumentSession` in this app at a time, and that is a data-safety
 * constraint rather than a simplification: two sessions on one file would autosave against the same
 * content hash and raise conflicts *with each other*, and §13.8's retained-buffer key is the file
 * path, so the second one's rescue copy would overwrite the first's.
 *
 * That invariant was fine while a document could only ever be drawn in the Files pane. A25's
 * slide-over broke it by adding a second place, and `main.tsx` went on holding the session in a bare
 * `let` that anyone could read and null. The security review found the consequence (P9-3): the panel's teardown
 * closed *whatever was live* and nulled the global unconditionally, so it could flush the Files
 * pane's document and orphan its own.
 *
 * ## Why this is a module and not two variables
 *
 * `main.tsx` cannot be unit-tested — it is the entry file, it builds the whole DOM, and the unit
 * environment is `node`. So every ordering rule that lived in it was a rule nobody could drive. The
 * two questions below are exactly the ones that were being answered wrongly, and they are answered
 * here where a test can ask them:
 *
 * - **`ownedBy(surface)`** — *is the live document the one THIS surface drew?* Asked before a
 *   teardown flushes, because "a document is open" is not the same question and answering the wrong
 *   one is how the panel came to close somebody else's editor.
 * - **`release(session)`** — *forget it, but only if it is still the live one.* The check is
 *   load-bearing and the failure it prevents needs no race to be fast, only a flush that is slow:
 *   a teardown takes the session, awaits `flush()` over the network, and while it is away a click
 *   on another surface adopts a new one. An unconditional null then wipes the **new** session's
 *   registration — after which nothing closes it on the next open, and, worse, `openFileVerdict`
 *   reads the absent session as *clean* and reopens the file over unsaved text.
 *
 * Generic over both the session and the host so the tests can drive it with strings. There is
 * nothing here that needs to know what a document or an element is; the whole subject is identity.
 */

export interface DocumentRegistry<S, H> {
  /** The live session, or `null`. */
  readonly current: () => S | null
  /** A new session takes the screen, drawn in `into`. The pair moves together or not at all. */
  readonly adopt: (session: S, into: H) => void
  /** The live session **if it is drawn in `surface`**, otherwise `null`. */
  readonly ownedBy: (surface: H) => S | null
  /** Forget `session` — and only `session`. A stale caller must not clear a newer registration. */
  readonly release: (session: S) => void
}

export function createDocumentRegistry<S, H>(): DocumentRegistry<S, H> {
  let live: S | null = null
  let host: H | null = null

  return {
    current: () => live,
    adopt: (session, into) => {
      live = session
      host = into
    },
    ownedBy: surface => (host === surface ? live : null),
    release: session => {
      if (live !== session) return
      live = null
      host = null
    },
  }
}
