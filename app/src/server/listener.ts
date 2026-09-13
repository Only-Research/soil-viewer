/**
 * The two listeners. Spec §7.
 *
 * **`PORT_LOCAL`** — loopback, never a `serve` target, serves no client. It carries no route the
 * tailnet listener does not: there are currently **zero** `local-only` routes, so the split is a
 * mechanism in good order protecting nothing today. Said plainly rather than described as though it
 * were load-bearing. The verbs.
 * **`PORT_TAILNET`** — loopback, the *sole* `serve` target, and what the phone reaches.
 *
 * **Privilege is decided by which listener accepted the connection.** Never a source address,
 * never a header. That is not a policy this file enforces with a check — it is a consequence of
 * how the routers are built: `createRouter('tailnet', …)` has no key for a privileged route, so
 * this file could not dispatch one if it tried.
 *
 * The reason the spec is emphatic: v1 gated privileged verbs on "requests from `127.0.0.1` only",
 * and `tailscale serve` terminates TLS and opens a **fresh loopback connection** to the backend.
 * Every phone request therefore arrived from `127.0.0.1` and passed, while the only requests
 * refused were on a raw tailnet listener nobody used. The gate was not weak — it was inverted, and
 * it read as protection the whole time. Build-plan §3 requires the test for this to use a **local
 * reverse-proxy stand-in** and to assert *both* that the privileged route 404s **and** that
 * `remoteAddress === '127.0.0.1'` — the second half is what proves the test reproduced the real
 * condition rather than a convenient one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { createRouter, type Handlers } from '../contract/router'
import { TransportErrorCode, type WireResponse } from '../contract/wire'
import { assetHeaders, resolveAsset, type AssetMap } from './asset-map'
import { readJsonBody } from './body'
import { securityHeaders } from './csp'
import { fileRouteLabel, isFileRequest, serveFile, type FileRouteOptions } from './file-route'
import {
  checkHost, checkNoDuplicateHeaders, checkNotFunnel, checkRequest, checkRequestTarget,
  checkStreamHandshake, type GuardConfig,
} from './guards'
import {
  HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, MAX_CONNECTIONS, bodyCapFor,
  MAX_HEADER_BYTES, MAX_URL_BYTES, REQUEST_TIMEOUT_MS,
} from './limits'
import { streamHeaders } from './stream'
import { routeRequiresToken } from '../contract/routes'
import type { FunnelWatch } from './funnel-watch'
import type { LocalLog } from './local-log'
import type { MutationLog } from './mutation-log'
import type { RateLimiter } from './rate-limit'
import type { SessionStore } from './session'
import type { StreamRegistry } from './stream'

/** How long a rate-limit bucket may sit idle before it is dropped, and how often to sweep. */
const RATE_LIMIT_IDLE_MS = 60_000
const RATE_LIMIT_SWEEP_MS = 30_000

/** Status for each refusal. Kept beside the codes so a new code cannot default to 200. */
const STATUS: Record<string, number> = {
  [TransportErrorCode.BAD_REQUEST]: 400,
  [TransportErrorCode.UNKNOWN_FIELD]: 400,
  [TransportErrorCode.BAD_HOST]: 400,
  [TransportErrorCode.FORBIDDEN_ORIGIN]: 403,
  [TransportErrorCode.MISSING_TOKEN]: 403,
  [TransportErrorCode.NOT_PRIVILEGED]: 404,
  [TransportErrorCode.NOT_FOUND]: 404,
  [TransportErrorCode.METHOD_NOT_ALLOWED]: 405,
  [TransportErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [TransportErrorCode.UNSUPPORTED_MEDIA_TYPE]: 415,
  [TransportErrorCode.RATE_LIMITED]: 429,
  [TransportErrorCode.FUNNEL_REFUSED]: 403,
  [TransportErrorCode.FUNNEL_STATUS_UNKNOWN]: 503,
  [TransportErrorCode.INTERNAL]: 500,
}

/** Fixed messages. Spec §6: no stack traces, no paths, no verbatim client strings. */
const MESSAGES: Record<string, string> = {
  [TransportErrorCode.BAD_HOST]: 'Unrecognised host.',
  [TransportErrorCode.FORBIDDEN_ORIGIN]: 'This request was not permitted.',
  [TransportErrorCode.MISSING_TOKEN]: 'This request was not permitted.',
  [TransportErrorCode.FUNNEL_REFUSED]: 'This request was not permitted.',
  [TransportErrorCode.RATE_LIMITED]: 'Too many requests.',
  [TransportErrorCode.PAYLOAD_TOO_LARGE]: 'The request was too large.',
  [TransportErrorCode.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported media type.',
  [TransportErrorCode.METHOD_NOT_ALLOWED]: 'That method is not allowed.',
  [TransportErrorCode.NOT_FOUND]: 'No such route.',
  [TransportErrorCode.BAD_REQUEST]: 'The request was not in the expected shape.',
  [TransportErrorCode.INTERNAL]: 'The operation could not be completed.',
}

interface ListenerBase {
  readonly handlers: Handlers
  readonly guards: GuardConfig
  readonly rateLimiter: RateLimiter
  /**
   * This listener's session store. Required — it holds the token this listener's session route hands
   * out, and it is what the stream route checks a ticket against.
   *
   * Required rather than optional because an optional store is a listener that can be built with no
   * way to verify a ticket, which is the "reachable by omission" shape that produced the Funnel
   * discriminated union two conditions above this one.
   */
  readonly sessions: SessionStore
  readonly mutationLog: MutationLog
  /**
   * Diagnostics. Spec §6's "full detail goes to the local log", which the P2 review found had no
   * implementation at all — a 500 was unobservable. Distinct from the mutation log on purpose: that
   * one is permanent evidence, this one holds exception text that must not be preserved forever.
   */
  readonly localLog: LocalLog
  /**
   * The built client, held in memory. Optional because the LOCAL listener has no reason to serve
   * a UI — but when present, this is what makes build-plan §3's acceptance condition live rather
   * than module-level: a real request resolving through a map, with no filesystem call in the path.
   */
  readonly assets?: AssetMap
  /**
   * §9's byte endpoint. Optional for the same reason `assets` is: a test exercising the API funnel
   * has no business standing one up, and its absence is a 404 rather than a silent pass-through.
   */
  readonly fileRoute?: FileRouteOptions
  /** Injected so tests need no wall clock. */
  readonly nowIso?: () => string
}

/**
 * A DISCRIMINATED UNION, so a tailnet listener **cannot be constructed without a Funnel watch.**
 *
 * the security review's P2 review, condition 1. The first version made `funnelWatch` optional, which meant a
 * tailnet listener built without one had no second Funnel mechanism at all — and nothing said so.
 * It compiled, it ran, it served. The control whose entire design principle is *"it MUST NOT be
 * allowed to fail open"* was reachable by omission.
 *
 * That is failure #1 — silently off — in a new coat, and the fix is the move already made twice in
 * this phase: make it impossible rather than optional. A route without a validator does not
 * compile; now a tailnet listener without a Funnel watch does not either.
 *
 * The local listener genuinely must not have one. It is loopback and is never a `serve` target, so
 * Funnel cannot reach it, and gating it on a Tailscale probe would take the whole app down whenever
 * Tailscale hiccuped — to defend a path the threat cannot use.
 */
export type ListenerOptions =
  | (ListenerBase & { readonly privilege: 'local' })
  | (ListenerBase & {
      readonly privilege: 'tailnet'
      readonly funnelWatch: FunnelWatch
      /**
       * The live-update registry. Tailnet only, and by the same reasoning as `assets`: the local
       * listener serves no client, so nothing could open a stream from it.
       */
      readonly streams?: StreamRegistry
    })

/** The live-update path, and the stable name it is recorded under in the mutation log. */
const STREAM_PATH = '/events'
const STREAM_ROUTE = 'events'

/** Exact match on the path, ignoring the query string. Never a prefix — spec §5's rule, one layer up. */
function streamPathFrom(target: string): boolean {
  return (target.split('?')[0] ?? '') === STREAM_PATH
}

/**
 * What a refusal is recorded as, for a request that never reached the router.
 *
 * `routeNameFrom` answers only for API routes, so before this existed the prologue recorded every
 * stream refusal as `(static)`. R4 exists so guard-layer refusals are visible in the mutation log;
 * a visible record under the wrong route name is a weaker version of the same blindness.
 */
function routeLabelFor(target: string): string {
  if (streamPathFrom(target)) return STREAM_ROUTE
  /**
   * **Before `routeNameFrom`, and a constant rather than anything derived from the target.**
   *
   * `/file`'s query string carries the ticket, and §7's token property 4 — *never in logs* — applies
   * to it by the same reasoning. Every other route's URL is inert, so deriving a label from it is
   * safe; this one is the exception, and the exception has to be taken before the general case runs.
   */
  if (isFileRequest(target)) return fileRouteLabel
  return routeNameFrom(target) ?? '(static)'
}

/** The query parameter the stream ticket travels in. */
const TICKET_PARAM = 'ticket'

/**
 * Pulls the ticket out of the request target.
 *
 * Parsed by hand rather than with `new URL()`, for one reason worth stating: `new URL(target)`
 * throws on a malformed target, and an exception carrying the request target is how a query string —
 * which holds a credential — ends up in `recordException`'s verbatim message and stack.
 *
 * Returns `null` for absent, malformed, or repeated. A repeated parameter must not be resolved to
 * one of its values, for the same reason duplicate `Host` headers are refused rather than collapsed.
 */
function ticketFrom(target: string): string | null {
  const query = target.split('?')[1]
  if (query === undefined) return null

  let found: string | null = null
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator) !== TICKET_PARAM) continue
    if (found !== null) return null
    found = pair.slice(separator + 1)
  }
  return found
}

/** The route name is the last path segment of `/api/<name>`. No parameters, no path building. */
function routeNameFrom(target: string): string | null {
  const path = target.split('?')[0] ?? ''
  const prefix = '/api/'
  if (path.length <= prefix.length) return null
  if (path.slice(0, prefix.length) !== prefix) return null
  const name = path.slice(prefix.length)
  return name.includes('/') ? null : name
}

/**
 * **THE SUBJECT OF A MUTATION: which folder, and which path inside it.**
 *
 * §7 specifies the log as *"timestamp, method, route, **folder id + relative path**, source address,
 * …"*, and §1 accepts tailnet device trust partly *because* that record exists. Both fields were
 * hardcoded `null` at both write sites, so the log named the verb and never the subject — a
 * stolen-token trail said `file.save` a thousand times and never once said on what.
 *
 * Nothing caught it because `mutation-log.test.ts` builds its own record with the fields populated,
 * proving the serialiser while the production path wrote nulls past it.
 *
 * Read structurally rather than per route: every route that touches a file carries `rootId` and
 * `segments`, because §4 forbids composing a path any other way. A route that carries neither — a
 * list, a health check — records nulls honestly.
 *
 * Read from the **validated** body, and defensively: this runs on refusals too, where the payload
 * may be anything a caller sent. A malformed subject must not be able to fail the request that was
 * already being refused, so anything unexpected becomes `null` rather than a throw.
 */
function subjectOf(payload: unknown): { rootId: string | null; relativePath: string | null } {
  if (typeof payload !== 'object' || payload === null) return { rootId: null, relativePath: null }
  const body = payload as { rootId?: unknown; segments?: unknown }
  const rootId = typeof body.rootId === 'string' ? body.rootId : null
  const relativePath = Array.isArray(body.segments)
    && body.segments.every(segment => typeof segment === 'string')
    ? (body.segments as string[]).join('/')
    : null
  return { rootId, relativePath }
}

export function createListener(options: ListenerOptions): Server {
  const router = createRouter(options.privilege, options.handlers)
  const nowIso = options.nowIso ?? (() => new Date().toISOString())

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    // `.catch` is not belt-and-braces here. The security review's P2 review, condition 3: `handle` is an async
    // function invoked with `void` from a network-facing callback, and `readJsonBody` RETHROWS when
    // the body stream errors mid-read — which is exactly what an aborted request produces. Node 24
    // exits the process on an unhandled rejection, so an aborted upload was one plausible input
    // away from taking the server down. The irony is precise: `requestTimeout` exists to destroy
    // slow requests, and destroying a request is what fires this path.
    void handle(req, res).catch(() => { failClosed(res) })
  })

  /** Last resort. Answers rather than dying, and says nothing about why. */
  const failClosed = (res: ServerResponse): void => {
    if (res.headersSent || res.writableEnded) {
      res.destroy()
      return
    }
    refuse(res, TransportErrorCode.INTERNAL)
  }

  // Spec §6, F8.1–F8.5. Set on the server rather than per-request: a timeout applied in a handler
  // is one that never runs for a request that never reaches the handler, which is the shape of
  // request that a slowloris sends.
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
  server.maxConnections = MAX_CONNECTIONS

  /**
   * THE PER-ADDRESS CONNECTION MAP IS GONE — the security review's K4. `server.maxConnections` is the whole cap.
   *
   * R5 asked for spec §6's "64 per address" to be enforced or the constant deleted, and it was
   * enforced — on `socket.remoteAddress`. **Both listeners bind `127.0.0.1`**, and `tailscale serve`
   * opens a fresh loopback connection per client, so that map held exactly one key. The result was a
   * global cap of 64 wearing a per-address name, and `MAX_CONNECTIONS = 256` sitting above it
   * **unreachable by construction** — the 65th connection was destroyed before Node's own limit could
   * ever apply.
   *
   * The wording was met and the property was not delivered, which is the shape this build keeps
   * producing. R5's other branch is the right one now: **delete.**
   *
   * A per-source cap is not merely unimplemented here, it is **undeliverable**. This fires on a
   * socket event, before any HTTP exists — there is no identity to read and none arrives before the
   * socket is already counted. Under the keying rule, a control that fires before anything is
   * validated has no per-client scope and must not claim one.
   */

  // R6. `evictIdle` existed and nothing called it, so the bucket map was unbounded by construction
  // and safe only by accident of loopback binding — which is the shape of v1's inversion. `unref`
  // so a maintenance timer never holds the process open.
  const eviction = setInterval(() => { options.rateLimiter.evictIdle(RATE_LIMIT_IDLE_MS) }, RATE_LIMIT_SWEEP_MS)
  eviction.unref()
  server.once('close', () => { clearInterval(eviction) })

  const send = (res: ServerResponse, status: number, body: WireResponse<unknown>): void => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      ...securityHeaders(),
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  const refuse = (res: ServerResponse, code: TransportErrorCode): void => {
    send(res, STATUS[code] ?? 500, {
      ok: false,
      error: { code, message: MESSAGES[code] ?? MESSAGES[TransportErrorCode.INTERNAL] ?? 'Error.' },
    })
  }

  /**
   * R4. Refusals now reach the mutation log.
   *
   * Before this, a request refused for a bad Host, a foreign Origin, a missing token or a Funnel
   * header returned before `record` was ever called — so the compensating control recorded only the
   * requests that **passed every guard**, and the attacks it exists to make visible were the one
   * thing invisible in it.
   *
   * **A failed log write on a refusal does NOT escalate**, and that is a deliberate departure from
   * §7's "a failed log write fails the operation." the security review's reasoning, adopted: every record is an
   * `fsync`, so escalating here would turn a request flood into unbounded synchronous disk writes
   * and then into a self-inflicted outage — a denial of service handed to anyone who can send a bad
   * Host. The request was already being refused; failing it harder achieves nothing. The failure
   * goes to the local log instead, so a log that has stopped recording is still noticeable.
   *
   * It runs AFTER the rate limiter, so a flood is throttled before it can generate records at all.
   */
  const refuseAndRecord = async (
    req: IncomingMessage, res: ServerResponse, code: TransportErrorCode, route: string,
  ): Promise<void> => {
    const recorded = await options.mutationLog.record({
      timestamp: nowIso(),
      method: req.method ?? '',
      route,
      rootId: null,
      relativePath: null,
      sourceAddress: req.socket.remoteAddress ?? 'unknown',
      forwardedFor: headerValue(req, 'x-forwarded-for'),
      tailscaleUserLogin: headerValue(req, 'tailscale-user-login'),
      origin: headerValue(req, 'origin'),
      outcome: 'refused',
      code,
    })
    if (!recorded.ok) {
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: 'mutation-log',
        detail: `could not record a refusal (${code}): ${recorded.code}`,
      })
    }
    refuse(res, code)
  }

  /**
   * Opens a live-update stream, or refuses it.
   *
   * TWO CONTROLS, and they answer different questions — the security review required both be named here so nobody
   * later asks which is redundant:
   *
   *   - **the ticket** answers *is this caller authorized*;
   *   - **`Sec-Fetch-Site`** answers *is this browser being driven by our own page*.
   *
   * The ticket travels in the query string because `EventSource` cannot set a custom header, so the
   * token cannot ride the handshake at all. That is why the ticket is a **distinct value** from the
   * token (C4): a credential whose whole CSRF property is "it can only travel where an attacker
   * cannot reach" must not also exist in the most reachable place there is.
   *
   * The query string does not reach the mutation log — `routeNameFrom` splits on `?` before the name
   * is recorded, which is verified by test rather than by reading.
   */
  const openStream = async (
    req: IncomingMessage, res: ServerResponse, streams: StreamRegistry,
  ): Promise<void> => {
    const handshake = checkStreamHandshake(
      req.headers, options.guards.allowedOrigins, req.method ?? '',
    )
    if (!handshake.ok) {
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: 'stream', detail: handshake.refusal.reason,
      })
      await refuseAndRecord(req, res, handshake.refusal.code, STREAM_ROUTE)
      return
    }

    const presented = ticketFrom(req.url ?? '')
    // The branded result, not a boolean — so the value that reaches `open()` is provably the one
    // that was verified, rather than a string that happens to sit beside a successful check (K5).
    const ticket = presented === null ? null : options.sessions.verifyTicket(presented)
    if (ticket === null) {
      // One refusal for "no ticket" and "wrong ticket" alike. Distinguishing them would tell an
      // unauthenticated caller whether a value it tried was well-formed.
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: 'stream', detail: 'absent or unrecognised ticket',
      })
      await refuseAndRecord(req, res, TransportErrorCode.MISSING_TOKEN, STREAM_ROUTE)
      return
    }

    const opened = streams.open(req.headers, ticket, {
      write: chunk => res.write(chunk),
      end: () => { res.end() },
      // S3: the registry binds its own teardown through this, so a dead peer cannot hold a slot in
      // the cap. Both events — `close` fires on a clean disconnect, `error` on a broken one, and
      // binding only the first leaves the second leaking.
      onClose: listener => { res.on('close', listener); res.on('error', listener) },
    }, req.method ?? '')

    if (!opened.ok) {
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: 'stream', detail: opened.reason,
      })
      await refuseAndRecord(req, res, opened.code, STREAM_ROUTE)
      return
    }

    /**
     * THE TICKET IS NOW IN USE, AND MUST BE RELEASED WHEN THE STREAM ENDS — the security review's K6.
     *
     * Without this pair, `MAX_LIVE_TICKETS` is a one-way counter: every page load spends one, and
     * after the 64th the session route answers 500 forever. The client's recovery is 403-only by
     * design, so it never recovers — the app is dead until the process restarts, and it gets worse
     * the more the app is used. Proven by a test that made 64 sessions and asked for one more.
     *
     * Held rather than merely timestamped, because a stream can legitimately stay open for days on
     * an installed web app, and a ticket that expired underneath a live connection would be an
     * eviction — the thing B5 refused.
     *
     * Both events are bound, and the once-guard below is why that is safe — `release` is **not**
     * idempotent. This sentence used to claim it was, which is the retracted line an adversarial
     * review found still living in two places after it was recorded as fixed in one.
     */
    options.sessions.hold(ticket)

    /**
     * RELEASED EXACTLY ONCE PER STREAM, and the guard belongs here rather than in `release`.
     *
     * `release` decrements a **per-ticket** counter, so two events for one stream decrement twice.
     * With one stream per ticket that is masked by the `Math.max(0, …)` clamp; with two — which
     * `MAX_STREAMS_PER_CLIENT` permits, and which an adversarial review measured happening four at a
     * time over real HTTP — it drives the count to zero while a stream is still live. The ticket is
     * then eligible for the sweep and is deleted underneath a working connection, violating the one
     * thing K6 promised: *a ticket holding an open stream is never reclaimed.*
     *
     * `release` cannot fix this itself: a ticket legitimately holds several streams, so it has no way
     * to know which of them a call refers to. The identity of "this stream" exists only here.
     *
     * **MEASURED, because the reason this guard was added turned out to be wrong.** The claim was
     * that a broken connection fires both `close` and `error`. On Node 24 it does not: across RST and
     * FIN, and while writing continuously into a destroyed socket, **only `close` ever fires** on a
     * `ServerResponse` — a failed write reports through its callback, not through an `error` event.
     * So `res.on('error', …)` does not run on this path, and the guard **cannot currently be
     * provoked from outside**.
     *
     * It stays, and the reasoning is deliberate rather than defensive habit: the `error` binding is
     * correct to keep, a duplicate release corrupts the count irrecoverably, and the guard costs one
     * boolean. But it is **insurance, not a live control** — it is not proven to fire, because the
     * condition it guards cannot presently be produced. That is recorded here and in the review
     * record rather than dressed up with a black-box test that would pass for the wrong reason.
     */
    let releasedThisStream = false
    const releaseOnce = (): void => {
      if (releasedThisStream) return
      releasedThisStream = true
      options.sessions.release(ticket)
    }
    res.on('close', releaseOnce)
    res.on('error', releaseOnce)

    res.writeHead(200, streamHeaders())
    /**
     * FLUSH THE HEADERS NOW. Without this the stream is broken in a way that looks like a hang.
     *
     * Node buffers the head until the first body write, and an SSE response may legitimately write
     * nothing for fifteen seconds — until the first heartbeat. So the browser would sit with a
     * connection it does not yet consider open: `EventSource.onopen` never fires, the status line
     * reads "Connecting…" against a stream that is working, and the client's backoff never resets
     * because it resets only on a *confirmed* open.
     *
     * Caught by the test that asserts the handshake returns 200: it received an empty response from
     * a server that had already accepted the connection.
     */
    res.flushHeaders()

    /**
     * AN IMMEDIATE COMMENT LINE, and on Safari it is the difference between working and not.
     *
     * Measured, both engines, against the real server: with headers flushed but no body byte sent,
     * **WebKit's `EventSource` sits in `readyState 0` indefinitely** — it fires neither `onopen` nor
     * `onerror`. Chromium opens on the headers alone. Since this server writes nothing until the
     * first heartbeat, Safari would show "Connecting…" for up to fifteen seconds after *every*
     * connect, including every time the operator returns to the app.
     *
     * That is worse than cosmetic: the app spends its life reporting "not connected" while the
     * server considers it connected, on a phone that is repeatedly backgrounded.
     *
     * **AND THIS BYTE IS WHY THE CLIENT'S BACKOFF RULE HAD TO CHANGE.** This comment used to say the
     * backoff "resets only on a confirmed open", and cited that as part of the justification here.
     * A fifth review round measured what these two facts do together: writing on accept makes
     * `onopen` fire 1–2ms in, so "confirmed" became indistinguishable from "accepted" and the reset
     * ran on every attempt — a client reconnecting once a second forever against a path that accepts
     * and drops. Two files, three commits apart, each locally correct.
     *
     * The client now resets only on a stream that SURVIVES `STREAM_STABLE_MS`, so this byte is free
     * to mean exactly what it says: the connection was accepted. It is not evidence of anything
     * more, and nothing should be built on it as though it were.
     *
     * A comment line is the right payload: SSE ignores `:`-prefixed lines entirely, so this cannot
     * be mistaken for an event, and it doubles as the anti-buffering flush that proxies need.
     */
    res.write(': open\n\n')

    // No `res.end()`. The response stays open — that is the point — and the registry closes it.
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res)
    } catch (thrown) {
      // Not inspected for the RESPONSE — spec §6 bars stack traces and verbatim strings from the
      // wire. It is recorded locally, because an exception that reaches this outermost catch is by
      // definition one nothing else handled.
      await options.localLog.recordException('listener', thrown).catch(() => { /* last resort */ })
      failClosed(res)
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? ''
    const method = req.method ?? ''
    const remote = req.socket.remoteAddress ?? 'unknown'

    // URL length before anything reads it. Spec §6: URL 2 KB.
    if (Buffer.byteLength(target) > MAX_URL_BYTES) {
      refuse(res, TransportErrorCode.PAYLOAD_TOO_LARGE)
      return
    }

    // The rate limiter comes first and does NOT record. A flood must be throttled before it can
    // generate log records, or the record-keeping becomes the denial of service.
    if (!options.rateLimiter.take(remote)) {
      refuse(res, TransportErrorCode.RATE_LIMITED)
      return
    }

    /**
     * DUPLICATE SINGLETON HEADERS, on EVERY path — the security review's C7, 2026-08-07.
     *
     * It lived only inside `checkRequest`, and the asset route returns before `checkRequest` is
     * ever reached, so every GET for the shell and for every asset was served with no duplicate-
     * header check at all. **Proven by sending the input, not by reading the control:** a raw socket
     * carrying `Host: 127.0.0.1:47652` followed by `Host: evil.example` was answered `200 OK` on the
     * asset path, while the identical duplication on the API path was refused `400`.
     *
     * Node keeps the *first* `Host` and discards the rest, so a proxy that keeps the last disagrees
     * with us about who the request was addressed to — which is the foundation of request smuggling
     * and the reason `Content-Length` is on the same list.
     *
     * The bitter part: this control exists **because** the P2 review found `single()`'s array branch
     * was dead code — the policy said one value, the enforcement never ran. It was then recorded as
     * closed, proven on a path that does run it, while not running on the GET paths at all. Failure
     * #1 one layer over, inside the control added to fix failure #1.
     *
     * PLACEMENT — after the rate limiter, not before it, and this deviates from the ruling's letter
     * to keep its reasoning. The security review said "put it first, ahead of the limiter: no I/O and no logging,
     * so it cannot be turned into a flood amplifier." Refusing here without recording would strip
     * this refusal class out of the mutation log — which is exactly the R4 regression that hoisting
     * Host produced a day ago. So it records, and because it records it must sit behind the brake:
     * every record is an `fsync`, and an unthrottled recorded refusal is a denial of service handed
     * to anyone who can send two headers. Behind the limiter it satisfies both.
     */
    const noDuplicates = checkNoDuplicateHeaders(req.rawHeaders)
    if (!noDuplicates.ok) {
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: 'guards', detail: noDuplicates.refusal.reason,
      })
      await refuseAndRecord(req, res, noDuplicates.refusal.code, routeLabelFor(target))
      return
    }

    /**
     * THE REQUEST TARGET, for EVERY request. The fourth item in spec §7's Host bullet, and the one
     * that got left behind when the other three were hoisted.
     *
     * §7: *"Reject multiple `Host` headers, illegal bytes, missing Host, **and absolute-form request
     * targets**."* Four things, one sentence. Duplicates, Host and the Funnel header were all moved
     * into this prologue; `checkRequestTarget` stayed inside `checkRequest`, which the stream and
     * asset branches both return before.
     *
     * Measured against the shipped binary before this moved:
     *
     *     GET http://evil/ HTTP/1.1        -> 200 OK, the app shell
     *     GET //evil/ HTTP/1.1             -> 200 OK, the app shell
     *
     * `asset-map.ts`'s deep-link rule is what serves it: an authority with no dot in it looks like an
     * in-app route, so it resolves to the shell. The exposure is a target/Host disagreement in front
     * of a reverse proxy, which is precisely what the spec bullet exists to refuse.
     *
     * **The lesson is the placement, not the check.** A control hoisted out of a chain leaves its
     * siblings behind unless someone checks the whole sentence it came from. That is the second time
     * in three commits: the Funnel status gate moved and left its header gate; this prologue moved
     * three of four and left the fourth.
     */
    const targetOk = checkRequestTarget(target)
    if (!targetOk.ok) {
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: 'guards', detail: targetOk.refusal.reason,
      })
      await refuseAndRecord(req, res, targetOk.refusal.code, routeLabelFor(target))
      return
    }

    // HOST, for EVERY request including static ones. Spec §7: "Host validation is the first
    // operation, default-deny." `checkRequest` re-checks it for the API path, which is redundant
    // and cheap; skipping it here would leave the asset path as the one door that does not.
    const hostOk = checkHost(req.headers, options.guards.allowedHosts)
    if (!hostOk.ok) {
      // Recorded, not merely refused. R4 made guard-layer refusals reach the mutation log so the
      // attacks are visible in it, and hoisting this check above the asset route would otherwise
      // have quietly moved the most common refusal back out of the record — the reason goes to the
      // local log, the stable code to the mutation log, and neither to the wire.
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: 'guards', detail: hostOk.refusal.reason,
      })
      // `routeLabelFor`, like the other four prologue refusals. This one was left behind when the
      // helper landed — and `listener.ts` calls a Host failure "the most common refusal", so the
      // record's most frequent entry was the one carrying a different label AND a different
      // fallback (`(unrouted)` against `(static)`). Two spellings for one thing is exactly what
      // stops the log being groupable by route, which is the R4 property the helper exists for.
      // Third time in this file that hoisting a control has stranded one of its siblings.
      await refuseAndRecord(req, res, hostOk.refusal.code, routeLabelFor(target))
      return
    }

    /**
     * THE FUNNEL GATE — **both mechanisms**, before anything is served, including the shell.
     *
     * Spec §7 requires *two independent* mechanisms, "enforced, not asserted in prose", because
     * "one mistyped command otherwise puts the app on the public internet with zero auth".
     *
     * The status gate below used to stand here alone. It was hoisted above the asset route after the
     * bootstrap test caught that an `unknown` status still served the client — the app's shell handed
     * to the public internet while the control designed to prevent exactly that sat two branches
     * lower. **Its companion header gate was left behind**, and a fifth review round measured the
     * consequence: `GET /` carrying `Tailscale-Funnel-Request` answered **200 with the shell**, while
     * the same header on `/api/*` and `/events` was correctly refused.
     *
     * So the static path had **zero** of the two. The header check reached it from nowhere —
     * `checkRequest` and `checkStreamHandshake` are its only callers and the asset branch returns
     * before both — and the status check is fed `funnelProbe: async () => false` in `main.ts`, so in
     * the shipped binary it can only ever report a confirmed "off". One inert, one absent.
     *
     * Both now sit here, adjacent, above every branch that serves anything. The adjacency is
     * deliberate: the failure was that they drifted apart, one moving and one staying, and nothing
     * about their placement said they were a pair.
     */
    if (options.privilege === 'tailnet') {
      // `req.headers`, not `rawHeaders` — a presence check, and Node joins repeats into one value,
      // which is still present. A forged duplicate cannot hide the header.
      const notFunnel = checkNotFunnel(req.headers)
      if (!notFunnel.ok) {
        await options.localLog.write({
          timestamp: nowIso(), level: 'warn', at: 'guards', detail: notFunnel.refusal.reason,
        })
        // `routeNameFrom` returns null for `/events`, so this recorded a Funnel refusal on the
        // stream route as `(static)` once the gate moved up here — the compensating control
        // mislabelling the very requests it exists to make visible. Named explicitly instead.
        await refuseAndRecord(req, res, notFunnel.refusal.code, routeLabelFor(target))
        return
      }
    }

    if (options.privilege === 'tailnet' && !options.funnelWatch.tailnetTrafficPermitted()) {
      await refuseAndRecord(req, res, options.funnelWatch.status() === 'on'
        ? TransportErrorCode.FUNNEL_REFUSED
        : TransportErrorCode.FUNNEL_STATUS_UNKNOWN, routeLabelFor(target))
      return
    }

    /**
     * THE LIVE-UPDATE STREAM — **before the asset route**, and that ordering is the security review's C8 rather
     * than taste.
     *
     * `/events` is only kept away from the asset map by a constant in `asset-map.ts`. If that
     * constant is ever edited, `resolveAsset('/events')` finds no key, sees no dot in the path, and
     * **serves the shell with 200** — and an `EventSource` handed `200 text/html` fails in a way
     * that looks like a client bug for as long as anyone cares to look. Placing the branch above the
     * asset route removes the coupling instead of documenting it.
     *
     * It sits after duplicate-headers, the rate limiter, Host and the Funnel gate — all of which are
     * above this line — so it inherits them by position. The security review named that inheritance-by-line-number
     * as the Funnel-gate bug's own shape, and the answer is that this branch carries its *own*
     * handshake guard rather than relying on what happens to precede it.
     */
    if (options.privilege === 'tailnet' && options.streams !== undefined && streamPathFrom(target)) {
      await openStream(req, res, options.streams)
      return
    }

    /**
     * `GET /file` — §9's byte endpoint.
     *
     * **Above the asset route**, for the reason the security review gave for putting `/events` there: the asset
     * map only fails to claim a path because no key matches it, and `resolveAsset` answers an
     * unmatched dotless path with **the shell, 200**. An `<img>` handed the app's HTML fails in a
     * way that looks like a broken image for as long as anyone cares to look. Placing the branch
     * above removes the coupling instead of documenting it.
     *
     * It inherits the prologue above — duplicate headers, the rate limiter, Host, the Funnel gate —
     * and carries its own credential check, its own headers and its own refusals, because a GET
     * that returns bytes shares nothing else with the API funnel.
     */
    if ((method === 'GET' || method === 'HEAD') && isFileRequest(target)) {
      if (options.fileRoute === undefined) {
        refuse(res, TransportErrorCode.NOT_FOUND)
        return
      }
      await serveFile(req, res, options.fileRoute)
      return
    }

    // STATIC ASSETS. Deliberately not behind the CSRF guards, and the reasoning matters because it
    // looks like a weakening: those guards stop a cross-origin page *commanding* the app, and they
    // require a token that a `<script src>` or a stylesheet link cannot send. Applying them here
    // would make the app unable to load its own shell.
    //
    // What protects this path instead is that there is nothing to command — a GET against an
    // in-memory map that mutates nothing and reads no file — and it is now behind both Host
    // validation and the Funnel gate above.
    if (options.assets !== undefined && (method === 'GET' || method === 'HEAD')) {
      const resolved = resolveAsset(options.assets, target)
      if (resolved.kind === 'asset' || resolved.kind === 'shell') {
        res.writeHead(200, assetHeaders(resolved.asset))
        // HEAD gets the headers and no body — a body on a HEAD is a protocol violation that some
        // proxies turn into a desynchronised connection.
        res.end(method === 'HEAD' ? undefined : resolved.asset.body)
        return
      }
      if (resolved.kind === 'not-found') {
        refuse(res, TransportErrorCode.NOT_FOUND)
        return
      }
      // `reserved` falls through to the API path below, which will refuse a GET on method policy.
    }

    /**
     * THE ROUTE NAME, RESOLVED EXACTLY ONCE — the security review's B1.
     *
     * It used to be recomputed at each of six call sites. That was harmless while every route
     * required the token; it stops being harmless the moment the name decides **which guard chain
     * runs**, because two derivations of an attacker-supplied string are two chances to disagree —
     * one selecting the weaker chain and the other selecting the handler.
     *
     * So: one derivation, and the same value feeds the auth decision, the refusal record and the
     * dispatch. `routeRequiresToken` answers `true` for `null` and for any unknown name, so the
     * default is deny and the exemption is a fact about the route table rather than a comparison
     * here.
     */
    const name = routeNameFrom(target)
    const requiresToken = routeRequiresToken(name)

    const guard = checkRequest(
      req.headers, method, target, options.guards, req.rawHeaders, requiresToken,
    )
    if (!guard.ok) {
      // The refusal reason goes to the LOCAL log — it names which guard fired, which the wire must
      // never say. The mutation log gets the stable code only.
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: 'guards', detail: guard.refusal.reason,
      })
      await refuseAndRecord(req, res, guard.refusal.code, name ?? '(unrouted)')
      return
    }

    if (name === null) {
      await refuseAndRecord(req, res, TransportErrorCode.NOT_FOUND, '(unrouted)')
      return
    }

    // The body is read only after every header-level guard has passed — spec §7 requires the 415
    // "before body parsing", and the same reasoning applies to all of them: nothing is read from a
    // request we have already decided to refuse.
    /**
     * **The cap depends on the route**, because one of them carries a document. Read at
     * `MAX_BODY_BYTES` for everything, a file between 1 MB and the 2 MiB editable cap is editable
     * and unsavable — FT-3, found by the end-to-end chain test on its first complete run. See
     * `bodyCapFor`.
     */
    const body = await readJsonBody(req, {
      maxBytes: bodyCapFor(name),
      contentLength: req.headers['content-length'],
    })
    if (!body.ok) {
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: `body:${name}`, detail: body.reason,
      })
      await refuseAndRecord(req, res, body.code, name)
      return
    }

    const outcome = await router.dispatch(name, method, body.value)

    // R3. Everything the wire is forbidden to say goes here instead. Without this a 500 in
    // production left no trace anywhere, which made an incident that manifested as an exception
    // undetectable — the thing the mutation log exists to prevent, one layer over.
    if (outcome.thrown !== undefined) {
      await options.localLog.recordException(`route:${name}`, outcome.thrown)
    } else if (outcome.failure !== undefined) {
      await options.localLog.write({
        timestamp: nowIso(), level: 'warn', at: `validate:${name}`,
        detail: `${outcome.failure.at}: ${outcome.failure.detail}`,
      })
    }

    // Spec §7: "A failed log write fails the operation." So the record is written BEFORE the
    // response, and a failure to record turns a success into a 500. A log that silently stops
    // recording converts "no incident" from an observation into an assumption.
    const logged = await options.mutationLog.record({
      timestamp: nowIso(),
      method,
      route: name,
      ...subjectOf(body.value),
      sourceAddress: remote,
      forwardedFor: headerValue(req, 'x-forwarded-for'),
      tailscaleUserLogin: headerValue(req, 'tailscale-user-login'),
      origin: headerValue(req, 'origin'),
      outcome: outcome.response.ok ? 'ok' : 'refused',
      code: outcome.response.ok ? null : outcome.response.error.code,
    })
    if (!logged.ok) {
      // The refusal path already records its own log failure to the local log; this path did not,
      // so a mutation log that could not be written — full, or unwritable — produced a 500 with no
      // trace anywhere. That is the unobservable failure the local log exists to end.
      await options.localLog.write({
        timestamp: nowIso(), level: 'error', at: 'mutation-log',
        detail: `could not record ${name}: ${logged.code}${logged.detail === undefined ? '' : ` — ${logged.detail}`}`,
      })
      refuse(res, TransportErrorCode.INTERNAL)
      return
    }

    send(res, outcome.status, outcome.response)
  }

  return server
}

/** One header value, or null. Arrays are refused rather than joined — see `guards.ts`. */
function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  return null
}
