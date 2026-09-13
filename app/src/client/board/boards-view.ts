/**
 * **THE BOARDS TAB — the home list.** P14 B1.
 *
 * the operator: *"boards home lists every board, wherever each one lives."* One row per `board-*` folder
 * found anywhere in a registered folder.
 *
 * **B1 is read-only, and that is the phase boundary rather than an unfinished edge.** Creating,
 * arranging and moving are B2–B4. Three of the four phases cannot lose anything, so the one that
 * writes is built last, against a surface already proven to show the tree correctly.
 */

import { append, clear, el, setText } from '../dom'

export interface BoardRow {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly name: string
  readonly where: string
}

export interface BoardsOptions {
  readonly onOpen: (board: BoardRow) => void
  /** B4. Asks where, then what to call it — the operator's flow, in that order. */
  readonly onNewBoard: () => void
}

/**
 * §17's rule, applied here: *"a tab with nothing to show explains itself rather than rendering
 * blank."* Two different sentences, because a person with no boards and a person whose boards are
 * all archived are asking different questions — and a new tab that renders empty is the difference
 * between "I have not made one yet" and "this is broken".
 */
const EMPTY_TITLE = 'No boards yet'
const EMPTY_HINT = 'A board is a folder named board-something. Make one here, or name a folder that '
  + 'way anywhere in your files and it will appear.'

export function renderBoards(
  host: HTMLElement,
  boards: readonly BoardRow[],
  options: BoardsOptions,
): void {
  clear(host)

  /**
   * **Drawn before the empty check, so the way to make the first board is on the empty screen.**
   *
   * The obvious ordering puts the button after it and gives someone with no boards a screen that
   * explains what a board is and offers no way to make one. That is §17's first-run failure exactly:
   * a state that reads as broken rather than as new.
   */
  const bar = el('div', { className: 'board-screen-bar' })
  const create = el('button', {
    className: 'boards-new',
    text: '+ New board',
    attributes: { type: 'button' },
  })
  create.addEventListener('click', () => { options.onNewBoard() })
  append(bar, create)
  append(host, bar)

  if (boards.length === 0) {
    const empty = el('div', { className: 'boards-empty' })
    append(empty, el('div', { className: 'boards-empty-title', text: EMPTY_TITLE }))
    append(empty, el('div', { className: 'boards-empty-hint', text: EMPTY_HINT }))
    append(host, empty)
    return
  }

  /**
   * **No `list`/`listitem` roles here, and the first version had them.**
   *
   * A row is a `<button>`, and `role="listitem"` on a button **replaces** its implicit button role
   * rather than adding to it — so every row stopped being announced as something you can press, and
   * `getByRole('button')` could not find one either. That is not a test inconvenience: it is the
   * control being unreachable to anyone driving the app by keyboard or screen reader, which is the
   * same *"reachable by nothing"* defect in a different dimension.
   *
   * A container of buttons is what this is. Saying so needs no ARIA at all.
   */
  const list = el('div', { className: 'boards-list' })

  for (const board of boards) {
    const row = el('button', {
      className: 'boards-row',
      attributes: { type: 'button' },
    })

    append(row, el('div', { className: 'boards-row-name', text: board.name }))

    /**
     * **Where it lives, shown on every row that has one.** Two boards may share a name — they create
     * these by typing a subject, and `board-notes` under two projects is not far-fetched. A list of
     * rows that cannot be told apart is the Inbox complaint they raised on 2026-08-18 arriving
     * somewhere new, and this is the one line that prevents it.
     *
     * Omitted rather than drawn empty for a board at a registered folder's own root: an empty
     * second line is a gap that reads like a missing value.
     */
    if (board.where !== '') {
      append(row, el('div', { className: 'boards-row-where', text: board.where }))
    }

    row.addEventListener('click', () => { options.onOpen(board) })
    append(list, row)
  }

  append(host, list)
}

/** The count line above the list. Separate so a caller can place it without rebuilding the list. */
export function boardsCountLabel(count: number): string {
  return count === 1 ? '1 board' : `${count} boards`
}

export function setBoardsCount(element: HTMLElement, count: number): void {
  setText(element, boardsCountLabel(count))
}

// ---------------------------------------------------------------------------
// ONE BOARD — columns and cards. P14 B2.
// ---------------------------------------------------------------------------

export interface BoardCardView {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly name: string
  readonly title: string
}

export interface BoardColumnView {
  readonly id: string
  readonly name: string
  readonly segments: readonly string[] | null
  readonly cards: readonly BoardCardView[]
}

export interface OneBoardOptions {
  readonly onBack: () => void
  readonly onOpenCard: (card: BoardCardView) => void
  /** B4 — *"I can name and create these things on the fly."* */
  readonly onNewColumn: () => void
  readonly onNewCard: (column: BoardColumnView) => void
  /**
   * B-follow-up — nudge a column one place. Ruled 2026-08-21: *"just the ability to move around
   * the columns to different orders and have the app remember where I put them."*
   *
   * **An arrow, not a menu, and that is their correction to what shipped first:** *"clicking the dot
   * and then clicking move right — if I want to move something all the way over, it's messy."* The
   * menu cost two presses per place moved. This costs one, and `onArrangeColumns` covers distance.
   */
  readonly onNudgeColumn: (column: BoardColumnView, by: -1 | 1) => void
  /**
   * B-follow-up — the stack. *"Some kind of interface where I could click rearrange and then I can
   * see them all like in a stack and I can arrange the board top to bottom equals left to right."*
   */
  readonly onArrangeColumns: () => void
  /**
   * B4 — move a card to another column. **§18.5: no drag, an explicit choice instead.**
   *
   * The Tasks board already works this way and the operator ruled it there; boards is the same
   * interaction, not a new one. The picker is the caller's, so this hands over the card and lets it
   * ask — the view does not own a dialog.
   */
  /**
   * **B-follow-up — a card DRAGGED.** Ruled 2026-08-22: *"the difference between the tasks and
   * the boards is I'm not able to grab an item and move it… I want to be able to grab it and move an
   * item between, and then rearranging."*
   *
   * **§18.5 was misread when Boards was built, and this corrects it.** The rule is not "no drag" —
   * it is *"one mechanism, with drag demoted to an accelerator"*, and the Tasks board has both
   * halves. Boards shipped with only the explicit one, so a card could be moved on a phone and not
   * with a mouse.
   *
   * `before` is the position **as drawn** that the card was dropped in front of — `0` for the top,
   * `to.cards.length` for past the last one. Turning that into a final index is `droppedAt`'s job,
   * not the view's.
   */
  readonly onDropCard: (
    card: BoardCardView,
    from: BoardColumnView,
    to: BoardColumnView,
    before: number,
  ) => void
  readonly onMoveCard: (
    card: BoardCardView,
    from: BoardColumnView,
    /** The control that was pressed — the menu anchors to it. */
    trigger: HTMLElement,
  ) => void
}

/**
 * **TWO SCREENS, NEVER BOTH** — §18.4's rule for Files, and the same reasoning applies here.
 *
 * the operator settled it for the tree: *"you're either in one or the other. Trying to have both of them
 * on the screen is the only thing that I know for sure."* A board list beside an open board would be
 * two navigations competing for a 390px screen.
 *
 * The back control is drawn at both widths rather than only on the phone. On the desktop the Boards
 * tab still has only one pane, so without it there is no way back to the list except leaving the tab
 * and returning — which is the *"reachable by nothing"* shape by another route.
 */
export function renderOneBoard(
  host: HTMLElement,
  board: { readonly name: string; readonly where: string },
  columns: readonly BoardColumnView[],
  options: OneBoardOptions,
): void {
  clear(host)

  const bar = el('div', { className: 'board-screen-bar' })
  const back = el('button', {
    className: 'board-screen-back',
    text: '‹ Boards',
    attributes: { type: 'button', 'aria-label': 'Back to boards' },
  })
  back.addEventListener('click', () => { options.onBack() })
  append(bar, back)
  append(bar, el('div', { className: 'board-screen-title', text: board.name }))

  const addColumn = el('button', {
    className: 'boards-new',
    text: '+ Column',
    attributes: { type: 'button' },
  })
  addColumn.addEventListener('click', () => { options.onNewColumn() })
  append(bar, addColumn)

  /**
   * **The real columns, counted once and used three times below.**
   *
   * `Uncategorized` is not a folder and is pinned leftmost — it is where a loose file waits, not a
   * column they placed — so it is absent from every arrangement control. Computing the list here
   * rather than in each control is what stops the drawn index and the arranged index from drifting
   * apart, which is the bug the first column menu shipped with: it counted from the drawn list, so
   * the first real column was offered a "move left" that moved it nowhere.
   */
  const real = columns.filter(column => column.segments !== null)
  const arrangeable = real.length > 1

  /**
   * **Discreet, and beside `+ Column` rather than on every head.** The operator asked for *"an arrange
   * columns button discretely somewhere"* — the head had no room for a third control next to the
   * two arrows and the count, and one board-level button is the right altitude for a board-level
   * question anyway.
   *
   * Absent below two columns: a button that opens a panel saying there is nothing to do is the
   * *"control that cannot work"* shape this build keeps finding.
   */
  if (arrangeable) {
    const arrange = el('button', {
      className: 'board-arrange',
      text: 'Arrange',
      attributes: { type: 'button', 'aria-label': 'Arrange columns' },
    })
    arrange.addEventListener('click', event => {
      // Same reason the card's move button stops here: the panel's own dismiss listener reads the
      // opening click as a click outside and shuts it again on the way up.
      event.stopPropagation()
      options.onArrangeColumns()
    })
    append(bar, arrange)
  }

  append(host, bar)

  if (columns.length === 0) {
    const empty = el('div', { className: 'boards-empty' })
    append(empty, el('div', { className: 'boards-empty-title', text: 'Nothing in this board yet' }))
    append(empty, el('div', {
      className: 'boards-empty-hint',
      // Named as folders on purpose: the tree IS the board, and knowing that is what lets them work
      // in either place. B4 adds the buttons that do it from here.
      text: 'A column is a folder inside the board. A card is a markdown file inside a column.',
    }))
    append(host, empty)
    return
  }

  /**
   * **The dragged card is held by reference, never serialized into the drag payload.**
   *
   * `board-view.ts` records why, having done it the other way first: a filename may contain the
   * separator, so `a b.md` and `a`,`b.md` serialize identically. The drag begins and ends inside one
   * board, so the card the drop wants is the object this function already drew — and holding the
   * reference keeps the entity token that makes the move safe rather than rebuilding it from a
   * string that left the app's memory.
   */
  let dragging: BoardCardView | null = null
  let draggingFrom: BoardColumnView | null = null

  const lanes = el('div', { className: 'board-columns' })

  for (const column of columns) {
    /**
     * **`Uncategorized` is marked, not merely different.** The Tasks board dashes its synthetic lane
     * for the reason that applies here too: it is not a folder, so a solid container would say it is
     * one. Everything else about it already differs — no arrows, no `+ Card` — but those are
     * absences, and an absence is not a statement.
     */
    const lane = el('div', {
      className: column.segments === null ? 'board-column is-synthetic' : 'board-column',
    })

    const head = el('div', { className: 'board-column-head' })
    append(head, el('div', { className: 'board-column-name', text: column.name }))

    /**
     * **THE ARROWS, on a real column only. One press per place moved.**
     *
     * This replaced a `⋯` menu offering *Move left* and *Move right*, which the operator used and
     * rejected: *"clicking the dot and then clicking move right, if I want to move something all the
     * way over, it's messy."* The menu cost two presses per place, so a column six along cost
     * twelve. Its stated reasoning was that two buttons per head is clutter at 390px; that was true
     * about the clutter and wrong about the price, and the clutter is by far the cheaper of the two.
     *
     * `Uncategorized` gets none. It is not a folder and is pinned leftmost, so a control offering to
     * move it would be one that cannot work. Same reason it has no `+ Card`.
     *
     * **Both arrows vanish when there is only one real column**, rather than drawing a pair that can
     * never do anything. That is a different case from the disabled state below, which is about the
     * ends of a row that *can* move.
     */
    if (column.segments !== null && arrangeable) {
      const at = real.findIndex(other => other.id === column.id)
      const nudges = [
        { by: -1 as const, glyph: '\u2190', describe: 'left', enabled: at > 0 },
        { by: 1 as const, glyph: '\u2192', describe: 'right', enabled: at > -1 && at < real.length - 1 },
      ]
      for (const nudge of nudges) {
        const button = el('button', {
          className: 'board-column-move',
          text: nudge.glyph,
          attributes: { type: 'button', 'aria-label': `Move ${column.name} ${nudge.describe}` },
        })
        /**
         * **Disabled at the ends rather than omitted**, which reverses the rule the menu followed,
         * for the reason that rule gave. A missing menu entry is invisible and costs nothing; a
         * missing arrow leaves a hole that slides the other one under the thumb already travelling
         * towards it. The head keeps its shape as columns move past each other.
         */
        if (!nudge.enabled) button.setAttribute('disabled', 'true')
        else button.addEventListener('click', () => { options.onNudgeColumn(column, nudge.by) })
        append(head, button)
      }
    }
    /**
     * The count, because a column scrolls and the head does not. Without it a column of thirty cards
     * and a column of three look the same until you scroll each one.
     */
    append(head, el('div', {
      className: 'board-column-count',
      text: String(column.cards.length),
    }))
    append(lane, head)

    const stack = el('div', { className: 'board-column-cards' })
    column.cards.forEach((card, index) => {
      /**
       * **`boards-card` only — NOT `board-card`.**
       *
       * The first version carried both, to inherit the Tasks board's card styling. But
       * `.board-card` is what four existing suites locate the Tasks and Projects cards by, and a
       * fifth surface answering to the same class is the *"ambiguous locator mistake this build has
       * made three separate times"* that `app-rail.spec.ts` warns about — set up deliberately this
       * time. `.boards-card` carries its own styling instead.
       */
      const row = el('button', {
        className: 'boards-card',
        attributes: { type: 'button' },
      })
      // The title where the file has one, the filename where it does not — the same fallback the
      // quick-open rows use, so one document reads the same in both places.
      append(row, el('div', {
        className: 'boards-card-title',
        text: card.title.trim() === '' ? card.name : card.title,
      }))
      row.addEventListener('click', () => { options.onOpenCard(card) })

      /**
       * **The accelerator.** A touch device never fires these at all — iOS Safari does not start an
       * HTML5 drag — which is exactly §18.5's shape: the explicit controls stay the mechanism, and
       * this is the shortcut for a mouse.
       */
      row.setAttribute('draggable', 'true')
      const at = index
      row.addEventListener('dragstart', event => {
        dragging = card
        draggingFrom = column
        /**
         * Set although the drop ignores it: WebKit refuses to begin a drag whose event carries no
         * data. The title is what a drop into another application would sensibly paste.
         */
        ;(event as DragEvent).dataTransfer?.setData('text/plain', card.title || card.name)
        row.classList.add('is-dragging')
      })
      row.addEventListener('dragend', () => {
        row.classList.remove('is-dragging')
        // A drag abandoned over nothing must not leave a stale reference behind it.
        dragging = null
        draggingFrom = null
      })

      /**
       * **A card is its own drop target**, which is what makes a drop land in a *position* rather
       * than merely in a column. Above the midpoint means before it, below means after — the
       * convention every list with drag reordering uses, and the one a hand already expects.
       */
      row.addEventListener('dragover', event => {
        if (dragging === null || column.segments === null) return
        event.preventDefault()
        // Stopped, or the column below would also claim this and append to the end instead.
        event.stopPropagation()
        const box = row.getBoundingClientRect()
        const after = (event as DragEvent).clientY > box.top + box.height / 2
        row.classList.toggle('is-drop-after', after)
        row.classList.toggle('is-drop-before', !after)
      })
      row.addEventListener('dragleave', () => {
        row.classList.remove('is-drop-before', 'is-drop-after')
      })
      row.addEventListener('drop', event => {
        const moved = dragging
        const from = draggingFrom
        dragging = null
        draggingFrom = null
        row.classList.remove('is-drop-before', 'is-drop-after')
        if (moved === null || from === null || column.segments === null) return
        event.preventDefault()
        event.stopPropagation()
        const box = row.getBoundingClientRect()
        const after = (event as DragEvent).clientY > box.top + box.height / 2
        options.onDropCard(moved, from, column, after ? at + 1 : at)
      })

      append(stack, row)

      /**
       * **The move control is its own button beside the card, not a gesture on it.**
       *
       * §18.5 — *"no drag, an explicit status change instead"* — which the operator ruled for the Tasks
       * board and which this reuses rather than inventing a second interaction. A card that both
       * opened on tap and moved on drag would be two meanings for one touch on a phone, and the
       * wrong one fires when a thumb slides a few pixels while reading.
       */
      const move = el('button', {
        className: 'boards-card-move',
        text: '→',
        attributes: { type: 'button', 'aria-label': `Move ${card.title || card.name}` },
      })
      move.addEventListener('click', event => {
        // The card's own click would otherwise open the document underneath the picker.
        event.stopPropagation()
        options.onMoveCard(card, column, move)
      })
      append(row, move)
    })

    /**
     * **Adding a card is per column**, because a card has to land somewhere and a single board-level
     * button would have to ask which column first — one more question for the commonest action.
     *
     * Absent on `Uncategorized`: it is not a folder, so there is nowhere to create into. A button
     * there would be one that cannot work, which is the shape this build keeps finding.
     */
    if (column.segments !== null) {
      const addCard = el('button', {
        className: 'boards-add-card',
        text: '+ Card',
        attributes: { type: 'button', 'aria-label': `Add a card to ${column.name}` },
      })
      addCard.addEventListener('click', () => { options.onNewCard(column) })
      append(stack, addCard)
    }

    /**
     * **The column is a drop target too, and it is the case that matters.** The reason to drag a
     * card into a column is usually that the column is empty — a board with only per-card targets
     * would refuse exactly the drop someone most wants to make.
     *
     * **Enters and leaves are COUNTED**, which `board-view.ts` records learning the hard way:
     * `dragleave` fires every time the pointer crosses into one of the column's own children, and a
     * column is nothing but children. Toggling on that event makes the highlight strobe as you move
     * down, which reads as the target refusing you.
     *
     * `Uncategorized` takes no drops: it is not a folder, so there is nowhere for the file to go.
     * That matches the move menu, which has never offered it either.
     */
    if (column.segments !== null) {
      let inside = 0
      const leave = (): void => {
        inside = 0
        lane.classList.remove('is-over')
      }
      lane.addEventListener('dragenter', () => {
        if (dragging === null) return
        inside += 1
        lane.classList.add('is-over')
      })
      lane.addEventListener('dragleave', () => {
        inside -= 1
        if (inside <= 0) leave()
      })
      // `preventDefault` and nothing else — without it the browser refuses the drop outright.
      lane.addEventListener('dragover', event => {
        if (dragging !== null) event.preventDefault()
      })
      lane.addEventListener('drop', event => {
        const moved = dragging
        const from = draggingFrom
        dragging = null
        draggingFrom = null
        leave()
        if (moved === null || from === null) return
        event.preventDefault()
        // Past the last card: a drop on the column's own space is "put it at the end".
        options.onDropCard(moved, from, column, column.cards.length)
      })
    }

    append(lane, stack)
    append(lanes, lane)
  }

  append(host, lanes)
}
