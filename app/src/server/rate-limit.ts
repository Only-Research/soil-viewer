/**
 * The token bucket. Spec §6, F8.6: **"token bucket 120 burst / 50 per second, GLOBAL → 429."**
 *
 * *Header corrected 2026-08-07.* It quoted *"token bucket 20/s"*, which the spec no longer says —
 * the constants and the spec line both moved when the limiter was re-sized and re-named for the
 * scope it actually has (the security review's K2). The numbers and their derivation live with the constants in
 * `limits.ts`; this module is the mechanism, not the policy. A stale quotation on the file a reader
 * opens to audit the limiter is worse than no quotation, because it removes the reason to look.
 *
 * The clock is injected. Not for purity — because a rate limiter tested with real sleeps is slow,
 * flaky, and quietly disabled the first time CI is red for an unrelated reason. Every refill
 * boundary here is exercised exactly, in microseconds.
 *
 * **Tokens are integers, in thousandths.** The first version held fractional tokens as floats and
 * added `elapsedMs * rate / 1000` per refill. It failed a test immediately: ten 5ms steps at 20/s
 * should be exactly one token, and in floating point they sum to 0.9999999999999999, so the
 * request was refused one tick late. Every tick. The drift is invisible in casual use and turns a
 * 20/s limit into slightly-under-20/s forever.
 *
 * Working in milli-tokens makes the arithmetic exact: one token is 1000, and at N tokens/second the
 * refill for one whole millisecond is exactly N milli-tokens. No division, no accumulation error,
 * and the boundary lands where it is specified to land.
 *
 * **GLOBAL — one bucket for every client, and that is the ruling rather than a limitation.** It is
 * keyed on `socket.remoteAddress`, which behind `tailscale serve` is loopback for every device, so
 * the tailnet listener sees one address for all of them.
 *
 * **Re-keying it would be strictly worse than sharing.** The caller of this module runs it *ahead of
 * the entire guard chain*, deliberately, so a flood is throttled before it can generate an
 * `fsync`-per-refusal log record — and that placement is safe **only because the limiter cannot be
 * turned off by the caller.** Nothing has been validated at that point, so the only available keys
 * are ones the caller supplies; spec §7 refuses the obvious one in as many words (*"Trusting
 * `X-Forwarded-For` instead is also wrong — anything reaching the loopback port forges it"*), and a
 * local process could otherwise mint a fresh bucket per request with a counter.
 *
 * So: a denial-of-service brake, global, sized for what it covers, and never an authorization
 * control — §7 is explicit that a source address decides nothing about privilege. Recorded so nobody
 * later mistakes it for per-client fairness and builds on it.
 */

const MILLI = 1000

export interface RateLimitConfig {
  readonly ratePerSecond: number
  readonly burst: number
  /** Milliseconds since an arbitrary epoch. Monotonic in production, controlled in tests. */
  readonly now: () => number
}

interface Bucket {
  /** Thousandths of a token. Integer, always. */
  milliTokens: number
  /** Advanced only by whole milliseconds, so sub-millisecond time is carried rather than lost. */
  lastRefillMs: number
}

export interface RateLimiter {
  /** True when the request may proceed. Consumes a token when it returns true. */
  readonly take: (key: string) => boolean
  /** Drops buckets time has already refilled, so a long-lived server does not accumulate them. */
  readonly evictIdle: (idleMs: number) => number
  readonly size: () => number
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, Bucket>()
  const burstMilli = config.burst * MILLI

  /**
   * Brings a bucket up to date. Returns its milli-token count.
   *
   * `Math.floor` on the elapsed time is what keeps the arithmetic integral, and advancing
   * `lastRefillMs` by only the floored amount is what stops sub-millisecond remainders being
   * discarded on every call — which would be its own slow drift, in the other direction.
   */
  const refill = (bucket: Bucket, now: number): number => {
    const elapsedMs = Math.floor(Math.max(0, now - bucket.lastRefillMs))
    if (elapsedMs > 0) {
      bucket.milliTokens = Math.min(burstMilli, bucket.milliTokens + elapsedMs * config.ratePerSecond)
      bucket.lastRefillMs += elapsedMs
    }
    // A clock that jumped backwards leaves lastRefillMs in the future. Pull it back, so the bucket
    // does not freeze until real time catches up — a sleep/wake must not disable the limiter, and
    // must not grant free tokens either.
    if (bucket.lastRefillMs > now) bucket.lastRefillMs = now
    return bucket.milliTokens
  }

  const take = (key: string): boolean => {
    const now = config.now()
    const bucket = buckets.get(key) ?? { milliTokens: burstMilli, lastRefillMs: now }
    const available = refill(bucket, now)

    const allowed = available >= MILLI
    if (allowed) bucket.milliTokens = available - MILLI

    buckets.set(key, bucket)
    return allowed
  }

  const evictIdle = (idleMs: number): number => {
    const now = config.now()
    const cutoff = now - idleMs
    let dropped = 0
    for (const [key, bucket] of buckets) {
      // Droppable only when time would ALREADY have refilled it, because dropping a full bucket
      // and recreating it are then indistinguishable. Evicting a still-depleted bucket would hand
      // its owner a fresh full one and turn eviction into a bypass of the limit.
      //
      // The projection matters: the stored count is from the last request, so a bucket idle for a
      // minute still *reads* as depleted while actually being long since full. Comparing the stored
      // value made eviction almost never fire and the map grow without bound — caught by the test
      // asserting an idle bucket is dropped.
      const wasIdle = bucket.lastRefillMs < cutoff
      const elapsedMs = Math.floor(Math.max(0, now - bucket.lastRefillMs))
      const projected = Math.min(burstMilli, bucket.milliTokens + elapsedMs * config.ratePerSecond)
      if (wasIdle && projected >= burstMilli) {
        buckets.delete(key)
        dropped++
      }
    }
    return dropped
  }

  return { take, evictIdle, size: () => buckets.size }
}
