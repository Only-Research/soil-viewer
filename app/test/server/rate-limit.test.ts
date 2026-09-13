import { describe, expect, it } from 'vitest'

import { createRateLimiter } from '../../src/server/rate-limit'
import {
  MAX_CONNECTIONS, RATE_LIMIT_GLOBAL_BURST, RATE_LIMIT_GLOBAL_PER_SECOND,
} from '../../src/server/limits'

/** A controlled clock. Every boundary below is exercised exactly, without sleeping. */
function clock(start = 0) {
  let ms = start
  return { now: () => ms, advance: (by: number) => { ms += by } }
}

const limiter = (c: ReturnType<typeof clock>) => createRateLimiter({
  ratePerSecond: RATE_LIMIT_GLOBAL_PER_SECOND,
  burst: RATE_LIMIT_GLOBAL_BURST,
  now: c.now,
})

describe('the token bucket', () => {
  it('allows the full burst immediately', () => {
    const c = clock()
    const rl = limiter(c)
    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) {
      expect(rl.take('a'), `request ${i + 1} of the burst`).toBe(true)
    }
  })

  it('refuses the request after the burst, with no time elapsed', () => {
    const c = clock()
    const rl = limiter(c)
    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) rl.take('a')
    expect(rl.take('a')).toBe(false)
  })

  it('refills at the configured rate, not all at once', () => {
    const c = clock()
    const rl = limiter(c)
    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) rl.take('a')
    expect(rl.take('a')).toBe(false)

    // Derived from the configured rate rather than hardcoded, so re-sizing the limiter does not
    // require editing the arithmetic here — which is how a test ends up asserting the old number.
    const msPerToken = 1_000 / RATE_LIMIT_GLOBAL_PER_SECOND
    c.advance(msPerToken - 1)
    expect(rl.take('a'), 'just under one token').toBe(false)
    c.advance(1)
    expect(rl.take('a'), 'exactly one token').toBe(true)
    expect(rl.take('a'), 'and only one').toBe(false)
  })

  it('does not refill beyond the burst however long it waits', () => {
    /**
     * **THIS TEST COULD NOT FAIL, AND IT IS THE ONE NAMED FOR THE PROPERTY.** It advanced the clock
     * *before any bucket existed*, so `take` constructed a fresh bucket at the current time with
     * exactly `burstMilli` in it — the ceiling was never involved. Removing
     * `Math.min(burstMilli, …)` from `refill` left it green, and a review measured what that costs:
     * **3,119 requests allowed where 120 is the bound. A 26× bypass.**
     *
     * The fix is one line: make a request FIRST, so a bucket exists and has a real `lastRefillMs`
     * for the idle to accumulate against. That is the only state in which the ceiling is reachable,
     * and the only state a real client is ever in.
     */
    const c = clock()
    const rl = limiter(c)

    // The bucket must EXIST before the idle, or nothing accrues and the cap is never consulted.
    expect(rl.take('a'), 'a first request, so a bucket exists').toBe(true)

    c.advance(60_000)

    // One already spent above, so the bucket may refill to the ceiling and no further.
    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) {
      expect(rl.take('a'), `refilled token ${i + 1} of ${RATE_LIMIT_GLOBAL_BURST}`).toBe(true)
    }
    expect(rl.take('a'), 'a minute of idling must not grant an unbounded burst').toBe(false)
  })

  it('an HOUR of idling grants no more than a minute of it', () => {
    // The scale the bypass showed up at: unclamped, elapsed time multiplies straight into tokens, so
    // the longer a client sits quiet the bigger its next burst. Two identical drives, different
    // idles, must allow the same number of requests.
    const drain = (idleMs: number): number => {
      const c = clock()
      const rl = limiter(c)
      rl.take('a')
      c.advance(idleMs)
      let allowed = 0
      while (rl.take('a')) allowed++
      return allowed
    }

    expect(drain(3_600_000), 'an hour of quiet is worth no more than a minute of it')
      .toBe(drain(60_000))
    expect(drain(3_600_000), 'and that is the burst, not something unbounded')
      .toBeLessThanOrEqual(RATE_LIMIT_GLOBAL_BURST)
  })

  it('keeps fractional tokens rather than flooring them', () => {
    // Flooring makes the bucket deliver slightly under its rate forever, and the drift is invisible
    // until someone measures it. Several small steps must add up to exactly one token.
    //
    // Derived from the configured rate rather than hardcoded: this test asserted "ten 5ms steps are
    // one 50ms token", which was true only while the rate was 20/s and quietly became an assertion
    // about the old number when it changed.
    const c = clock()
    const rl = limiter(c)
    const msPerToken = 1_000 / RATE_LIMIT_GLOBAL_PER_SECOND
    const steps = 10
    const step = msPerToken / steps

    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) rl.take('a')
    for (let i = 0; i < steps - 1; i++) {
      c.advance(step)
      expect(rl.take('a'), `after ${(i + 1) * step}ms`).toBe(false)
    }
    c.advance(step)
    expect(rl.take('a'), `${steps} steps of ${step}ms are one ${msPerToken}ms token`).toBe(true)
  })

  it('sustains exactly the configured rate over a second', () => {
    const c = clock()
    const rl = limiter(c)
    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) rl.take('a')

    let allowed = 0
    for (let ms = 0; ms < 1000; ms++) {
      c.advance(1)
      if (rl.take('a')) allowed++
    }
    expect(allowed).toBe(RATE_LIMIT_GLOBAL_PER_SECOND)
  })

  it('tracks keys independently', () => {
    const c = clock()
    const rl = limiter(c)
    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) rl.take('a')
    expect(rl.take('a')).toBe(false)
    expect(rl.take('b'), 'a different key has its own bucket').toBe(true)
  })

  it('never goes negative or lets a refused request consume a token', () => {
    const c = clock()
    const rl = limiter(c)
    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) rl.take('a')
    for (let i = 0; i < 100; i++) rl.take('a') // all refused

    // If refusals had drained the bucket below zero, this would need 100 extra tokens to recover.
    c.advance(50)
    expect(rl.take('a'), 'one token of elapsed time must grant exactly one request').toBe(true)
  })

  it('tolerates a clock that goes backwards without granting free tokens', () => {
    // A non-monotonic clock is a real possibility across a sleep/wake, and negative elapsed time
    // would otherwise subtract tokens or produce NaN.
    const c = clock(10_000)
    const rl = limiter(c)
    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) rl.take('a')
    c.advance(-5_000)
    expect(rl.take('a'), 'time going backwards must not grant a token').toBe(false)
    c.advance(5_050)
    expect(rl.take('a')).toBe(true)
  })
})

describe('eviction', () => {
  it('drops buckets that are idle AND fully refilled', () => {
    const c = clock()
    const rl = limiter(c)
    rl.take('a')
    expect(rl.size()).toBe(1)
    c.advance(60_000)
    expect(rl.evictIdle(30_000)).toBe(1)
    expect(rl.size()).toBe(0)
  })

  it('refuses to evict a bucket time has NOT yet refilled — eviction must never be a bypass', () => {
    // The subtle one: evicting a throttled key resets it, so eviction would become a way around
    // the limit. Droppable is defined as "time would already have refilled this", which makes
    // dropping and keeping indistinguishable.
    //
    // The idle threshold is short enough to qualify on age but too short to have refilled the
    // bucket. Both durations are derived from the configured limiter, because "200ms is only 4 of
    // the 20 tokens back" was arithmetic about a rate that has since changed.
    const c = clock()
    const rl = limiter(c)
    const msToRefill = (RATE_LIMIT_GLOBAL_BURST / RATE_LIMIT_GLOBAL_PER_SECOND) * 1_000

    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) rl.take('a')
    c.advance(msToRefill / 4)
    expect(rl.evictIdle(100), 'still depleted, so not droppable').toBe(0)
    expect(rl.size()).toBe(1)

    // And once time really has refilled it, dropping is safe and happens.
    c.advance(msToRefill)
    expect(rl.evictIdle(100)).toBe(1)
  })

  it('keeps a recently used bucket', () => {
    const c = clock()
    const rl = limiter(c)
    rl.take('a')
    c.advance(1_000)
    expect(rl.evictIdle(30_000)).toBe(0)
    expect(rl.size()).toBe(1)
  })
})

describe('the configured numbers match the spec', () => {
  it('is sized for real page loads, not for an API in isolation — security review K2', () => {
    /**
     * These were **20 and 20**, set before this server carried static assets or a session route.
     * A cold page load costs **six requests** (measured in WebKit: shell, manifest, module,
     * stylesheet, session, stream), so the old burst was three page loads — and it silently became
     * too small the moment the server started serving the client.
     *
     * It cost three debugging sessions wearing three disguises, none of which looked like a rate
     * limit: *"the background is transparent"*, *"the app did not mount"*, *"the deep link 404s"*.
     * **A refused asset is not a retried asset** — a stylesheet answered 429 is a broken page with
     * no recovery path, unlike an API call, which backs off.
     *
     * So the assertion is the property, not the number: the burst must cover several devices doing
     * a cold load at once. The user's tailnet is three devices plus a duplicate tab.
     */
    const REQUESTS_PER_COLD_LOAD = 6
    const CONCURRENT_DEVICES = 4

    expect(
      RATE_LIMIT_GLOBAL_BURST,
      'the burst must absorb every device cold-loading at once, twice over',
    ).toBeGreaterThanOrEqual(REQUESTS_PER_COLD_LOAD * CONCURRENT_DEVICES * 2)

    expect(
      RATE_LIMIT_GLOBAL_PER_SECOND,
      'and the sustained rate must clear more than one cold load per second',
    ).toBeGreaterThan(REQUESTS_PER_COLD_LOAD)
  })
})

/**
 * **THE SHIPPED NUMBERS, PINNED HERE BECAUSE THE BROWSER TESTS NO LONGER CAN.**
 *
 * the ruling of 2026-08-14 gave the e2e server its own rate limit — the suite sustains ~70
 * requests per second against a 50/s refill and drained the bucket during ordinary testing, which
 * surfaced as a page whose `session.start` was refused and therefore had no token for anything else.
 * `test/e2e/limits.ts` carries the measurement and states the cost.
 *
 * **This is that cost, answered.** With the browser running above the shipped size, nothing there
 * exercises the numbers a person installs. These assertions are the replacement: they are about the
 * *values*, not the mechanism, and they exist so the shipped configuration cannot drift while every
 * suite stays green.
 */
describe('the shipped rate limit', () => {
  it('is the size the derivation says, so a change has to change this line too', () => {
    expect(RATE_LIMIT_GLOBAL_BURST, 'the shipped burst moved').toBe(120)
    expect(RATE_LIMIT_GLOBAL_PER_SECOND, 'the shipped sustained rate moved').toBe(50)
  })

  it('has a burst below MAX_CONNECTIONS, or it is not a bound at all', () => {
    /**
     * **Learned by trying it.** Raised to 300 on 2026-08-14 and the limiter became unreachable: at
     * most `MAX_CONNECTIONS` requests can be in flight, so a burst above that can never be drained in
     * one wave, and the surplus waits for a connection while the bucket refills. **An unreachable
     * limit is indistinguishable from no limit**, and the only reason that is known is that a
     * control's own test refused to make it fire.
     */
    expect(RATE_LIMIT_GLOBAL_BURST).toBeLessThan(MAX_CONNECTIONS)
  })

  it('refills a drained bucket faster than a person can reload', () => {
    // The property that makes a refusal a brake rather than an outage: 120/50 = 2.4 seconds from
    // empty to full. A limit that took ten seconds to forgive would read as the app being broken.
    expect(RATE_LIMIT_GLOBAL_BURST / RATE_LIMIT_GLOBAL_PER_SECOND).toBeLessThanOrEqual(3)
  })
})

