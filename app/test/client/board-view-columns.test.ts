import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cardWhere, dropTargetFor, mountBoard, type BoardLane } from '../../src/client/board/board-view'
import { el } from '../../src/client/dom'
import { FakeElement, installFakeDocument, removeFakeDocument } from '../support/fake-dom'
import type { Lane } from '../../src/core/board'
import type { WireEntry } from '../../src/contract/wire'

/**
 * **THE TWO RULES A GATHERED COLUMN ADDS TO THE BOARD VIEW.**
 *
 * Both are pure and both are exported for that reason. The alternative — a `find` inside the drop
 * handler and a ternary inside the render loop — is the shape this build has repeatedly found
 * unobservable, and neither failure looks like a bug: a wrong drop target is a drag that silently
 * does nothing, and a wrong tag is a card confidently naming the wrong project.
 *
 * The lanes are built here in a **deliberately adverse order**, outermost first, because that is
 * what a first-match rule survives. `test/core/board-columns.test.ts` records the sweep that made
 * that necessary.
 */

beforeEach(installFakeDocument)
afterEach(removeFakeDocument)

const lane = (project: string[], id: string): Lane => ({
  id, name: 'Urgent', synthetic: false,
  origin: { project, name: project[project.length - 1] ?? '' },
})

const OUTER = ['02-projects', 'alpha']
const NESTED = ['02-projects', 'alpha', '02-work', 'projects', 'op-one']

const gathered: BoardLane = {
  id: 'column-urgent', name: 'Urgent', synthetic: false,
  members: [lane(OUTER, 'alpha-urgent'), lane(NESTED, 'op-urgent')],
}

const single: BoardLane = { id: 'plain-urgent', name: 'Urgent', synthetic: false }

const card = (segments: string[]): WireEntry => ({
  rootId: 'soil', segments, name: segments[segments.length - 1] ?? '', kind: 'file',
  title: 'A task', size: 1, isMarkdown: true, contentUnavailable: false,
} as unknown as WireEntry)

describe('dropTargetFor — which lane a drop actually names', () => {
  it('sends the column itself on a single-project board', () => {
    // P9's boards pass no members and must be untouched by any of this.
    expect(dropTargetFor(single, card([...OUTER, '02-work', 'tasks', '02-next', 'a.md'])))
      .toBe('plain-urgent')
  })

  it('sends the lane belonging to the card\'s own project', () => {
    expect(dropTargetFor(gathered, card([...OUTER, '02-work', 'tasks', '02-next', 'a.md'])))
      .toBe('alpha-urgent')
  })

  it('prefers the innermost project when an op is nested in one', () => {
    expect(dropTargetFor(gathered, card([...NESTED, '02-work', 'tasks', '02-next', 'o.md'])))
      .toBe('op-urgent')
  })

  /**
   * **Null, not a guess.** A card whose project owns no lane in this column has nowhere to land.
   * The server would refuse it — `STALE_TARGET`, proven in `test/server/board-columns.test.ts` — so
   * the cost of guessing is a card that visibly jumps and then snaps back for no stated reason.
   */
  it('refuses rather than guessing when the column has nothing for that project', () => {
    expect(dropTargetFor(gathered, card(['02-projects', 'beta', '02-work', 'tasks', 'b.md'])))
      .toBeNull()
  })
})

describe('cardWhere — what a card says underneath its title', () => {
  it('names the project on a gathered board', () => {
    expect(cardWhere(gathered, card([...OUTER, '02-work', 'tasks', '01-urgent', 'a.md']), true))
      .toBe('alpha')
  })

  it('names the op, not its parent project, for a nested card', () => {
    expect(cardWhere(gathered, card([...NESTED, '02-work', 'tasks', '01-urgent', 'o.md']), true))
      .toBe('op-one')
  })

  /**
   * **NOTHING on a single-project board — changed 2026-08-15 with the design pass.**
   *
   * *This test previously asserted the opposite: that the folder path stays. Its own comment argued
   * against itself — "a line identical on every card is noise wherever it is put" — and then kept
   * the line anyway. The packet finished the thought.*
   *
   * the operator hit the consequence on their phone before anyone acted on it: *"it names the whole file
   * path… that becomes like four lines, five lines in mobile view."* Ten lines on a task card.
   *
   * **Removed rather than shortened, and the reason is not width.** Every card in a lane sits in the
   * same folder, so the line was identical the whole way down the column. A shorter identical line
   * is still an identical line. The rule is now: a second line only when it *differs* between cards.
   */
  it('says nothing when the board is one project — the line was identical down the column', () => {
    expect(cardWhere(single, card([...OUTER, '02-work', 'tasks', '01-urgent', 'a.md']), false))
      .toBe('')
  })

  it('falls back to the path rather than going blank for a card it cannot place', () => {
    expect(cardWhere(gathered, card(['02-projects', 'beta', '02-work', 'tasks', 'b.md']), true))
      .toBe('02-projects/beta/02-work/tasks')
  })
})

/**
 * **THE DROP HANDLER ITSELF, DRIVEN.**
 *
 * `dropTargetFor` above is proven in isolation, and a sweep showed that was not enough: replacing
 * the handler's `if (target === null) return` with a fallback to the column id left every case above
 * green. The guard is what stops an impossible drop being *painted* — the card would jump to a lane
 * the server is about to refuse, then snap back with nothing said. A control no test could see, in a
 * handler, which is where this build keeps finding them.
 *
 * So the board is mounted against the shared fake DOM and the gesture is actually performed.
 */
describe('a merged column offers no quick-add', () => {
  /**
   * **Creation-is-placement, and a merged column is not a place.** A task typed into a lane is born
   * in that lane's folder; a column gathered from several projects has no single folder, so any
   * answer to "which one" is a guess that puts a real file somewhere nobody pointed at.
   *
   * Asserted at the surface rather than trusted to the comment, because the failure is silent in
   * both directions: a field that should not be there looks perfectly normal, and a column that
   * lost its field for the wrong reason looks like a missing feature.
   */
  const gatheredOnly = [gathered]

  const mount = (lanes: BoardLane[]): FakeElement => {
    const host = el('div') as unknown as FakeElement
    mountBoard(host as unknown as HTMLElement, { lanes, cards: new Map(), gathered: lanes === gatheredOnly }, {
      onMove: () => { /* not this test */ },
      onOpen: () => { /* not this test */ },
      drafts: new Map(),
      onDraft: () => { /* not this test */ },
      onAdd: () => { /* not this test */ }, onChangeStatus: () => { /* not this test */ },
    })
    return host
  }

  it('draws a quick-add on a single-project board', () => {
    expect(mount([single]).byClass('board-lane-add-field')).toHaveLength(1)
  })

  it('draws none on a gathered board', () => {
    expect(mount(gatheredOnly).byClass('board-lane-add-field')).toHaveLength(0)
  })

  it('still draws the column itself, and its cards', () => {
    // The early exit skips the add row and nothing else. A column that vanished with its quick-add
    // would be a board missing a whole lane, which is a far louder bug than the one being fixed.
    const host = el('div') as unknown as FakeElement
    mountBoard(host as unknown as HTMLElement, {
      lanes: [gathered], gathered: true,
      cards: new Map([['column-urgent', [card([...OUTER, '02-work', 'tasks', '01-urgent', 'a.md'])]]]),
    }, {
      onMove: () => { /* not this test */ }, onOpen: () => { /* not this test */ },
      drafts: new Map(), onDraft: () => { /* not this test */ }, onAdd: () => { /* not this test */ }, onChangeStatus: () => { /* not this test */ },
    })
    expect(host.byClass('board-lane')).toHaveLength(1)
    expect(host.byClass('board-card')).toHaveLength(1)
  })
})

describe('the drop handler, driven through a mounted board', () => {
  const dragEvent = () => ({ preventDefault: () => { /* the handler calls it */ } })

  interface Attempt {
    readonly moves: Array<{ card: string; laneId: string }>
    readonly host: FakeElement
  }

  /** Mounts a two-column gathered board and drags `card` onto the Urgent column. */
  const dragOntoUrgent = (card: WireEntry): Attempt => {
    const moves: Array<{ card: string; laneId: string }> = []
    const host = el('div') as unknown as FakeElement

    const next: BoardLane = {
      id: 'column-next', name: 'Next', synthetic: false,
      members: [lane(OUTER, 'alpha-next')],
    }
    mountBoard(host as unknown as HTMLElement, {
      lanes: [next, gathered],
      cards: new Map([['column-next', [card]]]),
    }, {
      onMove: (moved, laneId) => moves.push({ card: moved.name, laneId }),
      onOpen: () => { /* not this test */ },
      drafts: new Map(),
      onDraft: () => { /* not this test */ },
      onAdd: () => { /* not this test */ }, onChangeStatus: () => { /* not this test */ },
    })

    const cardNode = host.byClass('board-card')[0]
    expect(cardNode, 'the board drew no card').toBeDefined()
    cardNode?.fire('dragstart', dragEvent() as unknown as Event)

    // The Urgent column is the second lane drawn.
    const urgentColumn = host.byClass('board-lane')[1]
    expect(urgentColumn, 'the board drew no second column').toBeDefined()
    urgentColumn?.fire('drop', dragEvent() as unknown as Event)
    return { moves, host }
  }

  it('moves the card with its own project\'s lane id', () => {
    const { moves } = dragOntoUrgent(card([...OUTER, '02-work', 'tasks', '02-next', 'a.md']))
    expect(moves).toEqual([{ card: 'a.md', laneId: 'alpha-urgent' }])
  })

  /**
   * **Nothing is attempted and nothing is painted.** A beta card has no lane in this column, so the
   * server would refuse it. Asserting `onMove` was never called is the whole point: the alternative
   * is a card that visibly jumps and then returns, which reads as the app losing the drag.
   */
  it('does not attempt a drop the column has no lane for', () => {
    const { moves, host } = dragOntoUrgent(card(['02-projects', 'beta', '02-work', 'tasks', 'b.md']))
    expect(moves).toEqual([])
    // And the card is still in the column it started in, not moved optimistically.
    expect(host.byClass('board-lane')[0]?.byClass('board-card')).toHaveLength(1)
    expect(host.byClass('board-lane')[1]?.byClass('board-card')).toHaveLength(0)
  })
})
