import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { laneIdFor, resolveLaneDestination } from '../../src/core/board'
import { ErrorCode, refusalCodeOf } from '../../src/core/errors'
import { IndexStore } from '../../src/core/index-store'
import { indexRegisteredRoot } from '../../src/core/indexer'
import { loadConfigService } from '../../src/server/config-service'
import { createRootRegistry } from '../../src/server/root-registry'
import { createServices, type Services } from '../../src/server/services'
import { tokenReader } from '../support/entry-tokens'

/**
 * A card dragged to a lane. Spec §3 and §13.7's M2 — **the ghost-lane bug**.
 *
 * *"The move-mkdir exception resurrects folders an agent deliberately removed. A lane drag is a
 * move, and the destination lane was a client-supplied string — so a stale board plus a renamed
 * lane materializes a ghost lane. Since folders **are** the database, that is structural
 * corruption."*
 *
 * Everything here is about one property: **there is no request that creates a folder.** Not a
 * crafted one, not a stale one, not an honest one racing a rename.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree per test.
 */
let sandbox: string
let rootPath: string
let services: Services
let token: (segments: readonly string[]) => Promise<string>
let index: IndexStore
let caseInsensitive: boolean

const PROJECT = ['02-projects', 'cider-line']
const TASKS = [...PROJECT, 'tasks']

const reindex = async (): Promise<void> => {
  const registry = registryRef
  const root = registry?.get('soil')
  if (root === undefined) throw new Error('no root')
  index.clearRoot('soil')
  await indexRegisteredRoot(root, index)
}

let registryRef: ReturnType<typeof createRootRegistry> | null = null

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-board-'))
  rootPath = join(sandbox, 'root')

  await fsp.mkdir(join(rootPath, ...TASKS, '01-urgent'), { recursive: true })
  await fsp.mkdir(join(rootPath, ...TASKS, '02-next'), { recursive: true })
  await fsp.mkdir(join(rootPath, ...TASKS, '04-done'), { recursive: true })
  await fsp.writeFile(join(rootPath, ...TASKS, '02-next', 'press-service.md'), '# Press service\n')
  await fsp.writeFile(join(rootPath, ...TASKS, 'loose-note.md'), '# Loose note\n')
  await fsp.mkdir(join(rootPath, ...PROJECT, '00-context'), { recursive: true })

  const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  registryRef = registry
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)
  caseInsensitive = registered.value.caseInsensitive

  index = new IndexStore()
  await indexRegisteredRoot(registered.value, index)

  const config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })
  services = createServices(registry, index, {
    stagingRoot: join(sandbox, 'app-scratch'),
    archiveRoot: join(sandbox, 'app-archive'),
      // §11's browsable area, pointed INSIDE this test's sandbox. Never the real home directory:
      // these suites are not about browsing, and a scope that reached `$HOME` would make an
      // unrelated test capable of listing the user's disk.
      browseScope: { home: join(sandbox, 'browse-home'), volumes: join(sandbox, 'browse-volumes') },
  }, config)
  token = tokenReader({ services, index, root: registered.value })
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const lanes = () => services['board.lanes']({ rootId: 'soil', project: PROJECT })
const laneNamed = (name: string): string => {
  const found = lanes().find(lane => lane.name === name)
  if (found === undefined) throw new Error(`no lane called ${name}: ${lanes().map(l => l.name).join(', ')}`)
  return found.id
}
const onDisk = () => fsp.readdir(join(rootPath, ...TASKS))

describe('the lanes a board can offer', () => {
  it('lists the real lanes in §3 order, with Uncategorized leftmost', () => {
    // "order follows the numeric prefix, then alphabetical", and display strips the prefix.
    expect(lanes().map(lane => lane.name)).toEqual(['Uncategorized', 'Urgent', 'Next', 'Done'])
  })

  it('hides Uncategorized when nothing is in it — §3', async () => {
    await fsp.rm(join(rootPath, ...TASKS, 'loose-note.md'))
    await reindex()
    expect(lanes().map(lane => lane.name)).toEqual(['Urgent', 'Next', 'Done'])
  })

  it('offers NO PATH the client could reuse', () => {
    /**
     * The id is a digest, and this asserts the thing the digest exists for: nothing in the payload
     * can be turned back into a destination. §13.7's whole M2 fix is that the client names an id
     * rather than a place.
     */
    const payload = JSON.stringify(lanes())
    expect(payload).not.toContain('02-next')
    expect(payload).not.toContain('tasks')
    expect(payload).not.toContain(sandbox)
  })

  it('gives a lane the same id every time, and different lanes different ids', () => {
    expect(laneNamed('Next')).toBe(laneNamed('Next'))
    expect(new Set(lanes().map(lane => lane.id)).size).toBe(lanes().length)
  })
})

describe('moving a card by lane id', () => {
  it('THE ONE THAT MATTERS: the card lands in the lane, and no folder was created', async () => {
    const before = (await onDisk()).sort()

    const moved = await services['card.move']({
      rootId: 'soil',
      card: [...TASKS, '02-next', 'press-service.md'],
      laneId: laneNamed('Done'),
      token: await token([...TASKS, '02-next', 'press-service.md']),
    })

    expect(moved.to).toEqual([...TASKS, '04-done', 'press-service.md'])
    expect(moved.lane.name).toBe('Done')
    expect(await fsp.readFile(join(rootPath, ...moved.to), 'utf8')).toBe('# Press service\n')
    expect((await onDisk()).sort(), 'the set of lanes on disk is unchanged').toEqual(before)
  })

  it('moves a card OUT of Uncategorized into a real lane', async () => {
    // §3: "dragging a card out of Uncategorized moves the file into that lane's real folder."
    const moved = await services['card.move']({
      rootId: 'soil', card: [...TASKS, 'loose-note.md'], laneId: laneNamed('Urgent'),
      token: await token([...TASKS, 'loose-note.md']),
    })
    expect(moved.to).toEqual([...TASKS, '01-urgent', 'loose-note.md'])
  })

  it('moves a card INTO Uncategorized, which is never a folder', async () => {
    // §3: "dragging a card into Uncategorized moves the file up to the tasks folder root." The
    // absence of a lane folder is itself the state.
    const moved = await services['card.move']({
      rootId: 'soil',
      card: [...TASKS, '02-next', 'press-service.md'],
      laneId: laneNamed('Uncategorized'),
      token: await token([...TASKS, '02-next', 'press-service.md']),
    })
    expect(moved.to).toEqual([...TASKS, 'press-service.md'])
    expect(await onDisk()).not.toContain('__uncategorized__')
  })

  it('refuses rather than replacing a file already at the destination — §13.6', async () => {
    await fsp.writeFile(join(rootPath, ...TASKS, '04-done', 'press-service.md'), 'do not destroy\n')
    await reindex()

    await expect(services['card.move']({
      rootId: 'soil',
      card: [...TASKS, '02-next', 'press-service.md'],
      laneId: laneNamed('Done'),
      // A VALID token. The refusal under test is §13.6's — the destination is occupied — and a
      // stale token here would make the test pass for the wrong reason, which is the failure mode
      // this whole phase keeps finding.
      token: await token([...TASKS, '02-next', 'press-service.md']),
    })).rejects.toThrow()

    expect(await fsp.readFile(join(rootPath, ...TASKS, '04-done', 'press-service.md'), 'utf8'))
      .toBe('do not destroy\n')
  })
})

describe('THE GHOST LANE CANNOT BE CREATED — §13.7 M2', () => {
  it('THE ONE THAT MATTERS: a stale board naming a removed lane is refused, not obeyed', async () => {
    /**
     * The bug, exactly. The board is drawn, an agent removes the lane folder, and the drop lands.
     * v1 would have `mkdir -p`'d the destination and **resurrected a folder the agent deliberately
     * removed** — and since folders are the database, that is structural corruption rather than an
     * inconvenience.
     */
    const staleId = laneNamed('Done')
    await fsp.rm(join(rootPath, ...TASKS, '04-done'), { recursive: true, force: true })
    await reindex()

    await expect(services['card.move']({
      rootId: 'soil', card: [...TASKS, '02-next', 'press-service.md'], laneId: staleId,
      token: await token([...TASKS, '02-next', 'press-service.md']),
    })).rejects.toThrow(/no longer on this board/)

    expect(await onDisk(), 'the lane an agent removed stays removed').not.toContain('04-done')
    expect(
      await fsp.readFile(join(rootPath, ...TASKS, '02-next', 'press-service.md'), 'utf8'),
      'and the card did not move anywhere',
    ).toBe('# Press service\n')
  })

  it('refuses a lane id the client invented', async () => {
    // There is no string that resolves to a directory which is not currently a lane. An id that was
    // never minted matches nothing enumerated.
    await expect(services['card.move']({
      rootId: 'soil', card: [...TASKS, '02-next', 'press-service.md'], laneId: 'f'.repeat(32),
      token: await token([...TASKS, '02-next', 'press-service.md']),
    })).rejects.toThrow(/no longer on this board/)
  })

  /**
   * **TWO TASKS FOLDERS, ONE PROJECT.** The security review's P9-1, as a test rather than as a paragraph.
   *
   * The project keeps its real board at `02-work/tasks` and also has a shallower `tasks/` with a
   * lane of the *same name*. Before the fix both produced one id, so a drop onto the lane the card
   * was already in resolved into the other folder and moved the file. The card here starts in
   * `02-work/tasks/01-urgent`; the shallower folder is the one `tasksDirOf` picks, which is what
   * made the collision reachable.
   */
  it('mints different ids for same-named lanes in two different tasks folders', async () => {
    const deep = [...PROJECT, '02-work', 'tasks']
    await fsp.mkdir(join(rootPath, ...deep, '01-urgent'), { recursive: true })
    await fsp.writeFile(join(rootPath, ...deep, '01-urgent', 'gasket.md'), '# Gasket\n')
    await reindex()

    const shallow = laneIdFor('soil', PROJECT, TASKS, '01-urgent', caseInsensitive)
    const deeper = laneIdFor('soil', PROJECT, deep, '01-urgent', caseInsensitive)
    expect(shallow, 'the same lane name in two tasks folders must not share an id')
      .not.toBe(deeper)

    /**
     * And the id belonging to the folder the board was NOT drawn from is refused rather than
     * resolved — a client holding it gets §13.7's refusal instead of a file moved to the other
     * folder.
     *
     * **Which id that is flipped with ruled 2026-08-12.** `tasksDirOf` used to take the
     * shallowest, making `deeper` the stale one; it now takes the **template's** folder, which is
     * `02-work/tasks` — so `shallow`, the stray `tasks/` beside it, is the stale one. The property
     * under test is unchanged and it is the one that matters: exactly one id resolves, and the other
     * is refused rather than reinterpreted.
     */
    const resolved = resolveLaneDestination(
      index, 'soil', [...TASKS, '01-urgent', 'gasket.md'], shallow, caseInsensitive,
    )
    expect(resolved.ok, 'an id from the folder the board was not drawn from must not resolve')
      .toBe(false)

    /**
     * And the *control*: the id the board actually mints does resolve. Without this the assertion
     * above would pass just as happily against a `resolveLaneDestination` that refused everything —
     * the shape of pass this suite has caught before.
     */
    const drawn = resolveLaneDestination(
      index, 'soil', [...deep, '01-urgent', 'gasket.md'], deeper, caseInsensitive,
    )
    expect(drawn.ok, 'the lane the board WAS drawn from still resolves').toBe(true)
  })

  /**
   * **Two tasks folders at EQUAL depth.** The security review's P9-7.
   *
   * `tasksDirOf` takes the shallowest, and at equal depth the old test was false both ways — so the
   * winner was whichever the index's Map happened to yield first, and the board could be drawn from
   * a different folder between two identical requests. One project in the user's soil is shaped like
   * this today.
   *
   * The tie is now broken by `comparisonKey`, so `01-notes/tasks` wins over `02-work/tasks`.
   * Asserted **twice** rather than once: a single call cannot tell a deterministic rule from a lucky
   * iteration order, which is the whole complaint.
   */
  it('breaks an equal-depth tie deterministically, not by index order', async () => {
    /**
     * A project of its own, because `cider-line` already has a `tasks/` one level up from these
     * two — and the shallowest wins outright, so a tie never arises there. The first version of
     * this test put both folders under `cider-line` and proved nothing about ties at all.
     */
    /**
     * **Neither of these is the template's folder**, deliberately, and that changed with the operator's
     * ruling of 2026-08-12. `02-work/tasks` now wins outright wherever it exists, so a fixture using
     * it would be testing the template rule rather than the tie-break. Two equal-depth folders that
     * are *both* non-compliant is the only shape where a tie still arises — and the tie-break still
     * has to be deterministic, because P9-7 recorded what Map order costs when it is not.
     */
    const own = ['02-projects', 'cold-store']
    const early = [...own, '01-notes', 'tasks']
    const late = [...own, '03-scratch', 'tasks']
    await fsp.mkdir(join(rootPath, ...early, '01-urgent'), { recursive: true })
    await fsp.mkdir(join(rootPath, ...late, '01-urgent'), { recursive: true })
    await fsp.writeFile(join(rootPath, ...early, 'note.md'), '# Note\n')
    await reindex()

    const earlyId = laneIdFor('soil', own, early, '01-urgent', caseInsensitive)
    const lateId = laneIdFor('soil', own, late, '01-urgent', caseInsensitive)
    const card = [...early, 'note.md']

    for (const attempt of [1, 2]) {
      expect(
        resolveLaneDestination(index, 'soil', card, earlyId, caseInsensitive).ok,
        `attempt ${attempt}: the lower comparison key owns the board`,
      ).toBe(true)
      expect(
        resolveLaneDestination(index, 'soil', card, lateId, caseInsensitive).ok,
        `attempt ${attempt}: the other folder's id is refused, every time`,
      ).toBe(false)
    }
  })

  it('refuses an id minted for a DIFFERENT project', async () => {
    /**
     * The id is a digest over `(rootId, project, tasksDir, lane)` and not over the lane name alone,
     * so an id from another project's board cannot be replayed against this one. Two projects both
     * having a `02-next` is the normal case in this tree, not an exotic one.
     *
     * The tasks directory joined the digest at the security review's P9-1: without it, one id addressed two
     * folders whenever a project owned more than one `tasks`.
     */
    const other = ['02-projects', 'cold-store']
    await fsp.mkdir(join(rootPath, ...other, 'tasks', '02-next'), { recursive: true })
    await reindex()

    const otherId = laneIdFor('soil', other, [...other, 'tasks'], '02-next', caseInsensitive)
    await expect(services['card.move']({
      rootId: 'soil', card: [...TASKS, 'loose-note.md'], laneId: otherId,
      token: await token([...TASKS, 'loose-note.md']),
    })).rejects.toThrow(/no longer on this board/)
  })

  it('refuses a file that is not a card at all', async () => {
    await fsp.writeFile(join(rootPath, ...PROJECT, '00-context', 'context.md'), '# Context\n')
    await reindex()

    await expect(services['card.move']({
      rootId: 'soil', card: [...PROJECT, '00-context', 'context.md'], laneId: laneNamed('Done'),
      token: await token([...PROJECT, '00-context', 'context.md']),
    })).rejects.toThrow(/not a card/)
  })

  it('refuses when the lane disappears BETWEEN the check and the move', async () => {
    /**
     * The resolve happens twice — once cheaply outside the lock, once inside it — and only the
     * second one is the control. Without it, a board that was current when the request arrived and
     * stale by the time the lock was taken would move a card into a folder that had just been
     * removed, which is M2 arriving through a race instead of through staleness.
     *
     * Staged by removing the lane from the index between the two resolves, which is what a
     * reconcile triggered by the agent's own delete does.
     */
    const laneId = laneNamed('Done')
    const real = index.childrenOf.bind(index)

    /**
     * **The first resolve must SUCCEED or this test proves nothing.**
     *
     * The first version hard-coded "let four lookups through", which was one too many at the time —
     * the refusal came from the cheap pre-check and the re-resolve was never reached. Same error
     * message, same green, wrong reason. It then broke again when the resolve was simplified to
     * fewer lookups, which is the tell that a magic number was standing in for a fact.
     *
     * So the number is **measured**, by running one resolve and counting. The lane vanishes from
     * the call after that, and `callsMade` is asserted below to prove the second resolve ran at all.
     */
    let callsMade = 0
    const counting = ((rootId: string, segments: readonly string[]) => {
      callsMade++
      return real(rootId, segments)
    }) as typeof index.childrenOf

    index.childrenOf = counting
    const dryRun = resolveLaneDestination(index, 'soil', [...TASKS, '02-next', 'press-service.md'],
      laneId, caseInsensitive)
    expect(dryRun.ok, 'the lane is resolvable before the race is staged').toBe(true)
    const oneResolve = callsMade
    callsMade = 0

    index.childrenOf = ((rootId: string, segments: readonly string[]) => {
      callsMade++
      return callsMade > oneResolve
        ? real(rootId, segments).filter(entry => entry.name !== '04-done')
        : real(rootId, segments)
    }) as typeof index.childrenOf

    try {
      await expect(services['card.move']({
        rootId: 'soil', card: [...TASKS, '02-next', 'press-service.md'], laneId,
        token: await token([...TASKS, '02-next', 'press-service.md']),
      })).rejects.toThrow(/no longer on this board/)
      expect(
        callsMade,
        'the first resolve succeeded and the one inside the lock is what refused',
      ).toBeGreaterThan(oneResolve)
    } finally {
      index.childrenOf = real
    }

    expect(
      await fsp.readFile(join(rootPath, ...TASKS, '02-next', 'press-service.md'), 'utf8'),
      'the card stayed where it was',
    ).toBe('# Press service\n')
  })
})

/**
 * §13.8 ON THE BOARD, and this block exists because a mutation sweep asked for it.
 *
 * When the identity token was added to the four mutation verbs, the sweep deleted each check in
 * turn to see what went red. `entry.rename`, `entry.copy` and `conflict.resolve` all did.
 * **`card.move`'s check did not** — every test in this file sent a valid token, so removing the
 * check entirely left the suite green.
 *
 * That is F1's finding reproduced inside the fix for F1: a control placed correctly, and a suite
 * shaped so it cannot see whether the control is there. The board is also where it bites hardest —
 * a card row is a file, and a move is a rename.
 */
describe('§13.8 — a card that changed underneath the board is not moved', () => {
  it('an agent replaces the card file, and the drop refuses instead of moving the wrong file', async () => {
    const card = [...TASKS, '02-next', 'press-service.md']
    const shown = await token(card)

    // The agent's replacement: same path, new inode.
    await fsp.unlink(join(rootPath, ...card))
    await fsp.writeFile(join(rootPath, ...card), '# A different task entirely\n')

    await expect(services['card.move']({
      rootId: 'soil', card, laneId: laneNamed('Done'), token: shown,
    })).rejects.toSatisfy(thrown => refusalCodeOf(thrown) === ErrorCode.STALE_TARGET)

    // The agent's file is still in the lane the agent left it in.
    expect((await fsp.lstat(join(rootPath, ...card))).isFile()).toBe(true)
    await expect(fsp.lstat(join(rootPath, ...TASKS, '04-done', 'press-service.md')))
      .rejects.toThrow()
  })

  it('refuses a token that never came from this server', async () => {
    const card = [...TASKS, '02-next', 'press-service.md']
    await expect(services['card.move']({
      rootId: 'soil', card, laneId: laneNamed('Done'), token: 'AAAAAAAAAAAAAAAAAAAAAA',
    })).rejects.toSatisfy(thrown => refusalCodeOf(thrown) === ErrorCode.STALE_TARGET)
    expect((await fsp.lstat(join(rootPath, ...card))).isFile()).toBe(true)
  })
})

/**
 * **ARCHIVE IS NOT A LANE.** PRD: *"`archive/` content excluded everywhere."*
 *
 * `isArchived` has existed in the grammar since P1 and is imported by **tests only** — no product
 * module calls it. So a project with `tasks/archive/`, which is the shape `project-template` ships,
 * grows an "Archive" column on the board, and every task ever archived reappears on it as a live
 * card that can be dragged back out.
 */
describe('archive is excluded from the board', () => {
  it('does not offer an archived folder as a lane', async () => {
    await fsp.mkdir(join(rootPath, ...TASKS, 'archive'), { recursive: true })
    await fsp.writeFile(join(rootPath, ...TASKS, 'archive', 'finished.md'), '# Finished\n')
    await reindex()

    const lanes = services['board.lanes']({ rootId: 'soil', project: [...PROJECT] })
    expect(lanes.map(lane => lane.name)).not.toContain('Archive')
  })
})

/**
 * **THE CARDS.** `board.lanes` says which columns exist; nothing said what was in them, so no client
 * could paint a board. Both projections come out of one enumeration on purpose: a card whose lane id
 * resolved to nothing would be a card that cannot be dropped anywhere.
 */
describe('board.cards', () => {
  const laneNamed = (name: string) =>
    services['board.lanes']({ rootId: 'soil', project: [...PROJECT] })
      .find(lane => lane.name === name)

  it('groups the cards under the lane they are in', async () => {
    const cards = services['board.cards']({ rootId: 'soil', project: [...PROJECT] })
    const next = cards.find(group => group.laneId === laneNamed('Next')?.id)
    expect(next?.cards.map(card => card.name)).toEqual(['press-service.md'])
  })

  /** §3: the absence of a lane folder IS the state. A loose file in `tasks/` is Uncategorized. */
  it('puts a file sitting directly in tasks into Uncategorized', () => {
    const cards = services['board.cards']({ rootId: 'soil', project: [...PROJECT] })
    const loose = cards.find(group => group.laneId === laneNamed('Uncategorized')?.id)
    expect(loose?.cards.map(card => card.name)).toEqual(['loose-note.md'])
  })

  it('reports an empty lane as empty rather than omitting it', () => {
    const cards = services['board.cards']({ rootId: 'soil', project: [...PROJECT] })
    const urgent = cards.find(group => group.laneId === laneNamed('Urgent')?.id)
    expect(urgent).toBeDefined()
    expect(urgent?.cards).toEqual([])
  })

  /** A directory inside a lane is not a task and its contents are not tasks. */
  it('does not treat a folder inside a lane as a card', async () => {
    await fsp.mkdir(join(rootPath, ...TASKS, '02-next', 'attachments'), { recursive: true })
    await fsp.writeFile(join(rootPath, ...TASKS, '02-next', 'attachments', 'a.md'), '# a\n')
    await reindex()

    const cards = services['board.cards']({ rootId: 'soil', project: [...PROJECT] })
    const next = cards.find(group => group.laneId === laneNamed('Next')?.id)
    expect(next?.cards.map(card => card.name)).toEqual(['press-service.md'])
  })

  /** PRD: archive is excluded everywhere. Its cards go with its lane. */
  it('shows nothing from an archive', async () => {
    await fsp.mkdir(join(rootPath, ...TASKS, 'archive'), { recursive: true })
    await fsp.writeFile(join(rootPath, ...TASKS, 'archive', 'finished.md'), '# Finished\n')
    await reindex()

    const cards = services['board.cards']({ rootId: 'soil', project: [...PROJECT] })
    const names = cards.flatMap(group => group.cards.map(card => card.name))
    expect(names).not.toContain('finished.md')
  })

  /**
   * **Every lane id here must be one `board.lanes` reported.** The two routes are separate calls
   * and a client holds ids from one while drawing the other; if they could disagree, a card would
   * sit in a column the board cannot drop into.
   */
  it('uses exactly the lane ids board.lanes reports', () => {
    const lanes = services['board.lanes']({ rootId: 'soil', project: [...PROJECT] })
    const cards = services['board.cards']({ rootId: 'soil', project: [...PROJECT] })
    expect(cards.map(group => group.laneId)).toEqual(lanes.map(lane => lane.id))
  })
})

/**
 * **EVERY PROJECT, READ OFF THE INDEX.** PRD: *"every project in the tree at a glance… no curation
 * required."* §3: projects are resolved at walk time, never from a stored glob — so a project made
 * this morning is listed this morning.
 */
describe('projects.list', () => {
  it('finds a project by the path grammar alone', () => {
    const projects = services['projects.list']()
    expect(projects.map(p => p.name)).toContain('cider-line')
  })

  it('carries the path above it, for the breadcrumb tag', () => {
    const found = services['projects.list']().find(p => p.name === 'cider-line')
    expect(found?.parentPath).toEqual(['02-projects'])
  })

  /**
   * **A nested project is a project.** The soil nests them — an op lives at
   * `02-projects/<project>/02-work/projects/<op>` — and the PRD asks for *every* project with the
   * nesting shown rather than flattened away. Listing only the top level would hide most of the
   * real tree.
   */
  it('includes a project nested inside another project', async () => {
    await fsp.mkdir(
      join(rootPath, ...PROJECT, '02-work', 'projects', 'op-harvest'), { recursive: true },
    )
    await reindex()

    const projects = services['projects.list']()
    const nested = projects.find(p => p.name === 'op-harvest')
    expect(nested).toBeDefined()
    expect(nested?.parentPath).toEqual([...PROJECT, '02-work', 'projects'])
  })

  /**
   * Shallowest first, and **the fixture is chosen so depth and alphabet disagree.**
   *
   * The first version of this test created only `cider-line` and its nested `op-harvest`, whose
   * paths happen to sort into depth order alphabetically too — so removing the depth comparator
   * entirely left the test green. `zebra-line` sits at depth 2 and sorts *after* the depth-5 nested
   * project, so only a real depth comparison puts it first.
   */
  it('lists shallower projects before deeper ones', async () => {
    await fsp.mkdir(
      join(rootPath, ...PROJECT, '02-work', 'projects', 'op-harvest'), { recursive: true },
    )
    await fsp.mkdir(join(rootPath, '02-projects', 'zebra-line'), { recursive: true })
    await reindex()

    const projects = services['projects.list']()
    const names = projects.map(p => p.name)
    expect(names.indexOf('zebra-line')).toBeLessThan(names.indexOf('op-harvest'))
  })

  /**
   * §3 again: archived subtrees are out of every derived live set.
   *
   * **The fixture is a project literally NAMED `archive`, and that is the only shape that reaches
   * this filter.** The first version made `02-projects/archive/old-line` and asserted `old-line`
   * was absent — which it was, but for the wrong reason: its parent is not a project root, so the
   * grammar had already excluded it and the archive filter never ran. A folder called `archive`
   * sitting under `02-projects` *is* a project by the grammar, and without the filter it appears on
   * the board as a project called "archive" holding everything retired.
   */
  it('excludes a project that is itself an archive', async () => {
    await fsp.mkdir(join(rootPath, '02-projects', 'archive'), { recursive: true })
    await reindex()

    expect(services['projects.list']().map(p => p.name)).not.toContain('archive')
  })

  /** A folder that is not under a projects root is not a project, however it is named. */
  it('does not invent a project from an ordinary folder', () => {
    expect(services['projects.list']().map(p => p.name)).not.toContain('00-context')
  })
})

/**
 * **THE TASKS FOLDER IS AT `02-work/tasks`, NOT DIRECTLY UNDER THE PROJECT.**
 *
 * That is the shape of every project in the real soil and in the mock — `project-template` ships
 * `02-work/{objectives, projects, tasks}` — and `board.ts` looked for `tasks` among the project's
 * **immediate children** only. So `lanesOf` returned nothing and the Tasks tab said *"this project
 * has no tasks folder yet"* for a project with six lanes and fourteen cards in it.
 *
 * **The fixtures in this file agreed with the bug.** Every one of them puts `tasks` directly under
 * the project, which is a shape that does not occur — so the board was proven against a tree the
 * app will never see. Found by pointing the real UI at the mock soil, which is the first time
 * anything had.
 *
 * The grammar was right the whole time: `lanePlacementOf` resolves a card's project with
 * `enclosingProject`, which walks up past `02-work`. Only the board's own lookup was shallow.
 */
describe('a project whose tasks folder is nested, which is every real one', () => {
  const NESTED = ['02-projects', 'orchard-ops']
  const NESTED_TASKS = [...NESTED, '02-work', 'tasks']

  beforeEach(async () => {
    await fsp.mkdir(join(rootPath, ...NESTED_TASKS, '02-next'), { recursive: true })
    await fsp.mkdir(join(rootPath, ...NESTED_TASKS, '04-done'), { recursive: true })
    await fsp.writeFile(join(rootPath, ...NESTED_TASKS, '02-next', 'pick-crew.md'), '# Pick crew\n')
    await reindex()
  })

  it('finds the lanes', () => {
    const lanes = services['board.lanes']({ rootId: 'soil', project: [...NESTED] })
    expect(lanes.map(lane => lane.name)).toEqual(['Next', 'Done'])
  })

  it('finds the cards', () => {
    const lanes = services['board.lanes']({ rootId: 'soil', project: [...NESTED] })
    const cards = services['board.cards']({ rootId: 'soil', project: [...NESTED] })
    const next = cards.find(group => group.laneId === lanes[0]?.id)
    expect(next?.cards.map(card => card.name)).toEqual(['pick-crew.md'])
  })

  /**
   * **A nested project's tasks folder belongs to the nested project, not the one above it.**
   *
   * An op lives at `<project>/02-work/projects/<op>` and has its own `02-work/tasks`. A lookup that
   * merely searched the subtree for any folder called `tasks` would hand the outer project the
   * inner one's board — which is the failure mode of fixing the shallow lookup carelessly.
   */
  it('does not claim a nested project\'s tasks folder as its own', async () => {
    const OP = [...NESTED, '02-work', 'projects', 'op-harvest']
    await fsp.mkdir(join(rootPath, ...OP, '02-work', 'tasks', '01-urgent'), { recursive: true })
    await fsp.writeFile(
      join(rootPath, ...OP, '02-work', 'tasks', '01-urgent', 'hire.md'), '# Hire\n',
    )
    await reindex()

    const outer = services['board.cards']({ rootId: 'soil', project: [...NESTED] })
    expect(outer.flatMap(group => group.cards.map(card => card.name))).not.toContain('hire.md')

    const inner = services['board.cards']({ rootId: 'soil', project: [...OP] })
    expect(inner.flatMap(group => group.cards.map(card => card.name))).toContain('hire.md')
  })
})

/**
 * The two cases the nested-tasks tests above do **not** discriminate, found by the sweep: with the
 * fixtures they use, dropping either half of the lookup left every test green.
 */
describe('which tasks folder belongs to which project', () => {
  const OUTER = ['02-projects', 'holding-co']
  const INNER = [...OUTER, '02-work', 'projects', 'op-inner']

  /**
   * **The ownership check, isolated.** The outer project has no tasks folder of its own; only the
   * op inside it does. Without the check, a subtree search finds the op's and hands the outer
   * project a board of somebody else's tasks — and there is nothing on screen to say so.
   */
  it('gives a project with no tasks folder no board, even when one inside it has one', async () => {
    await fsp.mkdir(join(rootPath, ...OUTER, '00-context'), { recursive: true })
    await fsp.mkdir(
      join(rootPath, ...INNER, '02-work', 'tasks', '02-next'), { recursive: true },
    )
    await fsp.writeFile(
      join(rootPath, ...INNER, '02-work', 'tasks', '02-next', 'inner-task.md'), '# Inner\n',
    )
    await reindex()

    expect(services['board.lanes']({ rootId: 'soil', project: [...OUTER] })).toEqual([])
    expect(services['board.lanes']({ rootId: 'soil', project: [...INNER] }).length)
      .toBeGreaterThan(0)
  })

  /**
   * **Shallowest wins, isolated.** A project can own two folders called `tasks` — `tasks/` at its
   * root and `02-work/tasks/` — which is what a half-finished migration looks like. The index is a
   * map, so without an explicit choice the board would pick whichever came out of iteration first
   * and could pick differently between two identical requests.
   */
  /**
   * **REVERSED BY THE RULING, 2026-08-12.** This case used to assert shallowest-wins, and it
   * now asserts the opposite, because the template's folder is the deeper one.
   *
   * Their words: *"work and then tasks, in my mind, is how it is set up in the templates. Just follow
   * whatever is in the templates."* Depth was resolving to a stray `tasks/` in a project root and
   * ignoring the compliant `02-work/tasks` — and the security review's C3 found the consequence from the other
   * end: the board drew lanes from both folders, every drop was refused `STALE_TARGET`, and the
   * obvious repair moved the file into the other folder.
   *
   * Kept as one case rather than replaced, so the reversal is visible: same fixture, opposite
   * expectation, with the reason attached.
   */
  it('picks the TEMPLATE tasks folder when a project owns two, not the shallowest', async () => {
    await fsp.mkdir(join(rootPath, ...OUTER, 'tasks', '01-urgent'), { recursive: true })
    await fsp.writeFile(join(rootPath, ...OUTER, 'tasks', '01-urgent', 'shallow.md'), '# S\n')
    await fsp.mkdir(join(rootPath, ...OUTER, '02-work', 'tasks', '04-done'), { recursive: true })
    await fsp.writeFile(
      join(rootPath, ...OUTER, '02-work', 'tasks', '04-done', 'deep.md'), '# D\n',
    )
    await reindex()

    const names = services['board.cards']({ rootId: 'soil', project: [...OUTER] })
      .flatMap(group => group.cards.map(card => card.name))
    // `02-work/tasks` is the template's, and it is DEEPER than the stray `tasks/` beside it.
    expect(names).toContain('deep.md')
    expect(names).not.toContain('shallow.md')
  })
})

/**
 * **QUICK-ADD: a task born in a lane.** PRD's Tasks tab, and the second writer on this board.
 *
 * > *"every lane carries a quick-add at its bottom. Creation-is-placement embodied: standing in a
 * > project's tasks on the board, a task added at the bottom of a lane is born in that lane's
 * > actual folder — project and status already known from where you're standing, nothing to choose
 * > but the name."*
 *
 * It is in this file rather than a new one because it is the **same subject**: M2 says a client
 * must never name a lane's path, and a create is the case where obeying an invented path would
 * leave a folder behind rather than merely move a file into one. Both writers go through
 * `resolveLaneFolder`, so the refusals below are the refusals above, proven again on the verb that
 * can actually build something.
 */
describe('adding a task to a lane', () => {
  it('THE ONE THAT MATTERS: it lands in the lane, and no folder was created', async () => {
    const before = (await onDisk()).sort()

    const made = await services['card.create']({
      rootId: 'soil', project: PROJECT, laneId: laneNamed('Urgent'), name: 'Replace the belt',
    })

    expect(made.segments).toEqual([...TASKS, '01-urgent', 'replace-the-belt.md'])
    expect(made.lane.name).toBe('Urgent')
    expect(await fsp.readdir(join(rootPath, ...TASKS, '01-urgent')))
      .toEqual(['replace-the-belt.md'])
    // The lane set is untouched: a create reaches an existing folder or it refuses.
    expect((await onDisk()).sort()).toEqual(before)
  })

  it('slugifies on the server and keeps what was typed as the heading — §13.6, A5', async () => {
    const made = await services['card.create']({
      rootId: 'soil', project: PROJECT, laneId: laneNamed('Next'), name: 'Order  New  Filters!',
    })

    // The name is the slug...
    expect(made.segments[made.segments.length - 1]).toBe('order-new-filters.md')
    // ...and the title the board will draw is the person's own capitalisation and spacing, because
    // `title.ts` reads the first heading. A card titled `order-new-filters` would be the app
    // showing them its filename instead of their words.
    expect(await fsp.readFile(join(rootPath, ...TASKS, '02-next', 'order-new-filters.md'), 'utf8'))
      .toBe('# Order  New  Filters!\n')
  })

  it('adds to Uncategorized by putting the file in the tasks folder itself', async () => {
    const made = await services['card.create']({
      rootId: 'soil', project: PROJECT, laneId: laneNamed('Uncategorized'), name: 'Stray thought',
    })

    // Uncategorized is not a folder — §3 — so there is nothing to create for it, and the synthetic
    // lane resolves to `tasks/` itself. A lane that had to be materialised first would be M2.
    expect(made.segments).toEqual([...TASKS, 'stray-thought.md'])
    expect(await onDisk()).not.toContain('__uncategorized__')
  })

  it('THE GHOST LANE, on the verb that could actually build one', async () => {
    /**
     * The strongest version of M2 in this file. A move into a removed lane leaves the card where it
     * was; a **create** into a removed lane, if the path were obeyed, would resurrect the folder
     * *and* put a file in it — an agent's deliberate deletion undone by someone typing a task name.
     */
    const staleId = laneNamed('Done')
    await fsp.rm(join(rootPath, ...TASKS, '04-done'), { recursive: true, force: true })
    await reindex()

    await expect(services['card.create']({
      rootId: 'soil', project: PROJECT, laneId: staleId, name: 'Too late',
    })).rejects.toThrow(/no longer on this board/)

    expect(await onDisk(), 'the lane an agent removed stays removed').not.toContain('04-done')
  })

  it('refuses a lane id the client invented, and writes nothing', async () => {
    const before = (await onDisk()).sort()
    await expect(services['card.create']({
      rootId: 'soil', project: PROJECT, laneId: 'f'.repeat(32), name: 'Nowhere',
    })).rejects.toThrow(/no longer on this board/)
    expect((await onDisk()).sort()).toEqual(before)
  })

  /**
   * A lane belongs to one project. Sending another project's id has to fail, or the quick-add is a
   * way to write into a folder the person is not standing in — which is the whole M2 shape again,
   * reached sideways.
   */
  it('refuses a lane id that belongs to a different project', async () => {
    const OTHER = ['02-projects', 'orchard']
    await fsp.mkdir(join(rootPath, ...OTHER, 'tasks', '01-urgent'), { recursive: true })
    await fsp.writeFile(join(rootPath, ...OTHER, 'tasks', '01-urgent', 'other.md'), '# Other\n')
    await reindex()

    const theirLane = services['board.lanes']({ rootId: 'soil', project: OTHER })
      .find(lane => lane.name === 'Urgent')
    expect(theirLane, 'the other project must have an Urgent lane to borrow').toBeDefined()

    await expect(services['card.create']({
      rootId: 'soil', project: PROJECT, laneId: theirLane?.id ?? '', name: 'Wrong project',
    })).rejects.toThrow(/no longer on this board/)

    expect(await fsp.readdir(join(rootPath, ...OTHER, 'tasks', '01-urgent'))).toEqual(['other.md'])
  })

  it('refuses rather than replacing a task that is already there — §13.6', async () => {
    await services['card.create']({
      rootId: 'soil', project: PROJECT, laneId: laneNamed('Urgent'), name: 'Replace the belt',
    })
    await reindex()
    await fsp.writeFile(
      join(rootPath, ...TASKS, '01-urgent', 'replace-the-belt.md'), 'the real one\n',
    )

    await expect(services['card.create']({
      rootId: 'soil', project: PROJECT, laneId: laneNamed('Urgent'), name: 'Replace the belt',
    })).rejects.toThrow()

    // `O_CREAT|O_EXCL` refuses from the kernel, so a double-tap makes one file and one refusal —
    // never a second write over the first.
    expect(await fsp.readFile(join(rootPath, ...TASKS, '01-urgent', 'replace-the-belt.md'), 'utf8'))
      .toBe('the real one\n')
  })
})
