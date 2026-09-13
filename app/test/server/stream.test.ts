import { describe, expect, it } from 'vitest'

import {
  BACKPRESSURE_GRACE_MS, BATCH_MS, HEARTBEAT_MS, MAX_QUEUED_EVENTS, MAX_STREAMS_PER_CLIENT,
  MAX_STREAMS_TOTAL, createStreamRegistry, streamHeaders, type StreamSink,
} from '../../src/server/stream'
import { TransportErrorCode } from '../../src/contract/wire'
import type { RawHeaders } from '../../src/server/guards'
import type { VerifiedTicket } from '../../src/server/session'

/**
 * Spec §15. The two rules that are not negotiable:
 *
 *   - **`Origin` is validated on every connection.** SSE handshakes are not covered by CORS, which
 *     makes them the classic hole — a cross-origin page can open an `EventSource` and read
 *     everything it emits, with no preflight to stop it. One of the security review's four binding conditions.
 *   - **The queue is bounded, and overflow emits `resync`** rather than buffering. An unbounded
 *     queue behind a sleeping phone is a memory leak with a timer attached.
 */

function timers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    setTimer: (fn: () => void, ms: number): unknown => { pending.set(next, { fn, ms }); return next++ },
    clearTimer: (handle: unknown): void => { pending.delete(handle as number) },
    fire: (ms: number): number => {
      let fired = 0
      for (const [id, entry] of [...pending]) {
        if (entry.ms === ms) { pending.delete(id); entry.fn(); fired++ }
      }
      return fired
    },
    count: () => pending.size,
  }
}

/**
 * `drains: false` makes every write report a peer that is not reading — the input the security review's C10
 * requires the backpressure path be proven against. `dropPeer()` fires the socket-closed listener
 * the registry binds for itself.
 */
function sink(options: { drains?: boolean } = {}): StreamSink & {
  written: string[]
  ended: boolean
  dropPeer: () => void
} {
  const written: string[] = []
  const listeners: Array<() => void> = []
  const s = {
    written,
    ended: false,
    write: (chunk: string) => { written.push(chunk); return options.drains !== false },
    end: () => { s.ended = true },
    onClose: (listener: () => void) => { listeners.push(listener) },
    dropPeer: () => { for (const listener of listeners) listener() },
  }
  return s
}

const ORIGINS = new Set(['http://localhost:8765'])
const good: RawHeaders = { origin: 'http://localhost:8765', 'sec-fetch-site': 'same-origin' }

/**
 * Stands in for a ticket that `verifyTicket` has already branded.
 *
 * The cast is confined to this one helper on purpose. `open()` now accepts only a `VerifiedTicket`
 * (the security review's K5), so a test passing a bare string is a compile error — which is the property being
 * bought. A test suite still has to construct one somehow; doing it in a single named place means
 * there is exactly one line to look at if that guarantee is ever questioned, rather than a cast
 * scattered through thirty call sites.
 */
const asVerified = (value: string): VerifiedTicket => value as VerifiedTicket

/** Every dropped or discarded event, so the tests can assert nothing vanishes silently. */
function dropLog(): { entries: string[]; onDropped: (reason: string, detail: string) => void } {
  const entries: string[] = []
  return { entries, onDropped: (reason, detail) => { entries.push(`${reason}: ${detail}`) } }
}

const registry = (t = timers(), drops = dropLog()) => createStreamRegistry({
  allowedOrigins: ORIGINS, onDropped: drops.onDropped, setTimer: t.setTimer, clearTimer: t.clearTimer,
})

describe('Origin is validated on the handshake — the hole CORS does not cover', () => {
  it('accepts a same-origin connection', () => {
    expect(registry().open(good, asVerified('127.0.0.1'), sink(), 'GET').ok).toBe(true)
  })

  it('refuses a foreign origin', () => {
    const result = registry().open({ ...good, origin: 'https://evil.example' }, asVerified('127.0.0.1'), sink(), 'GET')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(TransportErrorCode.FORBIDDEN_ORIGIN)
  })

  it('refuses a MISSING origin — never treated as same-origin', () => {
    expect(registry().open({}, asVerified('127.0.0.1'), sink(), 'GET').ok).toBe(false)
  })

  it('the three §15 stream constants are the values the spec names — literals, not imports', () => {
    /**
     * All three were mutable in silence: heartbeat 15s → 24h, backpressure grace 5s → 24h, and the
     * queue bound 128 → 1,000,000 each left the whole suite green. Every test drives the fake clock
     * off the imported constant — `t.fire(HEARTBEAT_MS)` fires whatever the value is — so no value
     * can ever fail one.
     *
     * The literals below are §15/F8.4's numbers. Changing a constant now fails here and forces
     * whoever changes it to change the spec's number too, deliberately, rather than by drifting.
     *
     * These are not decoration. A 24-hour heartbeat is a phone that never learns its stream died;
     * a 24-hour grace is the "memory leak with a timer attached" this module's own header names;
     * and a million-event queue is that leak with the bound removed.
     */
    expect(HEARTBEAT_MS, 'a silent stream must prove itself every 15s').toBe(15_000)
    expect(BACKPRESSURE_GRACE_MS, 'a peer that stops draining is closed after 5s').toBe(5_000)
    expect(MAX_QUEUED_EVENTS, 'at most 128 events held before a resync is sent instead').toBe(128)
  })

  it('refuses a non-GET verb ITSELF — the redundant copy has to hold on its own', () => {
    /**
     * `open()` carries its own handshake check, deliberately: this module's header says a guarantee
     * that holds only because of who happens to call it is not a guarantee, and `open()` is the
     * function a future caller reaches for directly.
     *
     * The method policy was proven at the LISTENER (405 on the wire) and nowhere here — so the
     * redundant copy's whole justification was untested. `method` also stopped defaulting to `'GET'`
     * this round precisely because a default there can only ever be the permissive one; this pins
     * that the parameter is actually consulted rather than merely accepted.
     */
    for (const verb of ['POST', 'DELETE', 'PUT', 'PATCH', 'HEAD', '']) {
      const result = registry().open(good, asVerified('127.0.0.1'), sink(), verb)
      expect(result.ok, `${verb || '(empty)'} must not open a stream`).toBe(false)
      if (!result.ok) {
        expect(result.code, `${verb || '(empty)'} is a method refusal`)
          .toBe(TransportErrorCode.METHOD_NOT_ALLOWED)
      }
    }
    // And the mirror, so "refuse everything" cannot pass the loop above.
    expect(registry().open(good, asVerified('127.0.0.1'), sink(), 'GET').ok).toBe(true)
  })

  it('the verb is REQUIRED, not defaulted — proven by the compiler', () => {
    /**
     * A runtime test cannot pin this. `method` defaulted to `'GET'` for one commit, and re-adding
     * that default leaves every test green — because every caller passes a verb, so the default is
     * never exercised. It only bites the caller who *forgets*, which is the entire hazard: a default
     * on a method check can only ever be the permissive value, so there must not be one.
     *
     * `@ts-expect-error` inverts that. It fails the TYPECHECK when the line it guards does NOT
     * error — so restoring the default breaks `npm run typecheck` with "unused '@ts-expect-error'".
     * The compiler is the proof clause, and it runs on every commit and in CI.
     */
    // @ts-expect-error omitting the method must not compile
    expect(() => registry().open(good, asVerified('127.0.0.1'), sink())).toBeTypeOf('function')
  })

  it('refuses Sec-Fetch-Mode: no-cors — §7 MUST #4, which this handshake never checked', () => {
    // "All four of these MUST hold on every non-static route", and #4 is "Sec-Fetch-Mode: no-cors
    // rejected". `checkOrigin` enforced it for the JSON path; this handshake never read the header,
    // so a valid ticket plus `same-origin` plus `no-cors` was answered 200. This module's own header
    // claims it shares the request path's guards — it was a second implementation, and it differed.
    const result = registry().open(
      { ...good, 'sec-fetch-mode': 'no-cors' }, asVerified('127.0.0.1'), sink(), 'GET',
    )
    expect(result.ok).toBe(false)
  })

  it('refuses Origin: null — the sandboxed iframe and file:// case', () => {
    expect(registry().open({ ...good, origin: 'null' }, asVerified('127.0.0.1'), sink(), 'GET').ok).toBe(false)
  })

  it('refuses a Funnel request before anything else', () => {
    const result = registry().open(
      { ...good, 'tailscale-funnel-request': 'true' }, asVerified('127.0.0.1'), sink(), 'GET',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(TransportErrorCode.FUNNEL_REFUSED)
  })

  it('writes nothing to a refused sink', () => {
    const s = sink()
    registry().open({ ...good, origin: 'https://evil.example' }, asVerified('127.0.0.1'), s, 'GET')
    expect(s.written, 'a refused connection must receive no events at all').toEqual([])
  })
})

describe('limits — F8.4', () => {
  it('caps streams per CLIENT at 4 — keyed on the ticket, not an address', () => {
    const r = registry()
    for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) {
      expect(r.open(good, asVerified('127.0.0.1'), sink(), 'GET').ok, `stream ${i + 1}`).toBe(true)
    }
    expect(r.open(good, asVerified('127.0.0.1'), sink(), 'GET').ok, 'the fifth for one address').toBe(false)
  })

  it('lets a different client still connect', () => {
    const r = registry()
    for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) r.open(good, asVerified('127.0.0.1'), sink(), 'GET')
    expect(r.open(good, asVerified('10.0.0.2'), sink(), 'GET').ok).toBe(true)
  })

  it('caps total streams at 32', () => {
    const r = registry()
    for (let i = 0; i < MAX_STREAMS_TOTAL; i++) {
      expect(r.open(good, asVerified(`10.0.0.${i}`), sink(), 'GET').ok, `stream ${i + 1}`).toBe(true)
    }
    expect(r.open(good, asVerified('10.9.9.9'), sink(), 'GET').ok, 'the thirty-third').toBe(false)
  })

  it('frees a slot when a stream closes', () => {
    const r = registry()
    const handles = []
    for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) {
      const opened = r.open(good, asVerified('127.0.0.1'), sink(), 'GET')
      if (opened.ok) handles.push(opened.handle)
    }
    expect(r.open(good, asVerified('127.0.0.1'), sink(), 'GET').ok).toBe(false)
    handles[0]?.close()
    expect(r.open(good, asVerified('127.0.0.1'), sink(), 'GET').ok, 'a closed stream must free its slot').toBe(true)
  })

  it('ends the sink when a stream closes', () => {
    const r = registry()
    const s = sink()
    const opened = r.open(good, asVerified('127.0.0.1'), s, 'GET')
    if (!opened.ok) throw new Error('open failed')
    opened.handle.close()
    expect(s.ended).toBe(true)
  })
})

describe('batching — ≤250ms', () => {
  it('does not write until the batch window elapses', () => {
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    r.broadcast({ type: 'changed', data: { path: 'a.md' } })
    expect(s.written, 'nothing written synchronously').toEqual([])

    t.fire(BATCH_MS)
    expect(s.written).toHaveLength(1)
    expect(s.written[0]).toContain('event: changed')
  })

  it('coalesces several events into one flush', () => {
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    for (let i = 0; i < 5; i++) r.broadcast({ type: 'changed', data: { i } })
    expect(t.fire(BATCH_MS), 'one timer, not five').toBe(1)
    expect(s.written).toHaveLength(5)
  })

  it('delivers to every open stream', () => {
    const t = timers()
    const r = registry(t)
    const a = sink()
    const b = sink()
    r.open(good, asVerified('10.0.0.1'), a, 'GET')
    r.open(good, asVerified('10.0.0.2'), b, 'GET')

    r.broadcast({ type: 'changed', data: { path: 'x.md' } })
    t.fire(BATCH_MS)
    expect(a.written).toHaveLength(1)
    expect(b.written).toHaveLength(1)
  })
})

describe('overflow emits resync rather than buffering without limit', () => {
  it('replaces the backlog with a single resync', () => {
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    for (let i = 0; i < MAX_QUEUED_EVENTS + 50; i++) r.broadcast({ type: 'changed', data: { i } })
    t.fire(BATCH_MS)

    expect(s.written, 'one resync, not a replay').toHaveLength(1)
    expect(s.written[0]).toContain('event: resync')
  })

  it('drops the queue rather than replaying a prefix of a lost sequence', () => {
    // Replaying part of a sequence is worse than admitting the gap: the client would believe it
    // was caught up when it is not.
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    for (let i = 0; i < MAX_QUEUED_EVENTS + 1; i++) r.broadcast({ type: 'changed', data: { i } })
    t.fire(BATCH_MS)
    expect(s.written.join('')).not.toContain('event: changed')
  })

  it('returns to normal delivery after a resync', () => {
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    for (let i = 0; i < MAX_QUEUED_EVENTS + 1; i++) r.broadcast({ type: 'changed', data: { i } })
    t.fire(BATCH_MS)
    s.written.length = 0

    r.broadcast({ type: 'changed', data: { path: 'after.md' } })
    t.fire(BATCH_MS)
    expect(s.written).toHaveLength(1)
    expect(s.written[0]).toContain('after.md')
  })

  it('a slow stream overflowing does not affect a healthy one', () => {
    const t = timers()
    const r = registry(t)
    const slow = sink()
    const healthy = sink()
    r.open(good, asVerified('10.0.0.1'), slow, 'GET')

    for (let i = 0; i < MAX_QUEUED_EVENTS + 1; i++) r.broadcast({ type: 'changed', data: { i } })
    r.open(good, asVerified('10.0.0.2'), healthy, 'GET')
    r.broadcast({ type: 'changed', data: { path: 'late.md' } })
    t.fire(BATCH_MS)

    expect(slow.written[0]).toContain('resync')
    expect(healthy.written.join('')).toContain('late.md')
    expect(healthy.written.join('')).not.toContain('resync')
  })
})

describe('SSE framing', () => {
  it('JSON-encodes data so a newline cannot terminate the event early', () => {
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    // A filename containing a newline and a forged event boundary.
    r.broadcast({ type: 'changed', data: { path: 'evil\n\nevent: forged\ndata: {}' } })
    t.fire(BATCH_MS)

    const written = s.written[0] ?? ''

    // The forged text DOES survive, escaped, inside the data value — that is correct and is the
    // point. What must not survive is its structure: the frame has to remain exactly one event
    // with exactly one data line, so the client parses `event: forged` as characters rather than
    // as an event boundary.
    const lines = written.split('\n')
    expect(lines.filter(l => l.startsWith('event: ')), 'exactly one event line').toHaveLength(1)
    expect(lines.filter(l => l.startsWith('data: ')), 'exactly one data line').toHaveLength(1)
    expect(written.split('\n\n').filter(p => p.length > 0), 'one event, not two').toHaveLength(1)
    expect(written, 'the newline must be escaped, not literal').toContain('\\n')
  })

  it('REFUSES to frame an event whose TYPE carries a newline — the injection data was safe from', () => {
    // the security review's P2 review, condition 5, verified before the fix: one broadcast produced TWO events.
    // `data` was correctly inert; `type` was interpolated raw. Nothing external supplies a type in
    // P2, so it was latent — but P3 and P4 broadcast change events whose type may be derived from
    // something, which is a hunt later versus a regex now.
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    r.broadcast({ type: 'x\ndata: {"forged":true}\n\nevent: injected', data: { a: 1 } })
    t.fire(BATCH_MS)

    expect(s.written, 'a malformed type is dropped, not written raw').toEqual([])
  })

  it('accepts ordinary event types and rejects the shapes that could inject', () => {
    const r = registry()
    for (const good of ['changed', 'resync', 'tree-updated', 'a1']) {
      expect(r.isValidEventType(good), `"${good}" must be framable`).toBe(true)
    }
    for (const bad of ['', 'Changed', '1changed', 'a b', 'a\nb', 'a:b', 'a\r\nb', '../x']) {
      expect(r.isValidEventType(bad), `"${bad}" must be refused`).toBe(false)
    }
  })

  it('writes a heartbeat as a comment line', () => {
    const r = registry()
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')
    r.heartbeat()
    expect(s.written[0]).toBe(': heartbeat\n\n')
  })
})

describe('backpressure bounds memory — security review C10 / S1', () => {
  /**
   * `MAX_QUEUED_EVENTS` bounded the queue held BEFORE writing. Once written, an event moved into
   * Node's socket buffer, which is unbounded when the peer is not draining — so the bound was
   * applied one layer above the leak, behind exactly the sleeping phone §15 calls the normal case.
   */
  it('stops writing and closes after a grace when the peer stops draining', () => {
    const t = timers()
    const drops = dropLog()
    const r = registry(t, drops)
    const s = sink({ drains: false })
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    r.broadcast({ type: 'changed', data: { n: 1 } })
    t.fire(BATCH_MS)

    // One write attempt, which reported a peer that is not reading.
    expect(s.written.length).toBe(1)
    expect(drops.entries.some(e => e.startsWith('backpressure:'))).toBe(true)

    // Everything after it is withheld rather than piled into a buffer nobody is emptying.
    r.broadcast({ type: 'changed', data: { n: 2 } })
    t.fire(BATCH_MS)
    expect(s.written.length, 'nothing more may be written to a stream that is not draining').toBe(1)

    // And the stream does not linger forever holding a slot.
    expect(r.size()).toBe(1)
    t.fire(BACKPRESSURE_GRACE_MS)
    expect(s.ended).toBe(true)
    expect(r.size()).toBe(0)
  })

  it('a draining peer is untouched by any of this', () => {
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')
    r.broadcast({ type: 'changed', data: { n: 1 } })
    t.fire(BATCH_MS)
    r.broadcast({ type: 'changed', data: { n: 2 } })
    t.fire(BATCH_MS)
    expect(s.written.length).toBe(2)
    expect(r.size()).toBe(1)
  })
})

describe('the registry closes its own dead streams — security review C11 / S3', () => {
  it('drops a stream when its peer goes away, without the route remembering to say so', () => {
    // The fix could have been a line in the route binding `res.on('close')`. A guarantee that
    // depends on a caller remembering is the shape that has failed in this build repeatedly, so the
    // registry binds its own teardown and `StreamSink.onClose` is a required field.
    const r = registry()
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')
    expect(r.size()).toBe(1)

    s.dropPeer()

    expect(r.size(), 'a stream whose peer is gone must not hold a slot in the cap').toBe(0)
    expect(s.ended).toBe(true)
  })

  it('a dead stream stops receiving broadcasts', () => {
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')
    s.dropPeer()
    const before = s.written.length

    r.broadcast({ type: 'changed', data: {} })
    t.fire(BATCH_MS)

    expect(s.written.length, 'broadcast must not write to an ended sink').toBe(before)
  })

  it('frees the slot so the cap is not filled by corpses', () => {
    const r = registry()
    for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) {
      const s = sink()
      expect(r.open(good, asVerified('127.0.0.1'), s, 'GET').ok).toBe(true)
      s.dropPeer()
    }
    // Without the teardown these four would still occupy the per-address allowance.
    expect(r.open(good, asVerified('127.0.0.1'), sink(), 'GET').ok).toBe(true)
  })
})

describe('the heartbeat is wired, not merely declared — security review C11 / S2', () => {
  /**
   * `HEARTBEAT_MS` was declared and read nowhere; `heartbeat()` was called by nothing. The third
   * limit in this build that existed only as a number, after R5's connection cap and R6's idle
   * eviction — so the registry now owns the timer rather than exposing it for a caller to schedule.
   */
  it('schedules itself once a stream is open, and beats on its own', () => {
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    expect(t.fire(HEARTBEAT_MS), 'a heartbeat must be scheduled by opening a stream').toBe(1)
    expect(s.written).toContain(': heartbeat\n\n')
  })

  it('keeps beating', () => {
    const t = timers()
    const r = registry(t)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')
    t.fire(HEARTBEAT_MS)
    expect(t.fire(HEARTBEAT_MS), 'the heartbeat must reschedule itself').toBe(1)
    expect(s.written.filter(chunk => chunk === ': heartbeat\n\n').length).toBe(2)
  })

  it('holds no timer when nothing is open', () => {
    // An idle server with a pending timer is a process that will not exit, and a test that leaves
    // one is a test suite that hangs.
    const t = timers()
    const r = registry(t)
    expect(t.count()).toBe(0)

    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')
    expect(t.count()).toBeGreaterThan(0)

    s.dropPeer()
    expect(t.count(), 'closing the last stream must stop the heartbeat').toBe(0)
  })

  it('stop() closes everything and leaves no timer behind', () => {
    const t = timers()
    const r = registry(t)
    const a = sink()
    const b = sink()
    r.open(good, asVerified('127.0.0.1'), a, 'GET')
    r.open(good, asVerified('127.0.0.1'), b, 'GET')

    r.stop()

    expect(a.ended).toBe(true)
    expect(b.ended).toBe(true)
    expect(r.size()).toBe(0)
    expect(t.count()).toBe(0)
  })
})

describe('nothing is dropped silently — security review C11 / S5', () => {
  it('records a refusal to frame a malformed event type', () => {
    // Dropping is correct — a malformed type written raw is how it becomes an injection. But an
    // event vanishing with no trace is R3's lesson (an unobservable 500) in the event channel.
    const t = timers()
    const drops = dropLog()
    const r = registry(t, drops)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    r.broadcast({ type: 'x\ndata: {"forged":true}\n\nevent: injected', data: { a: 1 } })
    t.fire(BATCH_MS)

    expect(s.written.length, 'the malformed event must not reach the wire').toBe(0)
    expect(drops.entries.some(e => e.startsWith('malformed-type:'))).toBe(true)
  })

  it('records how many events an overflow discarded', () => {
    const t = timers()
    const drops = dropLog()
    const r = registry(t, drops)
    const s = sink()
    r.open(good, asVerified('127.0.0.1'), s, 'GET')

    for (let i = 0; i <= MAX_QUEUED_EVENTS; i++) r.broadcast({ type: 'changed', data: { i } })
    t.fire(BATCH_MS)

    expect(drops.entries.some(e => e.startsWith('overflow:'))).toBe(true)
    expect(s.written.join('')).toContain('resync')
  })
})

describe('response headers', () => {
  it('carries the shared security headers — security review C11 / S6', () => {
    // It used to return only the stream-specific headers with a comment telling the caller to add
    // these. `assetHeaders()` one module over spreads them itself, so the two response builders
    // disagreed about whose job it was — and a text/event-stream response is the response class
    // where a missing nosniff is most interesting.
    const headers = streamHeaders()
    expect(headers['content-security-policy'] ?? '').toContain("default-src 'none'")
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('no-referrer')
  })

  it('is an event stream that is never cached', () => {
    const headers = streamHeaders()
    expect(headers['content-type']).toBe('text/event-stream')
    // Spec §15: every response carries an explicit Cache-Control, because with none stated Safari
    // applies heuristic caching and pins a stale shell on an installed web app — permanently, since
    // the app never relaunches to notice.
    expect(headers['cache-control']).toBe('no-store')
  })

  it('disables proxy buffering, which would make a live stream arrive in bursts', () => {
    expect(streamHeaders()['x-accel-buffering']).toBe('no')
  })
})

describe('an unverified key cannot reach the stream cap — security review K5', () => {
  it('refuses a raw string at COMPILE time, not at runtime', () => {
    /**
     * The stream cap is keyed on the ticket, and the ticket is trustworthy **only because it was
     * verified before the cap used it**. `open()` used to take a `clientKey: string`, so nothing
     * stopped a future caller passing something unverified — and this build's repeated lesson is
     * that a guarantee depending on a caller remembering is not a guarantee. It is why
     * `StreamSink.onClose` is required and why a tailnet listener cannot be built without a Funnel
     * watch.
     *
     * `verifyTicket` is now the only thing that can produce a `VerifiedTicket`, so the check below
     * is enforced by `tsc` rather than by this assertion. The `@ts-expect-error` IS the test: if the
     * brand is ever removed, the directive becomes unused and **the typecheck fails**, which is the
     * loud failure a runtime assertion could not give.
     */
    const r = registry()
    // @ts-expect-error a bare string is not a verified ticket
    const refusedByTheCompiler = (): unknown => r.open(good, 'not-verified', sink(), 'GET')

    expect(typeof refusedByTheCompiler).toBe('function')
  })
})
