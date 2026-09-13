/**
 * **When a save happens, and when it must not.** Spec §12's flush contract.
 *
 * Pure, with no timer, no editor and no transport — because §12 makes one specific demand of this
 * logic and it is unusual enough to quote:
 *
 *   *"The save decision MUST be gated on a dirty flag, and that decision MUST be pure and
 *   separately testable."*
 *
 * The reason is on the record and it is not hypothetical. an earlier app shipped an unguarded
 * save-on-every-trigger and **turned one test note into roughly nine archive copies in seconds** —
 * because the exit triggers below fire constantly: every app switch, every backgrounding, every
 * tab change. A save that writes nothing must cost nothing.
 *
 * ## Why there are three triggers and not one
 *
 * §12, corrected 2026-08-05 after the first version got the reasoning right and the conclusion
 * wrong. It required flushing on `pagehide` "not only `beforeunload`, which does not fire on iOS
 * Safari backgrounding" — true about `beforeunload`, and **`pagehide` does not fire in that case
 * either.** Open the page, switch apps, close the browser from the app switcher: neither event is
 * dispatched. Desktop Safari is worse — closing a tab with the (X) dispatches neither
 * `visibilitychange` nor `pagehide`.
 *
 * **No end-of-session event is guaranteed on mobile WebKit.** So the design is three overlapping
 * triggers plus idempotency, rather than one event treated as reliable. `visibilitychange` → hidden
 * is primary because it is the last moment mobile WebKit reliably gives you; the other two are
 * duplicates, and firing three times has to cost nothing or the duplication is itself a bug.
 */

/** What the surface knows about itself when something asks it to flush. */
export interface SaveState {
  /** The buffer differs from what is known to be on disk. */
  readonly dirty: boolean
  /** A save is already in flight. */
  readonly inFlight: boolean
  /**
   * The document may be written at all.
   *
   * False while loading, for a file §12 refuses, and — the case that matters — **after a failed
   * read**. That is C2, the cheapest total-loss path in the build: a read fails, the editor mounts
   * on an empty document, one keystroke autosaves, and a 400-line file is permanently empty. The
   * engine already makes it structurally impossible by requiring a baseline no failed load can
   * produce; this is the same refusal at the surface, so the request is never even made.
   */
  readonly editable: boolean
}

/**
 * The whole decision. **Every flush path goes through this and nothing else decides.**
 *
 * Idempotent by construction: a save that lands clears `dirty`, so the second and third triggers
 * see a clean buffer and answer `false`. That is what makes "fire three times" free rather than
 * three writes.
 */
export function shouldSave(state: SaveState): boolean {
  if (!state.editable) return false
  if (!state.dirty) return false
  if (state.inFlight) return false
  return true
}

/**
 * Milliseconds of quiet before an autosave. PRD: *"autosave 1s after typing stops"*.
 *
 * A debounce, not an interval: each keystroke restarts it, so a continuous typist saves when they
 * pause rather than every second while they work.
 */
export const AUTOSAVE_QUIET_MS = 1000

/** How long a "Saved" indication stays before fading. PRD: *"Saved fades after 2s, Error is sticky"*. */
export const SAVED_VISIBLE_MS = 2000

/**
 * What the user is told. `error`, `conflict` and `blocked` are **sticky** — they are the states
 * where something needs a decision, and a status that fades is a decision nobody made.
 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict' | 'blocked' | 'unsaved'

/** Whether a status clears itself. Only the two that mean "nothing is wrong" do. */
export function statusFades(status: SaveStatus): boolean {
  return status === 'saved' || status === 'idle'
}

/**
 * The status a save outcome produces.
 *
 * Mirrors `SaveOutcome` in `server/services.ts`, which is deliberately not a bare success: a
 * conflict and a blocked truncation are **questions, not failures**, and §6 keeps them off the
 * error envelope so they arrive on the success side with the data the user needs to answer them.
 */
export function statusForOutcome(outcome: string): SaveStatus {
  switch (outcome) {
    case 'saved': return 'saved'
    case 'conflict': return 'conflict'
    case 'conflict-unrescued': return 'error'
    case 'truncation-blocked': return 'blocked'
    /**
     * An unknown outcome is an **error**, never a success.
     *
     * The server's outcome set can grow, and a client that treats anything it does not recognise as
     * "fine" would silently report a save that did not happen. This is §6's empty-but-successful
     * result in the shape a client can produce, and the safe direction is the one that keeps the
     * editor dirty and visible.
     */
    default: return 'error'
  }
}

/**
 * Does this outcome mean the buffer is now on disk?
 *
 * **Only `saved`.** A conflict rescued the edit to a separate file and left the canonical one
 * untouched — the buffer is *not* on disk, the user still has a choice to make, and clearing the
 * dirty flag would let the next trigger decide there was nothing to do. §12: *"a failed exit-save
 * keeps the editor open in a visible unsaved state. It is never dropped silently, and it never
 * resolves by discarding the buffer."*
 */
export function clearsDirty(outcome: string): boolean {
  return outcome === 'saved'
}
