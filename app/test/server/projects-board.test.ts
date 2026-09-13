import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCode, refusalCodeOf } from '../../src/core/errors'
import { IndexStore } from '../../src/core/index-store'
import { indexRegisteredRoot } from '../../src/core/indexer'
import { loadConfigService, type ConfigService } from '../../src/server/config-service'
import { createRootRegistry, type RootRegistry } from '../../src/server/root-registry'
import { createServices, type Services } from '../../src/server/services'
import { withPlacement } from '../../src/core/project-board'
import type { UiStateFile } from '../../src/core/fs/config-store'

/**
 * **THE PROJECTS BOARD.** Phase 9, and the opposite of the Tasks board on purpose.
 *
 * ruled 2026-08-10, and the one thing they were conclusive about: *"when I drag stuff around that
 * board nothing is supposed to happen on disk."* So the property under test in half this file is a
 * **negative** one — after every verb, the tree is byte-for-byte what it was.
 *
 * The other half is the feature they asked for: *"I know I'm gonna need to do this project… let me
 * put it on my back burner… I put in the name of it and then I fill out a description."* A card
 * with a name, a description, and no folder.
 */
let sandbox: string
let rootPath: string
let registry: RootRegistry
let config: ConfigService
let index: IndexStore
let services: Services

/** Every path under the root, for the "nothing moved" assertions. */
async function census(): Promise<string[]> {
  const out: string[] = []
  const walk = async (at: string, prefix: string): Promise<void> => {
    for (const item of await fsp.readdir(at, { withFileTypes: true })) {
      const here = `${prefix}/${item.name}`
      out.push(here)
      if (item.isDirectory()) await walk(join(at, item.name), here)
    }
  }
  await walk(rootPath, '')
  return out.sort()
}

beforeEach(async () => {
  sandbox = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'soil-projects-')))
  rootPath = join(sandbox, 'root')
  for (const name of ['cider-line', 'orchard-ops', 'zebra-line']) {
    await fsp.mkdir(join(rootPath, '02-projects', name, '00-context'), { recursive: true })
  }

  registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)
  index = new IndexStore()
  await indexRegisteredRoot(registered.value, index)

  config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })
  services = createServices(registry, index, {
    stagingRoot: join(sandbox, 'scratch'),
    archiveRoot: join(sandbox, 'archive'),
    browseScope: { home: sandbox, volumes: join(sandbox, 'volumes') },
  }, config)
})

afterEach(async () => { await fsp.rm(sandbox, { recursive: true, force: true }) })

const codeOf = (work: Promise<unknown>) =>
  work.then(() => null, (error: unknown) => refusalCodeOf(error))

/** The id of a STAGED card, which lives on the card itself rather than on the board wrapper. */
const stagedIdOf = (board: { cards: readonly unknown[] }, name: string): string | undefined =>
  (cardNamed(board, name) as { card?: { id?: string } } | undefined)?.card?.id

const cardNamed = (board: { cards: readonly unknown[] }, name: string) =>
  (board.cards as Array<{ kind: string; columnId: string; project?: { name: string }; card?: { name: string } }>)
    .find(card => (card.kind === 'project' ? card.project?.name : card.card?.name) === name)

describe('the board a person opens before touching anything', () => {
  it('starts with Active, Next, Back Burner and Unfiled', () => {
    expect(services['projects.board']().columns.map(column => column.name))
      .toEqual(['Active', 'Next', 'Back Burner', 'Unfiled'])
  })

  /**
   * **A newly scaffolded project appears by itself.** The operator confirmed the PRD's rule stands:
   * *"newly scaffolded project appears on the board by itself."*
   */
  it('shows every project without anyone placing it', () => {
    const board = services['projects.board']()
    expect(board.cards).toHaveLength(3)
    expect(board.cards.every(card => card.columnId === 'unfiled')).toBe(true)
  })

  it('picks up a project scaffolded after the board was first read', async () => {
    await fsp.mkdir(join(rootPath, '02-projects', 'op-harvest'), { recursive: true })
    index.clearRoot('soil')
    const root = registry.get('soil')
    if (root === undefined) throw new Error('no root')
    await indexRegisteredRoot(root, index)

    expect(cardNamed(services['projects.board'](), 'op-harvest')).toBeDefined()
  })
})

describe('filing a project, which must not touch the disk', () => {
  it('moves the card and nothing else', async () => {
    const before = await census()
    const board = await services['projects.place']({
      rootId: 'soil', segments: ['02-projects', 'cider-line'], columnId: 'active',
    })

    expect(cardNamed(board, 'cider-line')?.columnId).toBe('active')
    // The whole point. The operator: "nothing is supposed to happen on disk."
    expect(await census()).toEqual(before)
  })

  /**
   * **The placement survives a rename of the folder**, because it is stored as a `PathKey` and
   * `retargetPathKeys` already rewrites those on the rename path. `PathKey`'s comment has named
   * this board as its example since Phase 1; this is the first thing to use it.
   */
  it('follows the project when its folder is renamed', async () => {
    await services['projects.place']({
      rootId: 'soil', segments: ['02-projects', 'cider-line'], columnId: 'active',
    })
    const row = services['tree.entry']({ rootId: 'soil', segments: ['02-projects', 'cider-line'] })
    await services['entry.rename']({
      rootId: 'soil',
      from: ['02-projects', 'cider-line'],
      to: ['02-projects', 'cider-house'],
      token: row.token,
    })

    expect(cardNamed(services['projects.board'](), 'cider-house')?.columnId).toBe('active')
  })

  it('refuses a project that does not exist', async () => {
    expect(await codeOf(services['projects.place']({
      rootId: 'soil', segments: ['02-projects', 'imaginary'], columnId: 'active',
    }))).toBe(ErrorCode.INVALID_ROOT)
  })

  /**
   * **P9-8 — the existence check was byte-exact while the write beside it folds.**
   *
   * security review, P9 review: *"`projects.place` compares byte-exactly while placement folds through
   * `comparisonKey`."* Two lines of the same function disagreeing about when two paths are the same
   * path.
   *
   * **The check was the STRICTER of the two, so the bug is a false refusal.** `withPlacement` stores
   * against `comparisonKey(segments, caseInsensitive)` — NFC, and case-folded on a case-insensitive
   * volume, which is macOS's default. The guard above it required the bytes to match exactly. So a
   * request naming a real project in a spelling the *storage layer* considers identical was answered
   * **"no such project"** — a refusal that is not actionable, because the project is right there and
   * looks correctly spelled.
   *
   * Asserted on both axes the key folds: case, and unicode normalisation.
   */
  it('accepts a project named in a different case on a case-insensitive volume', async () => {
    const board = await services['projects.place']({
      rootId: 'soil', segments: ['02-PROJECTS', 'Cider-Line'], columnId: 'active',
    })
    expect(cardNamed(board, 'cider-line')?.columnId, 'a real project was refused as missing')
      .toBe('active')
  })

  // **There is deliberately no unicode-normalisation case here**, and the omission is recorded
  // rather than silent: every project in this fixture is pure ASCII, so `normalize('NFD')` returns
  // the identical string and such a test would assert nothing while appearing to. The first draft of
  // this file contained exactly that test and it passed against the unfixed code. What `comparisonKey`
  // folds — NFC and case — is proven in `paths.test.ts`; what this file proves is that
  // `projects.place` **uses** it rather than re-deriving a stricter comparison beside it.

  it('still refuses a project that does not exist, in any spelling', () => {
    // The other half: folding the comparison must not turn the guard off.
    return expect(codeOf(services['projects.place']({
      rootId: 'soil', segments: ['02-projects', 'IMAGINARY'], columnId: 'active',
    }))).resolves.toBe(ErrorCode.INVALID_ROOT)
  })

  it('refuses a column that does not exist', async () => {
    expect(await codeOf(services['projects.place']({
      rootId: 'soil', segments: ['02-projects', 'cider-line'], columnId: 'nowhere',
    }))).toBe(ErrorCode.INVALID_ROOT)
  })
})

/**
 * **P9-5 — three unbounded things in one route.** The security review, P9 review: *"Unbounded staged cards
 * (120 × 100 KB → 12 MB, quadratic); client-chosen ids including `../../etc/passwd` and a literal
 * NUL written into config."*
 *
 * **The NUL half was closed by P9F-5** — `displayName()` refuses control characters in the *name*.
 * The rest was not, and the ledger says to rule on the remainder explicitly. It is three separate
 * things wearing one id:
 *
 *   1. **the id itself is chosen by the client** and stored verbatim in the config file;
 *   2. **nothing caps how many cards there are**, and every write rewrites the whole config, which
 *      is where the quadratic comes from;
 *   3. **nothing caps the body**, so each card can be as large as a request allows.
 *
 * None of it escapes containment — the config is the app's own file and a staged card touches no
 * disk of the operator's. It is a config file that can be grown until it is slow to write and awkward to
 * read, by a route whose whole purpose is *"a plan with no folder"*.
 */
describe('a staged card cannot choose its own id', () => {
  it('mints the id when the client sends an empty one', async () => {
    const board = await services['projects.stage']({
      id: '', name: 'Minted', body: '', columnId: 'back-burner',
    })
    expect(stagedIdOf(board, 'Minted')).toMatch(/^staged-\d+$/)
  })

  it('refuses an id the server never issued', async () => {
    /**
     * **The fix is to remove the choice, not to sanitise it.** An id is either empty — meaning
     * "make me one" — or one this server already minted, meaning "edit that one". There is no third
     * case, so no string a client invents can ever reach the config, and there is nothing to
     * validate against a list of dangerous shapes that would need to stay complete.
     */
    expect(await codeOf(services['projects.stage']({
      id: '../../etc/passwd', name: 'Sneaky', body: '', columnId: 'back-burner',
    }))).toBe(ErrorCode.INVALID_ROOT)
  })

  it('refuses a plausible-looking id that does not exist either', async () => {
    // Not a shape check. `staged-99` is exactly the shape the server mints and is still refused,
    // because the rule is "one I issued", not "one that looks like mine".
    expect(await codeOf(services['projects.stage']({
      id: 'staged-99', name: 'Plausible', body: '', columnId: 'back-burner',
    }))).toBe(ErrorCode.INVALID_ROOT)
  })

  it('still edits a card by the id the server gave it', async () => {
    const made = await services['projects.stage']({
      id: '', name: 'First name', body: 'a', columnId: 'back-burner',
    })
    const id = stagedIdOf(made, 'First name') ?? ''
    expect(id).not.toBe('')

    const edited = await services['projects.stage']({
      id, name: 'Second name', body: 'b', columnId: 'back-burner',
    })
    expect(stagedIdOf(edited, 'Second name')).toBe(id)
    expect(cardNamed(edited, 'First name')).toBeUndefined()
  })
})

describe('staged cards have a ceiling', () => {
  it('refuses one past the cap, and names the cap', async () => {
    for (let i = 0; i < 200; i++) {
      await services['projects.stage']({
        id: '', name: `Card ${i}`, body: '', columnId: 'back-burner',
      })
    }
    const refusal = await services['projects.stage']({
      id: '', name: 'One too many', body: '', columnId: 'back-burner',
    }).then(() => null, (error: unknown) => error)

    expect(refusal, 'the 201st staged card was accepted').not.toBeNull()
    expect((refusal as Error).message).toContain('200')
  })

  it('editing an existing card is never refused by the cap', async () => {
    // The cap is about growth. A person at the ceiling must still be able to fix a typo, and a
    // cap applied to updates would trap them there.
    const made = await services['projects.stage']({
      id: '', name: 'Editable', body: '', columnId: 'back-burner',
    })
    const id = stagedIdOf(made, 'Editable') ?? ''
    for (let i = 0; i < 199; i++) {
      await services['projects.stage']({
        id: '', name: `Filler ${i}`, body: '', columnId: 'back-burner',
      })
    }
    const edited = await services['projects.stage']({
      id, name: 'Edited at the ceiling', body: '', columnId: 'back-burner',
    })
    expect(cardNamed(edited, 'Edited at the ceiling')).toBeDefined()
  })

  it('refuses a body larger than a card should hold', async () => {
    const huge = 'x'.repeat(64 * 1024 + 1)
    expect(await codeOf(services['projects.stage']({
      id: '', name: 'Huge', body: huge, columnId: 'back-burner',
    }))).toBe(ErrorCode.TOO_LARGE)
  })

  it('accepts an ordinary description', async () => {
    const board = await services['projects.stage']({
      id: '', name: 'Ordinary', body: 'a paragraph or two, which is what this is for',
      columnId: 'back-burner',
    })
    expect(cardNamed(board, 'Ordinary')).toBeDefined()
  })
})

describe('a staged card — a plan with no folder', () => {
  it('holds a name and a description, and creates nothing', async () => {
    const before = await census()
    const board = await services['projects.stage']({
      id: '', name: 'Cider bar', body: 'maybe next autumn, talk to Hollis first',
      columnId: 'back-burner',
    })

    const card = cardNamed(board, 'Cider bar')
    expect(card?.kind).toBe('staged')
    expect(card?.columnId).toBe('back-burner')
    expect(await census()).toEqual(before)
  })

  it('is not a project, so it never reaches projects.list', async () => {
    await services['projects.stage']({
      id: '', name: 'Cider bar', body: '', columnId: 'next',
    })
    expect(services['projects.list']().map(project => project.name)).not.toContain('Cider bar')
  })

  it('can be edited without becoming a second card', async () => {
    const made = await services['projects.stage']({
      id: '', name: 'Cider bar', body: 'first thought', columnId: 'next',
    })
    const id = (made.cards.find(card => card.kind === 'staged') as { card: { id: string } }).card.id

    const after = await services['projects.stage']({
      id, name: 'Cider bar', body: 'second thought', columnId: 'active',
    })
    expect(after.cards.filter(card => card.kind === 'staged')).toHaveLength(1)
    expect(cardNamed(after, 'Cider bar')?.columnId).toBe('active')
  })

  it('refuses a card with no name', async () => {
    expect(await codeOf(services['projects.stage']({
      id: '', name: '   ', body: 'x', columnId: 'next',
    }))).toBe(ErrorCode.NAME_EMPTY)
  })

  it('is forgotten on request, and there was never a file to delete', async () => {
    const before = await census()
    const made = await services['projects.stage']({
      id: '', name: 'Cider bar', body: '', columnId: 'next',
    })
    const id = (made.cards.find(card => card.kind === 'staged') as { card: { id: string } }).card.id

    const after = await services['projects.unstage']({ id })
    expect(after.cards.filter(card => card.kind === 'staged')).toHaveLength(0)
    expect(await census()).toEqual(before)
  })
})

describe('the columns are their to change', () => {
  it('renames one without moving the cards out of it', async () => {
    await services['projects.place']({
      rootId: 'soil', segments: ['02-projects', 'cider-line'], columnId: 'active',
    })
    const board = await services['projects.setColumns']({
      columns: [
        { id: 'active', name: 'Working On' },
        { id: 'next', name: 'Next' },
        { id: 'unfiled', name: 'Unfiled' },
      ],
    })

    expect(board.columns.map(column => column.name)).toEqual(['Working On', 'Next', 'Unfiled'])
    expect(cardNamed(board, 'cider-line')?.columnId).toBe('active')
  })

  it('adds one', async () => {
    const board = await services['projects.setColumns']({
      columns: [
        ...services['projects.board']().columns.map(column => ({ ...column })),
        { id: 'someday', name: 'Someday' },
      ],
    })
    expect(board.columns.map(column => column.id)).toContain('someday')
  })

  /**
   * **A card whose column disappears falls back rather than vanishing.** Deleting a column is
   * allowed; losing the cards that were in it silently is not — that reads as lost work.
   */
  it('moves a stranded card to the last column instead of dropping it', async () => {
    await services['projects.place']({
      rootId: 'soil', segments: ['02-projects', 'cider-line'], columnId: 'active',
    })
    const board = await services['projects.setColumns']({
      columns: [{ id: 'next', name: 'Next' }, { id: 'unfiled', name: 'Unfiled' }],
    })

    expect(board.cards).toHaveLength(3)
    expect(cardNamed(board, 'cider-line')?.columnId).toBe('unfiled')
  })

  it('refuses an empty board and duplicate ids', async () => {
    expect(await codeOf(services['projects.setColumns']({ columns: [] })))
      .toBe(ErrorCode.NAME_EMPTY)
    expect(await codeOf(services['projects.setColumns']({
      columns: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }],
    }))).toBe(ErrorCode.INVALID_ROOT)
  })

  it('refuses a column with a blank name', async () => {
    expect(await codeOf(services['projects.setColumns']({
      columns: [{ id: 'a', name: '  ' }],
    }))).toBe(ErrorCode.NAME_EMPTY)
  })
})

/**
 * `withPlacement` on its own, because the invariant it protects has no second caller yet.
 *
 * `pathKeys` is a **general** path-addressed store — its own comment calls the Projects board only
 * an *example* of what it holds. Filing a project therefore has to merge into whatever is already
 * keyed against that folder rather than replace it, or the first other feature to use the store
 * loses its data the moment a card is dragged.
 *
 * The mutation sweep found this unproven: with only this feature writing keys, merge and replace
 * are indistinguishable through the service. It is the same mistake `retargetPathKeys` actually
 * made — rebuilding a shared structure from a literal — one level down.
 */
describe('filing a project does not clobber other config keyed to the same folder', () => {
  it('merges into the existing value', () => {
    const before: UiStateFile = {
      pathKeys: [{
        rootId: 'soil',
        segments: ['02-projects', 'cider-line'],
        value: { note: 'something another feature stored' },
      }],
      projectColumns: [],
      stagedCards: [], boardSelection: [],
    }

    const after = withPlacement(before, 'soil', ['02-projects', 'cider-line'], 'active', false)
    expect(after.pathKeys[0]?.value).toEqual({
      note: 'something another feature stored',
      board: 'active',
    })
  })

  it('adds a key when the folder has none yet', () => {
    const after = withPlacement(
      { pathKeys: [], projectColumns: [], stagedCards: [], boardSelection: [] },
      'soil', ['02-projects', 'cider-line'], 'next', false,
    )
    expect(after.pathKeys).toEqual([
      { rootId: 'soil', segments: ['02-projects', 'cider-line'], value: { board: 'next' } },
    ])
  })
})

/**
 * **P9-9 — a value `withPlacement` cannot merge into is preserved, never replaced.**
 *
 * security review, P9 review: *"`withPlacement` replaces a non-object value instead of merging."* `PathKey.value`
 * is typed `unknown` on purpose — it is a general per-path store and this function owns exactly one
 * property in it. The same argument P9-6 settled for unrecognised config keys, one level up.
 */
describe('a stored value this function cannot merge into is kept', () => {
  const keyed = (value: unknown): UiStateFile => ({
    pathKeys: [{ rootId: 'soil', segments: ['02-projects', 'cider-line'], value }],
    projectColumns: [], stagedCards: [], boardSelection: [],
  })

  const place = (state: UiStateFile): unknown =>
    withPlacement(state, 'soil', ['02-projects', 'cider-line'], 'active', false).pathKeys[0]?.value

  it('rescues a string rather than discarding it', () => {
    expect(place(keyed('something a future feature wrote')))
      .toEqual({ previousValue: 'something a future feature wrote', board: 'active' })
  })

  it('rescues a number, and zero is not treated as absent', () => {
    expect(place(keyed(0))).toEqual({ previousValue: 0, board: 'active' })
  })

  it('rescues null, which is not an object to merge into however typeof reads it', () => {
    expect(place(keyed(null))).toEqual({ previousValue: null, board: 'active' })
  })

  it('rescues an ARRAY rather than spreading it into numbered keys', () => {
    /**
     * **The sharp case, and it is not the one the finding describes.** `typeof [] === 'object'` and
     * an array is not null, so the old test admitted one — and spreading `[1, 2]` into an object
     * gives `{ 0: 1, 1: 2, board: … }`. Worse than the reported failure, because it looks merged.
     */
    expect(place(keyed([1, 2]))).toEqual({ previousValue: [1, 2], board: 'active' })
  })

  it('merges into a plain object exactly as before', () => {
    expect(place(keyed({ note: 'kept' }))).toEqual({ note: 'kept', board: 'active' })
  })

  it('treats an absent value as nothing to rescue', () => {
    /**
     * `undefined` is the ordinary "nothing here yet" case. Rescuing it would put a
     * `previousValue: undefined` into every key this function has ever touched.
     *
     * **`toStrictEqual`, and the difference is the whole test.** `toEqual` ignores properties whose
     * value is `undefined`, so it reports `{ previousValue: undefined, board }` as equal to
     * `{ board }` — and the mutation that rescues `undefined` passed against it. Caught by the
     * sweep, which is the only reason this line is the strict one.
     */
    expect(place(keyed(undefined))).toStrictEqual({ board: 'active' })
  })

  it('overwrites its OWN property, because that is the one it owns', () => {
    expect(place(keyed({ board: 'back-burner', note: 'kept' })))
      .toEqual({ board: 'active', note: 'kept' })
  })
})

