import { describe, expect, it } from 'vitest'

import {
  BACKOFF_MAX_MS, BACKOFF_MIN_MS, STREAM_STABLE_MS, URL_DEADLINE_MS, createLiveStream,
  type EventSourceLike, type StreamState,
} from '../../src/client/live-stream'

/**
 * Spec §15's live-update client. The second rule is a hole rather than polish, and it is the reason
 * most of this file exists:
 *
 * > *"iOS suspends a backgrounded web app, and a suspended `EventSource` can come back dead without
 * > ever firing `error`. Backoff-on-error therefore never triggers: the stream is silently
 * > finished, the app looks connected, and no update ever arrives again."*
 *
 * So the recovery cannot be reactive. Every test below that reopens on visibility does so WITHOUT
 * an error having fired, because in the failure being defended against no error ever fires.
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
    delays: () => [...pending.values()].map(e => e.ms),
    count: () => pending.size,
  }
}

/**
 * Lets an in-flight connect finish.
 *
 * **Opening a stream is asynchronous now**, and that is a requirement rather than an implementation
 * detail: the security review's C6 says the client obtains a *fresh ticket* on every connect it initiates, because
 * `EventSource` reconnects on its own with no chance to change the URL and its `onerror` cannot
 * distinguish "server down" from "403, stale ticket". So `start()` no longer produces an
 * `EventSource` synchronously, and a test that asserts immediately after it is asserting against a
 * connect that has not happened.
 *
 * A macrotask rather than `await Promise.resolve()`: the connect path awaits the URL supplier and
 * then continues, so the number of microtasks is an implementation detail this helper should not
 * encode.
 */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** A fake EventSource that records what happened to it. */
function fakeSources() {
  const made: Array<EventSourceLike & {
    url: string
    closed: boolean
    listeners: Map<string, (event: { data: string }) => void>
    emit: (type: string, data: unknown) => void
  }> = []

  const open = (url: string): EventSourceLike => {
    const listeners = new Map<string, (event: { data: string }) => void>()
    const source = {
      url,
      closed: false,
      listeners,
      onopen: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      close: () => { source.closed = true },
      addEventListener: (type: string, listener: (event: { data: string }) => void) => {
        listeners.set(type, listener)
      },
      emit: (type: string, data: unknown) => {
        listeners.get(type)?.({ data: JSON.stringify(data) })
      },
    }
    made.push(source)
    return source
  }

  return { open, made, latest: () => made[made.length - 1] }
}

function build(overrides: { onEvent?: (e: { type: string; data: unknown }) => void } = {}) {
  const t = timers()
  const sources = fakeSources()
  const events: Array<{ type: string; data: unknown }> = []
  const states: StreamState[] = []
  let refetches = 0

  const stream = createLiveStream({
    open: sources.open,
    url: async () => '/events',
    onEvent: overrides.onEvent ?? (e => events.push(e)),
    onRefetch: () => { refetches++ },
    onStateChange: s => states.push(s),
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  })

  return { stream, t, sources, events, states, refetches: () => refetches }
}

describe('connecting', () => {
  it('opens a stream at a RELATIVE url — no absolute URL anywhere in the bundle', async () => {
    // Spec §7/F9.3: the client builds same-origin relative URLs only. An absolute URL in the bundle
    // is a hostname baked into a file that gets served over a different one.
    const { stream, sources } = build()
    stream.start(); await settle()
    expect(sources.latest()?.url).toBe('/events')
    expect(sources.latest()?.url.includes('://')).toBe(false)
  })

  it('goes live and refetches on a confirmed open', async () => {
    const { stream, sources, states, refetches } = build()
    stream.start(); await settle()
    sources.latest()?.onopen?.()
    expect(stream.state()).toBe('live')
    expect(states).toContain('live')
    // Anything that changed while disconnected was never delivered and no reconnection replays it.
    expect(refetches()).toBe(1)
  })

  it('is idempotent — a second start does not open a second stream', async () => {
    // Two live streams is worse than none: both deliver, neither is authoritative.
    const { stream, sources } = build()
    stream.start(); await settle()
    stream.start(); await settle()
    expect(sources.made).toHaveLength(1)
  })

  it('delivers a known event with its parsed payload', async () => {
    const { stream, sources, events } = build()
    stream.start(); await settle()
    sources.latest()?.onopen?.()
    sources.latest()?.emit('changed', { rootId: 'soil', segments: ['a.md'] })
    expect(events).toEqual([{ type: 'changed', data: { rootId: 'soil', segments: ['a.md'] } }])
  })

  it('survives a malformed payload rather than dying on it', async () => {
    // One bad frame must not kill the connection that would deliver the next good one.
    const { stream, sources, events } = build()
    stream.start(); await settle()
    sources.latest()?.onopen?.()
    sources.latest()?.listeners.get('changed')?.({ data: '{not json' })
    expect(events).toEqual([{ type: 'changed', data: null }])
    sources.latest()?.emit('changed', { ok: true })
    expect(events).toHaveLength(2)
  })
})

describe('backoff — 1s to 60s', () => {
  it('waits the MINIMUM on the first retry, not double it', async () => {
    const { stream, sources, t } = build()
    stream.start(); await settle()
    sources.latest()?.onerror?.()
    expect(t.delays()).toEqual([BACKOFF_MIN_MS])
  })

  it('doubles on each subsequent failure', async () => {
    const { stream, sources, t } = build()
    stream.start(); await settle()
    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      sources.latest()?.onerror?.()
      seen.push(t.delays()[0] ?? 0)
      t.fire(seen[seen.length - 1] ?? 0); await settle()
    }
    expect(seen).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  it('caps at 60s however long it keeps failing', async () => {
    const { stream, sources, t } = build()
    stream.start(); await settle()
    for (let i = 0; i < 20; i++) {
      sources.latest()?.onerror?.()
      const delay = t.delays()[0] ?? 0
      expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS)
      t.fire(delay); await settle()
    }
    expect(stream.retryDelayMs()).toBe(BACKOFF_MAX_MS)
  })

  it('resets only on a stream that SURVIVES, never on the handshake', async () => {
    /**
     * **THIS TEST USED TO ASSERT THE DEFECT.** Its last two lines were `onopen()` then `onerror()`
     * with `expect(t.delays()).toEqual([BACKOFF_MIN_MS])` — an accept-and-drop cycle, pinned as
     * correct, under a title claiming the opposite. It would have stayed green forever while the
     * client retried once a second indefinitely.
     *
     * That is the third time in this build a test has been found asserting the very thing it was
     * named to prevent. The others were `does not re-fetch when the session is still good` and the
     * first exhaustion test.
     */
    const { stream, sources, t } = build()
    stream.start(); await settle()
    sources.latest()?.onerror?.()
    t.fire(1_000); await settle()
    sources.latest()?.onerror?.()
    expect(t.delays(), 'still backing off, because nothing ever opened').toEqual([2_000])

    t.fire(2_000); await settle()
    sources.latest()?.onopen?.()
    sources.latest()?.onerror?.()
    expect(t.delays(), 'accepted then dropped is not an open — keep climbing').toEqual([4_000])
  })

  it('shows a reconnecting state rather than spinning silently', async () => {
    const { stream, sources, states } = build()
    stream.start(); await settle()
    sources.latest()?.onopen?.()
    sources.latest()?.onerror?.()
    expect(stream.state()).toBe('reconnecting')
    expect(states).toContain('reconnecting')
  })

  it('closes the dead source before opening a replacement', async () => {
    const { stream, sources, t } = build()
    stream.start(); await settle()
    const first = sources.latest()
    sources.latest()?.onerror?.()
    t.fire(1_000); await settle()
    expect(first?.closed, 'the dead stream must be closed, not abandoned').toBe(true)
    expect(sources.made).toHaveLength(2)
  })
})

describe('THE iOS HOLE — reopen on visibility, unconditionally, with no error', () => {
  it('tears down and reopens without any error having fired', async () => {
    // The defect in one test: a suspended EventSource comes back dead and NEVER fires error, so
    // backoff-on-error never triggers. Note no onerror call anywhere below.
    const { stream, sources, refetches } = build()
    stream.start(); await settle()
    sources.latest()?.onopen?.()
    const suspended = sources.latest()

    stream.onVisible(); await settle()

    expect(suspended?.closed, 'the possibly-dead stream must be discarded').toBe(true)
    expect(sources.made, 'and a fresh one opened').toHaveLength(2)
    sources.latest()?.onopen?.()
    expect(refetches(), 'and the state refetched, because nothing replays what was missed').toBe(2)
  })

  it('does NOT probe first — there is no signal to probe for', async () => {
    // A probe is just another way of waiting for a signal that never comes. The reopen happens
    // even when the stream looks perfectly healthy, because a dead one looks healthy too.
    const { stream, sources } = build()
    stream.start(); await settle()
    sources.latest()?.onopen?.()
    expect(stream.state()).toBe('live')
    stream.onVisible(); await settle()
    expect(sources.made).toHaveLength(2)
  })

  it('resets the backoff, so returning to the app is instant', async () => {
    // Coming back to a suspended app should not wait out a 60s backoff accumulated while it slept.
    const { stream, sources, t } = build()
    stream.start(); await settle()
    for (let i = 0; i < 8; i++) {
      sources.latest()?.onerror?.()
      t.fire(t.delays()[0] ?? 0)
    }
    expect(stream.retryDelayMs()).toBeGreaterThan(BACKOFF_MIN_MS)
    stream.onVisible(); await settle()
    expect(stream.retryDelayMs()).toBe(BACKOFF_MIN_MS)
  })

  it('does nothing when the stream was never started', async () => {
    const { stream, sources } = build()
    stream.onVisible(); await settle()
    expect(sources.made).toHaveLength(0)
  })

  it('cancels a pending retry rather than leaving two reconnections racing', async () => {
    const { stream, sources, t } = build()
    stream.start(); await settle()
    sources.latest()?.onerror?.()
    expect(t.count()).toBe(1)
    stream.onVisible(); await settle()
    expect(t.count(), 'the queued retry must be cancelled').toBe(0)
    expect(sources.made).toHaveLength(2)
  })
})

describe('a throw from caller code must not leave it dead-but-"live"', () => {
  it('schedules a retry when open() throws instead of escaping', async () => {
    // Found by the P3 review. The throw escaped, leaving state 'live' with ZERO pending retries —
    // the status line kept saying "Live" and no update ever arrived again. That is spec §15's named
    // iOS failure mode, reintroduced by the recovery path built to prevent it, and it escaped
    // through a visibilitychange handler where a throw goes nowhere at all.
    const t = timers()
    const stream = createLiveStream({
      open: () => { throw new Error('EventSource refused') },
      url: async () => '/events',
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    expect(() => stream.start()).not.toThrow()
    // Settle before asserting: the throw now happens inside the async connect, so the state it
    // leaves behind is not observable until that has run. The property is unchanged — the throw is
    // caught and a retry is scheduled — but a synchronous assertion here would be checking a
    // connect that had not yet reached `open()`.
    await settle()
    expect(stream.state(), 'never "live" when nothing opened').toBe('reconnecting')
    expect(t.delays(), 'and a retry is pending').toEqual([BACKOFF_MIN_MS])
  })

  it('does not escape through onVisible either', async () => {
    const t = timers()
    let failing = true
    const stream = createLiveStream({
      open: () => { if (failing) throw new Error('refused'); return fakeSources().open('/events') },
      url: async () => '/events',
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    stream.start(); await settle()
    failing = true
    expect(() => stream.onVisible()).not.toThrow()
    expect(stream.state()).toBe('reconnecting')
  })

  it('a throwing onRefetch does not leave the state dangling', async () => {
    // onRefetch is caller code. An exception used to escape into the EventSource's own onopen
    // handler, leaving the state 'live' with nothing scheduled — the same dead-but-connected shape.
    const t = timers()
    const sources = fakeSources()
    const stream = createLiveStream({
      open: sources.open,
      url: async () => '/events',
      onEvent: () => { /* unused */ },
      onRefetch: () => { throw new Error('refetch blew up') },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    stream.start(); await settle()

    expect(() => sources.latest()?.onopen?.()).not.toThrow()
    expect(stream.state(), 'the connection is real, so live is honest').toBe('live')
    expect(
      t.delays().filter(d => d !== STREAM_STABLE_MS),
      'no RETRY is scheduled — the stability timer is not one, and is expected here',
    ).toEqual([])
  })
})

describe('the backoff reset rule, stated accurately', () => {
  it('resets on an EXPLICIT visibility reopen — the invariant is who asked, not what happened', async () => {
    // The P3 review was right that "resets only on a confirmed open" was false. The accurate rule:
    // it resets on a confirmed open AND on an explicit visibility reopen, never on an automatic
    // retry. An automatic retry resetting its own backoff is the runaway loop; a person returning
    // to the app is a new intent, and making them wait out 60s accumulated while the phone slept
    // is the wrong answer to the wrong question.
    const { stream, sources, t } = build()
    stream.start(); await settle()
    for (let i = 0; i < 6; i++) {
      sources.latest()?.onerror?.()
      t.fire(t.delays()[0] ?? 0)
    }
    expect(stream.retryDelayMs()).toBeGreaterThan(BACKOFF_MIN_MS)
    stream.onVisible(); await settle()
    expect(stream.retryDelayMs()).toBe(BACKOFF_MIN_MS)
  })

  it('does NOT reset on an automatic retry — that would be the runaway loop', async () => {
    const { stream, sources, t } = build()
    stream.start(); await settle()
    sources.latest()?.onerror?.()
    t.fire(1_000); await settle()
    sources.latest()?.onerror?.()
    expect(t.delays(), 'an automatic retry keeps growing the backoff').toEqual([2_000])
  })

  /**
   * AN OPEN THAT IMMEDIATELY DROPS IS NOT A WORKING STREAM, AND THE OLD RULE COULD NOT TELL.
   *
   * `onopen` reset the backoff, defended as safe because it was *"a CONFIRMED open — never an
   * attempt"*, and the comment named the exact hazard: *"resetting on the attempt would make a
   * server that accepts and immediately drops produce a 1s retry loop forever."*
   *
   * It was already resetting on the attempt. `listener.ts` writes `: open\n\n` unconditionally the
   * instant a stream is accepted — added so WebKit fires `onopen` promptly instead of showing
   * "Connecting…" for fifteen seconds — so a fourth adversarial round measured `onopen` arriving
   * **1–2ms** after accept, in both engines, carrying no information about whether the stream
   * survives. Fifteen accept-and-drop cycles waited `1000, 1000, 1000…` and minted **61 tickets in
   * 60 seconds**.
   *
   * Two facts, each correct alone, three commits and two files apart. Three single-file rounds
   * missed it.
   *
   * The rule is now **survival, not acceptance**: the backoff resets once a stream has stayed open
   * for `STREAM_STABLE_MS`. An explicit visibility reopen still resets immediately — that is a
   * person's intent, tested above, and it is unchanged.
   */
  it('an accept-and-drop loop backs off — the reset needs SURVIVAL, not a handshake', async () => {
    const { stream, sources, t } = build()
    stream.start(); await settle()

    const waits: number[] = []
    for (let i = 0; i < 5; i++) {
      sources.latest()?.onopen?.() // accepted, and the server writes its opening byte at once
      sources.latest()?.onerror?.() // …then drops, well inside STREAM_STABLE_MS
      const wait = t.delays()[0] ?? 0
      waits.push(wait)
      t.fire(wait)
      await settle()
    }

    expect(waits, 'a server that accepts and drops must not be retried once a second forever')
      .toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  it('a stream that actually survives resets the backoff', async () => {
    const { stream, sources, t } = build()
    stream.start(); await settle()

    // Climb the ladder first, so a reset is observable rather than a no-op.
    for (let i = 0; i < 3; i++) {
      sources.latest()?.onerror?.()
      t.fire(t.delays()[0] ?? 0)
      await settle()
    }
    expect(stream.retryDelayMs()).toBeGreaterThan(BACKOFF_MIN_MS)

    sources.latest()?.onopen?.()
    expect(stream.retryDelayMs(), 'not yet — it has only been accepted').toBeGreaterThan(BACKOFF_MIN_MS)

    t.fire(STREAM_STABLE_MS)
    expect(stream.retryDelayMs(), 'it stayed up, so the next failure starts from the bottom')
      .toBe(BACKOFF_MIN_MS)
  })

  it('the stability window is a REAL delay, not zero — a literal, not the constant', () => {
    /**
     * Setting `STREAM_STABLE_MS` to `0` left every test green, because the whole suite drives the
     * fake clock off the imported constant — `t.fire(STREAM_STABLE_MS)` fires whatever the value
     * is, including zero. So the reset-on-attempt behaviour that caused a phone to reconnect once
     * a second, forever, was reintroducible in silence.
     *
     * Two literal facts pinned here instead. The value must be a genuine delay, and it must be
     * longer than the shortest backoff — otherwise a stream that dies immediately still collects
     * its reset before the first retry, which IS reset-on-attempt wearing a timer.
     */
    expect(STREAM_STABLE_MS, 'zero would restore reset-on-attempt').toBeGreaterThan(0)
    expect(
      STREAM_STABLE_MS,
      'and it must outlast the first retry, or a dead stream still earns a reset',
    ).toBeGreaterThan(BACKOFF_MIN_MS)
  })

  it('a stability timer never outlives the stream that armed it', async () => {
    // Otherwise a long-dead connection resets the backoff of whatever replaced it.
    const { stream, sources, t } = build()
    stream.start(); await settle()
    sources.latest()?.onopen?.()
    sources.latest()?.onerror?.()

    expect(
      t.delays().filter(d => d === STREAM_STABLE_MS),
      'the drop disarmed it',
    ).toHaveLength(0)
  })
})

describe('resync — visible, never silent', () => {
  it('refetches and says so', async () => {
    // Spec §15 requires the resyncing state be visible. The alternative is a screen confidently
    // showing stale files.
    const { stream, sources, states, refetches } = build()
    stream.start(); await settle()
    sources.latest()?.onopen?.()
    sources.latest()?.emit('resync', { reason: 'queue overflow' })

    expect(states).toContain('resyncing')
    expect(refetches(), 'the open refetch, plus the resync refetch').toBe(2)
    expect(stream.state(), 'and back to live afterwards').toBe('live')
  })

  it('does not deliver resync as an ordinary event', async () => {
    const { stream, sources, events } = build()
    stream.start(); await settle()
    sources.latest()?.onopen?.()
    sources.latest()?.emit('resync', {})
    expect(events, 'resync is a control signal, not data').toEqual([])
  })

  /**
   * A FAILING RESYNC IS THE WORST MOMENT TO GO QUIET.
   *
   * `onopen`'s refetch is wrapped, with a comment explaining exactly why. The structurally identical
   * call in the resync branch was not — an adversarial review found the asymmetry and drove it: the
   * throw escapes into the `EventSource` listener where nothing catches it, `setState('live')` after
   * it never runs, and the state stays `'resyncing'` on a perfectly healthy stream. Forever, because
   * only a reconnect clears it.
   *
   * And the resync refetch is the *only* thing that repairs a dropped backlog. If it fails and
   * nothing retries, the screen shows stale files with no path back.
   */
  it('a resync refetch that throws does not wedge the state, and is retried', async () => {
    const t = timers()
    const sources = fakeSources()
    const states: StreamState[] = []
    let failRefetch = false

    const stream = createLiveStream({
      open: sources.open,
      url: async () => '/events?ticket=t',
      onEvent: () => { /* unused */ },
      onRefetch: () => { if (failRefetch) throw new Error('the refetch failed') },
      onStateChange: s => { states.push(s) },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()
    sources.made[0]?.onopen?.()
    expect(stream.state()).toBe('live')

    failRefetch = true
    expect(
      () => { sources.made[0]?.emit('resync', {}) },
      'the throw must not escape into the EventSource listener',
    ).not.toThrow()

    expect(stream.state(), 'not stranded on "resyncing" over a healthy stream').not.toBe('resyncing')
    expect(t.delays(), 'and the stale backlog gets another attempt').toEqual([BACKOFF_MIN_MS])

    // The retry reconnects, and the reconnect's own refetch is what repairs the backlog.
    failRefetch = false
    t.fire(BACKOFF_MIN_MS)
    await settle()
    sources.made[1]?.onopen?.()
    expect(stream.state(), 'recovered without any help from the user').toBe('live')
  })

  it('a throwing onStateChange does not swallow the recovery it is reporting', async () => {
    // The nastiest of the three, because `connect()` calls setState: unguarded, the throw escapes
    // `connect` → `onVisible` → into the visibilitychange handler, after teardown closed the stream
    // and before attach ran. And the coalescer has already stamped, so the paired focus event is
    // suppressed — that return recovers nothing at all.
    const t = timers()
    const sources = fakeSources()
    let broken = false

    const stream = createLiveStream({
      open: sources.open,
      url: async () => '/events?ticket=t',
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      onStateChange: () => { if (broken) throw new Error('the status line is broken') },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()
    sources.made[0]?.onopen?.()
    expect(stream.state()).toBe('live')

    broken = true
    expect(() => { stream.onVisible() }, 'must not escape into the event handler').not.toThrow()
    await settle()

    expect(sources.made, 'the return actually reconnected').toHaveLength(2)
  })

  it('an event handler that throws does not kill delivery of the next event', async () => {
    // One malformed payload must not take the stream down. `onEvent` is caller code and P7 fills it
    // with screen rendering, which is exactly the code most likely to throw on unexpected data.
    const t = timers()
    const sources = fakeSources()
    const seen: string[] = []

    const stream = createLiveStream({
      open: sources.open,
      url: async () => '/events?ticket=t',
      onEvent: event => {
        seen.push(String(event.type))
        if (seen.length === 1) throw new Error('the first handler is broken')
      },
      onRefetch: () => { /* unused */ },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()
    sources.made[0]?.onopen?.()

    expect(() => { sources.made[0]?.emit('changed', {}) }).not.toThrow()
    sources.made[0]?.emit('changed', {})

    expect(seen, 'the second event still arrived').toHaveLength(2)
    expect(stream.state(), 'and the stream is still live').toBe('live')
  })
})

describe('stopping', () => {
  it('closes the stream and cancels any retry', async () => {
    const { stream, sources, t } = build()
    stream.start(); await settle()
    sources.latest()?.onerror?.()
    stream.stop()
    expect(sources.latest()?.closed).toBe(true)
    expect(t.count()).toBe(0)
    expect(stream.state()).toBe('idle')
  })

  it('a handler firing after stop cannot resurrect the stream', async () => {
    // Detaching before closing is why: a late error would otherwise schedule a reconnect for a
    // stream we deliberately discarded.
    const { stream, sources, t } = build()
    stream.start(); await settle()
    const source = sources.latest()
    stream.stop()
    source?.onerror?.()
    expect(t.count(), 'no retry may be scheduled after stop').toBe(0)
    expect(sources.made).toHaveLength(1)
  })
})

describe('the async connect cannot install a superseded stream', () => {
  /**
   * Obtaining the URL became asynchronous because the security review's C6 requires a **fresh ticket on every
   * connect the client initiates**. That opened a window that did not exist before: between "start
   * connecting" and "here is the URL", the world can change — the user returns to the app
   * (`onVisible` tears down and reconnects), `stop()` is called, or a backoff retry fires.
   *
   * Without a generation counter, a URL that resolves after any of those installs a **second**
   * `EventSource`. Two live streams is worse than none, because both deliver and neither is
   * authoritative — the exact hazard `teardown` was written to prevent, reintroduced by making the
   * happy path async.
   */
  function deferred() {
    let release: (url: string) => void = () => { /* replaced below */ }
    const promise = new Promise<string>(resolve => { release = resolve })
    return { promise, release }
  }

  /**
   * Verified by mutation: deleting `generation += 1` from `teardown` turns the **visibility** test
   * below red and leaves this one green. That is not a gap — this case is caught by the separate
   * `wanted` check, since `stop()` sets it false — but the two tests prove different guards, and a
   * reader who assumed both covered the counter would delete the wrong one.
   */
  it('discards a URL that resolves after stop()', async () => {
    const t = timers()
    const sources = fakeSources()
    const gate = deferred()

    const stream = createLiveStream({
      open: sources.open,
      url: () => gate.promise,
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    stream.stop()
    gate.release('/events?ticket=late')
    await settle()

    expect(sources.made, 'a stream we stopped must not open afterwards').toHaveLength(0)
    expect(stream.state()).toBe('idle')
  })

  it('discards a URL that resolves after a visibility reopen superseded it', async () => {
    const t = timers()
    const sources = fakeSources()
    const gates = [deferred(), deferred()]
    let issued = 0

    const stream = createLiveStream({
      open: sources.open,
      url: () => gates[issued++]?.promise ?? Promise.resolve('/events'),
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()          // first connect, URL still pending
    stream.onVisible()      // supersedes it and starts a second
    gates[1]?.release('/events?ticket=second')
    await settle()
    gates[0]?.release('/events?ticket=first')   // the stale one arrives late
    await settle()

    expect(sources.made, 'only the surviving attempt may open a stream').toHaveLength(1)
    expect(sources.latest()?.url).toBe('/events?ticket=second')
  })

  it('backs off when the ticket cannot be obtained, rather than failing silently', async () => {
    // A failed session fetch is indistinguishable from a failed connect, and is treated the same.
    // Letting it reject would send the rejection nowhere — `connect` is called from a
    // visibilitychange handler, where a throw is invisible.
    const t = timers()
    const sources = fakeSources()

    const stream = createLiveStream({
      open: sources.open,
      url: async () => { throw new Error('no session') },
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()

    expect(sources.made).toHaveLength(0)
    expect(stream.state(), 'visibly reconnecting, not silently dead').toBe('reconnecting')
    expect(t.delays()).toEqual([BACKOFF_MIN_MS])
  })
})

/**
 * A URL SUPPLIER THAT NEVER ANSWERS — and why the rejection tests above do not cover it.
 *
 * Every other test here feeds a supplier that *rejects*, and `attach` handles that: it schedules a
 * retry. Nothing exercised a supplier that neither resolves nor rejects — which is precisely what
 * `fetch` does when a request is dropped rather than refused. There is no default timeout in the
 * platform; a promise that never settles is awaited forever.
 *
 * The shape it produces is the one §15 names and this module exists to prevent — *"the stream is
 * silently finished, the app looks connected, and no update ever arrives again"* — reached through
 * the recovery path itself. An adversarial review drove the real client into it: zero
 * `EventSource`, zero pending retries, status line reading **Live**.
 *
 * It was masked, not absent. Both visibility events firing meant a return made two independent
 * attempts, and the second covered a first that hung. Coalescing them for ticket cost removed the
 * mask without fixing what it masked, which is why a rework round gets attacked like any other.
 */
describe('a URL supplier that never settles', () => {
  it('gives up at the deadline and schedules a retry, rather than waiting forever', async () => {
    const t = timers()
    const sources = fakeSources()

    const stream = createLiveStream({
      open: sources.open,
      // Neither resolves nor rejects. A dropped request, not a refused one.
      url: () => new Promise<string>(() => { /* never */ }),
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()

    expect(t.delays(), 'a deadline is armed while awaiting the URL').toContain(URL_DEADLINE_MS)
    expect(sources.made, 'nothing opened yet').toHaveLength(0)

    t.fire(URL_DEADLINE_MS)
    await settle()

    expect(stream.state(), 'never "live" while there is no stream').toBe('reconnecting')
    expect(t.delays(), 'and a retry is actually pending').toEqual([BACKOFF_MIN_MS])
  })

  it('THE FAILURE ITSELF: a hang after a healthy stream never leaves the UI saying "live"', async () => {
    const t = timers()
    const sources = fakeSources()
    const seen: StreamState[] = []
    let hang = false

    const stream = createLiveStream({
      open: sources.open,
      url: async () => {
        if (hang) await new Promise<never>(() => { /* never */ })
        return '/events?ticket=good'
      },
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      onStateChange: s => { seen.push(s) },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()
    sources.made[0]?.onopen?.()
    expect(stream.state()).toBe('live')

    // Returning to the app tears the stream down and asks for a fresh ticket — and that request is
    // never answered. This is the whole defect in three lines.
    hang = true
    stream.onVisible()
    await settle()

    expect(sources.made[0]?.closed, 'the old stream is gone').toBe(true)
    expect(stream.state(), 'so the UI must not still be claiming "live"').not.toBe('live')

    t.fire(URL_DEADLINE_MS)
    await settle()

    expect(stream.state()).toBe('reconnecting')
    expect(t.delays(), 'a retry is pending, so this recovers unaided').toEqual([BACKOFF_MIN_MS])
    expect(seen, 'and the transition was visible').toContain('reconnecting')
  })

  /**
   * THE CONNECT-ENTRY STATE, PINNED ON ITS OWN — including the condition on it.
   *
   * A review found this covered only as one assertion inside the multi-purpose hang test, and its
   * *guard* not covered at all: making the `setState` unconditional left the whole suite green,
   * while the source states the property explicitly. Condition worded, property not delivered — in
   * a line written two rounds ago to fix exactly that.
   */
  it('a first connect stays quiet, so the shell’s own "Connecting…" is not overwritten', async () => {
    const t = timers()
    const sources = fakeSources()
    const states: StreamState[] = []

    const stream = createLiveStream({
      open: sources.open,
      url: () => new Promise<string>(() => { /* never — the first connect is still in flight */ }),
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      onStateChange: s => { states.push(s) },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()

    expect(states, 'nothing has ever connected, so there is nothing to be RE-connecting to')
      .toEqual([])
  })

  it('a reconnect from a live stream says so before it says anything else', async () => {
    const t = timers()
    const sources = fakeSources()
    const states: StreamState[] = []
    let hang = false

    const stream = createLiveStream({
      open: sources.open,
      url: async () => {
        if (hang) await new Promise<never>(() => { /* never */ })
        return '/events?ticket=t'
      },
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      onStateChange: s => { states.push(s) },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()
    sources.made[0]?.onopen?.()
    expect(states).toEqual(['live'])

    hang = true
    stream.onVisible()

    expect(states, 'the stream is closed, so "live" stops being true immediately')
      .toEqual(['live', 'reconnecting'])
  })

  it('a URL that arrives before the deadline disarms it, leaving only the stream', async () => {
    const t = timers()
    const sources = fakeSources()
    let release: (url: string) => void = () => { /* replaced on the first call */ }

    const stream = createLiveStream({
      open: sources.open,
      url: () => new Promise<string>(resolve => { release = resolve }),
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()
    release('/events?ticket=good')
    await settle()

    expect(sources.made).toHaveLength(1)
    expect(t.delays(), 'the deadline was cleared, not left to fire later').toEqual([])
  })

  it('a deadline firing after its attempt was superseded schedules nothing', async () => {
    const t = timers()
    const sources = fakeSources()

    const stream = createLiveStream({
      open: sources.open,
      url: () => new Promise<string>(() => { /* never */ }),
      onEvent: () => { /* unused */ },
      onRefetch: () => { /* unused */ },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    stream.start()
    await settle()
    // Superseded: a second return tears the first attempt down and starts its own.
    stream.onVisible()
    await settle()

    t.fire(URL_DEADLINE_MS)
    await settle()

    expect(
      t.delays().filter(d => d === BACKOFF_MIN_MS),
      'one retry, not one per abandoned attempt',
    ).toHaveLength(1)
  })
})
