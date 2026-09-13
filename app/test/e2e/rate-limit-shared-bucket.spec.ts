/**
 * The rate limiter, against the running server — the security review's K2.
 *
 * **The limiter is GLOBAL.** It is keyed on `socket.remoteAddress`, which behind `tailscale serve` is
 * `127.0.0.1` for every device. That is not a defect to be re-keyed: the limiter runs ahead of the
 * whole guard chain, deliberately, so a flood is throttled before it can generate `fsync`-per-refusal
 * log records. Nothing has been validated at that point, so there is no trustworthy identity to key
 * on — and spec §7 already refused the tempting one: *"Trusting `X-Forwarded-For` instead is also
 * wrong — anything reaching the loopback port forges it."*
 *
 * So it is global, and the honest response was to size it for what it actually covers. It was
 * **20/20**, set before this server carried assets or a session route, which is three cold page
 * loads. That cost three debugging sessions wearing three different disguises — *"the background is
 * transparent"*, *"the app did not mount"*, *"the deep link 404s"* — and this suite needed a pacing
 * fixture to pass at all.
 *
 * **The fixture is gone.** The suite runs unpaced now.
 *
 * *That last sentence used to continue* "which is the real proof the burst is adequate: thirty
 * browser tests across two engines with no artificial delay anywhere." **Struck 2026-08-13, because
 * one run measured it false.** The suite is 224 tests now, not thirty, and the first test below
 * failed on chromium with **1 refusal in 24** — then passed on an immediate re-run, same position in
 * the suite. The mechanism is this file's own subject: the bucket is global, so by the time this
 * spec runs, ninety-four browser tests have just spent it, and what remained was under twenty
 * percent of the burst. The test was asserting a property of the *product* while measuring a bucket
 * left wherever the preceding suite happened to leave it — passing, in part, on luck.
 *
 * **The assertion is unchanged: zero refusals.** What changed is that the first test now waits for
 * the bucket to be provably full before it starts, so it measures the burst rather than the
 * suite. The wait is DERIVED from the two constants, so re-sizing the limiter cannot leave a wait
 * behind that is too short to do its job — the same rule the flood test below already follows.
 *
 * **What is NOT claimed any more:** that the suite running unpaced proves the burst is adequate. It
 * proves the other 223 tests tolerate whatever the bucket does, which is a weaker and different
 * statement. If a 429 ever surfaces as an unexplained flake elsewhere, this is the first thing to
 * suspect.
 *
 * The cross-client property — that one device's traffic refuses another's — is deliberately NOT
 * asserted here. It was, and it passed locally while failing in CI, because sixty real HTTP requests
 * take long enough on a slower runner for the bucket to refill mid-burst: it was measuring elapsed
 * time by accident. It lives in `test/server/listener.test.ts` with a frozen clock instead.
 */

import { expect, request as playwrightRequest, test } from '@playwright/test'

import { RATE_LIMIT_GLOBAL_BURST, RATE_LIMIT_GLOBAL_PER_SECOND } from '../../src/server/limits'
import { PORT_TAILNET } from './ports'

const BASE = `http://127.0.0.1:${PORT_TAILNET}`

/** Measured in WebKit: shell, manifest, module, stylesheet, session, stream. */
const REQUESTS_PER_COLD_LOAD = 6
/** the user's tailnet is three devices, plus a duplicate tab. */
const CONCURRENT_DEVICES = 4

/**
 * Long enough to refill the bucket from **completely empty**, which is the worst case and the only
 * one that needs no assumption about what the suite left behind.
 *
 * Derived, never typed as a number: at `BURST` tokens and `PER_SECOND` refill, a drained bucket is
 * full after `BURST / PER_SECOND` seconds. The extra 200ms covers the fact that the wait and the
 * refill are measured by two different clocks.
 */
const REFILL_FROM_EMPTY_MS =
  Math.ceil((RATE_LIMIT_GLOBAL_BURST / RATE_LIMIT_GLOBAL_PER_SECOND) * 1000) + 200

test('several devices cold-loading at once produce ZERO refusals', async () => {
  /**
   * K2's stated proof, and the failure it guards against is not a security one.
   *
   * **A refused asset is not a retried asset.** A stylesheet or module answered 429 is a broken page
   * with no recovery path — unlike an API call, which backs off. So a burst too small for the app's
   * own page loads presents as the app being broken, on whichever device happened to be second.
   */
  await new Promise(resolve => setTimeout(resolve, REFILL_FROM_EMPTY_MS))

  const contexts = await Promise.all(
    Array.from({ length: CONCURRENT_DEVICES }, () => playwrightRequest.newContext()),
  )
  try {
    const statuses = await Promise.all(
      contexts.flatMap(context =>
        Array.from({ length: REQUESTS_PER_COLD_LOAD }, () =>
          context.get(`${BASE}/`).then(r => r.status())),
      ),
    )

    expect(
      statuses.filter(status => status === 429).length,
      `${CONCURRENT_DEVICES} devices × ${REQUESTS_PER_COLD_LOAD} requests must not be throttled — ` +
      'a refused asset has no retry, so this presents as the app being broken',
    ).toBe(0)
  } finally {
    await Promise.all(contexts.map(c => c.dispose()))
  }
})

/**
 * **THE TWO MECHANISM CASES THAT USED TO SIT HERE WERE REMOVED, 2026-08-14, AND THIS SAYS WHY.**
 *
 * They were *"the limiter still fires against a genuine flood"* and *"the bucket refills, so the
 * refusal is a brake and not a ban"*. Both floods were sized **from** the shipped constant, which was
 * the right instinct. Neither can fire against the e2e server any more: it now runs a test-only
 * limit (the ruling; `test/e2e/limits.ts` has the measurement and the cost), and no harness can
 * out-run a 1,000/s refill.
 *
 * **A control test that cannot make its control fire is worse than no test**, because it reads as
 * coverage. Leaving them to pass vacuously is the exact failure this build has spent four reviews
 * removing, so they are gone rather than quietly green.
 *
 * **The coverage did not go with them.** `test/server/rate-limit.test.ts` proves the mechanism
 * directly and at more angles than a browser can: the full burst is allowed, the next request is
 * refused, refill happens at the configured rate and never beyond the burst, an hour of idling grants
 * no more than a minute of it, fractional tokens survive, keys are independent, a refused request
 * consumes nothing, a backwards clock grants nothing free, and eviction can never be a bypass. It
 * also pins the **shipped** numbers, which is what this file can no longer do.
 *
 * **What stays here is what only a browser can say:** that several real devices cold-loading at once
 * produce zero refusals. That is K2's stated proof, and it is about the application rather than the
 * limiter.
 */
