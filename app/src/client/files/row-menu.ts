/**
 * The "⋯" menu on a tree row. Annex A8, and the PRD's row-action list.
 *
 * PRD: *"Row actions ('⋯' — **always visible on touch**)"*. Always visible, not hover-revealed: a
 * hover affordance on a phone is an affordance that does not exist, and this app is used from one.
 *
 * **A8: the menu clamps to the viewport**, 8px inset, self-measuring. `clampToViewport` is P3's and
 * is not reimplemented here — a menu opened on the bottom row of a long tree must not render off
 * the screen, which is the whole of that annex item.
 */

import { append, el, onDocument } from '../dom'
import { isMobile } from '../layout-mode'
import { clampToViewport } from '../overlays'
import type { RowAction } from './row-actions'

/** What a menu can offer: something with an id and a label. `RowAction` satisfies it. */
export interface MenuChoice<Id extends string> {
  readonly id: Id
  readonly label: string
}

/**
 * **Generic over the id since §18.5.** It was `RowAction['id']`, a closed union of the tree's own
 * verbs, and the board's status picker offers **lane ids** — which are read off the disk and cannot
 * be enumerated in a type.
 *
 * The alternative was widening the id to `string`, which would have cost the tree the exhaustiveness
 * its `onChoose` switch depends on. A parameter keeps both: `RowAction[]` still infers the union.
 */
export interface RowMenuOptions<Id extends string = RowAction['id']> {
  /** Where the menu was asked for, in viewport coordinates. */
  readonly anchor: { readonly x: number; readonly y: number }
  readonly actions: readonly MenuChoice<Id>[]
  readonly onChoose: (id: Id) => void
  /** What the row is called, so the menu says what it acts on. */
  readonly subject: string
  /**
   * **The row this menu belongs to**, marked `has-menu` while it is up.
   *
   * Packet §4.6's *acted on* state, and half of the defect the operator reported: *"the last picked file
   * also stays highlighted while the one you're picking 3 dots on also is highlighted."* Without it
   * a menu names its subject in an `aria-label` and points at nothing on screen.
   *
   * **Held here rather than by each caller** because every way a menu closes is already in one
   * place — a choice, Escape, an outside click, a scroll — and a mark cleared by four callers is a
   * mark that survives whichever one someone forgets. Optional, so a caller with no row element
   * (the board's own menus arrive from a drag surface) is not forced to invent one.
   */
  readonly row?: HTMLElement
}

/**
 * Opens a menu and returns a function that closes it.
 *
 * One menu at a time is the caller's business — `createRowMenus` below holds that, because a stray
 * second menu is a state two independent openers cannot agree about.
 */
function openMenu<Id extends string>(
  parent: HTMLElement,
  /**
   * `onClose` is supplied by `createRowMenus`, never by a caller — it is the one `close()` that owns
   * every dismissal path, and a second way to shut a menu is a second state to keep in step.
   */
  options: RowMenuOptions<Id> & { readonly onClose: () => void },
): () => void {
  /**
   * §18.6 — **on a phone the menu comes up from the bottom edge, not down from the button.**
   *
   * The button does not move; the menu does. A dropdown anchored to a `⋯` near the top of a phone
   * screen puts every choice where the thumb is not, and clamping only guarantees it is *on* screen,
   * not that it is *reachable*. Below 768 px the anchor is therefore ignored entirely — the sheet
   * spans the bottom edge and does not need measuring, so the clamp is skipped rather than fed
   * coordinates it would only discard.
   */
  const sheet = isMobile()

  const menu = el('div', {
    className: sheet ? 'row-menu row-menu-sheet' : 'row-menu',
    attributes: { role: 'menu', 'aria-label': `Actions for ${options.subject}` },
  })

  /**
   * §4.8's sheet furniture: **a grabber, a header naming the target, and an explicit Close.**
   *
   * All three answer the same problem, which is that a sheet has no visible owner. A dropdown is
   * anchored to the `⋯` you pressed, so what it acts on is obvious; a sheet rises from the bottom
   * edge of the screen with the row it belongs to possibly scrolled out of view. Until now the
   * subject was named **only in the `aria-label`** — the one place a person looking at the screen
   * cannot read.
   *
   * The grabber is not a drag handle and does not pretend to be one. It is the shape a phone user
   * reads as *"this is a sheet, it dismisses downward"*, which is the affordance the outside-click
   * and Escape paths already provide.
   *
   * **Close is explicit because tapping outside a full-width sheet means tapping the app behind
   * it**, and on the tree screen that is another row — dismissing the menu and selecting something
   * in one gesture.
   */
  if (sheet) {
    append(menu, el('div', { className: 'row-menu-grabber', attributes: { 'aria-hidden': 'true' } }))
    append(menu, el('div', {
      className: 'row-menu-subject',
      text: options.subject,
      // The menu's own `aria-label` already says "Actions for <subject>"; this would repeat it.
      attributes: { 'aria-hidden': 'true' },
    }))
  }

  for (const action of options.actions) {
    const item = el('button', {
      className: 'row-menu-item',
      text: action.label,
      attributes: { role: 'menuitem', type: 'button' },
    })
    item.addEventListener('click', () => { options.onChoose(action.id) })
    append(menu, item)
  }

  if (sheet) {
    const close = el('button', {
      className: 'row-menu-close',
      text: 'Close',
      attributes: { type: 'button' },
    })
    /**
     * **Not `role="menuitem"`.** It performs no action on the row, and a screen reader counting
     * through a list of file operations should not find "Close" among them.
     *
     * **The handler is belt-and-braces, and this comment used to claim otherwise.** It said Close
     * could not lean on the outside-click path because that listener ignores presses inside the
     * menu. It does not: `onDocument('click', () => close())` below has no exemption at all, so
     * this button already closed the sheet with an empty handler. Found by breaking it and watching
     * the test pass.
     *
     * It stays because the day an exemption IS added — `card-panel` already carries
     * `exemptClasses` for exactly that reason — a Close button relying on a global "any click
     * dismisses" would stop working silently, and the mutation above shows no test would catch it.
     */
    close.addEventListener('click', () => { options.onClose() })
    append(menu, close)
  }

  /**
   * Placed off-screen first so it can be measured, then clamped, then shown.
   *
   * A8 calls the menu "self-measuring" for this reason: its height depends on how many actions the
   * row has — a file has four and a folder six — so a fixed offset would clear the bottom edge for
   * one and not the other.
   */
  if (sheet) {
    // Placed by the stylesheet against the bottom edge. No inline `style` at all, so a sheet cannot
    // inherit a stale `left`/`top` from a previous dropdown and end up half off the screen.
    append(parent, menu)
    return () => { menu.remove() }
  }

  menu.setAttribute('style', 'visibility: hidden; left: 0; top: 0')
  append(parent, menu)

  const box = menu.getBoundingClientRect()
  const placed = clampToViewport(
    options.anchor,
    { width: box.width, height: box.height },
    { width: window.innerWidth, height: window.innerHeight },
  )
  menu.setAttribute('style', `left: ${placed.x}px; top: ${placed.y}px`)

  return () => { menu.remove() }
}

export interface RowMenus {
  /** Opens the menu for a row, closing any other. */
  readonly open: <Id extends string>(options: RowMenuOptions<Id>) => void
  readonly close: () => void
  /** Removes the document-level listeners. */
  readonly destroy: () => void
}

/**
 * Holds the one-menu-at-a-time rule and the ways a menu closes.
 *
 * **Every close path is here rather than on the menu**, because a menu that can be left open is a
 * menu that acts on a row the person has since scrolled past. It closes on: a choice, Escape, a
 * click anywhere else, and a scroll — the last because the menu is positioned in viewport
 * coordinates and a scroll silently moves it away from the row it belongs to.
 */
export function createRowMenus(parent: HTMLElement): RowMenus {
  let closeCurrent: (() => void) | null = null
  /** Declared beside the menu it belongs to; the rule it carries is written at the listener below. */
  let armedForScroll = false
  /**
   * Whether the menu currently open is §18.6's sheet.
   *
   * **Captured when it opens, not asked for when a scroll arrives.** A phone rotated past 768 px
   * with a menu open would otherwise change the answer underneath a listener that is deciding
   * whether to dismiss it — and a menu that vanishes on rotation is indistinguishable from one that
   * crashed.
   */
  let sheetIsOpen = false

  /**
   * The row currently wearing `has-menu`, so `close` can take it off again.
   *
   * **Held rather than looked up.** Finding it by querying for the class would clear whatever
   * happens to carry it, which is the same bug in a different direction — and the tree redraws, so
   * the element that opened the menu may no longer be the one in the document by the time it shuts.
   * Removing a class from a detached node is harmless; removing it from the wrong live one is not.
   */
  let markedRow: HTMLElement | null = null

  const close = (): void => {
    closeCurrent?.()
    closeCurrent = null
    markedRow?.classList.remove('has-menu')
    markedRow = null
    // Disarmed with the menu, so the next one starts unarmed rather than inheriting this one's state.
    armedForScroll = false
    sheetIsOpen = false
  }

  /**
   * **A menu does not close on the scroll that opened it**, and that sentence is the whole of this
   * flag.
   *
   * Pressing "⋯" gives the button focus, and a browser brings a newly focused element fully into
   * view — so on a tree long enough to scroll, opening a menu **fires a scroll a moment later**.
   * With the listener below armed from the start, that scroll closed the menu before anyone could
   * reach it. Measured rather than reasoned: instrumenting the page during the failing run gave
   * `click on BUTTON.row-menu-button` → `MENU ADDED` → `scroll on DIV.tree` → `MENU REMOVED`.
   *
   * It presented as a **flaky test**, not as a bug: `templates.spec.ts` failed in Chromium only, and
   * only once the fixture tree had grown tall enough for that focus-scroll to happen at all. Which
   * is the worse symptom of the two — a bug is fixed once, and a suite that fails at random teaches
   * everyone to disbelieve red.
   *
   * **Armed on a timer rather than a frame.** `requestAnimationFrame` never fires in an occluded or
   * backgrounded tab, and this build has already shipped one control that depended on it and simply
   * never happened (A25's slide-over, which opened off-screen). The failure directions are not
   * symmetric here either: a timer that runs late leaves a menu that closes on the *next* scroll
   * instead of this one, while a frame that never comes leaves a menu that no scroll ever closes.
   */
  const stopListening = [
    onDocument('click', () => { close() }),
    onDocument('keydown', event => {
      if ((event as KeyboardEvent).key === 'Escape') close()
    }),
    /**
     * Capture, so a scroll inside the tree closes it as well as a scroll of the page. The menu is
     * `position: fixed`, so a scroll silently moves the row away from underneath it.
     *
     * **A sheet is exempt, and the reason is the same reason stated positively.** This rule exists
     * because a dropdown is positioned against a row that a scroll moves out from under it. §18.6's
     * sheet is positioned against the *bottom edge of the screen*, which no scroll moves — so
     * closing it on scroll would dismiss a menu that was still exactly where it belonged, and on a
     * phone the scroll that did it would most likely be the person's thumb resting on the list
     * behind it.
     */
    onDocument('scroll', () => { if (armedForScroll && !sheetIsOpen) close() }, { capture: true }),
  ]

  return {
    open: options => {
      // `close()` first, which is also what takes the mark off whichever row had it. Two rows
      // wearing `has-menu` is the exact defect this state was added to remove.
      close()
      markedRow = options.row ?? null
      markedRow?.classList.add('has-menu')
      sheetIsOpen = isMobile()
      closeCurrent = openMenu(parent, {
        ...options,
        // The sheet's explicit Close, wired to the same `close()` every other dismissal runs through.
        onClose: close,
        onChoose: id => {
          close()
          options.onChoose(id)
        },
      })
      const opening = closeCurrent
      setTimeout(() => {
        // Only if this menu is still the open one. A second menu opened inside the window would
        // otherwise be armed by the first one's timer and by its own.
        if (closeCurrent === opening) armedForScroll = true
      }, 0)
    },
    close,
    destroy: () => {
      close()
      for (const stop of stopListening) stop()
    },
  }
}

/** Builds the "⋯" control for a row. Exported so the tree can place it. */
export function menuButton(subject: string): HTMLElement {
  return el('button', {
    className: 'row-menu-button',
    // A middle dot triple rather than an emoji or an icon font — annex §C, zero emoji in UI.
    text: '⋯',
    attributes: { type: 'button', 'aria-label': `Actions for ${subject}`, 'aria-haspopup': 'menu' },
  })
}
