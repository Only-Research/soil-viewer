/**
 * The live-update stream. Spec §15.
 *
 * **Server-Sent Events, named explicitly in the spec "so nobody reaches for `setInterval`."** One
 * stream, server to client. The client half — reconnect backoff, and the unconditional teardown on
 * regaining visibility that iOS makes necessary — belongs to P3; this is the server side.
 *
 * TWO THINGS THAT ARE NOT OPTIONAL, both from spec §15:
 *
 * 1. **`Origin` is validated on every connection.** SSE and WebSocket handshakes are **not covered
 *    by CORS**, which makes them the classic hole — a cross-origin page can open an `EventSource`
 *    and read everything it emits, and no preflight ever happens to stop it. This is also one of
 *    the security review's four binding conditions in §7. The guards this uses are the same ones the request path
 *    uses, deliberately: a second implementation is a second thing to get wrong.
 *
 * 2. **The queue is bounded, and overflow emits `resync` rather than buffering.** An unbounded
 *    queue behind a phone that has gone to sleep is a memory leak with a timer attached. Telling
 *    the client "you are behind, refetch" is both cheaper and more honest than pretending a
 *    delivery order that no longer exists.
 *
 * Limits are F8.4: 4 streams per client, 32 total, 15s heartbeat, ≤250ms batching.
 */

import { TransportErrorCode } from '../contract/wire'
import { securityHeaders } from './csp'
import { checkStreamHandshake, type RawHeaders } from './guards'
import type { VerifiedTicket } from './session'

export const MAX_STREAMS_TOTAL = 32

/**
 * Streams one client may hold. **Keyed on the TICKET, not on an address** — the security review's C9.
 *
 * It was `MAX_STREAMS_PER_ADDRESS`, keyed on `socket.remoteAddress`, and behind `tailscale serve`
 * every tailnet device arrives on a fresh loopback connection — the fact this build's whole
 * privilege model rests on. So the per-client cap was a **global cap of four**, `MAX_STREAMS_TOTAL`
 * was unreachable by construction, and the fifth stream anywhere was refused. That presents as *"the
 * app randomly stops updating on one device"*, which is the hardest failure to diagnose and the one
 * §15 spends the most words on.
 *
 * **THIS CAP IS LIVE. IT FIRES. A previous version of this comment said it could not, and that was
 * measured false by two independent adversarial reviews** — four concurrent streams on a single
 * ticket over real HTTP, `countFor` reading 4, the fifth refused right here.
 *
 * The retracted claim was: *"C6 made a ticket per connect attempt rather than per page load, so no
 * two streams can share one and `perClient` never exceeds 1."* The error is worth naming exactly,
 * because it is not a typo. **That is a property of the CLIENT asserted as a property of the
 * SERVER.** `session.ts` mints a fresh ticket per connect, so an honest browser never presents one
 * twice — but nothing here consumes a ticket on use. `verifyTicket` compares; `hold` increments
 * without limit. Any caller that chooses to reuse one, can. It is the same mistake as
 * `MAX_STREAMS_PER_ADDRESS` run backwards: reasoning about who *would* call rather than who *can*.
 *
 * Two consequences follow, and both were being recorded the wrong way round:
 *
 * The multi-stream accounting in `session.ts` — `openStreams`, the once-guard in `listener.ts`, the
 * clamp — is **reachable today**, not latent machinery kept for a hypothetical. It is load-bearing.
 *
 * And the open question for the security review is **not** "this control died, what should replace it". It is
 * that a ticket is free to mint from an unauthenticated route, so no cap keyed on a ticket can
 * provide per-client fairness however it is sized — the same gap as the ungoverned mint rate in
 * `session.ts`. Both go to them together, on that premise rather than the false one.
 *
 * The rate limiter and the connection cap are keyed on the address still. Those are pinned, ruled,
 * and fixed in one pass with a single answer to "what identifies a client behind the proxy" — see
 * `the review's record-update notes` items 14, 15 and 22.
 */
export const MAX_STREAMS_PER_CLIENT = 4
export const HEARTBEAT_MS = 15_000
export const BATCH_MS = 250
/** Events held for one client before it is told to resync instead. */
export const MAX_QUEUED_EVENTS = 128

/**
 * How long a stream may refuse to drain before it is closed. The security review's C10.
 *
 * `MAX_QUEUED_EVENTS` bounds what is held *before* writing. Once written, an event moves into Node's
 * socket buffer, which is **unbounded when the peer is not draining** — so the queue bound was
 * applied one layer above the leak. This module's own header calls an unbounded queue behind a
 * sleeping phone "a memory leak with a timer attached", and §15 names a sleeping phone as the
 * NORMAL case.
 *
 * Closing is the right answer rather than waiting indefinitely: the client reconnects and refetches,
 * which §15 already requires on every connection, so nothing is lost that would have survived.
 */
export const BACKPRESSURE_GRACE_MS = 5_000

export interface StreamEvent {
  readonly type: string
  readonly data: unknown
}

/**
 * What a stream writes to. An interface so the registry is testable without a socket.
 *
 * `onClose` is REQUIRED rather than optional, and that is the security review's S3 made structural. Nothing closed
 * a stream when its socket died: dead streams stayed in the map, `broadcast` wrote to ended sinks
 * forever, and the 32-slot cap filled with corpses. The fix could have been a line in the route that
 * binds `res.on('close')` — but a guarantee that depends on a caller remembering is the shape that
 * has failed in this build repeatedly. A required field makes the compiler the one who remembers.
 */
export interface StreamSink {
  readonly write: (chunk: string) => boolean
  readonly end: () => void
  /** Registers a listener for the peer going away. Called with no arguments, possibly more than once. */
  readonly onClose: (listener: () => void) => void
}

export interface StreamHandle {
  readonly id: number
  readonly clientKey: string
  readonly close: () => void
}

export interface StreamRegistryOptions {
  readonly allowedOrigins: ReadonlySet<string>
  /**
   * Where a dropped or discarded event goes. The security review's S5.
   *
   * Required, not optional. Dropping a malformed frame is correct — it was asked for — but an event
   * vanishing with no trace is R3's lesson reappearing in the event channel: a 500 in production
   * that left no record anywhere made an incident undetectable. The caller routes this to the local
   * log, never to the wire.
   */
  readonly onDropped: (reason: string, detail: string) => void
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export type OpenResult =
  | { readonly ok: true; readonly handle: StreamHandle }
  | { readonly ok: false; readonly code: TransportErrorCode; readonly reason: string }

interface Stream {
  readonly id: number
  readonly clientKey: string
  readonly sink: StreamSink
  queued: StreamEvent[]
  overflowed: boolean
  batchTimer: unknown
  /** Set when the peer stopped draining. Nothing further is written; a close is already scheduled. */
  backpressured: boolean
  graceTimer: unknown
}

/**
 * Event types are constrained to this shape, and an event failing it is dropped rather than framed.
 *
 * the security review's P2 review, condition 5. `data` was correctly inert — JSON-encoded, so a filename carrying
 * a newline survives as escaped characters and the frame structure holds. **`type` was interpolated
 * raw**, and one `broadcast` with a crafted type produced TWO events:
 *
 *   broadcast({ type: 'x\ndata: {"forged":true}\n\nevent: injected', data: { a: 1 } })
 *
 * Nothing external supplies a type in P2, so it was latent — but P3 and P4 broadcast change events
 * whose type may be derived from something, and this is a five-minute fix now against a hunt later.
 */
const EVENT_TYPE = /^[a-z][a-z0-9-]*$/

/** SSE framing. `data` is JSON so a newline in a value cannot terminate the event early. */
function frame(event: StreamEvent): string | null {
  if (!EVENT_TYPE.test(event.type)) return null
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
}

export type StreamRegistry = ReturnType<typeof createStreamRegistry>

export function createStreamRegistry(options: StreamRegistryOptions) {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as never) })

  const streams = new Map<number, Stream>()
  let nextId = 1

  const perClient = (clientKey: string): number =>
    [...streams.values()].filter(s => s.clientKey === clientKey).length

  const close = (id: number): void => {
    const stream = streams.get(id)
    if (stream === undefined) return
    if (stream.batchTimer !== null) clearTimer(stream.batchTimer)
    if (stream.graceTimer !== null) clearTimer(stream.graceTimer)
    streams.delete(id)
    stream.sink.end()
    // The heartbeat exists only while there is something to keep alive. See `ensureHeartbeat`.
    if (streams.size === 0) stopHeartbeat()
  }

  /**
   * Writes, and treats a refusal to drain as the bounded-memory event it is. The security review's C10 / S1.
   *
   * `sink.write()`'s boolean was discarded at all three call sites, so `MAX_QUEUED_EVENTS` bounded
   * the queue while Node's socket buffer grew without limit behind a peer that had stopped reading.
   * Every write that carries EVENT DATA goes through here, which is the point: three call sites
   * each remembering to check a return value is three chances to forget.
   *
   * Not literally every byte on the socket: `listener.ts` writes the `: open

` handshake comment
   * directly, before the registry is involved. That is eight bytes immediately after the headers,
   * where backpressure cannot yet exist, and it is outside this rule by design rather than by
   * oversight — but the sentence used to say "every write", which was false and is the kind of
   * overstatement a later reader would rely on.
   */
  const writeTo = (stream: Stream, chunk: string): void => {
    if (stream.backpressured) return
    if (stream.sink.write(chunk)) return

    stream.backpressured = true
    options.onDropped(
      'backpressure',
      `stream ${stream.id} stopped draining; closing in ${BACKPRESSURE_GRACE_MS}ms`,
    )
    // Nothing further is written to this stream. It is closed after a bounded grace rather than
    // immediately, so a brief stall does not cost a reconnect — but the grace is what makes the
    // memory bounded, so it is a constant and not a retry loop.
    stream.graceTimer = setTimer(() => { close(stream.id) }, BACKPRESSURE_GRACE_MS)
  }

  const flush = (stream: Stream): void => {
    stream.batchTimer = null
    if (stream.overflowed) {
      // Spec §15: on overflow emit `resync` rather than buffering without limit. The queue is
      // dropped — replaying a prefix of a lost sequence is worse than admitting the gap, because
      // the client would believe it was caught up.
      const discarded = stream.queued.length
      stream.queued = []
      stream.overflowed = false
      options.onDropped('overflow', `discarded ${discarded} queued events for stream ${stream.id}`)
      const resync = frame({ type: 'resync', data: { reason: 'queue overflow' } })
      if (resync !== null) writeTo(stream, resync)
      return
    }
    const batch = stream.queued
    stream.queued = []
    for (const event of batch) {
      const framed = frame(event)
      // Dropped, not written raw and not written half-escaped. A malformed type is a programming
      // error on our side, and emitting it anyway is how it becomes an injection — and it is now
      // RECORDED, because an event vanishing silently is the thing R3 was about.
      if (framed === null) {
        options.onDropped('malformed-type', `refused to frame an event of type ${JSON.stringify(event.type)}`)
        continue
      }
      writeTo(stream, framed)
    }
  }

  const scheduleFlush = (stream: Stream): void => {
    if (stream.batchTimer !== null) return
    stream.batchTimer = setTimer(() => { flush(stream) }, BATCH_MS)
  }

  /**
   * THE HEARTBEAT, wired. The security review's C11 / S2.
   *
   * `HEARTBEAT_MS` was declared and read nowhere, and `heartbeat()` was called by nothing — the
   * third limit in this build that existed only as a number, after R5's connection cap and R6's
   * idle eviction. §15 requires it, and it is not decoration: it is what stops a proxy or a phone
   * silently dropping a connection that has simply been quiet.
   *
   * The registry owns the timer rather than exposing `heartbeat()` for a caller to schedule,
   * because "the caller will remember" is how it came to be called by nothing. It runs only while
   * at least one stream is open, so an idle server holds no timer and a test that opens no stream
   * leaves nothing pending.
   */
  let heartbeatTimer: unknown = null

  const stopHeartbeat = (): void => {
    if (heartbeatTimer === null) return
    clearTimer(heartbeatTimer)
    heartbeatTimer = null
  }

  const beat = (): void => {
    // A comment line, which SSE ignores but proxies and phones do not.
    for (const stream of streams.values()) writeTo(stream, ': heartbeat\n\n')
    heartbeatTimer = streams.size === 0 ? null : setTimer(beat, HEARTBEAT_MS)
  }

  const ensureHeartbeat = (): void => {
    if (heartbeatTimer !== null) return
    heartbeatTimer = setTimer(beat, HEARTBEAT_MS)
  }

  return {
    /**
     * Opens a stream, or refuses. Origin is checked here rather than by the caller, because a
     * caller that can forget is a caller that eventually does — and this is the handshake CORS
     * does not cover.
     */
    open: (
      headers: RawHeaders, clientKey: VerifiedTicket, sink: StreamSink, method: string,
    ): OpenResult => {
      /**
       * ONE implementation of the handshake rule, shared with the listener — the security review's C1.
       *
       * This used to call `checkOrigin` directly, and that was **wrong once C1 landed**: a
       * same-origin `EventSource` sends no `Origin` at all, so the app's own stream was refused
       * here even after the listener had correctly allowed it. The control existed in two places
       * with two different rules, which is the thing this module's own header warns against —
       * *"a second implementation is a second thing to get wrong."*
       *
       * The listener checks this too, before the ticket, so a refusal is logged with its reason and
       * nothing is allocated. That redundancy is deliberate and cheap: `open()` is the function a
       * future caller might reach for directly, and a guarantee that holds only because of who
       * happens to call it is not a guarantee.
       */
      // REQUIRED, not defaulted. It defaulted to `'GET'` for one commit, which is the
      // reachable-by-omission shape this build has been bitten by repeatedly — a caller that forgets
      // gets a free pass at the exact check that exists to refuse them. `requiresToken` defaults to
      // the SAFE value; a method default can only ever be the permissive one, so there must not be
      // one. Every caller now states the verb it actually received.
      const handshake = checkStreamHandshake(headers, options.allowedOrigins, method)
      if (!handshake.ok) {
        return { ok: false, code: handshake.refusal.code, reason: handshake.refusal.reason }
      }

      if (streams.size >= MAX_STREAMS_TOTAL) {
        return { ok: false, code: TransportErrorCode.RATE_LIMITED, reason: 'too many streams' }
      }
      if (perClient(clientKey) >= MAX_STREAMS_PER_CLIENT) {
        return { ok: false, code: TransportErrorCode.RATE_LIMITED, reason: 'too many streams for this client' }
      }

      const id = nextId++
      streams.set(id, {
        id, clientKey, sink, queued: [], overflowed: false,
        batchTimer: null, backpressured: false, graceTimer: null,
      })

      // S3: the registry binds its own teardown rather than trusting the route to do it. A stream
      // whose peer has gone but whose entry remains is a slot in a 32-slot cap held by a corpse,
      // and `broadcast` writing to an ended sink forever.
      sink.onClose(() => { close(id) })

      ensureHeartbeat()
      return { ok: true, handle: { id, clientKey, close: () => { close(id) } } }
    },

    /** True when a type is framable. Exposed so a caller can fail loudly rather than lose an event. */
    isValidEventType: (type: string): boolean => EVENT_TYPE.test(type),

    /** Queues an event for every open stream. Delivery is batched — spec §15's ≤250ms. */
    broadcast: (event: StreamEvent): void => {
      for (const stream of streams.values()) {
        if (stream.queued.length >= MAX_QUEUED_EVENTS) {
          stream.overflowed = true
        } else {
          stream.queued.push(event)
        }
        scheduleFlush(stream)
      }
    },

    /**
     * Spec §15's 15s heartbeat, exposed for tests to drive deterministically.
     *
     * The registry schedules this itself while any stream is open — see `ensureHeartbeat`. It stays
     * public so a test can beat on demand rather than waiting fifteen real seconds, which is the
     * kind of test that goes flaky and then gets deleted.
     */
    heartbeat: beat,

    /** Stops the heartbeat and closes every stream. For shutdown, so no timer outlives the server. */
    stop: (): void => {
      for (const id of [...streams.keys()]) close(id)
      stopHeartbeat()
    },

    close,
    size: () => streams.size,
    countFor: perClient,
  }
}

/**
 * Every header an SSE response carries — **including the shared security set**. The security review's C11 / S6.
 *
 * It used to return only the stream-specific headers, with a comment telling the caller to add
 * `securityHeaders()` itself. `assetHeaders()` one module over spreads them, so the two response
 * builders disagreed about whose job it was, and a `text/event-stream` response is the response
 * class where a missing `nosniff` is most interesting. The comment is now a spread.
 *
 * The stream's own `cache-control` wins over the spread — the same precedence `assetHeaders` uses.
 */
export function streamHeaders(): Readonly<Record<string, string>> {
  return {
    ...securityHeaders(),
    'content-type': 'text/event-stream',
    // `no-store` rather than `no-cache`: spec §15 requires an explicit Cache-Control on every
    // response, because with none stated Safari applies heuristic caching and pins a stale shell
    // on an installed web app — permanently, since the app never relaunches to notice.
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Defeats proxy buffering, which otherwise holds events until a buffer fills and makes a live
    // stream arrive in silent bursts.
    'x-accel-buffering': 'no',
  }
}
