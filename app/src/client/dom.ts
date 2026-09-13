/**
 * THE RENDERER. The one module permitted to touch the `document` global.
 *
 * Spec §8 bans the bare `document` identifier in client code so that escaping cannot be bypassed —
 * and the ban fired on the entry file the moment `src/client/` existed, which is the ban working.
 * But a client has to reach the DOM somewhere. The security review's amendment D settles how:
 *
 * > *"Replace it with a sanctioned, greppable mechanism (a named helper, or an allowlisted call),
 * > so a genuine [case] is visible in code and in review, not hidden in a line comment."*
 *
 * So this file is the allowlist, and it is an allowlist of **one**. `eslint.config.js` names it by
 * path in a single `ignores` entry; `noInlineConfig` means nobody can create a second one with a
 * comment; and `test/security/scope-boundary.test.ts` asserts the exception list has exactly this
 * member, so adding another is a test failure rather than a preference.
 *
 * WHAT IS **NOT** RELAXED HERE, and this is the important half: the HTML-sink bans still apply.
 * `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `srcdoc` and `document.write` are refused in this
 * file exactly as everywhere else — they live in the property and syntax scopes, which cover all of
 * `src/`. This module gets `document`. It does not get a way to inject markup.
 *
 * That distinction is the whole design. Agent-written markdown reaches this renderer, so
 * construction is `createElement` / `textContent` / `setAttribute` and nothing else. A
 * zero-dependency renderer that concatenates HTML leaks on the first unescaped quote.
 */

/*
 * `document` is referenced DIRECTLY below rather than through a module-level alias.
 *
 * The first version held `const doc = document` and used `doc.` everywhere — and the P3 review
 * found that `doc.write(markup)` produced **zero lint errors**, because the syntax selector that
 * bans `document.write` matches `[object.name='document']` and the alias is not named that. This
 * file's own header claimed the sink was "refused in this file exactly as everywhere else"; it was
 * not. That is the fifth time in this build a control has read as covering something it did not.
 *
 * Referring to the global by name is what keeps every `document.*` ban applicable here. An alias
 * would have to be re-banned separately, which is a rule that has to be remembered rather than one
 * that holds by construction.
 */

/**
 * The hard ceiling on any outbound request. Deliberately **longer** than the stream client's own
 * `URL_DEADLINE_MS`, so that on the stream path the stream client is always the one that acts — it
 * can schedule a retry, and this can only abort. Here this is socket hygiene, and the sole bound on
 * `call()`, which has no second layer behind it.
 */
export const REQUEST_DEADLINE_MS = 15_000

/**
 * The browser's cap on a `keepalive` fetch body — 64 KiB, across all in-flight ones. Not a number
 * this app chose; a request over it is rejected rather than merely cancellable. See `postJson`.
 */
export const KEEPALIVE_MAX_BODY_BYTES = 64 * 1024

export interface ElementOptions {
  readonly className?: string
  /** Set with `textContent`. There is deliberately no `html` option. */
  readonly text?: string
  readonly attributes?: Readonly<Record<string, string>>
}

/**
 * Creates an element.
 *
 * `setAttribute` for attributes and `textContent` for text — never a property assignment that could
 * be a sink, and never a string of markup. The signature is the control: there is no parameter that
 * accepts HTML, so a caller cannot pass any.
 */
export function el(tag: string, options: ElementOptions = {}): HTMLElement {
  const node = document.createElement(tag)
  if (options.className !== undefined) node.setAttribute('class', options.className)
  if (options.text !== undefined) node.textContent = options.text
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    node.setAttribute(name, value)
  }
  return node
}

/** Replaces a node's children. Text only, never markup. */
export function setText(node: Element, text: string): void {
  node.textContent = text
}

/** The SVG namespace. `createElement` produces an inert HTML element for these tags, not a shape. */
const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * A line icon, built node by node.
 *
 * **Not `innerHTML`, for the reason `el` has no `html` option**: an icon is markup that never comes
 * from a person, and that is exactly how every markup sink starts. The signature takes path data and
 * a size — there is no parameter a caller could put a `<script>` in.
 *
 * `createElementNS` rather than `createElement`, which is the whole reason this cannot live in `el`:
 * an `<svg>` made in the HTML namespace parses, appends, reports a box, and draws nothing at all.
 *
 * `stroke="currentColor"` so an icon takes the colour of the control holding it and hover states
 * stay one rule. `aria-hidden`, because every caller here is a button that already has a label —
 * an icon that announces itself makes the control say its name twice.
 */
export function icon(paths: readonly string[], size: number): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/**
 * A listener on the document, and the reason it lives here rather than at the call site.
 *
 * `document` is banned outside this file — *"use the renderer helpers rather than the document
 * global directly, so escaping cannot be bypassed"*. That rule is aimed at the construction sinks,
 * and a `keydown` listener is not one; but the ban is on the **global**, which is what keeps it
 * simple enough to hold. So the exception is granted once, here, in the file whose whole subject is
 * being the only place that touches it — rather than by a disable comment on every dialog that
 * needs Escape.
 *
 * Returns its own removal, because a document listener that outlives what it belongs to is a menu
 * closing a dialog that no longer exists.
 */
export function onDocument(
  type: string,
  handler: (event: Event) => void,
  /**
   * `passive` was added for §18.2's scroll listener, and it is a correctness concern on a phone
   * rather than a tuning one: the browser must assume a non-passive handler might call
   * `preventDefault`, so it waits for it before painting the next frame. On a scroll that is the
   * difference between tracking the thumb and stuttering behind it.
   *
   * Removal still keys on `capture` alone — that is what the DOM matches listeners by — so a
   * listener registered as passive is removed by the returned function exactly as before.
   */
  options?: { readonly capture?: boolean; readonly passive?: boolean },
): () => void {
  const capture = options?.capture ?? false
  document.addEventListener(type, handler, { capture, passive: options?.passive ?? false })
  return () => { document.removeEventListener(type, handler, capture) }
}

/**
 * True when the focused element carries this class.
 *
 * Here rather than at the call site because `document` is banned in view modules — §8's rule that
 * everything touching the document goes through this file, so escaping cannot be bypassed
 * somewhere nobody is looking.
 *
 * It exists for one job: a view that repaints on every keystroke destroys the input being typed
 * into, so it has to know whether to put focus back. Asked **before** the teardown, because
 * afterwards the focused element no longer exists and the answer is always no.
 */
export function focusHasClass(className: string): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && active.classList.contains(className)
}

/**
 * `focusHasClass` when knowing *which one* matters.
 *
 * The Tasks board draws one quick-add per lane, all with the same class, and a repaint replaces
 * every one of them. "Was the caret in a quick-add" is not enough to put it back — the answer has
 * to name the lane, or typing into `Next` while an agent writes a file lands the caret in
 * `Uncategorized`. Returns the attribute rather than the element so nothing outside this module
 * ends up holding a node it did not create.
 */
export function focusedAttribute(className: string, attribute: string): string | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !active.classList.contains(className)) return null
  return active.getAttribute(attribute)
}

export function byId(id: string): HTMLElement | null {
  return document.getElementById(id)
}

/**
 * Set an attribute on the root element. Spec §18.1's layout mode is the only caller.
 *
 * **Here rather than in `layout-mode.ts` because that module may not reach `document` directly** —
 * the `no-restricted-globals` ban routes every use through this file, so §8's escaping rules cannot
 * be stepped around by a module that had a good reason. This one *did* have a good reason
 * (`setAttribute` on the root is not an escaping sink), and the answer is still a helper here rather
 * than a suppression there: a rule with one exemption in it is a rule someone else will claim next.
 *
 * Attribute, never a class, and never `style`: the mode is a single value with two states, and CSS
 * reads it with one attribute selector.
 */
export function setRootAttribute(name: string, value: string): void {
  document.documentElement.setAttribute(name, value)
}

export function append(parent: Element, ...children: readonly Element[]): void {
  for (const child of children) parent.appendChild(child)
}

/** Removes every child. `replaceChildren()` rather than `innerHTML = ''`, which is a banned sink. */
export function clear(node: Element): void {
  node.replaceChildren()
}

/**
 * How long after a return the duplicate event is ignored.
 *
 * **Suppress-AFTER-firing.** The design before this deferred the first call by 50ms and merged
 * anything inside that window, which made correctness depend on the gap between `visibilitychange`
 * and `focus` on iOS — a number nobody has measured. A review found the cliff exactly at the
 * constant: 45ms apart merged, 60ms apart did not. A wrong guess there silently reverts the fix.
 *
 * Leading-edge inverts that dependency: the window no longer decides whether recovery happens, only
 * whether the *second* event is redundant.
 *
 * **250ms, not the 1000ms this started at.** A fourth round pointed out that the longer window was
 * buying the wrong thing — it saved one request per return while owning a lost-wakeup class, against
 * this module's own rule that a wasted ticket is cheap and a missed wakeup is a dead app. Two
 * genuine returns 700ms apart were being counted as one. Deriving the ticket pool from the rate
 * limiter made the request cheaper still, so the window is now sized to merge **one user action** and
 * nothing beyond it.
 */
export const VISIBILITY_SUPPRESS_MS = 250

/**
 * The browser objects this needs, injected. The unit environment is `node` with no DOM, and the one
 * control standing between the operator and a permanently dead app should not be the module that cannot
 * be tested.
 */
export interface VisibilitySeam {
  readonly onVisibilityChange: (listener: () => void) => void
  readonly onWindowFocus: (listener: () => void) => void
  /**
   * §12's second flush trigger. **Required, not optional, and that is the fix rather than a style
   * choice** — the same lesson `actionsFor`'s `context` produced on the same day. Until 2026-08-16
   * `pagehide` existed in this build only inside a comment in `save-policy.ts` saying it was one of
   * three overlapping triggers. An optional seam member would let the next seam forget it in
   * exactly the silence that hid it for eleven days.
   */
  readonly onPageHide: (listener: () => void) => void
  /** §12's third. Required for the same reason. */
  readonly onBeforeUnload: (listener: () => void) => void
  readonly isVisible: () => boolean
  readonly now: () => number
}

const browserVisibility = (): VisibilitySeam => ({
  onVisibilityChange: l => { document.addEventListener('visibilitychange', l) },
  onWindowFocus: l => { globalThis.addEventListener('focus', l) },
  onPageHide: l => { globalThis.addEventListener('pagehide', l) },
  /**
   * **Bound, and nothing is done to the event.** No `preventDefault`, no `returnValue` — either one
   * turns this into a "leave site?" prompt, which §12 asks for nowhere and which would put a modal
   * between the operator and closing a tab.
   *
   * **The cost, stated rather than discovered later:** registering a `beforeunload` listener can
   * disqualify a page from the back/forward cache in some browsers, so a back-navigation may reload
   * instead of restoring instantly. That is a real trade and it is made deliberately — §12 requires
   * the third trigger because *no end-of-session event is guaranteed on mobile WebKit*, and this app
   * is a tool someone edits in, not a page someone navigates back to. Losing an edit is
   * unrecoverable; losing a warm restore is a slower reload.
   */
  onBeforeUnload: l => { globalThis.addEventListener('beforeunload', l) },
  isVisible: () => document.visibilityState === 'visible',
  /**
   * MONOTONIC. `Date.now()` is a wall clock and was the wrong one: an NTP correction, a manual Date
   * & Time change or a carrier time update steps it backwards, and a backwards step made every
   * reading smaller than the last — suppressing *every* genuine return until the clock climbed back.
   * A 30-second step swallowed 29 of 30 consecutive returns. Nothing here needs wall time.
   *
   * The comparison below is written to survive a backwards step anyway. Both, because a control that
   * depends on somebody picking the right clock is one that gets re-broken.
   */
  now: () => performance.now(),
})

/**
 * Visibility and focus events, in one place.
 *
 * Both are bound and neither alone is enough — spec §15 requires the stream be reopened on
 * `visibilitychange` → visible *and* on `window.focus`, because a suspended `EventSource` can come
 * back dead without firing `error` and there is no other signal to act on.
 *
 * **LEADING EDGE: the first event of a return runs the listener SYNCHRONOUSLY**, and the duplicate
 * that follows is ignored. Two reasons, and the second is the one that matters.
 *
 * The cheap reason is that both events fire on one return, so the listener ran twice per user action
 * — two tickets minted, one used.
 *
 * The load-bearing reason is that the first attempt at this deferred recovery into a `setTimeout`.
 * That put the single iOS recovery path behind a timer on a platform that suspends timers, and it
 * made the merge depend on an unmeasured inter-event gap. Firing on the edge means recovery has
 * already happened by the time the handler returns — nothing to freeze, nothing to miss.
 *
 * **`focus` is deliberately NOT gated on `visibilityState`.** A `focus` arriving while the document
 * still reads hidden costs one ticket and one abandoned connect, which is cheap. Dropping it would
 * cost a *lost wakeup* if iOS ever ordered the two the other way — and a lost wakeup is the exact
 * failure this whole path exists to prevent. The asymmetry is the point, not an oversight.
 */
/**
 * §12's flush contract: **all three** end-of-session triggers, bound independently.
 *
 * The mirror of `onBecameVisible`, and it exists for the opposite reason. That one recovers a dead
 * stream; this one is the last chance to write an edit.
 *
 * ## Why three, and why this function used to be one
 *
 * `save-policy.ts` has described *"three overlapping triggers plus idempotency"* since 2026-08-05,
 * and the build plan named all three as a gated P6 deliverable. **Only `visibilitychange` was ever
 * wired.** `pagehide` and `beforeunload` appeared nowhere in `src/` except inside the comment
 * asserting they were there. The deep sweep of 2026-08-16 found it; this function is the fix, and
 * it replaces `onBecameHidden`, which bound one event under a name that sounded like it bound the
 * contract.
 *
 * The redundancy is not belt-and-braces. §12: *"no end-of-session event is guaranteed on mobile
 * WebKit."* Open the page, switch apps, close the browser from the app switcher — neither `pagehide`
 * nor `beforeunload` is dispatched. Close a desktop Safari tab with the (X) — neither
 * `visibilitychange` nor `pagehide` is. There is no single event to be correct about, so the design
 * is three overlapping chances and a flush cheap enough to fire all three.
 *
 * ## Three separate bindings, deliberately
 *
 * Not one handler registered three times, and not a loop. Each trigger is the *only* one that
 * arrives in some real scenario, so one of them throwing must not take the other two with it — the
 * listener here calls `retainNow()` and `doc.flush()` while the surface is being torn down
 * underneath it. `dom.test.ts` pins that: an earlier trigger that throws leaves the later ones
 * running.
 *
 * ## No suppression window, unlike its twin
 *
 * A duplicate reconnect costs a wasted ticket, so `onBecameVisible` debounces. A duplicate *flush*
 * costs nothing: it is gated on a dirty flag, and `shouldSave` answers `false` on a clean buffer.
 * §12 requires all three to be idempotent **precisely so that no single event is load-bearing** —
 * debouncing here would quietly rebuild the single point of failure this function exists to remove.
 */
export function onSessionEnding(listener: () => void, seam: VisibilitySeam = browserVisibility()): void {
  seam.onVisibilityChange(() => { if (!seam.isVisible()) listener() })
  seam.onPageHide(listener)
  seam.onBeforeUnload(listener)
}

export function onBecameVisible(listener: () => void, seam: VisibilitySeam = browserVisibility()): void {
  // Far enough in the past that the first event is never suppressed, whatever the clock reads.
  let lastFiredAt = Number.NEGATIVE_INFINITY

  const fire = (): void => {
    const at = seam.now()
    // `at >= lastFiredAt` first, so a reading EARLIER than the last can never be read as a
    // duplicate. Without it a clock that steps backwards makes every difference negative and
    // suppresses every genuine return until the clock climbs back — a dead recovery path for the
    // length of the step, on the one mechanism that has no fallback.
    if (at >= lastFiredAt && at - lastFiredAt < VISIBILITY_SUPPRESS_MS) return
    // Stamped BEFORE the call, so a listener that throws cannot be re-entered by the paired event.
    lastFiredAt = at
    listener()
  }

  seam.onVisibilityChange(() => { if (seam.isVisible()) fire() })
  seam.onWindowFocus(fire)
}

/** Opens an `EventSource`. Here because it is browser API, and the client should have one door. */
export function openEventSource(url: string): EventSource {
  return new EventSource(url)
}

/**
 * **Fetches a file's bytes as text, with the same request discipline `postJson` carries.**
 *
 * Added 2026-08-16 for the security review's G2. The non-editing pane called bare `fetch(url)` — no
 * `credentials: 'omit'`, no `cache: 'no-store'`, and **no abort deadline**.
 *
 * **The deadline is the sharp end, not the credential**, and the security review renamed it after the referral had
 * it the other way round. `dom.ts` already records the lesson one paragraph down: *"`fetch` has no
 * default timeout, and a request that is dropped rather than refused never settles — so an `await`
 * on it waits forever, holding the socket."* This call is consumed as
 * `void readText(entry).then(ok, err)`, so a dropped request left the pane reading "Loading…"
 * indefinitely, the promise never settling and the socket held. It was written *after* that lesson
 * was paid for and did not get it.
 *
 * **A GET, and deliberately so** — unlike `postJson`, whose POST-with-JSON shape is a CSRF control.
 * This reads a file the caller can already read and changes nothing; forcing it to POST would buy
 * nothing and break `<img src>` and `<iframe src>`, which reach the same route and **cannot** set
 * headers at all. Those two are why `no-store` on this call is a habit rather than the control: the
 * control that governs all three is the response header, which `file-route.ts` sets on every reply.
 *
 * `credentials: 'omit'` for the same reason it is on `postJson` — the app has no cookies and must
 * never acquire the habit.
 */
export async function getText(
  url: string,
  /** Overridable ONLY so the deadline can be proven to fire — see `postJson`'s note. */
  deadlineMs: number = REQUEST_DEADLINE_MS,
): Promise<string> {
  const response = await fetch(url, {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(deadlineMs),
  })
  if (!response.ok) throw new Error('could not read that file')
  return response.text()
}

/**
 * The client's outbound JSON call. **Not the only outbound HTTP call** — `getText` above fetches
 * file bytes, and `openEventSource` opens the stream.
 *
 * That sentence used to read *"the only outbound HTTP call in the client"*, and it was corrected on
 * 2026-08-16 because it is the **premise** of the CSRF argument in the paragraph it heads, not a
 * stray boast: a reader checking that argument would have checked it against a fact that stopped
 * being true. The argument itself survives intact — it is about *this* call's shape, and `getText`
 * is a GET that changes nothing.
 *
 * **POST with `Content-Type: application/json`, always** — and that is a security property, not a
 * convention. Spec §7 requires the content type on every non-static route precisely because it is a
 * *non-simple* request: it forces a cross-origin caller into a preflight, and the preflight then
 * fails because the server sends no CORS headers. A GET, or a form-encoded POST, would be a request
 * a hostile page could make directly.
 *
 * `credentials: 'omit'` and `cache: 'no-store'` are stated rather than left to the default: the
 * app has no cookies and must never acquire the habit, and a cached API response is a file listing
 * sitting in a disk cache after the app is closed.
 *
 * The reply is returned as a status and a parsed body rather than thrown on, because every non-200
 * here is a case the caller must decide about — a 403 means renew the session, a 429 means back off,
 * and an exception would flatten that distinction into one shape.
 */
export async function postJson(
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  /**
   * Overridable ONLY so the deadline can be proven to fire. A review found the test for it asserted
   * that a signal was *present* and not aborted — which a signal that never fires satisfies — so
   * swapping `AbortSignal.timeout(…)` for a bare `AbortController().signal` left the suite green.
   * Third round running that this same control was written up as covered and was not.
   *
   * Production never passes this. Fifteen seconds is not waitable in a test, and a control nobody
   * can afford to watch fail is a control nobody has watched fail.
   */
  deadlineMs: number = REQUEST_DEADLINE_MS,
): Promise<{ status: number; body: unknown }> {
  /**
   * **§12's `keepalive`, and it was missing.** The spec is explicit: *"The flush request MUST carry
   * `keepalive: true`. Without it the browser is permitted to cancel an in-flight request as the
   * page freezes or unloads, so the correct trigger fires and the save still does not land."* It was
   * added to the spec on 2026-08-06 *from an earlier app, which ships this in production* — and this build had
   * the triggers and not the flag, which is the exact state that clause was written about. Found by
   * P12's "every MUST has a test" inventory, 2026-08-15.
   *
   * **Set here rather than threaded down from the flush**, and the reason is not convenience. The
   * flush reaches this function through four layers — `flush` → `write` → `transport.save` →
   * `call` — and a flag passed through four layers is four places to forget it. `keepalive` only
   * ever *means* "do not cancel this when the page goes away", so it is correct on any request small
   * enough to carry it, and load-bearing on exactly one.
   *
   * **THE SIZE CONDITION IS NOT AN OPTIMISATION — it is the browser's rule.** A `keepalive` fetch is
   * capped at 64 KB of body across all in-flight ones, and a request over that is **rejected
   * outright** rather than merely uncancellable. Setting it unconditionally would turn every save of
   * a large document into an immediate failure — trading a rare cancellation for a certain one.
   *
   * **The residual, stated rather than hidden:** a document above the cap still gets a flush that a
   * browser may cancel during teardown. `open-items.md` carries it; the fix is a partial write API
   * this app does not have.
   */
  const payload = JSON.stringify(body)

  /**
   * **Measured in BYTES, which is what the browser's cap is in — `.length` is UTF-16 code units.**
   *
   * The two agree only for ASCII. A character outside it costs one code unit and two, three or four
   * bytes, so `payload.length` under-counts every non-English document and every one carrying curly
   * quotes or em-dashes. The constant is named `..._BYTES`; the test against it was not.
   *
   * **The failure is total and silent.** Over the cap, a `keepalive` fetch is rejected by the browser
   * outright — `fetch` returns a network error before anything leaves the machine, so the server
   * never sees it and nothing appears in any log. `postJson` is the single path for every API call,
   * so this is not confined to the exit flush: the ordinary autosave fails too, and the document
   * simply cannot be saved from the browser. A 70,000-character English note was fine; a
   * 25,000-character Japanese one was not.
   *
   * `retained-buffer.ts` already measures bytes with a `TextEncoder`, for this reason, in this
   * codebase.
   */
  const survivesTeardown = new TextEncoder().encode(payload).length <= KEEPALIVE_MAX_BODY_BYTES

  const response = await fetch(path, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    keepalive: survivesTeardown,
    /**
     * **`fetch` has no default timeout**, and a request that is dropped rather than refused never
     * settles — so an `await` on it waits forever, holding the socket. That produced a client with
     * no stream, no pending retry, and a status line still reading "Live".
     *
     * The stream client deadlines its own await as well, and that is the control: it can schedule a
     * retry, which this cannot. This one exists so the abandoned request is actually released
     * instead of accumulating one dead socket per return to the app, and so the same protection
     * reaches `call()` — the API path, which has no second layer behind it.
     */
    signal: AbortSignal.timeout(deadlineMs),
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  })
  // A body that is not JSON is not an exception here — an error response may legitimately be empty,
  // and letting a parse failure throw would turn "the server said 503" into "something went wrong".
  const parsed: unknown = await response.json().catch(() => null)
  return { status: response.status, body: parsed }
}
