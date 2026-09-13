import { describe, expect, it } from 'vitest'

import {
  KEEPALIVE_MAX_BODY_BYTES, REQUEST_DEADLINE_MS, VISIBILITY_SUPPRESS_MS, onBecameVisible,
  getText, onSessionEnding, postJson, type VisibilitySeam,
} from '../../src/client/dom'
import { URL_DEADLINE_MS } from '../../src/client/live-stream'

/**
 * `onBecameVisible` — the single iOS recovery path, and until now the only client module with no
 * test file at all.
 *
 * Spec §15's second rule is why it exists:
 *
 * > *"iOS suspends a backgrounded web app, and a suspended `EventSource` can come back dead without
 * > ever firing `error`. Backoff-on-error therefore never triggers: the stream is silently
 * > finished, the app looks connected, and no update ever arrives again."*
 *
 * So the recovery is unconditional and the only trigger is a return to the app. Everything here is
 * about one question: **does a real return always run the listener, exactly once?** A missed call is
 * an app that is dead until the next return. A doubled call is a wasted ticket. They are not
 * symmetric, and the tests say which way each edge case is resolved.
 *
 * Two adversarial reviews found this behaviour shipped with no proof clause whatsoever — in the same
 * commit whose message complains that the previous fix had none.
 */

/**
 * A fake document/window pair with a clock the test drives.
 *
 * `startAt` is a parameter because it had to be. A review found the first-event test was a tautology:
 * the clock started at exactly `1_000` and the window was exactly `1_000`, so a zero-initialised
 * stamp gave `1000 - 0 = 1000`, which is not `< 1000`, and the test passed against the very
 * initialisation it claimed to rule out. It named a clock "near zero" and then used one that was not.
 */
function seam(startAt = 1_000): VisibilitySeam & {
  visible: boolean
  now: () => number
  advance: (ms: number) => void
  fireVisibilityChange: () => void
  fireFocus: () => void
  firePageHide: () => void
  fireBeforeUnload: () => void
} {
  let clock = startAt
  const onVisibility: Array<() => void> = []
  const onFocus: Array<() => void> = []
  const onPageHide: Array<() => void> = []
  const onBeforeUnload: Array<() => void> = []
  /**
   * **Each listener is dispatched independently, because the browser does that** and because the
   * three session-ending triggers only mean anything if one throwing cannot silence the others.
   * A harness that let the first throw abort the loop would make the redundancy test below pass
   * for the wrong reason — it would be measuring the harness.
   */
  const dispatch = (listeners: readonly (() => void)[]): void => {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* the browser swallows it too */ }
    }
  }
  const harness = {
    visible: true,
    onVisibilityChange: (l: () => void) => { onVisibility.push(l) },
    onWindowFocus: (l: () => void) => { onFocus.push(l) },
    onPageHide: (l: () => void) => { onPageHide.push(l) },
    onBeforeUnload: (l: () => void) => { onBeforeUnload.push(l) },
    isVisible: () => harness.visible,
    now: () => clock,
    advance: (ms: number) => { clock += ms },
    fireVisibilityChange: () => { for (const l of [...onVisibility]) l() },
    fireFocus: () => { for (const l of [...onFocus]) l() },
    firePageHide: () => { dispatch(onPageHide) },
    fireBeforeUnload: () => { dispatch(onBeforeUnload) },
  }
  return harness
}

/** One return to the app raises BOTH events, `gapMs` apart. This is the whole point of the module. */
function returnToApp(s: ReturnType<typeof seam>, gapMs: number): void {
  s.visible = true
  s.fireVisibilityChange()
  s.advance(gapMs)
  s.fireFocus()
}

describe('one return runs the listener exactly once', () => {
  it('coalesces the pair across every gap a single return plausibly produces', () => {
    // THE REGRESSION THIS REPLACES. The previous design merged only within 50ms, and an adversarial
    // review measured the cliff at exactly that: 45ms apart merged, 60ms apart did not. The real iOS
    // gap has never been measured, so any value there was a guess that silently reverted the fix.
    // Leading-edge suppression makes the window a cost question rather than a correctness one, which
    // is why it can sit an order of magnitude above the measured cliff.
    for (const gap of [0, 10, 49, 51, 200, 249]) {
      const s = seam()
      let calls = 0
      onBecameVisible(() => { calls++ }, s)
      returnToApp(s, gap)
      expect(calls, `both events ${gap}ms apart are one return`).toBe(1)
    }
  })

  it('and past the window it costs one extra request — never a missed wakeup', () => {
    // The boundary stated as a property rather than left implicit. If iOS ever spaces the pair
    // further apart than the window, the failure mode is a spare ticket, which is the direction this
    // module resolves every ambiguity in. It is never silence.
    const s = seam()
    let calls = 0
    onBecameVisible(() => { calls++ }, s)

    returnToApp(s, VISIBILITY_SUPPRESS_MS + 50)

    expect(calls, 'degrades to a wasted request, not to a dead app').toBe(2)
  })

  it('runs SYNCHRONOUSLY, inside the handler — never deferred into a timer', () => {
    // Load-bearing on iOS: the platform suspends timers on a backgrounded app, so recovery parked in
    // a `setTimeout` can be frozen at exactly the moment it is needed. Firing on the edge means the
    // work is already done by the time the event handler returns. No fake timers here on purpose —
    // if this ever needs them, the property is gone.
    const s = seam()
    let calls = 0
    onBecameVisible(() => { calls++ }, s)

    s.fireVisibilityChange()
    expect(calls, 'already recovered, with no clock having advanced').toBe(1)
  })

  it('a genuine second return, after the window, fires again', () => {
    const s = seam()
    let calls = 0
    onBecameVisible(() => { calls++ }, s)

    returnToApp(s, 10)
    s.advance(VISIBILITY_SUPPRESS_MS)
    returnToApp(s, 10)

    expect(calls, 'two returns are two recoveries').toBe(2)
  })

  it('a return every few seconds keeps recovering, indefinitely', () => {
    // The failure that would hide here is a latch: something that fires once and never again, which
    // presents as "it worked this morning" and is untraceable.
    const s = seam()
    let calls = 0
    onBecameVisible(() => { calls++ }, s)

    for (let i = 0; i < 50; i++) {
      s.advance(3_000)
      returnToApp(s, 20)
    }

    expect(calls).toBe(50)
  })
})

describe('the edges, and which way each one is resolved', () => {
  it('a listener that throws does not wedge the path — the next return still recovers', () => {
    // A dead recovery path is invisible: nothing on screen changes, the app simply never updates
    // again.
    const s = seam()
    let calls = 0
    onBecameVisible(() => { calls++; throw new Error('the listener is broken') }, s)

    expect(() => { s.fireVisibilityChange() }).toThrow()
    s.advance(VISIBILITY_SUPPRESS_MS + 1)
    expect(() => { s.fireVisibilityChange() }).toThrow()

    expect(calls, 'it kept trying rather than latching off').toBe(2)
  })

  it('a throwing listener still consumes the return — the stamp is taken BEFORE the call', () => {
    /**
     * THE TEST ABOVE DOES NOT PROVE THIS, and a review proved that it does not: move the stamp to
     * *after* the listener and the whole file stays green, because that test advances past the entire
     * window between its two throws and so never exercises the only case the ordering changes.
     *
     * That case is here: one return, listener throws on the first event, and the **paired** event
     * arrives inside the window. Stamped before, the pair is one return and the throw is irrelevant.
     * Stamped after, the throw skips the stamp entirely and the pair becomes two returns — two
     * connects, two tickets, for one user action, every time the listener fails.
     *
     * Instance seven of this build's recurring failure, found in a file written specifically to end
     * it: the mechanism was named in a comment and left unpinned.
     */
    const s = seam()
    let calls = 0
    onBecameVisible(() => { calls++; throw new Error('the listener is broken') }, s)

    expect(() => { s.fireVisibilityChange() }).toThrow()
    s.advance(20) // the paired `focus`, well inside the window
    s.fireFocus()

    expect(calls, 'one return, even when the listener throws').toBe(1)
  })

  it('visibilitychange to HIDDEN is not a return, and does not fire', () => {
    const s = seam()
    let calls = 0
    onBecameVisible(() => { calls++ }, s)

    s.visible = false
    s.fireVisibilityChange()

    expect(calls).toBe(0)
  })

  it('focus while the document still reads hidden DOES fire — deliberately', () => {
    // The asymmetry, stated as a test so nobody "fixes" it later. Gating `focus` on visibilityState
    // would drop a real wakeup if iOS ever ordered the two events the other way, and a lost wakeup
    // is precisely the failure this module exists to prevent. A spurious one costs a ticket.
    const s = seam()
    let calls = 0
    onBecameVisible(() => { calls++ }, s)

    s.visible = false
    s.fireFocus()

    expect(calls, 'a wasted ticket is cheap; a missed wakeup is a dead app').toBe(1)
  })

  it('either event alone is enough — neither is merely decorative', () => {
    // §15 requires both bound. If one were dropped, the desktop cases diverge: app-switching gives
    // focus without visibilitychange, tab-switching gives the reverse.
    const viaVisibility = seam()
    let a = 0
    onBecameVisible(() => { a++ }, viaVisibility)
    viaVisibility.fireVisibilityChange()
    expect(a, 'visibilitychange alone recovers').toBe(1)

    const viaFocus = seam()
    let b = 0
    onBecameVisible(() => { b++ }, viaFocus)
    viaFocus.fireFocus()
    expect(b, 'focus alone recovers').toBe(1)
  })

  it('A CLOCK THAT GOES BACKWARDS MUST NOT CREATE A DEAD WINDOW', () => {
    /**
     * THE WORST CLASS OF DEFECT THIS MODULE CAN HAVE, and the fourth adversarial round found it in
     * the fix from the third.
     *
     * The suppression compared two readings of `Date.now()` — a **wall clock, used as a monotonic
     * one**. A backwards step of X (an NTP correction after a long offline period, a manual Date &
     * Time change, a carrier time update) makes every subsequent reading smaller, so the difference
     * is negative, so *every genuine return is suppressed* until the clock climbs back. Measured at
     * a 30-second step: 29 of 30 consecutive real returns produced no listener call at all.
     *
     * During that window the sole iOS recovery path is dead and the state is whatever it was —
     * including `'live'` over a stream delivering nothing, which is §15's named failure verbatim, on
     * a device that is resumed and never relaunched.
     *
     * Two changes, and this test pins the one that holds regardless of clock: a reading that is not
     * strictly after the last one is never treated as a duplicate. The seam also moved to
     * `performance.now()`, which is monotonic — but a control that depends on picking the right
     * clock is one somebody re-breaks later.
     */
    for (const step of [1_000, 30_000, 3_600_000]) {
      const s = seam()
      let calls = 0
      onBecameVisible(() => { calls++ }, s)

      returnToApp(s, 10)
      expect(calls).toBe(1)

      s.advance(-step) // the clock jumps backwards

      for (let i = 0; i < 5; i++) {
        s.advance(5_000)
        returnToApp(s, 10)
      }

      expect(calls, `a ${step}ms backwards step must not swallow returns`).toBe(6)
    }
  })

  it('two genuine returns a second apart are two returns, not one', () => {
    // The window was 1000ms, and an adversarial round pointed out it was buying the wrong thing: it
    // saved one request per return while owning a lost-wakeup class, against this module's own
    // stated rule that a wasted ticket is cheap and a missed wakeup is a dead app. Tickets got
    // cheaper still when the pool bound was derived, so the window is now sized to merge one user
    // action and nothing more.
    const s = seam()
    let calls = 0
    onBecameVisible(() => { calls++ }, s)

    returnToApp(s, 10)
    s.advance(700)
    returnToApp(s, 10)

    expect(calls, 'a person can genuinely leave and come back inside a second').toBe(2)
  })

  it('the FIRST event is never suppressed, whatever the clock happens to read', () => {
    /**
     * A zero-initialised stamp plus a clock near zero suppresses the very first return — and that
     * matters now that the seam reads `performance.now()`, which **starts near zero** on a freshly
     * loaded page. It is exactly the reading this app gets on a cold load.
     *
     * The previous version of this test said all of that and then used a clock starting at 1000
     * against a 1000ms window, so `1000 - 0` was not less than the window and a zero-initialised
     * stamp passed. A review caught it: the test restated the source and pinned nothing.
     */
    for (const startAt of [0, 1, 12, VISIBILITY_SUPPRESS_MS - 1]) {
      const s = seam(startAt)
      let calls = 0
      onBecameVisible(() => { calls++ }, s)

      s.fireFocus()

      expect(calls, `a page whose clock reads ${startAt}ms must still recover`).toBe(1)
    }
  })
})

/**
 * `postJson` — the client's only outbound call, and until now it had **no test anywhere in the
 * suite**. A review grepped the whole of `app/test/` for it and found zero hits.
 *
 * That matters most for the deadline. Both the source comment and the commit that added it present
 * `AbortSignal.timeout` as the sole bound on `call()` — *"the API path, which has no second layer
 * behind it"* — and deleting the line left the entire suite green. A named control on the only
 * unprotected path, with no proof clause: precisely the shape of the three defects the same commit
 * was written to fix.
 */
/**
 * `onSessionEnding` — §12's flush contract, and the reason it is three bindings and not one.
 *
 * `save-policy.ts` has described *"three overlapping triggers plus idempotency"* since 2026-08-05,
 * and until 2026-08-16 `pagehide` and `beforeunload` appeared **nowhere in `src/` except inside that
 * comment**. The only wiring was `visibilitychange`. The sweep of 2026-08-16 found it.
 *
 * The reason redundancy is the design, quoted from §12 by way of `save-policy.ts`: *"no end-of-session
 * event is guaranteed on mobile WebKit."* Open the page, switch apps, close the browser from the app
 * switcher — neither `pagehide` nor `beforeunload` is dispatched. Desktop Safari is worse: closing a
 * tab with the (X) dispatches neither `visibilitychange` nor `pagehide`. No single one of the three
 * can be the one that matters, so the test that matters is that **each fires on its own**.
 *
 * These are deliberately not one parameterised test. A loop over three event names would pass with
 * two bindings and a shared listener array, which is the exact shape of the bug being fixed.
 */
describe('onSessionEnding — each of §12\'s three triggers flushes on its own', () => {
  it('fires when the document becomes hidden', () => {
    const s = seam()
    let calls = 0
    onSessionEnding(() => { calls++ }, s)

    s.visible = false
    s.fireVisibilityChange()

    expect(calls, 'the primary trigger: the last moment mobile WebKit reliably gives you').toBe(1)
  })

  it('fires on pagehide', () => {
    const s = seam()
    let calls = 0
    onSessionEnding(() => { calls++ }, s)

    s.firePageHide()

    expect(calls, 'pagehide was in a comment and nowhere else until 2026-08-16').toBe(1)
  })

  it('fires on beforeunload', () => {
    const s = seam()
    let calls = 0
    onSessionEnding(() => { calls++ }, s)

    s.fireBeforeUnload()

    expect(calls, 'beforeunload was in a comment and nowhere else until 2026-08-16').toBe(1)
  })

  it('does NOT fire when the document becomes visible', () => {
    const s = seam()
    let calls = 0
    onSessionEnding(() => { calls++ }, s)

    s.visible = true
    s.fireVisibilityChange()

    expect(calls, 'a return to the app is not the end of a session').toBe(0)
  })

  /**
   * **No suppression window, unlike `onBecameVisible`, and that asymmetry is the contract.**
   *
   * A duplicate reconnect costs a wasted ticket, so that one debounces. A duplicate flush costs
   * nothing, because `shouldSave` answers `false` on a clean buffer — and §12 requires all three
   * triggers to be idempotent *precisely so that no single event is load-bearing*. Debouncing here
   * would quietly restore the single point of failure this whole function exists to remove.
   */
  it('runs on all three when all three fire, with no debounce', () => {
    const s = seam()
    let calls = 0
    onSessionEnding(() => { calls++ }, s)

    s.visible = false
    s.fireVisibilityChange()
    s.firePageHide()
    s.fireBeforeUnload()

    expect(calls, 'idempotency lives in shouldSave, not in a window here').toBe(3)
  })

  /**
   * **One trigger throwing must not silence the other two**, which is the whole claim of redundancy.
   *
   * A listener that throws is not hypothetical: this one calls `retainNow()` and `doc.flush()`, and
   * the surface it runs on is being torn down underneath it. If the three were chained — bound in
   * one handler, or dispatched from one array by a helper that stops on error — the *first* trigger
   * failing would take the last two chances with it, on the exact platform where the first trigger
   * is the one least likely to arrive.
   */
  it('keeps the later triggers alive when an earlier one throws', () => {
    const s = seam()
    const fired: string[] = []
    let stage = 'hidden'
    onSessionEnding(() => {
      fired.push(stage)
      if (stage === 'hidden') throw new Error('the flush blew up on the way out')
    }, s)

    s.visible = false
    // Caught HERE rather than in the harness, so `fireVisibilityChange` keeps the exact semantics
    // the `onBecameVisible` tests above were written against.
    try { s.fireVisibilityChange() } catch { /* expected: the listener threw on purpose */ }
    stage = 'pagehide'
    s.firePageHide()
    stage = 'beforeunload'
    s.fireBeforeUnload()

    expect(fired, 'three independent bindings, not one chain').toEqual([
      'hidden', 'pagehide', 'beforeunload',
    ])
  })
})

/**
 * **The seam tests above cannot catch a typo, and that is the gap this closes.**
 *
 * Every test in the block above injects a fake seam, so all six prove is that `onSessionEnding`
 * calls three *methods*. `'pagehidden'` instead of `'pagehide'` in `browserVisibility` would leave
 * all of them green and ship a trigger that never fires — which is this build's signature defect
 * wearing a new hat: complete, tested, and wired to nothing.
 *
 * The unit environment is `node` and this repo carries no DOM library (§2, and nobody installs a
 * package to write a test), so the globals are stubbed for the length of one call and the **exact
 * strings** handed to `addEventListener` are read back. That is the whole assertion: not that a
 * listener was registered, but what it was registered *for*.
 *
 * The default parameter is exercised on purpose — `onSessionEnding(listener)` with no seam is what
 * `main.tsx` calls, so this is the production path and not a second one built for the test.
 */
describe('browserVisibility — the real event names, not just three method calls', () => {
  it('registers visibilitychange on the document and pagehide + beforeunload on the window', () => {
    const onDocumentEvents: string[] = []
    const onWindowEvents: string[] = []

    const globals = globalThis as unknown as Record<string, unknown>
    const hadDocument = 'document' in globals
    const previousDocument = globals.document
    const previousAdd = globals.addEventListener

    try {
      globals.document = {
        addEventListener: (type: string) => { onDocumentEvents.push(type) },
        visibilityState: 'visible',
      }
      globals.addEventListener = (type: string) => { onWindowEvents.push(type) }

      // No seam: the default parameter, which is the path main.tsx takes.
      onSessionEnding(() => {})
    } finally {
      // Restored however the assertions go, so a failure here cannot leak a fake `document` into
      // every test file that runs after this one in the same worker.
      if (hadDocument) globals.document = previousDocument
      else delete globals.document
      if (previousAdd === undefined) delete globals.addEventListener
      else globals.addEventListener = previousAdd
    }

    expect(onDocumentEvents, '§12\'s primary trigger, on the document').toEqual(['visibilitychange'])
    expect(onWindowEvents, '§12\'s other two, on the window').toEqual(['pagehide', 'beforeunload'])
  })
})

/**
 * `getText` — the byte-fetching sibling, added 2026-08-16 for the security review's G2.
 *
 * The non-editing pane called bare `fetch(url)`: no `credentials: 'omit'`, no `cache: 'no-store'`,
 * and **no abort deadline**. The deadline is the one that mattered — the call is consumed as a
 * floating promise, so a dropped request never settled, the pane read "Loading…" forever, and the
 * socket stayed open. Written after `postJson` had already paid for that lesson.
 *
 * **The deadline is driven, not inspected.** `postJson`'s own note records why: a previous version
 * of its deadline test asserted a signal was *present and not aborted*, which a signal that never
 * fires satisfies — so swapping `AbortSignal.timeout(…)` for a bare `AbortController().signal` left
 * the suite green. The test below waits for the rejection instead.
 */
describe('getText — the byte fetch carries the same discipline', () => {
  const withFetch = async (
    impl: (input: unknown, init: RequestInit) => Promise<Response>,
    run: () => Promise<void>,
  ): Promise<void> => {
    const original = globalThis.fetch
    globalThis.fetch = impl as unknown as typeof fetch
    try { await run() } finally { globalThis.fetch = original }
  }

  it('sends no credentials and refuses to cache a reply carrying a live ticket', async () => {
    let seen: RequestInit | null = null
    await withFetch(async (_input, init) => {
      seen = init
      return { ok: true, text: async () => 'the bytes' } as unknown as Response
    }, async () => {
      expect(await getText('/file?ticket=abc&root=r&p=a.png')).toBe('the bytes')
    })

    const init = seen as RequestInit | null
    expect(init?.credentials, 'the app has no cookies and must not acquire the habit').toBe('omit')
    expect(init?.cache, 'the URL carries a ticket; it must not sit in a disk cache').toBe('no-store')
  })

  /**
   * **THE DEADLINE ACTUALLY FIRES.** A request that never answers must reject rather than hang.
   * Without this the pane reads "Loading…" for the rest of the session.
   */
  it('aborts a request that never answers', async () => {
    await withFetch((_input, init) => new Promise((_resolve, reject) => {
      // A request that is dropped rather than refused: it never settles on its own. The ONLY thing
      // that can end this promise is the signal, which is exactly the claim under test.
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
      })
    }), async () => {
      await expect(getText('/file?ticket=abc', 20)).rejects.toThrow()
    })
  })

  it('reports a refusal rather than returning an empty document', async () => {
    await withFetch(
      async () => ({ ok: false, status: 404, text: async () => '' }) as unknown as Response,
      async () => {
        // Returning '' here would paint an empty pane over a file that exists and was refused.
        await expect(getText('/file?ticket=abc')).rejects.toThrow('could not read that file')
      },
    )
  })
})

describe('postJson — every request carries a deadline', () => {
  const withFetch = async (
    impl: (input: unknown, init: RequestInit) => Promise<Response>,
    run: () => Promise<void>,
  ): Promise<void> => {
    const original = globalThis.fetch
    globalThis.fetch = impl as unknown as typeof fetch
    try { await run() } finally { globalThis.fetch = original }
  }

  const okResponse = (): Response => ({
    status: 200,
    json: async () => ({ ok: true }),
  } as unknown as Response)

  it('passes an abort signal, so a dropped request cannot hang forever', async () => {
    let seen: RequestInit | null = null
    await withFetch(async (_input, init) => { seen = init; return okResponse() }, async () => {
      await postJson('/api/session.start', {}, {})
    })

    const init = seen as RequestInit | null
    expect(init, 'fetch was called').not.toBeNull()
    expect(init?.signal, 'without this, a dropped request never settles').toBeInstanceOf(AbortSignal)
    expect(init?.signal?.aborted, 'and it has not fired yet').toBe(false)
  })

  it('THE DEADLINE ACTUALLY FIRES — a request that never answers is aborted', async () => {
    /**
     * The test above proves a signal is *passed*. It does not prove the signal ever *fires*, and a
     * review demonstrated the gap: swap `AbortSignal.timeout(…)` for a bare
     * `new AbortController().signal` — one that can never abort — and the whole suite stayed green.
     * `instanceof AbortSignal` and `aborted === false` are both satisfied by a signal that is dead.
     *
     * That is three consecutive rounds in which this same control was written up as covered and was
     * not, which is why the deadline is now injectable: fifteen seconds is not waitable, and a
     * control nobody can afford to watch fail is a control nobody has watched fail.
     */
    const original = globalThis.fetch
    // A server that accepts the request and never answers — the exact shape the deadline exists for.
    globalThis.fetch = ((_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })) as unknown as typeof fetch

    try {
      await expect(
        postJson('/api/session.start', {}, {}, 5),
        'the request must be abandoned, not awaited forever',
      ).rejects.toThrow()
    } finally {
      globalThis.fetch = original
    }
  })

  it('the deadline outlives the stream client’s, so the stream client is the one that acts', () => {
    // Stated in the source as the reason for the two numbers. The stream client can schedule a
    // retry; this can only abort. If this fired first, the recovery would be a bare rejection
    // instead of a backed-off reconnect.
    expect(REQUEST_DEADLINE_MS).toBeGreaterThan(URL_DEADLINE_MS)
  })

  it('a rejected request reaches the caller rather than being flattened', async () => {
    // The caller distinguishes 403 from 429 from "no answer at all". Swallowing the rejection here
    // would turn the last one into a silent success with an undefined body.
    await withFetch(async () => { throw new Error('aborted') }, async () => {
      await expect(postJson('/api/session.start', {}, {})).rejects.toThrow()
    })
  })

  it('a non-JSON body is a status, not an exception', async () => {
    // An error response may legitimately be empty; letting the parse throw would turn "the server
    // said 503" into "something went wrong".
    await withFetch(async () => ({
      status: 503,
      json: async () => { throw new Error('not json') },
    } as unknown as Response), async () => {
      const reply = await postJson('/api/session.start', {}, {})
      expect(reply).toEqual({ status: 503, body: null })
    })
  })
})

/**
 * **§12's `keepalive`, which this build had been missing since the clause was written.**
 *
 * > *"The flush request MUST carry `keepalive: true`. Without it the browser is permitted to cancel
 * > an in-flight request as the page freezes or unloads, so the correct trigger fires and the save
 * > still does not land."* — added to the spec 2026-08-06 **from an earlier app, which ships it in
 * > production**.
 *
 * This build had the triggers and not the flag: the exact state the clause was written about. Found
 * by P12's "every MUST has a test" inventory on 2026-08-15 — the inventory's first real catch, and
 * the reason it is a definition-of-done item rather than paperwork.
 */
describe('a request is not cancelled when the page goes away', () => {
  const fetchSeen = (): { calls: RequestInit[]; fetch: typeof globalThis.fetch } => {
    const calls: RequestInit[] = []
    const fake = (async (_url: string, init: RequestInit) => {
      calls.push(init)
      return {
        status: 200,
        json: async () => ({ ok: true }),
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    return { calls, fetch: fake }
  }

  it('carries keepalive on an ordinary request', async () => {
    const seen = fetchSeen()
    const original = globalThis.fetch
    globalThis.fetch = seen.fetch
    try {
      await postJson('/api/file.save', { content: 'a note' }, {})
    } finally {
      globalThis.fetch = original
    }
    expect(seen.calls[0]?.keepalive, 'the request may be cancelled during teardown').toBe(true)
  })

  it('drops keepalive above the browser cap, because the request would be REJECTED', () => {
    // Not an optimisation: a keepalive fetch is capped at 64 KiB of body and a larger one fails
    // outright. Setting it unconditionally trades a rare cancellation for a certain failure on
    // every save of a large document.
    expect(KEEPALIVE_MAX_BODY_BYTES).toBe(64 * 1024)
  })

  /**
   * **THE CAP IS BYTES; `String.length` IS UTF-16 CODE UNITS.** They agree only for ASCII.
   *
   * The size test used `payload.length`, so every non-ASCII document was under-counted by up to a
   * factor of three. Over the real cap the browser rejects a `keepalive` fetch outright — `fetch`
   * returns a network error before anything leaves the machine, so the server never sees it and no
   * log records it. And because `postJson` is the single path for every API call, the ordinary
   * autosave failed too: the document could not be saved from the browser at all.
   *
   * This fixture is the discriminating case and nothing else is. Its code-unit length is *under*
   * the cap while its UTF-8 size is *over* it, so it passes the old test and fails the new one.
   */
  it('measures the cap in BYTES, not characters — the non-ASCII case', async () => {
    // Each of these is one UTF-16 code unit and three UTF-8 bytes.
    const content = '\u65e5'.repeat(30_000)
    const payload = JSON.stringify({ content })

    expect(payload.length, 'under the cap when counted the wrong way')
      .toBeLessThan(KEEPALIVE_MAX_BODY_BYTES)
    expect(new TextEncoder().encode(payload).length, 'and over it when counted correctly')
      .toBeGreaterThan(KEEPALIVE_MAX_BODY_BYTES)

    const seen = fetchSeen()
    const original = globalThis.fetch
    globalThis.fetch = seen.fetch
    try {
      await postJson('/api/file.save', { content }, {})
    } finally {
      globalThis.fetch = original
    }

    expect(seen.calls[0]?.keepalive, 'the browser would reject this request outright').toBe(false)
  })

  it('drops it for a body over the cap', async () => {
    const seen = fetchSeen()
    const original = globalThis.fetch
    globalThis.fetch = seen.fetch
    try {
      await postJson('/api/file.save', { content: 'x'.repeat(KEEPALIVE_MAX_BODY_BYTES) }, {})
    } finally {
      globalThis.fetch = original
    }
    expect(seen.calls[0]?.keepalive, 'an oversized keepalive request is rejected outright')
      .toBe(false)
  })
})
