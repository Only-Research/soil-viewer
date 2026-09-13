import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  TOKEN_HEADER, checkContentType, checkHost, checkMethod, checkNoDuplicateHeaders, checkNotFunnel,
  asciiLowerCase, checkOrigin, checkRequest, checkRequestTarget, checkStreamHandshake,
  checkToken, createToken, type RawHeaders,
} from '../../src/server/guards'
import { TransportErrorCode } from '../../src/contract/wire'

/**
 * Spec §7's guards. Every rule here is one v1 got factually wrong, so every rule gets a test that
 * fails without it — and, where the v1 mistake was a *false negative*, a test for the specific
 * shape that slipped through.
 */

const HOSTS = new Set(['localhost:8765', 'mac.tail-scale.ts.net'])
const ORIGINS = new Set(['http://localhost:8765', 'https://mac.tail-scale.ts.net'])
const TOKEN = createToken()

const good = (over: RawHeaders = {}): RawHeaders => ({
  host: 'localhost:8765',
  'content-type': 'application/json',
  origin: 'http://localhost:8765',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  [TOKEN_HEADER]: TOKEN,
  ...over,
})

describe('Host — first operation, default-deny', () => {
  it('accepts an exact allowlisted host', () => {
    expect(checkHost({ host: 'localhost:8765' }, HOSTS).ok).toBe(true)
  })

  it('accepts a differently-cased host, ASCII-folded', () => {
    expect(checkHost({ host: 'LOCALHOST:8765' }, HOSTS).ok).toBe(true)
  })

  it('refuses a missing Host', () => {
    expect(checkHost({}, HOSTS).ok).toBe(false)
  })

  it('refuses REPEATED Host headers rather than picking one, IF it is ever handed an array', () => {
    // Kept, but it is no longer the control. The P2 review proved Node never produces this shape:
    // it discards the second Host before any handler sees it. See checkNoDuplicateHeaders below,
    // which reads rawHeaders — the only place the duplicates still exist.
    expect(checkHost({ host: ['localhost:8765', 'evil.example'] }, HOSTS).ok).toBe(false)
  })

  it('refuses an unlisted host', () => {
    expect(checkHost({ host: 'evil.example' }, HOSTS).ok).toBe(false)
  })

  it('does NOT strip a trailing dot, defaulting a port, or canonicalise IPv6', () => {
    // Spec §7 forbids every one of these normalisations by name. Each would make two spellings one.
    expect(checkHost({ host: 'localhost:8765.' }, HOSTS).ok).toBe(false)
    expect(checkHost({ host: 'localhost' }, HOSTS).ok, 'no port defaulting').toBe(false)
    expect(checkHost({ host: '[::1]:8765' }, new Set(['[0:0:0:0:0:0:0:1]:8765'])).ok).toBe(false)
  })

  it('does NOT fold non-ASCII into an ASCII lookalike', () => {
    // toLowerCase() on the Turkish dotless capital I produces "i" plus a combining dot, and an
    // IDNA step would map lookalikes onto ASCII. Both are how a crafted host matches an allowlist.
    // Both of these are non-ASCII and are refused by the byte check before folding is even
    // reached — which is the point: the narrow byte rule makes the folding question moot.
    expect(checkHost({ host: 'loca\u0131host:8765' }, HOSTS).ok, 'Turkish dotless i').toBe(false)
    expect(checkHost({ host: 'LOCALHOST:8765'.replace('L', '\u013F') }, HOSTS).ok, 'L with dot')
      .toBe(false)
    expect(checkHost({ host: 'l\u03BFcalhost:8765' }, HOSTS).ok, 'Greek omicron').toBe(false)
  })

  it('refuses control characters and spaces in the Host', () => {
    expect(checkHost({ host: 'localhost:8765\r\nX-Evil: 1' }, HOSTS).ok).toBe(false)
    expect(checkHost({ host: 'localhost :8765' }, HOSTS).ok).toBe(false)
  })
})

describe('duplicate singleton headers — read from rawHeaders, where they survive', () => {
  // Spec §7 requires rejecting multiple Host headers. The P2 review found the requirement unmet at
  // the socket: Node DISCARDS the second Host and Content-Type and JOINS everything else with
  // ", ", so the guard's array branch was dead code and the two headers where duplication decides
  // something took the first copy silently. rawHeaders preserves every copy.
  const raw = (...pairs: string[]): string[] => pairs

  it('accepts a well-formed set', () => {
    expect(checkNoDuplicateHeaders(raw(
      'Host', 'localhost:8765', 'Content-Type', 'application/json', 'Origin', 'http://x',
    )).ok).toBe(true)
  })

  it('refuses a duplicate Host, whatever the casing', () => {
    const result = checkNoDuplicateHeaders(raw('Host', 'good.example', 'host', 'evil.example'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toContain('host')
  })

  it('refuses a duplicate Content-Type and Content-Length', () => {
    expect(checkNoDuplicateHeaders(raw('Content-Type', 'application/json', 'Content-Type', 'text/plain')).ok)
      .toBe(false)
    expect(checkNoDuplicateHeaders(raw('Content-Length', '10', 'Content-Length', '20')).ok).toBe(false)
  })

  it('does NOT refuse a header that may legitimately repeat', () => {
    // Over-refusing is its own failure: a rule that fires on ordinary traffic gets switched off.
    expect(checkNoDuplicateHeaders(raw('Accept', 'a', 'Accept', 'b', 'Cookie', 'x', 'Cookie', 'y')).ok)
      .toBe(true)
  })

  it('accepts an empty array — but it is no longer reachable by omission', () => {
    /**
     * **THIS TEST USED TO ARGUE FOR A HOLE.** It read: *"The parameter defaults to `[]` so existing
     * callers keep working; an empty list means 'nothing to check', not 'nothing was sent'. The
     * listener always passes the real array."*
     *
     * That last sentence is verbatim the reasoning `stream.ts`'s header rejects: *a guarantee that
     * holds only because of who happens to call it is not a guarantee.* And the default was worse
     * than the `method = 'GET'` one removed a commit earlier — `'GET'` picked a permissive value,
     * `[]` **switched this guard off entirely**.
     *
     * `checkRequest`'s parameter is now required. `checkNoDuplicateHeaders([])` still returns OK,
     * which is correct in itself — a request genuinely carrying no headers has no duplicates — but
     * nothing can arrive here empty by forgetting.
     */
    expect(checkNoDuplicateHeaders([]).ok).toBe(true)
  })
})

describe('request target', () => {
  it('accepts an origin-form path', () => {
    expect(checkRequestTarget('/api/tree.children').ok).toBe(true)
  })

  it('refuses absolute-form, which carries its own authority past the Host check', () => {
    expect(checkRequestTarget('http://evil.example/api').ok).toBe(false)
  })

  it('refuses protocol-relative and empty targets', () => {
    expect(checkRequestTarget('//evil.example/api').ok).toBe(false)
    expect(checkRequestTarget('').ok).toBe(false)
  })
})

describe('Funnel — positive identification, never inference', () => {
  it('refuses a request carrying the Funnel header', () => {
    const result = checkNotFunnel({ 'tailscale-funnel-request': 'true' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe(TransportErrorCode.FUNNEL_REFUSED)
  })

  it('does NOT infer Funnel from missing identity headers — v1 rejected legitimate traffic', () => {
    // Tailscale omits identity headers for tagged devices and when identity lookup fails, which
    // its own source notes includes the local machine. Inferring Funnel from their absence blocked
    // real users.
    expect(checkNotFunnel({ 'x-forwarded-for': '100.64.0.2' }).ok).toBe(true)
    expect(checkNotFunnel({}).ok).toBe(true)
  })

  it('does NOT treat proxy headers as evidence — they are set on Funnel traffic too', () => {
    // The other direction of v1's failure: the inference missed what it existed to catch.
    expect(checkNotFunnel({ 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' }).ok).toBe(true)
  })
})

describe('method policy', () => {
  it('permits POST and PATCH', () => {
    expect(checkMethod('POST').ok).toBe(true)
    expect(checkMethod('PATCH').ok).toBe(true)
  })

  it('refuses everything else, including OPTIONS', () => {
    for (const m of ['GET', 'HEAD', 'PUT', 'DELETE', 'TRACE', 'CONNECT', 'OPTIONS']) {
      const result = checkMethod(m)
      expect(result.ok, `${m} must be refused`).toBe(false)
      if (!result.ok) expect(result.refusal.code).toBe(TransportErrorCode.METHOD_NOT_ALLOWED)
    }
  })
})

describe('Content-Type — 415 before the body is read', () => {
  it('requires application/json', () => {
    expect(checkContentType({ 'content-type': 'application/json' }).ok).toBe(true)
    expect(checkContentType({ 'content-type': 'application/json; charset=utf-8' }).ok).toBe(true)
    expect(checkContentType({ 'content-type': 'APPLICATION/JSON' }).ok).toBe(true)
  })

  it('refuses the three types an HTML form can send — this is the CSRF forcing function', () => {
    // A form cannot set application/json, so requiring it forces a preflight, which then fails
    // because no CORS headers are ever sent. These three are what a form CAN send.
    for (const t of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']) {
      expect(checkContentType({ 'content-type': t }).ok, `${t} must be refused`).toBe(false)
    }
  })

  it('refuses a missing content type and suffixed lookalikes', () => {
    expect(checkContentType({}).ok).toBe(false)
    expect(checkContentType({ 'content-type': 'application/ld+json' }).ok).toBe(false)
    expect(checkContentType({ 'content-type': 'application/json-evil' }).ok).toBe(false)
  })

  it('returns 415-shaped refusal, not a generic bad request', () => {
    const result = checkContentType({ 'content-type': 'text/plain' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe(TransportErrorCode.UNSUPPORTED_MEDIA_TYPE)
  })
})

describe('Origin and Sec-Fetch — default-deny', () => {
  it('accepts a same-origin request', () => {
    expect(checkOrigin(good(), ORIGINS).ok).toBe(true)
  })

  it('refuses a MISSING Origin — never treated as same-origin', () => {
    const headers = { ...good() }
    delete (headers as Record<string, unknown>)['origin']
    expect(checkOrigin(headers, ORIGINS).ok).toBe(false)
  })

  it('refuses Origin: null — the sandboxed iframe and file:// case', () => {
    // A vault .html opened from Finder sends Origin: null. Treating null as same-origin would let
    // a double-clicked file command the app.
    const result = checkOrigin(good({ origin: 'null' }), ORIGINS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('Origin: null')
  })

  it('refuses a foreign origin', () => {
    expect(checkOrigin(good({ origin: 'https://evil.example' }), ORIGINS).ok).toBe(false)
  })

  it('refuses cross-site and same-site Sec-Fetch-Site', () => {
    // same-site is not same-origin: a sibling subdomain is same-site.
    expect(checkOrigin(good({ 'sec-fetch-site': 'cross-site' }), ORIGINS).ok).toBe(false)
    expect(checkOrigin(good({ 'sec-fetch-site': 'same-site' }), ORIGINS).ok).toBe(false)
    expect(checkOrigin(good({ 'sec-fetch-site': 'none' }), ORIGINS).ok).toBe(false)
  })

  it('refuses Sec-Fetch-Mode: no-cors', () => {
    expect(checkOrigin(good({ 'sec-fetch-mode': 'no-cors' }), ORIGINS).ok).toBe(false)
  })

  it('refuses repeated Origin headers', () => {
    expect(checkOrigin(good({ origin: ['http://localhost:8765', 'https://evil.example'] }), ORIGINS).ok)
      .toBe(false)
  })
})

describe('the token', () => {
  it('accepts the exact token', () => {
    expect(checkToken({ [TOKEN_HEADER]: TOKEN }, TOKEN).ok).toBe(true)
  })

  it('refuses a missing, repeated or empty token', () => {
    expect(checkToken({}, TOKEN).ok).toBe(false)
    expect(checkToken({ [TOKEN_HEADER]: ['a', 'b'] }, TOKEN).ok).toBe(false)
    expect(checkToken({ [TOKEN_HEADER]: '' }, TOKEN).ok).toBe(false)
  })

  it('refuses a token of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch, and an uncaught throw here would be both a
    // crash and a length oracle. Both lengths are exercised.
    expect(() => checkToken({ [TOKEN_HEADER]: 'short' }, TOKEN)).not.toThrow()
    expect(checkToken({ [TOKEN_HEADER]: 'short' }, TOKEN).ok).toBe(false)
    expect(checkToken({ [TOKEN_HEADER]: 'x'.repeat(500) }, TOKEN).ok).toBe(false)
  })

  it('refuses a token that shares every byte but the last', () => {
    const nearly = TOKEN.slice(0, -1) + (TOKEN.endsWith('0') ? '1' : '0')
    expect(nearly.length).toBe(TOKEN.length)
    expect(checkToken({ [TOKEN_HEADER]: nearly }, TOKEN).ok).toBe(false)
  })

  it('survives the header round-trip — the bug that raw bytes had', () => {
    // The first version held raw random bytes and compared them read back as UTF-8. Random bytes
    // are not valid UTF-8, so the round-trip replaced invalid sequences with U+FFFD and the CORRECT
    // token was rejected. An auth check that fails closed for everyone reads as a broken app, and
    // the fix a hurried builder reaches for is to loosen the comparison.
    const roundTripped = Buffer.from(TOKEN, 'utf8').toString('utf8')
    expect(roundTripped).toBe(TOKEN)
    expect(checkToken({ [TOKEN_HEADER]: roundTripped }, TOKEN).ok).toBe(true)
  })

  it('REFUSES a malformed configured token — the empty-expected bypass', () => {
    // the security review's P2 review, condition 2, and verified live before the fix:
    //   checkToken({ 'x-soil-token': '' }, '')  ->  { ok: true }
    // Buffer.alloc(0), timingSafeEqual(empty, empty) is true, the lengths match, and EVERY request
    // authenticates. Nothing asserted the configured token came from createToken(). The bootstrap
    // that could supply an unset env var is being written in P3, so this closes before that code
    // exists rather than after.
    for (const malformed of ['', 'short', 'x'.repeat(32), TOKEN.toUpperCase(), `${TOKEN}0`]) {
      expect(checkToken({ [TOKEN_HEADER]: malformed }, malformed).ok,
        `a token of "${malformed.slice(0, 12)}…" must not authenticate itself`).toBe(false)
    }
    // And the empty case specifically, presenting anything at all.
    expect(checkToken({ [TOKEN_HEADER]: 'anything' }, '').ok).toBe(false)
    expect(checkToken({}, '').ok).toBe(false)
  })

  it('accepts only what createToken produces', () => {
    expect(checkToken({ [TOKEN_HEADER]: TOKEN }, TOKEN).ok).toBe(true)
    expect(/^[0-9a-f]{32}$/.test(createToken())).toBe(true)
  })

  it('is fixed-width, so the encoded length never varies with the value', () => {
    // A variable-length encoding would leak a bit through the length comparison.
    const lengths = new Set(Array.from({ length: 50 }, () => createToken().length))
    expect(lengths.size).toBe(1)
  })

  it('is generated with CSPRNG bytes, not something predictable', () => {
    // Spec §7 token property 1. Two draws must differ, and 16 bytes is the stated minimum — hex
    // doubles that to 32 characters. A counter or timestamp would collide or increment.
    const draws = new Set(Array.from({ length: 200 }, () => createToken()))
    expect(draws.size, 'every draw must be distinct').toBe(200)
    expect(createToken()).toHaveLength(32)
    expect(/^[0-9a-f]+$/.test(createToken())).toBe(true)
  })
})

describe('checkRequest — the guards in spec order, first failure wins', () => {
  const config = { allowedHosts: HOSTS, allowedOrigins: ORIGINS, token: TOKEN }

/**
 * Calls `checkRequest` with a REAL raw-header array derived from the same headers.
 *
 * Every call in this file used to omit that argument, which defaulted to `[]` — and `[]` disables
 * `checkNoDuplicateHeaders`, the FIRST guard in the chain. So the suite for *"every guard, in spec
 * order, first failure wins"* had never once exercised the first guard, and a request carrying two
 * `Host` headers passed `checkRequest` outright when the argument was left off.
 *
 * The default is gone. This helper exists so the tests below feed the guard what a socket would,
 * rather than restoring the hole with an explicit `[]`.
 */
function check(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  target: string,
  cfg = config,
): ReturnType<typeof checkRequest> {
  const raw: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) raw.push(name, one)
  }
  return checkRequest(headers, method, target, cfg, raw)
}

  it('accepts a well-formed request', () => {
    expect(check(good(), 'POST', '/api/tree.children', config).ok).toBe(true)
  })

  /**
   * TWO CONTROLS THAT WERE CORRECT AND UNDEFENDED. A review flipped each and the whole suite stayed
   * green — and both are the kind whose failure is silent and total.
   */
  it('DEFAULTS to requiring a token — the default IS the security property', () => {
    // `requiresToken = true` is a parameter default, and the source says why at length: a default of
    // `false` "would make an unauthenticated route appear by omission". Flipping it left 945 tests
    // green. Called here with the argument OMITTED on purpose — that is the whole point.
    const noToken = good()
    delete (noToken as Record<string, unknown>)['x-soil-token']

    const result = check(noToken, 'POST', '/api/tree.children', config)

    expect(result.ok, 'omitting the argument must not omit the token check').toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe(TransportErrorCode.MISSING_TOKEN)
  })

  it('refuses a token with the right PREFIX — the length check is load-bearing', () => {
    /**
     * The comparison pads the supplied token into a buffer the length of the expected one, so
     * `timingSafeEqual` alone sees `TOKEN + anything` as a match — the extra bytes are truncated
     * away. `lengthMatches` is what refuses it, and **nothing tested that**: drop it and the suite
     * stays green while `<token>` plus any suffix authenticates. Demonstrated by a review.
     *
     * The existing long-token case uses `'x'.repeat(500)`, whose *content* differs, so it is
     * refused by the comparison and can never discriminate. This one shares the prefix exactly.
     */
    for (const suffix of ['x', '0', 'a'.repeat(32), ' ']) {
      const forged = check(
        good({ 'x-soil-token': TOKEN + suffix }), 'POST', '/api/tree.children', config,
      )
      expect(forged.ok, `token + ${JSON.stringify(suffix.slice(0, 4))} must not authenticate`)
        .toBe(false)
    }

    // And the mirror: a truncated token must fail too, so the check is a length EQUALITY and not a
    // minimum. This half already held; it is here so the pair cannot drift apart.
    expect(
      check(good({ 'x-soil-token': TOKEN.slice(0, -1) }), 'POST', '/api/x', config).ok,
      'a short token is not a valid prefix either',
    ).toBe(false)
  })

  it('the raw header array is REQUIRED, not defaulted — proven by the compiler', () => {
    /**
     * A runtime test cannot pin this, and the same limit applied to `open()`'s `method` one commit
     * earlier. Restoring `rawHeaders: readonly string[] = []` leaves every test in this file green,
     * because they all now pass the array — a default only ever bites the caller who *forgets*,
     * which is the entire hazard. Ten of eleven call sites forgot.
     *
     * `@ts-expect-error` fails the TYPECHECK when the line it guards stops erroring, so restoring
     * the default breaks `npm run typecheck` by name. The compiler is the proof clause here, and it
     * runs on every commit and in CI.
     */
    // @ts-expect-error omitting the raw header array must not compile
    expect(() => checkRequest(good(), 'POST', '/api/x', config)).toBeTypeOf('function')
  })

  it('SMUGGLED DUPLICATES ARE REFUSED, and were not when the argument could be omitted', () => {
    /**
     * The proof clause the chain never had. Ten of eleven call sites omitted `rawHeaders`, including
     * every test in this file — so the suite for *"every guard, in spec order, first failure wins"*
     * had never once exercised the first guard.
     *
     * Measured before the default was removed, on identical inputs:
     *
     *     checkRequest(headers, 'POST', '/api/x', config, smuggled).ok  ->  false
     *     checkRequest(headers, 'POST', '/api/x', config).ok            ->  true
     *
     * Same request, same chain, and the second one is the wire shape C7 exists to refuse.
     */
    const smuggled = [
      'Host', 'localhost:8765', 'Host', 'evil.example',
      'Content-Length', '2', 'Content-Length', '99',
    ]
    const result = checkRequest(good(), 'POST', '/api/tree.children', config, smuggled)

    expect(result.ok, 'a smuggled duplicate must not reach the router').toBe(false)
    if (!result.ok) expect(result.refusal.reason).toContain('duplicate')
  })

  it('reports a DUPLICATE header before Host — the point is that Host may already be a lie', () => {
    const result = checkRequest(
      good({ host: 'evil.example' }), 'POST', '/api/x', config,
      ['Host', 'localhost:8765', 'Host', 'evil.example'],
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toContain('duplicate')
  })

  it('reports the HOST failure first, even when everything else is also wrong', () => {
    // Order is load-bearing: every later decision is meaningless if the request was not addressed
    // to us, and a later check reporting first would tell an attacker which one to fix.
    const result = check(
      { host: 'evil.example', 'content-type': 'text/plain', origin: 'null' },
      'GET', 'http://evil.example/', config,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe(TransportErrorCode.BAD_HOST)
  })

  it('refuses a Funnel request before it considers the method or body type', () => {
    const result = check(
      good({ 'tailscale-funnel-request': 'true', 'content-type': 'text/plain' }),
      'POST', '/api/x', config,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe(TransportErrorCode.FUNNEL_REFUSED)
  })

  it('rejects content type BEFORE origin, so the body is never read on a form post', () => {
    const result = check(
      good({ 'content-type': 'text/plain', origin: 'https://evil.example' }),
      'POST', '/api/x', config,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe(TransportErrorCode.UNSUPPORTED_MEDIA_TYPE)
  })

  it('never sends the refusal reason anywhere a client could see it', () => {
    // The reason exists for the local log. Nothing here asserts it reaches the wire, and the
    // dispatcher's fixed-message table is what keeps it off. Recorded so the pairing is visible.
    const result = check(good({ host: 'evil.example' }), 'POST', '/api/x', config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('host not allowed')
  })

  it('the happy-path fixture is genuinely well-formed — the negatives are not vacuous', () => {
    // Every test above mutates `good()`. If `good()` were itself refused, they would all pass for
    // the wrong reason.
    for (const [name, guard] of [
      ['host', () => checkHost(good(), HOSTS)],
      ['funnel', () => checkNotFunnel(good())],
      ['content-type', () => checkContentType(good())],
      ['origin', () => checkOrigin(good(), ORIGINS)],
      ['token', () => checkToken(good(), TOKEN)],
    ] as const) {
      expect(guard().ok, `${name} must accept the good fixture`).toBe(true)
    }
  })
})

/**
 * FOUR §7 CONTROLS THAT NOTHING DEFENDED.
 *
 * A whole-suite mutation review broke each and all 969 tests stayed green. Every one is correct in
 * the code today; none had anything watching. This layer is the one already running on the user's Mac
 * and reachable from their phone, so a silent regression here has a live surface today.
 */
describe('the §7 controls with no proof clause', () => {
  it('refuses illegal bytes in a Host EVEN IF that exact string is allowlisted', () => {
    /**
     * Neutering `LEGAL_HOST_BYTES` to `/^[\s\S]*$/` left the suite green, because every hostile
     * fixture also failed the allowlist check one line below. The tests named for this rule were
     * passing on the wrong code path.
     *
     * Isolated here by putting the hostile string *into* the allowlist, so the allowlist cannot
     * refuse it and the byte rule is the only thing left standing. Header injection is the case:
     * a Host carrying CRLF is how a second header gets smuggled downstream.
     */
    for (const hostile of [
      'localhost:8765\r\nX-Evil: 1',
      'localhost:8765\u0000',
      'local host:8765',
      'localhost:8765\u007f',
    ]) {
      const allowed = new Set([hostile, asciiLowerCase(hostile)])
      const result = checkHost({ host: hostile }, allowed)

      expect(result.ok, `${JSON.stringify(hostile)} must be refused on its BYTES`).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toContain('illegal bytes')
    }
  })

  it('refuses a Funnel request BEFORE the origin checks, not merely eventually', () => {
    // `stream.test.ts` asserts the Funnel refusal happens "before anything else" and cannot tell:
    // its fixture fails nothing else, so any ordering passes. Here everything else is ALSO wrong,
    // so only the ordering can produce a Funnel code. Ordering matters because the reason reaches
    // the local log, and "someone enabled Funnel" needs a different response from the operator than
    // "a page from somewhere else tried to connect".
    const result = checkStreamHandshake(
      { 'tailscale-funnel-request': '1', 'sec-fetch-site': 'cross-site', origin: 'https://evil' },
      new Set(['http://localhost:8765']),
      'GET',
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe(TransportErrorCode.FUNNEL_REFUSED)
  })

  /**
   * THE TWO BELOW ARE PINNED STRUCTURALLY, and the reason is the same one the §4 controls gave.
   *
   * Neither is observable from a test. A constant-time comparison and a variable-time one return
   * the identical boolean — the difference is *when*, and timing is unmeasurable in-process without
   * a flaky benchmark. And `Math.random()` produces numbers that look exactly like secure ones;
   * `createToken` would still emit 32 hex characters, still unique across a million draws, and every
   * existing assertion would still pass. Both mutations were confirmed green through lint AND
   * typecheck as well.
   *
   * These are spec §7 token properties 1 and 2, both worded as absolutes: *never `Math.random`*,
   * *never `===`*. An absolute with no enforcement is the shape this build exists to refuse.
   *
   * As before: this proves the control is PRESENT, not that it FIRES.
   */
  it('keeps the two token properties that cannot be observed at runtime', async () => {
    const source = await readFile(
      new URL('../../src/server/guards.ts', import.meta.url), 'utf8',
    )

    expect(source, '§7 property 1: the token comes from the CSPRNG, never Math.random')
      .toContain('randomBytes(TOKEN_BYTES)')
    // The CALL form. The file quotes the spec's own ban — "never `Math.random`" — so matching the
    // bare name trips on the sentence forbidding it. That is now the FOURTH assertion this week to
    // match documentation instead of code, three of them mine.
    expect(source, 'and Math.random must never be CALLED in this file')
      .not.toContain('Math.random(')
    expect(source, '§7 property 2: the comparison is constant-time, never ===')
      .toContain('timingSafeEqual(padded, expectedBytes)')
  })
})
