import { describe, expect, it } from 'vitest'

import { readRateLimitOverride } from '../../src/server/limits'

/**
 * **THE TEST-ONLY RATE LIMIT MUST BE UNREACHABLE FROM EVERY SHIPPED PATH.**
 *
 * ruled 2026-08-14: the e2e server runs its own limit because the suite sustains ~70
 * requests per second against a 50/s refill and drains the bucket during ordinary testing.
 * `test/e2e/limits.ts` carries the measurement and states the cost.
 *
 * **This is the guard on that decision.** An override of a rate limiter is a security-relevant knob,
 * and the property that makes it acceptable is that nothing a person installs can turn it on: no
 * config file, no flag, no default — two environment variables that the LaunchAgent, `npm run serve`
 * and every install leave unset.
 *
 * **This test also caught a hazard of its own making.** The reader was written in `main.ts`, which
 * ends with `void main()` — so importing it here **started a server** mid-unit-run. It failed on a
 * missing `dist` and printed a startup error into a green suite; had that path resolved, a unit test
 * would have bound the live ports. The reader now lives in `limits.ts`, which does nothing when
 * imported.
 *
 * **Both or neither, and malformed is a refusal to start.** A half-applied override would run the
 * server with one of the two numbers changed and nobody's intended configuration in effect — and the
 * suite would then report on it as though it were the product.
 */
describe('the rate-limit override', () => {
  it('is absent when neither variable is set — every shipped path', () => {
    const read = readRateLimitOverride({})
    expect(read.ok).toBe(true)
    if (!read.ok) return
    // `null` is what makes `bootstrap` fall through to the shipped constants.
    expect(read.value, 'an unset environment produced an override').toBeNull()
  })

  it('refuses to start on half an override', () => {
    expect(readRateLimitOverride({ SOIL_RATE_PER_SECOND: '1000' }).ok).toBe(false)
    expect(readRateLimitOverride({ SOIL_RATE_BURST: '5000' }).ok).toBe(false)
  })

  it('accepts both together', () => {
    const read = readRateLimitOverride({ SOIL_RATE_PER_SECOND: '1000', SOIL_RATE_BURST: '5000' })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value).toEqual({ ratePerSecond: 1000, burst: 5000 })
  })

  it('refuses anything that is not a positive integer, rather than coercing it', () => {
    // `Number('')` is 0 and `Number(' 12 ')` is 12 — coercion is how a typo becomes a configuration.
    for (const bad of ['0', '-5', '1.5', '', ' 12 ', 'lots', '1e3', '0x10']) {
      expect(
        readRateLimitOverride({ SOIL_RATE_PER_SECOND: bad, SOIL_RATE_BURST: '5000' }).ok,
        `SOIL_RATE_PER_SECOND=${JSON.stringify(bad)} was accepted`,
      ).toBe(false)
      expect(
        readRateLimitOverride({ SOIL_RATE_PER_SECOND: '1000', SOIL_RATE_BURST: bad }).ok,
        `SOIL_RATE_BURST=${JSON.stringify(bad)} was accepted`,
      ).toBe(false)
    }
  })

  it('refuses a value too large to be an exact integer', () => {
    expect(readRateLimitOverride({
      SOIL_RATE_PER_SECOND: '9007199254740993', SOIL_RATE_BURST: '5000',
    }).ok).toBe(false)
  })
})
