import { describe, expect, it } from 'vitest'

import { type BoardLane, statusChoicesFor } from '../../src/client/board/board-view'
import type { WireEntry } from '../../src/contract/wire'

/**
 * Spec §18.5 -- the statuses a card can be given.
 *
 * **The property under test is not "it lists the lanes."** It is that every offer is the id *this
 * card's project* moves with, and that a column with nothing for that project is **absent rather
 * than offered**. On a gathered board the column's own id is the wrong answer, and an offer that
 * cannot be honoured is a move that must not be attempted -- not one that lands somewhere
 * plausible. That is the failure P9-1 already produced once through a different mechanism.
 */

const card = (segments: readonly string[]): WireEntry =>
  ({ segments, title: 'a task', name: 'a-task.md' }) as unknown as WireEntry

const lane = (
  id: string, name: string, extra: Record<string, unknown> = {},
): BoardLane => ({ id, name, synthetic: false, ...extra }) as unknown as BoardLane

/** One project's lane inside a merged column. `origin.project` is what `laneForCard` matches on. */
const member = (id: string, project: readonly string[]): unknown =>
  ({ id, name: id, synthetic: false, origin: { project } })

describe('statusChoicesFor -- every offer is honourable, or it is not offered', () => {
  const CARD = card(['02-projects', 'cider', '02-work', 'tasks', '01-next', 'a-task.md'])

  it('offers every lane on a single-project board, and marks the one it is in', () => {
    const choices = statusChoicesFor(
      [lane('01-next', 'Next'), lane('02-doing', 'Doing'), lane('03-done', 'Done')],
      CARD, '01-next',
    )
    expect(choices.map(choice => choice.label)).toEqual(['Next', 'Doing', 'Done'])
    expect(choices.filter(choice => choice.current).map(choice => choice.id)).toEqual(['01-next'])
  })

  it('keeps the current lane in the list rather than dropping it', () => {
    /**
     * A picker that omitted the present status would change shape depending on where the card
     * already is -- so the same status would sit under a different finger each time, on a surface
     * where the neighbouring row moves a file.
     */
    const lanes = [lane('01-next', 'Next'), lane('02-doing', 'Doing')]
    expect(statusChoicesFor(lanes, CARD, '01-next')).toHaveLength(2)
    expect(statusChoicesFor(lanes, CARD, '02-doing')).toHaveLength(2)
  })

  it('INCLUDES the synthetic Uncategorized lane', () => {
    /**
     * §18.5: *"The Uncategorized lane is one of the choices, so 'no status' is reachable by the same
     * action that set one."* The first draft of the function filtered it out for being synthetic --
     * which would have made the one unreachable status the one meaning "I have not decided yet."
     */
    const choices = statusChoicesFor(
      [lane('01-next', 'Next'), lane('~uncategorized', 'Uncategorized', { synthetic: true })],
      CARD, '01-next',
    )
    expect(choices.map(choice => choice.label)).toContain('Uncategorized')
  })

  it('on a gathered board offers THIS project\'s lane id, not the column\'s', () => {
    const gathered: BoardLane[] = [
      lane('next', 'Next', {
        members: [
          member('01-next', ['02-projects', 'cider']),
          member('next', ['02-projects', 'orchard']),
        ],
      }),
    ]
    const choices = statusChoicesFor(gathered, CARD, '01-next')
    // The column is called `next`; the card lives under cider, whose lane folder is `01-next`.
    expect(choices.map(choice => choice.id)).toEqual(['01-next'])
  })

  it('DROPS a column that has nothing for this card\'s project', () => {
    // The case that matters most, and the one an implementation mapping over `lanes` gets wrong.
    const gathered: BoardLane[] = [
      lane('blocked', 'Blocked', {
        members: [
          member('blocked', ['02-projects', 'orchard']),
        ],
      }),
    ]
    expect(statusChoicesFor(gathered, CARD, '01-next')).toEqual([])
  })
})
