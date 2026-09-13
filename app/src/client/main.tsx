/**
 * The client entry point.
 *
 * Deliberately thin. Phase 3's job is the *platform* — the boundary, the feedback channel, the
 * navigation machine, the live stream — and every one of those is a framework-free module with its
 * dependencies injected, so it is testable without a DOM and reusable if the view layer ever
 * changes.
 *
 * **This file is where the browser is ASSEMBLED, and it is not the only file that touches one.**
 * Corrected 2026-08-16; it read *"the only place that knows a browser exists"*, and two modules make
 * that false: `layout-mode.ts` calls `window.matchMedia`, and `buffer-store.ts` reads `indexedDB`.
 * Both are deliberate and both inject a seam so they stay testable — which is the property the
 * sentence was reaching for and stated as a location instead. `dom.ts` is the shared door for the
 * rest.
 *
 * The distinction is worth keeping straight because the sentence is load-bearing for anyone deciding
 * where a new browser API belongs: the rule is *inject a seam and keep the rule pure*, not *put it
 * in this file*.
 *
 * The screens themselves arrive in P7 and P9. What mounts here now is enough to prove the platform
 * runs: the shell renders, the boundary contains a failure, the stream connects and says what state
 * it is in.
 */

import {
  append, byId, clear, el, getText, icon, onBecameVisible, onDocument, onSessionEnding,
  openEventSource,
  postJson, setRootAttribute, setText,
} from './dom'
import type { WireEntry } from '../contract/wire'
/**
 * A13's fade rule, from the module that owns it. Imported here because nothing imported it at all —
 * the policy was written, tested, and reached by no product code, so "Saved" never cleared.
 */
import { SAVED_VISIBLE_MS, statusFades } from './editor/save-policy'
import { mountChatroom } from './chatroom-view'
import { applyCardOrder, droppedAt, moveWithin } from '../core/board-order'
import { BOARD_PREFIX, isBoardFolder, isChatroom } from '../core/grammar'
import { createDocumentRegistry } from './editor/document-registry'
import { createDocumentSession, type DocumentSession } from './editor/document-session'
import { createEditor, type EditorHandle } from './editor/create-editor'
import { createBufferStore } from './buffer-store'
import { isMobile, onLayoutChange, startLayoutMode } from './layout-mode'
import { startChromeRetreat } from './chrome-retreat'
import { RETAIN_QUIET_MS, createRetainedBuffers } from './retained-buffer'
import { worthOffering } from './files/restore-prompt'
import { mountConflictView } from './files/conflict-view'
import { createFormatBar } from './editor/format-bar'
import { askAboutTruncation, truncationHeadline } from './editor/truncation-prompt'
import { copyPath, pathTextFor, type FolderName } from './files/copy-path'
import { headerPath } from '../core/paths'
import { askWhereToMove } from './files/move-picker'
import { templateIdFor } from './settings/template-id'
import { askForName } from './files/name-prompt'
import { actionsFor, createMutationGuard, templateIdOf } from './files/row-actions'
import { createRowMenus, type RowMenus } from './files/row-menu'
import { buildNonEditingPane } from './files/pane-view'
import { markdownRefusal } from './files/pane-state'
import { MAX_VIEWER_NAME, readViewState, writeViewState } from './files/session-memory'
import { rowKey } from './files/tree-model'
import { fileNameFrom, slugStem } from '../core/slug'
import { createTreeStore } from './files/tree-store'
import { createTreeView } from './files/tree-view'
import { mountBoard, type BoardLane } from './board/board-view'
import { mountProjectFilter, selectionKey } from './board/project-filter'
import { mountQuickOpen, type QuickOpenHandle } from './quick-open-panel'
import type { Column } from '../core/board'
import { mountProjectsBoard, type ProjectsBoardView } from './board/projects-view'
import {
  renderBoards,
  renderOneBoard,
  type BoardCardView,
  type BoardColumnView,
  type BoardRow,
} from './board/boards-view'
import { renderArrangeColumns } from './board/arrange-columns'
import { askForPlan } from './board/plan-prompt'
import { mountInbox, type InboxGroupView } from './board/inbox-view'
import { createCardPanel, type CardPanel } from './board/card-panel'
import { originLabel } from './board/board-view'

/**
 * The Projects board as the server sends it. Declared here rather than imported from the server,
 * for the reason every other wire shape is: the client may not reach into a server module, and a
 * shape agreed at both ends is checked by the tests that drive the real routes.
 */
interface ProjectBoardReply {
  readonly columns: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly cards: ReadonlyArray<
    | {
      readonly kind: 'project'
      readonly columnId: string
      readonly project: {
        readonly rootId: string
        readonly segments: readonly string[]
        readonly name: string
        readonly parentPath: readonly string[]
      }
    }
    | {
      readonly kind: 'staged'
      readonly columnId: string
      readonly card: {
        readonly id: string; readonly name: string; readonly body: string
      }
    }
  >
}
import { openSettings } from './settings/settings-view'
import type { BrowseReply } from './settings/folder-browser'
import { createErrorBoundary } from './error-boundary'
import { createFeedback } from './feedback'
import { createFeedbackView } from './feedback-view'
import { createLiveStream, type EventSourceLike } from './live-stream'
import {
  CHANGED, applyChanged, changedEventOf, openFileVerdict, refetchOpenFolders, type ChangedEvent,
} from './live-refresh'
import { createNavigation } from './navigation'
import { createSessionClient, type CallResult } from './session'
import './tokens.css'

/**
 * Adapts the browser's `EventSource` to the injected interface.
 *
 * Not a cast. The browser's handlers take an `Event` argument and the interface's take none, and
 * TypeScript is right to refuse the assignment — a function requiring a parameter is not a function
 * requiring none. Writing the adapter rather than casting is the difference between "the types
 * agree" and "the types were told to stop complaining", and this codebase has been bitten twice by
 * the second kind.
 */
function adaptEventSource(source: EventSource): EventSourceLike {
  const adapted: EventSourceLike = {
    close: () => { source.close() },
    onopen: null,
    onerror: null,
    onmessage: null,
    addEventListener: (type, listener) => {
      source.addEventListener(type, event => {
        listener({ data: (event as MessageEvent<string>).data })
      })
    },
  }
  source.onopen = () => { adapted.onopen?.() }
  source.onerror = () => { adapted.onerror?.() }
  source.onmessage = event => { adapted.onmessage?.({ data: (event as MessageEvent<string>).data }) }
  return adapted
}

function mount(): void {
  const root = byId('app')
  if (root === null) return

  /**
   * The feedback channel, and **its view** — which did not exist until P7.
   *
   * `onChange` drives the redraw rather than the view polling, so the state's own change event is
   * the single trigger. Declared before the view exists, so it is assigned once and read later:
   * `createFeedback` fires `onChange` during `toast()`, which can happen before mount.
   */
  let feedbackView: { render: () => void } | null = null
  const feedback = createFeedback({ onChange: () => { feedbackView?.render() } })
  const navigation = createNavigation()
  const boundary = createErrorBoundary({
    onError: error => {
      // A tab crash is a banner, not a toast. It is about the state of what the operator is looking at,
      // and A27's persistent variant exists so a message like this cannot fade before they see it.
      feedback.banner('danger', error.message)
    },
  })

  /**
   * §18.1 — **before anything is built**, because what gets built differs by mode. §18.4 makes
   * Files two screens rather than one and §18.5 removes a gesture, so a pane constructed before the
   * mode was settled would be constructed for the wrong layout and would have to be torn down.
   */
  startLayoutMode()

  const shell = el('div', { className: 'shell' })
  /**
   * The stream's state, §15 — *"a silent resync is a screen confidently showing stale files."*
   *
   * **Built here and mounted at the foot of the rail**, below, once everything above it exists. It
   * used to hang off the shell's top-right corner, which stopped being a bar when the tabs moved
   * into the rail and became a label floating over whatever the pane put there. On a phone that
   * corner is the board's Refresh button, and the collision is one the operator reported.
   */
  const status = el('div', {
    className: 'status',
    text: 'Connecting…',
    /**
     * Stamped at birth, not left until the first state arrives. The phone hides only the healthy
     * state, so an unstamped element would be drawn — correctly, because "connecting" is not
     * "live" — but the rule would be reading an absent attribute rather than a stated one.
     */
    attributes: { 'data-state': 'connecting' },
  })
  append(root, shell)

  /**
   * Annex A2: `name copy.md`, then `name copy 2.md`. The extension is preserved rather than
   * slugified away — a duplicate derives from a name already on disk, so §13.6's slugification,
   * which is for names a person types, does not apply. D1 in the phase brief.
   */
  const duplicateNameFor = (entry: WireEntry): string => {
    const dot = entry.name.lastIndexOf('.')
    const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name
    const extension = dot > 0 ? entry.name.slice(dot) : ''
    return `${stem} copy${extension}`
  }

  const messages = createFeedbackView(feedback)
  feedbackView = messages
  // Appended to the shell rather than to a tab: a data-safety banner outlives whichever screen
  // produced it, and §13.5 requires it stay until dismissed.
  append(shell, messages.element)

  /**
   * **THE TAB BAR.** PRD: *"Order: Files · Tasks · Projects · Inbox (the operator: inbox last)."*
   *
   * `navigation.openTab` has existed since P3 and nothing ever showed a tab, because there was only
   * one screen — so `activeTab()` was a fact no pixel depended on. This is where that stops: the bar
   * drives the navigation module and the navigation module decides which pane is visible.
   *
   * **Only the tabs that exist are listed.** Projects and Inbox are Phase 9's later units; a bar
   * with two dead entries in it teaches a person that half the app does not work, which is worse
   * than a bar that grows.
   */
  const TABS: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'files', label: 'Files' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'projects', label: 'Projects' },
    // Inbox last. The ordering, recorded in the PRD: "Files · Tasks · Projects · Inbox".
    { id: 'inbox', label: 'Inbox' },
    /**
     * **Boards, fifth.** P14, and after Inbox rather than among the four because the PRD's ordering
     * is the operator's and this is an addition to it, not a re-cut of it.
     *
     * **The phone bar takes five**, measured rather than assumed: four tabs are 96×48, five are
     * 76×48, and nothing clips including `Projects` and `Boards`. Measured at 390px with a real
     * cloned tab before this line was written, and asserted in `boards-tab.spec.ts` now that the
     * fifth one is real rather than a mock.
     */
    { id: 'boards', label: 'Boards' },
  ]

  const panes = new Map<string, HTMLElement>()
  const tabBar = el('div', { className: 'tabs', attributes: { role: 'tablist' } })

  /**
   * **THE RAIL — the app's sidebar, one level above every pane.** Packet §4.1, direction 1a.
   *
   * the operator's headline want, from the reference app: *"that whole layout down to the side bar…
   * the way you can collapse it… the plus new button, the settings button up top, the name of it
   * up top and how many workspaces there are."*
   *
   * **This unit moves it and nothing else.** The rail is created here, at the shell, and the Files
   * tab's sidebar is parented into it instead of into the Files pane. It is shown for Files alone,
   * so both widths look exactly as they did — the tree is beside the document on a desktop and is
   * its own screen on a phone. The header block, the tabs and the footer arrive in later units,
   * on top of a structure that is already proven.
   *
   * **Why the move is the risky part and therefore travels alone.** Inside the pane, the tree was
   * hidden by the pane being hidden. One level up that stops being automatic, and the failure it
   * buys is the file tree lying across the board on a phone. It is one line in `showTab` below and
   * two rules in the stylesheet, and it is worth a commit of its own to keep it that visible.
   *
   * **The tree is not rebuilt or re-parented after this.** It has one home at both widths, and the
   * rail changes shape around it. Moving a node when the layout flips — which it can, live, on a
   * window drag — would cost the scroll position, the open folders and the selected row, all three
   * of which are kept today only by never taking the thing apart.
   */
  const rail = el('div', { className: 'app-rail' })

  /**
   * **Is anything open over the top?** §18.2 forbids the chrome retreating while it is, and the
   * Escape and ⌘K handlers below already ask a narrower version of the same question.
   *
   * Broader than theirs on purpose. Theirs guard against acting *behind* a modal, so `.modal-backdrop`
   * is the whole population. This one guards against a bar leaving while a person is reading a menu —
   * and §18.6's row menu is a **bottom sheet on a phone**, sitting exactly where the tab bar is, with
   * its own scrolling content. A sheet that took the chrome with it as you scrolled its items would
   * be the most visible version of this bug and the easiest to miss on a desktop.
   */
  const OVERLAY_SELECTOR = '.modal-backdrop, .row-menu, .quick-open-backdrop'
  const overlayOpen = (): boolean => shell.querySelector(OVERLAY_SELECTOR) !== null

  /**
   * §18.2 — the one place that decides whether the bars are on screen. The rule is in
   * `core/chrome-retreat.ts`; this hands it measurements.
   */
  const retreat = startChromeRetreat({
    overlayOpen,
    // Measured rather than read from the token, because the token is a `min-height` and the bar
    // also carries the home-indicator inset on an iPhone. The question §18.2 asks is how much room
    // retreating would actually give back, and only the element knows that.
    chromeHeight: () => tabBar.offsetHeight,
    isMobile,
  })

  /**
   * **A LAYOUT CHANGE CLEARS THE RETREAT.** Sweep finding 10, fixed 2026-08-16.
   *
   * The retreat is remembered in `data-chrome` and **only a scroll ever cleared it**. Rotating the
   * phone crosses the 768px breakpoint into the desktop layout, where the retreat CSS does not
   * apply — so it looks fine while the app privately still holds "hidden". Rotating back restores
   * the mobile layout and the bar is gone at once, before anything has been scrolled.
   *
   * **The trap is a surface with nothing to scroll**, which is most of them: a short file, a small
   * folder. No scroll is possible, so nothing clears the state, and all four tabs are off screen
   * until the app is relaunched. Reproduced in both engines before this line existed.
   *
   * `onLayoutChange` was built for exactly this and **had no consumers** — the thirteenth control in
   * this build to be complete, tested and reached by nothing, and the fourth found by this sweep. So
   * this closes a dead end as much as a bug, which is the argument it was fixed on: the operator judged
   * the bug itself rare and survivable — *"I have no issues restarting an app"* — and left the call
   * to me.
   *
   * Resetting on **every** change rather than only on the flip back to mobile: `reset` returns the
   * bars to present, which is the correct state on both sides of the breakpoint, and a condition
   * here would be a second place that knows what the layout means.
   */
  onLayoutChange(() => { retreat.reset() })

  /**
   * §18.3 — **the tab bar is absent entirely in the document view.**
   *
   * Published as a root attribute rather than selected with `:has()`, following §18.1's rule that
   * one place decides and everything else reads. It is two facts and they live in two different
   * components — which tab is active, and which screen the Files pane is on — so something has to
   * combine them, and doing it in a stylesheet would put that logic where no test can reach it.
   */
  let onDocumentScreen = false
  const publishDocumentView = (): void => {
    setRootAttribute(
      'data-document-view',
      String(navigation.activeTab() === 'files' && onDocumentScreen),
    )
  }

  /**
   * Every board's slide-over, so leaving a tab can close the one that belongs to it.
   *
   * **A panel left open on a hidden tab is a live editor nobody can see.** There is one document
   * session in this app, so opening a file in Files while a panel still held one would replace the
   * session underneath the panel and leave it showing a surface that takes keystrokes and saves
   * none of them. Closing on the way out flushes first — §13's *"closing a panel… flushes or
   * asks"* — so nothing is dropped by the switch.
   */
  const panels: CardPanel[] = []

  /**
   * **Where you were when you were thrown into Files.** PRD §navigation:
   *
   * > *"drilling into a file from another tab leaves a back control labeled with the origin tab;
   * > Escape goes back and never fires while a modal or panel is open"*
   *
   * `null` whenever you arrived under your own steam. Every ordinary tab click clears it, because
   * `showTab`'s second argument defaults to `null` and the tab buttons pass nothing — so the only
   * way to set it is for a drill-in to say so explicitly, which is the one case the control is for.
   *
   * Deliberately **not** cleared by clicking another file in the tree. Where you came from does not
   * stop being true because you read a second file, and the tab bar is the only other way back.
   */
  let originTab: string | null = null
  /**
   * Held on an object for the reason `opener` records above: the only assignment happens inside the
   * Files tab's render callback, so a plain variable is narrowed to its initial value everywhere
   * afterwards and the call in `showTab` stops typechecking.
   */
  const backControl: { render: () => void } = {
    render: () => { /* replaced when the Files tab renders; nothing to draw before then */ },
  }

  const showTab = (id: string, origin: string | null = null): void => {
    originTab = origin
    backControl.render()
    for (const panel of panels) if (panel.openKey() !== null) void panel.close()
    navigation.activate(id)
    for (const [tabId, pane] of panes) pane.toggleAttribute('hidden', tabId !== id)
    /**
     * **Which tab is showing, published for the stylesheet.**
     *
     * The rail is permanent on a desktop now — that is what §4.1 means by a rail — so it is no
     * longer hidden per tab. **The phone still needs the answer**: there the rail is the Files tree
     * screen, and the tree must not lie over the board. That is a width-dependent rule, which an
     * attribute on the element could not express and a media query can.
     *
     * Set here rather than read from the navigation module because this is the same call that hides
     * the panes, so the two can never disagree about which tab is showing.
     */
    setRootAttribute('data-tab', id)
    for (const button of tabBar.querySelectorAll('.tab')) {
      const selected = button.getAttribute('data-tab') === id
      button.setAttribute('aria-selected', String(selected))
      button.setAttribute('class', selected ? 'tab is-active' : 'tab')
    }
    // §18.2 — the bars come back, and the anchor is forgotten. Arriving somewhere new with a
    // scroll position from the surface you left would hide the chrome on the first flick, measured
    // against a number belonging to a different screen.
    retreat.reset()
    publishDocumentView()
    /**
     * **A33 — the tab is remembered here, because nothing else was going to.**
     *
     * `remember()` fired on opening a file and on naming yourself, and a tab change is neither. The
     * value was written into the blob correctly and only ever with the tab the app happened to be on
     * when a *file* was last opened — so the round trip worked and the feature did not, which the
     * unit tests could not see. It no-ops until the boot restore has finished; see `restored`.
     */
    remember()
    // Drawn on arrival rather than at boot: a board is a round trip, and paying for it before
    // anyone has asked to see it is the cold-start cost §5 spends a whole section avoiding.
    if (id === 'tasks') void refreshBoard()
    if (id === 'projects') void refreshProjects()
    if (id === 'inbox') void refreshInbox()
    /**
     * **Back to the board you were on, not to the list.** Ruled 2026-08-19: *"when I go back to
     * boards it takes me to the home screen in boards."*
     *
     * `refreshBoards` clears `openBoard` as its first act — correctly, since it draws the list — so
     * routing every arrival through it meant leaving the tab and returning always forgot where you
     * were. The tab now redraws whichever of its two screens you were actually on, which is what
     * every other tab already does with its own state.
     */
    if (id === 'boards') void (openBoard === null ? refreshBoards() : refreshOneBoard())
  }

  /**
   * **THE BOARDS DO NOT REDRAW THEMSELVES, SO THEY SAY WHEN THEY ARE BEHIND.**
   *
   * The tree is live — §15's channel invalidates the folders it is showing — but the three boards
   * are drawn from the index on arrival and nothing refreshes them after that. A card an agent adds
   * to the project on your screen simply does not appear, and the board looks complete while being
   * wrong. That is the silent-staleness shape this build refuses everywhere else.
   *
   * **A button rather than an automatic redraw**, which is the call and the one the app
   * already leans on elsewhere: when a file changes underneath an editor you are typing in, §13.5
   * does not replace your text — it *tells you* and lets you act. A board that repainted itself on
   * every watcher event would do the opposite, and it would do it while a card was mid-drag or a
   * task name was half-typed.
   *
   * **The marker means one thing on all three boards: files changed somewhere since this board was
   * drawn.** Not "your board is wrong" — that would need to know which changes could matter to which
   * board, and for the Projects board (which lists every project across every root) the honest
   * answer is "almost any of them". One coarse rule that is always true beats three precise-looking
   * rules where one is a guess, and the failure directions are not symmetric: an unnecessary refresh
   * costs a round trip, a missed one costs a decision made on a stale board.
   */
  /**
   * The board's row menus, held so the next draw can destroy the last one's document listeners.
   * See the note at its assignment — `clear(host)` cannot reach them.
   */
  let boardMenus: RowMenus | null = null
  let filesMenus: RowMenus | null = null

  const staleBoards = new Set<string>()
  const refreshControls = new Map<string, { element: HTMLElement; render: () => void }>()

  const refreshControl = (tabId: string, what: string, run: () => void): HTMLElement => {
    const button = el('button', { className: 'board-refresh', attributes: { type: 'button' } })
    const render = (): void => {
      const stale = staleBoards.has(tabId)
      button.classList.toggle('is-stale', stale)
      setText(button, stale ? 'Refresh — files changed' : 'Refresh')
      // Said in the label too, not only in colour. A marker nobody can hear is not a marker.
      button.setAttribute('aria-label', stale ? `Refresh ${what} — files changed` : `Refresh ${what}`)
    }
    button.addEventListener('click', run)
    refreshControls.set(tabId, { element: button, render })
    render()
    return button
  }

  /** A watcher event landed. Every board is now behind whatever it was drawn from. */
  const markBoardsStale = (): void => {
    for (const tabId of refreshControls.keys()) staleBoards.add(tabId)
    for (const control of refreshControls.values()) control.render()
  }

  /** Called by each board once it has finished drawing — including a draw it did on arrival. */
  const boardDrawn = (tabId: string): void => {
    staleBoards.delete(tabId)
    refreshControls.get(tabId)?.render()
  }

  /** Back to the tab you were thrown out of. A no-op when you arrived here yourself. */
  const goBack = (): void => {
    if (originTab === null) return
    showTab(originTab)
  }

  /**
   * **Escape goes back — and never fires while a modal or panel is open.**
   *
   * The second clause is the one that does the work, and it is the reason this handler asks three
   * questions before it acts rather than one. Four dialogs and three slide-overs in this app already
   * listen for Escape in the capture phase, and **this listener is registered at boot**, so on the
   * document it runs *first* — before the modal that the press actually belongs to. Without the
   * checks, one press would dismiss a dialog and change tab underneath it.
   *
   * Asked of `shell` rather than of a pane, for the reason A25's handoff records: every modal in
   * this app mounts on the shell, so a backdrop never appears inside a pane and a guard that looked
   * there would always answer `false`.
   *
   * **The "or panel" half is carried by `originTab` itself, and there is deliberately no second
   * condition for it.** An origin is only ever recorded by a drill-in *into Files* — every other
   * `showTab` passes nothing and clears it — so a non-null origin already means Files is on screen.
   * A slide-over exists only on a board, and `showTab` closes every panel on the way out, so there
   * is no state in which this handler can run with a panel open.
   *
   * Two further guards were written here and then removed after the sweep showed neither could be
   * observed to fail: `panels.some(…)`, and a check that Files was the active tab. Both were
   * restatements of the line above. An unobservable control in this build is one that gets believed
   * rather than proven, and three conditions that are really one is how a reader comes to think the
   * cases were considered separately.
   *
   * Not consumed with `stopPropagation` when it declines, obviously — but not when it *acts*
   * either. Nothing else is listening at that point: the check above has just established there is
   * no dialog, and no board is on screen, which is the whole population of other Escape handlers.
   */
  onDocument('keydown', raw => {
    const event = raw as KeyboardEvent
    if (event.key !== 'Escape' || originTab === null) return
    if (shell.querySelector('.modal-backdrop') !== null) return
    event.preventDefault()
    goBack()
  }, { capture: true })

  /**
   * **⌘K / Ctrl+K — quick-open.** §16, and the answer to *"stuff gets buried"* for every surface the
   * task filter does not cover.
   *
   * Bound at capture, like Escape above, so the editor never swallows it: CodeMirror binds a great
   * many keys and a shortcut that works everywhere *except* while you are typing in a document is a
   * shortcut that fails exactly when you reach for it.
   *
   * **Refused while a dialog is up.** A jump list opening behind a modal is a second focus trap on
   * top of the first, and the modal is the thing that asked a question.
   */
  const quickOpenHost = el('div', { className: 'quick-open-host' })
  append(shell, quickOpenHost)
  let quickOpen: QuickOpenHandle | null = null

  const closeQuickOpen = (): void => {
    quickOpen?.close()
    quickOpen = null
  }

  /**
   * **ONE DOOR INTO SEARCH, and now two entrances that press it.** P13.
   *
   * The shortcut was the only way in until 2026-08-18, which meant that on a phone — where there is
   * no ⌘K — §16's feature existed and could not be opened. The search buttons at both widths call
   * this. **They do not mount their own panel**, for the same reason the rail's gear presses the
   * Settings button rather than repeating what it does: a second copy of the mount-and-query block
   * is a second place for the query protocol to drift, and the two would diverge silently.
   *
   * `toggle` is what separates the two entrances. A second ⌘K closes the panel, because the hands
   * are already on the keys and that is what the shortcut is for. A button cannot be pressed while
   * the panel is up — the backdrop covers the screen — so it asks to open and never to close, and a
   * button that silently did nothing would be indistinguishable from a broken one.
   */
  const openQuickOpen = ({ toggle }: { toggle: boolean }): boolean => {
    // **Refused while a dialog is up**, from either entrance. A jump list opening behind a modal is
    // a second focus trap on top of the first, and the modal is the thing that asked a question.
    //
    // **The answer is returned rather than swallowed**, because the shortcut's caller needs it: the
    // refusal used to sit ahead of `preventDefault`, so ⌘K under a modal fell through to the
    // browser. Reporting the refusal keeps that exactly as it was. Folding the guard in and
    // preventing unconditionally would have been a silent behaviour change smuggled in by a
    // refactor, which is the kind that never gets found.
    if (shell.querySelector('.modal-backdrop') !== null) return false
    if (quickOpen !== null) { if (toggle) closeQuickOpen(); return true }

    quickOpen = mountQuickOpen(quickOpenHost, {
      onClose: closeQuickOpen,
      /**
       * **Every keystroke asks, and the answer is discarded if it is late.** §16 bounds the search
       * server-side, so the cost of asking is already capped — what is not free is a slow reply
       * landing after a faster one and replacing newer results with older. The query is compared on
       * arrival rather than debounced: a debounce makes the fast case worse to protect a case the
       * budget already handles.
       */
      onQuery: query => {
        void (async () => {
          const answered = await session.call('search.quickOpen', { query })
          if (quickOpen === null || quickOpen.query() !== query) return
          if (!answered.ok) { quickOpen.show([]); return }
          quickOpen.show(answered.data as Array<{ entry: WireEntry; inName: boolean }>)
        })()
      },
      onChoose: entry => {
        closeQuickOpen()
        // Files is where a document lives. Landing there rather than opening it under whatever tab
        // happened to be in front is what makes the jump a jump.
        showTab('files')
        void opener.run?.(entry)
      },
    })
    return true
  }

  /**
   * **⌘K / Ctrl+K.** §16, and the answer to *"stuff gets buried"* for every surface the task filter
   * does not cover.
   *
   * Bound at capture, like Escape above, so the editor never swallows it: CodeMirror binds a great
   * many keys and a shortcut that works everywhere *except* while you are typing in a document is a
   * shortcut that fails exactly when you reach for it.
   */
  onDocument('keydown', raw => {
    const event = raw as KeyboardEvent
    if (event.key !== 'k' && event.key !== 'K') return
    if (!(event.metaKey || event.ctrlKey)) return
    if (openQuickOpen({ toggle: true })) event.preventDefault()
  }, { capture: true })

  for (const tab of TABS) {
    navigation.openTab(tab.id)
    const button = el('button', {
      className: 'tab',
      text: tab.label,
      attributes: { type: 'button', role: 'tab', 'data-tab': tab.id, 'aria-selected': 'false' },
    })
    button.addEventListener('click', () => { showTab(tab.id) })
    append(tabBar, button)
  }
  /**
   * Mounted empty and before any tab renders. The rail is filled in order further down: the header
   * block, then this tab bar, then the Files renderer's sidebar on `renderAll()` — which runs well
   * before the boot `showTab`, so the rail is never a hole on screen waiting to be filled.
   *
   * **The tab bar is NOT appended here**, though it was until the tabs moved into the rail. It goes
   * in with the header, because its position in the rail's column is the whole point of §4.1.
   */
  append(shell, rail)

  /**
   * The session. Holds both credentials and lets neither cross: the token reaches only the request
   * header, the ticket only the stream URL. Nothing is persisted — a credential that outlives the
   * server that minted it is a phone that 403s forever and never relaunches to notice.
   */
  const session = createSessionClient(postJson)

  /**
   * §13.8's unsaved-edit rescue, **finally given a store**.
   *
   * `retained-buffer.ts` has held every rule since P3 — never auto-replay, discard corrupt or
   * oversized blobs, treat a quota failure as blocking rather than as a dropped edit — with the
   * store injected so all of it was testable without a browser. Nothing ever passed it one. It was
   * the security review's eighth unreachable module and finding G4 of the P7 review, which means an unsaved edit
   * on a phone that iOS suspended had no rescue at all.
   */
  const buffers = createRetainedBuffers(createBufferStore())

  const stream = createLiveStream({
    /**
     * A fresh ticket on every connect this client initiates. Relative, always — spec §7/F9.3: no
     * absolute URL, port or hostname anywhere in the bundle.
     */
    url: () => session.streamUrl(),
    open: url => adaptEventSource(openEventSource(url)),
    /**
     * **WIRED, 2026-08-10.** These two were empty for the whole of P7 and the comment here claimed
     * *"the screens that consume these arrive in P7"* the entire time. The screens arrived; nothing
     * connected them. That made live updates the ninth control in this build to be complete,
     * tested, mutation-swept and reachable by no product code — and the only one of the nine that
     * was a live wrong answer rather than a missing feature: an agent rewrote a file and the tree
     * on screen went on showing the old one.
     *
     * The decisions about *what is now stale* are in `live-refresh.ts`, where a test can ask them
     * without a browser. What stays here is the part that is genuinely about this screen: whether
     * to reopen the document the person is looking at.
     *
     * `void` rather than `await`, because these are called from an `EventSource` listener and
     * `live-stream.ts` guards them synchronously — a rejected promise would escape that guard. The
     * refresh cannot reject in practice (the store reports its own failures) and the `catch` is
     * there because "in practice" is not a guarantee.
     */
    onEvent: event => {
      // Only `changed` carries paths. `resync` is the stream's own business and it calls
      // `onRefetch` itself; anything else is a frame this client does not know and must not guess at.
      if (event.type !== CHANGED) return
      const changed = changedEventOf(event.data)
      if (changed === null) return
      void onFilesChanged(changed).catch(() => { /* the store reported it; the stream is fine */ })
    },
    onRefetch: () => {
      void refetchEverything().catch(() => { /* likewise */ })
    },
    onStateChange: state => {
      // Spec §15 requires the resyncing state be VISIBLE. A silent resync is a screen confidently
      // showing stale files, which is the failure this whole channel exists to prevent.
      setText(status, state === 'live' ? 'Live'
        : state === 'resyncing' ? 'Resyncing…'
          : state === 'reconnecting' ? 'Reconnecting…'
            : 'Not connected')
      /**
       * **Published so the stylesheet can treat "fine" differently from "not fine".**
       *
       * On a phone the word `Live` sat on top of the board's Refresh button — the operator reported it,
       * and it is measurable: the label occupied x 355–378 against Refresh at 312–376. There is no
       * free corner at 390px wide.
       *
       * So on a phone the healthy state is not drawn at all, and the other three are. §15 asks that
       * *"the resyncing state be VISIBLE"* — a permanent `Live` badge is not what satisfies it, and
       * a badge that is always present is one nobody reads by the second day. Desktop keeps all
       * four in the rail's footer, where there is room and nothing to collide with.
       */
      status.setAttribute('data-state', state)
    },
  })

  /**
   * The iOS recovery. Spec §15, and the reason it is unconditional:
   *
   *   "iOS suspends a backgrounded web app, and a suspended EventSource can come back dead without
   *   ever firing error… Reopening unconditionally on visibilitychange→visible and on window.focus
   *   is the only reliable recovery — do not probe first, just reopen."
   *
   * Both listeners, because the two fire in different situations and neither alone is enough.
   */
  onBecameVisible(() => { stream.onVisible() })

  /**
   * **THE FILES TAB.** The tree on the left, the editor on the right.
   *
   * This replaces P6's development surface, which mounted the editor on a string constant. The
   * editor has been correct since P6 and unreachable by a person; what changes here is that it is
   * given a file.
   */
  /**
   * The Settings button, once the Files pane has built it. First run clicks this exact element.
   *
   * **Declared here, above `boundary.register('files', …)`, and that is not style.** The first
   * version declared it beside `showFirstRun` near the bottom of the file — but the Files pane is
   * built *earlier* at runtime, so the assignment ran before the `let` was evaluated and threw
   * `Cannot access before initialization`. The whole client stopped mounting, every browser test
   * timed out at thirty seconds, and no failure named the cause.
   */
  let firstRunTarget: HTMLElement | null = null

  let openFile: { rootId: string; segments: readonly string[] } | null = null

  /**
   * **THE ROW THE TREE HIGHLIGHTS. Separate from `openFile`, and that separation is the whole fix.**
   *
   * Until 2026-08-19 the tree's only notion of "current" was `openFile`, which `opener.run` sets
   * when a **document** opens. So every jump landing on a **folder** — a project's *"View in
   * Files"*, a board, an inbox folder — expanded the path and highlighted nothing. The operator, testing
   * it: *"it just jumps you to files, but it doesn't select or show on screen the selected folder."*
   *
   * ## The first fix for that was worse than the bug, and an adversarial review caught it
   *
   * It made the tree draw `openFile ?? revealedFolder` and had the jump **null `openFile`** to win
   * the precedence. But `openFile` is not a highlight — it is the app's record of *which document is
   * on screen*, and the document stays open across a jump. Nulling it silently disarmed three
   * separate contracts, every one confirmed by probe:
   *
   *   - **§15's live updates stopped** for the document being read. The changed-file handler reads
   *     `openFile` and ignores a null, so an edit on disk never reached the editor and no banner
   *     appeared — the exact silent staleness that channel exists to prevent.
   *   - **Session restore lost the document.** `showTab` calls `remember()`, so `openFile: null` was
   *     written to storage and a reload came back with nothing open.
   *   - **The open file stopped following its own rename** — annex A3's *"the editor must never lose
   *     its file"*, disarmed, along with the guard that refuses a rename when the buffer is unsaved.
   *
   * **So the highlight gets its own variable and `openFile` is never touched.** Both paths write
   * here — a document open and a folder jump — which also removes the precedence puzzle entirely:
   * there is one value, so two rows cannot light and no clearing line is needed anywhere.
   */
  let selectedRow: { rootId: string; segments: readonly string[] } | null = null

  /**
   * Jump to a folder in Files and land on it — expanded, highlighted, and scrolled to.
   *
   * **Both folder jumps go through here**, and since 2026-08-19 both arrive from a panel's *View in
   * Files* button rather than from a click — Projects' card panel and the Inbox's folder panel. A
   * board card opens a document in a panel instead and never comes here. They were written
   * separately and were broken identically, so a third written by hand would have been broken the
   * same way. Same rule as the search control pressing one door: one handler, no copies.
   */
  const jumpToFolder = (
    rootId: string, segments: readonly string[], from: string,
  ): void => {
    selectedRow = { rootId, segments: [...segments] }
    showTab('files', from)
    /**
     * **§18.4: the phone has two Files screens, and a folder jump belongs on the TREE one.**
     *
     * `showTab` does not reset that state — only this and the back control do — so a jump made while
     * Files was sitting on its document screen landed on **a document the person had not asked
     * for**, with no tree, no highlight and no tab bar. Reachable straight off a reload, because the
     * boot restore reopens the last document and then switches tabs. Found by an adversarial review
     * at 390×844, which is the width the operator reported the original bug from.
     */
    filesShowScreen?.('tree')
    /**
     * **Asked for on every jump, which is what makes a REPEAT jump work.** Inferring it from a
     * changed selection shipped once and brought the original bug back: the second jump to the same
     * folder had nothing to notice, so a row that had drifted off screen stayed there.
     */
    filesTree?.scrollToSelection()
    void store.revealPath(rootId, [...segments], { open: true })
  }

  /**
   * **The one open document and the surface it is drawn in.** The security review's P9-3.
   *
   * Held in a registry rather than in a pair of bare `let`s because the rules that matter are about
   * *identity* — is the live document this surface's, and is the session a teardown is holding still
   * the live one — and `main.tsx` is the one file in this build where no test can ask a question.
   * `document-registry.ts` states both rules and drives them. What is left here is the wiring.
   */
  const documents = createDocumentRegistry<DocumentSession, HTMLElement>()

  /**
   * **Where `openFile` is drawn**, which is a different question from where the *document* is.
   *
   * The live-update reopen has to redraw a file where it actually is. Without this it called
   * `opener.run(entry)` with no host at all, so an agent rewriting the file you had open in a
   * slide-over remounted it into the *hidden* Files pane: the panel went on showing an editor whose
   * session had just been closed under it, taking keystrokes and saving none of them, with no error
   * anywhere.
   *
   * Separate from the registry because the two genuinely diverge — opening a `.png` in Files while a
   * markdown document sits in a panel moves `openFile` and leaves the document exactly where it was.
   */
  let openFileHost: HTMLElement | null = null

  /**
   * **The name this device posts under**, and the redraw hook for the conversation on screen.
   *
   * §7's viewer identity has no Settings section yet, so rather than a config key nothing can set —
   * this build's signature failure — the name is **asked for once, the first time anyone posts**,
   * and remembered per client with the rest of the view state. §15 already makes that state
   * per-client, and the reasoning holds harder here: the name is how a reader tells one voice from
   * another, so syncing it would make the phone and the Mac indistinguishable in a conversation
   * they both post to.
   */
  let viewer: string | null = null
  /** Set while a conversation is on screen, so the live channel can refresh it. */
  let chatroomRefresh: (() => Promise<void>) | null = null

  /**
   * The posting name, asked for once and then remembered.
   *
   * Returns `null` when the person dismissed the dialog, which is a refusal to post rather than a
   * failure — the message stays in the composer and nothing is written.
   */
  const viewerName = async (): Promise<string | null> => {
    if (viewer !== null) return viewer
    const typed = await askForName(shell, {
      title: 'Post as',
      confirmLabel: 'Save',
      initial: '',
    })
    if (typed === null || typed.trim() === '') return null
    viewer = typed.trim().slice(0, MAX_VIEWER_NAME)
    remember()
    return viewer
  }

  /**
   * Where this browser was last time. §15: view state is **per-client** — the user's Mac and their
   * phone are meant to be looking at different things, and a shared cursor would have one yank the
   * other around.
   */
  /**
   * Opening a file, reachable from outside the tab that defines it.
   *
   * **Named `openEntry`, not `open`.** The first version defined a local `open()` inside the tab
   * and called it from the restore path outside — where `open` resolves to **`window.open`**, so
   * the call typechecked against `string | URL` and would have opened a popup instead of a file.
   * The compiler caught it; nothing else would have, because a popup blocker makes the symptom
   * "restoring the last file silently does nothing".
   */
  /**
   * Held on an object rather than in a bare `let`, and that is a type-system fact rather than a
   * style choice: the only assignment happens inside the tab's render callback, so control-flow
   * analysis narrows a plain variable to `null` everywhere afterwards and the call below stops
   * typechecking. A property is re-read at each use.
   */
  /**
   * **`host` is what lets a document open somewhere other than the Files pane.** A25's slide-over
   * on the Tasks and Inbox boards is *"the full editor beside the board"*, and the only honest way
   * to give it one is to hand the existing open path a different element to draw into — the
   * alternative is a second editor with its own save, flush and conflict handling, which is exactly
   * the duplication §13 exists to prevent.
   *
   * **Still one live document at a time**, whichever host it is in. That is a data-safety
   * constraint, not a simplification: two sessions on the same file would both autosave against the
   * same content hash and generate conflicts *with each other*, and the retained-buffer key is the
   * file's path, so the second session's buffer would overwrite the first's.
   */
  const opener: {
    /**
     * `select: false` reopens a document **without moving the tree's highlight** — §15's silent
     * re-read, which is the app catching up with disk rather than the person choosing a row.
     */
    run: ((
      entry: WireEntry, host?: HTMLElement, options?: { readonly select?: boolean },
    ) => Promise<void>) | null
  } = { run: null }

  const storage = typeof localStorage === 'undefined' ? undefined : localStorage

  /**
   * **Nothing is persisted until the restore has finished, and that gate is the whole fix.**
   *
   * `remember` is subscribed to the store before the app has read anything back — it has to be,
   * because the subscription is set up when the tab renders and the restore needs the folder list
   * that arrives later. Without this flag the sequence is: subscribe, `setRoots`, **announce**,
   * `remember()` writes the *empty* current state over the saved one, and only then does the app
   * read what is left. Which is nothing.
   *
   * It presented as "the app never remembers anything", and the saved state was correct on disk
   * the entire time — a test that read storage across the reload saw it populated, because the read
   * beat the wipe.
   */
  let restored = false
  const remember = (): void => {
    if (!restored) return
    writeViewState(storage, {
      openFile, expanded: [...store.expanded()], viewer, activeTab: navigation.activeTab(),
    })
  }
  /** Registered folders, kept for Copy Path — it needs the folder's NAME, not just its id. */
  let folders: readonly FolderName[] = []

  /**
   * The templates, kept here because **two screens read them**: Settings lists them, and every
   * folder row's menu offers one item per available template. Re-read after any change rather than
   * captured, for the same reason `folders` is — a snapshot taken at mount names only what existed
   * at boot, which is the bug Settings → Folders shipped with and had to have extracted out of it.
   */
  let templates: readonly {
    id: string; name: string; rootId: string; segments: readonly string[]; available: boolean
  }[] = []

  /** Re-reads the template registry. Called at boot and after any change to it. */
  const reloadTemplates = async (): Promise<boolean> => {
    const listed = await session.call('templates.list')
    if (!listed.ok) return false
    templates = listed.data as typeof templates
    return true
  }

  /** §13.8's in-flight rule, keyed per row. */
  const guard = createMutationGuard()

  /**
   * One folder's rows. Named rather than inlined into the gateway because the live-update path needs
   * the same request for a folder the **tree is not showing** — see `onFilesChanged`.
   */
  const listChildren = async (
    rootId: string, segments: readonly string[],
  ): Promise<readonly WireEntry[]> => {
    const reply = await session.call('tree.children', { rootId, segments: [...segments] })
    // A failure is thrown, never returned as `[]`. §6: an empty-but-successful result must
    // never stand in for a failure, and the store depends on being able to tell them apart.
    if (!reply.ok) throw new Error('that folder could not be read')
    return reply.data as WireEntry[]
  }

  /**
   * §18.4's screen switch, published for the opener.
   *
   * **Declared here, above everything that assigns or calls it.** P11 lost two reverts to a `let`
   * declared below its own assignment: the Files pane is built earlier at runtime than the code it
   * sits next to, so the binding was read before it existed and the whole client stopped mounting.
   * The rule that came out of it is the reason this line is where it is.
   */
  let filesShowScreen: ((screen: 'tree' | 'document') => void) | null = null
  /**
   * The Files tree, lifted for the same reason `filesShowScreen` is: it is built inside the Files
   * pane's boundary, and a folder jump made from another tab has to reach it.
   */
  let filesTree: { readonly render: () => void; readonly scrollToSelection: () => void } | null = null

  /**
   * **The rail's gear presses the Settings button rather than repeating what it does.**
   *
   * The button's handler carries a large options object — the folder picker, registration, §11's
   * containment, every refusal message, the template list. The comment beside it records what
   * happened the last time someone hoisted that handler into a shared function: *"it typechecked
   * and broke the boot, and had to be reverted."* First run already learned the same lesson and
   * holds the **element**, not a copy of its behaviour.
   *
   * So this holds a press, not a reimplementation. There is one door and one handler; the gear and
   * the phone's strip are two ways of knocking on it, and neither can drift from the other because
   * neither knows what is behind it.
   */
  const settingsDoor: { press: () => void } = { press: () => { /* set when Files renders */ } }

  const store = createTreeStore({
    gateway: { children: listChildren },
    onError: (_key, reason) => { feedback.banner('warning', reason) },
  })

  boundary.register('files', () => {
    const pane = el('div', { className: 'files-pane' })
    const sidebar = el('div', { className: 'files-sidebar' })
    const main = el('div', { className: 'files-main' })

    /**
     * **P9F-6, the other half.** The boundary renders this once today — nothing calls `retry` — so
     * this is the latent case the security review's "harmless only while" names. It is still held and destroyed,
     * because the day `retry` is wired to a button is not the day anyone will remember that a tab
     * re-render leaks three document listeners.
     */
    filesMenus?.destroy()
    filesMenus = createRowMenus(pane)
    const menus = filesMenus

    const tree = createTreeView({
      store,
      // Read through a function, not captured: `reloadFolders` replaces `folders` when Settings
      // registers one, and a snapshot taken at mount would name only what existed at boot.
      rootNames: () => new Map(folders.map(folder => [folder.id, folder.name])),
      selected: () => selectedRow,
      isBusy: key => guard.isBusy(key),
      onOpen: entry => { void opener.run?.(entry) },
      onMenu: (entry, at, row) => {
        menus.open({
          anchor: at,
          subject: entry.name,
          // §4.6's *acted on* state. The menu clears it on every close path, so nothing here has to.
          row,
          actions: actionsFor(entry, templates, { desktop: !isMobile() }),
          onChoose: id => { void runAction(id, entry) },
        })
      },
    })
    // A busy row draws differently, so the tree redraws when the busy set changes.
    filesTree = tree
    guard.subscribe(() => { tree.render() })

    /**
     * One action, on one row.
     *
     * **Every mutating branch goes through `guard.run` and carries `entry.token`** — §13.8's two
     * halves. The token is the one the row was painted with, so a file an agent replaced since is
     * refused by the server rather than acted on.
     */
    async function runAction(id: string, entry: WireEntry): Promise<void> {
      const key = rowKey(entry.rootId, entry.segments)
      const parentSegments = entry.segments.slice(0, -1)

      /**
       * **SCAFFOLDING FROM A TEMPLATE.** Phase 8, and it is `entry.copy` with a name.
       *
       * the operator's flow, in their words: *"when I say I want to create a new op somewhere… and then
       * when I click it, it knows to make a copy of that folder path and everything underneath
       * it."* The location is the folder whose menu was used — creation-is-placement, the same rule
       * New File follows — and the name is required before anything happens, which is the other
       * half of what they asked for: *"a field that has to be filled with op-hollis-outreach or
       * whatever before it scaffolds where you tell it to scaffold."*
       *
       * **Nothing is renamed inside.** Their ruling: *"it should not do renaming on any files."* The
       * copy is verbatim, so a scaffolded op carries `context-template.md` exactly as the template
       * holds it.
       */
      const templateId = templateIdOf(id)
      if (templateId !== null) {
        const template = templates.find(candidate => candidate.id === templateId)
        // Gone between the menu opening and the click — a template removed in Settings on another
        // device, or this one. Silent rather than an error: nothing was attempted.
        if (template === undefined || !template.available) return
        /**
         * **The row and the template must be in the same registered folder.** The security review's C1.
         *
         * `actionsFor` already declines to offer a cross-root template, so this is unreachable
         * through the menu — and it is here anyway, because the menu is a *display* rule and this
         * is the line that composes the request. The defect it guards was exactly this asymmetry:
         * `entry.copy` was handed the template's `rootId` and the row's segments, which is a
         * destination nobody named. A filter that lives only in the thing that draws the button is
         * one refactor away from being bypassed by a keyboard shortcut or a second call site.
         */
        if (template.rootId !== entry.rootId) {
          feedback.banner('warning',
            `${template.name} belongs to a different folder, so it cannot be used here.`)
          return
        }

        const typed = await askForName(shell, {
          title: `New ${template.name}`,
          confirmLabel: 'Create',
        })
        if (typed === null) return
        const named = fileNameFrom(typed)
        if (!named.ok) return

        /**
         * **The template folder's CURRENT token, read immediately before the copy.**
         *
         * `entry.copy` requires §13.8's entity token — *"required, never optional. An optional
         * token is a control the client can switch off by omission."* A template is named by the
         * registry rather than by a row on screen, so unlike every other action here there is no
         * token in hand: it has to be fetched. That is the contract working rather than a
         * workaround — it means a template folder that was renamed or replaced since cannot be
         * scaffolded from a stale idea of what it is.
         */
        await guard.run(key, async () => {
          const row = await session.call('tree.entry', {
            rootId: template.rootId, segments: [...template.segments],
          })
          if (!row.ok) {
            feedback.banner('warning',
              `The ${template.name} template could not be read. Nothing was created.`)
            return
          }

          const copied = await session.call('entry.copy', {
            // `entry.rootId`, not `template.rootId` — they are equal by the guard above, and this
            // is the one that has to be right: the destination path is the row's, so the root must
            // be the row's too. Reading them from two different objects is what produced C1.
            rootId: entry.rootId,
            from: [...template.segments],
            to: [...entry.segments, named.value.name],
            plan: false,
            token: (row.data as WireEntry).token,
          })
          if (!copied.ok) {
            feedback.banner('warning',
              copied.error?.message ?? `${named.value.name} could not be created.`)
            // Refreshed anyway: the copy is all-or-nothing, but the listing may be stale for an
            // unrelated reason and a person looking at a failure should see the true tree.
            await store.invalidate(entry.rootId, entry.segments)
            return
          }

          await store.invalidate(entry.rootId, entry.segments)
          // Opened, so the thing that was just made is on screen. Creating into a collapsed folder
          // otherwise looks like nothing happened — the same reasoning as New File.
          await store.restoreExpanded([rowKey(entry.rootId, entry.segments)])
          feedback.toast('info', `Created ${named.value.name} from ${template.name}.`)
        })
        return
      }

      if (id === 'reveal') {
        /**
         * **§10's Reveal in Finder — the only action in this app that asks macOS to do something.**
         *
         * The menu item exists on the desktop only (§18.8, `actionsFor`), and that is the *whole*
         * of the desktop restriction: the route is carried on both listeners, because a `local-only`
         * route cannot be reached by any interface at all (ruled 2026-08-14). A runtime
         * check on the server was explicitly rejected — §7 decides privilege by which listener
         * carries a route, never by a check.
         *
         * **No optimistic feedback.** Success is a Finder window appearing, which the person sees
         * themselves; a toast saying "revealed" would be the app narrating something already
         * visible. A *failure* is invisible, though — nothing happens and there is nothing to look
         * at — so that is the case worth speaking about, which is the inverse of the usual rule and
         * the reason it is written down.
         */
        const shown = await session.call('file.reveal', {
          rootId: entry.rootId,
          segments: [...entry.segments],
        })
        if (!shown.ok) feedback.banner('warning', 'Could not show that file in Finder.')
        return
      }

      if (id === 'copy-path') {
        const outcome = await copyPath(
          pathTextFor(entry, folders),
          typeof navigator === 'undefined' ? undefined : navigator.clipboard,
        )
        if (outcome.ok) feedback.toast('info', `Copied ${outcome.text}`)
        else feedback.banner('warning', outcome.reason)
        return
      }

      if (id === 'new-file' || id === 'new-folder') {
        const kind = id === 'new-file' ? 'file' : 'directory'
        const typed = await askForName(shell, {
          title: kind === 'file' ? 'New file' : 'New folder',
          ...(kind === 'file' ? { extension: 'md' } : {}),
          confirmLabel: 'Create',
        })
        if (typed === null) return
        // Created INSIDE the folder whose menu was used — creation-is-placement.
        const made = await mutate(key, 'entry.create', {
          rootId: entry.rootId, parent: [...entry.segments], name: typed, kind,
        }, entry.segments)
        /**
         * And the folder is opened, so the thing you just made is on screen.
         *
         * Not cosmetic: creating into a collapsed folder otherwise looks like nothing happened,
         * and the natural next move is to press the button again.
         */
        await store.restoreExpanded([rowKey(entry.rootId, entry.segments)])

        /**
         * **A5: a new file opens immediately.** Making a file is not the goal; writing in it is, and
         * a create that leaves you looking at a tree row asks you to do the same work twice.
         *
         * The path comes from the **reply**, never from what was typed — §13.6 slugifies on the
         * server precisely so there is one implementation of it, and `My Notes` becomes
         * `my-notes.md`. Opening the typed name would open nothing.
         *
         * Folders are deliberately excluded: a new folder is empty, so there is nothing to open.
         */
        if (kind === 'file' && made?.ok === true) {
          const created = (made.data as { segments: string[] }).segments
          const wanted = rowKey(entry.rootId, created)
          const row = store.childrenOf(entry.rootId, entry.segments)
            ?.find(candidate => rowKey(candidate.rootId, candidate.segments) === wanted)
          if (row !== undefined) await opener.run?.(row)
        }
        return
      }

      if (id === 'rename') {
        const typed = await askForName(shell, {
          title: `Rename ${entry.name}`,
          ...(entry.kind === 'file' && entry.isMarkdown ? { extension: 'md' } : {}),
          initial: entry.name,
          confirmLabel: 'Rename',
        })
        if (typed === null) return
        const named = fileNameFrom(typed, entry.kind === 'file' && entry.isMarkdown ? 'md' : undefined)
        if (!named.ok) return
        const renamedTo = [...parentSegments, named.value.name]
        await renameCarryingTheOpenFile(entry, renamedTo, async using => {
          await mutate(key, 'entry.rename', {
            rootId: entry.rootId,
            from: [...entry.segments],
            to: renamedTo,
            // `using`, not `entry` — see the wrapper: a flush may have replaced the file.
            token: using.token,
          }, parentSegments)
        })
        return
      }

      if (id === 'duplicate') {
        /**
         * Annex A2's name, §13.6's mechanism — D1 in the brief. The suffix is a *proposal*: the
         * server's exclusive create refuses a collision, so a name taken between the suggestion
         * and the copy produces a refusal rather than a clobber.
         */
        const suggested = duplicateNameFor(entry)
        await mutate(key, 'entry.copy', {
          rootId: entry.rootId,
          from: [...entry.segments],
          to: [...parentSegments, suggested],
          plan: false,
          token: entry.token,
        }, parentSegments)
        return
      }

      if (id === 'move') {
        /**
         * M6's count, fetched before the dialog can be confirmed rather than after.
         *
         * A folder move is cheap to perform and expensive to notice — *"a directory rename moves
         * zero bytes… would let a project move silently remove 200 files from every view"* — so the
         * number is part of the question, not part of the report afterwards.
         */
        let fileCount: number | null = null
        if (entry.kind === 'directory') {
          const counted = await session.call('tree.count', {
            rootId: entry.rootId, segments: [...entry.segments],
          })
          fileCount = counted.ok ? (counted.data as { files: number }).files : null
        }

        const destination = await askWhereToMove(shell, {
          store, subject: entry, folders, fileCount,
        })
        if (destination === null) return

        // The destination came from the tree the server drew — §13.7's rule that a client names a
        // target from the server's last payload rather than composing a path.
        const movedTo = [...destination.segments, entry.name]
        /**
         * Wrapped for the same reason Rename is, and this is the branch where it matters most: a
         * FOLDER move is the annex's ancestor case in one gesture. Moving a project takes every file
         * under it, including the one open on screen three levels down.
         */
        await renameCarryingTheOpenFile(entry, movedTo, async using => {
          await mutate(key, 'entry.rename', {
            rootId: entry.rootId,
            from: [...entry.segments],
            to: movedTo,
            token: using.token,
          }, parentSegments)
          // Both ends of the move are refreshed: the folder it left and the one it arrived in.
          await store.invalidate(destination.rootId, destination.segments)
        })
      }
    }

    /**
     * Runs a mutation and reconciles the tree, with the row disabled throughout.
     *
     * `refreshIn` is the folder whose listing changed — the parent for a rename or duplicate, the
     * folder itself for a create. Invalidating it is what makes the result appear without waiting
     * for the watcher.
     */
    /**
     * Returns the server's reply, or `null` when the guard refused to start because that row
     * already had a mutation in flight. Callers that only care whether the tree changed can ignore
     * it; New File needs it, because the name it asked for is not necessarily the name it got.
     */
    async function mutate(
      key: string, route: string, body: unknown, refreshIn: readonly string[],
    ): Promise<Awaited<ReturnType<typeof session.call>> | null> {
      const rootId = (body as { rootId: string }).rootId
      return guard.run(key, async () => {
        const reply = await session.call(route, body)
        if (!reply.ok) {
          feedback.banner('warning', 'That did not work. The tree has been refreshed.')
        }
        await store.invalidate(rootId, refreshIn)
        return reply
      })
    }

    /**
     * **THE EDITOR MUST NEVER LOSE ITS FILE.** Annex A3, and P6's own deliverable: *"editor keyed on
     * identity; retarget on rename/move of the file or any ancestor."*
     *
     * It was never true, and the P9 annex audit found it by writing the test the annex implies. What
     * happened before: the rename ran, the tree updated, and **the editor went on holding the old
     * path.** The header still named the old file, and — the part that matters — every keystroke
     * after that was aimed at a path that no longer existed, so nothing typed after a rename reached
     * disk at all. Proven in `files-tab.spec.ts`: the renamed file still held `# Subject` while the
     * browser held everything the person had written since.
     *
     * **Flush first, then rename, then reopen.** The order is the whole design:
     *
     * - *Flush first*, because it is the last moment the old path is real. Pending edits land in the
     *   file the person is about to rename, and the rename then carries them.
     * - *Reopen rather than retarget the session.* A `retarget` would have to be matched by five
     *   other things rebuilt around the same entry — the header, Copy Path, the retained-buffer key,
     *   the conflict surface, the live-update lookup — and each one left behind would be a stale
     *   path nobody notices. Reopening rebuilds all of them by construction.
     * - *Into the same host*, so a file open in a slide-over stays in the slide-over.
     *
     * **Ancestors count.** Renaming a folder moves everything under it, and the file open three
     * levels down is exactly the case the annex calls out. The comparison is on segments, not on a
     * joined string — `notes` and `notes-old` share a prefix as text and are unrelated as paths.
     */
    const isAtOrUnder = (target: readonly string[], ancestor: readonly string[]): boolean =>
      target.length >= ancestor.length
      && ancestor.every((segment, at) => target[at] === segment)

    async function renameCarryingTheOpenFile(
      subject: WireEntry, to: readonly string[], run: (using: WireEntry) => Promise<void>,
    ): Promise<void> {
      const rootId = subject.rootId
      const from = subject.segments
      const open = openFile
      const carried = open !== null && open.rootId === rootId && isAtOrUnder(open.segments, from)
      if (!carried || open === null) {
        await run(subject)
        return
      }

      /**
       * **THE FLUSH IS ASKED WHETHER IT WROTE.** The security review, P9F-2 — and the comment that stood here
       * said the opposite: *"a failure here is not a reason to refuse the rename… §13.8's retained
       * buffer is what holds their text if it fails."* **The first clause is true. The second is
       * not,** and the security review measured both halves:
       *
       * - `write()` catches its own transport error, sets an `error` status and **returns** — so
       *   `flush()` resolves whether or not anything was written, and `dirty` stays true. A blocked
       *   truncation (§13.2) resolves the same way.
       * - The retained buffer is keyed by **path** — `keyFor(rootId, segments)`. Renaming therefore
       *   files the rescue copy under a name that no longer exists on disk, and nothing in this app
       *   ever re-keys it. `inspect` under the new path answers `none`, forever.
       *
       * So a save that failed followed by a rename put the text beyond reach of both the editor and
       * the rescue: the banner said the save failed, and nothing said the rename had just made that
       * permanent.
       *
       * **The rename is refused rather than the buffer carried**, and that is the smaller mechanism
       * of the two honest options: carrying it would need a text accessor on the session that
       * nothing else wants, and a second writer to §13.8's store. Declining to move a file whose
       * contents could not be saved loses nothing and says why.
       */
      const live = documents.current()
      const wroteSomething = live !== null && live.peek().dirty
      await live?.flush()
      if (live !== null && live.peek().dirty) {
        const name = open.segments[open.segments.length - 1] ?? 'That file'
        feedback.banner('danger',
          `${name} has changes that could not be saved, so it was not renamed. Renaming it now would `
          + 'put those changes out of reach. Fix the save first — your text is still on screen.')
        return
      }
      const host = openFileHost

      /**
       * **THE FLUSH INVALIDATES THE TOKEN THE RENAME NEEDS, and this cost an hour to see.**
       *
       * §13.8's identity token names the entity the row was *painted* with, and an atomic write is
       * write-a-temp-then-rename — so saving the file gives it a **new inode** and the token stops
       * matching. The rename that follows is then refused, correctly, by the exact control that
       * exists to stop a client acting on something an agent changed underneath it. Saving a file
       * and then renaming it turned out to trip the guard against *somebody else* having saved it.
       *
       * A folder is not exempt: writing a file into a directory moves the directory's mtime, so the
       * ancestor case goes stale the same way.
       *
       * So the row is re-read after the flush and the rename is issued against **that** token. Not
       * by suppressing the check, and not by retrying past a refusal — both of those would give up
       * the protection to buy convenience. The client simply looks again at what it just changed.
       */
      /**
       * **Re-read only because WE wrote, never unconditionally.** The security review, P9F-3.
       *
       * An atomic write replaces the inode, so a flush that wrote invalidates §13.8's identity token
       * and the rename must be issued against a fresh one — that is the whole reason this exists.
       * But the first version re-read on **every** carried rename, including the ones where the
       * flush wrote nothing. That discarded a token that was still perfectly valid and adopted
       * whatever the server currently reported, which means a file **an agent replaced between the
       * paint and the rename** was renamed without the refusal. §13.8's entire job is to say
       * "someone else changed this since you looked", and on this path it could no longer say it.
       *
       * `wroteSomething` is read before the flush and is the only thing that unlocks the re-read.
       * Nothing written, nothing invalidated, nothing to re-read: the painted token stands and the
       * guard fires exactly as it does everywhere else.
       */
      let using = subject
      if (wroteSomething) {
        const holder = from.slice(0, -1)
        await store.invalidate(rootId, holder)
        const nearby = store.childrenOf(rootId, holder)
          ?? await listChildren(rootId, holder).catch(() => undefined)
        const subjectKey = rowKey(rootId, from)
        using = nearby?.find(row => rowKey(row.rootId, row.segments) === subjectKey) ?? subject
      }

      await run(using)

      const moved = [...to, ...open.segments.slice(from.length)]
      const parent = moved.slice(0, -1)
      /**
       * Read from the store, which `mutate` has just invalidated — so this is the row as the server
       * now describes it, carrying the identity token §13.8 needs. Composing a `WireEntry` here from
       * what we knew a moment ago would be inventing a token, which is the one field a client must
       * never author.
       */
      const rows = store.childrenOf(rootId, parent)
        ?? await listChildren(rootId, parent).catch(() => undefined)
      const wanted = rowKey(rootId, moved)
      const entry = rows?.find(row => rowKey(row.rootId, row.segments) === wanted)
      if (entry === undefined) {
        // Renamed to somewhere the tree cannot see it. Said out loud rather than leaving an editor
        // pointed at a path that is gone.
        feedback.banner('warning', 'That file was renamed, but it could not be reopened.')
        return
      }
      await opener.run?.(entry, host ?? undefined)
    }
    // Expanding or collapsing a folder is part of "where you were", so it is remembered too.
    store.subscribe(remember)
    /**
     * **The back control, at the top of the navigation column.**
     *
     * Here rather than in the header above the editor, and that is the whole reason it works for
     * every drill-in rather than most of them: `files-main` is replaced wholesale on every open —
     * by the editor, by the non-editing pane, by the placeholder — so a control mounted inside it
     * would have to be re-drawn at three sites and would simply be missing on the fourth, which is
     * the Projects panel's jump. That one reveals a *folder* and opens no file at all, so there is
     * no header for it to live in.
     *
     * The sidebar is never replaced, so this is drawn once and only its contents change.
     */
    const backBar = el('div', { className: 'files-back', attributes: { hidden: 'true' } })
    backControl.render = (): void => {
      clear(backBar)
      const label = TABS.find(tab => tab.id === originTab)?.label
      // Unknown id and no origin are the same case: nothing to go back to, nothing to draw.
      backBar.toggleAttribute('hidden', label === undefined)
      if (label === undefined) return
      const button = el('button', {
        className: 'files-back-button',
        // The arrow is part of the label rather than a separate node: it is one control saying one
        // thing, and a screen reader announcing "left arrow, Tasks" is announcing two.
        text: `← ${label}`,
        attributes: { type: 'button' },
      })
      button.addEventListener('click', () => { goBack() })
      append(backBar, button)
    }
    append(sidebar, backBar)
    append(sidebar, tree.element)

    /**
     * **Settings, in the sidebar under the tree.** The operator: *"a normal settings menu within the
     * main interface just like it is in the app as it exists today where I can click around in
     * settings and add a folder to the file tree."*
     *
     * Under the tree rather than in a top bar because the tree is what it edits — the folders it
     * adds are the tree's top level, and the control that adds them sits at the bottom of the thing
     * it grows.
     */
    const settingsButton = el('button', {
      className: 'sidebar-settings',
      text: 'Settings',
      attributes: { type: 'button', 'aria-label': 'Settings' },
    })
    settingsButton.addEventListener('click', () => {
      void openSettings(pane, {
        folders: () => folders.map(folder => ({
          id: folder.id,
          name: folder.name,
          displayPath: (folder as { displayPath?: string }).displayPath ?? folder.name,
        })),

        browse: async absolutePath => {
          const reply = await session.call('folders.browse', { absolutePath })
          // `null` rather than an empty listing: §6's banned shape is exactly an
          // empty-but-successful result standing in for a failure, and the picker has a different
          // sentence for each.
          return reply.ok ? reply.data as BrowseReply : null
        },

        register: async input => {
          const reply = await session.call('folders.register', input)
          if (reply.ok) return null
          /**
           * The server's own sentence from §6's message table — the reason `ROOT_ALREADY_REGISTERED`
           * and `ROOT_OVERLAPS` were split out of `INVALID_ROOT`. A single generic refusal would
           * leave a person re-picking the same folder forever, learning nothing each time.
           *
           * The fallback is for a transport failure, where there is no envelope to read at all.
           */
          return reply.error?.message ?? 'That folder could not be added.'
        },

        remove: async id => {
          const reply = await session.call('folders.deregister', { id })
          if (reply.ok) {
            /**
             * §13.8/F9.2: drop every retained buffer for a folder that is no longer registered.
             *
             * Not tidiness. A buffer for an unregistered root cannot be restored — `inspect`
             * refuses it — so leaving it behind is unreadable data about the person's files sitting
             * in browser storage after they have told the app to stop looking at that folder.
             * Failure is swallowed on purpose: the folder IS removed, `inspect` refuses the orphans
             * anyway, and a warning about storage housekeeping on top of a successful action would
             * read as the removal having gone wrong.
             */
            await buffers.forgetRoot(id).catch(() => { /* inspect refuses orphans regardless */ })
            return null
          }
          return reply.error?.message ?? 'That folder could not be removed from the list.'
        },

        onRegistered: async () => {
          if (!await reloadFolders()) {
            feedback.banner('warning', 'The folder was added, but the tree could not be refreshed.')
          }
          // A template's availability depends on whether its folder is registered, so the list has
          // to be re-read when that changes — otherwise removing a folder leaves its templates
          // still offered in every row menu until the next reload.
          await reloadTemplates()
          tree.render()
        },

        templates: () => templates.map(template => ({
          id: template.id,
          name: template.name,
          // Folder-relative and joined for display only. §6 keeps absolute paths off the wire and
          // this never becomes one — every route that takes a location takes `(rootId, segments)`.
          where: template.segments.join('/'),
          available: template.available,
        })),

        /**
         * **Two required answers, in the order: which folder, then what it is called.**
         *
         * *"I should be able to go into configurations and say add new template and then name it
         * round table and point it at that round table template."* Either dismissal abandons the
         * whole thing — a template with a folder and no name is not a template, and this is the
         * screen where a half-made one would sit around looking finished.
         */
        addTemplate: async () => {
          const folder = await askWhereToMove(pane, {
            store,
            folders,
            title: 'Which folder is the template?',
            confirmLabel: 'Use This Folder',
          })
          if (folder === null) return null
          /**
           * The registered folder itself cannot be a template — it would scaffold a root into its
           * own subtree. The server refuses it too; refusing here means the person is told while
           * they are still looking at the picker rather than after naming it.
           */
          if (folder.segments.length === 0) {
            return 'Pick a folder inside the registered folder, not the whole of it.'
          }

          const named = await askForName(pane, {
            title: 'Name this template',
            confirmLabel: 'Add Template',
          })
          if (named === null) return null

          const id = templateIdFor(named, templates.map(template => template.id))
          const reply = await session.call('templates.register', {
            id, name: named, rootId: folder.rootId, segments: [...folder.segments],
          })
          if (!reply.ok) return reply.error?.message ?? 'That folder could not be made a template.'

          await reloadTemplates()
          // The row menus are built from `templates`, so the new one has to reach the tree too.
          tree.render()
          return null
        },

        removeTemplate: async id => {
          const reply = await session.call('templates.deregister', { id })
          if (!reply.ok) return reply.error?.message ?? 'That template could not be removed.'
          await reloadTemplates()
          tree.render()
          return null
        },
      })
    })
    /**
     * **Held so first run can use the same door — the element itself, not a copy of its handler.**
     *
     * §17's card offers *"Choose a folder"*, and the flow behind it is this button's: the picker,
     * the registration, §11's containment, every refusal. A previous attempt hoisted that handler
     * out into a shared function and rewrote a brace boundary around a large options object in this
     * 2,700-line file; it typechecked and broke the boot, and had to be reverted.
     *
     * Keeping the *button* and clicking it is the same door by construction rather than by
     * agreement. There is no second copy to drift.
     */
    firstRunTarget = settingsButton
    // **Still Settings, and never search.** On a fresh install nothing is registered, so search has
    // nothing to find — pointing someone at an empty box on their first launch is worse than
    // pointing them nowhere. §17's card asks them to choose a folder, which is this button's flow.

    /**
     * **THE PHONE'S STRIP, now two halves.** P13, on the ruling: *"the thin bar above the tabs
     * — left half stays settings, right half becomes search."*
     *
     * This was a single full-width button that *was* the strip: it carried the pinned position, the
     * safe-area offset and the retreat transform itself. Those move up to this container, and the
     * button becomes one of two children. **All four of the rules naming `.sidebar-settings` in
     * `tokens.css` had to move together** — the desktop hide, the pinned block, the retreated
     * transform and the reduced-motion exemption. Moving three and forgetting one leaves a strip
     * that looks right until something moves.
     *
     * **Phone only, and only on Files.** The strip lives in the Files sidebar, which the phone hides
     * on every other tab and in the document view, and the whole container is hidden on desktop —
     * where the rail's gear and magnifier are the way in. So search appears exactly where Settings
     * appears today, which is the operator's *"Files tab only"* with no extra rule to produce it.
     */
    const searchButton = el('button', {
      className: 'sidebar-search',
      text: 'Search',
      attributes: { type: 'button', 'aria-label': 'Search' },
    })
    searchButton.addEventListener('click', () => { openQuickOpen({ toggle: false }) })

    const sidebarStrip = el('div', { className: 'sidebar-strip' })
    append(sidebarStrip, settingsButton, searchButton)
    append(sidebar, sidebarStrip)
    // The rail's gear, for the same reason and by the same means: press the button, do not copy it.
    settingsDoor.press = () => { settingsButton.click() }

    /**
     * The Files pane's empty state. A function rather than one element, because it is drawn twice:
     * at boot, and again whenever a document opens into a board's slide-over instead of here —
     * appending the *same* node would silently move it out of the pane it was already in.
     */
    /**
     * §4.2's empty pane: *"'Nothing open' at `--size-modal-title`/500 `--text-secondary`, then one
     * dim line naming the action."*
     *
     * Two lines rather than one because they answer two different questions. *Nothing open* says
     * the screen is empty on purpose — the state it replaced, a single grey sentence, reads at a
     * glance like a failure to load. The line beneath is the only one that has to change by width:
     * on a phone the tree is not "on the left", it is the screen you just came from.
     */
    const placeholderPane = (): HTMLElement => {
      const host = el('div', { className: 'files-placeholder' })
      append(host, el('div', { className: 'files-placeholder-title', text: 'Nothing open' }))
      append(host, el('div', {
        className: 'files-placeholder-line',
        text: isMobile() ? 'Pick a file from the tree.' : 'Choose a file on the left.',
      }))
      return host
    }
    append(main, placeholderPane())

    /**
     * §18.4 — **on a phone you are in the tree or in the document, never both.** The operator: *"trying
     * to have both of them on the screen is the only thing that I know for sure."*
     *
     * Which screen you are on is an attribute, and **CSS hides the other rather than script
     * unmounting it.** That is what makes §18.4's other requirement — *"back restores scroll
     * position and open folders"* — structural instead of remembered: the tree is never torn down,
     * so there is no state to save and nothing to restore incorrectly. A rebuild-on-back would have
     * needed a scroll offset, an expansion set and a selected row kept in step, and the first thing
     * to drift would have been the one nobody tested.
     *
     * Desktop ignores the attribute entirely: both halves are always shown, so this costs a string
     * and changes nothing above 768 px.
     */
    const showScreen = (screen: 'tree' | 'document'): void => {
      pane.setAttribute('data-screen', screen)
      /**
       * **Published on the root as well, because the two halves no longer share a parent.**
       *
       * The phone's either/or was written as `.files-pane[data-screen] .files-sidebar` — a
       * descendant rule, which stopped matching the moment the sidebar moved up to the rail. The
       * attribute goes where both can read it, following §18.1's rule that one place decides and
       * everything else reads. It is the same fact, said somewhere both elements can hear it.
       *
       * Not folded into `data-document-view` above, which is a different question: that one is
       * *"is the tab bar allowed on screen"*, and it is false whenever another tab is in front,
       * including while Files is sitting on its document screen behind one.
       */
      setRootAttribute('data-files-screen', screen)
      // §18.3's "absent in the document view", and §18.2's reset. Moving between the two screens is
      // moving between two scrolling surfaces, so the anchor is as meaningless here as it is across
      // a tab change — and arriving in a document with the chrome already retreated would hide the
      // one control that gets you back out.
      onDocumentScreen = screen === 'document'
      publishDocumentView()
      retreat.reset()
    }
    showScreen('tree')
    filesShowScreen = showScreen

    /**
     * The way back, and it names where it goes. §18.4 asks for a *labelled* control rather than a
     * bare chevron — on a phone the tree is off screen, so an arrow alone is a promise about
     * somewhere you cannot see.
     *
     * In the document half rather than in a shared bar, because it belongs to the screen it leaves.
     */
    const backToTree = el('button', {
      className: 'files-screen-back',
      text: '← Files',
      attributes: { type: 'button' },
    })
    backToTree.addEventListener('click', () => { showScreen('tree') })

    /**
     * **Parented to the pane, not to `main`.** `main` is cleared every time a document opens, so a
     * back control living inside it would be destroyed by the very action that makes it necessary.
     * Found by asking what clears what rather than by watching it disappear.
     */
    append(pane, backToTree, main)
    /**
     * **The sidebar goes to the rail, not to the pane.** This is the promotion: everything the
     * sidebar holds — the back bar, the tree, the Settings control — is unchanged and merely lives
     * one level up. `.files-sidebar` keeps its name because it keeps its contents; it is the rail's
     * body rather than a thing sitting beside the rail, and building it as a second column is the
     * mistake that gives Files two 272px sidebars.
     */
    append(rail, sidebar)
    append(shell, pane)
    panes.set('files', pane)

    /**
     * Opens one file. **Markdown only, point blank** (§12, PRD) — everything else gets the
     * non-editing pane, which is the next unit of this stage. Until it exists the app says so
     * rather than pretending: a wrong pane is worse than a plain sentence.
     */
    /**
     * Copy Path, on the open file. §15, annex A26, and a daily workflow rather than a nicety.
     *
     * Built per open rather than once, because the text depends on which file is open — and a
     * button that copies a stale path is worse than no button, since the failure is invisible until
     * something is pasted somewhere.
     */
    function copyPathButton(entry: WireEntry): HTMLElement {
      const button = el('button', { className: 'copy-path', text: 'Copy path' })
      button.addEventListener('click', () => {
        void (async () => {
          const outcome = await copyPath(
            pathTextFor(entry, folders),
            typeof navigator === 'undefined' ? undefined : navigator.clipboard,
          )
          // §15: Copy Path "always confirms". A silent success is indistinguishable from a
          // silent failure at the moment it matters — when something is pasted.
          if (outcome.ok) feedback.toast('info', `Copied ${outcome.text}`)
          else feedback.banner('warning', outcome.reason)
        })()
      })
      return button
    }

    /**
     * Draws a conversation into `into` and keeps it fresh.
     *
     * **The file is read through `file.load` like any other document**, because it is one — §14
     * changes how a chatroom is *shown*, never how it is stored. What it does not get is a
     * `DocumentSession`: nothing here edits, and posting is an append, which §14 exempts from
     * conflict detection precisely because it does not depend on prior bytes.
     */
    async function mountConversation(into: HTMLElement, entry: WireEntry): Promise<void> {
      const read = async (): Promise<string | null> => {
        const reply = await session.call('file.load', {
          rootId: entry.rootId, segments: [...entry.segments],
        })
        return reply.ok ? (reply.data as { content: string }).content : null
      }

      const first = await read()
      if (first === null) {
        into.replaceChildren(el('div', {
          className: 'pane-note pane-note-refusal',
          text: 'That conversation could not be read.',
        }))
        return
      }

      const surface = el('div', { className: 'chat-surface' })
      into.replaceChildren(surface)

      const view = mountChatroom(surface, first, {
        author: viewer ?? 'you',
        copyPath: () => copyPathButton(entry),
        onPost: async (body: string) => {
          /**
           * The name is asked for **here**, at the first post, rather than when the conversation
           * opens: reading a chatroom should never put a dialog in front of somebody, and most
           * visits are reading.
           */
          const author = await viewerName()
          if (author === null) return
          const posted = await session.call('chatroom.append', {
            rootId: entry.rootId, segments: [...entry.segments], author, body,
          })
          if (!posted.ok) {
            feedback.banner('warning', posted.error?.message ?? 'That message could not be posted.')
          }
          /**
           * Re-read either way. A refused post still leaves the conversation as it is on disk, and
           * a redraw from the file is the only honest picture — the alternative is a view that
           * shows a message the server never accepted.
           */
          const after = await read()
          if (after !== null) view.update(after)
        },
      })

      /**
       * A conversation is the surface most likely to change under you, so it follows the live
       * channel. The scroll rule is what makes that bearable: it only moves the view if the reader
       * was already at the end.
       */
      chatroomRefresh = async (): Promise<void> => {
        const latest = await read()
        if (latest !== null) view.update(latest)
      }
    }

    opener.run = async function openTheEntry(
      entry: WireEntry, into: HTMLElement = main, runOptions?: { readonly select?: boolean },
    ): Promise<void> {
      openFile = { rootId: entry.rootId, segments: entry.segments }
      /**
       * The highlight follows the document — **unless this is a silent re-read.** One variable, so a
       * folder jump and a document open cannot both be lit, and `openFile` keeps its own job.
       */
      if (runOptions?.select !== false) {
        selectedRow = { rootId: entry.rootId, segments: entry.segments }
      }
      // Dropped on every open. Left set, it would redraw a conversation into an element that has
      // since been replaced — a surface nobody can see, updating itself forever.
      chatroomRefresh = null
      // Recorded for every open, markdown or not — a reopen of a non-editing pane belongs in the
      // same place it was drawn just as much as an editor does.
      openFileHost = into
      remember()
      tree.render()

      /**
       * §18.4 — opening a file **is** the move to the document screen, on a phone.
       *
       * Only when the document is opening into the Files pane itself. A board's slide-over passes
       * its own host, and that is not a Files navigation at all: switching the Files screen
       * underneath it would leave the tree hidden behind a panel on a tab the person is not even
       * looking at, and they would find it on the wrong screen the next time they went back.
       */
      if (into === main) filesShowScreen?.('document')

      /**
       * **The Files pane is emptied when the document goes somewhere else.**
       *
       * Without this, opening a card in a board's slide-over leaves the previous editor's DOM
       * sitting in the Files pane attached to a session that has just been closed — a surface that
       * takes keystrokes and saves none of them. Emptying it is the honest state: one document is
       * open, it is in the panel, and the tree still shows which file it is.
       */
      if (into !== main) main.replaceChildren(placeholderPane())

      /**
       * **A chatroom is a conversation, not a document.** Spec §14, and the branch sits here — ahead
       * of the editor — because the file is markdown and would otherwise open in it.
       *
       * The match is `isChatroom`, which is an equality on the final segment and never a glob:
       * `chatroom-protocol.md` is the document that *explains* the message format, and rendering it
       * as a conversation would turn every example heading into a message.
       *
       * The document session is closed first. One live document at a time is a data-safety rule,
       * not a simplification — two sessions on one file autosave against the same content hash and
       * conflict with each other — and a conversation has no session of its own because **nothing
       * here edits**: posting is an append, which §14 exempts from conflict detection entirely.
       */
      if (isChatroom(entry.segments)) {
        const live = documents.current()
        if (live !== null) {
          live.close()
          documents.release(live)
        }
        await mountConversation(into, entry)
        return
      }

      /**
       * **Markdown only, point blank** (§12, PRD). Everything else gets the non-editing pane, and
       * so does a `.md` the editor is not allowed to touch — FT-11 makes that a *state* with a
       * reason, never a failure.
       */
      const refusal = entry.isMarkdown ? markdownRefusal(entry) : null
      if (!entry.isMarkdown || refusal !== null) {
        into.replaceChildren(buildNonEditingPane(entry, {
          fileUrl: session.fileUrl,
          /**
           * **Through `getText`, not a bare `fetch`.** The security review's G2, 2026-08-16: this called `fetch`
           * directly with no abort deadline, and it is consumed as a floating promise — so a
           * request that was dropped rather than refused never settled, and the pane read
           * "Loading…" forever while the socket stayed open.
           */
          readText: async target => {
            const url = session.fileUrl(target.rootId, target.segments)
            if (url === null) throw new Error('not connected')
            return getText(url)
          },
        }))
        into.querySelector('.pane-header')?.appendChild(copyPathButton(entry))
        if (refusal !== null) {
          // The editor's own reason, above the pane's — the pane knows the file type, this knows
          // why the EDITOR declined, and §12 requires that sentence be shown.
          into.prepend(el('div', { className: 'pane-note pane-note-refusal', text: refusal }))
        }
        return
      }

      /**
       * **The editor now SAVES.** `createDocumentSession` — autosave, the three-trigger flush, the
       * conflict contract, C2's no-save-without-a-load — was built at P6, driven against the real
       * routes at P6's gate, and imported by nothing in the product until here. The editor loaded
       * files and discarded every keystroke.
       *
       * The fifth module this phase found with tests and no product caller, which is why the
       * importer grep is a standing obligation at every gate rather than a habit.
       */
      documents.current()?.close()

      /**
       * §13.8's retain loop, for this file only. Reset on every open, so a timer armed for the
       * previous document cannot write that document's text under this one's key.
       */
      /**
       * Held on an object rather than in a bare `let`, for the reason `opener` above records: the
       * only assignment happens inside `onReady`, so control-flow analysis narrows a plain variable
       * to `null` everywhere afterwards and the reads below stop typechecking. A property is
       * re-read at each use.
       */
      const editorHandle: { current: EditorHandle | null } = { current: null }
      let loadedFromDisk = ''
      let retainTimer: ReturnType<typeof setTimeout> | null = null
      /** One announcement per open file. A store that is failing fails on every keystroke. */
      let retainFailureAnnounced = false
      /**
       * Where §13.2's truncation question stands for this document.
       *
       * **A modal cannot be the answer to a repeating event.** `truncation-blocked` does not clear
       * the dirty flag — `clearsDirty` is true only for `saved` — so every later autosave is refused
       * the same way. Asking on each one would put a dialog in front of somebody once per quiet
       * period, which is not a confirmation but a trap.
       *
       * So: **ask once, then fall back to the banner.** `declined` means the person has answered and
       * the answer was no; the state stays visible without a modal re-seizing the screen. A
       * successful save resets it, because the next large deletion is a new question.
       */
      let truncationAsk: 'ready' | 'open' | 'declined' = 'ready'

      const retainNow = async (): Promise<void> => {
        const text = editorHandle.current?.text()
        if (text === undefined) return
        /**
         * **Never write a buffer the read end would always refuse — because writing it DESTROYS the
         * one it would have offered.** Found 2026-08-16 while wiring §12's missing flush triggers.
         *
         * This retained unconditionally. With a clean editor that stores text identical to disk, and
         * `worthOffering` — the predicate the restore prompt uses at line ~2047 — then answers
         * `false` forever after. There is one buffer per file, so the write is not an extra copy: it
         * is an overwrite of an *earlier session's unrescued work* with something that can never be
         * shown.
         *
         * The path that exposed it: type, let the save fail, reload, get the dialog, answer **Decide
         * later** — which by design keeps the buffer and leaves the editor clean — then reload again.
         * The second reload retained the clean text over the rescue and the work was gone, silently,
         * from the one mechanism §13.8 exists to provide.
         *
         * **The trigger was already reachable before those triggers were wired.** `visibilitychange`
         * → hidden called this too, so backgrounding the app after "Decide later" destroyed the
         * rescue exactly the same way. Adding `pagehide` and `beforeunload` moved it from *switch
         * apps* onto *every reload*, which is how the e2e suite finally caught it.
         *
         * **The same predicate at both ends, deliberately.** A separate "is it dirty?" rule here
         * could drift from the rule that decides whether to show it, and the invariant that matters
         * is precisely that the two agree: never store what the reader would discard.
         */
        if (!worthOffering(text, loadedFromDisk)) return
        const result = await buffers.retain({
          rootId: entry.rootId,
          segments: entry.segments,
          content: text,
          // The token the row was PAINTED with — the same one §13.8 compares on restore to decide
          // whether the file moved underneath while the edit sat unsaved.
          identityToken: entry.token,
          savedAtMs: Date.now(),
        })
        /**
         * §13.8: **"a quota failure is a blocking error, never a dropped edit."** Silence here is
         * the forbidden outcome — the person keeps typing, believing the work is kept, and it is
         * not. `too-large` is separated out because it is not a fault the person can clear by
         * freeing space; over 256 KB the rescue simply does not apply and saying so is the honest
         * answer.
         */
        if (!result.ok && !retainFailureAnnounced) {
          retainFailureAnnounced = true
          feedback.banner('danger', result.reason === 'too-large'
            ? 'This document is too large to keep a local backup of. Save often.'
            : 'Unsaved changes are NOT being kept on this device. Save before closing this tab.')
        }
      }

      const scheduleRetain = (): void => {
        if (retainTimer !== null) clearTimeout(retainTimer)
        /**
         * Debounced rather than per keystroke: the store is asynchronous and a write per character
         * would queue transactions faster than they complete on a phone.
         *
         * **Deliberately shorter than the autosave's quiet period** — see `RETAIN_QUIET_MS`. Both
         * timers are armed by the same keystroke and `doc.changed()` above arms the save first, so
         * at equal delays the buffer would be written *after* the save that should have dropped it.
         * Keep, then save, then drop.
         */
        retainTimer = setTimeout(() => { retainTimer = null; void retainNow() }, RETAIN_QUIET_MS)
      }

      const surface = el('div', { className: 'editor-surface' })
      const host = el('div', { className: 'editor-host' })
      const header = el('div', { className: 'pane-header' })
      const status = el('div', { className: 'save-status', text: '' })
      /**
       * The pending fade for that pill. Held per document, alongside the element it clears — a
       * timer that outlived its editor would blank the pill of whatever opened next.
       */
      let statusFadeTimer: ReturnType<typeof setTimeout> | null = null
      /**
       * **The title line — name, `saved`, Copy Path — with the path on its own line beneath it.**
       *
       * ruled 2026-08-15: *"on the task card lets just move the filepath under the title, it's
       * cramming up with the copy path button and disrupts the whole header section."*
       *
       * All four used to share one row, competing for the same width. In the card panel — the
       * narrowest place this header appears — that row was additionally allowed to wrap, so where
       * the path landed depended on how long the filename was and the header changed shape from one
       * card to the next. **Giving the path its own row is what makes that shape fixed**, and it is
       * why the wrap hack this replaces can go.
       *
       * The row is a real element rather than flex `order` on the path: reordering visually while
       * leaving the DOM alone would put the reading order and the drawn order out of step for the
       * sake of saving one div.
       */
      const titleRow = el('div', { className: 'pane-header-top' })
      append(
        titleRow,
        el('div', { className: 'pane-name', text: entry.name }),
        status,
        copyPathButton(entry),
      )
      append(header, titleRow)
      /**
       * **The tail, on one line.** `headerPath` drops the filename — the line above already carries
       * it — and elides from the front, because `02-projects/` is the part every file in this soil
       * has in common. Rendered only when there is a folder to name, so a file at the root draws no
       * line rather than an empty one.
       *
       * **This header is shared by the Files pane and the board's card panel**, so this is one
       * change on both surfaces. That is also why the ten-line version appeared in a task card and
       * the two-line version in the editor: one string, two widths.
       */
      const where = headerPath(entry.segments)
      if (where !== '') {
        append(header, el('div', { className: 'pane-path', text: where }))
      }
      append(surface, host)
      into.replaceChildren(header, surface)

      let refreshBar = (): void => {}

      const doc = createDocumentSession(
        { rootId: entry.rootId, segments: entry.segments },
        {
          load: async location => {
            const reply = await session.call('file.load', {
              rootId: location.rootId, segments: [...location.segments],
            })
            if (!reply.ok) throw new Error('that file could not be opened')
            return reply.data as { content: string; hash: string; bytes: number }
          },
          save: async request => {
            const reply = await session.call('file.save', {
              rootId: request.rootId,
              segments: [...request.segments],
              content: request.content,
              expectedHash: request.expectedHash,
              confirmTruncation: request.confirmTruncation,
            })
            if (!reply.ok) throw new Error('the save did not reach the server')
            return reply.data as { outcome: string }
          },
        },
        { after: (ms, run) => { const id = setTimeout(run, ms); return () => { clearTimeout(id) } } },
        {
          onReady: loaded => {
            loadedFromDisk = loaded.content
            const editor = createEditor({
              doc: loaded.content,
              parent: host,
              onDocChanged: text => { doc.changed(text); refreshBar(); scheduleRetain() },
            })
            editorHandle.current = editor
            const bar = createFormatBar(editor.view)
            refreshBar = () => {
              const { from, to } = editor.view.state.selection.main
              bar.refresh(editor.text(), from, to)
            }
            surface.prepend(bar.element)
            editor.view.dom.addEventListener('keyup', refreshBar)
            editor.view.dom.addEventListener('mouseup', refreshBar)
            refreshBar()
          },
          onStatus: (state, detail) => {
            /**
             * A13's pill. **`unsaved` is the ordinary dirty state**, emitted on every keystroke —
             * not a failure, and the first version of this handler treated it as §13.5's blocking
             * "could not be saved anywhere" banner. Eight keystrokes produced eight alarms about
             * data loss while nothing was wrong.
             */
            setText(status, state === 'saving' ? 'Saving…'
              : state === 'saved' ? 'Saved'
                : state === 'unsaved' ? 'Editing…'
                  : state === 'idle' ? '' : 'Not saved')

            /**
             * **A13's fade, wired 2026-08-16 — the rule existed and nothing called it.**
             *
             * PRD: *"Saved fades after 2s, Error is sticky."* `save-policy.ts` implements exactly
             * that in `statusFades` and `SAVED_VISIBLE_MS`, both exported, both unit-tested, and
             * **imported by no product code at all** — so the pill was written and never cleared.
             * "Saved" sat on screen until the next keystroke changed it. Found by the reachability
             * sweep, which is the thirteenth control in this build to be complete, tested, and
             * reached by nothing.
             *
             * **Which states fade is `save-policy`'s decision, not this file's.** `error`,
             * `conflict` and `blocked` are the states where something needs a person, and §13.5 is
             * explicit that a data-safety event is a persistent banner rather than a fading toast —
             * *"a status that fades is a decision nobody made."* Asking the policy keeps that rule
             * in the module that states it instead of copying the list of states here.
             *
             * The previous timer is always cleared first: two saves inside two seconds would
             * otherwise leave the first one's timer to blank a pill the second one had just
             * rewritten.
             */
            // A save that lands closes the truncation question: the next large deletion is a new
            // one, and somebody who answered "no" once has not answered for the rest of the session.
            if (state === 'saved') truncationAsk = 'ready'

            if (statusFadeTimer !== null) { clearTimeout(statusFadeTimer); statusFadeTimer = null }
            if (statusFades(state) && state !== 'idle') {
              statusFadeTimer = setTimeout(() => {
                statusFadeTimer = null
                setText(status, '')
              }, SAVED_VISIBLE_MS)
            }

            /**
             * **The retained buffer is dropped the moment the bytes are on disk**, and only then.
             *
             * A buffer that outlives its save is worse than no buffer: the next open finds it,
             * compares it against a file that already contains the same text, and asks a question
             * with no answer. Every other outcome — blocked, conflict, error — keeps it, because
             * in each of those the edit exists nowhere except this browser and the retained copy.
             */
            if (state === 'saved') {
              /**
               * **The baseline moves with the file, and until 2026-08-25 it never did.**
               *
               * `loadedFromDisk` was assigned once, in `onReady`, and read by `retainNow` as its
               * answer to *"is there unsaved work here?"* — a question it cannot answer, because
               * after the first save it means *"has this document changed since it was opened."*
               * Every document the operator edited and then walked away from wrote a rescue copy of text
               * that was already on disk, and the `doc.flush()` beside it saved nothing, so nothing
               * ever discarded it. The buffer then sat invisible until an agent touched the file —
               * at which point the next open offered them a choice between their own saved work and
               * the agent's, wording it as though the agent had overwritten something of their.
               *
               * **Not `editorHandle.current?.text()`.** That is the buffer as it reads *now*, and a
               * keystroke during the round trip has already moved it past what was written. Taking
               * it would mark a genuine unsaved edit as safe and drop the one rescue it had.
               * `detail.onDisk` is the text the session actually sent.
               */
              if (detail?.onDisk !== undefined) loadedFromDisk = detail.onDisk
              if (retainTimer !== null) { clearTimeout(retainTimer); retainTimer = null }
              void buffers.discard(entry.rootId, entry.segments).catch(() => {
                /* the buffer outlives its save; the next open asks about it, which is harmless */
              })
            }

            /**
             * §13.5: a data-safety event is a **persistent banner**, never a fading toast. v1
             * announced a conflict with a 2.5-second toast, which on a phone in a pocket is an
             * announcement that did not happen.
             */
            if (state === 'conflict' && detail?.rescue !== undefined) {
              /**
               * **A RESCUED CONFLICT DROPS THE RETAINED BUFFER, and this is a rule rather than
               * housekeeping.**
               *
               * §13.8's local copy exists for exactly one reason: the edit is nowhere but this
               * browser. Once the save is refused and §13.5 writes the edit to a sibling file, that
               * stops being true — the text is on disk, named, and the two-pane surface is about to
               * ask what to do with it. Keeping the buffer as well means **two questions about one
               * edit**, and they arrive in the worst possible order: "Decide later" reopens the
               * file, the reopen finds the retained buffer, and a second dialog lands on top of the
               * screen the person just chose to postpone.
               *
               * That is not hypothetical. It is how this was found — the existing conflict test went
               * red because the restore modal blocked the reopen and the reminder banner never came
               * back.
               *
               * `error` deliberately does NOT do this. `conflict-unrescued` maps there, and it means
               * the rescue file could not be written — so the browser really does hold the only
               * copy, and the retained buffer is the last line.
               */
              void buffers.discard(entry.rootId, entry.segments).catch(() => {
                /* the rescue file is the copy that matters now */
              })
              void showConflict(entry, detail.rescue)
            } else if (state === 'blocked') {
              /**
               * §13.2: a blocked truncation is *"surfaced as an explicit confirmation naming the
               * loss."* **Until 2026-08-16 this was a banner that named the loss and asked nothing.**
               *
               * Everything else existed: the server decides and returns both byte counts,
               * `confirmTruncation()` re-issues the identical save with the waiver, the wire carries
               * the flag. No product code called it. The comment that used to sit here called the
               * banner *"a question, not a failure"* — it was a sentence with no answer, and because
               * a blocked save never clears the dirty flag, deleting a long section on purpose left
               * the file permanently unsaveable with no sequence of actions that would write it.
               */
              const summary = {
                fileName: entry.name,
                wasBytes: detail?.wasBytes ?? 0,
                willBeBytes: detail?.willBeBytes ?? 0,
              }
              if (truncationAsk === 'ready') {
                truncationAsk = 'open'
                void askAboutTruncation(shell, summary).then(confirmed => {
                  truncationAsk = confirmed ? 'ready' : 'declined'
                  // Only a deliberate confirmation waives the guard, and it waives it for this one
                  // save. The next one is checked again from scratch.
                  if (confirmed) return doc.confirmTruncation()
                  return undefined
                }).catch(() => {
                  // The question could not be asked or the re-issued save threw. Back to `ready` so
                  // the guard is answerable rather than stuck closed — the alternative is the same
                  // dead end this branch was written to remove.
                  truncationAsk = 'ready'
                })
              } else if (truncationAsk === 'declined') {
                feedback.banner('warning',
                  `${truncationHeadline(summary)} You chose not to, so nothing was written.`)
              }
            } else if (state === 'error') {
              /**
               * §13.5's blocking case arrives here: `conflict-unrescued` maps to `error`, because
               * the edit exists **only in this browser** — the rescue file could not be written.
               * It never resolves by discarding the buffer, so the message says what to do rather
               * than what happened.
               */
              feedback.banner('danger', detail?.reason
                ?? 'That did not save. Copy your text somewhere safe before closing this tab.')
            }
          },
        },
      )
      // The session and its surface are registered together; nothing can read one without the other.
      documents.adopt(doc, into)
      await doc.open()

      /**
       * §12's flush contract, **all three triggers** — `visibilitychange`→hidden, `pagehide` and
       * `beforeunload`. Until 2026-08-16 this call site bound only the first, under a function
       * named `onBecameHidden` that read like it bound the contract. The flush is idempotent, so
       * firing it three times costs nothing; see `onSessionEnding`.
       */
      /**
       * **Retained BEFORE the flush, not after, and the order is the whole point.**
       *
       * `visibilitychange`→hidden is the last moment mobile WebKit reliably gives you, and the
       * flush may not finish — iOS can suspend the tab mid-request. Retaining first means the worst
       * case is a local copy of an edit that also saved; retaining second means the case this
       * feature exists for (suspended before the save lands) is the one case with nothing kept.
       *
       * Not awaited in sequence for the same reason: there is no time to spend here.
       */
      onSessionEnding(() => { void retainNow(); void doc.flush() })

      /**
       * **OPENING A FILE NEVER BLOCKS, AND THE APP NEVER ASKS WHICH VERSION YOU WANT.**
       *
       * ruled 2026-08-26, after being asked twice in one week: *"I don't want these dialogs when
       * agents are editing my files inbetween loading them in the viewer, this is unacceptable UI."*
       *
       * ## The design error this replaces, because it is worth naming precisely
       *
       * §13.8's resolution screen was built for a world where the person is the only editor and the
       * file sits still between visits — so a difference between the browser's copy and the disk
       * means they made two versions and must choose. **This tree is the inverse.** Agents are the
       * primary editors, the file changes between almost every visit, and the operator types here rarely
       * and briefly with an autosave a second behind them. The condition the screen treated as a rare
       * event worth blocking the way in for — *these two differ* — is the normal state of their tree,
       * while the thing it protected against, typing that never reached disk, barely happens to them.
       * It had the frequencies backwards.
       *
       * The deeper error: **it treated difference as conflict.** A difference is only a conflict if
       * both sides carry someone's intent. Here the disk is simply newer, and a copy taken against a
       * file that has since moved on is not a version of that file at all — it is a fragment of an
       * older document. Offering it as the alternative to what is on screen is a category error, and
       * no wording could have fixed it.
       *
       * ## So the decision is made from the copy's own state, never from a comparison
       *
       * `inspect` already reports the two apart, because it compares the retained identity token
       * against the one this row was painted with. That distinction used to only change the
       * *wording* of the question. It is now the whole decision:
       *
       * - **`stale`** — something else wrote the file. Drop the copy. Never mention it.
       * - **`available`** — the file is untouched since the copy was taken, so the copy is strictly
       *   newer and there is nothing to choose between. Put it back.
       *
       * `discarded` has already cleaned up after itself: corrupt, oversized, or belonging to a
       * folder that is no longer registered.
       *
       * ## What did NOT change, and must not
       *
       * The rescue copy is still written 400 ms after a keystroke, and a save that fails still
       * raises a persistent banner **at the moment it fails**, while the person is sitting there
       * having just typed. That is the alarm that matters and it is the one this file keeps. What
       * has gone is the deferred alarm — the one that arrived days later, on the way into a file,
       * which is exactly when it was least useful and most in the way.
       *
       * The accepted cost, ruled with the trade in front of them: a save that fails
       * unnoticed, followed by an agent rewriting that same file, loses that typing. Both halves are
       * required, the first is announced when it happens, and they type here rarely.
       */
      const retained = await buffers.inspect(
        entry.rootId, entry.segments, entry.token,
        rootId => folders.some(folder => folder.id === rootId),
      ).catch(() => ({ kind: 'none' as const }))

      if (retained.kind === 'stale') {
        /**
         * An agent wrote the file. The copy describes a document that no longer exists, so it is
         * not evidence of anything and it is not offered — it is dropped, silently, before it can
         * become the question above.
         */
        await buffers.discard(entry.rootId, entry.segments).catch(() => {
          /* it will be dropped on the next open; it is already never shown */
        })
      } else if (retained.kind === 'available'
        // The person may have clicked another file while the store was being read.
        && openFile?.segments === entry.segments) {
        if (worthOffering(retained.buffer.content, loadedFromDisk)) {
          /**
           * **Put it back.** Nothing else has touched this file since the copy was taken, so there
           * is no competing version and nothing to decide — the copy is simply the newer text and
           * the person's own.
           *
           * It goes into the **editor**, not onto disk. The dispatch marks the document dirty, so
           * the ordinary autosave carries it the rest of the way a second later and the save runs
           * §13.5's contract like any other. Nothing here writes to a file.
           *
           * **This is a deliberate departure from §13.8's "a retained buffer is never
           * auto-replayed", made on the ruling of 2026-08-26 with the trade in front of them.**
           * That rule exists to stop a stale copy overwriting an agent's work — and the stale branch
           * above now drops those copies outright, so the case the rule guards cannot reach this
           * line. The token matched: the file is byte-for-byte what it was.
           */
          const view = editorHandle.current?.view
          if (view !== undefined) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: retained.buffer.content },
            })
          }
        }
        /**
         * **There is deliberately no `else`, and the branch that was here got deleted for cause.**
         *
         * The first version of this change dropped the copy when it was byte-identical to the file
         * — the lost-answer case, where the bytes landed and the reply never came back. The
         * reasoning was sound and the branch was **unreachable**, which the mutation sweep proved:
         * commenting the discard out left all seven tests green.
         *
         * Why it cannot fire: for a copy to match the file, the file must have been written since
         * the copy was taken — and every write in this app is temp-then-rename, so it lands on a new
         * inode, and §13.8's identity token is minted from `(dev, ino)`. Any write that could make
         * them match also makes the token differ, which routes the copy to `stale` above. The
         * lost-answer case is handled there, and only there.
         *
         * Written down rather than quietly fixed because this is the build's signature defect — a
         * control that is correct and reached by nothing — and I had just produced a fresh one while
         * removing an older mistake.
         */
      }

      /** The two-pane surface, for a conflict whose rescue already landed on disk. */
      async function showConflict(target: WireEntry, rescue: readonly string[]): Promise<void> {
        /**
         * The banner announces; the surface **replaces** it.
         *
         * §13.5 requires a data-safety event to persist rather than fade — and a banner that is
         * still on screen once the two-pane surface has opened is no longer an announcement, it is
         * an obstacle: it is fixed to the bottom of the window and sits on top of the very buttons
         * that resolve the thing it is warning about. A real click on "Keep yours" was intercepted
         * by it, which is how this was found.
         *
         * So the banner is dismissed when the surface mounts, and comes back if the person chooses
         * "Decide later" — which is §13.5's "Needs attention" case and the one where a persistent
         * reminder is exactly right.
         */
        const announce = (): void => {
          feedback.banner('danger',
            `${target.name} changed on disk. Your edit was saved beside it — choose which to keep.`)
        }
        announce()

        const [theirs, mine] = await Promise.all([
          session.call('file.load', { rootId: target.rootId, segments: [...target.segments] }),
          session.call('file.load', { rootId: target.rootId, segments: [...rescue] }),
        ])
        if (!theirs.ok || !mine.ok) return

        feedback.dismissAll()
        // Into the same host the document is in — a conflict raised by an edit made in the
        // slide-over has to be resolvable there, not on a pane the person cannot currently see.
        mountConflictView(into, {
          panes: {
            theirs: (theirs.data as { content: string }).content,
            mine: (mine.data as { content: string }).content,
            canonicalName: target.name,
            artifactName: rescue[rescue.length - 1] ?? '',
          },
          onDismiss: () => {
            // "Decide later" is a real answer. The reminder stays; the screen goes.
            void opener.run?.(target, into).then(announce)
          },
          onChoose: choice => {
            void (async () => {
              const resolved = await session.call('conflict.resolve', {
                rootId: target.rootId,
                canonical: [...target.segments],
                artifact: [...rescue],
                choice,
                token: target.token,
              })
              if (!resolved.ok) {
                feedback.banner('danger', 'That conflict could not be resolved. Nothing changed.')
                return
              }
              feedback.dismissAll()
              await store.invalidate(target.rootId, target.segments.slice(0, -1))
              // §13.5: "The editor always retargets to canonical."
              await opener.run?.(target, into)
            })()
          },
        })
      }
    }
  })

  /**
   * **THE TASKS TAB.** PRD: *"per-project board with a picker… you choose a project (or a tasks
   * folder); the board shows that scope's lanes."*
   *
   * **THAT RULING WAS REVERSED ON 2026-08-12, and both halves are kept.**
   *
   * The original, 2026-07-28: *"matches the working pattern: go into a project, see its tasks, add
   * from the board. **No global aggregate board in v1.**"*
   *
   * The reversal, after using the built board: *"I want to see all my tasks in one place… having to
   * sift through each project and each sub-project to see my tasks is not very good user
   * experience."* And the shape: *"defaults to all. And then I can pick other projects that I want
   * to show in the board. That's really all I need to filter."*
   *
   * Kept rather than deleted, because a superseded ruling that is simply removed looks like it
   * never existed — and the next reader would find a filtered board with no sign it was once
   * explicitly refused, or would "restore" the old behaviour as a bug fix.
   *
   * **The inversion is the whole point.** The board used to start at nothing and make you pick
   * before it showed anything. It starts at everything and each ticked project narrows it.
   */
  /** The ticked projects. **Empty means every project**, which is the default board. */
  let boardSelection: ReadonlySet<string> = new Set()

  /**
   * Which registered folder the board reads from.
   *
   * **The first one, for now, and that is a stated reduction rather than an oversight.** Every
   * project route takes a `rootId`, and a board spanning two registered folders would need the
   * selection to carry one per entry — which it does — plus a request per root and a merge across
   * them. The operator registers one folder today. Recorded here so the day they register a second, the
   * gap is a line of code with a comment on it rather than a mystery.
   */
  const rootForBoard = (): string | null => projectsForBoard[0]?.rootId ?? null

  /** The ticked projects as paths, for the wire. Empty stays empty, and empty means all. */
  const selectedProjectPaths = (): string[][] =>
    projectsForBoard
      .filter(project => boardSelection.has(selectionKey(project.rootId, project.segments)))
      .map(project => [...project.segments])
  let boardHost: HTMLElement | null = null
  let boardFilterHost: HTMLElement | null = null
  /**
   * Half-typed task names, by lane id. **Outside the view because the view is replaced**, and the
   * board redraws on any watcher event — an agent writing a file into this project while someone
   * is naming a task would otherwise take the name away mid-word.
   *
   * Never cleared wholesale: a lane's entry is emptied when its task is submitted, and an entry for
   * a lane that has since gone is a string nobody reads. Keeping it is cheaper than deciding when
   * it is safe to forget, and it survives switching projects and coming back.
   */
  const taskDrafts = new Map<string, string>()

  /**
   * Draws the board for whichever project is picked.
   *
   * **Lanes and cards are two requests, and both are re-read every time.** The board is a
   * projection of the folder tree and nothing here caches it: a lane created by an agent thirty
   * seconds ago is a column now, which is the whole point of columns being folders.
   */
  /**
   * The move a card makes, whichever gesture asked for it. §18.5.
   *
   * Named and shared rather than written twice: the drag calls it and so does Change status, so
   * §13.8's token, the refusal banner and the unconditional redraw cannot drift apart between the
   * two surfaces. A second copy is how one of them would quietly stop sending the token.
   */
  function moveCardToLane(card: WireEntry, laneId: string): void {
    void (async () => {
      const moved = await session.call('card.move', {
        rootId: card.rootId,
        card: [...card.segments],
        laneId,
        // §13.8's token, the one this card was PAINTED with — so a file an agent replaced
        // since the board was drawn is refused rather than moved.
        token: card.token,
      })
      if (!moved.ok) {
        // PRD's board contract: *"failures visibly snap back"*. The redraw below is the snap.
        feedback.banner('warning', moved.error?.message ?? 'That card could not be moved.')
      }
      // Redrawn either way, and unconditionally — the contract says *"reconcile against disk
      // unconditionally"*, because a move that half-succeeded looks identical to one that did
      // not from here.
      await refreshBoard()
    })()
  }

  async function refreshBoard(): Promise<void> {
    const host = boardHost
    if (host === null) return

    /**
     * §18.6's menu, parented to the board rather than to a card — a card is torn down on every
     * redraw and a menu that outlived its row would be acting on a card that no longer exists.
     *
     * **P9F-6 — this used to say it was "destroyed by the redraw that replaces it, which is what
     * `clear` on the host already does to everything else in here." That was false**, and it is the
     * kind of false that reads as a teardown having been thought about.
     *
     * `createRowMenus` registers three **document-level** listeners — click, keydown, and a
     * capturing scroll. `clear(host)` removes the host's children; it cannot remove a listener on
     * `document`. So every board draw — arriving at the tab, the refresh button, a filter change —
     * left three more behind, permanently, each holding its own closure.
     *
     * the security review filed this as *"`RowMenus.close` and `RowMenus.destroy` reach no product code"*, marked
     * harmless *"only while the boundary renders once at boot"*. The boundary does render once — its
     * `retry` is never called from anywhere. The board is the reachable half, and it redraws all
     * day.
     */
    boardMenus?.destroy()
    // Bound to a local as well, so the callbacks below close over a menu that cannot be null —
    // reassigning the holder is what the NEXT draw does, and a callback reading the holder would
    // then be talking to a menu that had already been destroyed.
    const menus = createRowMenus(host)
    boardMenus = menus

    /**
     * **There is no "nothing chosen" state any more.** The empty selection is the default and it
     * means *every* project — so the board always has something to draw, and the screen that used
     * to say "Choose a project above" is gone with the ruling that required it.
     */
    const root = rootForBoard()
    if (root === null) {
      /**
       * **A29, applied to the request above this one.** Before any of the three sentences below can
       * be true, the projects list has to have answered — and until it has, every one of them is a
       * claim about the tree made by a client that has not been told anything about it.
       *
       * This is the same failure A29 removed for `board.columns`: *"an empty board and a waiting
       * board were the same picture"*. It reached here through a **flaky test rather than a report**
       * — A29's own browser test, which held `board.columns` open and expected `Loading…`, instead
       * found *"No projects found in the folders you have registered"* and polled it fourteen times
       * without it changing. The board was not slow; it had finished, on the wrong answer.
       *
       * **`boardDrawn` is deliberately NOT called here**, unlike the branch below. It clears the
       * stale marker, and a board that has drawn a placeholder has fetched nothing — saying
       * "nothing further to fetch" would be the same class of lie one level down.
       */
      if (!projectsEverLoaded) {
        boardWaitedOnProjects = true
        showBoardWaiting(host)
        return
      }

      /**
       * **THE MESSAGE HAS TO MATCH THE CONDITION, and for a day it did not.**
       *
       * `rootForBoard()` is `projectsForBoard[0]?.rootId ?? null` — it reads the **projects** list,
       * not the registry. So this branch means *"no projects came back"*, and it said *"No folders
       * are registered yet. Add one in Settings"* — which is a different fact, and one that is
       * false whenever a folder is registered and the projects request simply did not answer.
       *
       * **It cost about an hour on 2026-08-14.** An intermittent test failure showed this screen;
       * the sentence sent the investigation at the root registry and the boot-time restore, and the
       * registry was fine every time. §6's rule is that a failure must never arrive looking like a
       * success; this is its neighbour — **a failure must not arrive describing a different
       * failure.**
       *
       * Three conditions, three sentences. `folders` is the registry as this client last read it,
       * which is what makes them tellable apart at all.
       */
      host.replaceChildren(el('div', {
        className: 'board-empty',
        text: folders.length === 0
          ? 'No folders are registered yet. Add one in Settings and your tasks appear here.'
          : 'No projects found in the folders you have registered. A project is a folder inside '
            + '02-projects; add one and it appears here.',
      }))
      boardDrawn('tasks')
      return
    }

    showBoardWaiting(host)
    const request = { rootId: root, projects: selectedProjectPaths() }
    const [lanes, cards] = await Promise.all([
      session.call('board.columns', request),
      session.call('board.cardsFor', request),
    ])
    if (!lanes.ok || !cards.ok) {
      feedback.banner('warning', 'That board could not be read.')
      return
    }

    const byLane = new Map<string, WireEntry[]>()
    for (const group of cards.data as Array<{ laneId: string; cards: WireEntry[] }>) {
      byLane.set(group.laneId, group.cards)
    }

    /**
     * **Typed as what the server actually returns, not as what the view wants.**
     *
     * This read `as Array<BoardLane & { lanes: Lane[] }>`, and that cast was a lie: `BoardLane` has
     * an `id` and `Column` has a **`key`**. The assertion told the compiler `column.id` existed, so
     * every use of it silently produced `undefined` — both columns then collided on the key
     * `"undefined"` in the card map, every lookup missed, and **the board drew every column with
     * zero cards.** Nothing threw and nothing was refused; the tab simply looked like a project
     * with no tasks.
     *
     * Three rounds of this bug were spent on the drop handler because a card that is not on the
     * board cannot be dragged, and the symptom of the real fault is indistinguishable from an empty
     * project. The cast is what hid it: `as` is not a check, and here it was asserting the presence
     * of a field that has never existed on this type.
     */
    const columns = lanes.data as Column[]

    /**
     * **`members` is attached on every board, not only a filtered one.**
     *
     * A backed-out first attempt attached them only when the board spanned projects, and it broke
     * every drag: with them absent the drop fell back to the column's own id, which is a lane
     * *name* rather than a lane *digest*, and `card.move` refused it. Addressing and display are
     * different questions, and only the second depends on how many projects are showing.
     */
    const laneList: BoardLane[] = columns.map(column => ({
      id: column.key, name: column.name, synthetic: column.synthetic, members: column.lanes,
    }))
    const projects = new Set(
      columns.flatMap(column => column.lanes.map(lane => lane.origin.project.join('/'))),
    )
    /** Display only: whether a card names its project, and whether a lane offers a quick-add. */
    const gathered = projects.size > 1

    /** Which project each lane belongs to, for a quick-add whose board may span many. */
    const laneProject = new Map<string, readonly string[]>(
      columns.flatMap(column => column.lanes.map(lane => [lane.id, lane.origin.project] as const)),
    )

    /**
     * **The cards arrive keyed by LANE and the board draws COLUMNS.**
     *
     * The other bug the first attempt shipped: `board.cardsFor` keys by lane id, `mountBoard` looks
     * up `cards.get(lane.id)` where that id is the column key, and the two are different strings by
     * construction. Nothing threw — every column simply drew zero cards, which is indistinguishable
     * from a project with no tasks. No unit test could see it; both halves are correct alone.
     */
    const byColumn = new Map<string, WireEntry[]>(columns.map(column => [
      column.key,
      column.lanes.flatMap(lane => byLane.get(lane.id) ?? []),
    ]))

    if (laneList.length === 0) {
      host.replaceChildren(el('div', {
        className: 'board-empty',
        text: boardSelection.size === 0
          ? 'No tasks yet. A task is a markdown file inside a "tasks" folder in a project — make '
            + 'one and it appears here.'
          : 'Nothing in the projects you have picked. Clear the filter to see everything.',
      }))
      boardDrawn('tasks')
      return
    }

    mountBoard(host, { lanes: laneList, cards: byColumn, gathered, projectCount: projects.size }, {
      onOpen: card => {
        // A25: the card opens beside the board, not instead of it — the board stays mounted and
        // draggable behind the panel. "View in Files" inside the panel is the full-screen route.
        openInPanel(tasksPanel, card, 'tasks')
      },
      // The drag, now one of two callers of the same move. §18.5.
      onMove: (card, laneId) => { moveCardToLane(card, laneId) },
      /**
       * §18.5 — **Change status, and it performs `onMove`'s move rather than a second one.**
       *
       * That is the point of the feature: one mechanism on both surfaces, with the drag demoted to
       * an accelerator. The board resolved the offers, because only it knows how a merged column
       * maps to *this* card's project; everything after the choice is the path a drop already takes,
       * including §13.8's token and the unconditional redraw.
       *
       * **The current lane is offered and does nothing.** It is in the list so the list keeps its
       * shape wherever the card is — see `statusChoicesFor` — and choosing it returns without a
       * request, because a move to where the file already is would be a round trip to change
       * nothing, and the server would have to decide what that means.
       *
       * **No confirmation**, per §18.5 and the operator directly: a status change is a file moving
       * between two visible folders and the reverse is the same action again. §13.4 already forbids
       * asking about something that safe.
       */
      onChangeStatus: (card, choices, anchor, node) => {
        if (choices.length === 0) return
        menus.open({
          anchor,
          subject: card.title.length > 0 ? card.title : card.name,
          // §4.6's *acted on* state, cleared by whichever way the menu closes.
          row: node,
          actions: choices.map(choice => ({
            id: choice.id,
            label: choice.current ? `${choice.label} — now` : choice.label,
          })),
          onChoose: laneId => {
            if (choices.find(choice => choice.id === laneId)?.current === true) return
            moveCardToLane(card, laneId)
          },
        })
      },
      drafts: taskDrafts,
      onDraft: (laneId, text) => { taskDrafts.set(laneId, text) },
      /**
       * **Creation-is-placement.** The lane is an id and the project is where the picker is
       * standing; between them the server knows the folder, and the person named a task without
       * choosing a location, a template or a status.
       *
       * `boardProject` is re-read here rather than captured, because the picker can move between
       * the board being drawn and a task being typed into it.
       */
      onAdd: (laneId, name) => {
        /**
         * **The project comes from the lane, not from the filter.** A board can now show many
         * projects, so there is no single "current project" to create into — but a quick-add only
         * exists on an unfiltered single-project column, and the lane it belongs to knows exactly
         * where it lives. Built from the same reply the board was drawn from, so a lane that has
         * since gone is not in the map and the create is not attempted.
         */
        const project = laneProject.get(laneId)
        if (project === undefined || root === null) return
        void (async () => {
          const made = await session.call('card.create', {
            rootId: root,
            project: [...project],
            laneId,
            name,
          })
          if (!made.ok) {
            // A lane that stopped existing between the paint and the Enter lands here as
            // STALE_TARGET, and the redraw below is what shows the board it actually has now.
            feedback.banner('warning', made.error?.message ?? 'That task could not be added.')
          }
          await refreshBoard()
        })()
      },
    })
    boardDrawn('tasks')
  }

  boundary.register('tasks', () => {
    const pane = el('div', { className: 'tasks-pane' })
    const bar = el('div', { className: 'board-bar' })

    /**
     * The filter's own host, redrawn whenever the selection or the project list changes. The picker
     * is a view over both and holds neither.
     */
    const filterHost = el('div', { className: 'tasks-project-filter' })
    boardFilterHost = filterHost
    append(bar, el('span', { className: 'board-bar-label', text: 'Showing' }), filterHost)
    append(bar, refreshControl('tasks', 'the tasks board', () => { void refreshBoard() }))
    const host = el('div', { className: 'board-host' })
    boardHost = host
    append(pane, bar, host)
    tasksPanel = createCardPanel(pane, {
      /**
       * the ruling: Tasks goes full screen on a phone, Projects stays a side panel.
       *
       * **Phone only, unlike the Inbox.** On a desktop the board behind this panel is the context
       * you are moving a card within — which lane it is in, what else is in that lane. Filing an
       * inbox item has no such context, which is why that one goes to `'both'`.
       */
      fullScreen: 'phone',
      exemptClasses: ['board-card'],
      blockedByOverlay: () => shell.querySelector('.modal-backdrop') !== null,
    })
    panels.push(tasksPanel)
    append(shell, pane)
    panes.set('tasks', pane)
  })

  /** The projects the picker offers. Re-read whenever the folder list changes. */
  let projectsForBoard: ReadonlyArray<{
    rootId: string; segments: readonly string[]; name: string; parentPath: readonly string[]
  }> = []

  /**
   * **Whether `projects.list` has ever answered**, which is NOT the same question as whether
   * `projectsForBoard` is empty — and telling them apart is the whole of A29 applied to this
   * request rather than to `board.columns`.
   *
   * An empty list means *"there are no projects"*. An unanswered one means *"I have not been told
   * yet"*, and the board drew the first sentence for both. `reloadProjects` is deliberately
   * un-awaited at boot (the picker is off the critical path), so `showTab('tasks')` can reach the
   * board first and paint **"No projects found in the folders you have registered"** over a tree
   * that is full of them.
   */
  let projectsEverLoaded = false

  /**
   * Set when the board gave up because the projects list had not arrived. It is the signal that the
   * board is showing a placeholder nothing else will replace — `reloadProjects` reads it and
   * redraws exactly once.
   *
   * **Narrow on purpose.** The boot comment warns that redrawing the board from the project restore
   * *"cost thirteen browser tests"* by racing the tree's own restore, so this fires only from the
   * one state that is genuinely stuck, never on an ordinary boot.
   */
  let boardWaitedOnProjects = false

  const reloadProjects = async (): Promise<boolean> => {
    const listed = await session.call('projects.list')
    if (!listed.ok) {
      /**
       * **A REFUSED REQUEST MUST NOT PRESENT AS AN EMPTY RESULT.** §6, and this swallowed it.
       *
       * The list was left at its previous value — empty, at boot — and the board then drew *"No
       * projects found in the folders you have registered"*, which is a statement about the tree.
       * Its only caller does `if (!listed) return`, so nothing anywhere said a request had failed.
       *
       * **Found 2026-08-14 through an intermittent test**, and the swallowing is why it took a day:
       * every screen said the app was fine and empty. `folders.list` next to it has surfaced its
       * failures since P7; this one never did.
       *
       * The banner rather than a thrown error, for the reason `reloadFolders` gives: the picker is
       * not on the critical path, and a board that fails to *narrow* is still a usable board.
       */
      feedback.banner('danger', 'Could not read the list of projects.')
      return false
    }
    projectsForBoard = listed.data as typeof projectsForBoard
    projectsEverLoaded = true
    drawProjectFilter()

    /**
     * **The board gave up before this answered, so redraw it — once.**
     *
     * Without this the placeholder is permanent: `reloadProjects` is un-awaited and nothing else
     * repaints the tasks board, so a boot that lost the race left *"No projects found"* on screen
     * until the person pressed Refresh. That is the intermittent failure the empty-branch comment
     * below records as costing about an hour, seen from the other end.
     *
     * Guarded by the flag rather than run unconditionally, because an unconditional refresh here is
     * the one the boot comment says cost thirteen browser tests.
     */
    if (boardWaitedOnProjects) {
      boardWaitedOnProjects = false
      void refreshBoard()
    }
    return true
  }

  /**
   * Redraws the picker from the current project list and selection.
   *
   * **The board is refreshed by the change handler and not by this**, so redrawing the control
   * after a board read cannot loop back into another read. The two are deliberately one-directional:
   * a tick changes the selection, the selection redraws both, and nothing here calls the server.
   */
  function drawProjectFilter(): void {
    const host = boardFilterHost
    if (host === null) return
    mountProjectFilter(host, {
      projects: projectsForBoard,
      selected: boardSelection,
      onChange: next => {
        boardSelection = next
        drawProjectFilter()
        void refreshBoard()
        /**
         * **Remembered across a restart.** The operator's point 5 — *"I shouldn't have to re-filter
         * everything back to the view that I was in."* Within a session the panes stay mounted and
         * this costs nothing; the write is what carries it over a quit.
         *
         * Not awaited, and a failure is not surfaced: the board on screen is already correct, and a
         * banner about a *preference* that did not save would be noise over an action that worked.
         */
        void session.call('board.setSelection', {
          projects: projectsForBoard
            .filter(project => next.has(selectionKey(project.rootId, project.segments)))
            .map(project => ({ rootId: project.rootId, segments: [...project.segments] })),
        })
      },
    })
  }

  /**
   * **THE PROJECTS TAB.** The operator's Trello, settled 2026-08-10.
   *
   * Every verb below writes app config and nothing else. Their rule: *"when I drag stuff around that
   * board nothing is supposed to happen on disk."* The one action here that reaches the file tree
   * is opening a project in Files, which reads.
   */
  let projectsHost: HTMLElement | null = null
  /** P14 B1. Null until `boundary.register('boards', …)` runs, exactly as the others are. */
  let boardsHost: HTMLElement | null = null
  /** The Boards pane's row menus — B4's move picker. One per pane, like the tree's and the board's. */
  let boardsMenus: RowMenus | null = null
  /** The Boards card panel — the Tasks-style editor, not the Projects-style folder list. */
  let boardsPanel: CardPanel | null = null
  /**
   * The columns as last drawn, so a move can name a destination by id.
   *
   * **Read from here rather than re-fetched when the menu is answered.** The menu offers exactly the
   * columns that were on screen when it opened; resolving the choice against a fresher board could
   * move the card into a column the person never saw. If the board has changed underneath, the move
   * fails on §13.8's token — which is the check that is supposed to catch it.
   */
  let latestColumns: readonly BoardColumnView[] = []
  let projectsPanel: CardPanel | null = null
  let tasksPanel: CardPanel | null = null
  let inboxPanel: CardPanel | null = null

  /**
   * **A document, in a board's slide-over.** The PRD's *"card tap opens a slide-over panel with the
   * full editor beside the board"*, for the two tabs whose cards are files.
   *
   * The editor is the Files pane's editor, mounted into the panel — same session, same autosave,
   * same conflict contract, same retained buffer. Building a second one here is the failure this
   * whole build is organised against, and it would be a second one that has to agree with the first
   * about §13 forever.
   */
  /**
   * **THE WAY OUT OF A FULL-SCREEN PANEL, and both panel builders now use it.**
   *
   * A full-screen card has no outside to click. That is deliberate — it removes the mis-click
   * the operator described, *"if you click anywhere else on the screen, like another dropped item, it
   * defaults to that item"* — but it means the labelled control IS the exit, not a convenience.
   *
   * **`openFolderInPanel` shipped without one and an adversarial review measured the result.** On a
   * phone, tapping an inbox folder gave a 390×844 panel sitting over the tab bar with no back
   * control, no outside, and no keyboard: the only way out was *View in Files* — the automatic jump
   * they had just asked to stop being what a tap does. It was a trap on their primary device, on the
   * exact surface they first reported an exit problem for.
   *
   * The folder panel never needed it before because it only served Projects, which is never full
   * screen. Giving the Inbox that panel changed what it had to carry, and I did not notice.
   *
   * Hidden by CSS wherever the panel is a slide-over with an outside to click.
   */
  const appendPanelBack = (host: HTMLElement, panel: CardPanel, cameFrom: string): void => {
    const label = originLabel(cameFrom)
    const back = el('button', {
      className: 'card-panel-back',
      text: `\u2039 ${label}`,
      attributes: { type: 'button', 'aria-label': `Back to ${label}` },
    })
    back.addEventListener('click', () => { void panel.close() })
    append(host, back)
  }

  /**
   * **A FOLDER IN A PANEL: what is inside it, and a way to go there.** Not a document — a folder has
   * nothing to edit, so this lists and offers rather than opening.
   *
   * **Extracted 2026-08-19 so the Inbox and Projects share one**, when the operator asked for an inbox
   * folder to behave the way a project card does: *"it should do exactly what a project does — when
   * I click on it, it slides out from the right, it shows the contents of the folder, and it gives
   * you a button to view in files."* It lived inline in the Projects board's `onOpen` and the honest
   * way to give the Inbox the same thing is to call it, not to copy it. Two copies of a panel body
   * is the drift this build has been bitten by repeatedly — the search control presses one door for
   * the same reason.
   *
   * **`View in Files` is where the jump lives now.** It stopped being what a *click* does — which is
   * what the operator objected to (*"I don't love the automatic jump"*) — and became what a labelled
   * button does, which is the part they say already works well here.
   */
  const openFolderInPanel = (
    panel: CardPanel | null,
    place: { readonly rootId: string; readonly segments: readonly string[] },
    title: string,
    where: string,
    from: string,
  ): void => {
    if (panel === null) return
    void panel.open(`${place.rootId}/${place.segments.join('/')}`, host => {
      // Full screen on a phone means this IS the exit. See `appendPanelBack`.
      appendPanelBack(host, panel, place.segments.at(-2) ?? from)
      append(host, el('div', { className: 'card-panel-title', text: title }))
      if (where !== '') append(host, el('div', { className: 'card-panel-where', text: where }))

      const list = el('div', { className: 'card-panel-list' })
      append(host, list)

      const jump = el('button', {
        className: 'card-panel-action', text: 'View in Files', attributes: { type: 'button' },
      })
      jump.addEventListener('click', () => { jumpToFolder(place.rootId, place.segments, from) })
      append(host, jump)

      void (async () => {
        const reply = await session.call('tree.children', {
          rootId: place.rootId, segments: [...place.segments],
        })
        if (!reply.ok) {
          append(list, el('div', {
            className: 'card-panel-empty', text: 'That folder could not be read.',
          }))
          return
        }
        const rows = reply.data as WireEntry[]
        if (rows.length === 0) {
          append(list, el('div', { className: 'card-panel-empty', text: 'Empty.' }))
          return
        }
        for (const row of rows) {
          const item = el('div', { className: 'card-panel-item' })
          append(item, el('span', {
            className: 'card-panel-item-kind',
            text: row.kind === 'directory' ? 'folder' : 'file',
          }))
          append(item, el('span', { className: 'card-panel-item-name', text: row.name }))
          append(list, item)
        }
      })()
    })
  }

  const openInPanel = (panel: CardPanel | null, entry: WireEntry, from: string): void => {
    if (panel === null) return
    void panel.open(`${entry.rootId}/${entry.segments.join('/')}`, host => {
      /**
       * **THE WAY BACK, and on a phone it is the only one.**
       *
       * A full-screen card has no outside to click, which is deliberate: the exit problem the operator
       * described was *"if you click anywhere else on the screen, like another dropped item, it
       * defaults to that item… you have to click that little strip on the top."* Removing the
       * outside removes the mis-click; this replaces it with a labelled control.
       *
       * **It names where you came from, not what it does.** `‹ 01-urgent` rather than `‹ Back` —
       * the packet's rule, and it is the difference between a control you can aim at and one you
       * have to remember. The origin is the card's own parent folder, which for a task is its lane
       * and for an inbox item is the inbox it sits in.
       *
       * Hidden by CSS on desktop and on Projects, where the panel is a slide-over with a board
       * beside it and an outside to click.
       */
      appendPanelBack(host, panel, entry.segments.at(-2) ?? from)

      /**
       * **View in Files stays**, above the document rather than instead of it. The operator uses the
       * Files pane for real reading and the panel is the quick look beside the board; taking the
       * jump away would make the panel a worse version of both.
       */
      const jump = el('button', {
        className: 'card-panel-action',
        text: 'View in Files',
        attributes: { type: 'button' },
      })
      const surface = el('div', { className: 'card-panel-doc' })
      jump.addEventListener('click', () => {
        void (async () => {
          // Closed FIRST, so the panel's teardown flushes this document before the Files pane
          // opens it again. Reversed, the reopen would race the flush on the same file.
          await panel.close()
          // `from` is the tab this panel belongs to — the origin the back control names.
          showTab('files', from)
          /**
           * **A10: the tree opens to the file.** A board card is not a tree row, so arriving from
           * one used to leave the file open in the editor and *nowhere* in the tree — selected, and
           * inside folders nobody had expanded. Revealing it is what makes "View in Files" mean
           * what it says.
           */
          void store.revealPath(entry.rootId, entry.segments)
          await opener.run?.(entry)
        })()
      })
      append(host, jump, surface)
      void opener.run?.(entry, surface)

      /**
       * §13, on the exit this surface adds: *"pending edits are never silently dropped — closing a
       * panel, switching files, or quitting flushes or asks."* Awaited by the panel before the
       * contents are replaced, so a swap flushes the outgoing document too.
       */
      return async () => {
        /**
         * **The surface stops being somewhere a reopen may draw, first.** It is about to be
         * detached, and `openFileHost` is a reference rather than a path — a watcher event arriving
         * after this panel closed would otherwise mount a live editor into an element that is in no
         * document, which is a save loop nobody can see. Cleared back to `null` so a later reopen
         * lands in the Files pane, which is where it landed before any of this existed.
         */
        if (openFileHost === surface) openFileHost = null
        /**
         * **Only the document this surface drew** — the security review's C3, and both halves of it.
         *
         * `ownedBy` is the first half: `surface` is created fresh by every open, so this is an
         * identity question rather than a path question. A reopen driven by the watcher keeps the
         * document in this same element — that is what `openFileHost` above is for — so what gets
         * flushed here is the *current* session and not the stale one this closure was built beside.
         *
         * `release` is the second half, and it is the one that needed no race at all. The flush
         * below is a network round trip; a click on another surface during it adopts a new session,
         * and the version that nulled the global unconditionally wiped **that** registration on the
         * way out. Both rules live in `document-registry.ts`, where a test can drive them.
         */
        const doc = documents.ownedBy(surface)
        if (doc === null) return
        await doc.flush()
        doc.close()
        documents.release(doc)
      }
    })
  }
  /** The Projects filter. Held here so a redraw after an edit does not clear what was typed. */
  let projectsFilter = ''
  /** The board last painted, so a filter change can repaint without a round trip. */
  let projectsLast: ProjectBoardReply | null = null

  /**
   * **A29 — a board that is waiting says so, rather than looking empty.** Annex A29: *"Explicit
   * loading states, never a blank frame."*
   *
   * **The failure is that an empty board and a waiting board are the same picture.** A board draws
   * from a round trip; until it answers, the surface said *"nothing here"* — which for a moment is
   * the app asserting something false about the person's own files. §6's rule that an empty result
   * must never stand in for a failure has a neighbour here: it must not stand in for a *pending* one
   * either.
   *
   * **Locally that window is ~25 ms and invisible. Over the tailnet on a phone it is three round
   * trips**, which is long enough to read and believe.
   *
   * Drawn only if the host is still empty — a **redraw** of a board that already has cards keeps
   * them on screen while the new data arrives, because replacing a good board with the word
   * "Loading" is a worse answer than a board one refresh out of date.
   */
  const showBoardWaiting = (host: HTMLElement): void => {
    if (host.firstElementChild !== null) return
    host.replaceChildren(el('div', { className: 'board-empty', text: 'Loading…' }))
  }

  async function refreshProjects(): Promise<void> {
    const host = projectsHost
    if (host === null) return
    showBoardWaiting(host)
    const reply = await session.call('projects.board')
    if (!reply.ok) {
      feedback.banner('warning', 'The projects board could not be read.')
      return
    }
    paintProjects(host, reply.data as ProjectBoardReply)
  }

  /**
   * **The Boards home list.** P14 B1.
   *
   * Same shape as `refreshProjects` above and deliberately not a shared abstraction with it: the two
   * will diverge at B2, when a board opens into columns and this grows a second screen. Factoring
   * them together now would have to be undone then, and the undoing is where the bugs live.
   */
  async function refreshBoards(): Promise<void> {
    const host = boardsHost
    if (host === null) return
    showBoardWaiting(host)
    const reply = await session.call('boards.list')
    if (!reply.ok) {
      feedback.banner('warning', 'The list of boards could not be read.')
      return
    }
    openBoard = null
    /**
     * **The arrange stack cannot outlive the board it arranges.**
     *
     * Almost every route here closes it already: pressing *‹ Boards*, or a tab, is a click outside
     * the panel, and that is exactly what the panel dismisses on. **The route that does not is a
     * press inside the stack itself** — those are deliberately exempt from the dismiss, so when one
     * of them finds the board gone and falls back to the list, nothing else is left to close it. A
     * stack of columns from a board that no longer exists, offering to arrange it.
     *
     * `arrangeStack` is the exact test rather than a guess at the key: the teardown nulls it, so it
     * is non-null precisely while the stack is mounted.
     */
    if (arrangeStack !== null) void boardsPanel?.close()
    renderBoards(host, reply.data as BoardRow[], {
      onOpen: board => {
        openBoard = board
        void refreshOneBoard()
      },
      onNewBoard: () => { void createBoard() },
    })
  }

  /**
   * **CREATING A BOARD — where first, then what to call it.** P14 B4, the order.
   *
   * **No default location, on their own reasoning.** They considered defaulting to a project's shared
   * canvas and talked themselves out of it: *"maybe no default, to make it simpler — you just have to
   * pick in the file tree where you want it."*
   *
   * The `board-` prefix is prepended to what they type **before** it reaches the server, and that is
   * the one place in Boards where the client shapes a name. It is not slugging — the server still
   * does that, as `entry.create` requires — it is adding the grammar's marker, which is what makes
   * the folder recognisable as a board afterwards. Prefixing server-side instead would mean
   * `entry.create` had a board-shaped special case in it, and that verb is shared by everything.
   */
  async function createBoard(): Promise<void> {
    /**
     * `askWhereToMove` with no `subject` — the generalisation its own docstring describes: *"Phase 8
     * asks the same question ('which folder?') to name a template."* Creating a board is the third
     * caller of that question, and a second tree picker would be two implementations of one widget.
     */
    const where = await askWhereToMove(shell, {
      store,
      folders: folders.map(folder => ({ id: folder.id, name: folder.name })),
      title: 'Where should this board live?',
      confirmLabel: 'Create here',
    })
    if (where === null) return

    const typed = await askForName(shell, {
      title: 'What is this board called?',
      confirmLabel: 'Create',
    })
    if (typed === null || typed.trim() === '') return

    /**
     * **FROM THEIR TEMPLATE, IF THEY HAVE REGISTERED ONE.** Ruled 2026-08-19, reversing their own *"no
     * template, nothing pre-filled"*:
     *
     * > *"I feel each board should include a context folder and file… as well as an m-thread per
     * > board. And so I have gone ahead and created that in Canon and I have worked it into the
     * > scaffold skill."*
     *
     * **Recognised by the grammar, not by a setting.** Their template folder is literally called
     * `board-template`, so *"the one named for boards"* is just: the registered template that is a
     * board folder. They register it once from a Files row menu, exactly as they register the op and
     * project templates, and nothing asks them again.
     *
     * **A bare folder when there is no template**, which is what Boards did before this and what it
     * still does on a machine where nothing is registered. The feature turns itself on.
     */
    const template = templates.find(candidate =>
      candidate.available && isBoardFolder(candidate.segments.at(-1) ?? ''))

    /**
     * **The template and the destination must share a registered folder** — the security review's C1, which is a
     * property of `entry.copy` rather than a rule Boards invents: it takes **one** `rootId`, so a
     * cross-root copy is a destination nobody named.
     *
     * Said out loud rather than silently falling back. A board that arrives empty when they expected
     * their context and m-thread inside it is the kind of quiet difference they would not notice until
     * it mattered, and the fix — register the two in one folder — is not guessable from an empty
     * board.
     */
    if (template !== undefined && template.rootId !== where.rootId) {
      feedback.banner('warning',
        `${template.name} lives in a different registered folder, so this board was made empty.`)
    }

    const useTemplate = template !== undefined && template.rootId === where.rootId
    const named = fileNameFrom(`${BOARD_PREFIX}${typed}`)
    if (useTemplate && !named.ok) {
      feedback.banner('warning', 'That name cannot be used for a folder.')
      return
    }

    /**
     * **Two verbs, and neither is new.** Creating a bare board is `entry.create`; creating one from
     * the template is `entry.copy` with §13.8's token on the source, read **immediately before** the
     * copy — the same path a New Op takes from a row menu, called rather than copied.
     *
     * The token is fetched rather than carried because a template is named by the registry and not
     * by a row on screen: there is no token in hand, and fetching it means a template renamed or
     * replaced since boot cannot be scaffolded from a stale idea of what it is.
     */
    const reply = useTemplate && template !== undefined && named.ok
      ? await copyBoardTemplate(template, where, named.value.name)
      : await session.call('entry.create', {
        rootId: where.rootId,
        parent: [...where.segments],
        name: `${BOARD_PREFIX}${typed}`,
        kind: 'directory',
      })
    if (reply === null) return
    if (!reply.ok) {
      feedback.banner('warning', reply.error?.message ?? 'That board could not be created.')
      return
    }
    await refreshBoards()
  }

  /**
   * Reads the template's current token, then copies it into place. Returns `null` when the template
   * itself could not be read — the caller has already been told, and nothing was attempted.
   */
  async function copyBoardTemplate(
    template: { readonly name: string; readonly rootId: string; readonly segments: readonly string[] },
    where: { readonly rootId: string; readonly segments: readonly string[] },
    name: string,
  ): Promise<CallResult | null> {
    const row = await session.call('tree.entry', {
      rootId: template.rootId, segments: [...template.segments],
    })
    if (!row.ok) {
      feedback.banner('warning',
        `The ${template.name} template could not be read. Nothing was created.`)
      return null
    }

    return session.call('entry.copy', {
      // `where.rootId`, not the template's — they are equal by the guard above, and this is the one
      // that has to be right, because the destination path is `where`'s. Reading them from two
      // different objects is exactly what produced C1.
      rootId: where.rootId,
      from: [...template.segments],
      to: [...where.segments, name],
      plan: false,
      token: (row.data as WireEntry).token,
    })
  }

  /**
   * **The board screen.** P14 B2 — §18.4's *"two screens, never both"*, applied to this tab.
   *
   * `openBoard` is the whole of the screen state: null is the list, a board is that board. One
   * variable rather than a screen enum, because there are exactly two states and a third would need
   * a reason to exist.
   */
  let openBoard: BoardRow | null = null

  async function refreshOneBoard(): Promise<void> {
    const host = boardsHost
    const board = openBoard
    if (host === null || board === null) return
    showBoardWaiting(host)

    const reply = await session.call('boards.open', {
      rootId: board.rootId, segments: [...board.segments],
    })
    // **Checked after the await.** They can press back while the round trip is in flight, and drawing
    // a board into a host that is now showing the list is the stale-reply bug quick-open guards.
    if (openBoard !== board) return
    if (!reply.ok) {
      /**
       * **A board that has gone falls back to the list rather than sitting on a dead screen.**
       *
       * The server now refuses a board whose folder is no longer in the index, instead of returning
       * an empty one — see `openBoardAt`. Without this the refusal left the previous board's columns
       * on screen with a warning above them, which is its own kind of lie.
       *
       * `STALE_TARGET` is the specific case worth its own sentence: renamed, archived or moved while
       * the tab was elsewhere. Anything else keeps the general message.
       */
      const gone = reply.error?.code === 'STALE_TARGET'
      feedback.banner('warning', gone
        ? `${board.name} is not there any more — it may have been renamed or archived.`
        : 'That board could not be read.')
      if (gone) {
        openBoard = null
        await refreshBoards()
      }
      return
    }

    latestColumns = reply.data as BoardColumnView[]
    paintOneBoard(board)
  }

  /**
   * **Draws `latestColumns`.** Split out of `refreshOneBoard` so an arrangement can repaint the board
   * **before** the save lands rather than a round trip after it — see `setColumnOrder`.
   */
  function paintOneBoard(board: BoardRow): void {
    const host = boardsHost
    if (host === null) return

    renderOneBoard(host, board, latestColumns, {
      onBack: () => { void refreshBoards() },
      /**
       * **THE CARD OPENS IN A PANEL BESIDE THE BOARD. It does not jump.**
       *
       * ruled 2026-08-19, using the version that jumped: *"when I go into a board and I click a
       * card it just jumps you to the card in files… I need to be able to interact with a board the
       * same way I interact with tasks, where the thing pops out from the side and I can edit it
       * from there."*
       *
       * `openInPanel` is the Tasks card's own opener — the editor, plus `View in Files` inside the
       * panel for when they do want to leave. **The board stays mounted behind it**, which is the
       * whole point: the jump lost their place, and going back landed them on the boards home list.
       *
       * **The real row is fetched rather than assembled from the card.** `openInPanel` takes a
       * `WireEntry`, and a hand-built object with four of its fields and a cast is a promise about a
       * shape this code does not have — the opener reads `kind`, `isMarkdown`, `size` and
       * `contentUnavailable` to decide what surface a document gets. A cast that lies typechecks.
       */
      onOpenCard: card => {
        void (async () => {
          const row = await session.call('tree.entry', {
            rootId: card.rootId, segments: [...card.segments],
          })
          if (!row.ok) {
            feedback.banner('warning', 'That card could not be opened — the board may be stale.')
            return
          }
          openInPanel(boardsPanel, row.data as WireEntry, 'boards')
        })()
      },
      onNewColumn: () => { void createInBoard(board, [...board.segments], 'directory', 'column') },
      onNewCard: column => {
        // `column.segments` is null only for Uncategorized, and no button is drawn there.
        if (column.segments === null) return
        void createInBoard(board, [...column.segments], 'file', 'card')
      },
      onMoveCard: (card, from, trigger) => { moveCard(card, from, trigger) },
      onDropCard: (card, from, to, before) => { void dropCard(card, from, to, before) },
      onNudgeColumn: (column, by) => { nudgeColumn(column, by) },
      onArrangeColumns: () => { arrangeColumns() },
    })

    /**
     * **The stack follows the board.** Every repaint reaches it — an arrow press, a move made in the
     * panel itself, and a change the watcher noticed — so the two controls cannot disagree about the
     * order, and a column created while the panel is open appears in it.
     */
    drawArrangeStack()
  }

  /**
   * A column or a card. One function, because the two differ only in `kind` and in what they are
   * called — and the alternative is two near-identical blocks that drift on the next change.
   */
  async function createInBoard(
    board: BoardRow,
    parent: readonly string[],
    kind: 'file' | 'directory',
    noun: 'column' | 'card',
  ): Promise<void> {
    const typed = await askForName(shell, {
      title: noun === 'column' ? 'What is this column called?' : 'What is this card called?',
      // `md` for a card so the preview shows the extension it will actually get — §13.6's preview,
      // and the reason `askForName` takes this rather than the caller appending it afterwards.
      ...(kind === 'file' ? { extension: 'md' } : {}),
      confirmLabel: 'Create',
    })
    if (typed === null || typed.trim() === '') return

    const reply = await session.call('entry.create', {
      rootId: board.rootId, parent: [...parent], name: typed, kind,
    })
    if (!reply.ok) {
      feedback.banner('warning', reply.error?.message ?? `That ${noun} could not be created.`)
      return
    }
    await refreshOneBoard()
  }

  /**
   * **MOVING A CARD BETWEEN COLUMNS MOVES THE FILE.** §13.6's exclusive rename, unchanged.
   *
   * Boards adds no new way to touch the tree: this is `entry.rename`, the same verb the Files tab's
   * move uses, with the same entity token and the same refusals. **The card keeps its filename** —
   * only its parent changes — because renaming on a move would make the remembered order lose track
   * of it and would rewrite a name the operator chose.
   */
  function moveCard(card: BoardCardView, from: BoardColumnView, trigger: HTMLElement): void {
    const menus = boardsMenus
    if (menus === null) return

    const columns = latestColumns.filter(column =>
      column.segments !== null && column.id !== from.id)

    /**
     * **Reordering lives in the same menu, and this is what makes the stored arrangement reachable.**
     *
     * P14 B3 built the machinery — an order held on the Mac, arrivals landing at the bottom — and
     * B4 shipped with **nothing that could ever write one**: `boards.setOrder` was a route with no
     * caller. That is the *"complete, tested, and reachable by nothing"* defect this build has found
     * five times. This is the caller.
     *
     * **One menu rather than a second pair of buttons on every card.** Three controls per card is
     * clutter at 390px, and §18.5 already made this menu the way a card is moved — reordering is the
     * same question with a different answer.
     *
     * **Up on the first card and down on the last are omitted, not disabled.** A menu entry that
     * does nothing is indistinguishable from one that is broken.
     *
     * Column choices are prefixed `col:` so a folder genuinely named `up` or `down` cannot be
     * mistaken for a direction. Sentinel ids that a real folder could collide with is the kind of
     * bug that shows up once, on someone else's tree.
     */
    const at = from.cards.findIndex(other => other.name === card.name)
    const canReorder = from.segments !== null && at !== -1
    const actions: Array<{ id: string; label: string }> = []
    if (canReorder && at > 0) actions.push({ id: 'up', label: 'Move up' })
    if (canReorder && at < from.cards.length - 1) actions.push({ id: 'down', label: 'Move down' })
    for (const column of columns) actions.push({ id: `col:${column.id}`, label: `To ${column.name}` })

    if (actions.length === 0) {
      feedback.banner('warning',
        'There is nowhere else to put it yet — add another column, or another card.')
      return
    }

    /**
     * **The row menu, not a new dialog — and callback-driven, not wrapped in a promise.**
     *
     * It is already generic over the id *because* §18.5's status picker offers lane ids read off the
     * disk; column ids are the same thing one tab over. It also already owns every way a menu closes
     * and §18.6's phone sheet.
     *
     * The first version awaited a promise resolved by `onChoose`, with `onClose` resolving null.
     * **`onClose` is supplied by `createRowMenus` and never by a caller** — its own comment says so —
     * so a menu dismissed with Escape or an outside click would have left that promise pending
     * forever, holding the card and its column alive with nothing to release them.
     */
    const box = trigger.getBoundingClientRect()
    menus.open<string>({
      anchor: { x: box.left, y: box.bottom },
      subject: card.title.trim() === '' ? card.name : card.title,
      actions,
      onChoose: id => {
        if (id === 'up' || id === 'down') { void reorderCard(from, at, id); return }
        void moveCardTo(card, id.slice('col:'.length))
      },
    })
  }

  /**
   * **Swaps a card with its neighbour and remembers the result.** P14 B3's arrangement, written.
   *
   * The whole column's order is sent, not a two-item edit. The stored value **is** the arrangement,
   * so sending a delta would mean the server reconstructing an order from a change against a state
   * the client believes it has — and the client's belief is one paint old. One list in, one list
   * stored.
   *
   * Nothing on disk moves. `boards.setOrder` writes app config alone, which is the rule for
   * the Projects board applied here: *"when I drag stuff around that board nothing is supposed to
   * happen on disk."*
   */
  async function reorderCard(
    column: BoardColumnView, at: number, direction: 'up' | 'down',
  ): Promise<void> {
    if (column.segments === null) return
    const to = direction === 'up' ? at - 1 : at + 1
    if (to < 0 || to >= column.cards.length) return

    const order = column.cards.map(card => card.name)
    const moved = order[at]
    const displaced = order[to]
    // Both are read before either is written: swapping through a single temporary is where an
    // off-by-one turns into a duplicated name, and a duplicated name is a card drawn twice.
    if (moved === undefined || displaced === undefined) return
    order[to] = moved
    order[at] = displaced

    /**
     * **The root comes from the open board, not from a card in the column.**
     *
     * Reading it off `cards[0]` would work for every case a test happens to cover and fail on an
     * empty column — which is still a column someone may be arranging into.
     */
    const board = openBoard
    if (board === null) return

    const reply = await session.call('boards.setOrder', {
      rootId: board.rootId, segments: [...column.segments], order,
    })
    if (!reply.ok) {
      feedback.banner('warning', 'That new order could not be saved.')
      return
    }
    // Repainted from the board the server now holds — `boards.setOrder` returns it for that reason.
    await refreshOneBoard()
  }

  /**
   * **A CARD DROPPED.** Ruled 2026-08-22: *"I want to be able to grab it and move an item between,
   * and then rearranging."*
   *
   * **Two different operations behind one gesture, and only one of them touches the disk.**
   *
   * - **Within a column** it is an arrangement: `boards.setOrder`, app config alone. Their rule for the
   *   Projects board, applied here — *"when I drag stuff around that board nothing is supposed to
   *   happen on disk."*
   * - **Between columns** the file moves, because the columns **are** folders. That is
   *   `entry.rename`, the same verb the move menu uses, with the same entity token and the same
   *   refusals — Boards still adds no new way to touch the tree.
   *
   * The order is written **after** the move so the card lands where it was dropped rather than at
   * the bottom. Two round trips for one gesture, and the alternative is a card that appears
   * somewhere other than where the hand let go.
   */
  async function dropCard(
    card: BoardCardView,
    from: BoardColumnView,
    to: BoardColumnView,
    before: number,
  ): Promise<void> {
    const board = openBoard
    if (board === null || to.segments === null) return

    const sameColumn = from.id === to.id
    const at = sameColumn ? to.cards.findIndex(other => other.name === card.name) : null
    const index = droppedAt(before, at, to.cards.length)

    if (sameColumn) {
      // Dropped where it already is. Refused rather than written: a save that changes nothing still
      // repaints the board under the hand that just let go.
      if (at === null || at === -1 || at === index) return
      await setCardOrder(to, moveWithin(to.cards.map(other => other.name), at, index))
      return
    }

    if (!await moveCardTo(card, to.id)) return
    /**
     * The destination's names **as it was drawn**, with the arrival spliced in. Read from the paint
     * rather than from the refreshed board because the refresh has not happened yet — and a name
     * list that omitted the card would file it as an arrival at the bottom, which is the bug this
     * whole branch exists to avoid.
     */
    const names = to.cards.map(other => other.name)
    names.splice(index, 0, card.name)
    await setCardOrder(to, names)
  }

  /** The one card-order write. `reorderCard` and a drop both come through here. */
  async function setCardOrder(
    column: BoardColumnView, order: readonly string[],
  ): Promise<void> {
    const board = openBoard
    if (board === null || column.segments === null) return

    const reply = await session.call('boards.setOrder', {
      rootId: board.rootId, segments: [...column.segments], order: [...order],
    })
    if (!reply.ok) {
      feedback.banner('warning', 'That new order could not be saved.')
      return
    }
    await refreshOneBoard()
  }

  /**
   * **THE REAL COLUMNS — the list every arrangement control counts against.**
   *
   * `Uncategorized` is pinned leftmost and is not a folder, so it is never arranged. Read from
   * `latestColumns` at the moment of the press rather than from anything the view captured: a board
   * that changed under an open panel would otherwise be arranged by its old shape.
   *
   * **The drawn index is not this index**, and that distinction is the bug the first version of this
   * shipped with — it counted from the drawn list, so the first real column was offered a "move
   * left" that moved it nowhere.
   */
  const realColumns = (): BoardColumnView[] =>
    latestColumns.filter(column => column.segments !== null)

  /**
   * **MOVING A COLUMN. Nothing on disk moves.** Ruled 2026-08-21: *"it doesn't need or use any
   * numbering system, just the ability to move around the columns to different orders and have the
   * app remember where I put them."*
   *
   * The same arrangement store the cards use, one level up — a card is arranged against its column,
   * a column against its board. **Boards only:** they were explicit that Tasks does not change, and a
   * Tasks lane still comes from its fixed roster.
   *
   * **One press, from an arrow on the head.** It was a `⋯` menu offering *Move left* and *Move
   * right*, and they rejected it after using it: *"if I want to move something all the way over, it's
   * messy."* Two presses per place is what made distance expensive.
   */
  function nudgeColumn(column: BoardColumnView, by: -1 | 1): void {
    const real = realColumns()
    const here = real.findIndex(other => other.id === column.id)
    if (here === -1) return
    void setColumnOrder(moveWithin(real.map(other => other.id), here, here + by))
  }

  /**
   * The one write. Both controls funnel through it, so neither can grow its own idea of what saving
   * means — and `moveWithin` is the only thing that computes an order, so neither can grow its own
   * off-by-one either.
   *
   * **The board repaints BEFORE the save, not a round trip after it**, and that is not polish.
   *
   * Every press reads `latestColumns` to work out where the column currently is. Painting only on
   * the reply leaves that list stale for the whole round trip, so a second press during it computes
   * **the same move again** and the first one is silently overwritten: two presses, one move. Over
   * Tailscale on a phone the round trip is long enough that a thumb outruns it easily, and the
   * feature the operator asked for is precisely *pressing an arrow several times in a row*.
   *
   * `applyCardOrder` is the server's own arranging rule, called rather than re-derived, so the
   * picture drawn here and the picture that comes back cannot disagree about anything. The pinned
   * `Uncategorized` pile is put back at the front because it is not part of any arrangement.
   *
   * A refusal repaints from the server, which is what puts the board back if the save was rejected.
   */
  async function setColumnOrder(order: readonly string[]): Promise<void> {
    const board = openBoard
    if (board === null) return

    const pinned = latestColumns.filter(column => column.segments === null)
    const arranged = applyCardOrder(realColumns(), column => column.id, order)
    latestColumns = [...pinned, ...arranged]
    paintOneBoard(board)

    const reply = await session.call('boards.setColumnOrder', {
      rootId: board.rootId, segments: [...board.segments], order: [...order],
    })
    if (!reply.ok) {
      feedback.banner('warning', 'That new column order could not be saved.')
    }
    // Repainted from the board the server now holds, which also redraws the arrange stack — and on a
    // refusal it is what takes the optimistic picture back off the screen.
    await refreshOneBoard()
  }

  /**
   * **THE ARRANGE PANEL.** Ruled 2026-08-21: *"some kind of interface where I could click
   * rearrange and then I can see them all like in a stack and I can arrange the board top to bottom
   * equals left to right."*
   *
   * The same panel a card opens — full screen on a phone, a slide-over on the desktop — so it
   * inherits the way out that `appendPanelBack` exists for: the back control on a phone, a click
   * outside on the desktop.
   *
   * **Pressing *Arrange* again is NOT the way out, and a first version of this claimed it was.** The
   * panel opens over the right-hand end of the board's bar, which is where that button lives — so it
   * is underneath the panel and cannot be pressed. WebKit failed the assertion outright; Chromium
   * passed it on timing, which is the more dangerous of the two.
   *
   * `arrangeStack` is kept so `refreshOneBoard` can redraw the stack in place. Redrawing by calling
   * `open` again would *close* it — the toggle — which is the shape of bug that would have been
   * found by hand and never by a test.
   */
  let arrangeStack: HTMLElement | null = null

  function arrangeColumns(): void {
    const board = openBoard
    const panel = boardsPanel
    if (board === null || panel === null) return

    void panel.open(`arrange:${board.rootId}/${board.segments.join('/')}`, host => {
      appendPanelBack(host, panel, board.name)
      append(host, el('div', { className: 'card-panel-title', text: 'Arrange columns' }))
      const stack = el('div', { className: 'arrange' })
      append(host, stack)
      arrangeStack = stack
      drawArrangeStack()
      // Dropped on teardown so a later refresh cannot draw into a host that is no longer mounted.
      return () => { arrangeStack = null }
    })
  }

  /** Draws the stack from `latestColumns`. A no-op unless the panel is open, so callers need no guard. */
  function drawArrangeStack(): void {
    const stack = arrangeStack
    if (stack === null) return

    const real = realColumns()
    renderArrangeColumns(stack, real.map(column => ({ id: column.id, name: column.name })), {
      hasPinnedFirst: latestColumns.some(column => column.segments === null),
      onMove: (from, to) => { void setColumnOrder(moveWithin(real.map(c => c.id), from, to)) },
    })
  }

  async function moveCardTo(card: BoardCardView, columnId: string): Promise<boolean> {
    const destination = latestColumns.find(column => column.id === columnId)
    if (destination?.segments == null) return false

    /**
     * §13.8's entity token, read immediately before the move. Required, never optional — *"an
     * optional token is a control the client can switch off by omission."* Reading it here rather
     * than carrying one from the paint means a card replaced since the board was drawn refuses,
     * instead of the move landing on whatever now holds that path.
     */
    const row = await session.call('tree.entry', {
      rootId: card.rootId, segments: [...card.segments],
    })
    if (!row.ok) {
      feedback.banner('warning', 'That card could not be found — the board may be out of date.')
      return false
    }

    const reply = await session.call('entry.rename', {
      rootId: card.rootId,
      from: [...card.segments],
      to: [...destination.segments, card.name],
      token: (row.data as { token: string }).token,
    })
    if (!reply.ok) {
      feedback.banner('warning', reply.error?.message ?? 'That card could not be moved.')
      return false
    }
    await refreshOneBoard()
    // Reported, because a DROP has a second half: the card still has to land where it was let go,
    // and writing an order for a move that never happened would file a name with nothing behind it.
    return true
  }

  /** Applies a config edit and repaints from the board the server hands back. */
  const editProjects = async (route: string, body: unknown): Promise<void> => {
    const reply = await session.call(route, body)
    const host = projectsHost
    if (!reply.ok) {
      feedback.banner('warning', reply.error?.message ?? 'That change could not be saved.')
      // Repainted anyway: the board on screen may have moved a card optimistically, and the
      // server's answer is the only true one. Same reconcile-unconditionally rule as Tasks.
      await refreshProjects()
      return
    }
    if (host !== null) paintProjects(host, reply.data as ProjectBoardReply)
  }

  function paintProjects(host: HTMLElement, board: ProjectBoardReply): void {
    projectsLast = board
    /**
     * Cleared here rather than in `refreshProjects`, because this is the one function that draws
     * and three separate callers reach it — including the filter, which repaints from the copy it
     * already holds. A filter keystroke is not fresh data, but the board it produces is no more
     * stale than the one before it, and leaving the marker up would make it mean two things.
     */
    boardDrawn('projects')
    const view: ProjectsBoardView = {
      columns: board.columns,
      cards: board.cards.map(card => (card.kind === 'project'
        ? {
          kind: 'project' as const,
          columnId: card.columnId,
          title: card.project.name,
          where: card.project.parentPath.join(' / '),
          body: '',
          ref: { rootId: card.project.rootId, segments: card.project.segments },
        }
        : {
          kind: 'staged' as const,
          columnId: card.columnId,
          title: card.card.name,
          where: '',
          body: card.card.body,
          ref: { staged: card.card.id },
        })),
    }

    mountProjectsBoard(host, view, {
      filter: projectsFilter,
      onFilter: query => {
        projectsFilter = query
        // Repainted from the board already in hand: filtering is a view concern and asking the
        // server again on every keystroke would be a round trip per character.
        if (projectsLast !== null) paintProjects(host, projectsLast)
      },

      onPlace: (card, columnId) => {
        void ('staged' in card.ref
          ? editProjects('projects.stage', {
            id: card.ref.staged, name: card.title, body: card.body, columnId,
          })
          : editProjects('projects.place', {
            rootId: card.ref.rootId, segments: [...card.ref.segments], columnId,
          }))
      },

      onOpen: card => {
        const ref = card.ref
        if ('staged' in ref) return
        /**
         * **The slide-over, not a jump.** A25, and the call: a project card opens a panel
         * beside the board rather than throwing you into another tab to see what a project is.
         *
         * A project is a folder, so there is no document to edit here — the panel shows what is
         * inside it and offers the jump as a choice rather than making it for you. PRD's *"View in
         * Files (jump to the tab with that folder selected)"* is that button.
         */
        openFolderInPanel(projectsPanel, ref, card.title, card.where, 'projects')
      },

      onEditPlan: card => {
        const ref = card.ref
        // Narrowed OUTSIDE the closure and captured. A `'staged' in card.ref` check inside the
        // async body narrows nothing: `card.ref` is a property access, re-read on every use, so
        // control-flow analysis cannot carry the narrowing across the await.
        if (!('staged' in ref)) return
        const id = ref.staged
        void (async () => {
          const edited = await askForPlan(shell, { name: card.title, body: card.body })
          if (edited === null) return
          if (edited.removed) {
            await editProjects('projects.unstage', { id })
            return
          }
          await editProjects('projects.stage', {
            id, name: edited.name, body: edited.body, columnId: card.columnId,
          })
        })()
      },

      onAddPlan: columnId => {
        void (async () => {
          const made = await askForPlan(shell, { name: '', body: '' })
          if (made === null || made.removed) return
          await editProjects('projects.stage', {
            id: '', name: made.name, body: made.body, columnId,
          })
        })()
      },

      onRenameColumn: columnId => {
        void (async () => {
          const current = board.columns.find(column => column.id === columnId)
          if (current === undefined) return
          const typed = await askForName(shell, {
            title: `Rename ${current.name}`, initial: current.name, confirmLabel: 'Rename',
          })
          if (typed === null) return
          await editProjects('projects.setColumns', {
            columns: board.columns.map(column =>
              (column.id === columnId ? { id: column.id, name: typed } : { ...column })),
          })
        })()
      },

      onAddColumn: () => {
        void (async () => {
          const typed = await askForName(shell, { title: 'New column', confirmLabel: 'Add' })
          if (typed === null) return
          /**
           * The id is derived from the name and disambiguated against what exists — the same job
           * `folderIdFor` does for folders, and the same reason: an id a person never sees still
           * has to be unique, and a collision would silently merge two columns.
           */
          const taken = new Set(board.columns.map(column => column.id))
          const base = slugStem(typed) || 'column'
          let id = base
          let suffix = 2
          while (taken.has(id)) { id = `${base}-${suffix}`; suffix += 1 }
          await editProjects('projects.setColumns', {
            columns: [...board.columns.map(column => ({ ...column })), { id, name: typed }],
          })
        })()
      },
    })

    /**
     * **The refresh control is moved back into the bar the view just rebuilt.**
     *
     * `mountProjects` clears the host and draws its own filter bar, so a control appended once
     * would be detached by the next paint and never seen again. The same move `copyPathButton`
     * makes into a pane header: one retained element, re-parented by whoever draws the container.
     * Appended rather than recreated, so the marker state it is carrying survives the redraw.
     */
    const control = refreshControls.get('projects')
    const bar = host.querySelector('.board-filter')
    if (control !== undefined && bar !== null) bar.appendChild(control.element)
  }

  /**
   * **THE INBOX TAB.** PRD: *"v1 shows and receives"*, and capture is the point of it.
   *
   * Capture is `entry.create` — the same verb New File uses. There is no second creation path, so
   * §13.6's slugification, the exclusive create and the never-make-a-directory rule all apply here
   * because they apply there.
   */
  let inboxHost: HTMLElement | null = null

  /**
   * Redraws the Inbox, and optionally **opens one item once it is drawn**.
   *
   * The second half is the operator's, 2026-08-16, on what capture used to do:
   *
   * > *"I have to like name something, and then it like escapes to way down. I have to find it,
   * > then I have to open it, then I have to edit… I'd rather just, like, name it, and it opens it
   * > right away."*
   *
   * **The lookup has to happen here** rather than at the call site, because this is the only place
   * the freshly-listed rows exist. A caller holding the create reply has segments and a root id but
   * no `WireEntry` — no title, no token — and the panel needs a row, not a path.
   */
  async function refreshInbox(
    openAfter?: { readonly rootId: string; readonly segments: readonly string[] },
  ): Promise<void> {
    const host = inboxHost
    if (host === null) return
    showBoardWaiting(host)
    const reply = await session.call('inbox.list')
    if (!reply.ok) {
      feedback.banner('warning', 'The inboxes could not be read.')
      return
    }

    const groups = reply.data as InboxGroupView[]
    mountInbox(host, groups, {
      onCapture: (group, typed) => {
        void (async () => {
          const made = await session.call('entry.create', {
            rootId: group.rootId,
            parent: [...group.segments],
            name: typed,
            kind: 'file',
          })
          if (!made.ok) {
            feedback.banner('warning', made.error?.message ?? 'That could not be captured.')
            return
          }
          // §15: a file operation confirms. It names where, because the target is a choice — and
          // it still earns its place now the item opens: the panel says WHAT you made, the toast
          // says WHICH inbox it went into, which the panel does not show.
          feedback.toast('info', `Captured in ${group.label}.`)
          /**
           * **And it opens, which is the whole point of the change.** The operator: *"I'd rather just,
           * like, name it, and it opens it right away."* A capture that files a title and leaves
           * you looking at a list is a note you have to go and find before you can write it — and
           * on a full inbox it lands at the bottom, off screen.
           *
           * The segments come from the reply rather than from what was typed. Same rule as A5's
           * new-file open: the server slugifies, so the typed name opens nothing.
           */
          const created = (made.data as { segments: string[] }).segments
          await refreshInbox({ rootId: group.rootId, segments: created })
          // The tree may be showing that folder; a capture is a change like any other.
          await store.invalidate(group.rootId, group.segments)
        })()
      },

      onOpen: item => {
        /**
         * **A FOLDER OPENS A PANEL. It does not jump.** Ruled 2026-08-19, using the build that
         * did jump: *"I don't love the automatic jump… it should do exactly what a project does —
         * when I click on it, it slides out from the right, it shows the contents of the folder, and
         * it gives you a button to view in files."*
         *
         * The same panel a project card opens, called rather than copied. The jump still exists and
         * is still the right answer — it is now behind that button instead of being the click.
         *
         * **Three wrong answers preceded this one and each was worse than the last.** It handed the
         * folder to the *document* opener, so a phone said "this kind of file cannot be shown here"
         * and a desktop landed on an empty pane. Then it jumped, which worked and was not wanted.
         * The comment above the first version said it *"goes to Files where a tree can expand it"* —
         * describing an intent the code never had.
         */
        if (item.kind === 'directory') {
          openFolderInPanel(
            inboxPanel,
            item,
            item.title.trim() === '' ? item.name : item.title,
            // ` / ` like the Projects card's own `where`, so one panel does not show two formats.
            item.segments.slice(0, -1).join(' / '),
            'inbox',
          )
          return
        }
        openInPanel(inboxPanel, item, 'inbox')
      },
    })
    boardDrawn('inbox')

    if (openAfter === undefined) return
    /**
     * **Matched on the row key, not on the name.** §13.6 slugifies server-side, so `Call the roofer`
     * arrives as `call-the-roofer.md` — searching for what was typed would find nothing, every time.
     * The segments come from the create reply for the same reason.
     *
     * A miss is silent on purpose. The file is made and the list is showing it; failing to open it
     * is a worse screen, not a lost thought, and a banner about it would be alarming out of
     * proportion to what went wrong.
     */
    const wanted = rowKey(openAfter.rootId, openAfter.segments)
    const made = groups
      .flatMap(group => group.items)
      .find(item => rowKey(item.rootId, item.segments) === wanted)
    if (made !== undefined) openInPanel(inboxPanel, made, 'inbox')
  }

  boundary.register('inbox', () => {
    const pane = el('div', { className: 'tasks-pane' })
    const bar = el('div', { className: 'board-bar' })
    append(bar, refreshControl('inbox', 'the inboxes', () => { void refreshInbox() }))
    const host = el('div', { className: 'board-host inbox-host' })
    inboxHost = host
    append(pane, bar, host)
    // An inbox row is the exempt class here — the same reason a board card is on the other two
    // boards: clicking the next item is a swap, performed by that row's own handler.
    inboxPanel = createCardPanel(pane, {
      /**
       * **Phone only, since 2026-08-19 — and this reverses a ruling of their from 2026-08-16.**
       *
       * They were asked then whether a desktop inbox item should open full-screen like the phone's or
       * keep the side panel, and said *"yes"* to full screen. Having used it, they reversed it while
       * asking for inbox folders to behave like project cards: *"yes, they should be side panels for
       * desktop… full screen on the phone, side panel on the desktop."*
       *
       * The original reasoning was that filing needs no context behind it. What it did not account
       * for is that this list now opens two different kinds of thing — a document to read, and a
       * **folder** whose panel is a list of what is inside it — and two behaviours in one list is
       * the thing that feels broken even when it is deliberate: you cannot tell what a click will do
       * until you have done it.
       *
       * The exit problem it also solved is unaffected: `exemptClasses` still stops a click on
       * another item navigating instead of closing.
       */
      fullScreen: 'phone',
      exemptClasses: ['inbox-item'],
      blockedByOverlay: () => shell.querySelector('.modal-backdrop') !== null,
    })
    panels.push(inboxPanel)
    append(shell, pane)
    panes.set('inbox', pane)
  })

  boundary.register('projects', () => {
    const pane = el('div', { className: 'tasks-pane' })
    const host = el('div', { className: 'board-host' })
    projectsHost = host
    append(pane, host)
    /**
     * Created here but **appended by `paintProjects`**, because this board's bar belongs to the
     * view and is rebuilt from scratch on every paint. Registering it now is what makes it exist to
     * be re-parented — and to be marked stale by an event that arrives before the first paint.
     */
    refreshControl('projects', 'the projects board', () => { void refreshProjects() })
    /**
     * **A25's slide-over, one per tab that has cards.** It is mounted on the pane rather than the
     * shell so it slides over its own board and leaves the others alone.
     *
     * `blockedByOverlay` is the Escape handoff: while any modal is up — the plan composer, a rename
     * — that layer owns the key, and the panel declines rather than both acting on one press.
     *
     * **Asked of `shell`, not of `pane`, and the first version asked the wrong one.** Every modal in
     * this app mounts on the shell: `askForPlan(shell, …)`, `askAboutTruncation(shell, …)`. A
     * backdrop therefore never appears inside the pane, so the guard returned `false` while a
     * composer was open and the panel took the Escape anyway — closing itself *and* the dialog on
     * one press, which is precisely the double-fire A25 names the handoff to prevent.
     */
    projectsPanel = createCardPanel(pane, {
      exemptClasses: ['board-card'],
      blockedByOverlay: () => shell.querySelector('.modal-backdrop') !== null,
    })
    panels.push(projectsPanel)
    append(shell, pane)
    panes.set('projects', pane)
  })

  /**
   * **THE BOARDS TAB.** P14 B1 — the home list, and read-only.
   *
   * No card panel and no refresh control yet: there are no cards on this screen to open, and
   * nothing here can go stale in a way a button would fix that reopening the tab does not. Both
   * arrive with B2, when a board opens into columns.
   */
  boundary.register('boards', () => {
    const pane = el('div', { className: 'tasks-pane' })
    const host = el('div', { className: 'board-host boards-host' })
    boardsHost = host
    boardsMenus = createRowMenus(pane)
    /**
     * **The card panel — and it is the Tasks one, not the Projects one.** Ruled 2026-08-19:
     * *"I need to be able to interact with a board the same way I interact with tasks, where the
     * thing pops out from the side and I can edit it from there, I can view it in files from there.
     * It should look exactly like tasks and it should act exactly like tasks."*
     *
     * The distinction matters: a project's panel **lists a folder**, because a project has no
     * document to edit. A board card **is** a markdown file, so it gets the editor — which is what
     * `openInPanel` opens and what Tasks uses.
     *
     * `fullScreen: 'phone'` matches Tasks exactly, and they confirmed it when asked rather than
     * leaving it inferred from "exactly like tasks": *"full screen on the phone, side panel on the
     * desktop."* A side panel at 390px leaves a sliver of board, which is not context.
     *
     * **The board stays mounted behind it.** That is the whole of what they were objecting to — the
     * card used to throw them into Files and lose their place.
     */
    boardsPanel = createCardPanel(pane, {
      fullScreen: 'phone',
      /**
       * `boards-card` is A25's exemption: a click on a card swaps the panel, and that card's own
       * handler does it.
       *
       * `board-column-move` is the arrows, added with them. Arranging is one activity whichever
       * control they reache for, and an arrow that shut the arrange stack every time it was pressed
       * would make the two halves of this feature fight each other.
       */
      exemptClasses: ['boards-card', 'board-column-move'],
      blockedByOverlay: () => shell.querySelector('.modal-backdrop') !== null,
    })
    panels.push(boardsPanel)
    append(pane, host)
    append(shell, pane)
    panes.set('boards', pane)
  })

  /**
   * **THE RAIL'S HEADER BLOCK.** Packet §4.1, and the reference app it was drawn from:
   *
   * > *"the plus new button, the settings button up top, the name of it up top and how many
   * > workspaces there are"*
   *
   * Built here rather than inside the Files renderer because it belongs to the **app**, not to a
   * tab — Files is merely the first tab to show it. Appended before `renderAll()` below, which is
   * what puts the sidebar in, so the header lands above the tree without anyone having to reorder.
   *
   * **Desktop only.** The phone's header is its own thing — §4.1 gives it a 96px title block and no
   * sidebar at all — and its Settings strip above the tab bar is a surface the operator ruled and tested
   * on their own phone. Nothing here goes near it: the gear is hidden below 768px and the strip is
   * hidden above it, so there is exactly one way into Settings at each width.
   *
   * The `+ New` button is deliberately absent. It is the one thing in §4.1 that is a new **action**
   * rather than a new arrangement — a rail-level create has no folder to create into, unlike a row
   * menu, which knows because you clicked it. It gets its own unit and its own tests.
   */
  const railWorkspaces = el('div', { className: 'rail-workspaces' })

  /**
   * Two call sites set `folders`: `reloadFolders` above and the boot read below. **Both must call
   * this**, and a third assignment that does not would leave the count frozen at whatever it was —
   * a wrong number is worse than no number, because it looks like an answer.
   */
  const refreshWorkspaceCount = (): void => {
    const count = folders.length
    setText(railWorkspaces, `${count} workspace${count === 1 ? '' : 's'}`)
  }
  refreshWorkspaceCount()

  const railIdentity = el('div', { className: 'rail-identity' })
  append(
    railIdentity,
    el('div', { className: 'rail-wordmark', text: 'Soil Viewer' }),
    railWorkspaces,
  )

  /**
   * Feather's `settings` glyph, the same one the reference app draws, expressed as two paths — the
   * ring is an arc pair rather than a `<circle>` so the icon helper needs one element type.
   */
  const GEAR_RING = 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z'
  const GEAR_BODY = 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'

  const railGear = el('button', {
    className: 'rail-gear',
    // Named, because the icon inside is `aria-hidden` and a button with no text has no name at all.
    attributes: { type: 'button', 'aria-label': 'Settings' },
  })
  railGear.append(icon([GEAR_RING, GEAR_BODY], 13))
  railGear.addEventListener('click', () => { settingsDoor.press() })

  /**
   * **The collapse.** §4.1: 272px down to a 44px strip holding nothing but the way back out,
   * `width .2s ease`. The operator named it among the things they wanted from the reference app — *"the way
   * you can collapse it"* — and it is the reason the rail owns the width rather than the sidebar.
   *
   * **One button, not two.** The chevron turns around rather than being swapped for its mirror, so
   * there is a single control with a single state and no pair to get out of step. Its name changes
   * with it, because *"Collapse sidebar"* on a collapsed rail is a lie a screen reader would read
   * out.
   *
   * **Not remembered across a reload**, deliberately. Persisting it means a stored preference and a
   * migration for the day its shape changes, and the cost of guessing wrong is that the app opens
   * with its navigation hidden. A33 remembers the tab because landing on the wrong tab is harmless.
   */
  let railCollapsed = false
  const CHEVRON_LEFT = 'M15 18l-6-6 6-6'
  const railCollapse = el('button', {
    className: 'rail-collapse',
    attributes: { type: 'button', 'aria-label': 'Collapse sidebar', 'aria-expanded': 'true' },
  })
  railCollapse.append(icon([CHEVRON_LEFT], 12))
  railCollapse.addEventListener('click', () => {
    railCollapsed = !railCollapsed
    setRootAttribute('data-rail', railCollapsed ? 'collapsed' : 'open')
    railCollapse.setAttribute('aria-label', railCollapsed ? 'Expand sidebar' : 'Collapse sidebar')
    railCollapse.setAttribute('aria-expanded', String(!railCollapsed))
  })
  setRootAttribute('data-rail', 'open')

  /**
   * **`data-tab` is stamped here too, and the omission was a real phone bug.**
   *
   * The rail unit made the phone's tree conditional on it —
   * `:root[data-layout='mobile']:not([data-tab='files']) .files-sidebar { display: none }` — and
   * `:not([data-tab='files'])` **matches an element with no such attribute at all**. The only
   * writer is `showTab`, which runs at the end of an async boot: after `folders.list`, the
   * session-memory restore and the reveal. `renderAll()` below draws the panes long before that.
   *
   * So on a phone the tree was hidden for the entire restore — a blank screen for as long as the
   * round trip takes, which over the tailnet is not instant. Desktop never showed it, because there
   * the rail is a box with no per-tab rule and the tree paints as soon as it is built.
   *
   * `files` rather than the remembered tab, because the remembered one is not known yet — that is
   * the whole point. `showTab` corrects it a moment later, and its own fallback is `files` too, so
   * the common case is stamped right the first time.
   */
  setRootAttribute('data-tab', 'files')

  /**
   * **THE SEARCH CONTROL.** P13, and §16's *"⌘K on desktop, a search field on phone"* finally having
   * something on screen to press.
   *
   * Feather's `search` glyph: a ring and the handle, as two paths for the same reason the gear is —
   * the icon helper takes one element type.
   *
   * **First in the actions row.** It is the frequent control, and the collapse chevron belongs at
   * the outer edge against the rail's own border rather than with a button pushed past it.
   *
   * It calls `openQuickOpen` and mounts nothing itself. Same rule as the gear directly below, for
   * the same reason: one door, one handler, no second copy of the query protocol to drift.
   */
  const SEARCH_RING = 'M11 4a7 7 0 1 0 0 14 7 7 0 1 0 0-14z'
  const SEARCH_HANDLE = 'M20 20l-4.35-4.35'

  const railSearch = el('button', {
    className: 'rail-search',
    // Named, for the same reason the gear is: the icon inside is `aria-hidden`, so a button with no
    // text has no accessible name at all.
    attributes: { type: 'button', 'aria-label': 'Search' },
  })
  railSearch.append(icon([SEARCH_RING, SEARCH_HANDLE], 13))
  railSearch.addEventListener('click', () => { openQuickOpen({ toggle: false }) })

  const railActions = el('div', { className: 'rail-actions' })
  append(railActions, railSearch, railGear, railCollapse)

  const railHeader = el('div', { className: 'rail-header' })
  append(railHeader, railIdentity, railActions)

  /**
   * **The header, then the tabs, then the tree.** §4.1's order, and the reason the tab bar is
   * appended here rather than where it was built: it is the rail's second band, under a 1px rule,
   * and the sidebar that `renderAll()` adds next is the third.
   *
   * **On a phone the tab bar is still the bar across the bottom.** It does not move in the DOM to
   * get there — the rail stops being a box at that width (`display: contents`), so the bar lays out
   * against the shell exactly as it did before it had a rail to sit in. Nothing is re-parented when
   * the layout flips, which it can do live on a window drag.
   */
  append(rail, railHeader, tabBar)

  boundary.renderAll()

  /**
   * **Last into the rail, so it sits at the foot of it.** The sidebar above takes the free height,
   * which puts this against the bottom edge without a fixed offset to keep in step with anything.
   *
   * A rail child rather than a shell child even though a phone has no rail: at that width the rail
   * is not a box at all, and `.status` positions itself against the viewport exactly as it did
   * before. One element, one place in the DOM, two arrangements.
   */
  append(rail, status)

  /**
   * The registered folders, which are the tree's top level.
   *
   * After `boundary.renderAll()`, so the pane exists before rows can arrive — the store announces
   * as soon as the first response lands, and an announcement with no view attached is a render
   * into nothing.
   */
  /**
   * Re-reads the folder list and hands the new set of roots to the tree.
   *
   * Extracted from the boot path when Settings arrived, because registering a folder has to do
   * exactly what boot does — and the version that did not was the fifth module this phase with a
   * correct implementation and no way to observe it. `setRoots` announces, so the tree redraws with
   * the new root already in it; no reload, which is what the operator means by *"a normal settings
   * menu"*.
   */
  const reloadFolders = async (): Promise<boolean> => {
    const listed = await session.call('folders.list')
    if (!listed.ok) return false
    folders = listed.data as ReadonlyArray<FolderName & { displayPath: string }>
    // Registering or removing a folder changes the rail's count. One of the two places that must.
    refreshWorkspaceCount()
    store.setRoots(folders.map(folder => folder.id))
    /**
     * **Nothing is auto-expanded, because the operator asked for collapsed by default** — *"it is
     * collapsed by default"*, matching the app this replaces.
     *
     * An earlier version opened every root here, reasoning that a newly drawn root row would
     * otherwise hide the contents someone was already looking at. They ruled the other way, and the
     * ruling costs nothing: expansion is per-client session memory (§15), so a folder they open
     * stays open across reloads. Only a genuinely first visit starts closed.
     */
    return true
  }

  /**
   * **A file changed on disk and this client did not do it.** Spec §15.
   *
   * Two things happen, in this order, and the order is the point: the tree is made true first, and
   * only then is the open document reconsidered — because deciding what to do about the open file
   * requires the *refreshed* listing to look the entry up in. Reading the stale cache would hand
   * the editor back the row it already had, complete with the entity token the server has since
   * invalidated, and the reopen would be refused for a reason nobody could see.
   *
   * **A dirty buffer is never replaced.** The person's unsaved text is the one thing on screen that
   * exists nowhere else, and a watcher event is not permitted to be the second writer to it. They
   * get a persistent banner instead, and §13.5's conflict contract — which already refuses a save
   * onto changed bytes and rescues the edit beside the file — handles it properly at save time.
   *
   * A clean buffer is reopened, because there is nothing to lose and a reader looking at a file an
   * agent rewrote thirty seconds ago is exactly the failure this whole channel exists to prevent.
   */
  async function onFilesChanged(event: ChangedEvent): Promise<void> {
    await applyChanged(store, event)

    /**
     * **The tree has just been made true; the boards have not.** They are drawn from the index on
     * arrival and nothing here redraws them — so this is the moment they become out of date, and
     * the moment their refresh control has to start saying so. Marked before the reopen work below,
     * because none of that can fail in a way that would make this untrue.
     */
    markBoardsStale()

    const target = openFile
    const verdict = openFileVerdict(event, target, documents.current()?.peek() ?? null)
    if (verdict === 'ignore' || target === null) return
    const name = target.segments[target.segments.length - 1] ?? ''

    if (verdict === 'keep-and-announce') {
      // §13.5: anything about a file's state is a banner, never a toast. On a phone in a pocket a
      // 2.5-second announcement about someone else's write is an announcement that did not happen.
      feedback.banner('warning',
        `${name} changed on disk while you were editing it. Your version is still here — saving`
        + ' will ask you which one to keep.')
      return
    }

    /**
     * **A conversation refreshes in place.** Reopening it would rebuild the whole surface and throw
     * away where the reader is; the view's own redraw follows the annex's scroll rule instead, and
     * only moves the view if they were already at the end.
     */
    if (chatroomRefresh !== null && isChatroom(target.segments)) {
      await chatroomRefresh()
      return
    }

    /**
     * **The folder is fetched when the tree has never listed it, and that is not a nicety.**
     *
     * This used to be `store.childrenOf(...)` and a silent `return` when the answer was
     * `undefined` — which was correct while the only way to open a file was to click a row in the
     * tree, because clicking a row is what lists its folder. A25's slide-over broke that: **a board
     * card is not a tree row.** So opening a task card and having an agent rewrite that file
     * produced *nothing at all* — no update, no banner, no error, just the old bytes on screen for
     * as long as the panel stayed open. The same silent-staleness failure §15 exists to prevent,
     * sitting on the main way the operator opens a task file.
     *
     * The extra request is bounded and small: `openFileVerdict` above has already refused every
     * event that does not name the open file, so this is at most one listing per change to the one
     * file you are looking at, after the watcher's 250ms coalescing window.
     *
     * A listing that fails is still a silent return. The file on screen is unchanged and correct,
     * the store's own error channel is not involved in this request, and guessing at the file's fate
     * on top of a failed read would only add a second wrong answer.
     */
    const parent = target.segments.slice(0, -1)
    const rows = store.childrenOf(target.rootId, parent)
      ?? await listChildren(target.rootId, parent).catch(() => undefined)
    if (rows === undefined) return

    const wanted = rowKey(target.rootId, target.segments)
    const entry = rows.find(row => rowKey(row.rootId, row.segments) === wanted)
    if (entry === undefined) {
      // Moved, renamed, or archived out from under the pane. Named rather than silently left on
      // screen — a pane showing a file that is not there is the stale-screen failure in miniature.
      feedback.banner('warning', `${name} is no longer in that folder.`)
      return
    }

    /**
     * Still the same file, checked by REFERENCE.
     *
     * `openFile` is assigned a fresh object by every open, so this is asking "has the person
     * clicked something else while we were awaiting the listing?" — which they can easily have
     * done, since a refetch is a round trip. Comparing the paths instead would answer a different
     * and useless question: reopening the file they just navigated away from, because it happens
     * to have the same name.
     */
    if (openFile !== target) return
    /**
     * **Redrawn where it is, not where the Files pane would put it** (security review, C3). This call used to
     * pass no host, so the default applied and a file open in a slide-over was remounted into the
     * Files pane — which is hidden while a board tab is showing. The panel kept its old editor on
     * screen, attached to a session this reopen had just closed.
     */
    /**
     * **The reopen does not touch the highlight at all.** §15's silent re-read is the app catching
     * up with disk, not the person choosing a row — so an agent writing to the open document must
     * not yank the tree off whatever folder was jumped to.
     *
     * **The first fix for this saved and restored `selectedRow` around the call, and that was a race
     * I shipped.** One write produces more than one watcher event, so a second invocation could read
     * `chosen` while the first was still inside `opener.run` — with the selection momentarily on the
     * file — and then "restore" it to the file. It failed about one run in four, and the review that
     * first saw it could only call it a suspected flake.
     *
     * Telling the opener not to select is the fix: there is nothing to put back, so there is nothing
     * to race over.
     */
    await opener.run?.(entry, openFileHost ?? undefined, { select: false })
  }

  /**
   * Everything on screen, re-read from the server. Spec §15's refetch.
   *
   * Runs on **every** connection and on every resync — including the very first connect, which
   * duplicates the boot load below by one `folders.list` and one listing per root. That duplication
   * is deliberate and cheap: gating it on "is this the first connect" would mean the refetch path
   * runs only after a disconnection, and a path that runs only in the rare case is a path that is
   * broken for months before anyone finds out. This build has nine reasons to believe that.
   *
   * The folder list comes first because a folder registered from the **other** device is a root
   * this client has never heard of, and refreshing the listings of roots it already knows would
   * never reveal it.
   */
  async function refetchEverything(): Promise<void> {
    if (!await reloadFolders()) return
    // Templates too: one is a registry entry like a folder, and one added from the Mac has to
    // reach the phone. This is the only path that would ever tell it.
    await reloadTemplates()
    await refetchOpenFolders(store)
  }

  /**
   * §17's first-run card. *"The moment that decides whether the app feels finished or broken."*
   *
   * Nothing registered means nothing to restore and no reason to make somebody infer what this is
   * from an empty tree. One centred card in the app's own voice: what it is, that it reads and
   * writes real files in place, and — stated because it is the whole reason this rebuild exists —
   * **that it never deletes anything.** One button.
   */
  /**
   * What a damaged folder record says instead of the welcome.
   *
   * **It names the file and says the bytes are untouched**, because the one thing a person needs to
   * know here is that their list is not gone. It offers no "Choose a folder": that button leads to a
   * write the server is refusing, and a control that cannot work is worse than none.
   */
  function showRecordDamaged(): void {
    const pane = panes.get('files')
    if (pane === undefined) return
    const card = el('div', { className: 'first-run' })
    append(card, el('div', { className: 'first-run-title', text: 'Your folder list could not be read' }))
    append(card, el('p', {
      className: 'first-run-promise',
      text: 'Nothing has been lost. The app has not written over the file — it is on disk exactly '
        + 'as it was, in registry.json inside the app\'s own settings folder.',
    }))
    append(card, el('p', {
      className: 'first-run-body',
      text: 'Adding a folder is switched off until that file can be read, so nothing overwrites it '
        + 'by accident. The reason is in the app\'s local log.',
    }))
    pane.replaceChildren(card)
  }

  function showFirstRun(): void {
    const pane = panes.get('files')
    if (pane === undefined || firstRunTarget === null) return
    const target = firstRunTarget
    const card = el('div', { className: 'first-run' })
    append(card, el('div', { className: 'first-run-title', text: 'Soil Viewer' }))
    append(card, el('p', {
      className: 'first-run-body',
      text: 'This reads and writes the markdown files in your folders, in place. It is a window '
        + 'onto them, not a copy of them.',
    }))
    /**
     * Its own paragraph, and the strongest sentence on the screen. §17 asks for it by name, and it
     * is the promise the previous version of this app broke — 1,610 files of 1,611.
     */
    append(card, el('p', {
      className: 'first-run-promise',
      text: 'It never deletes anything. Things are moved or archived, never removed.',
    }))
    const choose = el('button', {
      className: 'first-run-choose', text: 'Choose a folder', attributes: { type: 'button' },
    })
    choose.addEventListener('click', () => { target.click() })
    append(card, choose)
    pane.replaceChildren(card)
  }

  void (async () => {
    const listed = await session.call('folders.list')
    if (!listed.ok) {
      feedback.banner('danger', 'Could not read the list of registered folders.')
      return
    }
    folders = listed.data as ReadonlyArray<FolderName & { displayPath: string }>
    // The boot read. The other of the two places; see `refreshWorkspaceCount`.
    refreshWorkspaceCount()
    const rootIds = folders.map(folder => folder.id)

    /**
     * The templates, at boot — **and deliberately NOT awaited.**
     *
     * Nothing on the critical path needs them: the tree does not draw templates, and a row's menu
     * is built by `actionsFor(entry, templates)` at the moment it is opened, so the list only has
     * to be there before someone right-clicks a folder.
     *
     * Awaiting it here was the first version and it was wrong twice over. It put a second round
     * trip in front of `setRoots`, so the tree could not paint until the template list came back —
     * and it pushed the first `tree.children` late enough to still be in flight when the page was
     * reloaded, which WebKit logs as a failed fetch. That surfaced as a console-error assertion in
     * an unrelated suite, which is a fair description of what a slower boot costs.
     *
     * Not fatal if it fails, either: a tree with no scaffold actions is a usable app.
     */
    void reloadTemplates()
    // Same reasoning: the picker is not on the critical path, and a board nobody has opened does
    // not need its project list before the tree paints.
    /**
     * **The remembered filter, restored after the project list it is keyed against.**
     *
     * Chained off the existing call rather than replacing it, so `reloadProjects` stays un-awaited
     * — the picker is not on the critical path and putting it there once cost the boot a round
     * trip. **And nothing here redraws the board:** `showTab('tasks')` already refreshes it, so a
     * refresh from the restore would be a second one racing the tree's own restore. A first attempt
     * did exactly that and cost thirteen browser tests.
     *
     * A stored project that no longer exists simply matches nothing — the filter narrows less,
     * never more, which is the safe direction for something the app remembered rather than the
     * person asked for.
     */
    void reloadProjects().then(async listed => {
      if (!listed) return
      const stored = await session.call('board.selection')
      if (!stored.ok) return
      const remembered = stored.data as Array<{ rootId: string; segments: string[] }>
      if (remembered.length === 0) return
      boardSelection = new Set(remembered.map(entry => selectionKey(entry.rootId, entry.segments)))
      drawProjectFilter()
    })

    /**
     * Read **before** the store is touched, and validated against the folder list that just
     * arrived — F9.2's "discard unknown folder ids" needs something to check against, and a
     * remembered file in a folder since deregistered must be dropped rather than requested.
     *
     * Before `setRoots` specifically, because that announces, and an announcement runs `remember`.
     * The flag above already prevents the overwrite; reading first means the code does not depend
     * on the flag being right.
     */
    const remembered = readViewState(storage, rootIds)

    store.setRoots(rootIds)
    // Only what this browser had open last time. Collapsed by default is the ruling; §15
    // makes it per-client, so their Mac and their phone remember separately.
    if (remembered.expanded.length > 0) await store.restoreExpanded(remembered.expanded)
    if (remembered.openFile !== null) {
      const { rootId, segments } = remembered.openFile
      // Auto-expand to it, per the PRD, which is also what makes the row visible to select.
      await store.revealPath(rootId, segments)
      const entry = store.childrenOf(rootId, segments.slice(0, -1))
        ?.find(candidate => candidate.segments.join('\u0000') === segments.join('\u0000'))
      // Absent means it was renamed, moved or deleted since. Nothing to restore, nothing to say —
      // the tree simply opens where it was and no file is selected.
      if (entry !== undefined) await opener.run?.(entry)
    }

    // From here on, what the person does is worth remembering.
    restored = true
    /**
     * **A33 — back to the tab you were on, or Files.**
     *
     * Files is still where the app opens for anyone who has never chosen otherwise, and the restore
     * still runs first so the pane a tab reveals is the restored one rather than an empty frame that
     * fills in a moment later.
     *
     * **Validated against the tabs that actually exist**, here rather than in `session-memory.ts`:
     * that module has no idea what a tab is, and a list of names inside it would be a second place
     * to update whenever the tabs change. A remembered id that is no longer a tab — after a rename,
     * or an edited storage blob — falls back to Files rather than leaving the app on nothing.
     *
     * **The phone is why this is worth anything.** On the Mac a reload is rare; an installed web app
     * on iOS is suspended and resumed constantly, and every resume used to land on Files however
     * long the person had been living on Tasks.
     */
    const wanted = remembered.activeTab
    const known = wanted !== null && TABS.some(tab => tab.id === wanted)
    showTab(known && wanted !== null ? wanted : 'files')

    /**
     * **After `showTab`, not before.** Drawn first, the tab switch redraws the pane over it — built,
     * attached, and replaced a moment later, silently. That is how the first attempt at this failed.
     */
    /**
     * **First run is "nothing registered" AND "the record is intact".** (security review, P11 C4.)
     *
     * A damaged `registry.json` also produces zero folders — the server refuses to overwrite it and
     * keeps the bytes, exactly as §13.8 requires, but reports an empty list. So the card as first
     * written greeted a returning user as a new one, over a failure, with one button that is then
     * refused `IO_FAILED`. `config-store.ts` wrote the rule this broke two phases ago: *"reading it
     * as 'no folders' is precisely the total loss §13.8 forbids."* Nothing is lost on disk; what was
     * lost is the user's ability to know that.
     *
     * The health check is asked for **only** when the list is empty, so an ordinary boot pays
     * nothing for it.
     */
    if (folders.length === 0) {
      const health = await session.call('config.health')
      const damaged = health.ok && (health.data as { registryDamaged: boolean }).registryDamaged
      if (damaged) showRecordDamaged()
      else showFirstRun()
    }
  })()

  stream.start()
}

mount()
