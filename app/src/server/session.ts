/**
 * The session store: what `POST /api/session.start` hands out, and what the stream route checks.
 *
 * Two credentials, deliberately distinct — the security review's C4:
 *
 *   - **the token**, which travels only in the `x-soil-token` header. Its entire CSRF property is
 *     that a custom header cannot be set cross-origin. The moment the same value authenticates from
 *     a query string, that property is void for every route that accepts it there.
 *   - **the ticket**, which travels only in the live-stream URL's query string. `EventSource` cannot
 *     set a custom header, so the token cannot ride the handshake at all — measured, not assumed.
 *
 * They are handed out together and are obtained by the same authorization, which is the amended
 * form of the security review's C4(b): *the ticket is obtainable only through the same authorization that yields
 * the main token, and never through a weaker one.* Their original wording said the ticket required the
 * token; the bootstrap route makes that false, and they amended it rather than let a future reader
 * quote a property no longer delivered.
 *
 * **The ticket is reusable, and the server must allow it.** `EventSource` reconnects on its own,
 * reusing the URL verbatim — measured across four reconnects in both engines, and again on the operator's
 * iPhone through `tailscale serve`. A server that consumed a ticket on use would fail on the first
 * automatic reconnect. Nothing here binds a ticket to one stream; several can share one, and an
 * adversarial review measured four doing so.
 *
 * **And yet a spent ticket is reclaimed immediately** (see `release`). Both are true, and the
 * resolution lives in a different file, which is why it is written here: `live-stream.ts` calls
 * `close()` in its `onerror`, which cancels the browser's automatic reconnect, and then connects
 * again with a **fresh** ticket. So this client never presents a spent one — not because it cannot,
 * but because it chooses not to.
 *
 * **That coupling is load-bearing and cross-file.** If the client ever stops closing on error, the
 * browser's own reconnect will present a ticket this store has already reclaimed, and the stream
 * will be refused once before the client recovers. Degradation, not a brick — but it is the kind of
 * dependency that gets broken by someone who never reads this file, so it is stated rather than
 * assumed. A third adversarial review found these two paragraphs contradicting each other outright.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

import { RATE_LIMIT_GLOBAL_BURST, RATE_LIMIT_GLOBAL_PER_SECOND } from './limits'

/**
 * How long a ticket with **no open stream** is kept before it can be reclaimed. The security review's K6.
 *
 * **This constant exists because `MAX_LIVE_TICKETS` alone was a brick.** B5 required a named bound
 * and exhaustion that refuses rather than evicts; all of that was implemented exactly. What it did
 * not require was that the bound be *reclaimable* — and `release` was exported and called by nothing,
 * so the counter only ever rose. Every page load spent one. **After the 64th, the route answered 500
 * forever**, and the client's recovery is 403-only by design, so it never recovered: the app was dead
 * until the process restarted, and it got worse the more the app was used.
 *
 * **This window covers exactly one gap: mint → the `EventSource` actually connecting.** That is
 * milliseconds to a second or two, so a minute is generous. It was **ten** minutes, which was sized
 * as though a ticket lasted a page load — and after C6 that made every reconnect occupy a slot for
 * ten minutes, which is what exhausted the pool during ordinary window-switching.
 *
 * **A ticket whose stream has ENDED needs no grace at all** and is reclaimed immediately — see
 * `release`. Its stream is over and the client that owned it always fetches a fresh one for its next
 * attempt (C6), so it will never be presented again.
 *
 * **What that does and does not buy, stated precisely** — the earlier wording here claimed the live
 * count "tracks concurrent streams rather than cumulative connects", and a third adversarial round
 * showed it does not. It tracks *mints, with a one-minute memory*: a ticket that is minted and then
 * used is reclaimed the moment its stream ends, but a ticket that is minted and **never** used waits
 * out this whole window, because nothing has finished. So the reclaim removes the cost of *ordinary
 * use*, which was the exhaustion, and leaves the cost of *minting* — which is what the bound below
 * is now derived against.
 *
 * A ticket holding an open stream is **never** reclaimed however old it is — an installed web app can
 * legitimately hold one for days. Exhaustion still refuses rather than evicting, so an attacker
 * cannot choose whose session dies.
 */
export const TICKET_IDLE_MS = 60 * 1000

/**
 * How many tickets may be live at once. The security review's B5.
 *
 * The bootstrap route is reachable **with no credential**, and it allocates on every call. Unbounded,
 * that is a memory-growth denial of service from anything that can reach the listener.
 *
 * **Exhaustion refuses a NEW bootstrap rather than evicting an old ticket**, and that direction is
 * the whole condition. Evicting would let a flood knock out the streams of clients already
 * connected — worse than the address-keyed cap it replaced, because it would be an attacker
 * *choosing* whose connection dies. Refusing new ones degrades to "a new tab cannot connect", which
 * is visible and recoverable.
 *
 * It was 64, *"sized above `MAX_STREAMS_TOTAL` so the stream cap is the binding constraint"* — true
 * while a ticket lasted a page load, made false by C6, and it exhausted in **568 seconds** for a
 * user with a healthy stream returning to the app every nine seconds. Then it was 1024, picked in
 * isolation, and a third round did the arithmetic nobody had done: at a one-minute window the pool
 * drains about **17 mints a second** while the only control in front of this route permits **50** —
 * three times the fill rate. A client stuck in a retry loop, no attacker required, would take
 * `session.start` to 500 for every device.
 *
 * **DERIVED, because two independent numbers with an unstated relationship is how both of those
 * happened.** Sized above everything the limiter can deliver inside one idle window, plus the burst
 * allowance and a margin. Changing either input now moves this with it.
 *
 * **Which makes the rate limiter the binding control, and this a memory ceiling.** Said plainly so
 * no later reader cites it as a request bound it is not. It is not unreachable-by-construction — it
 * becomes live again the moment the limiter is loosened, which is exactly when a backstop earns its
 * place. A ticket is a 32-character string in a `Map`; a few thousand is a few hundred kilobytes.
 *
 * That the mint rate is unauthenticated and ungoverned *per client* is a real gap, and it is the
 * same question as per-client stream fairness. Both go to the security review together rather than being answered
 * here by whoever happened to notice.
 */
export const MAX_LIVE_TICKETS =
  RATE_LIMIT_GLOBAL_PER_SECOND * (TICKET_IDLE_MS / 1000) + RATE_LIMIT_GLOBAL_BURST + 256

/** 16 bytes as hex — the same shape and generator as the request token. */
const CREDENTIAL_BYTES = 16
const CREDENTIAL_SHAPE = /^[0-9a-f]{32}$/

/**
 * THE KEYING RULE. Written once, here, and cited rather than restated everywhere else — the security review's K1.
 *
 * > **A client is identified by the strongest identity that has already been VALIDATED at the point
 * > the control fires — and an unvalidated value may only ever NARROW an allowance, never widen one.
 * > A control that fires before anything is validated does not get to claim per-client scope: it
 * > keeps its unconditional brake, is named for what it actually is, and is sized for what it
 * > actually covers.**
 *
 * The test that decides which side of it a value falls on is not "is this a cap or an
 * authorization?" — those are not opposites. It is:
 *
 * > **Does presenting a different value ever get the caller more than presenting none?**
 *
 * If yes, it is authorization whatever it is called, because a fresh budget is a capability. A
 * mutation-log field passes that test (a record grants nothing). A rate-limit key does not.
 *
 * Applied to this build's three controls, the rule produces all three keys with no further judgement
 * — which is the point, since three independent judgements is how one of them stays wrong:
 *
 *   - **the connection cap** fires on a socket event, before any HTTP exists → no identity → global.
 *   - **the rate limiter** fires ahead of the guard chain, deliberately → nothing validated yet →
 *     global. See `limits.ts` for why re-keying it would be strictly worse than sharing.
 *   - **the stream cap** fires after `verifyTicket` → the ticket → per client. The ticket is not
 *     special because it survives the proxy; `X-Forwarded-For` does too. It is special because it is
 *     the only per-client identity that has been **verified before the control uses it**.
 */

export interface Session {
  readonly token: string
  readonly streamTicket: string
}

/**
 * A ticket that has been verified. The security review's K5.
 *
 * `open()` took a `clientKey: string`, so nothing stopped a future caller passing an unverified one —
 * and it is the single most important value in the keying scheme. Today's only caller verifies first,
 * so it was never live, but this module's own principle is that *a guarantee depending on a caller
 * remembering is the shape that has failed in this build repeatedly*: it is why `StreamSink.onClose`
 * is required and why the tailnet listener cannot be built without a Funnel watch.
 *
 * The brand makes the compiler the one who remembers. `verifyTicket` is the only thing that can
 * produce one, so a raw string will not typecheck where a verified ticket is required.
 */
declare const verified: unique symbol
export type VerifiedTicket = string & { readonly [verified]: true }

export type SessionResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly reason: string }

export interface SessionStore {
  /** Mints a ticket and returns it with the listener's token, or refuses. */
  readonly start: () => SessionResult
  /**
   * Constant-time. Returns the ticket **branded as verified**, or `null`.
   *
   * A value rather than a boolean, because a boolean leaves the caller holding a raw string that
   * looks identical to an unverified one — and `open()` accepts only the branded type. That is K5:
   * the compiler, not the caller's memory, is what stops an unverified key becoming a client
   * identity.
   */
  readonly verifyTicket: (presented: string) => VerifiedTicket | null
  /** Marks a ticket as holding an open stream, so it is never reclaimed while in use. */
  readonly hold: (ticket: VerifiedTicket) => void
  /**
   * One stream on this ticket has ended. **Call exactly once per stream — this is NOT idempotent**,
   * and it cannot be: a ticket may hold several streams, so it cannot tell which one a repeated call
   * refers to. The caller owns the once-guard; `listener.ts` holds it because only the request scope
   * knows the identity of an individual stream.
   */
  readonly release: (ticket: VerifiedTicket) => void
  readonly liveTickets: () => number
}

export interface SessionStoreOptions {
  /** This listener's token. Per-listener — see `bootstrap.ts` and the security review's B2. */
  readonly token: string
  /** Injected so a test can force a collision or a malformed value. */
  readonly mint?: () => string
  /** Injected so the reclaim window is testable without a wall clock. */
  readonly now?: () => number
}

interface Ticket {
  /** How many streams are currently open on this ticket. Never reclaimed while above zero. */
  openStreams: number
  /** When it was minted or last verified. Not touched by a release — see `finished`. */
  lastActive: number
  /**
   * True once a stream on this ticket has opened and closed.
   *
   * Such a ticket is reclaimable **immediately**: its stream is over, and the client that owned it
   * fetches a fresh ticket for its next connect attempt (C6), so it can never be presented again.
   * Waiting out an idle window for it is what let ordinary window-switching exhaust the pool.
   */
  finished: boolean
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const mint = options.mint ?? (() => randomBytes(CREDENTIAL_BYTES).toString('hex'))
  const now = options.now ?? (() => Date.now())
  const tickets = new Map<string, Ticket>()

  /**
   * Drops tickets that hold no stream and have been idle past the window.
   *
   * Swept on `start()` rather than on a timer: the only moment the bound matters is when someone is
   * asking for a new ticket, and a timer would be one more thing holding the process alive. It also
   * means the sweep cannot run while nothing is happening, which is when it would be pointless.
   *
   * **Never touches a ticket with an open stream**, however old. An installed web app can hold one
   * for days, and reclaiming it would kill a live connection to make room for a new one — which is
   * the eviction B5 refused.
   */
  const sweep = (): void => {
    const cutoff = now() - TICKET_IDLE_MS
    for (const [value, ticket] of tickets) {
      // A ticket holding a live stream is never reclaimed, however old. Everything else falls into
      // one of two cases, and collapsing them into one window is what caused the exhaustion.
      if (ticket.openStreams > 0) continue
      // Finished: its stream opened and closed, so the client has already moved on. No grace.
      if (ticket.finished) { tickets.delete(value); continue }
      // Never used: still inside the mint → connect gap, which is the only thing the window covers.
      if (ticket.lastActive < cutoff) tickets.delete(value)
    }
  }

  return {
    start: (): SessionResult => {
      /**
       * B4: NOTHING MALFORMED IS EVER EMITTED, and this is the one route where that matters most.
       *
       * `checkToken` is the only place that validates the *configured* token's shape, and this
       * route is the one route that omits `checkToken` — so without this line, the route that
       * *distributes* the token is the only one with no assertion that what it distributes is
       * well-formed.
       *
       * The failure it prevents is not an authentication bypass; it fails closed, which is worse in
       * a different way. A malformed token is handed out, every subsequent call is refused 403, the
       * client refetches on 403, receives the same malformed token, and loops — on a phone whose
       * installed web app is *resumed, never relaunched*, so nothing ever reloads to break the
       * cycle. That is spec §15's named brick arriving through the route built to prevent it.
       *
       * **Neither value appears in the reason.** `local-log.ts` emits an `Error`'s message and stack
       * verbatim, and §7 token property 4 is a MUST.
       */
      if (!CREDENTIAL_SHAPE.test(options.token)) {
        return { ok: false, reason: 'the configured token is malformed' }
      }

      // Reclaim before refusing. Without this the bound is a one-way counter and the route becomes
      // permanently unavailable after enough ordinary page loads — K6.
      sweep()

      if (tickets.size >= MAX_LIVE_TICKETS) {
        // Still refuses rather than evicting (B5 unchanged): everything reclaimable has just been
        // reclaimed, so what remains is in use, and dropping one would let a flood choose whose
        // stream dies.
        return { ok: false, reason: 'too many live sessions' }
      }

      const streamTicket = mint()
      if (!CREDENTIAL_SHAPE.test(streamTicket)) {
        return { ok: false, reason: 'the minted ticket is malformed' }
      }
      // A collision would silently give two clients one identity, and the stream cap is keyed on the
      // ticket — so one client could consume the other's allowance. Astronomically unlikely with 16
      // CSPRNG bytes; refused rather than reasoned about, because `mint` is injectable.
      if (tickets.has(streamTicket)) {
        return { ok: false, reason: 'ticket collision' }
      }

      tickets.set(streamTicket, { openStreams: 0, lastActive: now(), finished: false })
      return { ok: true, session: { token: options.token, streamTicket } }
    },

    /**
     * the security review's C5. Shape first, then constant-time, **with no short-circuit anywhere**.
     *
     * `tickets.has(presented)` alone would be a second implementation of a comparison this codebase
     * already has, and a hash lookup is not constant-time. The loop below deliberately visits every
     * live ticket even after a match: an early `return true` would make the response time depend on
     * *which* ticket matched, and `||=` on a boolean already computed does not short-circuit the
     * work that produced it.
     *
     * Honest limit, stated rather than implied: for a 16-byte CSPRNG value with no partial-match
     * feedback, this is not a practical oracle over a tailnet. It is written this way because §7
     * property 2 requires it and because the shape check — the part that actually bit, when an empty
     * expected token authenticated every request — travels with it.
     */
    verifyTicket: (presented: string): VerifiedTicket | null => {
      if (!CREDENTIAL_SHAPE.test(presented)) return null
      const presentedBytes = Buffer.from(presented, 'utf8')

      let matched = false
      for (const value of tickets.keys()) {
        const ticketBytes = Buffer.from(value, 'utf8')
        if (ticketBytes.length !== presentedBytes.length) continue
        // No `if`, no `break`. Bitwise OR on the result, so every live ticket is compared.
        matched = timingSafeEqual(ticketBytes, presentedBytes) || matched
      }

      // Touched only on a match, and after the constant-time loop, so the map write cannot become
      // the timing signal the loop was written to avoid.
      if (!matched) return null
      const ticket = tickets.get(presented)
      if (ticket !== undefined) ticket.lastActive = now()
      return presented as VerifiedTicket
    },

    hold: (ticket: VerifiedTicket): void => {
      const held = tickets.get(ticket)
      if (held === undefined) return
      held.openStreams += 1
      held.lastActive = now()
    },

    /**
     * One call per stream that has ended. **NOT idempotent, and it cannot be** — a ticket may hold
     * several streams, so this has no way to tell which one a repeated call refers to.
     *
     * The comment here used to claim idempotence, on the grounds that the listener binds it to both
     * `close` and `error`. The clamp below made that look true with one stream per ticket and false
     * with two: a single broken connection firing both events decremented twice and freed a ticket
     * whose other stream was still live, making it eligible for the idle sweep. **The once-guard
     * lives at the binding site in `listener.ts`**, which is the only place that knows the identity
     * of an individual stream.
     *
     * The clamp stays as a floor, not as a correctness mechanism.
     */
    release: (ticket: VerifiedTicket): void => {
      const held = tickets.get(ticket)
      if (held === undefined) return
      held.openStreams = Math.max(0, held.openStreams - 1)
      // Marked finished rather than timestamped. A ticket whose stream has ended is reclaimable at
      // once — the client has already moved on and fetches a fresh one for its next attempt — and
      // refreshing `lastActive` here is what kept a spent ticket occupying a slot for the whole idle
      // window, which is how ordinary window-switching exhausted the pool.
      if (held.openStreams === 0) held.finished = true
    },

    liveTickets: () => tickets.size,
  }
}
