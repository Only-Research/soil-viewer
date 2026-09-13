import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { RATE_LIMIT_GLOBAL_BURST, RATE_LIMIT_GLOBAL_PER_SECOND } from '../../src/server/limits'
import {
  MAX_LIVE_TICKETS, TICKET_IDLE_MS, createSessionStore, type VerifiedTicket,
} from '../../src/server/session'

/**
 * The session store — the security review's B4, B5, C5 and K6.
 *
 * **This file did not exist**, and a fresh-eyes review found that out: the store had no unit coverage
 * at all, so B4's and B5's stated proof clauses had nothing behind them and the K6 brick was only
 * caught by an integration test that skips wherever a socket cannot bind. Every control here is now
 * exercised directly, in-process, with an injected clock and an injected minter.
 */

const TOKEN = 'a'.repeat(32)

/** A deterministic minter, so collisions and malformed values are reachable rather than theoretical. */
function minter(values: string[]) {
  let i = 0
  return () => values[i++] ?? `${String(i).padStart(32, '0')}`
}

const store = (overrides: Parameters<typeof createSessionStore>[0] = { token: TOKEN }) =>
  createSessionStore(overrides)

describe('B4 — nothing malformed is ever emitted', () => {
  /**
   * `checkToken` is the only place that validates the *configured* token's shape, and the session
   * route is the one route that omits `checkToken`. Without this check, the route that **distributes**
   * the token is the only one with no assertion that what it distributes is well-formed.
   *
   * It fails closed, which is worse in a different way than a bypass: a malformed token is handed
   * out, every later call is refused 403, the client refetches, receives the same malformed token,
   * and loops — on a phone whose installed web app is resumed and never relaunched.
   */
  it('refuses to issue when the configured token is malformed', () => {
    for (const bad of ['', 'not-hex', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), ' '.repeat(32)]) {
      const result = store({ token: bad }).start()
      expect(result.ok, `token ${JSON.stringify(bad.slice(0, 8))} must not be issued`).toBe(false)
    }
  })

  it('refuses to issue a malformed TICKET, even with a good token', () => {
    const result = store({ token: TOKEN, mint: () => 'nope' }).start()
    expect(result.ok).toBe(false)
  })

  it('puts NEITHER credential in the refusal reason', () => {
    // `local-log.ts` emits an Error's message and stack verbatim, and §7 token property 4 is a MUST.
    const badToken = 'z'.repeat(32)
    const result = store({ token: badToken, mint: () => TOKEN }).start()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).not.toContain(badToken)
      expect(result.reason).not.toContain(TOKEN)
    }
  })

  it('refuses a ticket collision rather than giving two clients one identity', () => {
    // The stream cap is keyed on the ticket, so a collision would let one client consume another's
    // allowance. Astronomically unlikely with 16 CSPRNG bytes — refused rather than reasoned about.
    const s = store({ token: TOKEN, mint: minter(['b'.repeat(32), 'b'.repeat(32)]) })
    expect(s.start().ok).toBe(true)
    expect(s.start().ok, 'the same ticket must not be issued twice').toBe(false)
  })
})

describe('B5 — the pool refuses rather than evicting', () => {
  it('refuses a new session at the bound, and does NOT disturb the ones already issued', () => {
    /**
     * B5's stated proof clause, which was missing: *"N+1 calls followed by **the first client's
     * ticket still opening a stream**."* The direction is the whole condition — evicting would let a
     * flood choose whose stream dies, which is strictly worse than refusing a new tab.
     */
    const clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })

    const first = s.start()
    expect(first.ok).toBe(true)
    const firstTicket = first.ok ? first.session.streamTicket : ''

    for (let i = 1; i < MAX_LIVE_TICKETS; i++) expect(s.start().ok, `session ${i + 1}`).toBe(true)

    expect(s.start().ok, 'the bound is refused').toBe(false)
    expect(s.liveTickets()).toBe(MAX_LIVE_TICKETS)

    expect(
      s.verifyTicket(firstTicket),
      'the FIRST client\'s ticket must still be valid — exhaustion refuses, it never evicts',
    ).not.toBeNull()
  })
})

describe('K6 — the pool is reclaimable, and never at the cost of a live stream', () => {
  it('reclaims idle tickets once the window passes', () => {
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })
    for (let i = 0; i < MAX_LIVE_TICKETS; i++) s.start()

    expect(s.start().ok, 'full, and nothing is idle yet').toBe(false)
    clock += TICKET_IDLE_MS + 1
    expect(s.start().ok, 'a bound that only fills is a brick that arrives with use').toBe(true)
  })

  it('NEVER reclaims a ticket holding an open stream, however old', () => {
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })

    const held = s.start()
    if (!held.ok) throw new Error('start failed')
    const ticket = s.verifyTicket(held.session.streamTicket)
    if (ticket === null) throw new Error('verify failed')
    s.hold(ticket)

    // Fill the rest, then age everything far past the window and force a sweep.
    for (let i = 1; i < MAX_LIVE_TICKETS; i++) s.start()
    clock += TICKET_IDLE_MS * 100
    s.start()

    expect(
      s.verifyTicket(held.session.streamTicket),
      'an installed web app can hold a stream for days; expiring it underneath a live connection ' +
      'is the eviction B5 refused, arriving through the mechanism added to satisfy K6',
    ).not.toBeNull()
  })

  it('releases a held ticket back into the pool when its stream ends', () => {
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })
    const started = s.start()
    if (!started.ok) throw new Error('start failed')
    const ticket = s.verifyTicket(started.session.streamTicket)
    if (ticket === null) throw new Error('verify failed')

    s.hold(ticket)
    clock += TICKET_IDLE_MS * 2
    s.start()
    expect(s.verifyTicket(started.session.streamTicket), 'still held').not.toBeNull()

    s.release(ticket)
    clock += TICKET_IDLE_MS * 2
    s.start()
    expect(s.verifyTicket(started.session.streamTicket), 'released, then idle, then reclaimed').toBeNull()
  })

  it('a release beyond the holds does not drive the count below zero', () => {
    // The clamp is a floor, not the correctness mechanism — the once-per-stream guard lives at the
    // listener's binding site, because only that knows the identity of an individual stream.
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })
    const started = s.start()
    if (!started.ok) throw new Error('start failed')
    const ticket = s.verifyTicket(started.session.streamTicket)
    if (ticket === null) throw new Error('verify failed')

    s.hold(ticket)
    s.release(ticket)
    s.release(ticket)
    s.release(ticket)

    clock += TICKET_IDLE_MS * 2
    s.start()
    expect(s.verifyTicket(started.session.streamTicket), 'reclaimable, not corrupted').toBeNull()
  })
})

describe('the pool survives ordinary use, now that a ticket costs one CONNECT', () => {
  /**
   * **The proof clause that was missing, and its absence cost a critical defect.**
   *
   * C6 made `streamUrl()` mint a ticket on every client-initiated connect — `start`, every
   * `onVisible`, every backoff retry. Nothing measured what that spends. An adversarial review
   * measured it on a virtual clock: a user with a **perfectly healthy stream**, returning to the app
   * every nine seconds, exhausted a 64-ticket pool in **568 seconds**. Nothing was broken. The app
   * then answered 500 to every session request and sat on "Reconnecting…" until the pool drained.
   *
   * That is item 24's shape a second time — a bound that fills with use — and it arrived through the
   * mechanism added to fix a different defect.
   *
   * The fix is not the bigger number. It is that a ticket whose stream has **ended** is reclaimed
   * immediately instead of occupying a slot for a full idle window: the live count now tracks
   * *concurrent streams* rather than *cumulative connects*.
   */
  /**
   * **This test is written to isolate the reclaim, and the first version of it did not.**
   *
   * It originally stepped the clock nine seconds per return — the reviewer's measured scenario — and
   * passed with the `finished` reclaim mutated away. It was passing on the *sizing* change instead:
   * with a 60s window, nine-second returns leave only ~7 tickets live at a time, so nothing could
   * accumulate whether or not spent tickets were reclaimed. A green test proving the wrong control.
   *
   * The clock now advances **10ms** per cycle, so the whole run fits inside one idle window. Without
   * the immediate reclaim every spent ticket stays live and the pool exhausts; with it, the live
   * count tracks concurrent streams. That is the discriminator, and mutating `finished` turns this
   * red.
   *
   * The scenario is real, not contrived: a flapping connection or a burst of visibility events
   * produces exactly this — many connects inside one window.
   */
  it('spent tickets are reclaimed at once, so rapid reconnects cannot fill the pool', () => {
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })

    for (let i = 0; i < MAX_LIVE_TICKETS * 2; i++) {
      const started = s.start()
      expect(started.ok, `connect ${i + 1}: the pool must not fill with spent tickets`).toBe(true)
      if (!started.ok) break

      // What a reconnect does: open a stream, then tear it down when the next one supersedes it.
      const ticket = s.verifyTicket(started.session.streamTicket)
      if (ticket === null) throw new Error('verify failed')
      s.hold(ticket)
      clock += 10
      s.release(ticket)
    }

    expect(
      s.liveTickets(),
      'a spent ticket occupies no slot — the live count tracks concurrent streams, not connects',
    ).toBeLessThan(MAX_LIVE_TICKETS)
  })

  it('and the same run under ORDINARY pacing is nowhere near the bound', () => {
    // The reviewer's measured case: a healthy stream, the user returning every nine seconds. This is
    // the scenario that died at 568 seconds against the old pool and window.
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })

    for (let i = 0; i < 400; i++) {
      const started = s.start()
      expect(started.ok, `return ${i + 1}`).toBe(true)
      if (!started.ok) break
      const ticket = s.verifyTicket(started.session.streamTicket)
      if (ticket === null) throw new Error('verify failed')
      s.hold(ticket)
      clock += 9_000
      s.release(ticket)
    }

    expect(s.liveTickets()).toBeLessThan(10)
  })

  it('a ticket that never connected still gets its grace, so the mint→connect gap is safe', () => {
    // The window's only job. A phone on a slow link may take a moment between fetching a session and
    // the EventSource actually opening; reclaiming inside that gap would refuse its own client.
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })
    const started = s.start()
    if (!started.ok) throw new Error('start failed')

    clock += TICKET_IDLE_MS - 1
    s.start()
    expect(
      s.verifyTicket(started.session.streamTicket),
      'a freshly minted ticket must survive long enough to be used',
    ).not.toBeNull()
  })
})

describe('C5 — ticket verification', () => {
  it('refuses anything failing the shape before comparing', () => {
    const s = store()
    s.start()
    for (const bad of ['', 'x', 'A'.repeat(32), 'a'.repeat(31), '../../etc/passwd', ' '.repeat(32)]) {
      expect(s.verifyTicket(bad), `${JSON.stringify(bad.slice(0, 10))} must not verify`).toBeNull()
    }
  })

  it('refuses a well-formed ticket that was never issued', () => {
    const s = store()
    s.start()
    expect(s.verifyTicket('c'.repeat(32))).toBeNull()
  })

  it('returns the ticket branded, so a caller cannot pass an unverified one onward', () => {
    const s = store({ token: TOKEN, mint: minter(['d'.repeat(32)]) })
    s.start()
    const verified: VerifiedTicket | null = s.verifyTicket('d'.repeat(32))
    expect(verified).toBe('d'.repeat(32))
  })

  it('verifying refreshes the idle clock, so an active client is not reclaimed', () => {
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })
    const started = s.start()
    if (!started.ok) throw new Error('start failed')

    // Just under the window, then verify — which should reset it.
    clock += TICKET_IDLE_MS - 1
    expect(s.verifyTicket(started.session.streamTicket)).not.toBeNull()

    // Another almost-window. Without the refresh this would be past the cutoff.
    clock += TICKET_IDLE_MS - 1
    s.start()
    expect(s.verifyTicket(started.session.streamTicket), 'recent use must keep it alive').not.toBeNull()
  })
})

/**
 * THE TWO CONSTANTS, PINNED BY BEHAVIOUR RATHER THAN BY VALUE.
 *
 * A third adversarial round reverted `MAX_LIVE_TICKETS` to 64 and `TICKET_IDLE_MS` to ten minutes —
 * their exact pre-fix values, the pair that produced a brick and then an exhaustion — and the whole
 * suite stayed green. Every test imported the constants and scaled off them (`TICKET_IDLE_MS + 1`,
 * `MAX_LIVE_TICKETS * 2`), so no value could ever fail one. Two of the three axes of that fix were
 * undefended.
 *
 * These use **literal** durations and counts on purpose. They describe what a person does, not what
 * the code is currently set to, so changing a constant to a value that cannot support ordinary use
 * turns them red. That is the difference between a test and a restatement.
 */
/**
 * TWO TICKET-VERIFICATION CONTROLS THAT NOTHING DEFENDED.
 *
 * Both mutations left the whole suite green: replacing the constant-time loop with
 * `tickets.has(presented)`, and deleting the shape check that runs before it.
 */
describe('verifyTicket — the shape check and the constant-time loop', () => {
  it('refuses malformed tickets, and the shape check is UNREACHABLE by construction', () => {
    /**
     * **HONEST RESULT: the shape check cannot be provoked, and deleting it stays green.** Recorded
     * rather than papered over with a test that passes for a different reason.
     *
     * The check exists to reject a malformed *presented* value before any work is done. But the only
     * way it could change an outcome is if a malformed value could MATCH a stored ticket — and B4
     * refuses to mint a malformed ticket at all, so no such stored value can exist. Without the
     * shape check, garbage still reaches the loop, still matches nothing, and still returns null.
     * Identical behaviour, so no behavioural assertion can separate them.
     *
     * It stays because it is a cheap early-out that keeps an unbounded input from being copied into
     * a Buffer, and because B4 being the only thing standing between here and a malformed ticket is
     * exactly the single-point-of-failure this build refuses elsewhere. It is pinned structurally
     * below, with the constant-time loop.
     *
     * What this test DOES prove is the outcome: malformed values are refused.
     */
    const good = store({ token: TOKEN })
    const started = good.start()
    if (!started.ok) throw new Error('start failed')

    for (const bad of ['', 'zz', 'not-a-valid-hex-ticket', `${started.session.streamTicket}X`]) {
      expect(good.verifyTicket(bad), `${JSON.stringify(bad.slice(0, 8))} must be refused`).toBeNull()
    }
    expect(good.verifyTicket(started.session.streamTicket), 'and the real one still works').not.toBeNull()
  })

  it('keeps the constant-time comparison — pinned structurally, like §7 property 2', async () => {
    /**
     * Swapping the loop for `tickets.has(presented)` returns the identical boolean for every input,
     * so no behavioural test can separate them. The difference is *when* the answer arrives: a Map
     * lookup short-circuits on the first differing byte and leaks the ticket a character at a time.
     *
     * Same honesty as the §4 and §7 structural pins: this proves the control is PRESENT, not that
     * it FIRES.
     */
    const source = await readFile(new URL('../../src/server/session.ts', import.meta.url), 'utf8')

    expect(source, 'every live ticket is compared, in constant time')
      .toContain('timingSafeEqual(ticketBytes, presentedBytes)')
    expect(source, 'and a malformed value is rejected on its shape before any of that')
      .toContain('if (!CREDENTIAL_SHAPE.test(presented)) return null')
    // NO negative assertion here. `tickets.has(...)` is used legitimately in `start()` for
    // collision detection, and the comment above `verifyTicket` names the banned pattern to explain
    // it — so any "must not contain" phrasing trips on one or the other. That is the FIFTH
    // assertion this week to match a comment instead of code. The positive assertion is sufficient:
    // replacing the loop with a Map lookup removes the call it looks for.
  })
})

describe('the sizing, stated as use rather than as numbers', () => {
  it('two thousand connect-and-disconnect cycles never fill the pool', () => {
    // THE K6 BRICK AND THE EXHAUSTION AFTER IT, described the way both were experienced: the app
    // worked all morning and then stopped, and nothing was broken. Both were a count that only ever
    // went up. A device left open for days does this thousands of times.
    //
    // My first attempt at this test used a hundred loads that never opened a stream — and it stayed
    // green with the pool reverted to 64, because the idle window alone was enough to drain them. It
    // proved nothing and read as though it did. The cycle below is the shape that actually degrades:
    // a ticket that gets used.
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })

    for (let i = 0; i < 2_000; i++) {
      clock += 9_000 // a return to the app every nine seconds
      const started = s.start()
      expect(started.ok, `connect ${i + 1} must get a session`).toBe(true)
      if (!started.ok) throw new Error('start failed')
      const ticket = s.verifyTicket(started.session.streamTicket)
      s.hold(ticket as VerifiedTicket)
      s.release(ticket as VerifiedTicket)
    }

    expect(s.liveTickets(), 'spent tickets went back, rather than accumulating').toBeLessThan(5)
  })

  it('sustained minting at the rate the limiter permits is never refused', () => {
    /**
     * THE RELATIONSHIP, not either number.
     *
     * The pool and the rate limiter were sized independently, and a third adversarial round did the
     * arithmetic: the pool drained about 17 mints a second while the limiter permitted 50. Three
     * times over. Everything in front of this route would happily deliver more than it could hold,
     * and `session.start` would answer 500 for every device until the flood stopped — reachable by a
     * client stuck in a retry loop, with no attacker involved.
     *
     * Driven at exactly the permitted rate, for a full idle window, with nothing ever connecting —
     * the worst case, because a ticket that is never used is the only kind that occupies a slot for
     * the whole window. If the bound stops being derived from the limiter, this goes red.
     */
    /**
     * **DRIVEN INCLUDING THE BURST, because without it this test was a partial re-derivation.**
     * It asserted `PER_SECOND × window` against a bound of `PER_SECOND × window + BURST + 256`, so
     * it re-used the source's own arithmetic and could never fail while the derivation held —
     * dropping the entire `+ BURST + 256` margin left it green, which means the burst allowance, the
     * whole reason the margin exists, was unpinned. A review caught it.
     *
     * The limiter's real worst case is the full burst at once and then the sustained rate for the
     * window. That is what the pool has to absorb, and it is what is driven here.
     */
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })
    const perSecond = RATE_LIMIT_GLOBAL_PER_SECOND
    const window = TICKET_IDLE_MS / 1_000
    const worstCase = RATE_LIMIT_GLOBAL_BURST + perSecond * window

    let peak = 0
    // The burst first, as fast as the limiter will release it.
    for (let i = 0; i < RATE_LIMIT_GLOBAL_BURST; i++) {
      clock += 1
      expect(s.start().ok, `burst mint ${i + 1} of ${RATE_LIMIT_GLOBAL_BURST}`).toBe(true)
      peak = Math.max(peak, s.liveTickets())
    }
    // Then the sustained rate, for the whole window, with none of it ever connecting — the only
    // shape that occupies a slot for the full window, because nothing ever finishes.
    for (let i = 0; i < perSecond * window; i++) {
      clock += 1_000 / perSecond
      expect(
        s.start().ok,
        `sustained mint ${i + 1} — the pool must absorb what the limiter allows`,
      ).toBe(true)
      peak = Math.max(peak, s.liveTickets())
    }

    // The assertion that makes the margin load-bearing rather than decorative: the run genuinely
    // goes past what a bound without the burst allowance would permit, so dropping it fails above.
    expect(peak, 'the drive really did exceed a marginless bound').toBeGreaterThan(perSecond * window)
    expect(peak, 'and stayed inside the real one').toBeLessThanOrEqual(worstCase)
  })

  it('tickets nobody ever uses are gone a minute later, so a burst cannot hold the pool', () => {
    // The other half. Minted-and-abandoned tickets are the only ones that occupy a slot for the full
    // window, so the window has to be short enough that a burst drains before the next one arrives.
    // At ten minutes this fails: the first burst is still resident when the second lands.
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })

    for (let burst = 0; burst < 5; burst++) {
      for (let i = 0; i < 300; i++) {
        clock += 1
        expect(s.start().ok, `burst ${burst}, mint ${i}`).toBe(true)
      }
      clock += 61_000 // a minute of quiet between bursts
    }

    expect(s.liveTickets(), 'the earlier bursts drained rather than accumulating').toBeLessThan(310)
  })
})

/**
 * WHAT THE ACCOUNTING PROTECTS, AND HOW REACHABLE EACH PATH ACTUALLY IS.
 *
 * Both controls below were recorded as covered and neither was. Deleting the clamp left all 911
 * tests green; so did deleting the listener's once-guard. What follows pins the invariant they
 * exist for — *a ticket holding an open stream is never reclaimed* — rather than their mechanics.
 *
 * **On the once-guard, a correction worth more than the test.** It was added because a broken
 * connection was said to fire both `close` and `error` on the response. Measured on Node 24 across
 * both disconnect shapes — RST and FIN, including writing continuously into a destroyed socket —
 * **only `close` ever fires.** So `res.on('error', …)` does not run on this path and the guard
 * cannot currently be provoked from outside. It stays, because it is free and a duplicate release
 * corrupts the count irrecoverably, but it is **insurance, not a live control**, and a black-box
 * test that claims to exercise it would be passing for the wrong reason. Recorded rather than faked.
 */
describe('a ticket holding an open stream is never reclaimed', () => {
  it('survives a sweep while a second stream on it has already ended', () => {
    // REACHABLE TODAY, and the third review measured it: four concurrent streams on one ticket over
    // real HTTP. `MAX_STREAMS_PER_CLIENT` is not dead by construction, and the multi-stream
    // accounting is not latent machinery — it runs.
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })
    const started = s.start()
    if (!started.ok) throw new Error('start failed')
    const ticket = s.verifyTicket(started.session.streamTicket)
    expect(ticket).not.toBeNull()

    s.hold(ticket as VerifiedTicket)
    s.hold(ticket as VerifiedTicket)
    s.release(ticket as VerifiedTicket) // one ends; one is still delivering

    clock += TICKET_IDLE_MS * 10
    s.start() // the sweep runs here

    expect(
      s.verifyTicket(started.session.streamTicket),
      'the surviving stream must not have its ticket deleted underneath it',
    ).not.toBeNull()
  })

  it('a release with no matching hold cannot drive the count below zero', () => {
    // THE CLAMP, pinned by consequence rather than by reading a counter there is no accessor for.
    // Unclamped, the count goes to -1; the next `hold` only brings it back to 0; and a sweep then
    // sees a ticket that reads "no open streams" while a stream is live, and deletes it. The clamp
    // was documented as "a floor, not a correctness mechanism" — the immediate reclaim made that
    // false, and nothing noticed.
    let clock = 1_000
    const s = store({ token: TOKEN, now: () => clock })
    const started = s.start()
    if (!started.ok) throw new Error('start failed')
    const ticket = s.verifyTicket(started.session.streamTicket)

    s.release(ticket as VerifiedTicket) // never held
    s.hold(ticket as VerifiedTicket) // now a real stream opens

    clock += TICKET_IDLE_MS * 10
    s.start()

    expect(
      s.verifyTicket(started.session.streamTicket),
      'a live stream must survive, whatever the release history',
    ).not.toBeNull()
  })
})
