import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  filterSummary, mountProjectFilter, nestProjects, selectionKey,
} from '../../src/client/board/project-filter'
import { el } from '../../src/client/dom'
import { FakeElement, installFakeDocument, removeFakeDocument } from '../support/fake-dom'

/**
 * **THE PICKER, WHICH IS THE FEATURE RATHER THAN ITS DECORATION.**
 *
 * the operator cannot use the Tasks tab today because *"everything is buried in 12 different folders."*
 * A flat alphabetical list of forty projects is that same problem wearing a checkbox. The nesting
 * is what turns *"I pick Holdings Group and then under it are the three projects within it"*
 * from a hunt into three clicks — so the ordering rule is load-bearing, not cosmetic.
 */

beforeEach(installFakeDocument)
afterEach(removeFakeDocument)

const project = (segments: string[]) => ({
  rootId: 'soil', segments, name: segments[segments.length - 1] ?? '',
})

const BINS = ['02-projects', 'bin-logistics']
const CLIENT_A = [...BINS, '02-work', 'projects', 'client-a']
const CLIENT_B = [...BINS, '02-work', 'projects', 'client-b']
const ALPHA_TWO = ['02-projects', 'bin-logistics-old']
const ORCHARD = ['02-projects', 'orchard']
/** Inside `bin-logistics-OLD`, and therefore NOT inside `bin-logistics`. */
const OLD_CHILD = [...ALPHA_TWO, '02-work', 'projects', 'sub']
/** Named to sort after `orchard` while living inside `bin-logistics`. */
const LATE_CHILD = [...BINS, '02-work', 'projects', 'zzz-client']

describe('nestProjects — the order and the indent', () => {
  it('puts a project immediately before the projects inside it', () => {
    const rows = nestProjects([project(ORCHARD), project(CLIENT_B), project(BINS), project(CLIENT_A)])
    expect(rows.map(row => row.name)).toEqual([
      'bin-logistics', 'client-a', 'client-b', 'orchard',
    ])
  })

  /**
   * **Depth counts selectable ancestors, not path segments.** `client-a` is five segments deep and
   * one *project* deep, and the second number is the one a reader is looking at. Indenting by path
   * length would push every op four levels in for reasons nobody can see.
   */
  it('indents by how many projects contain it, not by path length', () => {
    const rows = nestProjects([project(BINS), project(CLIENT_A)])
    expect(rows.map(row => `${row.name}:${row.depth}`))
      .toEqual(['bin-logistics:0', 'client-a:1'])
  })

  /**
   * `bin-logistics-old` is not inside `bin-logistics` — it shares a text prefix and no
   * folder. Spec §5's segment-boundary rule, which `laneForCard` had to learn after a sweep, and
   * getting it wrong here indents an unrelated project under a stranger.
   */
  it('is not fooled by a project whose name is a prefix of another', () => {
    const rows = nestProjects([project(BINS), project(ALPHA_TWO)])
    expect(rows.map(row => row.depth)).toEqual([0, 0])
  })

  /**
   * **The case a sweep proved the one above could not see.** Two sibling projects at the same depth
   * are filtered out by the length guard before any prefix test runs, so a `startsWith` survived it.
   * A project *inside* `bin-logistics-old` is deeper, so the guard lets it through — and as text
   * its path begins with `02-projects/bin-logistics`, so a string prefix counts an unrelated
   * project as an ancestor and indents it a level too far, under a stranger.
   */
  it('does not count a name-prefix stranger as an ancestor of a deeper project', () => {
    const rows = nestProjects([project(BINS), project(ALPHA_TWO), project(OLD_CHILD)])
    const child = rows.find(row => row.name === 'sub')
    expect(child?.depth, 'sub is inside bin-logistics-old and nothing else').toBe(1)
  })

  /**
   * **Named so that name-order and path-order genuinely differ**, which the first version of this
   * case did not manage: `client-a` sorts between `bin-logistics` and `orchard` either way, so
   * sorting by name passed it. `zzz-client` lives inside `bin-logistics` and sorts last by
   * name — so a name sort separates it from its parent and draws it indented under `orchard`, which
   * is an indent describing a nesting the order contradicts.
   */
  it('orders by path rather than by name, so the indent never contradicts the order', () => {
    const rows = nestProjects([project(LATE_CHILD), project(ORCHARD), project(BINS)])
    expect(rows.map(row => `${row.name}:${row.depth}`))
      .toEqual(['bin-logistics:0', 'zzz-client:1', 'orchard:0'])
  })
})

describe('filterSummary — what the closed control says', () => {
  /**
   * **"All projects" when nothing is ticked.** The empty selection *is* the default and it means
   * everything; a control reading "none selected" above a full board would be the screen
   * disagreeing with itself, which is the condition this build exists to prevent.
   */
  it('says All projects when nothing is ticked', () => {
    expect(filterSummary(new Set(), 4)).toBe('All projects')
  })

  it('says All projects when everything is ticked, because that is the same board', () => {
    expect(filterSummary(new Set(['a', 'b']), 2)).toBe('All projects')
  })

  it('counts, and gets the singular right', () => {
    expect(filterSummary(new Set(['a']), 4)).toBe('1 project')
    expect(filterSummary(new Set(['a', 'b']), 4)).toBe('2 projects')
  })
})

describe('the mounted picker', () => {
  const mount = (selected: string[] = []): { host: FakeElement; changes: Array<string[]> } => {
    const changes: Array<string[]> = []
    const host = el('div') as unknown as FakeElement
    mountProjectFilter(host as unknown as HTMLElement, {
      projects: [project(BINS), project(CLIENT_A), project(ORCHARD)],
      selected: new Set(selected),
      onChange: next => changes.push([...next].sort()),
    })
    return { host, changes }
  }

  it('draws one row per project, with a tick each', () => {
    const { host } = mount()
    expect(host.byClass('project-filter-row')).toHaveLength(3)
    expect(host.byClass('project-filter-tick')).toHaveLength(3)
  })

  it('reports the project that was ticked', () => {
    const { host, changes } = mount()
    const tick = host.byClass('project-filter-tick')[0]
    ;(tick as unknown as { checked: boolean }).checked = true
    tick?.fire('change')
    expect(changes).toEqual([[selectionKey('soil', BINS)]])
  })

  it('removes a project that was unticked, leaving the others', () => {
    const { host, changes } = mount([selectionKey('soil', BINS), selectionKey('soil', ORCHARD)])
    const tick = host.byClass('project-filter-tick')[0]
    ;(tick as unknown as { checked: boolean }).checked = false
    tick?.fire('change')
    expect(changes).toEqual([[selectionKey('soil', ORCHARD)]])
  })

  it('offers Clear filters only when something is ticked', () => {
    // A permanently visible Clear on a board already showing everything is a control that does
    // nothing, and this build keeps a ledger of those.
    expect(mount().host.byClass('project-filter-clear')).toHaveLength(0)
    expect(mount([selectionKey('soil', BINS)]).host.byClass('project-filter-clear')).toHaveLength(1)
  })

  it('Clear filters empties the selection, which is the board back to everything', () => {
    const { host, changes } = mount([selectionKey('soil', BINS)])
    host.byClass('project-filter-clear')[0]?.fire('click')
    expect(changes).toEqual([[]])
  })

  /**
   * **The list stays open across a redraw**, which every tick causes. A disclosure that closed each
   * time would mean reopening it to choose each project — the opposite of a multi-select. Found by
   * a browser test timing out on an invisible checkbox rather than by reading the code.
   */
  it('stays open across the redraw that a tick causes', () => {
    const host = el('div') as unknown as FakeElement
    const draw = (selected: string[]): void => {
      mountProjectFilter(host as unknown as HTMLElement, {
        projects: [project(BINS), project(ORCHARD)],
        selected: new Set(selected),
        onChange: () => { /* not this test */ },
      })
    }
    draw([])
    expect(host.byClass('project-filter')[0]?.hasAttribute('open')).toBe(false)

    host.byClass('project-filter')[0]?.setAttribute('open', '')
    draw([selectionKey('soil', BINS)])
    expect(host.byClass('project-filter')[0]?.hasAttribute('open')).toBe(true)
  })

  it('shows the ticks that are already on', () => {
    const { host } = mount([selectionKey('soil', CLIENT_A)])
    const checked = host.byClass('project-filter-tick')
      .filter(node => (node as unknown as { checked?: boolean }).checked === true)
    expect(checked).toHaveLength(1)
    expect(checked[0]?.getAttribute('data-project')).toBe(selectionKey('soil', CLIENT_A))
  })
})
