/**
 * The slide-over panel. Annex **A25**, and the PRD's *"card tap opens a slide-over panel with the
 * full editor beside the board."*
 *
 * A25 states the contract precisely, so this file implements it rather than inventing one:
 *
 * > `min(560px, 70%)`, 180ms translateX, xl shadow, left hairline, over a board that stays mounted
 * > and interactive; Esc closes; outside click closes (board-card exemption); different card
 * > swaps; same card closes; **Esc ownership handoff so one press doesn't double-fire**;
 * > mount-then-animate via rAF.
 *
 * ## The three that are easy to get wrong
 *
 * **The board stays interactive.** This is not a modal. There is no backdrop that swallows clicks,
 * because the point of a slide-over is reading a card while still dragging the ones behind it.
 * Everything a modal gets for free — focus trapping, click blocking — is deliberately absent.
 *
 * **A click on another card is a swap, not a dismissal.** Without the exemption, clicking card B
 * while A is open closes the panel *and* opens it again, which is a flicker and, worse, tears down
 * A's editor via the close path instead of the swap path.
 *
 * **Escape ownership.** Four dialogs in this app already listen for Escape in the capture phase.
 * Without a handoff, one press closes the panel *and* whatever else is listening. So the panel
 * refuses Escape whenever a modal is above it — the modal is the newer, higher layer and the press
 * is its — and only acts when it is the top thing on screen.
 *
 * ## Teardown is the caller's, and it is awaited
 *
 * `open` takes a render function that may return a teardown. The panel awaits it before the
 * contents are replaced or removed, which is what makes §13's rule hold across this surface:
 * *"pending edits are never silently dropped — closing a panel, switching files, or quitting
 * flushes or asks."* A swap is a close of the outgoing document, so it flushes too.
 *
 * ## And because the teardown is the flush, nothing here may interleave
 *
 * security review, P9-2: `open` and `close` were `async`, re-entrant and unguarded, and two taps arriving
 * during one slow teardown was enough to lose an edit. Both now queue on a single chain — see
 * `queued` below. That is the whole fix, and it is a **stronger** guarantee than re-checking a
 * generation counter after every `await`, because the state is never mutated by two callers at all.
 */

import { append, clear, el, onDocument } from '../dom'

/** A25's transition. Exported so a test asserts the number rather than a copy of it. */
export const PANEL_SLIDE_MS = 180

/** Cleanup for whatever was rendered. Awaited before the panel changes or closes. */
export type PanelTeardown = () => void | Promise<void>

export interface CardPanel {
  /**
   * Show `key`'s contents. **Opening the key that is already open closes the panel** — A25's
   * same-card-closes, which is what makes a card a toggle rather than a one-way door.
   */
  readonly open: (key: string, render: (host: HTMLElement) => PanelTeardown | void) => Promise<void>
  readonly close: () => Promise<void>
  /**
   * The key currently shown, or `null`.
   *
   * Read **synchronously**, and it reports the last *settled* state — a call queued behind another
   * has not run yet and is not visible here. The one caller wants exactly that: `showTab` asks
   * "is anything open on this board" before closing it, and a queued open is not yet open.
   */
  readonly openKey: () => string | null
  /**
   * Detaches listeners, **flushes whatever is mounted**, and removes the panel.
   *
   * The flush is the part that was missing (security review, P9-2): `destroy` used to drop the teardown on
   * the floor, so tearing down a surface with an editor in it discarded the edit. It is `async` for
   * that reason — there is a save in here, and a caller that cannot await it cannot be sure of it.
   *
   * **Called by nothing today.** The panels in `main.tsx` are created once at boot and live for the
   * life of the app; no product code destroys one. Fixed rather than deleted because deleting a
   * public affordance is a decision for the operator, and recorded in `build/open-items.md` so it does
   * not read as covered.
   */
  readonly destroy: () => Promise<void>
}

export interface CardPanelOptions {
  /**
   * Classes a click may land on without closing the panel — A25's *"board-card exemption"*.
   * A click on a card is a swap, and the swap is performed by that card's own handler.
   */
  readonly exemptClasses: readonly string[]
  /**
   * True when something is stacked above the panel and owns the keyboard. The panel declines
   * Escape while it is, rather than both layers acting on one press.
   */
  readonly blockedByOverlay: () => boolean
  /**
   * **True when this panel becomes a SCREEN on a phone rather than a slide-over.**
   *
   * the operator, after using the app on their phone: *"when you open a card it takes up half the page —
   * which I think is good for desktop, but for mobile I feel like we should just treat it like
   * Files, where it should open the whole page, because it gets crunched."* Measured: 262px of a
   * 390px screen, leaving a 112px sliver of board.
   *
   * **Tasks and Inbox set this; Projects does not**, and that distinction is their: *"projects is okay
   * as a side file, but tasks should open the whole thing."*
   *
   * A flag rather than a width, because the difference is not size. A full-screen panel has no
   * outside to click, so it needs a back control instead — which is what closes the exit problem they
   * described rather than patching it.
   *
   * **`'both'` is the Inbox, and it is the ruling of 2026-08-16.** Asked whether a desktop
   * inbox item should open full-screen like the phone's or keep the side panel, they answered *"yes"*
   * to full-screen. Filing is the whole job of that screen and a 45% sliver is not where you read
   * something to decide what to do with it. Tasks stays `'phone'`: on a desktop the board behind
   * the panel is the context you are moving a card within.
   */
  /**
   * `'both'` is retained and **currently used by nothing.** The Inbox was its only caller, on
   * the ruling of 2026-08-16; they reversed that on 2026-08-19 after using it — *"they should be
   * side panels for desktop"* — because the list now opens documents AND folders, and two
   * behaviours in one list reads as broken even when deliberate.
   *
   * Kept rather than deleted: it is one branch, the argument for it was real, and a surface whose
   * whole job is filing may well want it again. Its CSS is `is-fullscreen-both`.
   */
  readonly fullScreen?: 'phone' | 'both'
}

export function createCardPanel(parent: HTMLElement, options: CardPanelOptions): CardPanel {
  const full = options.fullScreen
  const panel = el('aside', {
    className: full === undefined
      ? 'card-panel'
      : `card-panel is-fullscreen-${full === 'both' ? 'both' : 'phone'}`,
    attributes: { role: 'complementary', 'aria-label': 'Card', hidden: 'true' },
  })
  const body = el('div', { className: 'card-panel-body' })
  append(panel, body)
  append(parent, panel)

  let key: string | null = null
  let teardown: PanelTeardown | null = null
  let destroyed = false

  /**
   * **One state change at a time.** Every entry point below runs through here, and this is the fix
   * for P9-2 in its entirety.
   *
   * The module was written as though `open` and `close` ran to completion once entered. They do not:
   * both `await` a caller-supplied teardown, and the teardown mounted on this panel flushes a
   * document to disk — a network round trip, on a phone, on a bad connection. Everything after that
   * `await` resumed against state a *later* tap had already changed. The security review found three distinct
   * losses in the unguarded version, and only the third looks like a race:
   *
   * - Tap B, tap C while B's flush is in flight → both `open` calls got past the same-key check,
   *   both called `release()`, and the second found `teardown` already nulled by the first. C
   *   rendered, C's teardown was stored, and **B's edit was never flushed**.
   * - An `open` landing inside a `close` → the close resumed and ran `clear(body)` over the new
   *   contents, leaving a panel that reported C, showed nothing, and slid shut believing it was open.
   * - `destroy()` never released at all.
   *
   * A promise chain fixes all three by construction: a second call cannot begin until the first has
   * settled, so no reader ever sees half-applied state and no teardown is skipped. There is nothing
   * to re-check after an `await`, because nothing else can have run.
   *
   * **The chain must not carry a rejection forward.** A teardown that throws — a flush that 500s —
   * would otherwise poison every later open and close on this panel, which is a panel that can
   * never be closed again. So the chain is caught while the *caller's* promise keeps the rejection,
   * because the caller is the one who can report it.
   *
   * **A queued job must never await another one.** A teardown that calls `open` or `close` on its
   * own panel deadlocks: the chain waits on a job that waits on the chain. Nothing does today, and
   * the teardowns live one file up in `main.tsx` where that is visible.
   */
  let chain: Promise<void> = Promise.resolve()
  const queued = (job: () => Promise<void>): Promise<void> => {
    const settled = chain.then(job)
    chain = settled.catch(() => {
      /* the caller keeps this rejection; the chain has to stay usable for the next card */
    })
    return settled
  }

  /** Runs and forgets the current teardown. Awaited — this is where a document flushes. */
  const release = async (): Promise<void> => {
    const run = teardown
    teardown = null
    if (run !== null) await run()
  }

  const closeNow = async (): Promise<void> => {
    if (key === null) return
    key = null
    await release()
    // The class comes off first so the slide-out animates, and the element is hidden only after —
    // `hidden` removes it from layout immediately, which would make the transition invisible.
    panel.classList.remove('is-open')
    /**
     * The one thing here that runs OUTSIDE the chain, so it is the one thing that still needs a
     * guard. `key === null` is that guard and it is sufficient: the only way the panel should stay
     * on screen at +180ms is if something re-opened it, and re-opening is the only thing that sets
     * a key. A generation counter was written here first and then removed — every sequence it
     * distinguished ended in the same attribute, so it was a control that could not be observed to
     * fail, which in this build is a control that gets believed rather than tested.
     */
    setTimeout(() => {
      if (key === null) panel.toggleAttribute('hidden', true)
    }, PANEL_SLIDE_MS)
    clear(body)
  }

  const openNow = async (
    next: string, render: (host: HTMLElement) => PanelTeardown | void,
  ): Promise<void> => {
    // A25: the same card closes. Checked before anything is torn down or drawn.
    if (key === next) { await closeNow(); return }

    // A swap: the outgoing contents are released — and flushed — before the new ones are drawn.
    await release()
    clear(body)
    key = next

    const wasOpen = panel.classList.contains('is-open')
    panel.toggleAttribute('hidden', false)
    teardown = render(body) ?? null

    /**
     * **Mount, then animate — by forcing a style flush, NOT by waiting for a frame.**
     *
     * A25 asks for mount-then-animate, and the reason is real: a class added in the same breath as
     * the element's insertion is not a transition, because the browser has no prior value to
     * interpolate from and the panel would simply appear.
     *
     * The obvious way to get a prior value is `requestAnimationFrame`, and that is what this did
     * first. **It shipped a panel that opened into nothing.** rAF only runs while the page is
     * actually rendering, so in a tab that is occluded, backgrounded, or minimised the callback
     * never fires — measured here as zero callbacks in 300ms — and `is-open` was the only thing
     * that brought the panel on screen. The result was a panel that un-hid, rendered its contents
     * correctly, and sat parked off the right edge of the viewport, permanently. Switching apps
     * mid-tap on a phone is enough to reproduce it.
     *
     * Reading a layout property forces the browser to resolve style and layout *now*, with the
     * pre-class transform still in effect. That gives the transition its starting value
     * synchronously, so the end state is correct whether or not a frame is ever painted: a tab
     * that is not rendering has no animation to show anyway, and it arrives open rather than
     * arriving nowhere. Skipped on a swap, where the panel is already in place and must not slide
     * again.
     */
    if (!wasOpen) {
      void panel.offsetWidth
      panel.classList.add('is-open')
    }
  }

  /**
   * The two public entry points, and the only two ways state changes. Both queue.
   *
   * A destroyed panel accepts neither. It has already flushed and removed itself, so an `open`
   * arriving late would mount an editor into a detached element — a surface that takes keystrokes
   * and saves none, which is the failure C3 is about, arrived at from the other direction.
   */
  const open = (
    next: string, render: (host: HTMLElement) => PanelTeardown | void,
  ): Promise<void> => queued(async () => {
    if (destroyed) return
    await openNow(next, render)
  })

  const close = (): Promise<void> => queued(async () => {
    if (destroyed) return
    await closeNow()
  })

  /**
   * Escape, in the capture phase and **declined while a modal is above**.
   *
   * Capture because the panel may hold an editor, and CodeMirror handles keys itself; without
   * capture the press would be swallowed before it arrived.
   */
  const stopKeys = onDocument('keydown', raw => {
    const event = raw as KeyboardEvent
    if (event.key !== 'Escape' || key === null) return
    if (options.blockedByOverlay()) return
    event.preventDefault()
    // The press is consumed here so nothing further up acts on it — A25's ownership handoff.
    event.stopPropagation()
    void close()
  }, { capture: true })

  /**
   * Outside click. **Not a backdrop** — the board underneath stays live, so this listens on the
   * document and asks where the click landed instead of covering the screen with something that
   * eats it.
   */
  const stopClicks = onDocument('click', raw => {
    if (key === null) return
    const target = raw.target
    if (!(target instanceof Element)) return
    if (panel.contains(target)) return
    // A25's exemption: a click on a card swaps, and that card's own handler does it.
    if (options.exemptClasses.some(name => target.closest(`.${name}`) !== null)) return
    void close()
  })

  return {
    open,
    close,
    openKey: () => key,
    destroy: () => queued(async () => {
      if (destroyed) return
      destroyed = true
      // Listeners first: after this point neither Escape nor a stray click can queue more work,
      // so the release below is the last thing that ever touches the mounted contents.
      stopKeys()
      stopClicks()
      key = null
      await release()
      panel.remove()
    }),
  }
}
