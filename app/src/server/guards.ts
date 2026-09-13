/**
 * The request guards. Spec §7, in the order the spec requires them to run.
 *
 * Written as pure functions over headers rather than as middleware, for one reason: every rule
 * below is a rule v1 got *factually wrong*, and the only way to know these are right is to run them
 * against the exact header shapes an attacker sends. A pure function can be handed a hundred
 * malformed header sets in a millisecond; middleware needs a socket.
 *
 * WHAT V1 GOT WRONG, because each mistake is why a rule reads the way it does:
 *
 *   - **The loopback gate was inverted and void.** v1 gated privileged verbs on "requests from
 *     `127.0.0.1` only". `tailscale serve` terminates TLS and opens a *fresh local connection*, so
 *     every phone request passed, and the only requests correctly refused were on a raw tailnet
 *     listener nobody used. Hence: **privilege is decided by which listener accepted the
 *     connection**, never by an address, never by a header. That decision is made in `routes.ts`,
 *     not here — this file never sees an address.
 *   - **"No CORS headers stops cross-origin writes" is false.** Withholding CORS stops an attacker
 *     *reading the response*; it does nothing to stop the request being sent and executed. So the
 *     defense is the four checks below, not the absence of a header.
 *   - **The hostname is not a secret.** `tailscale serve`'s Let's Encrypt certificate is published
 *     in Certificate Transparency logs. Nothing here may assume obscurity.
 *   - **Funnel was inferred, and the inference failed in both directions.** See `FUNNEL` below.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

import { TransportErrorCode } from '../contract/wire'

/** Headers as Node gives them: a name may legitimately arrive more than once. */
export type RawHeaders = Readonly<Record<string, string | string[] | undefined>>

/**
 * Headers whose duplication must be refused rather than resolved. Spec §7: "Reject multiple `Host`
 * headers."
 *
 * **This exists because `single()` below could not do the job, and the P2 review proved it.** Node
 * collapses duplicates before any handler sees them: it **discards** the second `Host` and
 * `Content-Type` and **joins** everything else with `", "`. So `single()`'s array branch is dead
 * code for real requests, the unit test asserting it fed a shape Node does not produce, and the two
 * headers where duplication actually decides something took the *first* copy silently.
 *
 * That is the gap between policy and enforcement, found in a test rather than a config this time.
 * `rawHeaders` preserves every copy — verified — so the count happens there.
 *
 * `Content-Length` is included because a disagreement about body length between two parsers is the
 * foundation of request smuggling, even though Node also collapses it.
 */
const SINGLETON_HEADERS = ['host', 'content-type', 'content-length']

/**
 * Refuses a request carrying any singleton header more than once.
 *
 * Takes `rawHeaders` — Node's flat `[name, value, name, value, …]` array — because that is the only
 * place the duplicates still exist by the time a handler runs.
 */
export function checkNoDuplicateHeaders(rawHeaders: readonly string[]): GuardResult {
  const counts = new Map<string, number>()
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = asciiLowerCase(rawHeaders[i] ?? '')
    if (!SINGLETON_HEADERS.includes(name)) continue
    const next = (counts.get(name) ?? 0) + 1
    if (next > 1) {
      return no(TransportErrorCode.BAD_REQUEST, `duplicate ${name} header`)
    }
    counts.set(name, next)
  }
  return OK
}

export interface Refusal {
  readonly code: TransportErrorCode
  /** For the local log only. Never sent to the client. */
  readonly reason: string
}

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly refusal: Refusal }

const OK: GuardResult = { ok: true }
const no = (code: TransportErrorCode, reason: string): GuardResult =>
  ({ ok: false, refusal: { code, reason } })

/**
 * Exactly one value for a header, or `null`.
 *
 * A repeated header is **refused, never joined and never last-wins**. Request smuggling and
 * header-confusion attacks live in the disagreement between two parsers about which copy counts;
 * refusing removes the disagreement. Spec §7 names this for `Host` specifically and the same
 * reasoning applies to every header a decision is made on, so it is applied uniformly here.
 */
function single(headers: RawHeaders, name: string): string | null | undefined {
  const value = headers[name]
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.length === 1 ? (value[0] ?? null) : null
  return value
}

/**
 * ASCII lowercase only. Deliberately NOT `toLowerCase()`.
 *
 * Spec §7: "raw header, ASCII-lowercased **only** — no trailing-dot strip, no IDNA, no port
 * defaulting, no IPv6 canonicalization, no DNS lookup." Unicode lowercasing would fold characters
 * into ASCII lookalikes and let a crafted host match the allowlist; the Turkish dotless-i family is
 * the classic. Same reasoning as Core's `toASCIILowerCase`, and the same rule: narrow beats clever.
 */
export function asciiLowerCase(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : value[i]
  }
  return out
}

/** Printable ASCII, no space, no control characters. Anything else in a Host is hostile. */
const LEGAL_HOST_BYTES = /^[!-~]+$/

/**
 * Host validation. **The first operation, default-deny.** Spec §7.
 *
 * `allowed` is derived at startup from the actual bind config plus the MagicDNS name — never from
 * a request, and never widened at runtime. Exact match after ASCII-lowercasing, and nothing else:
 * no normalisation of any kind, because every normalisation step is a way for two spellings to
 * become one and for the wrong one to be let in.
 */
export function checkHost(headers: RawHeaders, allowed: ReadonlySet<string>): GuardResult {
  const host = single(headers, 'host')
  if (host === undefined) return no(TransportErrorCode.BAD_HOST, 'missing Host')
  if (host === null) return no(TransportErrorCode.BAD_HOST, 'multiple or empty Host headers')
  if (!LEGAL_HOST_BYTES.test(host)) return no(TransportErrorCode.BAD_HOST, 'illegal bytes in Host')
  if (!allowed.has(asciiLowerCase(host))) return no(TransportErrorCode.BAD_HOST, 'host not allowed')
  return OK
}

/**
 * Absolute-form request targets are refused. Spec §7 names this alongside Host validation, and the
 * reason is that `GET http://evil/ HTTP/1.1` puts the authority in the target instead of the Host
 * header, so a check that only reads `Host` sees whatever it likes there.
 */
export function checkRequestTarget(target: string): GuardResult {
  // Written with index access rather than `startsWith`, and NOT because the lint rule forced a
  // workaround — it forced the right question. Spec §5 bans prefix comparison on paths because
  // `/soil/notes` must not match `/soil/notes-old`; this is a single-character check on one string,
  // which is a different operation that happened to share a method name. Index access says what is
  // actually meant and needs no escalation. The rule earned its keep by making that explicit.
  if (target.length === 0) return no(TransportErrorCode.BAD_REQUEST, 'empty request target')
  if (target[0] !== '/') return no(TransportErrorCode.BAD_REQUEST, 'absolute-form target')
  if (target[1] === '/') return no(TransportErrorCode.BAD_REQUEST, 'protocol-relative target')
  return OK
}

/**
 * Funnel refusal — the **positive** identification. Spec §7.
 *
 * Tailscale sets `Tailscale-Funnel-Request` on Funnel requests and only on Funnel requests, and
 * strips any incoming copy before setting it, so it cannot be forged into a loopback-only backend.
 *
 * **Measured rather than cited, 2026-08-13.** That sentence was read off Tailscale's documentation
 * and believed for six days. Sent through the real mount, a client-supplied
 * `Tailscale-Funnel-Request: ?1` never reached this function: with a bad Origin the refusal was
 * `FORBIDDEN_ORIGIN` and with a good one it was `MISSING_TOKEN`, both of which are gates that sit
 * *after* this one in `listener.ts`. The same run found `Tailscale-User-Login: attacker@example.com`
 * replaced with the tailnet's real identity.
 *
 * **This does not make the check redundant, and the reasoning matters more than the result.** The
 * stripping is Tailscale's behaviour, not this app's, and it is the property of one specific front.
 * §7 requires the app to refuse Funnel traffic on its own evidence; a control that is currently
 * unreachable is still the only thing standing there if the front ever changes.
 *
 * v1's rule inferred Funnel from *"proxy headers present but no `Tailscale-User-Login`"*, and that
 * inference **failed in both directions**: Tailscale also omits the identity headers for tagged
 * devices and when identity lookup fails (which its own source notes includes the local machine),
 * so the rule rejected legitimate traffic; and `X-Forwarded-For` is set on Funnel traffic too, so
 * the presence of proxy headers distinguished nothing and it missed the requests it existed to
 * catch. A control that blocks the wrong requests while missing the right ones is worse than none,
 * because it reads as coverage.
 *
 * The second mechanism — polling the LocalAPI with a "funnel status unknown" state that refuses
 * rather than fails open — is separate and lives with the server lifecycle, not here.
 */
export function checkNotFunnel(headers: RawHeaders): GuardResult {
  return headers['tailscale-funnel-request'] === undefined
    ? OK
    : no(TransportErrorCode.FUNNEL_REFUSED, 'Tailscale-Funnel-Request present')
}

/** Spec §7: state-changing verbs are POST/PATCH only; everything else is refused. */
export function checkMethod(method: string): GuardResult {
  if (method === 'POST' || method === 'PATCH') return OK
  // OPTIONS is refused with 405 and **no CORS headers** — answering a preflight is how the
  // preflight stops being a defense. The caller must not add CORS headers to this response.
  return no(TransportErrorCode.METHOD_NOT_ALLOWED, `method ${method}`)
}

/**
 * Spec §7: `Content-Type: application/json` required, "rejected **415 before body parsing**".
 *
 * This is load-bearing for CSRF rather than for parsing convenience: a non-simple content type
 * forces the browser into a preflight, and the preflight then fails because no CORS headers are
 * ever sent. A form post cannot set it.
 *
 * Parameters are permitted (`application/json; charset=utf-8`) but the type itself must match
 * exactly — no `+json` suffixes, no wildcards.
 */
export function checkContentType(headers: RawHeaders): GuardResult {
  const raw = single(headers, 'content-type')
  if (raw === undefined || raw === null) {
    return no(TransportErrorCode.UNSUPPORTED_MEDIA_TYPE, 'missing or repeated Content-Type')
  }
  const semicolon = raw.indexOf(';')
  const type = asciiLowerCase(semicolon === -1 ? raw : raw.slice(0, semicolon)).trim()
  return type === 'application/json'
    ? OK
    : no(TransportErrorCode.UNSUPPORTED_MEDIA_TYPE, 'content type not application/json')
}

/**
 * Origin and Sec-Fetch, default-deny. Spec §7, rules 3 and 4.
 *
 * **A missing `Origin` and `Origin: null` are rejected — never treated as same-origin.** `null`
 * covers sandboxed iframes and `file://` pages, which includes a vault `.html` opened from Finder:
 * an entirely plausible thing for the operator to double-click, and one that would otherwise be able to
 * command the app.
 */
export function checkOrigin(headers: RawHeaders, allowedOrigins: ReadonlySet<string>): GuardResult {
  const origin = single(headers, 'origin')
  if (origin === undefined) return no(TransportErrorCode.FORBIDDEN_ORIGIN, 'missing Origin')
  if (origin === null) return no(TransportErrorCode.FORBIDDEN_ORIGIN, 'multiple Origin headers')
  if (origin === 'null') return no(TransportErrorCode.FORBIDDEN_ORIGIN, 'Origin: null')
  if (!allowedOrigins.has(asciiLowerCase(origin))) {
    return no(TransportErrorCode.FORBIDDEN_ORIGIN, 'origin not allowed')
  }

  const site = single(headers, 'sec-fetch-site')
  if (site !== undefined && site !== null && site !== 'same-origin') {
    return no(TransportErrorCode.FORBIDDEN_ORIGIN, `Sec-Fetch-Site ${site}`)
  }

  const mode = single(headers, 'sec-fetch-mode')
  if (mode === 'no-cors') return no(TransportErrorCode.FORBIDDEN_ORIGIN, 'Sec-Fetch-Mode no-cors')

  return OK
}

/**
 * THE STREAM HANDSHAKE. The security review's C1, and the shape of it is the ruling.
 *
 * **`Sec-Fetch-Site` is ADDITIVE to the Origin allowlist, never a replacement.** The brief that went
 * to the security review proposed replacing `checkOrigin` on this route; it was refused, and the review amended its own earlier
 * wording that had invited it. Replacing would throw away a control that already works against the
 * measured cross-origin case.
 *
 * WHY THE ORIGIN CHECK ALONE CANNOT STAND HERE — measured, not reasoned. In Chromium, in WebKit, and
 * on the operator's iPhone through a real `tailscale serve`:
 *
 *   same-origin `EventSource`  ->  Origin ABSENT,  Sec-Fetch-Site: same-origin
 *   cross-origin `EventSource` ->  Origin present, Sec-Fetch-Site: SAME-SITE
 *
 * So `checkOrigin`'s default-deny on a missing `Origin` would refuse **the app's own stream** — and
 * the fix that suggests itself, `if (origin === undefined) allow`, is the exact hole the check
 * exists to close.
 *
 * **AND THE TRAP, which is why the assertion must be positive.** The cross-origin attacker came back
 * `same-site`, NOT `cross-site` — a different port on the same host is the same *site*. In
 * production that covers **every other machine on the user's tailnet**, since they share a
 * registrable domain. A check written as "refuse `cross-site`" would wave all of them through. Only
 * *present, and exactly `same-origin`* holds.
 *
 * WHAT THIS DOES AND DOES NOT DO, in the words the security review asked be written here so nobody later asks
 * which of the two controls is redundant:
 *
 *   - **The ticket answers "is this caller authorized."**
 *   - **`Sec-Fetch-Site` answers "is this browser being driven by our own page."**
 *
 * Neither substitutes for the other. `Sec-Fetch-*` are forbidden header names — `fetch` cannot set
 * them and `EventSource` has no header API — so a page that can only *make the browser send a
 * request* cannot forge them. A caller that sets arbitrary headers is not a confused deputy; it is a
 * direct client, and against a direct client the ticket is the control.
 *
 * **Absent refuses.** Safari shipped `Sec-Fetch-*` in 16.4; the operator's iPhone runs Safari 26.5.2, so
 * refusing costs nothing on the target device. Falling back would convert "old Safari" into "any
 * client that omits a header", handing a pass by omission — strictly easier than the forgery that
 * was already impossible.
 */
export function checkStreamHandshake(
  headers: RawHeaders,
  allowedOrigins: ReadonlySet<string>,
  method: string,
): GuardResult {
  /**
   * METHOD FIRST, because `/events` was the one route in this build with no method policy at all.
   *
   * Spec §7's CSRF rules make it a MUST: *"state-changing verbs are POST/PATCH only; no side effects
   * on GET/HEAD; PUT/DELETE/TRACE/CONNECT → 405."* `routes.ts` states that policy as universal.
   * `checkMethod` delivers it — and is reached only from `checkRequest`, which the stream branch
   * returns before. A fifth review round measured `POST /events` and `DELETE /events` each answering
   * **200 text/event-stream**, and each allocating: a slot in `MAX_STREAMS_TOTAL`, a `hold()` on the
   * ticket, and a heartbeat timer.
   *
   * **GET ONLY — HEAD is refused too, and that is not pedantry.** The first version of this check
   * allowed HEAD on the reasoning that HEAD is safe wherever GET is. A sixth review round measured
   * what it actually does here: `HEAD /events` opens a **real stream**. Eight tickets × four HEADs
   * filled all 32 slots of `MAX_STREAMS_TOTAL`, after which a legitimate `GET` from a fresh ticket
   * was refused 429.
   *
   * And the slots are unreclaimable. **Node discards the body of a HEAD response**, so `res.write()`
   * returns `true` forever — measured 500/500 true on HEAD against 500/500 false on GET. `writeTo`'s
   * backpressure detection (the security review's C10) keys on that boolean, so on a HEAD stream it can never set
   * `backpressured`, never arm `BACKPRESSURE_GRACE_MS`, and never close. The one mechanism that
   * reclaims a non-draining peer is structurally dead on exactly the requests that cannot drain.
   *
   * An `EventSource` issues GET and nothing else, so refusing HEAD costs the app nothing — and the
   * previous comment said exactly that while the code admitted a second verb. Recurring shape: a
   * control correct in isolation and never reached, and the wording met with the property not
   * delivered, in one line.
   */
  if (method !== 'GET') {
    return no(TransportErrorCode.METHOD_NOT_ALLOWED, `${method} on the stream route`)
  }

  const funnel = checkNotFunnel(headers)
  if (!funnel.ok) return funnel

  const site = single(headers, 'sec-fetch-site')
  if (site === undefined || site === null) {
    return no(TransportErrorCode.FORBIDDEN_ORIGIN, 'missing Sec-Fetch-Site on a stream handshake')
  }

  /**
   * §7 MUST #4, and it was missing here. *"All four of these MUST hold on every non-static route"* —
   * #4 is *"`Sec-Fetch-Mode: no-cors` rejected."* `checkOrigin` enforces it for the JSON path; this
   * function never read the header, so `GET /events` with a valid ticket, `Sec-Fetch-Site:
   * same-origin` **and** `Sec-Fetch-Mode: no-cors` was answered 200.
   *
   * `stream.ts`'s header claims *"the guards this uses are the same ones the request path uses…
   * a second implementation is a second thing to get wrong."* It **is** a second implementation, and
   * it did differ — in exactly the direction that sentence was written to prevent.
   */
  const mode = single(headers, 'sec-fetch-mode')
  if (mode === 'no-cors') {
    return no(TransportErrorCode.FORBIDDEN_ORIGIN, 'Sec-Fetch-Mode no-cors on a stream handshake')
  }
  if (site !== 'same-origin') {
    // Note what this refuses: `same-site` is the MEASURED cross-origin attacker, not a near-miss.
    return no(TransportErrorCode.FORBIDDEN_ORIGIN, `Sec-Fetch-Site ${site}`)
  }

  // Additive. When `Origin` IS present it must still be one of ours — a same-origin EventSource
  // omits it, so this is not reachable by the app itself, but anything that does send one is held
  // to the allowlist exactly as the JSON path holds it.
  const origin = single(headers, 'origin')
  if (origin === null) {
    return no(TransportErrorCode.FORBIDDEN_ORIGIN, 'multiple Origin headers')
  }
  if (origin !== undefined && !allowedOrigins.has(asciiLowerCase(origin))) {
    return no(TransportErrorCode.FORBIDDEN_ORIGIN, 'origin not allowed')
  }

  return OK
}

/** The header the per-request token travels in. A custom header cannot be set cross-origin. */
export const TOKEN_HEADER = 'x-soil-token'

/**
 * Mints a request token. Spec §7, token property 1: `crypto.randomBytes`, 16 bytes minimum —
 * "never `Math.random`, never a timestamp, never a counter, never a hash of anything predictable."
 *
 * **Hex-encoded, and that is not cosmetic.** The first version of this held raw bytes and compared
 * them against the header value read as UTF-8. Random bytes are not valid UTF-8, so the header
 * round-trip replaced every invalid sequence with U+FFFD and the CORRECT token was rejected — the
 * test caught it immediately, but the failure mode had it shipped would have been worse than a
 * crash: an authentication check that fails closed for everyone looks like a broken app, and the
 * fix a hurried builder reaches for is to loosen the comparison.
 *
 * Hex is chosen over base64url for one reason: it is fixed-width and has no padding, so the
 * encoded length never varies with the value. A variable-length encoding would leak a bit through
 * the length check below.
 */
export function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/** 16 bytes as hex. Exactly what `createToken` produces, and the only shape `checkToken` accepts. */
const TOKEN_BYTES = 16
const TOKEN_SHAPE = /^[0-9a-f]{32}$/

/**
 * Constant-time token comparison. Spec §7, token property 2: `crypto.timingSafeEqual`, "never
 * `===` or `==`. A byte-by-byte comparison that returns early leaks the token one character at a
 * time to anything that can measure response time — and everything on the tailnet can."
 *
 * `timingSafeEqual` throws when the buffers differ in length, and an uncaught throw would be both a
 * crash and a length oracle. So the presented value is copied into a buffer of the expected length
 * and compared in full; the length equality is then checked separately, and **both results are
 * computed before either is used** — `&&` would short-circuit and put the length back into the
 * timing.
 */
export function checkToken(headers: RawHeaders, expected: string): GuardResult {
  // THE EXPECTED TOKEN IS VALIDATED FIRST, and this is a real finding rather than defensive
  // padding. The security review's P2 review, condition 2: with `expected` an empty string, `Buffer.alloc(0)`
  // makes `timingSafeEqual(empty, empty)` true, the lengths match, and **every request
  // authenticates**. Verified live before fixing: `checkToken({token: ''}, '')` returned `ok: true`.
  //
  // Nothing anywhere asserted the configured token came from `createToken()`. The bootstrap that
  // could hand this an unset env var or a config default is being written in P3, so this closes
  // now — before the code that would trip it exists, rather than after.
  if (!TOKEN_SHAPE.test(expected)) {
    return no(TransportErrorCode.MISSING_TOKEN, 'configured token is malformed')
  }

  const presented = single(headers, TOKEN_HEADER)
  if (presented === undefined || presented === null) {
    return no(TransportErrorCode.MISSING_TOKEN, 'missing or repeated token header')
  }

  const expectedBytes = Buffer.from(expected, 'utf8')
  const supplied = Buffer.from(presented, 'utf8')
  const padded = Buffer.alloc(expectedBytes.length)
  supplied.copy(padded, 0, 0, Math.min(supplied.length, expectedBytes.length))

  // Both comparisons always run; `&&` would short-circuit and leak the length by timing.
  const contentMatches = timingSafeEqual(padded, expectedBytes)
  const lengthMatches = supplied.length === expectedBytes.length
  return contentMatches && lengthMatches ? OK : no(TransportErrorCode.MISSING_TOKEN, 'token mismatch')
}

export interface GuardConfig {
  readonly allowedHosts: ReadonlySet<string>
  readonly allowedOrigins: ReadonlySet<string>
  readonly token: string
}

/**
 * Every guard, in spec order, first failure wins.
 *
 * The order is not cosmetic. Host is first because §7 says so and because every later decision is
 * meaningless if the request was not addressed to us. Funnel is next because a Funnel request must
 * be refused whatever else is true of it. Content-Type precedes any body handling, per §7's
 * "rejected 415 **before body parsing**" — the caller must not have read the body yet when it
 * calls this.
 */
export function checkRequest(
  headers: RawHeaders,
  method: string,
  target: string,
  config: GuardConfig,
  /**
   * The flat `[name, value, name, value, …]` array. **REQUIRED — it defaulted to `[]` and that was
   * strictly worse than the `method = 'GET'` default removed one commit earlier.** `'GET'` picked a
   * permissive *value*; `[]` **turns the first guard in this chain off entirely**, because
   * `checkNoDuplicateHeaders([])` iterates nothing and returns OK.
   *
   * Proven: with the same headers, the same method and the same config, a request carrying
   * `Host: 127.0.0.1` + `Host: evil.example` and two `Content-Length`s is refused when the array is
   * passed and **accepted when the argument is omitted**. That is the exact wire shape C7 exists to
   * refuse.
   *
   * Its removed default was defended in a test with *"the listener always passes the real array"* —
   * which is verbatim the reasoning `stream.ts`'s header rejects two files over: *a guarantee that
   * holds only because of who happens to call it is not a guarantee.* The rule was declared
   * absolutely in the commit that fixed `method` and applied to one of the two permissive defaults
   * on this surface; a seventh review round found the other one, in this file, five lines away.
   *
   * Ten of eleven call sites omitted it, including every test in `guards.test.ts` — so the suite for
   * "every guard, in spec order, first failure wins" had never once exercised the first guard.
   */
  rawHeaders: readonly string[],
  /**
   * Whether the token is required. **Defaults to `true`, and the default is the security property.**
   *
   * the security review's B1: exactly one route omits the token, and which one is a fact about the route table
   * (`routeRequiresToken`), never a name comparison here. The caller resolves the route name once
   * and passes the answer; an unknown name resolves to `true`, so an attacker-supplied path cannot
   * select the weaker chain.
   *
   * A default of `false` — or an optional flag meaning "skip" — would make an unauthenticated route
   * appear by omission, which is the failure mode every other guard in this file exists to prevent.
   */
  requiresToken = true,
): GuardResult {
  const ordered = [
    // Before Host, because the whole point is that Host may be a lie by the time it is one value.
    //
    // Kept here even though `listener.ts` now runs this on every path including the asset route —
    // the same deliberate redundancy as `checkHost`. This function is called directly by tests and
    // could be called by a future route that does not go through the listener's prologue, and a
    // guard chain that is complete only because of where its caller sits is the shape that let the
    // asset path go unchecked in the first place.
    () => checkNoDuplicateHeaders(rawHeaders),
    () => checkHost(headers, config.allowedHosts),
    () => checkRequestTarget(target),
    () => checkNotFunnel(headers),
    () => checkMethod(method),
    () => checkContentType(headers),
    () => checkOrigin(headers, config.allowedOrigins),
    () => (requiresToken ? checkToken(headers, config.token) : OK),
  ]
  for (const guard of ordered) {
    const result = guard()
    if (!result.ok) return result
  }
  return OK
}
