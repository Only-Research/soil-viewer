import { describe, expect, it } from 'vitest'

import {
  createDocumentSession,
  type DocumentTransport,
  type LoadedDocument,
  type SaveRequest,
  type SaveResponse,
  type Scheduler,
} from '../../../src/client/editor/document-session'
import type { SaveStatus } from '../../../src/client/editor/save-policy'

const LOCATION = { rootId: 'soil', segments: ['notes.md'] } as const

/** A scheduler that runs nothing until a test says so. No sleeping, no flake. */
function manualScheduler(): Scheduler & { runPending: () => void; pending: () => number } {
  let queue: (() => void)[] = []
  return {
    after: (_ms, run) => {
      queue.push(run)
      return () => { queue = queue.filter(q => q !== run) }
    },
    runPending: () => {
      const due = queue
      queue = []
      for (const run of due) run()
    },
    pending: () => queue.length,
  }
}

interface Harness {
  readonly transport: DocumentTransport
  readonly saves: SaveRequest[]
  readonly statuses: SaveStatus[]
  readonly ready: LoadedDocument[]
}

function harness(over: {
  load?: () => Promise<LoadedDocument>
  save?: (r: SaveRequest) => Promise<SaveResponse>
} = {}): Harness {
  const saves: SaveRequest[] = []
  const statuses: SaveStatus[] = []
  const ready: LoadedDocument[] = []
  return {
    saves,
    statuses,
    ready,
    transport: {
      load: over.load ?? (async () => ({ content: '# Original\n', hash: 'h0', bytes: 11 })),
      save: async (request) => {
        saves.push(request)
        return over.save ? await over.save(request) : { outcome: 'saved', hash: 'h1' }
      },
    },
  }
}

function session(h: Harness, scheduler: Scheduler) {
  return createDocumentSession(LOCATION, h.transport, scheduler, {
    onStatus: status => { h.statuses.push(status) },
    onReady: document => { h.ready.push(document) },
  })
}

describe('opening a document', () => {
  it('becomes editable and hands the text forward', async () => {
    const h = harness()
    const s = session(h, manualScheduler())
    await s.open()

    expect(h.ready).toHaveLength(1)
    expect(h.ready[0]?.content).toBe('# Original\n')
    expect(s.peek()).toMatchObject({ editable: true, dirty: false, hash: 'h0' })
  })

  it('C2 — A FAILED READ LEAVES THE EDITOR UNEDITABLE, AND NO KEYSTROKE CAN WRITE', async () => {
    /**
     * The cheapest total-loss path in the build, and the acceptance the build plan moved into P6
     * because the editor is what it is about:
     *
     *   a read fails → the editor mounts on an empty document → one keystroke → autosave →
     *   the on-disk mtime is unchanged so the conflict check passes → a 400-line file is
     *   permanently empty.
     *
     * The engine makes it structurally impossible. This proves the surface never even asks.
     */
    const h = harness({ load: () => Promise.reject(new Error('EIO')) })
    const scheduler = manualScheduler()
    const s = session(h, scheduler)
    await s.open()

    expect(h.ready, 'nothing became editable').toEqual([])
    expect(s.peek().editable).toBe(false)
    expect(h.statuses.at(-1)).toBe('error')

    // Everything a user or a browser could do next.
    s.changed('anything at all')
    scheduler.runPending()
    await s.flush()
    await s.confirmTruncation()

    expect(h.saves, 'not one write was attempted').toEqual([])
  })

  it('a closed session refuses to write even though it holds a valid hash', async () => {
    /**
     * **Added after a mutation sweep found the test above passing for the wrong reason.**
     *
     * Removing the `editable` guard from `shouldSave` left the failed-read test green: on that path
     * `hash` is also null, and the write refuses on the hash instead. Two guards, one reachable, and
     * the one named for C2 doing no work the test could see — this build's signature shape.
     *
     * They are both correct and they refuse different things: `hash === null` means *no baseline
     * exists*, `editable` means *this document may not be written*. The close case is where they
     * come apart, so it is where the second guard is provable.
     */
    const h = harness()
    const s = session(h, manualScheduler())
    await s.open()
    s.changed('typed')
    expect(s.peek().hash, 'a real baseline is held').toBe('h0')

    s.close()
    await s.flush()
    await s.confirmTruncation()

    expect(h.saves, 'a closed document is not writable, baseline or no baseline').toEqual([])
  })

  it('the failed-read status is sticky — it cannot fade into a blank editor', async () => {
    const h = harness({ load: () => Promise.reject(new Error('EIO')) })
    const s = session(h, manualScheduler())
    await s.open()
    // `error` never fades; a status that clears itself here is a blank editor over a file that
    // still has content.
    expect(h.statuses.filter(x => x === 'idle')).toEqual([])
  })
})

describe('autosave', () => {
  it('waits for typing to stop, then writes once', async () => {
    const h = harness()
    const scheduler = manualScheduler()
    const s = session(h, scheduler)
    await s.open()

    s.changed('a')
    s.changed('ab')
    s.changed('abc')
    expect(h.saves, 'nothing written while typing').toEqual([])
    expect(scheduler.pending(), 'each keystroke replaces the last timer, never stacks').toBe(1)

    scheduler.runPending()
    await Promise.resolve()
    expect(h.saves).toHaveLength(1)
    expect(h.saves[0]?.content).toBe('abc')
  })

  it('sends the hash it was given, not one it invented', async () => {
    const h = harness()
    const s = session(h, manualScheduler())
    await s.open()
    s.changed('x')
    await s.flush()
    expect(h.saves[0]?.expectedHash).toBe('h0')
    expect(h.saves[0]?.confirmTruncation).toBe(false)
  })

  it('adopts the new hash so a second save is measured against what it just wrote', async () => {
    const h = harness()
    const s = session(h, manualScheduler())
    await s.open()
    s.changed('x')
    await s.flush()
    s.changed('xy')
    await s.flush()
    expect(h.saves[1]?.expectedHash).toBe('h1')
  })
})

describe('the three exit triggers', () => {
  it('firing all three costs one write — the an earlier app lesson', async () => {
    const h = harness()
    const s = session(h, manualScheduler())
    await s.open()
    s.changed('edited')

    await s.flush() // visibilitychange
    await s.flush() // pagehide
    await s.flush() // beforeunload

    expect(h.saves, 'three triggers, one write').toHaveLength(1)
  })

  it('a flush with nothing to save costs nothing at all', async () => {
    const h = harness()
    const s = session(h, manualScheduler())
    await s.open()
    await s.flush()
    await s.flush()
    expect(h.saves).toEqual([])
  })

  it('a flush pre-empts the pending autosave rather than racing it', async () => {
    const h = harness()
    const scheduler = manualScheduler()
    const s = session(h, scheduler)
    await s.open()
    s.changed('edited')
    await s.flush()
    scheduler.runPending()
    await Promise.resolve()
    expect(h.saves, 'the cancelled timer did not fire a second write').toHaveLength(1)
  })
})

describe('when a save does not land', () => {
  it('a conflict keeps the buffer dirty and reports where the rescue went', async () => {
    const h = harness({ save: async () => ({ outcome: 'conflict', rescue: ['notes (conflict).md'] }) })
    const s = session(h, manualScheduler())
    await s.open()
    s.changed('mine')
    await s.flush()

    expect(h.statuses.at(-1)).toBe('conflict')
    // §12: never resolved by discarding the buffer. The canonical file was left alone, so the edit
    // is NOT on disk and the next trigger must try again.
    expect(s.peek().dirty).toBe(true)
  })

  it('a transport failure keeps the buffer dirty and says so', async () => {
    const h = harness({ save: () => Promise.reject(new Error('offline')) })
    const s = session(h, manualScheduler())
    await s.open()
    s.changed('mine')
    await s.flush()

    expect(h.statuses.at(-1)).toBe('error')
    expect(s.peek()).toMatchObject({ dirty: true, inFlight: false })

    // And it recovers: the next flush tries again rather than believing itself saved.
    await s.flush()
    expect(h.saves).toHaveLength(2)
  })

  it('a blocked truncation can be re-issued with the confirmation attached', async () => {
    let confirmed = false
    const h = harness({
      save: async request => {
        if (request.confirmTruncation) { confirmed = true; return { outcome: 'saved', hash: 'h2' } }
        return { outcome: 'truncation-blocked', wasBytes: 400, willBeBytes: 3 }
      },
    })
    const s = session(h, manualScheduler())
    await s.open()
    s.changed('abc')
    await s.flush()
    expect(h.statuses.at(-1)).toBe('blocked')
    expect(s.peek().dirty).toBe(true)

    await s.confirmTruncation()
    expect(confirmed).toBe(true)
    expect(s.peek().dirty).toBe(false)
  })

  it('an outcome the client does not recognise is an error, never a success', async () => {
    const h = harness({ save: async () => ({ outcome: 'a-new-outcome-from-a-later-version' }) })
    const s = session(h, manualScheduler())
    await s.open()
    s.changed('mine')
    await s.flush()
    expect(h.statuses.at(-1)).toBe('error')
    expect(s.peek().dirty, 'and the edit is still held').toBe(true)
  })
})

describe('a pending save always resolves against the file it was typed into', () => {
  it('a response arriving after the document closed is dropped', async () => {
    let release: (value: SaveResponse) => void = () => {}
    const h = harness({ save: () => new Promise<SaveResponse>(resolve => { release = resolve }) })
    const s = session(h, manualScheduler())
    await s.open()
    s.changed('typed into notes.md')

    const inFlight = s.flush()
    s.close() // the user switched files
    release({ outcome: 'saved', hash: 'h9' })
    await inFlight

    // The status would have been rendered into an editor showing somebody else's document.
    expect(h.statuses.at(-1), 'no status after close').not.toBe('saved')
    expect(s.peek().hash, 'and the closed session did not adopt a hash for a file nobody is showing')
      .toBe('h0')
  })

  it('a keystroke during the round trip is not lost to the response that overtakes it', async () => {
    /**
     * The save was a claim about a specific pair of (content, hash). If the response cleared the
     * dirty flag unconditionally, the character typed while it was in flight would sit in the buffer
     * marked clean — and be dropped the moment the file closed.
     */
    let release: (value: SaveResponse) => void = () => {}
    const h = harness({ save: () => new Promise<SaveResponse>(resolve => { release = resolve }) })
    const scheduler = manualScheduler()
    const s = session(h, scheduler)
    await s.open()

    s.changed('first')
    const inFlight = s.flush()
    s.changed('first plus more')
    release({ outcome: 'saved', hash: 'h1' })
    await inFlight

    expect(s.peek().dirty, 'the later keystroke is still unsaved').toBe(true)
    scheduler.runPending()
    await Promise.resolve()
    expect(h.saves.at(-1)?.content).toBe('first plus more')
  })
})

/**
 * **What the session reports as being on disk**, added 2026-08-25.
 *
 * The surface needs a moving baseline for "is there unsaved work here?" and the only one it had was
 * the content the file was *opened* with — which after the first save answers a different question
 * entirely. `main.tsx` used it to decide whether to keep a local rescue copy, so every document
 * the operator edited and walked away from left a copy of text that was already saved; the next agent
 * edit turned that copy into a dialog asking them to choose between two versions of their own work.
 *
 * The e2e proves the symptom in a browser. This proves the contract that fixes it, including the
 * two cases a browser test would have to be built around to reach.
 */
describe('reporting the bytes that reached disk', () => {
  it('reports the text it SENT, not the buffer as it reads when the answer arrives', async () => {
    /**
     * The discriminating case, and the reason `onDisk` exists rather than the surface reading the
     * editor. A keystroke during the round trip is not on disk; a baseline that includes it marks
     * genuinely unsaved work as safe, and the rescue copy is dropped by the save that lands.
     */
    let release: (value: SaveResponse) => void = () => {}
    const h = harness({ save: () => new Promise<SaveResponse>(resolve => { release = resolve }) })
    const details: (string | undefined)[] = []
    const s = createDocumentSession(LOCATION, h.transport, manualScheduler(), {
      onStatus: (_status, detail) => { details.push(detail?.onDisk) },
      onReady: () => {},
    })
    await s.open()

    s.changed('what was sent')
    const inFlight = s.flush()
    s.changed('what was sent plus more')
    release({ outcome: 'saved', hash: 'h1' })
    await inFlight

    expect(details.at(-1)).toBe('what was sent')
  })

  it('reports nothing when the save was refused and rescued to a sibling', async () => {
    /**
     * A conflict wrote the edit *beside* the file and left this one untouched. Reporting the sent
     * text as this file's contents would tell the surface the buffer is safe at the exact moment it
     * is not — and the local copy is the last thing standing between the person and a lost edit.
     */
    const h = harness({ save: async () => ({ outcome: 'conflict', rescue: ['notes conflict.md'] }) })
    const details: (string | undefined)[] = []
    const s = createDocumentSession(LOCATION, h.transport, manualScheduler(), {
      onStatus: (_status, detail) => { details.push(detail?.onDisk) },
      onReady: () => {},
    })
    await s.open()

    s.changed('refused')
    await s.flush()

    expect(details.at(-1)).toBeUndefined()
  })
})
