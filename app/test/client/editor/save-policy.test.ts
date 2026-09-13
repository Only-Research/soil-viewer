import { describe, expect, it } from 'vitest'

import {
  AUTOSAVE_QUIET_MS,
  SAVED_VISIBLE_MS,
  clearsDirty,
  shouldSave,
  statusFades,
  statusForOutcome,
  type SaveState,
} from '../../../src/client/editor/save-policy'

const state = (over: Partial<SaveState> = {}): SaveState =>
  ({ dirty: true, inFlight: false, editable: true, ...over })

describe('the save decision — §12 requires this to be pure and separately testable', () => {
  it('saves only when there is something to save', () => {
    expect(shouldSave(state())).toBe(true)
    expect(shouldSave(state({ dirty: false })), 'a clean buffer').toBe(false)
  })

  it('never saves while a save is in flight', () => {
    expect(shouldSave(state({ inFlight: true }))).toBe(false)
  })

  it('NEVER saves a document that is not editable — this is C2', () => {
    /**
     * The cheapest total-loss path in the build: a read fails, the editor mounts on an empty
     * document, one keystroke autosaves, the on-disk mtime is unchanged so no conflict fires, and a
     * 400-line file is permanently empty.
     *
     * The engine makes it structurally impossible — a write demands a baseline only a completed
     * read can produce. This is the same refusal at the surface, so the request is never made at
     * all. Both, deliberately: the type system cannot stop a request being sent, and a server-side
     * refusal cannot stop a UI from claiming it saved.
     */
    expect(shouldSave(state({ editable: false }))).toBe(false)
    expect(shouldSave(state({ editable: false, dirty: true, inFlight: false }))).toBe(false)
  })

  it('covers every combination, so no branch is decided by accident', () => {
    const seen: Record<string, boolean> = {}
    for (const dirty of [true, false]) {
      for (const inFlight of [true, false]) {
        for (const editable of [true, false]) {
          seen[`${dirty}${inFlight}${editable}`] = shouldSave({ dirty, inFlight, editable })
        }
      }
    }
    // Exactly one of the eight is a save: dirty, not in flight, editable.
    expect(Object.values(seen).filter(Boolean)).toHaveLength(1)
    expect(seen['truefalsetrue']).toBe(true)
  })

  it('is idempotent across the three exit triggers — the an earlier app lesson', () => {
    /**
     * §12 fires `visibilitychange`, `pagehide` and `beforeunload` because **no end-of-session event
     * is guaranteed on mobile WebKit**. That only works if firing three times costs nothing: an earlier app
     * shipped an unguarded save-on-every-trigger and turned one note into roughly nine archive
     * copies in seconds.
     */
    let dirty = true
    let saves = 0
    for (const trigger of ['visibilitychange', 'pagehide', 'beforeunload']) {
      expect(trigger, 'all three fire; §12 guarantees none of them individually').toBeTruthy()
      if (shouldSave({ dirty, inFlight: false, editable: true })) {
        saves++
        dirty = false // the save landed
      }
    }
    expect(saves, 'three triggers, one write').toBe(1)
  })
})

describe('what the user is told', () => {
  it('maps each server outcome to a status', () => {
    expect(statusForOutcome('saved')).toBe('saved')
    expect(statusForOutcome('conflict')).toBe('conflict')
    expect(statusForOutcome('conflict-unrescued')).toBe('error')
    expect(statusForOutcome('truncation-blocked')).toBe('blocked')
  })

  it('treats an outcome it does not recognise as an ERROR, never a success', () => {
    // The server's outcome set can grow. A client that reads anything unfamiliar as "fine" reports
    // a save that did not happen — §6's empty-but-successful result, in the shape a client makes.
    expect(statusForOutcome('something-new')).toBe('error')
    expect(statusForOutcome('')).toBe('error')
    expect(statusForOutcome('SAVED')).toBe('error')
  })

  it('only the two that mean nothing is wrong fade', () => {
    expect(statusFades('saved')).toBe(true)
    expect(statusFades('idle')).toBe(true)
    for (const sticky of ['error', 'conflict', 'blocked', 'unsaved', 'saving'] as const) {
      // A status that fades is a decision nobody made.
      expect(statusFades(sticky), sticky).toBe(false)
    }
  })
})

describe('what clears the dirty flag', () => {
  it('ONLY a save that landed', () => {
    expect(clearsDirty('saved')).toBe(true)
    for (const outcome of ['conflict', 'conflict-unrescued', 'truncation-blocked', 'anything']) {
      expect(clearsDirty(outcome), outcome).toBe(false)
    }
  })

  it('a conflict leaves the buffer dirty, because it is not on disk', () => {
    /**
     * A conflict rescues the edit to a separate file and leaves the canonical one untouched. The
     * buffer is therefore *not* saved and the user still has a choice to make. Clearing the flag
     * would let the next exit trigger decide there was nothing to do — §12: "it never resolves by
     * discarding the buffer."
     */
    expect(clearsDirty('conflict')).toBe(false)
    expect(shouldSave({ dirty: !clearsDirty('conflict'), inFlight: false, editable: true })).toBe(true)
  })
})

describe('the timings the PRD names', () => {
  it('autosave one second after typing stops; Saved fades after two', () => {
    expect(AUTOSAVE_QUIET_MS).toBe(1000)
    expect(SAVED_VISIBLE_MS).toBe(2000)
  })
})
