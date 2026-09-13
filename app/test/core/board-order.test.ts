import { describe, expect, it } from 'vitest'
import {
  applyCardOrder, cardOrderOf, droppedAt, moveWithin, withCardOrder,
} from '../../src/core/board-order'
import { EMPTY_UI_STATE, type UiStateFile } from '../../src/core/fs/config-store'

/**
 * **THE ARRANGEMENT.** P14 B3.
 *
 * **The two tests worth writing first are the last two in this file** — the ones about retention and
 * merging. Everything else here fails loudly: a board in the wrong order is visible the moment it is
 * opened. Those two fail *silently and permanently*: an arrangement quietly erased on the next save,
 * with nothing on screen to say it happened.
 */

const NAMES = (items: readonly { name: string }[]): string[] => items.map(item => item.name)
const cards = (...names: string[]): { name: string }[] => names.map(name => ({ name }))

/**
 * **THE MOVE ITSELF.** Ruled 2026-08-21, on the menu the columns shipped with: *"clicking the dot
 * and then clicking move right — if I want to move something all the way over, it's messy."*
 *
 * The arrows on a column head and the `Top`/`Bottom` presses in the arrange stack are the **same
 * function** with different arguments, which is the reason it is a function at all: the inline swap
 * it replaced carried a comment warning that an off-by-one here duplicates an id, and a duplicated
 * id draws a column twice. A comment cannot fail; these can.
 *
 * **Every case below asserts the whole list, not the moved item.** A version that lost or duplicated
 * a neighbour passes any assertion that only looks at where the moved one landed — and losing a
 * column from an arrangement is the failure that matters, because the column then reappears at the
 * far end as an "arrival".
 */
describe('moveWithin', () => {
  const L = ['a', 'b', 'c', 'd'] as const

  it('moves one place down the list', () => {
    expect(moveWithin(L, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('moves one place up the list', () => {
    expect(moveWithin(L, 2, 1)).toEqual(['a', 'c', 'b', 'd'])
  })

  /**
   * **The press this whole change exists for.** MUTATION: implement it as a swap —
   * `[from, to] = [to, from]` — and this reddens while both adjacent cases above stay green, which
   * is exactly how a swap would have shipped looking correct.
   */
  it('sends an item all the way to the front, carrying everything else along', () => {
    expect(moveWithin(L, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('sends an item all the way to the end, carrying everything else along', () => {
    expect(moveWithin(L, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
  })

  /**
   * The guard rails. A control at the end of a row is disabled rather than removed, so it **can** be
   * reached by a keyboard or a script — and an out-of-range move must be a no-op rather than a
   * scramble. MUTATION: drop either bounds check; the last two cases redden.
   */
  it('leaves the list alone when there is nowhere to go', () => {
    expect(moveWithin(L, 0, -1)).toEqual([...L])
    expect(moveWithin(L, 3, 4)).toEqual([...L])
    expect(moveWithin(L, 1, 1)).toEqual([...L])
    expect(moveWithin(L, -1, 0)).toEqual([...L])
    expect(moveWithin(L, 9, 0)).toEqual([...L])
  })

  it('never mutates what it was given', () => {
    const original = [...L]
    moveWithin(original, 0, 3)
    expect(original).toEqual([...L])
  })

  it('has nothing to do to a single item', () => {
    expect(moveWithin(['only'], 0, 0)).toEqual(['only'])
  })
})

/**
 * **THE DROP'S ARITHMETIC**, and it exists as a function because of one case.
 *
 * Dragging a card **down inside its own column** is the commonest drag on a board and the only one
 * with an off-by-one in it: the card is removed before it is re-inserted, so every drawn position
 * below it has already shifted up by one. Get it wrong and the card lands one place short of where
 * it was dropped — which looks like the drop being imprecise rather than like a bug, so it survives
 * hand testing indefinitely.
 */
describe('droppedAt', () => {
  it('drops from another column at the drawn position', () => {
    expect(droppedAt(0, null, 3)).toBe(0)
    expect(droppedAt(2, null, 3)).toBe(2)
    expect(droppedAt(3, null, 3), 'past the last card is the end').toBe(3)
  })

  /** MUTATION: return `target` unconditionally. This is the case that reddens; upward stays green. */
  it('moving DOWN its own column accounts for its own removal', () => {
    // Drawn [a, b, c]; drag a (index 0) to just before c (drawn index 2). After a is lifted out the
    // list is [b, c], so a belongs at index 1 to sit between them.
    expect(droppedAt(2, 0, 3)).toBe(1)
    expect(droppedAt(3, 0, 3), 'dropped past the end lands last').toBe(2)
  })

  it('moving UP its own column does not', () => {
    // Drag c (index 2) to the top: nothing below it has shifted, so the target is unchanged.
    expect(droppedAt(0, 2, 3)).toBe(0)
    expect(droppedAt(1, 2, 3)).toBe(1)
  })

  it('dropping a card where it already is asks for the place it already has', () => {
    expect(droppedAt(1, 1, 3)).toBe(1)
  })

  /** A drawn position can only be nonsense if something upstream is, and a scramble is worse. */
  it('clamps a position outside the column', () => {
    expect(droppedAt(-4, null, 3)).toBe(0)
    expect(droppedAt(99, null, 3)).toBe(3)
    expect(droppedAt(99, 0, 3)).toBe(2)
  })

  it('an empty column takes a card at the only position there is', () => {
    expect(droppedAt(0, null, 0)).toBe(0)
  })
})

describe('applyCardOrder', () => {
  it('restores a remembered arrangement', () => {
    const present = cards('a.md', 'b.md', 'c.md')
    const ordered = applyCardOrder(present, card => card.name, ['c.md', 'a.md', 'b.md'])
    expect(NAMES(ordered)).toEqual(['c.md', 'a.md', 'b.md'])
  })

  /**
   * **THE BOTTOM, and the operator reversed me on this.**
   *
   * MUTATION: `ordered.unshift(item)` for the arrivals — top instead of bottom.
   *
   * I suggested the top. They said: *"that's what Trello does, that's what's intuitive, sorted from
   * oldest to newest."* An agent writing into a column is the common case, not the rare one, so this
   * is the rule that decides what a board looks like day to day.
   */
  it('a card that arrives from outside the app goes to the BOTTOM', () => {
    const present = cards('a.md', 'b.md', 'new-from-agent.md')
    const ordered = applyCardOrder(present, card => card.name, ['b.md', 'a.md'])
    expect(NAMES(ordered)).toEqual(['b.md', 'a.md', 'new-from-agent.md'])
  })

  it('several arrivals land at the bottom in a deterministic order, not the index order', () => {
    // `present` arrives sorted by name from boardContents; the arrivals must keep that.
    const present = cards('kept.md', 'x-new.md', 'y-new.md', 'z-new.md')
    const ordered = applyCardOrder(present, card => card.name, ['kept.md'])
    expect(NAMES(ordered)).toEqual(['kept.md', 'x-new.md', 'y-new.md', 'z-new.md'])
  })

  /**
   * MUTATION: render remembered names that have no file behind them.
   *
   * the operator: *"a remembered position for something renamed or removed outside the app is simply
   * ignored."* A ghost row is a card you can see and cannot open — and since nothing in this app
   * deletes, the file it names is usually still somewhere, which makes the ghost actively
   * misleading about where.
   */
  it('a remembered name with no file behind it makes no ghost row', () => {
    const present = cards('a.md')
    const ordered = applyCardOrder(present, card => card.name, ['gone.md', 'a.md', 'also-gone.md'])
    expect(NAMES(ordered)).toEqual(['a.md'])
  })

  it('an empty arrangement leaves the order it was given', () => {
    const present = cards('a.md', 'b.md')
    expect(NAMES(applyCardOrder(present, card => card.name, []))).toEqual(['a.md', 'b.md'])
  })

  /**
   * **A name repeated in the stored list must not duplicate the card.**
   *
   * MUTATION: look up by name without consuming the match. A hand-edited state file, or a bug
   * anywhere upstream, would then draw one file as two cards — and moving either would move the
   * same file, which is the most confusing possible failure on a board.
   */
  it('a duplicated remembered name does not draw the same card twice', () => {
    const present = cards('a.md', 'b.md')
    const ordered = applyCardOrder(present, card => card.name, ['a.md', 'a.md', 'b.md'])
    expect(NAMES(ordered)).toEqual(['a.md', 'b.md'])
  })

  it('every present card appears exactly once, whatever the stored list says', () => {
    const present = cards('a.md', 'b.md', 'c.md')
    const ordered = applyCardOrder(present, card => card.name, ['c.md', 'ghost.md', 'c.md'])
    expect(NAMES(ordered).slice().sort()).toEqual(['a.md', 'b.md', 'c.md'])
  })
})

describe('cardOrderOf', () => {
  const COLUMN = ['board-x', 'doing']

  it('reads back what was written', () => {
    const state = withCardOrder(EMPTY_UI_STATE, 'r1', COLUMN, ['b.md', 'a.md'], false)
    expect(cardOrderOf(state, 'r1', COLUMN, false)).toEqual(['b.md', 'a.md'])
  })

  it('a column never arranged has no stored order', () => {
    expect(cardOrderOf(EMPTY_UI_STATE, 'r1', COLUMN, false)).toEqual([])
  })

  it('another root with the same path is a different column', () => {
    const state = withCardOrder(EMPTY_UI_STATE, 'r1', COLUMN, ['a.md'], false)
    expect(cardOrderOf(state, 'r2', COLUMN, false)).toEqual([])
  })

  /**
   * MUTATION: return `value.cardOrder` without filtering.
   *
   * `PathKey.value` is typed `unknown` on purpose and the state file can be hand-edited. A number
   * where a filename belongs would never match anything, so the card it was meant to place would
   * silently fall to the bottom — a bug that looks like the arrival rule working correctly.
   */
  it('ignores entries that are not filenames rather than carrying them through', () => {
    const state: UiStateFile = {
      ...EMPTY_UI_STATE,
      pathKeys: [{ rootId: 'r1', segments: COLUMN, value: { cardOrder: ['a.md', 7, null, 'b.md'] } }],
    }
    expect(cardOrderOf(state, 'r1', COLUMN, false)).toEqual(['a.md', 'b.md'])
  })

  it('a value of the wrong shape entirely is not read as an order', () => {
    const state: UiStateFile = {
      ...EMPTY_UI_STATE,
      pathKeys: [{ rootId: 'r1', segments: COLUMN, value: { cardOrder: 'a.md' } }],
    }
    expect(cardOrderOf(state, 'r1', COLUMN, false)).toEqual([])
  })
})

describe('withCardOrder — the two that fail silently', () => {
  const COLUMN = ['board-x', 'doing']
  const OTHER = ['board-x', 'done']

  /**
   * **B3.5 — MERGE, NEVER REPLACE.** MUTATION: `value: { cardOrder: [...order] }`.
   *
   * `pathKeys` is a shared, path-addressed store. The Projects board keeps a `board` placement on
   * keys of exactly this kind, and a folder can be both a board column and a filed project. Writing
   * a card order by replacing the value erases the placement — and nothing on screen says so until
   * the Projects board is opened and a card has moved on its own.
   *
   * This is the security review's P9-9 finding, arriving in a second feature. `isPlainObject` is imported from
   * `project-board.ts` rather than copied for exactly this reason.
   */
  it('does not clobber another feature keeping data on the same key', () => {
    const state: UiStateFile = {
      ...EMPTY_UI_STATE,
      pathKeys: [{ rootId: 'r1', segments: COLUMN, value: { board: 'active', other: 1 } }],
    }

    const next = withCardOrder(state, 'r1', COLUMN, ['a.md'], false)
    const value = next.pathKeys[0]?.value as Record<string, unknown>

    expect(value.board, "the Projects board's placement survives").toBe('active')
    expect(value.other, 'and so does anything else').toBe(1)
    expect(value.cardOrder).toEqual(['a.md'])
  })

  /**
   * The array case P9-9 calls the sharp one: `typeof [] === 'object'`, so a naive merge spreads
   * `[1, 2]` into `{ 0: 1, 1: 2, … }` — worse than clobbering, because it looks like it merged.
   */
  it('rescues a value of an unplanned shape instead of spreading or dropping it', () => {
    const state: UiStateFile = {
      ...EMPTY_UI_STATE,
      pathKeys: [{ rootId: 'r1', segments: COLUMN, value: [1, 2] }],
    }

    const value = withCardOrder(state, 'r1', COLUMN, ['a.md'], false)
      .pathKeys[0]?.value as Record<string, unknown>

    expect(value.previousValue, 'kept, not thrown away').toEqual([1, 2])
    expect(value['0'], 'and not spread into numbered keys').toBeUndefined()
    expect(value.cardOrder).toEqual(['a.md'])
  })

  /**
   * **B3.4 — §13.8: AN UNRESOLVED KEY IS RETAINED, NOT DROPPED.**
   *
   * MUTATION: `state.pathKeys.filter(key => key.unresolved !== true).map(…)`.
   *
   * A volume unplugged this morning is plugged in this afternoon. Dropping its keys while it is away
   * erases arrangements the operator made by hand, permanently, with nothing to show it happened — and
   * the next save is what does it, not the unplugging. The single most damaging thing this phase
   * could get wrong, and the cheapest to guard.
   */
  it('carries every other key through untouched, including unresolved ones', () => {
    const state: UiStateFile = {
      ...EMPTY_UI_STATE,
      pathKeys: [
        { rootId: 'r2', segments: ['elsewhere'], value: { cardOrder: ['x.md'] }, unresolved: true },
        { rootId: 'r1', segments: OTHER, value: { board: 'kept' } },
      ],
    }

    const next = withCardOrder(state, 'r1', COLUMN, ['a.md'], false)

    const stranded = next.pathKeys.find(key => key.rootId === 'r2')
    expect(stranded, 'the unplugged volume keeps its arrangement').toBeDefined()
    expect(stranded?.unresolved).toBe(true)
    expect(stranded?.value).toEqual({ cardOrder: ['x.md'] })

    const sibling = next.pathKeys.find(key => key.segments[1] === 'done')
    expect(sibling?.value, 'and an untouched sibling is untouched').toEqual({ board: 'kept' })

    expect(next.pathKeys).toHaveLength(3)
  })

  it('writing twice replaces the order rather than appending a second key', () => {
    const once = withCardOrder(EMPTY_UI_STATE, 'r1', COLUMN, ['a.md'], false)
    const twice = withCardOrder(once, 'r1', COLUMN, ['b.md', 'a.md'], false)

    expect(twice.pathKeys).toHaveLength(1)
    expect(cardOrderOf(twice, 'r1', COLUMN, false)).toEqual(['b.md', 'a.md'])
  })

  it('does not disturb the rest of the ui state', () => {
    const state: UiStateFile = { ...EMPTY_UI_STATE, boardSelection: [{ rootId: 'r1', segments: ['p'] }] }
    const next = withCardOrder(state, 'r1', COLUMN, ['a.md'], false)
    expect(next.boardSelection).toEqual(state.boardSelection)
  })
})
