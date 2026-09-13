/**
 * The Projects board — the operator's Trello. Phase 9.
 *
 * **Nothing this file does touches the file tree.** Dragging a card writes a line of app config;
 * renaming a column writes a line of app config; adding a planned card writes a line of app config.
 * Their rule, and the only thing they were conclusive about when we settled the design: *"when I drag
 * stuff around that board nothing is supposed to happen on disk."*
 *
 * That makes it the mirror of `board-view.ts`, where a drag genuinely moves a file. Two boards, one
 * gesture, opposite consequences — which is a hazard worth naming rather than leaving for someone
 * to discover. The difference is visible on the card: a project card carries a folder path, a
 * planned card carries nothing, and they are drawn differently for exactly that reason.
 *
 * ## Two kinds of card
 *
 * A **project card** is a folder that exists. It appears by itself — the operator confirmed the PRD's
 * rule — and it can be opened in Files.
 *
 * A **planned card** is a thought. *"I know I'm gonna need to do this project… it doesn't mean I
 * wanna scaffold the folder just yet."* A name and a description and no folder anywhere. Marked
 * with a dashed edge and the word Planned rather than colour alone, because colour alone is the
 * cue that fails on a phone in sunlight — and a dashed edge already means "not a folder" on the
 * Tasks board's Uncategorized lane.
 */

import { append, clear, el, focusHasClass } from '../dom'
import { matchesFilter } from './filter'

export interface ProjectColumnView {
  readonly id: string
  readonly name: string
}

export interface ProjectCardView {
  readonly kind: 'project' | 'staged'
  readonly columnId: string
  /** What the card says. A folder's name, or the plan's name. */
  readonly title: string
  /** The breadcrumb for a project, read off its path. Empty for a plan, which has no path. */
  readonly where: string
  /** The description, for a plan. Empty for a project. */
  readonly body: string
  /** Identifies the card when something is done to it. A staged id, or a project location. */
  readonly ref: { readonly staged: string } | { readonly rootId: string; readonly segments: readonly string[] }
}

export interface ProjectsBoardView {
  readonly columns: readonly ProjectColumnView[]
  readonly cards: readonly ProjectCardView[]
}

export interface ProjectsBoardOptions {
  /** The current filter text, and what to do when it changes. PRD's shared filter bar. */
  readonly filter: string
  readonly onFilter: (query: string) => void
  readonly onPlace: (card: ProjectCardView, columnId: string) => void
  /** A project card was clicked — show it in Files. */
  readonly onOpen: (card: ProjectCardView) => void
  /** A planned card was clicked — edit its name and description. */
  readonly onEditPlan: (card: ProjectCardView) => void
  /** The plus at the bottom of a column. */
  readonly onAddPlan: (columnId: string) => void
  readonly onRenameColumn: (columnId: string) => void
  readonly onAddColumn: () => void
}

/** True when this card is a plan rather than a folder. */
export function isPlanned(card: ProjectCardView): boolean {
  return card.kind === 'staged'
}

/**
 * Cards in one column, in a stable order: **projects first, then plans, each alphabetical.**
 *
 * Neither kind carries a position — there is nothing on disk or in config that says "third" — so
 * the order has to be derived, and it has to be the same on every redraw or cards jump under the
 * cursor mid-drag. Projects first because they are the things that exist; plans read as the
 * queue below them.
 */
export function cardsInColumn(
  cards: readonly ProjectCardView[], columnId: string, query = '',
): readonly ProjectCardView[] {
  return cards
    .filter(card => card.columnId === columnId)
    /**
     * Filtered on the name, the breadcrumb **and the description**. A planned card's body is
     * usually where the searchable thought actually is — its name is four words and the reason it
     * exists is in the description.
     */
    .filter(card => matchesFilter([card.title, card.where, card.body], query))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'project' ? -1 : 1
      return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
    })
}

export function mountProjectsBoard(
  host: HTMLElement, data: ProjectsBoardView, options: ProjectsBoardOptions,
): void {
  /**
   * **Whether the caret was in the filter, read BEFORE the board is torn down.**
   *
   * Every keystroke repaints, and a repaint replaces the input element — so without this the field
   * loses focus after the first character and the rest of the query goes nowhere. The caret
   * position goes with it, which is worse: typing `cider` would leave `c` in the box and four
   * characters lost to the document.
   *
   * Checked here rather than after `clear`, because by then the element that had focus no longer
   * exists and `document.activeElement` has already fallen back to the body.
   */
  const wasFiltering = focusHasClass('board-filter-field')

  clear(host)
  // Held by reference rather than serialized into the drag payload — see `board-view.ts`, where
  // serializing a path met the separator-ambiguity trap. The drag never leaves this board.
  let dragging: ProjectCardView | null = null

  /**
   * **The filter, above the columns.** The board opens with every project unfiled — sixty-six of
   * them — and filing by dragging each one across that scroll is a chore nobody performs. Getting
   * from sixty-six to three in one line of typing is what makes the drag worth doing at all.
   */
  const bar = el('div', { className: 'board-filter' })
  const field = el('input', {
    className: 'board-filter-field',
    attributes: {
      type: 'text', value: options.filter,
      placeholder: 'Filter projects…', 'aria-label': 'Filter projects',
    },
  }) as HTMLInputElement
  field.addEventListener('input', () => { options.onFilter(field.value) })
  append(bar, field)
  append(host, bar)

  const columns = el('div', {
    className: 'board',
    attributes: { role: 'list', 'aria-label': 'Project columns' },
  })

  for (const column of data.columns) {
    const cards = cardsInColumn(data.cards, column.id, options.filter)
    const element = el('div', {
      className: 'board-lane',
      attributes: { role: 'listitem', 'aria-label': column.name, 'data-column': column.id },
    })

    const header = el('div', { className: 'board-lane-header' })
    const name = el('button', {
      className: 'board-lane-name is-editable',
      text: column.name,
      attributes: { type: 'button', 'aria-label': `Rename ${column.name}` },
    })
    name.addEventListener('click', () => { options.onRenameColumn(column.id) })
    append(header, name)
    const total = data.cards.filter(card => card.columnId === column.id).length
    append(header, el('span', {
      className: 'board-lane-count',
      // "3 of 66" rather than "3", because a filtered column that just says 3 reads as a column
      // that lost sixty-three cards.
      text: cards.length === total ? String(total) : `${cards.length} of ${total}`,
    }))
    append(element, header)

    const list = el('div', { className: 'board-cards' })
    for (const card of cards) {
      const planned = isPlanned(card)
      const item = el('div', {
        className: `board-card${planned ? ' is-planned' : ''}`,
        attributes: { draggable: 'true', tabindex: '0' },
      })

      append(item, el('div', { className: 'board-card-title', text: card.title }))
      if (planned) {
        /**
         * **The label says it in words.** A dashed edge is the glance-level cue; the word is what
         * makes it unambiguous, and it is what a screen reader gets. There is no colour-only state
         * on this card.
         */
        append(item, el('div', { className: 'board-card-tag', text: 'Planned — no folder yet' }))
        if (card.body.trim() !== '') {
          append(item, el('div', { className: 'board-card-body', text: card.body }))
        }
      } else if (card.where !== '') {
        // PRD: *"nesting shown as a breadcrumb tag read off the path"*. Display only — every route
        // takes `(rootId, segments)`, never this string.
        append(item, el('div', { className: 'board-card-where', text: card.where }))
      }

      item.addEventListener('click', () => {
        if (planned) options.onEditPlan(card)
        else options.onOpen(card)
      })
      item.addEventListener('dragstart', event => {
        dragging = card
        // WebKit refuses to begin a drag with no data attached; the drop reads `dragging`.
        ;(event as DragEvent).dataTransfer?.setData('text/plain', card.title)
        item.classList.add('is-dragging')
      })
      item.addEventListener('dragend', () => { item.classList.remove('is-dragging') })
      append(list, item)
    }
    append(element, list)

    const add = el('button', {
      className: 'board-add-card',
      text: '+ Plan',
      attributes: { type: 'button', 'aria-label': `Add a planned project to ${column.name}` },
    })
    add.addEventListener('click', () => { options.onAddPlan(column.id) })
    append(element, add)

    element.addEventListener('dragover', event => {
      event.preventDefault()
      element.classList.add('is-over')
    })
    element.addEventListener('dragleave', () => { element.classList.remove('is-over') })
    element.addEventListener('drop', event => {
      event.preventDefault()
      element.classList.remove('is-over')
      const moved = dragging
      dragging = null
      // Dropping a card into the column it is already in is not a change. Cheap to check and it
      // saves a write plus a redraw for a gesture that did nothing.
      if (moved === null || moved.columnId === column.id) return
      options.onPlace(moved, column.id)
    })

    append(columns, element)
  }

  const addColumn = el('button', {
    className: 'board-add-column',
    text: '+ Column',
    attributes: { type: 'button' },
  })
  addColumn.addEventListener('click', () => { options.onAddColumn() })
  append(columns, addColumn)

  append(host, columns)

  // Focus restored after the board is in the document — focusing a detached node does nothing,
  // silently. The caret goes to the end, which is where it was: this only runs while typing.
  if (wasFiltering) {
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }
}
