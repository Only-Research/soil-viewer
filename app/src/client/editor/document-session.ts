/**
 * **One open document: load it, hold its identity, save it, and never lose it.** Spec §12, §13.2.
 *
 * Framework-free with every dependency injected, in P3's shape — no `fetch`, no timer, no DOM. That
 * is what lets the whole lifecycle be proven in vitest on the `node` environment, and the lifecycle
 * is where the expensive mistakes live: this module decides whether a keystroke becomes a write.
 *
 * ## The three properties it exists to hold
 *
 * **1. No save without a load** (§13.2). A session that failed to load is `editable: false`
 * forever, so `shouldSave` refuses and the request is never made. The engine already refuses on its
 * own — a write needs a `DocumentBaseline` that only a completed read can produce — and this is the
 * same refusal at the surface. Both, deliberately: a type cannot stop a request being sent, and a
 * server-side refusal cannot stop a UI claiming it saved.
 *
 * **2. A pending save always resolves against the file it was typed into** (§12, PRD). The session
 * is per-file and carries a generation counter. Switching files closes it; a response that arrives
 * after that is dropped rather than applied, because the editor it would update is showing somebody
 * else's document.
 *
 * **3. A failed save keeps the editor open in a visible unsaved state** (§12). Never dropped
 * silently, never resolved by discarding the buffer. `clearsDirty` says only a landed save clears
 * the flag, so everything else leaves the document dirty and the next trigger tries again.
 */

import {
  AUTOSAVE_QUIET_MS,
  clearsDirty,
  shouldSave,
  statusForOutcome,
  type SaveStatus,
} from './save-policy'

/** What `file.load` answers. */
export interface LoadedDocument {
  readonly content: string
  readonly hash: string
  readonly bytes: number
}

/** What `file.save` answers — the discriminated outcome, never a bare success. */
export interface SaveResponse {
  readonly outcome: string
  readonly hash?: string
  readonly rescue?: readonly string[]
  readonly wasBytes?: number
  readonly willBeBytes?: number
}

export interface DocumentTransport {
  load: (location: DocumentLocation) => Promise<LoadedDocument>
  save: (request: SaveRequest) => Promise<SaveResponse>
}

export interface DocumentLocation {
  readonly rootId: string
  readonly segments: readonly string[]
}

export interface SaveRequest extends DocumentLocation {
  readonly content: string
  readonly expectedHash: string
  readonly confirmTruncation: boolean
}

/** A one-shot timer. Injected so the tests do not sleep and the policy stays pure. */
export interface Scheduler {
  after: (ms: number, run: () => void) => () => void
}

export interface SessionEvents {
  /** Every status change, including back to `idle`. The surface renders this and nothing else. */
  readonly onStatus: (status: SaveStatus, detail?: SaveDetail) => void
  /** The document is ready to edit. Not called when the load failed or §12 refused the file. */
  readonly onReady: (document: LoadedDocument) => void
}

export interface SaveDetail {
  readonly reason?: string
  readonly rescue?: readonly string[]
  readonly wasBytes?: number
  readonly willBeBytes?: number
  /**
   * **The bytes that are now on disk.** Present only on a landed save, and it is the text that was
   * actually sent — not the buffer as it reads when the response arrives, which a keystroke during
   * the round trip has already moved on from.
   *
   * The surface needs this to know what "unchanged" means. Without it the only baseline available
   * out there is the content the file was *opened* with, and a rescue copy then gets written for
   * every document that was edited at all, saved or not — see the retained-buffer e2e.
   */
  readonly onDisk?: string
}

export interface DocumentSession {
  /** Load and become editable, or fail loudly and stay uneditable. */
  open: () => Promise<void>
  /** The buffer changed. Schedules an autosave; does not write now. */
  changed: (text: string) => void
  /**
   * Write now if there is anything to write. Safe to call from all three exit triggers and from
   * anywhere else — `shouldSave` makes a redundant call free.
   */
  flush: () => Promise<void>
  /** Re-issue the identical save with §13.2's truncation confirmation attached. */
  confirmTruncation: () => Promise<void>
  /** Stop. A response in flight after this is dropped rather than applied. */
  close: () => void
  /** For tests and for the surface: what the session believes right now. */
  peek: () => { dirty: boolean; editable: boolean; inFlight: boolean; hash: string | null }
}

export function createDocumentSession(
  location: DocumentLocation,
  transport: DocumentTransport,
  scheduler: Scheduler,
  events: SessionEvents,
): DocumentSession {
  let editable = false
  let dirty = false
  let inFlight = false
  let closed = false
  let hash: string | null = null
  let text = ''
  let cancelPending: (() => void) | null = null

  const status = (next: SaveStatus, detail?: SaveDetail): void => {
    if (closed) return
    events.onStatus(next, detail)
  }

  const cancelScheduled = (): void => {
    if (cancelPending !== null) {
      cancelPending()
      cancelPending = null
    }
  }

  async function write(confirmTruncation: boolean): Promise<void> {
    // The single gate. Every path into a write goes through it and nothing else decides.
    if (!shouldSave({ dirty, inFlight, editable })) return
    if (hash === null) return

    inFlight = true
    status('saving')

    /**
     * The content and the hash are captured **now**, before the await. A save must be a claim about
     * a specific pair — send the buffer as it is when the response returns and the `expectedHash`
     * describes a different document than the content does, which is a conflict check that passes
     * while comparing the wrong things.
     */
    const sending = text
    const against = hash

    let response: SaveResponse
    try {
      response = await transport.save({ ...location, content: sending, expectedHash: against, confirmTruncation })
    } catch (error) {
      inFlight = false
      // Dirty stays true. The edit is still in the buffer and the next trigger will try again.
      status('error', { reason: error instanceof Error ? error.message : 'the save could not be sent' })
      return
    }

    inFlight = false
    // A response for a document that is no longer open belongs to nobody. Applying it would update
    // an editor showing a different file.
    if (closed) return

    if (clearsDirty(response.outcome)) {
      if (response.hash !== undefined) hash = response.hash
      // Only if nothing was typed while the request was in flight. Comparing the text that was
      // sent, not a flag, so a keystroke during the round trip cannot be lost.
      if (text === sending) dirty = false
    }

    status(statusForOutcome(response.outcome), {
      ...(response.rescue !== undefined ? { rescue: response.rescue } : {}),
      ...(response.wasBytes !== undefined ? { wasBytes: response.wasBytes } : {}),
      ...(response.willBeBytes !== undefined ? { willBeBytes: response.willBeBytes } : {}),
      /**
       * **`sending`, and only on a landed save.** A conflict rescued the edit to a *sibling* file
       * and left this one untouched, so reporting the sent text as the file's contents there would
       * tell the surface the buffer is safe at the exact moment it is not.
       */
      ...(clearsDirty(response.outcome) ? { onDisk: sending } : {}),
    })

    // Something was typed while the request was in flight, so the buffer is ahead of disk again.
    if (dirty && clearsDirty(response.outcome)) scheduleAutosave()
  }

  function scheduleAutosave(): void {
    cancelScheduled()
    cancelPending = scheduler.after(AUTOSAVE_QUIET_MS, () => {
      cancelPending = null
      void write(false)
    })
  }

  return {
    async open(): Promise<void> {
      let loaded: LoadedDocument
      try {
        loaded = await transport.load(location)
      } catch (error) {
        /**
         * **C2, at the surface.** The editor does not become editable, so no keystroke can produce
         * a write against a document nobody read. The status is sticky by construction — `error`
         * does not fade — because a failed read that quietly clears itself is a blank editor over a
         * file that still has content.
         */
        editable = false
        status('error', { reason: error instanceof Error ? error.message : 'the file could not be read' })
        return
      }
      if (closed) return
      hash = loaded.hash
      text = loaded.content
      editable = true
      dirty = false
      status('idle')
      events.onReady(loaded)
    },

    changed(next: string): void {
      if (!editable) return
      text = next
      dirty = true
      status('unsaved')
      scheduleAutosave()
    },

    async flush(): Promise<void> {
      cancelScheduled()
      await write(false)
    },

    async confirmTruncation(): Promise<void> {
      cancelScheduled()
      await write(true)
    },

    close(): void {
      closed = true
      editable = false
      cancelScheduled()
    },

    peek: () => ({ dirty, editable, inFlight, hash }),
  }
}
