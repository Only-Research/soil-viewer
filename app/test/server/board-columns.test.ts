import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IndexStore } from '../../src/core/index-store'
import { indexRegisteredRoot } from '../../src/core/indexer'
import { loadConfigService } from '../../src/server/config-service'
import { createRootRegistry } from '../../src/server/root-registry'
import { createServices, type Services } from '../../src/server/services'
import { tokenReader } from '../support/entry-tokens'

/**
 * **THE GATHERED BOARD, THROUGH THE SERVICE, AGAINST A REAL FILESYSTEM.**
 *
 * `test/core/board-columns.test.ts` proves the merge against a hand-built index. What only this
 * layer can answer is the thing that actually matters for a drag:
 *
 * > **a lane id minted by a gathered board must still resolve through `card.move`.**
 *
 * A column is a display grouping across many folders and is deliberately not addressable. If
 * gathering had changed how ids are minted — a column id, a re-derived digest, an id built from the
 * scope rather than the lane — the board would draw perfectly and every drop would be refused, or
 * worse, land somewhere else. That is the M2 class of bug arriving through a new door, and it is
 * what this file exists to close.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree per test.
 */

let sandbox: string
let rootPath: string
let services: Services
let index: IndexStore
let token: (segments: readonly string[]) => Promise<string>

/** Two projects with the SAME lane names, which is the entire point of the fixture. */
const ALPHA = ['02-projects', 'alpha']
const BETA = ['02-projects', 'beta']

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-columns-'))
  rootPath = join(sandbox, 'root')

  const make = async (project: readonly string[], lane: string, file: string): Promise<void> => {
    const at = join(rootPath, ...project, '02-work', 'tasks', lane)
    await fsp.mkdir(at, { recursive: true })
    await fsp.writeFile(join(at, file), `# ${file.replace(/\.md$/, '')}\n`)
  }

  await make(ALPHA, '01-urgent', 'alpha-urgent.md')
  await make(ALPHA, '02-next', 'alpha-next.md')
  await make(BETA, '01-urgent', 'beta-urgent.md')
  await make(BETA, '03-back-burner', 'beta-back.md')
  // A retired op with its own tasks folder. The core suite gained this case after a mutation sweep
  // showed the archive filter had none; it belongs here too, where the index is real.
  // A FOLDER inside a lane. A card is a file; a sub-folder is not one, and a sweep showed nothing
  // here could tell the difference because every lane in this fixture held only markdown.
  await fsp.mkdir(join(rootPath, ...ALPHA, '02-work', 'tasks', '01-urgent', 'attachments'), { recursive: true })

  const retired = join(rootPath, ...BETA, 'archive', 'old-op', '02-work', 'tasks', '01-urgent')
  await fsp.mkdir(retired, { recursive: true })
  await fsp.writeFile(join(retired, 'retired.md'), '# Retired\n')

  const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)

  index = new IndexStore()
  await indexRegisteredRoot(registered.value, index)

  const config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })
  services = createServices(registry, index, {
    stagingRoot: join(sandbox, 'app-scratch'),
    archiveRoot: join(sandbox, 'app-archive'),
    browseScope: { home: join(sandbox, 'browse-home'), volumes: join(sandbox, 'browse-volumes') },
  }, config)
  token = tokenReader({ services, index, root: registered.value })
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

/** A selection of projects. `[]` is the default board: every project. */
const columns = (projects: string[][]) =>
  services['board.columns']({ rootId: 'soil', projects })

describe('board.columns — one board over many projects', () => {
  it('merges same-named lanes from two projects into one column', () => {
    const urgent = columns([]).filter(column => column.name === 'Urgent')
    expect(urgent).toHaveLength(1)
    // Two contributors — alpha's and beta's — each with its own id.
    expect(urgent[0]?.lanes).toHaveLength(2)
    expect(new Set(urgent[0]?.lanes.map(lane => lane.id)).size).toBe(2)
  })

  it('shows every lane that exists under the scope, from either project', () => {
    expect(columns([]).map(column => column.name))
      .toEqual(['Urgent', 'Next', 'Back Burner'])
  })

  it('scoped to one project, gathers only that one', () => {
    expect(columns([[...ALPHA]]).map(column => column.name)).toEqual(['Urgent', 'Next'])
  })

  it('never gathers a retired op', () => {
    const urgent = columns([[...BETA]]).find(column => column.name === 'Urgent')
    // beta owns exactly one live Urgent. Its archived op owns another, and it must not be here.
    expect(urgent?.lanes).toHaveLength(1)
  })

  it('a scope naming a folder with nothing under it returns no columns, not an error', () => {
    expect(columns([['02-projects', 'alpha', '00-context']])).toEqual([])
  })
})

describe('board.cardsUnder — what is in those columns', () => {
  const cards = (projects: string[][]) =>
    services['board.cardsFor']({ rootId: 'soil', projects })

  it('returns a group for every lane the columns advertise, and no others', () => {
    const advertised = new Set(columns([]).flatMap(c => c.lanes.map(l => l.id)))
    const returned = new Set(cards([]).map(group => group.laneId))
    /**
     * **Set equality, both directions.** A card in a group the columns never mentioned is a card
     * that cannot be dropped anywhere; a column with no group is a lane that always draws empty.
     * The two enumerations must agree exactly, and the only thing making that true is that both go
     * through `placedLanesIn`.
     */
    expect([...returned].sort()).toEqual([...advertised].sort())
  })

  it('puts each project\'s cards under its own lane', () => {
    const urgent = columns([]).find(column => column.name === 'Urgent')
    const beta = urgent?.lanes.find(lane => lane.origin.name === 'beta')
    const group = cards([]).find(g => g.laneId === beta?.id)
    expect(group?.cards.map(card => card.name)).toEqual(['beta-urgent.md'])
  })

  /**
   * **The card tag needs nothing extra on the wire**, and this is the assertion that says so: from a
   * card's lane id the client reaches its lane, and the lane already knows the project. The operator's
   * *"this is part of this op"* is a lookup, not a new field — and a per-card copy would be the same
   * fact stored twice.
   */
  it('lets a card name its project through the lane it is in', () => {
    const all = columns([])
    const laneById = new Map(all.flatMap(c => c.lanes).map(lane => [lane.id, lane]))
    const tagged = cards([]).flatMap(group =>
      group.cards.map(card => `${card.name} -> ${laneById.get(group.laneId)?.origin.name ?? '?'}`))
    expect(tagged.sort()).toEqual([
      'alpha-next.md -> alpha',
      'alpha-urgent.md -> alpha',
      'beta-back.md -> beta',
      'beta-urgent.md -> beta',
    ])
  })

  /**
   * **The scope actually narrows**, asserted because a sweep found nothing checked it: ignoring the
   * scope entirely and gathering the whole root left this suite green. Every other case here asks
   * for `02-projects`, which in this fixture *is* everything — so the parameter that makes a board
   * mean anything was carried and never read.
   */
  it('returns only the scoped project\'s cards, not every project\'s', () => {
    const names = cards([[...ALPHA]]).flatMap(group => group.cards.map(card => card.name)).sort()
    expect(names).toEqual(['alpha-next.md', 'alpha-urgent.md'])
  })

  it('never counts a folder inside a lane as a card', () => {
    const names = cards([[...ALPHA]]).flatMap(group => group.cards.map(card => card.name))
    expect(names).not.toContain('attachments')
    expect(names).toContain('alpha-urgent.md')
  })

  it('never returns a retired op\'s cards', () => {
    const names = cards([]).flatMap(group => group.cards.map(card => card.name))
    expect(names).not.toContain('retired.md')
  })
})

describe('the ids a gathered board mints are the ids a drag resolves', () => {
  /**
   * **THE INTEGRATION THIS FILE IS FOR, AND IT FOUND SOMETHING.**
   *
   * Take a lane id from a *gathered* board — one drawn across two projects — and move a card with
   * it. The first version of this case expected the move to succeed and it does not: it is refused
   * `STALE_TARGET`, because `resolveLaneDestination` derives the project from **the card's own
   * path** and then matches the id against *that* project's lanes. A card in `beta` and a lane id
   * from `alpha` do not match.
   *
   * **The refusal is correct, and the expectation was wrong.** Dragging a task between columns
   * changes its *status*, not its *project*. A merged Urgent column holds alpha's Urgent and beta's
   * Urgent; a beta card dropped there belongs in beta's. Had the server accepted the first id in the
   * column, dragging on a gathered board would silently relocate work between projects — the same
   * silent-wrong-write shape as P8's C1, which moved a folder tree into a folder nobody named.
   *
   * So the guarantee this pins is the safe one: **an id belonging to another project is refused, not
   * reinterpreted.** What remains for the client is choosing *which* of a column's ids to send — the
   * one whose project matches the card's — and the server keeps checking independently. Recorded on
   * the P11 checklist as U1's drag item rather than left as a comment.
   */
  it('refuses a lane id from another project rather than relocating the card', async () => {
    const next = columns([]).find(column => column.name === 'Next')
    // Only alpha has a Next, so this id is guaranteed to be the wrong project for a beta card.
    const alphaNext = next?.lanes[0]?.id
    expect(alphaNext, 'the gathered board minted no Next lane').toBeDefined()

    const card = [...BETA, '02-work', 'tasks', '03-back-burner', 'beta-back.md']
    await expect(services['card.move']({
      rootId: 'soil', card, laneId: alphaNext ?? '', token: await token(card),
    })).rejects.toThrow(/STALE_TARGET/)

    // And nothing moved. A refusal that had already written would be worse than an acceptance.
    await expect(fsp.stat(join(rootPath, ...card))).resolves.toBeDefined()
  })

  it('moves a card using the id from its OWN project inside a merged column', async () => {
    // The merged Urgent column carries both projects' lanes. The one a beta card may use is beta's,
    // and picking it is the client's job — proven here at the layer that has to accept it.
    const urgent = columns([]).find(column => column.name === 'Urgent')
    const betaUrgent = services['board.lanes']({ rootId: 'soil', project: [...BETA] })
      .find(lane => lane.name === 'Urgent')?.id
    expect(urgent?.lanes.map(lane => lane.id)).toContain(betaUrgent)

    const card = [...BETA, '02-work', 'tasks', '03-back-burner', 'beta-back.md']
    const moved = await services['card.move']({
      rootId: 'soil', card, laneId: betaUrgent ?? '', token: await token(card),
    })
    expect(moved.to.slice(0, -1)).toEqual([...BETA, '02-work', 'tasks', '01-urgent'])
    await expect(fsp.stat(join(rootPath, ...moved.to))).resolves.toBeDefined()
  })

  it('an id from a gathered board is byte-identical to the one the single-project board mints', () => {
    const gathered = columns([])
      .find(column => column.name === 'Next')?.lanes.map(lane => lane.id) ?? []
    const single = services['board.lanes']({ rootId: 'soil', project: [...ALPHA] })
      .find(lane => lane.name === 'Next')?.id
    expect(single).toBeDefined()
    /**
     * Asserted rather than assumed, because "the same digest" is what makes every refusal in
     * §13.7 apply to the new board for free. Two mints that merely *usually* agree would be two
     * implementations, and this build has a file's worth of notes on what that costs.
     */
    expect(gathered).toContain(single)
  })
})
