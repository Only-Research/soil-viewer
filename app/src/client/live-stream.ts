/**
 * The live-update client. Spec §15.
 *
 * Framework-free, with the browser injected. Not for purity — because the two rules this file
 * exists for are both *timing* rules, and a test that waits on a real clock or a real
 * `EventSource` is a test that goes flaky and then gets deleted.
 *
 * THE TWO RULES, and the second one is a hole rather than polish:
 *
 * **1. Reconnect with exponential backoff, 1s → 60s.** Spec §15 names SSE explicitly "so nobody
 * reaches for `setInterval`", and names the backoff so nobody reaches for a fixed retry either.
 * It resets on a stream that **survives** `STREAM_STABLE_MS`, and on an explicit visibility reopen —
 * never on an automatic retry, and never on a bare handshake. See `onVisible` for why the second
 * distinction is who asked rather than what happened, and `STREAM_STABLE_MS` for why the first had
 * to stop being "a confirmed open": this sentence used to say exactly that, and a fourth adversarial
 * round measured `onopen` arriving 1–2ms after accept, which made it reset-on-attempt — the runaway
 * the rule was written to prevent.
 *
 * **2. On regaining visibility, tear down and reopen UNCONDITIONALLY, and refetch. Do not wait for
 * an error.** This is the one that matters:
 *
 * > *"iOS suspends a backgrounded web app, and a suspended `EventSource` can come back dead without
 * > ever firing `error`. Backoff-on-error therefore never triggers: the stream is silently
 * > finished, the app looks connected, and no update ever arrives again."*
 *
 * So the recovery cannot be *reactive*. There is no event to react to — that is the whole defect.
 * `visibilitychange` → visible and `window.focus` reopen the stream **without probing first**,
 * because probing is just another way of waiting for a signal that never comes. The refetch is
 * required alongside it: anything that changed during suspension was never delivered and no
 * reconnection replays it.
 *
 * A one-shot signal sent while the phone was suspended is simply lost — §15 says so, and says such
 * a signal must report its own delivery rather than assume it landed. Nothing here sends one; the
 * note is for whoever first wants to.
 */

export type StreamState =
  /** No stream open and none wanted. */
  | 'idle'
  /** A stream is open and delivering. */
  | 'live'
  /** Disconnected, waiting out the backoff. The client shows this. */
  | 'reconnecting'
  /**
   * The server said we are behind. Spec §15 requires this be *visible* rather than silent, because
   * the alternative is a screen confidently showing stale files.
   */
  | 'resyncing'

export interface StreamEvent {
  readonly type: string
  readonly data: unknown
}

/** The bits of `EventSource` this uses. Injected so tests need no browser. */
export interface EventSourceLike {
  readonly close: () => void
  onopen: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  addEventListener: (type: string, listener: (event: { data: string }) => void) => void
}

export interface LiveStreamOptions {
  readonly open: (url: string) => EventSourceLike
  /**
   * The stream URL, obtained **fresh on every connect this client initiates** — the security review's C6.
   *
   * It was `readonly url: string`, captured once. That could not express the requirement: the URL
   * carries a ticket, and after a server restart the old ticket is dead. `EventSource` reconnects on
   * its own with no opportunity to change the URL, and its `onerror` fires identically for "server
   * down" and "403, bad ticket" while exposing no status — so a client holding one ticket would
   * reconnect forever against a credential that will never be accepted again, on a phone whose
   * installed web app is *resumed, never relaunched*.
   *
   * Same-origin RELATIVE url only — spec §7/F9.3 forbids an absolute URL anywhere in the bundle.
   */
  readonly url: () => Promise<string>
  readonly onEvent: (event: StreamEvent) => void
  /** Called on every (re)connection and on every resync. Spec §15 requires the refetch. */
  readonly onRefetch: () => void
  readonly onStateChange?: (state: StreamState) => void
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 60_000

/**
 * How long to wait for the URL supplier before treating the attempt as failed. Ten seconds.
 *
 * **`fetch` has no timeout.** A request that is refused rejects and `attach` already handles it; a
 * request that is *dropped* — a packet lost on the tailnet, a socket abandoned as iOS suspends —
 * neither resolves nor rejects, and an `await` on it waits forever. That left the client with no
 * `EventSource`, no pending retry and the state still `'live'`: §15's named failure, arriving
 * through the recovery path built to prevent it.
 *
 * It was masked rather than absent. `visibilitychange` and `focus` both fired, so every return made
 * two independent attempts and the second covered a first that hung; coalescing them removed the
 * mask. Restoring the duplicate would restore the mask, not the property — a hang on a *backoff*
 * retry was never covered by it, and a mask that depends on doing everything twice is not a control.
 *
 * Ten seconds because the request is a same-host POST that answers in single-digit milliseconds in
 * practice, and because this bound is not a latency budget — it is the line past which "slow" and
 * "never" stop being worth distinguishing. Retrying costs one ticket, which is now cheap.
 */
export const URL_DEADLINE_MS = 10_000

/**
 * How long a stream must stay open before it counts as working, and the backoff resets. Ten seconds.
 *
 * **`onopen` is not evidence of a working stream, and the code that assumed it was named its own
 * hazard.** The reset lived in `onopen`, defended as *"a CONFIRMED open — never an attempt"*, with
 * the warning that resetting on the attempt *"would make a server that accepts and immediately drops
 * produce a 1s retry loop forever."*
 *
 * It was resetting on the attempt. `listener.ts` writes `: open\n\n` the instant a stream is
 * accepted — added so WebKit fires `onopen` promptly rather than showing "Connecting…" for fifteen
 * seconds — so a fourth adversarial round measured `onopen` at **1–2ms** after accept in both
 * engines. Fifteen accept-and-drop cycles waited `1000, 1000, 1000…` and minted **61 tickets in 60
 * seconds**: a phone reconnecting once a second indefinitely, radio never idling, whenever the path
 * accepts and drops. A wifi-to-cellular handover is the ordinary case.
 *
 * Two facts, each correct alone, three commits and two files apart. Three single-file review rounds
 * missed it, which is the argument for cross-cutting ones.
 *
 * Ten seconds is comfortably below the 15s heartbeat, so a stream that survives to the reset has
 * survived on its own rather than because traffic happened to arrive. An explicit visibility reopen
 * still resets immediately — that is a person's intent, not an automatic retry, and it is unchanged.
 */
export const STREAM_STABLE_MS = 10_000

/** Event types the client listens for by name. Anything else is ignored rather than guessed at. */
const KNOWN_EVENTS = ['changed', 'resync']

export interface LiveStream {
  readonly state: () => StreamState
  readonly start: () => void
  readonly stop: () => void
  /**
   * Called on `visibilitychange` → visible and on `window.focus`.
   *
   * **Unconditional.** It does not check whether the stream looks alive first, because a suspended
   * `EventSource` looks alive right up until you notice it has delivered nothing for an hour.
   */
  readonly onVisible: () => void
  /** Current backoff, exposed so the UI can say "retrying in 8s" rather than spinning silently. */
  readonly retryDelayMs: () => number
}

export function createLiveStream(options: LiveStreamOptions): LiveStream {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as never) })

  let source: EventSourceLike | null = null
  let state: StreamState = 'idle'
  let backoffMs = BACKOFF_MIN_MS
  let retryTimer: unknown = null
  /** Armed by a confirmed open, collected only if the stream survives `STREAM_STABLE_MS`. */
  let stableTimer: unknown = null
  let wanted = false
  /** Incremented by every teardown. A connect whose generation is stale must not install itself. */
  let generation = 0

  const setState = (next: StreamState): void => {
    if (next === state) return
    state = next
    /**
     * GUARDED, like `onEvent` and `onRefetch`, and this was the last caller callback left bare.
     *
     * It is the most dangerous of the three to leave open, because `connect()` calls it — so a throw
     * escapes `connect`, escapes `onVisible`, and lands in the `visibilitychange` handler where
     * nothing catches it, *after* `teardown()` closed the stream and *before* `attach()` runs. No
     * stream, nothing scheduled. Worse, the coalescer has already stamped its clock, so the paired
     * `focus` event is suppressed and that return produces **no recovery at all**.
     *
     * Not live today — `main.tsx` wires it to `setText`, which cannot throw — and live the moment
     * P7 puts rendering behind it, which is exactly what the other two guards anticipate.
     */
    try {
      options.onStateChange?.(next)
    } catch { /* the caller's reporter is broken; the stream is not */ }
  }

  const teardown = (): void => {
    /**
     * INVALIDATES ANY CONNECT STILL IN FLIGHT, and this counter is what makes an async URL safe.
     *
     * Obtaining the URL is now asynchronous, so between "start connecting" and "here is the URL"
     * the world can change: the user backgrounds and returns (`onVisible` tears down and reconnects),
     * `stop()` is called, or a backoff retry fires. Without a generation, a resolution that arrives
     * after any of those installs a second `EventSource` — and two live streams is worse than none,
     * because both deliver and neither is authoritative.
     *
     * Bumped here rather than in `connect`, so every path that discards a stream also discards the
     * attempts that were racing to create one.
     */
    generation += 1
    if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null }
    // The stability timer dies with the stream that armed it. Otherwise a connection that was torn
    // down would reset the backoff of whatever replaced it — reintroducing the reset-on-attempt this
    // timer exists to remove, just later.
    if (stableTimer !== null) { clearTimer(stableTimer); stableTimer = null }
    if (source !== null) {
      // Detach before closing. A handler that fires during teardown would otherwise schedule a
      // reconnect for a stream we are deliberately discarding, and two live streams is worse than
      // none: both deliver, neither is authoritative.
      source.onopen = null
      source.onerror = null
      source.onmessage = null
      source.close()
      source = null
    }
  }

  const scheduleRetry = (): void => {
    if (!wanted) return
    setState('reconnecting')
    retryTimer = setTimer(() => { retryTimer = null; connect() }, backoffMs)
    // Doubled AFTER scheduling, so the first retry waits the minimum rather than double it.
    backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2)
  }

  function connect(): void {
    if (!wanted) return
    teardown()
    /**
     * THE STATUS LINE MAY NEVER SAY "live" WHILE THERE IS NO STREAM.
     *
     * `teardown()` above just closed it, and what replaces it is not open yet — so between here and
     * `onopen` the app is, factually, disconnected. Leaving the state alone across that gap is what
     * let a hung connect present as **Live** indefinitely: a wrong state is worse than a pessimistic
     * one, because §15's whole failure mode is *"the app looks connected"*.
     *
     * Only from `'live'`, so a first connect goes `idle → live` and the shell's own "Connecting…"
     * is not overwritten with "Reconnecting…" before anything has ever connected.
     */
    if (state === 'live') setState('reconnecting')
    const mine = generation
    void attach(mine)
  }

  /**
   * Races a promise against the deadline. Uses the INJECTED timer, so tests drive it deterministically
   * rather than waiting ten real seconds.
   *
   * The loser is abandoned, not cancelled — this cannot reach inside the supplier. That is fine and
   * is the point: the abandoned attempt's generation is already stale, so if it does eventually
   * resolve, the check after the await discards it.
   */
  const withDeadline = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    let settled = false
    const handle = setTimer(() => {
      if (settled) return
      settled = true
      reject(new Error('deadline'))
    }, URL_DEADLINE_MS)
    work.then(
      value => { if (!settled) { settled = true; clearTimer(handle); resolve(value) } },
      (error: unknown) => { if (!settled) { settled = true; clearTimer(handle); reject(error as Error) } },
    )
  })

  /**
   * Obtains a fresh URL and installs the stream, unless it has been superseded.
   *
   * `void`-ed by `connect` and fully self-contained: nothing here may reject, because a rejection
   * from a `visibilitychange` handler goes nowhere at all — which is how the first version of this
   * file left the stream dead with state `'live'` and zero pending retries.
   */
  async function attach(mine: number): Promise<void> {
    let url: string
    try {
      // Deadlined. A supplier that REJECTS was always handled here; one that never settles was not,
      // and `fetch` produces the second whenever a request is dropped rather than refused.
      url = await withDeadline(options.url())
    } catch {
      // The session could not be obtained — the server is down, refusing, or not answering at all.
      // Indistinguishable from a failed connect, and treated the same: back off and try again.
      if (wanted && mine === generation) scheduleRetry()
      return
    }
    // Superseded while awaiting: a teardown happened, so this attempt is abandoned rather than
    // installed on top of whatever replaced it.
    if (!wanted || mine !== generation) return

    // `open()` can throw — a browser refusing an EventSource, a mis-built URL, an adapter that
    // fails. The first version let it escape, which left the stream dead with state `'live'` and
    // ZERO pending retries: the status line kept saying "Live" and no update ever arrived again.
    // That is spec §15's named iOS failure mode, reintroduced by the recovery path built to prevent
    // it.
    let next: EventSourceLike
    try {
      next = options.open(url)
    } catch {
      if (wanted && mine === generation) scheduleRetry()
      return
    }

    // Checked AGAIN after `open()`, because `open` is caller code and may itself await or throw
    // asynchronously. Without this a stream created during a teardown would be installed and then
    // leak: nothing else holds a reference to close it.
    if (!wanted || mine !== generation) {
      next.close()
      return
    }
    source = next

    next.onopen = () => {
      /**
       * NOT a backoff reset. `onopen` fires 1–2ms after accept, because the server writes an opening
       * byte immediately — so it says the connection was accepted, not that it works. Resetting here
       * is resetting on the attempt, which is the runaway loop the old comment warned about while
       * being the thing it did.
       *
       * The reset is armed instead, and only survival collects it. A drop before then tears this
       * timer down with the stream, so the ladder keeps climbing.
       */
      stableTimer = setTimer(() => {
        stableTimer = null
        if (wanted && mine === generation) backoffMs = BACKOFF_MIN_MS
      }, STREAM_STABLE_MS)
      setState('live')
      // Spec §15: refetch on every connection. Anything that changed while disconnected was never
      // delivered, and no reconnection replays it.
      //
      // Guarded, because `onRefetch` is caller code. An exception here used to escape into the
      // EventSource's own onopen handler, leaving the state `'live'` with nothing scheduled — the
      // same dead-but-connected shape as above.
      try {
        options.onRefetch()
      } catch {
        // The connection is real; the caller's refetch failed. Reporting a live stream is honest,
        // and a failed refetch is the caller's to surface.
      }
    }

    next.onerror = () => {
      // `EventSource` fires error for both a failed connect and a dropped stream, and does not
      // distinguish them. Treated identically: both mean we are not receiving.
      teardown()
      scheduleRetry()
    }

    for (const type of KNOWN_EVENTS) {
      next.addEventListener(type, event => {
        /**
         * A TORN-DOWN STREAM MUST NOT ACT. `teardown()` nulls `onopen`/`onerror`/`onmessage` but
         * cannot remove these — `EventSourceLike` has no `removeEventListener`, deliberately, since
         * it is the minimum surface the client needs.
         *
         * Measured in Chromium and WebKit: `close()` from inside a listener does stop the remaining
         * events in the same TCP write, so this is not reachable in production today. Gated anyway,
         * because that is a browser behaviour rather than a property of this file, and one
         * comparison is cheaper than depending on it.
         */
        if (mine !== generation) return
        if (type === 'resync') {
          // The server dropped our backlog rather than replaying a prefix of a lost sequence. The
          // only correct response is to refetch, and to SAY SO — a silent resync is a screen that
          // confidently shows stale files.
          setState('resyncing')
          try {
            options.onRefetch()
          } catch {
            /**
             * Guarded for the same reason `onopen`'s refetch is, and this one is worse if it fails.
             * Unguarded, the throw escaped into the `EventSource` listener where nothing catches it,
             * `setState('live')` below never ran, and the app sat on `'resyncing'` over a perfectly
             * healthy stream — permanently, because only a reconnect clears that state.
             *
             * Reconnecting rather than continuing, because this refetch is the ONLY thing that
             * repairs a dropped backlog: carrying on would mean saying "live" over files known to
             * be stale. The reconnect re-runs the refetch from `onopen`, with the backoff behind it.
             */
            teardown()
            scheduleRetry()
            return
          }
          setState('live')
          return
        }
        // Guarded because `onEvent` is caller code — P7 fills it with rendering, which is precisely
        // what throws on unexpected data. One malformed payload must not end the stream; the state
        // is unchanged because the connection is fine and only this event was not handled.
        try {
          options.onEvent({ type, data: safeParse(event.data) })
        } catch { /* the caller's handler failed; the stream is still delivering */ }
      })
    }
  }

  return {
    state: () => state,
    retryDelayMs: () => backoffMs,

    start: () => {
      if (wanted) return
      wanted = true
      connect()
    },

    stop: () => {
      wanted = false
      teardown()
      setState('idle')
    },

    onVisible: () => {
      if (!wanted) return
      // No probe, no condition. See the header: there is no signal to check, which is the defect.
      //
      // THE BACKOFF IS RESET HERE, and that is deliberate — but it means "resets only on a
      // confirmed open" was never the whole truth, and the P3 review was right to call the stated
      // invariant false. The accurate rule:
      //
      //   The backoff resets on a stream that SURVIVES `STREAM_STABLE_MS`, and on an explicit
      //   visibility reopen. It never resets on an automatic retry, and never on a bare handshake.
      //
      // The "confirmed open" half of that sentence was itself corrected in the fourth round: the
      // server writes an opening byte on accept, so `onopen` fired 1-2ms in and reset the backoff on
      // what was effectively the attempt. Twice now this rule has been stated more confidently than
      // it was true.
      //
      // The distinction that matters is *who asked*. An automatic retry resetting its own backoff
      // is the runaway loop; a person returning to the app is a new intent, and making them wait
      // out a 60s delay accumulated while the phone slept is the wrong answer to the wrong
      // question. `dom.ts` wires this to `window.focus` as well, so an alt-tab against a
      // still-down server does re-attempt at 1s — accepted: it is user-initiated, bounded by how
      // fast someone can switch windows, and the alternative is an app that looks broken on return.
      teardown()
      backoffMs = BACKOFF_MIN_MS
      connect()
    },
  }
}

/**
 * Parses an event payload without letting a malformed one take down the stream.
 *
 * Returns `null` rather than throwing. A single bad frame must not kill the connection that would
 * deliver the next good one — and the server JSON-encodes `data`, so a parse failure here means
 * something is wrong upstream, not that this frame should be retried.
 */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}
