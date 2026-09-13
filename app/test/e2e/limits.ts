/**
 * **THE RATE LIMIT THE E2E SERVER RUNS WITH — a test-only value, and the shipped app never sees it.**
 *
 * ruled 2026-08-14, option A of three put to them.
 *
 * **Why the suite needs its own number.** The limiter is **global** by the security review's ruling: behind
 * `tailscale serve` every device's address collapses to `127.0.0.1`, so a per-client bucket is
 * undeliverable (§7). One bucket serves the whole process. The shipped size — 120 burst, 50/s — is
 * derived from real use: three devices plus a reload is about 42 requests, roughly a third of the
 * burst.
 *
 * **The suite is not real use, and this was measured rather than assumed.** Logging every refusal
 * server-side across a full Chromium run produced **265** of them: 260 belonged to the flood tests
 * that exist to cause them, and **five** were collateral — all inside one 1.2-second window, and
 * **fifty-five seconds away from the nearest flood**, so the floods were not the cause. During dense
 * stretches the suite sustains roughly **70 requests per second** against a 50/s refill, so the
 * bucket drains over a few seconds of ordinary testing.
 *
 * **What that cost before it was understood:** a refused `session.start` leaves a page with no token,
 * so every request after it fails too — one refusal takes down a whole screen. It surfaced as
 * `board-refresh` failing about one run in two, and was chased as a WebKit hang, connection
 * exhaustion, a watcher stall, a fixture-count problem and a stale rate-limit derivation.
 *
 * **`playwright.config.ts` already concedes this exact point for a different reason**, in its note on
 * `workers: 1`: *"parallelism here measures the limiter, not the application."* This is the same
 * sentence applied to the sustained rate rather than to concurrency.
 *
 * **THE COST, STATED RATHER THAN BURIED.** Running the suite above the shipped numbers means the
 * browser tests no longer exercise the limiter at the size that ships. That is why
 * `test/server/rate-limit.test.ts` pins the shipped constants directly — see the case named for it —
 * and why the two e2e cases that existed to make the limiter *fire* were removed rather than left in
 * a state where they could not: a control test that cannot make its control fire is worse than no
 * test, because it reads as coverage.
 */

/**
 * Well above the ~70/s the suite sustains, and below nothing in particular — there is no ceiling
 * worth respecting here, because this number protects a temp directory for two and a half minutes.
 */
export const E2E_RATE_PER_SECOND = 1_000

/**
 * Large enough that no burst of page loads can drain it inside a run. The shipped burst has a real
 * constraint — a burst above `MAX_CONNECTIONS` (256) can never be drained in one wave and so is not
 * a bound at all — and that constraint does not apply here, because nothing is trying to drain this
 * one.
 */
export const E2E_RATE_BURST = 5_000
