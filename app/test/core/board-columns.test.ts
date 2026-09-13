import { beforeEach, describe, expect, it } from 'vitest'

import type { Selection } from '../../src/core/board'
import {
  columnsFor, lanesOf, tasksDirsUnder, type Lane,
} from '../../src/core/board'
import { laneForCard } from '../../src/core/lane-match'
import { IndexStore } from '../../src/core/index-store'

/**
 * **THE GATHERED BOARD.** P11 U1 — ruled 2026-08-12:
 *
 * > *"they would all collapse into one next column… If I'm looking at Holdings Group, and I'm in
 * > my consulting company folder, I want to see all of my tasks across all my projects."*
 *
 * ## The fixture has TWO of everything, deliberately
 *
 * This is the gate condition the P11 brief names, and it is named because the build has paid for it
 * twice already. M36, on P8: *"every template fixture registers exactly one root"* — so a
 * cross-root bug shipped. M35, the same phase, the same shape. A **fixture with one of something
 * cannot test what happens when there are two**, and this unit is *entirely about* there being two.
 *
 * So: two projects with same-named lanes, a nested op inside one of them, a project owning two
 * separate tasks folders, loose files in more than one place, a lane that differs only by case, an
 * archive, a folder literally named `uncategorized`, and a `tasks/` no project owns.
 */

const ROOT = 'soil'

let store: IndexStore

/** Adds a directory and every ancestor the index would have seen on the way to it. */
function dir(...segments: string[]): void {
  for (let depth = 1; depth <= segments.length; depth++) {
    const at = segments.slice(0, depth)
    if (store.get(ROOT, at) !== undefined) continue
    store.upsert({
      rootId: ROOT, segments: at, name: at[at.length - 1] ?? '', kind: 'directory',
      title: '', size: 0, mtimeNs: 1n, dev: 1n, ino: BigInt(at.join('/').length + depth * 7919),
      isMarkdown: false, contentUnavailable: false,
    })
  }
}

function file(...segments: string[]): void {
  dir(...segments.slice(0, -1))
  const name = segments[segments.length - 1] ?? ''
  store.upsert({
    rootId: ROOT, segments, name, kind: 'file', title: name.replace(/\.md$/, ''),
    size: 10, mtimeNs: 1n, dev: 1n, ino: BigInt(segments.join('/').length * 31 + 1),
    isMarkdown: true, contentUnavailable: false,
  })
}

const names = (segments: Selection): string[] =>
  columnsFor(store, ROOT, segments, true).map(column => column.name)

beforeEach(() => {
  store = new IndexStore()
  store.registerRootCasing(ROOT, true)

  // --- alpha: the ordinary project -----------------------------------------------------------
  file('02-projects', 'alpha', '02-work', 'tasks', '01-urgent', 'a1.md')
  file('02-projects', 'alpha', '02-work', 'tasks', '02-next', 'a2.md')
  // A file sitting directly in tasks/ — this is what Uncategorized is.
  file('02-projects', 'alpha', '02-work', 'tasks', 'loose-a.md')

  // --- beta: same lane names, so the merge has something to merge -----------------------------
  file('02-projects', 'beta', '02-work', 'tasks', '01-urgent', 'b1.md')
  file('02-projects', 'beta', '02-work', 'tasks', '03-back-burner', 'b2.md')
  file('02-projects', 'beta', '02-work', 'tasks', 'loose-b.md')
  // Retired work. §3 excludes archive from every derived live set.
  file('02-projects', 'beta', '02-work', 'tasks', 'archive', 'gone.md')

  // --- an op nested inside alpha, which is the "especially with nesting" case -----------------
  file('02-projects', 'alpha', '02-work', 'projects', 'op-one', '02-work', 'tasks', '02-next', 'o1.md')

  // --- alpha's SECOND tasks folder, shallower than its first ----------------------------------
  file('02-projects', 'alpha', 'tasks', '01-urgent', 'a3.md')

  // --- a lane differing only by case, which must not become a second column -------------------
  file('02-projects', 'gamma', '02-work', 'tasks', '02-Next', 'g1.md')

  // --- a real folder called `uncategorized`: a different place from the synthetic lane ---------
  file('02-projects', 'gamma', '02-work', 'tasks', 'uncategorized', 'g2.md')

  /**
   * **A whole retired op, with its own tasks folder inside it.**
   *
   * Added after a mutation sweep: removing the archive filter from `tasksDirsUnder` left this file
   * green, because the only archive here was `tasks/archive/` — a *lane*, excluded one level lower
   * by `placedLanesIn`. The filter guarding archived **projects** had no case at all, which makes it
   * the sixteenth control in this build that was live and unobservable. A retired op whose tasks
   * came back as columns is the board version of the Archive-column bug M37 records.
   */
  file('02-projects', 'beta', 'archive', 'old-op', '02-work', 'tasks', '01-urgent', 'z1.md')

  // --- a tasks folder no project owns -----------------------------------------------------------
  file('04-experiments-and-research', 'tasks', '01-urgent', 'x1.md')
})

describe('tasksDirsUnder — what a scope actually contains', () => {
  it('finds every tasks folder a project owns, including a second one', () => {
    const found = tasksDirsUnder(store, ROOT, ['02-projects', 'alpha'], true)
      .map(segments => segments.join('/'))
    /**
     * **Both**, where `tasksDirOf` returns one. That difference is the whole reason this function
     * exists rather than reusing the other: "which folder does this project mean" and "what is under
     * here" are different questions, and only the first one has to pick a winner.
     */
    expect(found).toEqual([
      '02-projects/alpha/02-work/projects/op-one/02-work/tasks',
      '02-projects/alpha/02-work/tasks',
      '02-projects/alpha/tasks',
    ])
  })

  it('ignores a tasks folder that no project encloses', () => {
    const found = tasksDirsUnder(store, ROOT, [], true).map(segments => segments.join('/'))
    expect(found).not.toContain('04-experiments-and-research/tasks')
    // And it did find things, so the assertion above is not passing on an empty list.
    expect(found.length).toBeGreaterThan(3)
  })

  it('reaches a nested op from its parent project', () => {
    const found = tasksDirsUnder(store, ROOT, ['02-projects', 'alpha'], true)
      .map(segments => segments.join('/'))
    expect(found).toContain('02-projects/alpha/02-work/projects/op-one/02-work/tasks')
  })

  it('is ordered, so two identical requests cannot disagree', () => {
    // P9-7's precedent: a tie left to Map iteration order made a board draw from a different folder
    // between two identical requests. The index is a Map; the order here is imposed, not inherited.
    const once = tasksDirsUnder(store, ROOT, [], true).map(s => s.join('/'))
    const twice = tasksDirsUnder(store, ROOT, [], true).map(s => s.join('/'))
    expect(once).toEqual(twice)
    expect([...once].sort()).toEqual(once)
  })
})

describe('columnsUnder — same-named lanes collapse into one column', () => {
  it('merges Urgent across two different projects', () => {
    const columns = columnsFor(store, ROOT, [], true)
    const urgent = columns.filter(column => column.name === 'Urgent')
    expect(urgent, 'Urgent appeared as more than one column').toHaveLength(1)
    /**
     * **Three contributors, each keeping its own id.** alpha's two tasks folders and beta's one.
     * The ids are what a drop targets — a column is a display grouping and is deliberately not
     * addressable, because there is no folder named "every Urgent under here".
     */
    expect(urgent[0]?.lanes).toHaveLength(3)
    expect(new Set(urgent[0]?.lanes.map(lane => lane.id)).size).toBe(3)
  })

  it('merges a lane that differs only by case, rather than showing it twice', () => {
    // `02-Next` and `02-next` are one lane on a case-insensitive volume. Merging on raw bytes would
    // draw two columns that look identical and send drops to whichever the reader guessed.
    const next = columnsFor(store, ROOT, [], true).filter(c => c.name === 'Next')
    expect(next).toHaveLength(1)
    expect(next[0]?.lanes.length).toBeGreaterThan(2)
  })

  it('keeps the numeric prefixes apart — merging is on the folder, never the display name', () => {
    // `laneDisplayName` strips `01-` and `02-`. Merging on the displayed word would fold
    // `01-urgent` and `02-urgent` together and lose the ordering the prefixes exist to carry.
    file('02-projects', 'delta', '02-work', 'tasks', '05-urgent', 'd1.md')
    const urgent = columnsFor(store, ROOT, [], true).filter(c => c.name === 'Urgent')
    expect(urgent, '01-urgent and 05-urgent were folded into one column').toHaveLength(2)
  })

  it('gathers loose files from every project into one Uncategorized, on the left', () => {
    const columns = columnsFor(store, ROOT, [], true)
    expect(columns[0]?.name).toBe('Uncategorized')
    expect(columns[0]?.synthetic).toBe(true)
    // alpha's and beta's loose files: two contributing tasks folders, not one.
    expect(columns[0]?.lanes.length).toBeGreaterThanOrEqual(2)
  })

  it('does not merge a real folder named uncategorized into the synthetic lane', () => {
    const columns = columnsFor(store, ROOT, [], true)
    const synthetic = columns.filter(column => column.synthetic)
    expect(synthetic).toHaveLength(1)
    /**
     * They are different places. `gamma/02-work/tasks/uncategorized/` is a folder a drop moves a
     * file *into*; the synthetic lane is the absence of a lane, and a drop there moves a file *up*.
     * Showing them as one column would send a card somewhere the reader did not point at.
     */
    const real = columns.find(column => !column.synthetic && column.name.toLowerCase() === 'uncategorized')
    expect(real, 'the real folder vanished into the synthetic lane').toBeDefined()
  })

  it('never gathers the tasks folder of a retired op', () => {
    const found = tasksDirsUnder(store, ROOT, ['02-projects'], true).map(s => s.join('/'))
    expect(found).not.toContain('02-projects/beta/archive/old-op/02-work/tasks')
    // The folder is really there — the exclusion is a decision, not an empty fixture.
    expect(store.get(ROOT, ['02-projects', 'beta', 'archive', 'old-op', '02-work', 'tasks'])).toBeDefined()
  })

  /**
   * **Every lane says which project it came from**, asserted here because a sweep found nothing did.
   * `originOf` returning an empty path left the whole suite green: `laneForCard`'s own cases build
   * their lanes by hand, so the wiring between the rule and the enumeration had no test at all — a
   * live control, and the one a cross-project drag depends on entirely.
   */
  it('carries each contributing lane\'s own project', () => {
    const urgent = columnsFor(store, ROOT, [], true)
      .find(column => column.name === 'Urgent')
    const origins = urgent?.lanes.map(lane => lane.origin.project.join('/')).sort()
    // alpha twice — it owns two tasks folders — and beta once.
    expect(origins).toEqual(['02-projects/alpha', '02-projects/alpha', '02-projects/beta'])
    expect(urgent?.lanes.every(lane => lane.origin.name !== '')).toBe(true)
  })

  it('never shows an archive as a column', () => {
    expect(names([])).not.toContain('Archive')
    // beta's archive holds a file, so this is not passing because the folder was empty.
    expect(store.get(ROOT, ['02-projects', 'beta', '02-work', 'tasks', 'archive', 'gone.md'])).toBeDefined()
  })

  it('orders columns by the grammar, with Uncategorized leftmost', () => {
    const columns = names([])
    expect(columns.slice(0, 4)).toEqual(['Uncategorized', 'Urgent', 'Next', 'Back Burner'])
    // Plus gamma's real `uncategorized` folder, whose display spelling is laneDisplayName's
    // business rather than this case's. Five columns, not six: the case variant merged.
    expect(columns).toHaveLength(5)
  })
})

/**
 * **THE COST OF WIDENING.** The security review, P11 C1.
 *
 * The board exists so the operator can widen — *"I pick Holdings Group and then under it are the
 * three projects within it."* The first implementation walked the whole index **once per selected
 * project**, so the gesture the picker is built for was the one that cost the most: on an
 * 800-project tree, the empty selection took 35ms and ticking everything took **13.4 seconds**, for
 * the identical board.
 *
 * **Asserted as a ratio against the empty selection**, never as a millisecond figure. A wall-clock
 * bound passes on a fast machine while the property is false; the ratio is the property.
 */
describe('a wide selection costs about what a narrow one does', () => {
  const elapsed = (run: () => void): number => {
    run()
    const started = performance.now()
    run()
    return Math.max(performance.now() - started, 0.05)
  }

  it('is governed by the size of the tree, not by how much of it you ask for', () => {
    const PROJECTS = 300
    for (let at = 0; at < PROJECTS; at++) {
      file('02-projects', `bulk-${at}`, '02-work', 'tasks', '01-urgent', `t${at}.md`)
    }
    const all = Array.from({ length: PROJECTS }, (_, at) => ['02-projects', `bulk-${at}`])

    const empty = elapsed(() => { columnsFor(store, ROOT, [], true) })
    const every = elapsed(() => { columnsFor(store, ROOT, all, true) })

    /**
     * Both draw a board over the same tree. Before the fix this ratio was ~384; a single pass makes
     * it a small constant. Generous, because it is measuring a real clock — but 384 is not within
     * any reading of "generous".
     */
    expect(every / empty, `empty ${empty.toFixed(1)}ms -> all ${every.toFixed(1)}ms`)
      .toBeLessThan(8)
  })

  it('does not pay again for the same project named twice', () => {
    const PROJECTS = 200
    for (let at = 0; at < PROJECTS; at++) {
      file('02-projects', `dup-${at}`, '02-work', 'tasks', '01-urgent', `t${at}.md`)
    }
    const one = [['02-projects', 'dup-0']]
    const repeated = Array.from({ length: 300 }, () => ['02-projects', 'dup-0'])

    const single = elapsed(() => { columnsFor(store, ROOT, one, true) })
    const many300 = elapsed(() => { columnsFor(store, ROOT, repeated, true) })

    // The dedup used to be consulted AFTER each project's walk, so 512 copies of one project cost
    // 4.1 seconds. There is one walk to consult it in now.
    expect(many300 / single, `1 copy ${single.toFixed(1)}ms -> 300 copies ${many300.toFixed(1)}ms`)
      .toBeLessThan(8)
  })
})

describe('laneForCard — which of a merged column\'s lanes a card may land in', () => {
  /**
   * **Fed directly, with the lanes in a deliberately adverse order.**
   *
   * The first version of these cases went through `columnsUnder`, and a mutation sweep showed all
   * three proving nothing: `tasksDirsUnder` sorts, and the sort happened to put the right answer
   * first every time. First-match-wins, string-prefix matching and a missing bounds check all
   * passed. **The tests agreed with the bug** — the third time in this build a suite has done that,
   * and the cause is the same each time: exercising a rule through a pipeline that is already
   * arranging its inputs favourably.
   *
   * So the column is built here, outermost-first, which is the order that breaks a first-match rule.
   */
  const lane = (project: string[], id: string): Lane => ({
    id, name: 'Urgent', synthetic: false,
    origin: { project, name: project[project.length - 1] ?? '' },
  })

  const OUTER = ['02-projects', 'alpha']
  const NESTED = ['02-projects', 'alpha', '02-work', 'projects', 'op-one']
  const SIBLING = ['02-projects', 'alpha-two']

  // Outermost FIRST, and the prefix-sharing sibling before the one that should win.
  const column = {
    lanes: [lane(OUTER, 'outer'), lane(NESTED, 'nested'), lane(SIBLING, 'sibling')],
  }

  it('picks the lane belonging to the card\'s own project', () => {
    expect(laneForCard(column, [...OUTER, '02-work', 'tasks', '02-next', 'a.md'])?.id).toBe('outer')
  })

  /**
   * **The nested op, and why the rule is longest-match rather than first-match.** A card inside
   * `alpha/…/op-one` sits under *both* alpha and op-one, and the lane it belongs to is the innermost
   * one. First-match would file every op's card into its parent project's lane — a real move, of a
   * real file, to a place nobody pointed at. With `outer` listed first, that bug cannot hide here.
   */
  it('prefers the innermost project when an op is nested inside one', () => {
    expect(laneForCard(column, [...NESTED, '02-work', 'tasks', '01-urgent', 'o.md'])?.id)
      .toBe('nested')
  })

  /**
   * **`alpha-two` is not inside `alpha`**, and only segment-wise matching knows that. As a string,
   * `02-projects/alpha-two/…` begins with `02-projects/alpha` — so a `startsWith` would match both,
   * and with `alpha` listed first it would file alpha-two's cards into alpha. This is spec §5's
   * segment-boundary rule, which `subtree` already states in its own header after the same bug bit
   * the lab code.
   */
  it('is not fooled by a project whose name is a prefix of another', () => {
    expect(laneForCard(column, [...SIBLING, '02-work', 'tasks', '01-urgent', 'at.md'])?.id)
      .toBe('sibling')
  })

  it('returns null when the column has nothing for that card\'s project', () => {
    expect(laneForCard(column, ['02-projects', 'gamma', '02-work', 'tasks', 'g.md'])).toBeNull()
  })

  it('returns null rather than matching when the card path is shorter than a project', () => {
    // A card cannot live above the project that owns it. Without a real comparison this reads as
    // a match on a truncated path.
    expect(laneForCard(column, ['02-projects'])).toBeNull()
  })
})

describe('scope — one project is the degenerate case, not a separate mode', () => {
  it('scoped to one project, shows only that project\'s lanes', () => {
    const columns = names([['02-projects', 'beta']])
    expect(columns).toContain('Urgent')
    expect(columns).toContain('Back Burner')
    // gamma's lanes are not beta's.
    expect(columns).not.toContain('uncategorized')
  })

  /**
   * **Ticking a parent does NOT bring its ops along**, and that is the operator's distinction rather
   * than a limitation: *"I also might want to see just the Holdings Group's tasks, not all of
   * its projects' tasks."*
   *
   * In the picker the parent and its ops are separate rows, so "everything in here" is a few clicks
   * and "just this" is one — with no mode, no toggle, and nothing to explain. The earlier design
   * gathered the whole subtree and could not express the second question at all.
   */
  it('gives a selected project its own lanes, not its ops\'', () => {
    const alpha = columnsFor(store, ROOT, [['02-projects', 'alpha']], true)
    const next = alpha.find(column => column.name === 'Next')
    // alpha's own 02-next only. op-one's is op-one's.
    expect(next?.lanes).toHaveLength(1)
    expect(next?.lanes[0]?.origin.project).toEqual(['02-projects', 'alpha'])
  })

  it('brings the op in when the op is ticked too', () => {
    const both = columnsFor(store, ROOT, [
      ['02-projects', 'alpha'],
      ['02-projects', 'alpha', '02-work', 'projects', 'op-one'],
    ], true)
    const next = both.find(column => column.name === 'Next')
    expect(next?.lanes.map(lane => lane.origin.name).sort()).toEqual(['alpha', 'op-one'])
  })

  /**
   * **A parent and a child ticked together must not double up.** Their tasks folders can resolve to
   * the same directory on some trees, and a lane added twice puts every one of its cards on the
   * board twice — which reads as duplicated work rather than a display bug.
   */
  it('does not count a folder twice when overlapping projects are ticked', () => {
    const once = columnsFor(store, ROOT, [['02-projects', 'alpha']], true)
    const twice = columnsFor(store, ROOT, [['02-projects', 'alpha'], ['02-projects', 'alpha']], true)
    expect(twice.map(c => c.lanes.length)).toEqual(once.map(c => c.lanes.length))
  })

  /**
   * **The single-project board is untouched.** `lanesOf` is P9's, it is gated, and a drag resolves
   * against it — so the guarantee worth pinning is that adding the gathered view did not quietly
   * change what a single project shows.
   */
  it('leaves the single-project board exactly as P9 gated it', () => {
    const lanes = lanesOf(store, ROOT, ['02-projects', 'beta'], true).map(lane => lane.name)
    expect(lanes).toEqual(['Uncategorized', 'Urgent', 'Back Burner'])
  })

  it('a scope with no projects under it has no columns, rather than throwing', () => {
    expect(columnsFor(store, ROOT, [['04-experiments-and-research']], true)).toEqual([])
  })
})
