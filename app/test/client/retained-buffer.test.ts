import { describe, expect, it } from 'vitest'

import {
  MAX_BUFFER_BYTES, createRetainedBuffers,
  type BufferStore, type RetainedBuffer,
} from '../../src/client/retained-buffer'

/**
 * Spec §13.8. A retained buffer is the rescue path for an unsaved edit, which makes every rule here
 * a data-safety rule rather than storage plumbing.
 *
 * The line the whole file turns on: **a retained buffer is never auto-replayed.**
 */

function fakeStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial))
  let failWith: Error | null = null
  const store: BufferStore = {
    get: async key => data.get(key),
    put: async (key, value) => {
      if (failWith !== null) throw failWith
      data.set(key, value)
    },
    delete: async key => { data.delete(key) },
    keys: async () => [...data.keys()],
  }
  return { store, data, failNextPutWith: (error: Error) => { failWith = error } }
}

const buffer = (over: Partial<RetainedBuffer> = {}): RetainedBuffer => ({
  rootId: 'soil',
  segments: ['notes.md'],
  content: '# Notes\n\nunsaved work',
  identityToken: 'ident-1',
  savedAtMs: 1_754_524_800_000,
  ...over,
})

const registered = (id: string): boolean => id === 'soil'

/**
 * The storage key, spelled as an escape.
 *
 * NUL-delimited because it is the one byte a path cannot contain. Written with the escape rather
 * than typed, for the same reason the implementation is: a literal NUL renders as an ordinary space
 * in every editor, so a fixture keyed on a space and one keyed on NUL look identical — and the
 * first version of these tests was keyed on a space and missed every lookup.
 */
const KEY_NOTES = `soil\u0000notes.md`

describe('IT IS NEVER AUTO-REPLAYED', () => {
  it('reports a matching buffer as AVAILABLE — an offer, not a restore', () => {
    // Even the happy path only reports. The caller presents the choice; nothing here writes it back.
    const { store } = fakeStore()
    const buffers = createRetainedBuffers(store)
    return buffers.retain(buffer()).then(async () => {
      const outcome = await buffers.inspect('soil', ['notes.md'], 'ident-1', registered)
      expect(outcome.kind).toBe('available')
    })
  })

  it('reports a MISMATCHED identity as stale rather than restoring over it', async () => {
    // The case auto-replay destroys: the file changed while the edit sat unsaved, and replaying
    // would overwrite whatever changed it — an agent, another device, the operator themselves.
    const { store } = fakeStore()
    const buffers = createRetainedBuffers(store)
    await buffers.retain(buffer({ identityToken: 'ident-1' }))

    const outcome = await buffers.inspect('soil', ['notes.md'], 'ident-2-file-changed', registered)
    expect(outcome.kind).toBe('stale')
    if (outcome.kind === 'stale') expect(outcome.buffer.content).toContain('unsaved work')
  })

  it('keeps the stale buffer rather than discarding it — the user has to choose', async () => {
    // view diff / save as conflict sibling / discard. Silently dropping it decides for them.
    const { store, data } = fakeStore()
    const buffers = createRetainedBuffers(store)
    await buffers.retain(buffer())
    await buffers.inspect('soil', ['notes.md'], 'different', registered)
    expect(data.size, 'the buffer must survive the inspection').toBe(1)
  })

  it('reports none when nothing was retained', async () => {
    const { store } = fakeStore()
    const buffers = createRetainedBuffers(store)
    expect((await buffers.inspect('soil', ['notes.md'], 'x', registered)).kind).toBe('none')
  })
})

describe('a quota failure is a BLOCKING ERROR, never a dropped edit', () => {
  it('reports quota distinctly so the caller can block on it', async () => {
    // Swallowing this lets the user believe their work is safe when nothing was written — which is
    // the failure §13.8 names by writing the rule down.
    const { store, failNextPutWith } = fakeStore()
    const quota = new Error('quota')
    quota.name = 'QuotaExceededError'
    failNextPutWith(quota)

    const result = await createRetainedBuffers(store).retain(buffer())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('quota')
  })

  it('reports any other store failure rather than throwing', async () => {
    const { store, failNextPutWith } = fakeStore()
    failNextPutWith(new Error('disk on fire'))
    const result = await createRetainedBuffers(store).retain(buffer())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('store-failed')
  })

  it('never reports success when nothing was written', async () => {
    const { store, data, failNextPutWith } = fakeStore()
    failNextPutWith(new Error('nope'))
    const result = await createRetainedBuffers(store).retain(buffer())
    expect(result.ok).toBe(false)
    expect(data.size).toBe(0)
  })
})

describe('restored state is untrusted input — F9.2', () => {
  it('discards a corrupt blob', async () => {
    const { store } = fakeStore({ [KEY_NOTES]: { rootId: 'soil', content: 42 } })
    const outcome = await createRetainedBuffers(store)
      .inspect('soil', ['notes.md'], 'x', registered)
    expect(outcome.kind).toBe('discarded')
    if (outcome.kind === 'discarded') expect(outcome.reason).toContain('corrupt')
  })

  it('discards a blob that is not an object at all', async () => {
    for (const junk of ['a string', 42, [], true]) {
      const { store } = fakeStore({ [KEY_NOTES]: junk })
      const outcome = await createRetainedBuffers(store)
        .inspect('soil', ['notes.md'], 'x', registered)
      expect(outcome.kind, JSON.stringify(junk)).toBe('discarded')
    }
  })

  it('refuses to RETAIN more than 256 KB', async () => {
    const { store } = fakeStore()
    const result = await createRetainedBuffers(store)
      .retain(buffer({ content: 'a'.repeat(MAX_BUFFER_BYTES + 1) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('too-large')
  })

  it('discards an oversized blob found in storage', async () => {
    // The cap has to hold on the way OUT too — a blob can predate the limit, or be written by an
    // older build.
    const { store } = fakeStore({
      [KEY_NOTES]: { ...buffer(), content: 'a'.repeat(MAX_BUFFER_BYTES + 1) },
    })
    const outcome = await createRetainedBuffers(store)
      .inspect('soil', ['notes.md'], 'ident-1', registered)
    expect(outcome.kind).toBe('discarded')
  })

  it('discards a buffer for a folder that is no longer registered', async () => {
    const { store, data } = fakeStore()
    const buffers = createRetainedBuffers(store)
    await buffers.retain(buffer({ rootId: 'gone' }))
    const outcome = await buffers.inspect('gone', ['notes.md'], 'ident-1', registered)
    expect(outcome.kind).toBe('discarded')
    expect(data.size, 'and cleaned up').toBe(0)
  })

  it('survives a store that throws on read', async () => {
    const store: BufferStore = {
      get: async () => { throw new Error('IndexedDB is gone') },
      put: async () => { /* unused */ },
      delete: async () => { /* unused */ },
      keys: async () => [],
    }
    const outcome = await createRetainedBuffers(store).inspect('soil', ['a.md'], 'x', registered)
    expect(outcome.kind).toBe('discarded')
  })
})

describe('forgetting a deregistered folder', () => {
  it('drops every buffer for that folder', async () => {
    const { store, data } = fakeStore()
    const buffers = createRetainedBuffers(store)
    await buffers.retain(buffer({ segments: ['a.md'] }))
    await buffers.retain(buffer({ segments: ['b.md'] }))
    await buffers.retain(buffer({ rootId: 'other', segments: ['c.md'] }))

    expect(await buffers.forgetRoot('soil')).toBe(2)
    expect([...data.keys()]).toEqual([`other\u0000c.md`])
  })

  it('does NOT drop a folder whose id merely shares a prefix', async () => {
    // The same segment-boundary reasoning as spec §5, applied to a storage key: `soil` must not
    // match `soil-archive`.
    const { store, data } = fakeStore()
    const buffers = createRetainedBuffers(store)
    await buffers.retain(buffer({ rootId: 'soil', segments: ['a.md'] }))
    await buffers.retain(buffer({ rootId: 'soil-archive', segments: ['b.md'] }))

    expect(await buffers.forgetRoot('soil')).toBe(1)
    expect([...data.keys()]).toEqual([`soil-archive\u0000b.md`])
  })
})

/**
 * **The phone durability notice was CUT on 2026-08-10 and its test went with it. §21.**
 *
 * §13.8 required a plain-language sentence saying unsaved work is only durable on a phone if Soil
 * Viewer is on the Home Screen. The operator: *"I'm just gonna put it on my home screen."* The notice
 * warned about a condition they do not have, and this app already has a rule about training people
 * to dismiss dialogs unread.
 *
 * Recorded here rather than silently deleted: a promise that disappears from a list of promises is
 * the thing the build's status page exists to prevent. The eviction behaviour itself is unchanged
 * and still real — see the module's header.
 */

/**
 * TWO SIZE-ACCOUNTING PROPERTIES THAT NOTHING DEFENDED.
 *
 * `MAX_BUFFER_BYTES` was only ever compared to itself, and swapping `utf8Bytes` for `value.length`
 * left the suite green — because every fixture is ASCII, where the two agree exactly.
 */
describe('the retained-buffer size rules', () => {
  it('caps at the literal §13.8 figure, not at whatever the constant happens to say', () => {
    expect(MAX_BUFFER_BYTES, '§13.8: 256 KB per buffer').toBe(256 * 1024)
  })

  it('measures UTF-8 BYTES, not JavaScript characters — driven through retain()', async () => {
    /**
     * Swapping `utf8Bytes` for `value.length` left the whole suite green, because every fixture in
     * this file is ASCII, where the two agree exactly. The user's notes are full of em dashes and
     * curly quotes, which are three bytes each and one character each.
     *
     * Under-counting means a buffer IndexedDB will refuse sails past the cap and is dropped
     * silently at write time — the unrecoverable-edit path §13.8 exists to close.
     *
     * The payload below is deliberately UNDER the cap in characters and OVER it in bytes, so a
     * character-counting implementation accepts it and a byte-counting one refuses.
     */
    const emDash = '\u2014'
    const content = emDash.repeat(MAX_BUFFER_BYTES / 2)

    expect(content.length, 'under the cap if you count characters').toBeLessThan(MAX_BUFFER_BYTES)
    expect(
      new TextEncoder().encode(content).length,
      'over the cap once encoded, which is what storage actually stores',
    ).toBeGreaterThan(MAX_BUFFER_BYTES)

    const { store } = fakeStore()
    const result = await createRetainedBuffers(store).retain(buffer({ content }))

    expect(result.ok, 'must be refused on its BYTE size').toBe(false)
    if (!result.ok) expect(result.reason).toBe('too-large')
  })
})

/**
 * THE RELATIONSHIP BETWEEN THE TWO TIMERS, asserted rather than assumed.
 *
 * Both are armed by the same keystroke, and `main.tsx` arms the save first — so at equal delays the
 * save fires first, its success discards the buffer, and the retain writes a fresh one immediately
 * afterwards. Every successful save would leave a rescue copy behind.
 *
 * This build has made the two-constants mistake once already, and it cost more: the 1 MB request
 * limit and the 2 MB editability limit were each correct alone, and every file between them could
 * be opened and never saved. Three tests covered the number; none asked what it had to be true
 * *relative to*.
 */
describe('the retain delay against the autosave delay', () => {
  it('keeps, then saves, then drops', async () => {
    const { RETAIN_QUIET_MS } = await import('../../src/client/retained-buffer')
    const { AUTOSAVE_QUIET_MS } = await import('../../src/client/editor/save-policy')
    expect(RETAIN_QUIET_MS).toBeLessThan(AUTOSAVE_QUIET_MS)
  })
})
