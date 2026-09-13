import { describe, expect, it } from 'vitest'

import { createFunnelWatch, type FunnelStatus } from '../../src/server/funnel-watch'

/**
 * Spec §7's second Funnel mechanism. The rule under test is one sentence and every case below is a
 * way of breaking it:
 *
 * > *"If the check cannot be completed, enter a named 'funnel status unknown' state and refuse
 * > tailnet-listener traffic until it resolves… It MUST NOT be allowed to fail open."*
 *
 * One mistyped `tailscale funnel` puts the app on the public internet with zero authentication, so
 * "we could not tell, so we allowed it" is not a degraded outcome — it is the threat model
 * inverted.
 */

/** Lets every queued microtask run, so a promise chain settles before the next assertion. */
const flush = async (): Promise<void> => { await new Promise(resolve => { setImmediate(resolve) }) }

/** A controllable timer registry, so no test waits on a real clock. */
function timers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    setTimer: (fn: () => void, ms: number): unknown => { pending.set(next, { fn, ms }); return next++ },
    clearTimer: (handle: unknown): void => { pending.delete(handle as number) },
    /** Fires every timer registered for exactly `ms`, as a real clock reaching that delay would. */
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

const watchWith = (probe: () => Promise<boolean>, t = timers(), onChange?: (s: FunnelStatus, p: FunnelStatus) => void) =>
  createFunnelWatch({
    probe,
    intervalMs: 60_000,
    timeoutMs: 5_000,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    ...(onChange === undefined ? {} : { onChange }),
  })

describe('the initial state', () => {
  it('starts UNKNOWN, not off — the window before the first answer is when optimism is wrong', () => {
    const watch = watchWith(async () => false)
    expect(watch.status()).toBe('unknown')
    expect(watch.tailnetTrafficPermitted()).toBe(false)
  })
})

describe('what each probe outcome means', () => {
  it('a confirmed OFF permits tailnet traffic', async () => {
    const watch = watchWith(async () => false)
    expect(await watch.check()).toBe('off')
    expect(watch.tailnetTrafficPermitted()).toBe(true)
  })

  it('a confirmed ON refuses it', async () => {
    const watch = watchWith(async () => true)
    expect(await watch.check()).toBe('on')
    expect(watch.tailnetTrafficPermitted()).toBe(false)
  })

  it('a REJECTED probe is unknown, and refuses', async () => {
    const watch = watchWith(async () => { throw new Error('LocalAPI moved') })
    expect(await watch.check()).toBe('unknown')
    expect(watch.tailnetTrafficPermitted()).toBe(false)
  })

  it('a probe that never settles is unknown, not stuck', async () => {
    // The likeliest shape when the daemon is wedged. Without the timeout race, the watch would sit
    // on its last-known status forever — and stale in the fail-open direction if that was `off`.
    const t = timers()
    const watch = watchWith(() => new Promise<boolean>(() => { /* never settles */ }), t)
    const pending = watch.check()
    t.fire(5_000)
    expect(await pending).toBe('unknown')
    expect(watch.tailnetTrafficPermitted()).toBe(false)
  })
})

describe('IT MUST NOT FAIL OPEN — the case the whole mechanism exists for', () => {
  it('a healthy probe followed by a broken one REVOKES permission', async () => {
    // The exact scenario spec §7 describes: Tailscale upgrades, the endpoint changes shape, and a
    // check that had been passing starts failing. If the watch kept its last good answer, the
    // control would silently become a no-op on the day it matters.
    let healthy = true
    const watch = watchWith(async () => {
      if (!healthy) throw new Error('endpoint changed after upgrade')
      return false
    })

    expect(await watch.check()).toBe('off')
    expect(watch.tailnetTrafficPermitted(), 'permitted while confirmed off').toBe(true)

    healthy = false
    expect(await watch.check()).toBe('unknown')
    expect(watch.tailnetTrafficPermitted(), 'permission must be revoked, not retained').toBe(false)
  })

  it('recovers once the probe works again', async () => {
    // Fail-closed must not mean fail-forever, or the first transient blip takes the app down until
    // someone restarts it — which is how a fail-closed control gets removed.
    let healthy = false
    const watch = watchWith(async () => {
      if (!healthy) throw new Error('transient')
      return false
    })
    expect(await watch.check()).toBe('unknown')
    healthy = true
    expect(await watch.check()).toBe('off')
    expect(watch.tailnetTrafficPermitted()).toBe(true)
  })

  it('treats every failure identically, so none can be judged benign', async () => {
    // Distinguishing failure kinds invites treating some as harmless, which is the first step to
    // failing open for the "harmless" ones.
    for (const thrown of [new Error('ENOENT'), new TypeError('bad shape'), 'a string', undefined]) {
      const watch = watchWith(async () => { throw thrown })
      expect(await watch.check(), `${String(thrown)} must be unknown`).toBe('unknown')
    }
  })

  it('stopping the watch does not leave a stale permission behind', async () => {
    const watch = watchWith(async () => false)
    watch.start()
    await Promise.resolve()
    watch.stop()
    expect(watch.status(), 'a stopped watch knows nothing').toBe('unknown')
    expect(watch.tailnetTrafficPermitted()).toBe(false)
  })

  it('AND IT STILL KNOWS NOTHING A TICK LATER — an in-flight probe cannot re-grant', async () => {
    /**
     * **THE TEST ABOVE COULD NOT FAIL.** `await Promise.resolve()` yields exactly one microtask,
     * and `check()`'s `await Promise.race([...])` has not resumed by then — so its assertion saw
     * the `'unknown'` that `stop()` itself had just written, one line earlier. One more tick and the
     * property collapsed: the probe resolved `false`, `set('off')` ran, and
     * `tailnetTrafficPermitted()` returned **true on a stopped watch** — the exact opposite of what
     * `stop()` documents.
     *
     * Not theoretical. `bootstrap.ts` calls `stop()` and then awaits `close()` on both servers, and
     * `Server.close()` keeps serving in-flight and already-established keep-alive connections while
     * the listener consults this watch on every request.
     *
     * This one holds a probe open explicitly, stops the watch, then releases it — so the answer
     * lands *after* the stop, which is the only ordering that discriminates.
     */
    let release: (enabled: boolean) => void = () => { /* replaced on the first call */ }
    const watch = watchWith(() => new Promise<boolean>(resolve => { release = resolve }))

    void watch.check()
    await Promise.resolve() // let `check` reach its await, so a probe is genuinely in flight

    watch.stop()
    expect(watch.status(), 'stopped').toBe('unknown')

    release(false) // the probe finally answers "Funnel is off"
    await Promise.resolve()
    await Promise.resolve()

    expect(watch.status(), 'a late answer must not resurrect a stopped watch').toBe('unknown')
    expect(watch.tailnetTrafficPermitted(), 'and must not re-grant permission').toBe(false)
  })

  it('a normal check still records its answer — the gate must not deafen the watch', async () => {
    // The other half, so "ignore every answer" cannot pass the test above.
    const watch = watchWith(async () => false)
    expect(await watch.check()).toBe('off')
    expect(watch.tailnetTrafficPermitted()).toBe(true)
  })
})

describe('polling', () => {
  it('probes at startup and schedules the next check', async () => {
    let calls = 0
    const t = timers()
    const watch = watchWith(async () => { calls++; return false }, t)

    watch.start()
    await flush()
    expect(calls, 'startup probe').toBe(1)
    expect(t.count(), 'a follow-up check is scheduled').toBeGreaterThan(0)
    watch.stop()
  })

  it('re-probes when the interval elapses', async () => {
    let calls = 0
    const t = timers()
    const watch = watchWith(async () => { calls++; return false }, t)

    watch.start()
    await flush()
    const afterStart = calls

    t.fire(60_000)
    await flush()
    expect(calls, 'the 60s timer must trigger another probe').toBe(afterStart + 1)
    watch.stop()
  })

  it('stops scheduling once stopped', async () => {
    const t = timers()
    const watch = watchWith(async () => false, t)
    watch.start()
    await flush()
    watch.stop()
    expect(t.fire(60_000), 'no timer should remain after stop').toBe(0)
  })

  it('start is idempotent — a second call does not double the polling', async () => {
    let calls = 0
    const t = timers()
    const watch = watchWith(async () => { calls++; return false }, t)
    watch.start()
    watch.start()
    await flush()
    expect(calls).toBe(1)
    watch.stop()
  })
})

describe('change notification', () => {
  it('reports transitions, and only transitions', async () => {
    const seen: Array<[FunnelStatus, FunnelStatus]> = []
    let enabled = false
    const watch = watchWith(
      async () => enabled,
      timers(),
      (status, previous) => { seen.push([status, previous]) },
    )

    await watch.check()            // unknown -> off
    await watch.check()            // off -> off, no notification
    enabled = true
    await watch.check()            // off -> on

    expect(seen).toEqual([['off', 'unknown'], ['on', 'off']])
  })

  it('announces the drop into unknown, so it is visible rather than silent', async () => {
    // the operator needs to be able to tell "someone enabled Funnel" from "Tailscale changed its API".
    const seen: FunnelStatus[] = []
    let healthy = true
    const watch = watchWith(
      async () => { if (!healthy) throw new Error('changed'); return false },
      timers(),
      status => { seen.push(status) },
    )
    await watch.check()
    healthy = false
    await watch.check()
    expect(seen).toEqual(['off', 'unknown'])
  })
})
