import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EMPTY_REGISTRY,
  EMPTY_UI_STATE,
  deregisterRoot,
  markUnresolvedKeys,
  readConfig,
  retargetPathKeys,
  validateRegistry,
  validateUiState,
  writeConfig,
  type RegistryFile,
  type UiStateFile,
} from '../../../src/core/fs/config-store'

/**
 * §13.8. Every rule here protects a record the user cannot reconstruct: which folders they
 * registered, and how they arranged their boards.
 *
 * **Two files, not one — M7.** The registry and the UI state are read through the same proven path
 * with a validator each, so neither can parse as the other. That was a single `AppConfig` until
 * 2026-08-08; see the module header for how a rule stated twice in the spec got built the other way
 * and survived a phase and a half.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch directory, created and removed here.
 */
let dir: string
let configPath: string
let statePath: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p4-config-'))
  configPath = join(dir, 'registry.json')
  statePath = join(dir, 'ui-state.json')
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const readRegistry = (path: string) => readConfig(path, validateRegistry)
const readUiState = (path: string) => readConfig(path, validateUiState)

const withRoots = (over: Partial<RegistryFile> = {}): RegistryFile => ({
  ...EMPTY_REGISTRY,
  roots: [{ id: 'soil', absolutePath: '/scratch/soil' }],
  ...over,
})

describe('a damaged config is PRESERVED, never replaced with defaults', () => {
  it('reports invalid JSON as unreadable rather than as empty', async () => {
    /**
     * The failure this closes is total and self-inflicted: treat a damaged config as empty, and the
     * app comes up with no folders registered — then writes that emptiness back over the only
     * record of what was there. §13.8 forbids it in one sentence and this is the whole reason
     * `missing` and `unreadable` are different outcomes.
     */
    await fsp.writeFile(configPath, '{ "roots": [ this is not json')
    const loaded = await readRegistry(configPath)
    expect(loaded.kind).toBe('unreadable')
  })

  it('leaves the damaged file exactly as it found it', async () => {
    const damaged = '{ "roots": [ broken'
    await fsp.writeFile(configPath, damaged)
    await readRegistry(configPath)
    expect(await fsp.readFile(configPath, 'utf8'), 'reading must never repair').toBe(damaged)
  })

  it('distinguishes a MISSING config from a damaged one', async () => {
    // First run is not damage. Collapsing the two is how a corrupt config becomes an empty one.
    expect((await readRegistry(join(dir, 'never-written.json'))).kind).toBe('missing')
  })

  it('rejects a structurally wrong registry rather than salvaging what it can', async () => {
    // Salvaging is dropping, and dropping is the silent loss §13.8 exists to forbid.
    for (const body of [
      '[]',
      '"a string"',
      '{ "roots": "not a list" }',
      '{ "roots": [ { "id": "x" } ] }',
      // No `roots` key at all. **Required, unlike `deregistered`** — a registry missing its own
      // list is damage, and reading it as "no folders" is the total loss this section forbids.
      '{ "deregistered": [] }',
    ]) {
      await fsp.writeFile(configPath, body)
      expect((await readRegistry(configPath)).kind, body).toBe('unreadable')
    }
  })

  it('rejects a structurally wrong UI state the same way', async () => {
    for (const body of [
      '[]',
      '{ }',
      '{ "pathKeys": "not a list" }',
      '{ "pathKeys": [ { "rootId": "a", "segments": [1, 2] } ] }',
    ]) {
      await fsp.writeFile(statePath, body)
      expect((await readUiState(statePath)).kind, body).toBe('unreadable')
    }
  })

  it('accepts a registry that omits the optional list', async () => {
    // An older build wrote no `deregistered`. That is not damage.
    await fsp.writeFile(configPath, '{ "roots": [] }')
    expect((await readRegistry(configPath)).kind).toBe('loaded')
  })

  it('THE TWO FILES CANNOT BE READ AS EACH OTHER — M7', async () => {
    /**
     * The rule is that they are separate files; this is what makes the separation load-bearing
     * rather than cosmetic. If a UI-state file parsed as a registry it would parse as **a registry
     * with no folders**, and the next registry write would put that emptiness on disk — which is
     * the M7 loss arriving by a different door than the one M7 describes.
     */
    await writeConfig(configPath, withRoots())
    await writeConfig(statePath, {
      pathKeys: [{ rootId: 'soil', segments: ['a'], value: 1 }],
      projectColumns: [], stagedCards: [], boardSelection: [],
    })

    expect((await readRegistry(statePath)).kind, 'ui state is not a registry').toBe('unreadable')
    expect((await readUiState(configPath)).kind, 'a registry is not ui state').toBe('unreadable')
  })
})

describe('writing is as safe as a user write', () => {
  it('round-trips the registry', async () => {
    const config = withRoots({ deregistered: [{ id: 'old', absolutePath: '/gone' }] })
    expect((await writeConfig(configPath, config)).ok).toBe(true)

    const loaded = await readRegistry(configPath)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') return
    expect(loaded.config).toEqual(config)
  })

  it('round-trips the UI state', async () => {
    const state: UiStateFile = {
      pathKeys: [{ rootId: 'soil', segments: ['a'], value: { column: 2 } }],
      projectColumns: [], stagedCards: [], boardSelection: [],
    }
    expect((await writeConfig(statePath, state)).ok).toBe(true)

    const loaded = await readUiState(statePath)
    if (loaded.kind !== 'loaded') throw new Error('expected loaded UI state')
    expect(loaded.config).toEqual(state)
  })

  it('leaves no temp file behind', async () => {
    await writeConfig(configPath, withRoots())
    const left = (await fsp.readdir(dir)).filter(name => name.includes('.tmp'))
    expect(left).toEqual([])
  })

  it('replaces the previous config completely, with no leftovers from the old one', async () => {
    await writeConfig(configPath, withRoots({
      roots: [
        { id: 'a', absolutePath: '/one' },
        { id: 'b', absolutePath: '/two' },
      ],
    }))
    await writeConfig(configPath, withRoots({ roots: [{ id: 'a', absolutePath: '/one' }] }))

    const loaded = await readRegistry(configPath)
    if (loaded.kind !== 'loaded') throw new Error('expected a loaded config')
    expect(loaded.config.roots).toHaveLength(1)
  })

  it('REPLACES the file rather than overwriting it in place', async () => {
    /**
     * The observable fingerprint of an atomic write, and the sweep needed it: swapping the final
     * `rename` for a `copyFile` left every other test green, because the content lands either way.
     * The difference only shows in a crash — or here, in the file's identity.
     *
     * A rename installs a *new* inode; a copy writes into the existing one. So the inode changing
     * between two writes is direct evidence that the destination was never open for writing, which
     * is the whole property: a crash mid-write leaves the previous config intact rather than
     * truncated. An app that comes up with a truncated config comes up with no folders registered.
     */
    await writeConfig(configPath, withRoots())
    const first = await fsp.stat(configPath, { bigint: true })

    await writeConfig(configPath, withRoots({ roots: [{ id: 'b', absolutePath: '/two' }] }))
    const second = await fsp.stat(configPath, { bigint: true })

    expect(second.ino, 'an atomic replace installs a new inode').not.toBe(first.ino)
    expect(Number(second.mode) & 0o777, 'and the config stays private').toBe(0o600)
  })

  it('creates the directory if it does not exist yet', async () => {
    // First run: the app's config directory has never been created.
    const nested = join(dir, 'deeper', 'still', 'config.json')
    expect((await writeConfig(nested, withRoots())).ok).toBe(true)
    expect((await readRegistry(nested)).kind).toBe('loaded')
  })
})

describe('deregistering appends, never deletes — M7', () => {
  it('moves the root to the deregistered list', async () => {
    const after = deregisterRoot(withRoots(), 'soil')
    expect(after.roots).toHaveLength(0)
    expect(after.deregistered).toEqual([{ id: 'soil', absolutePath: '/scratch/soil' }])
  })

  it('survives a round-trip through the file', async () => {
    await writeConfig(configPath, deregisterRoot(withRoots(), 'soil'))
    const loaded = await readRegistry(configPath)
    if (loaded.kind !== 'loaded') throw new Error('expected a loaded config')
    expect(loaded.config.deregistered).toHaveLength(1)
  })

  it('does not stack duplicates when a folder is registered and removed twice', async () => {
    const once = deregisterRoot(withRoots(), 'soil')
    const reAdded: RegistryFile = { ...once, roots: [{ id: 'soil', absolutePath: '/scratch/soil' }] }
    const twice = deregisterRoot(reAdded, 'soil')
    expect(twice.deregistered).toHaveLength(1)
  })

  it('is a no-op for an id that is not registered', () => {
    const before = withRoots()
    expect(deregisterRoot(before, 'nobody')).toEqual(before)
  })
})

describe('config keys follow the paths they describe — §13.8', () => {
  const board = (segments: string[]): UiStateFile => ({
    ...EMPTY_UI_STATE,
    pathKeys: [{ rootId: 'soil', segments, value: { column: 3 } }],
  })

  it('retargets the exact path that moved', () => {
    /**
     * The failure without this is quiet and maddening: the Projects board's column arrangement is
     * keyed by project path, so renaming a project reverts its placement to the default. The app
     * undoes the user's own arrangement, with no error and nothing to point at.
     */
    const after = retargetPathKeys(board(['projects', 'old-name']), 'soil',
      ['projects', 'old-name'], ['projects', 'new-name'])
    expect(after.pathKeys[0]?.segments).toEqual(['projects', 'new-name'])
  })

  it('retargets DESCENDANTS too, not just the exact match', () => {
    // Updating only the exact match orphans every child key — the same bug one level down, and
    // harder to notice because the top-level project looks fine.
    const after = retargetPathKeys(board(['projects', 'old', 'inner', 'deep']), 'soil',
      ['projects', 'old'], ['projects', 'new'])
    expect(after.pathKeys[0]?.segments).toEqual(['projects', 'new', 'inner', 'deep'])
  })

  it('leaves a key that merely SHARES A PREFIX alone', () => {
    // §5's rule again: `old-archive` is not inside `old`. Getting this wrong silently rewrites the
    // arrangement of an unrelated project.
    const after = retargetPathKeys(board(['projects', 'old-archive']), 'soil',
      ['projects', 'old'], ['projects', 'new'])
    expect(after.pathKeys[0]?.segments).toEqual(['projects', 'old-archive'])
  })

  it('leaves keys belonging to another root alone', () => {
    const after = retargetPathKeys(board(['projects', 'old']), 'a-different-root',
      ['projects', 'old'], ['projects', 'new'])
    expect(after.pathKeys[0]?.segments).toEqual(['projects', 'old'])
  })

  it('keeps the value attached through the move', () => {
    const after = retargetPathKeys(board(['p', 'old']), 'soil', ['p', 'old'], ['p', 'new'])
    expect(after.pathKeys[0]?.value).toEqual({ column: 3 })
  })
})

describe('an unresolved key is RETAINED, never dropped — §13.8', () => {
  const twoKeys: UiStateFile = {
    ...EMPTY_UI_STATE,
    pathKeys: [
      { rootId: 'soil', segments: ['here.md'], value: 1 },
      { rootId: 'soil', segments: ['gone.md'], value: 2 },
    ],
  }

  it('marks the missing one and keeps both', async () => {
    /**
     * A volume unplugged this morning is plugged in this afternoon. Dropping the key in between
     * permanently erases arrangement the user did by hand — and the build plan names the exact
     * case: during the copy-first trial week every key points into the copy, so switching to the
     * real tree makes them all unresolved at once.
     */
    const after = markUnresolvedKeys(twoKeys, (_root, segments) => segments[0] === 'here.md')
    expect(after.pathKeys, 'nothing may be dropped').toHaveLength(2)
    expect(after.pathKeys.find(k => k.segments[0] === 'gone.md')?.unresolved).toBe(true)
  })

  it('CLEARS the mark when the path comes back', async () => {
    // The other half. A key marked unresolved once and never cleared would show as broken in
    // Settings forever, which teaches the user to ignore the warning.
    const marked = markUnresolvedKeys(twoKeys, () => false)
    expect(marked.pathKeys.every(k => k.unresolved === true)).toBe(true)

    const restored = markUnresolvedKeys(marked, () => true)
    expect(restored.pathKeys.some(k => k.unresolved === true)).toBe(false)
  })

  it('survives a round-trip through the file with the mark intact', async () => {
    await writeConfig(statePath, markUnresolvedKeys(twoKeys, () => false))
    const loaded = await readUiState(statePath)
    if (loaded.kind !== 'loaded') throw new Error('expected loaded UI state')
    expect(loaded.config.pathKeys).toHaveLength(2)
    expect(loaded.config.pathKeys.every(k => k.unresolved === true)).toBe(true)
  })
})

/**
 * **TEMPLATES IN THE REGISTRY FILE.** Phase 8.
 *
 * A template is a *pointer* — the operator's requirement, not an implementation shortcut: *"that
 * template might change… these things take shape."* Storing the shape would mean an update step and
 * a template that drifts from the folder it came from. Pointing at the folder means the template is
 * whatever that folder is today.
 *
 * It lives in this file rather than a third one because it names a `rootId` that lives here. Two
 * files would let a folder be deregistered in one and still referenced by the other, with no single
 * read that could see both.
 */
describe('templates in the registry', () => {
  const template = {
    id: 't1', name: 'Op', rootId: 'notes',
    segments: ['00-context', 'templates', 'work-templates', 'op-template'],
  }

  it('round-trips a stored template', () => {
    const loaded = validateRegistry({ roots: [], deregistered: [], templates: [template] })
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.value.templates).toEqual([template])
  })

  /**
   * **THE ONE THAT WOULD HAVE BROKEN EVERY EXISTING INSTALL.**
   *
   * Every registry on disk today predates templates. If the key were required, the first launch
   * after this ships would read the file as `unreadable`, refuse to write over it, and report no
   * folders — the exact total loss §13.8 forbids, delivered by the validator written to prevent it.
   * The same asymmetry `deregistered` already has, earning its keep a second time.
   */
  it('accepts a registry written before templates existed', () => {
    const loaded = validateRegistry({ roots: [{ id: 'a', absolutePath: '/tmp/a' }] })
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.value.templates).toEqual([])
  })

  /** Restored config is untrusted input — F9.2. Damage is reported, never quietly dropped. */
  it.each([
    ['not a list', { templates: {} }],
    ['an entry that is not an object', { templates: ['op'] }],
    ['a missing name', { templates: [{ id: 't', rootId: 'r', segments: ['a'] }] }],
    ['a missing rootId', { templates: [{ id: 't', name: 'Op', segments: ['a'] }] }],
    ['segments that are not a list', { templates: [{ id: 't', name: 'Op', rootId: 'r', segments: 'a' }] }],
    ['a segment that is a number', { templates: [{ id: 't', name: 'Op', rootId: 'r', segments: [3] }] }],
  ])('refuses %s', (_label, extra) => {
    expect(validateRegistry({ roots: [], ...extra }).ok).toBe(false)
  })

  /**
   * An empty `segments` names the registered folder itself — a template of a whole root, which
   * would scaffold a root into its own subtree. Refused at load rather than at use: a stored
   * template that can never be instantiated is a damaged record however it got written.
   */
  it('refuses a template pointing at a whole registered folder', () => {
    const whole = { id: 't', name: 'Everything', rootId: 'r', segments: [] }
    expect(validateRegistry({ roots: [], templates: [whole] }).ok).toBe(false)
  })

  /**
   * **Deregistering a folder KEEPS its templates.** They go inert — nothing can scaffold from a
   * folder the app may no longer read — but the naming work is the user's, and removing a folder is
   * not a statement about it. `folderIdFor` derives an id from the folder's own last segment, so
   * re-adding the same folder mints the same id and the templates work again.
   *
   * The same append-don't-delete rule as `deregistered` itself, one level up.
   */
  it('keeps templates when their folder is deregistered', () => {
    const registry = {
      roots: [{ id: 'notes', absolutePath: '/tmp/soil' }],
      deregistered: [],
      templates: [template],
    }
    const after = deregisterRoot(registry, 'notes')
    expect(after.roots).toEqual([])
    expect(after.templates).toEqual([template])
  })
})

/**
 * **THE PROJECTS BOARD'S ARRANGEMENT, AND THE CARDS THAT ARE NOT FOLDERS.** Phase 9.
 *
 * The PRD puts the column arrangement in *"app config only — it never touches the file tree"*, and
 * this file's own `PathKey` comment has named the Projects board as its example since P1. The operator
 * added the other half on 2026-08-10: a card that is a name and a body and **no folder at all** —
 * *"it doesn't mean I wanna scaffold the folder just yet."*
 */
describe('project columns and staged cards', () => {
  it('round-trips both', () => {
    const loaded = validateUiState({
      pathKeys: [],
      projectColumns: [{ id: 'active', name: 'Active' }],
      stagedCards: [{ id: 's1', name: 'Cider bar', body: 'maybe autumn', columnId: 'active' }], boardSelection: [],
    })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.projectColumns).toEqual([{ id: 'active', name: 'Active' }])
    expect(loaded.value.stagedCards[0]?.body).toBe('maybe autumn')
  })

  /**
   * **Every UI-state file on disk predates this.** Requiring either key would make the first launch
   * after it ships read them all as damaged — and a damaged UI state makes the app refuse to write
   * the file at all, so the arrangement freezes. Third time this asymmetry has earned its keep.
   */
  it('accepts a UI state written before either existed', () => {
    const loaded = validateUiState({ pathKeys: [] })
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.value.projectColumns).toEqual([])
      expect(loaded.value.stagedCards).toEqual([])
    }
  })

  /** A body is optional on the wire — a staged card with only a name is a perfectly good thought. */
  it('defaults a missing body to empty text', () => {
    const loaded = validateUiState({
      pathKeys: [], stagedCards: [{ id: 's', name: 'Idea', columnId: 'next' }], boardSelection: [],
    })
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.value.stagedCards[0]?.body).toBe('')
  })

  it.each([
    ['columns that are not a list', { projectColumns: {} }],
    ['a column with no name', { projectColumns: [{ id: 'a' }] }],
    ['a column with an empty id', { projectColumns: [{ id: '', name: 'A' }] }],
    ['cards that are not a list', { stagedCards: 'nope' }],
    ['a card with no columnId', { stagedCards: [{ id: 's', name: 'Idea' }], boardSelection: [] }],
    ['a card whose body is not text', { stagedCards: [{ id: 's', name: 'I', body: 3, columnId: 'c' }], boardSelection: [] }],
  ])('refuses %s', (_label, extra) => {
    expect(validateUiState({ pathKeys: [], ...extra }).ok).toBe(false)
  })

  /**
   * **A rename must not eat the arrangement.** `retargetPathKeys` rebuilt the state from a fresh
   * literal, which drops every field it does not name — so the first project rename after this
   * shipped would have silently erased the columns and every staged card. The compiler caught it;
   * this keeps it caught.
   */
  it('keeps columns and staged cards through a path retarget', () => {
    const before: UiStateFile = {
      pathKeys: [{ rootId: 'soil', segments: ['02-projects', 'old'], value: { column: 'active' } }],
      projectColumns: [{ id: 'active', name: 'Active' }],
      stagedCards: [{ id: 's1', name: 'Cider bar', body: '', columnId: 'active' }], boardSelection: [],
    }
    const after = retargetPathKeys(before, 'soil', ['02-projects', 'old'], ['02-projects', 'new'])
    expect(after.pathKeys[0]?.segments).toEqual(['02-projects', 'new'])
    expect(after.projectColumns).toEqual(before.projectColumns)
    expect(after.stagedCards).toEqual(before.stagedCards)
  })
})

/**
 * **THE TASKS BOARD'S STORED FILTER.** P11, and the operator's requirement in their own words:
 *
 * > *"if I go to files or I go to projects or I navigate away, I shouldn't have to re-filter
 * > everything back to the view that I was in."*
 *
 * Within a session that is free — the tabs are separate panes and nothing tears the board down.
 * This is the half that survives a restart, and it lives on the file that already survives one.
 */
describe('the board selection', () => {
  it('reads a file written before this key existed, rather than calling it damaged', () => {
    /**
     * **The third time this asymmetry has earned its keep**, and the reason is worse than losing an
     * arrangement: a UI-state file read as damaged makes the app **refuse to write the file at
     * all**. Every state file on disk today predates this key.
     */
    const older = validateUiState({ pathKeys: [], projectColumns: [], stagedCards: [] })
    expect(older.ok).toBe(true)
    if (older.ok) expect(older.value.boardSelection).toEqual([])
  })

  it('keeps the projects it was given', () => {
    const read = validateUiState({
      pathKeys: [], projectColumns: [], stagedCards: [],
      boardSelection: [{ rootId: 'soil', segments: ['02-projects', 'alpha'] }],
    })
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.value.boardSelection).toEqual([
        { rootId: 'soil', segments: ['02-projects', 'alpha'] },
      ])
    }
  })

  /**
   * **A path that names nothing is kept, not rejected.** This is a filter: an entry matching no
   * project simply contributes nothing when the board resolves it against the index. Validating
   * against the tree here would make a *renamed project* turn the whole state file into damage —
   * trading a filter that narrows slightly wrong for a config the app refuses to write.
   */
  it('accepts a path that may since have been renamed away', () => {
    const read = validateUiState({
      pathKeys: [], projectColumns: [], stagedCards: [],
      boardSelection: [{ rootId: 'soil', segments: ['02-projects', 'gone-last-week'] }],
    })
    expect(read.ok).toBe(true)
  })

  it('refuses an entry with no rootId or no path', () => {
    for (const bad of [{ segments: ['a'] }, { rootId: 'soil' }, { rootId: '', segments: [] }]) {
      expect(validateUiState({
        pathKeys: [], projectColumns: [], stagedCards: [], boardSelection: [bad],
      }).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  /**
   * **Capped.** P9-5 is on the ledger for the opposite — staged cards were uncapped and 120 of them
   * at 100 KB each was 12 MB of config read on every start. This file is rewritten whenever the
   * filter changes, so an unbounded list is an unbounded write on a keystroke.
   */
  it('refuses a selection naming more projects than the cap', () => {
    const many = Array.from({ length: 513 }, (_, at) => ({ rootId: 'soil', segments: [`p${at}`] }))
    expect(validateUiState({
      pathKeys: [], projectColumns: [], stagedCards: [], boardSelection: many,
    }).ok).toBe(false)
    expect(validateUiState({
      pathKeys: [], projectColumns: [], stagedCards: [], boardSelection: many.slice(0, 512),
    }).ok).toBe(true)
  })
})

/**
 * **P9-6 — a key this build does not recognise survives the next save.**
 *
 * security review, P9 review: *"A misspelled optional config key silently defaults, and the next write
 * persists the emptiness."*
 *
 * **The misspelling is not what loses the data — the next save is.** Reading defaults an absent key;
 * writing emits the parsed shape and nothing else. So the loss happens on the first thing the person
 * does afterwards, with no error and nothing to notice, and the key they meant to set is gone.
 *
 * It is not only typos. A file written by a **newer build**, opened by an older one, has exactly
 * this shape — and older builds exist the moment there is a second one.
 */
describe('a config key this build does not know is carried, not dropped', () => {
  const loadedValue = async (path: string): Promise<UiStateFile> => {
    const read = await readUiState(path)
    expect(read.kind, 'the file did not load').toBe('loaded')
    if (read.kind !== 'loaded') throw new Error('not loaded')
    return read.config
  }

  it('survives a read and a write', async () => {
    const path = join(dir, 'ui-state.json')
    await fsp.writeFile(path, JSON.stringify({
      pathKeys: [],
      projectColumns: [{ id: 'active', name: 'Active' }],
      // Misspelled — this build reads `stagedCards` — plus a key from an imagined newer build.
      stagedCarsd: [{ id: 'staged-1', name: 'A plan', body: '', columnId: 'active' }],
      somethingFromALaterVersion: { enabled: true },
    }, null, 2))

    const value = await loadedValue(path)
    expect((await writeConfig(path, value)).ok).toBe(true)

    const after = JSON.parse(await fsp.readFile(path, 'utf8')) as Record<string, unknown>
    expect(after['stagedCarsd'], 'the misspelled key was erased by the save').toBeDefined()
    expect(after['somethingFromALaterVersion'], 'a newer build\'s key was erased')
      .toEqual({ enabled: true })
    // And the keys this build does know are still written from the parsed values.
    expect(after['projectColumns']).toEqual([{ id: 'active', name: 'Active' }])
    // `carried` is bookkeeping about the file, never part of it.
    expect(after['carried'], 'the bookkeeping field reached the disk').toBeUndefined()
  })

  it('adds no key to an ordinary file', async () => {
    // The common case must round-trip cleanly, or every install grows a `carried` field on first
    // save and then carries it forever.
    const path = join(dir, 'ordinary.json')
    await fsp.writeFile(path, JSON.stringify({
      pathKeys: [], projectColumns: [], stagedCards: [], boardSelection: [],
    }, null, 2))

    await writeConfig(path, await loadedValue(path))

    const after = JSON.parse(await fsp.readFile(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(after).sort())
      .toEqual(['boardSelection', 'pathKeys', 'projectColumns', 'stagedCards'])
  })

  it('lets a known key win over a carried one of the same name', async () => {
    // Only reachable if the parser changes between a read and a write, which is exactly when it
    // matters: the parsed value has been validated and the carried one has not.
    const path = join(dir, 'both.json')
    await fsp.writeFile(path, JSON.stringify({
      pathKeys: [], projectColumns: [], stagedCards: [], boardSelection: [], extra: 1,
    }, null, 2))

    const forged = { ...await loadedValue(path), carried: { extra: 2, projectColumns: 'nonsense' } }
    await writeConfig(path, forged)

    const after = JSON.parse(await fsp.readFile(path, 'utf8')) as Record<string, unknown>
    expect(after['projectColumns'], 'a carried value overwrote a parsed one').toEqual([])
    expect(after['extra']).toBe(2)
  })
})
