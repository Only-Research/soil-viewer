/**
 * The Tasks board. PRD's Tasks tab, spec §3.
 *
 * **The columns are the folders that exist.** The rule, stated in the PRD as a rule rather
 * than a default: *"kanban whose columns are the **actual status folders that exist** inside the
 * chosen tasks folder — the app reads the folders and those are the columns, period."* Nothing here
 * knows the conventional lane names; it draws what the server enumerated. A project with a lane
 * called `05-blocked` gets a Blocked column without anybody adding it to a list.
 *
 * **A lane is an opaque id and never a path.** `board.ts` explains why at length: a digest over
 * `(rootId, project, lane)` matches iff the lane is enumerated *now*, so there is no id a client can
 * construct that resolves to a directory which is not currently a lane. This module therefore
 * cannot compose a destination even by accident — it has nothing to compose one from.
 *
 * **Drag moves the file.** §13.7's M2 is the reason the drop sends an id rather than a path: *"a
 * stale board plus a renamed lane materializes a ghost lane. Since folders are the database, that
 * is structural corruption."*
 *
 * **The card moves on the drop, and the board is then reconciled against disk unconditionally.**
 * PRD's board contract: *"lane moves render optimistically then reconcile against disk
 * unconditionally (failures visibly snap back)"*.
 *
 * This comment has now been wrong in both directions, which is worth recording once. It first
 * described an optimistic paint that **no line of this file performed** — the card sat in its old
 * lane for the whole round trip and a refusal snapped nothing back, because nothing had moved. The
 * P9 annex audit found the claim, the claim was corrected to match the code, and then the *code*
 * was corrected to match the PRD, which had been asking for the paint all along.
 *
 * The reconcile was always real: `onMove`'s caller redraws from the server whether the move
 * succeeded or not. What was missing was anything to reconcile *against*. Locally the gap is 25ms
 * and invisible; over the tailnet on a phone it is three round trips of a card not following your
 * finger.
 */

import { laneForCard } from '../../core/lane-match'
import type { Lane } from '../../core/board'
import { append, clear, el, focusedAttribute, setText } from '../dom'
import { menuButton } from '../files/row-menu'
import type { WireEntry } from '../../contract/wire'

export interface BoardLane {
  readonly id: string
  readonly name: string
  readonly synthetic: boolean
  /**
   * The real lanes behind this column. **Always present when the caller has them**, on a
   * single-project board as much as a gathered one.
   *
   * An earlier version attached these only when the board spanned projects, and it broke every
   * drag: with them absent the drop fell back to `lane.id`, which is the **column** key — a lane
   * name, not a lane digest — so `card.move` refused it and nothing moved. Addressing and display
   * are separate questions, and only the second one depends on whether the board is gathered.
   *
   * **A drop has to choose one of these**, and the choice is not free: `card.move` resolves against
   * the *card's own* project and refuses anything else. Sending the column's first member would be
   * refused for most cards and — if the refusal were ever relaxed — would relocate work between
   * projects. `laneForCard` is the rule, and it lives in core so the view is not the only thing that
   * knows it.
   */
  readonly members?: readonly Lane[]
}

export interface BoardData {
  readonly lanes: readonly BoardLane[]
  /**
   * True when this board spans more than one project. **Display only.**
   *
   * It decides two things and no others: whether a card names its project instead of its path, and
   * whether a lane offers a quick-add. Both are about what a merged column *means* rather than how
   * it is addressed, which is why this is on the board and not on the lane.
   */
  readonly gathered?: boolean
  /**
   * How many distinct projects this board is drawing. **Published to the DOM as `data-projects`.**
   *
   * Not for display — nothing renders it. It exists because **the board redraw is a round trip and
   * nothing on screen said when it had landed.** A caller that ticked one project in the filter and
   * then read a lane was reading whatever board was still painted: the filter summary updates
   * locally and immediately, the lanes arrive later, and "a `.board-lane` is visible" is satisfied
   * by the *previous* board.
   *
   * That produced two different reds on 2026-08-13 with one cause — a card count taken against a
   * stale board, and `laneNamed('Urgent')` resolving to two lanes belonging to two different
   * projects. Both looked like flakes and neither was: the board genuinely had not caught up.
   *
   * So the board states what it drew, and a caller can wait for the answer to be the one it asked
   * for. **A count rather than a boolean** — `gathered` cannot tell "one project" from "none".
   */
  readonly projectCount?: number
  /** Cards by lane id. A lane with no entry is an empty lane, not a missing one. */
  readonly cards: ReadonlyMap<string, readonly WireEntry[]>
}

export interface BoardOptions {
  /**
   * A card was dropped on a lane, and **the view has already moved it there.**
   *
   * So the caller owes a redraw from the server on every outcome, success or failure — that redraw
   * is both the reconcile and the snap-back. Returning without one leaves the board showing a move
   * that may not have happened, which is worse than the wait it saves.
   */
  readonly onMove: (card: WireEntry, laneId: string) => void
  /** A card was clicked. Opens it. */
  readonly onOpen: (card: WireEntry) => void
  /**
   * What is half-typed in each lane's quick-add, by lane id.
   *
   * Held by the caller rather than by the field, because **the board repaints underneath it.** A
   * watcher event while someone is naming a task would otherwise take the name away mid-word, and
   * that is not a rare case on this app — an agent writing into the project you are looking at is
   * the thing the live channel exists for.
   */
  readonly drafts: ReadonlyMap<string, string>
  readonly onDraft: (laneId: string, text: string) => void
  /** A task was named and submitted in a lane. The lane is an **id**; see `card.create`. */
  readonly onAdd: (laneId: string, name: string) => void
  /**
   * §18.5 — **Change status was asked for on a card.**
   *
   * The board resolves the offers because only it knows how a merged column maps to *this card's*
   * project; the caller owns the menu and the move. The move it performs is `onMove`'s, not a second
   * path — that is the whole point of §18.5: one mechanism, with drag demoted to an accelerator.
   *
   * `anchor` is in viewport coordinates for the desktop dropdown. Below 768 px §18.6 ignores it and
   * the menu comes up from the bottom edge, so it costs nothing to pass and nothing to honour.
   */
  readonly onChangeStatus: (
    card: WireEntry, choices: readonly StatusChoice[],
    anchor: { readonly x: number; readonly y: number },
    /** The card's element, so the menu can mark it `has-menu` while it is open. */
    node: HTMLElement,
  ) => void
}

/**
 * What a card says. PRD: *"title from the file's first heading (falling back to filename)"*.
 *
 * The fallback is already done — `title` on a wire row is the indexer's answer and it falls back to
 * the name — so this exists for the case the indexer could not read the file at all, where `title`
 * is empty and a blank card would be worse than a filename.
 */
/**
 * The lane id a card dropped on `lane` must be moved with.
 *
 * On a single-project board that is the lane itself. On a gathered one it is the member whose
 * project owns the card — and `null` when the column has nothing for that project, which is a drop
 * that must not be attempted rather than one that lands somewhere plausible.
 */
export function dropTargetFor(lane: BoardLane, card: WireEntry): string | null {
  if (lane.members === undefined) return lane.id
  return laneForCard({ lanes: lane.members }, card.segments)?.id ?? null
}

/** One offer in §18.5's Change status: the lane as the person sees it, and the id it moves with. */
export interface StatusChoice {
  /** The lane id **this card's project** must move with — `dropTargetFor`'s answer, never the column's. */
  readonly id: string
  /** The column's name, which is what the board already calls it. */
  readonly label: string
  /** True for the lane the card is in now. Shown, never hidden — see below. */
  readonly current: boolean
}

/**
 * The statuses a card can be given. Spec §18.5.
 *
 * **Every offer is resolved through `dropTargetFor`, which is the whole reason this is a function
 * and not a map over `lanes`.** On a gathered board a column is several projects' lanes merged, and
 * the id the *column* carries is not the id **this card's project** moves with. `dropTargetFor`
 * returns `null` when the column has nothing for that project — and those columns are dropped
 * rather than offered, because an offer that cannot be honoured is worse than an absence: it is a
 * move that must not be attempted, not one that lands somewhere plausible.
 *
 * **That is also what makes Change status work on a gathered board**, which matters more on the
 * phone than anywhere else — §18.5 removed the drag there, and the board starts at everything.
 *
 * **The current lane is included and marked, not omitted.** A picker that silently drops the
 * present status makes the list change shape depending on where the card already is, so the same
 * status sits under a different finger each time. Marked-and-inert costs one row and keeps the
 * list stable.
 *
 * **The synthetic Uncategorized lane is NOT skipped**, and the first draft of this function skipped
 * it. §18.5: *"The Uncategorized lane is one of the choices, so 'no status' is reachable by the same
 * action that set one."* It is synthetic because it is not a folder on disk — which is a fact about
 * where the file lands, not a reason it cannot be chosen, and the drag has always allowed it (§9:
 * *"drag in returns it to the tasks root"*). Filtering it would have made the one status you cannot
 * reach the one meaning *"I have not decided yet."*
 */
export function statusChoicesFor(
  lanes: readonly BoardLane[], card: WireEntry, currentLaneId: string,
): readonly StatusChoice[] {
  const offers: StatusChoice[] = []
  for (const lane of lanes) {
    const id = dropTargetFor(lane, card)
    if (id === null) continue
    offers.push({ id, label: lane.name, current: id === currentLaneId })
  }
  return offers
}

/**
 * What a card says underneath its title.
 *
 * **On a gathered board this is the project or op it belongs to**, which is the operator's ask —
 * *"it'd be nice if a card said, hey, this is part of this op"* — and it **replaces** the folder
 * path rather than joining it, because their condition was *"as long as it doesn't crowd it"*.
 *
 * On a single-project board every card would say the same word, so the path stays: a line that is
 * identical on every card is noise wherever it appears.
 */
/**
 * The card's second line — **and it is empty on a single-project board, deliberately.**
 *
 * It used to be the folder path on every card, which is what the operator hit on their phone: *"it names
 * the whole file path… that becomes like four lines, five lines in mobile view."* Ten lines, on a
 * task card.
 *
 * **The packet removed it rather than shortening it, and the reason is not width.** Every card in a
 * lane sits in the same folder, so the line was identical the whole way down the column — it carried
 * no information at the point it was read. A shorter identical line is still an identical line.
 *
 * So: **a second line only when it differs between cards.** On a gathered board that is the project
 * name, which is the one thing that actually varies. On a single-project board there is nothing to
 * say, and the card says nothing. The full path is still one tap away in Copy path, and the document
 * header still carries it.
 */
export function cardWhere(lane: BoardLane, card: WireEntry, gathered: boolean): string {
  if (!gathered || lane.members === undefined) return ''
  return laneForCard({ lanes: lane.members }, card.segments)?.origin.name
    // A card whose project is not among the members: show where it is rather than nothing, so an
    // impossible state is legible instead of blank.
    ?? card.segments.slice(0, -1).join('/')
}

/**
 * Which of the packet's three lane colours a lane takes, or none.
 *
 * **A lookup on the name, not a hash and not a position.** The three conventional lanes are the ones
 * with an agreed meaning; everything else is a folder somebody made, and the honest answer for it is
 * the dim dot. Position would be worse than either — the same colour would mean "urgent" on one
 * board and "done" on another.
 *
 * Matched on the name the server enumerated, lowercased, with the numeric prefix the soil's grammar
 * puts on status folders removed — `01-urgent` and `Urgent` are the same lane wearing two spellings.
 */
export function laneKind(name: string): 'urgent' | 'next' | 'done' | 'other' {
  const stem = name.trim().toLowerCase().replace(/^[0-9]+[-_\s]*/, '')
  if (stem === 'urgent') return 'urgent'
  if (stem === 'next') return 'next'
  if (stem === 'done' || stem === 'complete' || stem === 'completed') return 'done'
  return 'other'
}

/**
 * A folder name as a person would say it — for the phone's back control.
 *
 * `01-urgent` becomes `Urgent`, `tasks` becomes `Tasks`. The soil's grammar puts a numeric prefix on
 * status folders to fix their order on disk; that prefix is filing, not a name, and reading it back
 * to someone is showing them the plumbing.
 *
 * **Display only, and it must stay that way** — nothing addresses a folder by this string. §5's rule
 * is that a lane is an opaque id, and a prettified name is exactly the sort of thing that gets
 * quietly reused as one.
 */
export function originLabel(folder: string): string {
  const stem = folder.replace(/^[0-9]+[-_\s]*/, '').replace(/[-_]+/g, ' ').trim()
  if (stem === '') return folder
  return stem.charAt(0).toUpperCase() + stem.slice(1)
}

export function cardTitle(card: WireEntry): string {
  const title = card.title.trim()
  return title === '' ? card.name : title
}

/**
 * Renders the board into `host`, replacing whatever was there.
 *
 * Returns nothing: the board is redrawn from data rather than mutated in place, because the data is
 * the folder tree and the folder tree is the truth. A view that patched itself would be a second
 * copy of the state, which is the thing this whole app is built to avoid.
 */
export function mountBoard(host: HTMLElement, data: BoardData, options: BoardOptions): void {
  /**
   * **Which lane's quick-add had the caret, read BEFORE the board is torn down.**
   *
   * `projects-view.ts` records why this has to happen first: after `clear` the element that had
   * focus no longer exists and `document.activeElement` has already fallen back to the body. The
   * lane id is what is read rather than just "a quick-add had focus", because there is one field
   * per lane and putting the caret back in the wrong one is its own bug.
   */
  const focusedLane = focusedAttribute('board-lane-add-field', 'data-lane')
  /** The field to put the caret back into, once the board is actually in the document. */
  let restoreFocusTo: HTMLInputElement | null = null
  clear(host)
  /**
   * **The card being dragged is held as a reference, not serialized into the drag payload.**
   *
   * The first version put `segments.join(' ')` in `dataTransfer` and parsed it back on drop, which
   * is the separator-ambiguity trap this build has now met three times: a filename may contain a
   * space, so `a b.md` and `a`,`b.md` serialize identically. `rowKey` uses NUL precisely because it
   * is the one byte a filename cannot hold.
   *
   * None of that is needed. The drag begins and ends inside one board, so the card the drop wants
   * is the object the board already drew — and holding the reference means the entity token that
   * makes the move safe is *remembered* rather than reconstructed from a string that left the
   * app's memory.
   */
  let dragging: WireEntry | null = null
  /**
   * The dragged card's element, held beside the row it stands for. The optimistic paint moves a
   * node into another column, and a `WireEntry` cannot say which node that is — the board may hold
   * two cards with the same name in different lanes, so it cannot be looked up by title either.
   */
  let draggingNode: HTMLElement | null = null

  const columns = el('div', {
    className: 'board',
    attributes: {
      role: 'list',
      'aria-label': 'Task lanes',
      // What this board actually drew. See BoardData.projectCount for why it is here.
      'data-projects': String(data.projectCount ?? (data.gathered === true ? 2 : 1)),
    },
  })

  /**
   * Re-derives every lane's count from the cards actually in it.
   *
   * Needed by the optimistic paint: a card moving out of one column and into another changes two
   * counts, and the drop handler is only in scope for one of them. Counting what is on screen is
   * also the honest answer — the header claims to be a count of the column, and after an optimistic
   * move that is a different number from the one the server last sent.
   */
  const recount = (): void => {
    for (const column of [...columns.children]) {
      const label = column.querySelector('.board-lane-count')
      if (label !== null) setText(label, String(column.querySelectorAll('.board-card').length))
    }
  }

  for (const lane of data.lanes) {
    const cards = data.cards.get(lane.id) ?? []
    const column = el('div', {
      className: `board-lane${lane.synthetic ? ' is-synthetic' : ''}`,
      attributes: { role: 'listitem', 'aria-label': lane.name, 'data-lane': lane.id },
    })

    const header = el('div', { className: 'board-lane-header' })
    /**
     * **A23's status dot, held since the annex audit and unblocked by the design pass.**
     *
     * It was deferred on purpose: a coloured dot needs a colour *language* before it needs a colour,
     * and inventing one per-lane would have been a decision nobody made. The packet supplies it —
     * three mapped hues plus a dim default.
     *
     * **An unknown lane takes the dim dot rather than a guess.** The board draws whatever folders
     * exist, so `05-blocked` is a lane the moment somebody makes one; picking a colour for it by
     * position or by hashing its name would assert a meaning the folder does not carry.
     */
    append(header, el('span', {
      className: 'board-lane-dot',
      attributes: { 'data-lane-kind': laneKind(lane.name), 'aria-hidden': 'true' },
    }))
    append(header, el('span', { className: 'board-lane-name', text: lane.name }))
    // The count is on the header rather than implied by the column's height, because an empty lane
    // and a lane whose cards are scrolled out of view look identical otherwise.
    append(header, el('span', { className: 'board-lane-count', text: String(cards.length) }))
    append(column, header)

    const list = el('div', { className: 'board-cards' })
    for (const card of cards) {
      const item = el('div', {
        className: 'board-card',
        attributes: { draggable: 'true', tabindex: '0', 'data-card': card.segments.join('/') },
      })
      append(item, el('div', { className: 'board-card-title', text: cardTitle(card) }))
      /**
       * The location footer, PRD's third line on a card. Folder-relative and for display only —
       * §6 keeps absolute paths off the wire and this never becomes one.
       */
      /**
       * Rendered only when it has something to say. An empty `div` still carries its `margin-top`,
       * so a blank second line is a blank second line — the space would survive the text.
       */
      const where = cardWhere(lane, card, data.gathered === true)
      if (where !== '') {
        append(item, el('div', { className: 'board-card-where', text: where }))
      }

      /**
       * §18.5/§18.6 — **the card's own `⋯`, and until now a card had none.**
       *
       * On the phone this is the *only* way to move a card, because §18.5 removed the drag there.
       * On the desktop it sits beside the drag rather than replacing it.
       *
       * **`stopPropagation`, or the card opens underneath the menu.** The card's own click handler
       * is on the element this button lives inside, so without it every Change status would also
       * open the task in the panel behind the sheet.
       */
      const menu = menuButton(cardTitle(card))
      menu.classList.add('board-card-menu')
      menu.addEventListener('click', event => {
        event.stopPropagation()
        const box = menu.getBoundingClientRect()
        /**
         * **The current lane is `dropTargetFor`'s answer, not `lane.id`.**
         *
         * A column's own id is its *key*, and on every board — gathered or not — `laneList` gives
         * each column its members, so the id a card actually moves with is the member's. Comparing
         * the key against a resolved id meant **nothing was ever marked as current**, which the e2e
         * case caught: the card is in this lane, so `dropTargetFor` on this lane IS its status.
         */
        options.onChangeStatus(
          card,
          statusChoicesFor(data.lanes, card, dropTargetFor(lane, card) ?? lane.id),
          { x: box.left, y: box.bottom },
          // The card, so the menu can mark it while it is open — §4.6's *acted on* state. The
          // `.board-card.has-menu` rule has existed since the card work and nothing set it.
          item,
        )
      })
      append(item, menu)

      item.addEventListener('click', () => { options.onOpen(card) })
      item.addEventListener('dragstart', event => {
        dragging = card
        draggingNode = item
        /**
         * Set anyway, and ignored on the way back. WebKit will not start a drag unless the event
         * carries some data, so this is a browser requirement rather than the payload -- the drop
         * reads `dragging`. The value is the card's title, which is what a drop onto another
         * application would sensibly paste.
         */
        ;(event as DragEvent).dataTransfer?.setData('text/plain', cardTitle(card))
        item.classList.add('is-dragging')
      })
      item.addEventListener('dragend', () => {
        item.classList.remove('is-dragging')
        // A drag abandoned outside any lane leaves nothing holding a stale node.
        draggingNode = null
        dragging = null
      })
      append(list, item)
    }

    /**
     * **An empty lane is a drop target too.** PRD's board contract says so in as many words —
     * *"empty lanes render with drop targets"* — and it is the case that matters: the reason to
     * drag a card into Done is usually that Done is empty. Annex A21 gives it its appearance: a
     * dashed teal target that appears while a card is over the lane, so an empty column is
     * visibly a place a card can go rather than a place nothing is.
     */
    append(list, el('div', { className: 'board-lane-drop', text: 'Drop here' }))

    /**
     * **Enter and leave are COUNTED** — annex A22, and it is not a nicety.
     *
     * `dragleave` fires on the column every time the pointer crosses into one of its own children,
     * and a lane full of cards is nothing but children. Toggling the highlight on that event makes
     * it strobe as you move down the column, which reads as the drop target refusing you. Counting
     * enters against leaves means the highlight goes out when the pointer leaves the *lane*, which
     * is the thing the person is aiming at.
     *
     * `dragover` still calls `preventDefault` and nothing else: without it the browser refuses the
     * drop entirely, and with the class toggle in it the counter would be redundant.
     */
    let inside = 0
    const leave = (): void => {
      inside = 0
      column.classList.remove('is-over')
    }
    column.addEventListener('dragenter', () => {
      inside += 1
      column.classList.add('is-over')
    })
    column.addEventListener('dragleave', () => {
      inside -= 1
      if (inside <= 0) leave()
    })
    column.addEventListener('dragover', event => { event.preventDefault() })
    column.addEventListener('drop', event => {
      event.preventDefault()
      leave()
      const moved = dragging
      const movedNode = draggingNode
      dragging = null
      draggingNode = null
      if (moved === null) return
      /**
       * Dropping a card back into the lane it is already in is not a move. The server treats it as
       * a case-only rename — `(dev, ino)` match, so it succeeds as a no-op — which means nothing on
       * screen would say the gesture did nothing, and a `rename` syscall would run on the file for
       * a drag that went nowhere.
       *
       * **P9F-7 — "already in" reads the PAINTED position, not the last server answer.**
       *
       * security review, P9 fresh-eyes: *"the optimistic paint and the same-lane guard disagree about where a
       * card is inside the round-trip window."* This line used to ask `data`, which is the board as
       * the server last described it, while the paint below moves the node and leaves `data`
       * untouched. **Two sources of truth for one question**, differing for exactly as long as a
       * round trip.
       *
       * What that cost, in the window: dragging a card A→B and then back to A was **swallowed** —
       * `data` still said A, so the guard called it a no-op — and the card stayed sitting in B until
       * the reconcile pulled it back to A. The person's last gesture was the one that did nothing.
       * The mirror case fires a request and a `rename` for a drag that visibly went nowhere.
       *
       * The DOM is the painted position, so asking it is asking the one thing that is true now.
       * `data` is used only when there is no node to ask — and in that case nothing was painted
       * either, so there is no second source to disagree with.
       */
      const alreadyHere = movedNode !== null
        ? movedNode.parentElement === list
        : data.cards.get(lane.id)?.includes(moved) === true
      if (alreadyHere) return

      /**
       * **The card moves NOW.** PRD's board contract: *"lane moves render optimistically then
       * reconcile against disk unconditionally (failures visibly snap back)"*.
       *
       * This was missing, and two comments in this file claimed it was here. The reconcile has
       * always been real — `onMove`'s caller redraws from the server whether the move succeeded or
       * not — but with nothing painted first there was nothing to reconcile *against*: the card sat
       * in its old lane until the round trip finished, and a refusal snapped nothing back because
       * nothing had moved.
       *
       * Locally that gap is 25ms and invisible. Over the tailnet on a phone it is three round trips
       * of a card not following your finger, which is the difference between a board that feels
       * direct and one that feels broken.
       */
      /**
       * **Resolved before anything is painted.** On a gathered board a column holds several real
       * lanes and only the card's own project's lane may receive it; a card with none is a drop
       * that cannot happen. Painting first and discovering that afterwards would show a move that
       * was never attempted and then snap it back for no visible reason.
       */
      const target = dropTargetFor(lane, moved)
      if (target === null) return

      if (movedNode !== null) {
        list.insertBefore(movedNode, list.lastElementChild)
        recount()
      }
      options.onMove(moved, target)
    })

    append(column, list)

    /**
     * **The quick-add, at the bottom of the lane.** PRD's Tasks tab:
     *
     * > *"every lane carries a quick-add at its bottom. Creation-is-placement embodied: standing in
     * > a project's tasks on the board, a task added at the bottom of a lane is born in that lane's
     * > actual folder — project and status already known from where you're standing, nothing to
     * > choose but the name."*
     *
     * So there is a name field and nothing else. No folder picker, no template, no status — all
     * three are already answered by which lane you are standing in, and asking again would turn the
     * one gesture the PRD describes back into the dialog it is meant to replace.
     *
     * **Enter submits, and there is a button as well.** Enter is the quick part; the button is the
     * discoverable part, and on a phone it is the only part.
     */
    /**
     * **A merged column carries no quick-add, and that is the same rule as the drop.**
     *
     * Creation-is-placement: a task typed into a lane is born in *that lane's folder*. A column
     * gathered from six projects is not a folder, so there is no answer to "which one" that is not
     * a guess about what the person meant — and guessing would put real files in real places nobody
     * pointed at. Standing in one project is how you add to it, which is exactly the working pattern
     * the operator described in the first place.
     *
     * Returning before the row is built rather than hiding it afterwards: a disabled field that
     * looks like it should work is worse than no field.
     */
    if (data.gathered === true) {
      // The list is already attached above; the column still has to reach the board, so this
      // continues the loop rather than returning out of the function.
      append(columns, column)
      continue
    }

    const add = el('div', { className: 'board-lane-add' })
    const field = el('input', {
      className: 'board-lane-add-field',
      attributes: {
        type: 'text',
        value: options.drafts.get(lane.id) ?? '',
        placeholder: 'Add a task',
        // Named with the lane, because a screen reader reading four identical "Add a task" fields
        // down a board has told you nothing about where the task would go.
        'aria-label': `Add a task to ${lane.name}`,
        'data-lane': lane.id,
      },
    }) as HTMLInputElement
    const submitButton = el('button', {
      className: 'board-lane-add-button',
      text: 'Add',
      attributes: { type: 'button', 'aria-label': `Add a task to ${lane.name}` },
    })

    const submit = (): void => {
      const typed = field.value.trim()
      // A name is the one thing this cannot supply for you. Silent rather than an error: an empty
      // Enter in a text field is a slip, not a request.
      if (typed === '') return
      /**
       * Cleared here rather than when the server answers. The create is a round trip and the next
       * thing a person does is type the next task; leaving their last one in the box means the
       * second task is named `buy milkcall the vet`.
       */
      field.value = ''
      options.onDraft(lane.id, '')
      /**
       * **A real lane id, not the column's key.** `lane.id` identifies a *column* — a display
       * grouping — and `card.create` needs the folder a file is born in. On the boards that carry a
       * quick-add the column has this project's lanes and nothing else, so the first member is that
       * folder; `tasksDirsUnder` sorts, so "first" is deterministic rather than incidental.
       *
       * The fallback keeps every P9 caller working: a board built without members passes its own id,
       * which is what those boards' ids already are.
       */
      options.onAdd(lane.members?.[0]?.id ?? lane.id, typed)
    }

    field.addEventListener('input', () => { options.onDraft(lane.id, field.value) })
    field.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key !== 'Enter') return
      // Stopped here so the board's own key handling — and anything listening above it — does not
      // also act on a press that was aimed at this field.
      event.preventDefault()
      event.stopPropagation()
      submit()
    })
    submitButton.addEventListener('click', submit)

    append(add, field, submitButton)
    append(column, add)
    append(columns, column)

    if (focusedLane === lane.id) restoreFocusTo = field
  }

  append(host, columns)

  /**
   * **After the board is in the document, not before.** `focus()` on a detached element does
   * nothing at all — it would fail silently and the caret would stay wherever the teardown left it,
   * which is the same symptom as not having written this at all.
   */
  if (restoreFocusTo !== null) {
    restoreFocusTo.focus()
    restoreFocusTo.setSelectionRange(restoreFocusTo.value.length, restoreFocusTo.value.length)
  }
}
