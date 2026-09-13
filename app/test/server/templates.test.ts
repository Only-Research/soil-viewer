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

/**
 * **TEMPLATES, ON THE SERVER.** Phase 8.
 *
 * A template is a **named pointer to a folder**, and that is the operator's requirement rather than an
 * implementation shortcut: *"that template might change… these things take shape."* A snapshot
 * would mean an update step and a template that drifts from the folder it came from; a pointer is
 * always whatever the folder is today.
 *
 * There are three verbs and deliberately no fourth. **Scaffolding is `entry.copy`** — a template is
 * a folder, so making one is a recursive copy of a folder, and that engine has had a pre-flight, a
 * staging directory, an exclusive rename and a mutation sweep since P4. A `templates.instantiate`
 * would be a second way to copy a directory tree, which is the shape the P7 review named: the
 * danger is rarely a divergent implementation, it is a caller that does the job itself instead of
 * going through the chokepoint. The last test here proves the copy really is that chokepoint.
 */

let sandbox: string
let rootPath: string
let registry: RootRegistry
let config: ConfigService
let index: IndexStore
let services: Services

/** The op template's shape, small enough to assert and real enough to be the same problem. */
async function seedTemplate(at: string): Promise<void> {
  await fsp.mkdir(join(at, '00-context'), { recursive: true })
  await fsp.mkdir(join(at, '01-inbox'), { recursive: true })
  await fsp.writeFile(join(at, '00-context', 'context-template.md'), '# context\n')
  // The empty folder exists in git ONLY because of this file. §3's dot rule was skipping it.
  await fsp.writeFile(join(at, '01-inbox', '.gitkeep'), '')
}

beforeEach(async () => {
  // `realpath` first: on macOS `tmpdir()` is `/var/folders/…` and `/var` is a symlink to
  // `/private/var`. Registration compares against realpath's answer, so the two spellings diverge.
  sandbox = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'soil-templates-')))
  rootPath = join(sandbox, 'soil')
  await fsp.mkdir(join(rootPath, 'templates'), { recursive: true })
  await fsp.mkdir(join(rootPath, 'projects'), { recursive: true })
  await seedTemplate(join(rootPath, 'templates', 'op-template'))
  await fsp.writeFile(join(rootPath, 'a-file.md'), '# not a folder\n')

  registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)

  /**
   * **Indexed, because the scaffold path needs a token and a token comes from a row.**
   *
   * `folders.register` indexes as part of registering; this fixture registers the root directly, so
   * it has to do the same or `tree.entry` answers out of an empty index. Getting that wrong would
   * have made the scaffold tests fail for a fixture reason and read as a broken feature.
   */
  index = new IndexStore()
  await indexRegisteredRoot(registered.value, index)

  config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })

  services = createServices(registry, index, {
    stagingRoot: join(sandbox, 'app-scratch'),
    archiveRoot: join(sandbox, 'app-archive'),
    browseScope: { home: sandbox, volumes: join(sandbox, 'volumes') },
  }, config)
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const codeOf = (work: Promise<unknown>) =>
  work.then(() => null, (error: unknown) => refusalCodeOf(error))

const registerOp = () => services['templates.register']({
  id: 'op', name: 'Op', rootId: 'soil', segments: ['templates', 'op-template'],
})

/**
 * Scaffolds from a template **exactly as the client will**, and the two steps are the point.
 *
 * `entry.copy` requires §13.8's entity token — *"as the client was last shown it on the target's
 * row… required, never optional. An optional token is a control the client can switch off by
 * omission."* A template is named by the registry rather than by a row, so the caller has to go and
 * read the row first. That is not a workaround: it is the contract doing its job, and it means a
 * template whose folder was renamed or replaced since cannot be scaffolded from a stale idea of it.
 *
 * The first version of these tests skipped this and every one of them failed `STALE_TARGET`.
 */
const scaffold = async (segments: readonly string[], to: readonly string[]) => {
  const row = services['tree.entry']({ rootId: 'soil', segments: [...segments] })
  return services['entry.copy']({
    rootId: 'soil', from: [...segments], to: [...to], plan: false, token: row.token,
  })
}

describe('naming a folder as a template', () => {
  it('stores it and reports it back', async () => {
    const made = await registerOp()
    expect(made).toEqual({
      id: 'op', name: 'Op', rootId: 'soil',
      segments: ['templates', 'op-template'], available: true,
    })
    expect(services['templates.list']()).toEqual([made])
  })

  /**
   * **It survives a restart, and that is the whole point of putting it in the registry file.**
   *
   * The folder list was an in-memory `Map` until 2026-08-08 — add a folder, stop the app, it is
   * forgotten — because `config-store.ts` was complete and imported by nothing. A template registry
   * that only lived in memory would be the same defect, rebuilt.
   */
  it('survives a reload of the config from disk', async () => {
    await registerOp()
    const reloaded = await loadConfigService({
      registryPath: join(sandbox, 'registry.json'),
      uiStatePath: join(sandbox, 'ui-state.json'),
    })
    expect(reloaded.registry().templates).toEqual([{
      id: 'op', name: 'Op', rootId: 'soil', segments: ['templates', 'op-template'],
    }])
  })

  it('refuses a folder that is not registered', async () => {
    expect(await codeOf(services['templates.register']({
      id: 'x', name: 'X', rootId: 'nowhere', segments: ['templates'],
    }))).toBe(ErrorCode.INVALID_ROOT)
  })

  it('refuses a path that does not exist', async () => {
    expect(await codeOf(services['templates.register']({
      id: 'x', name: 'X', rootId: 'soil', segments: ['templates', 'no-such-template'],
    }))).not.toBeNull()
  })

  /** A file is not a shape. The picker offers folders, so this is a backstop rather than a path. */
  it('refuses a file', async () => {
    expect(await codeOf(services['templates.register']({
      id: 'x', name: 'X', rootId: 'soil', segments: ['a-file.md'],
    }))).toBe(ErrorCode.INVALID_ROOT)
  })

  /**
   * An empty `segments` names the whole registered folder — a template of a root, which would
   * scaffold a root into its own subtree.
   */
  it('refuses a template of the whole registered folder', async () => {
    expect(await codeOf(services['templates.register']({
      id: 'x', name: 'X', rootId: 'soil', segments: [],
    }))).toBe(ErrorCode.PATH_EMPTY);
  })

  it('refuses a blank name', async () => {
    expect(await codeOf(services['templates.register']({
      id: 'x', name: '   ', rootId: 'soil', segments: ['templates', 'op-template'],
    }))).toBe(ErrorCode.NAME_EMPTY)
  })

  /**
   * **Two identically-named templates make a menu where the right choice cannot be identified.**
   *
   * The same reasoning that split `ROOT_ALREADY_REGISTERED` out of `INVALID_ROOT` in the P7 review:
   * a refusal has to tell you something you can act on, or you re-pick forever learning nothing.
   * The id and the name are different problems and both are refused.
   */
  it('refuses a duplicate name, and says which name', async () => {
    await registerOp()
    const refusal = await services['templates.register']({
      id: 'op2', name: 'Op', rootId: 'soil', segments: ['templates', 'op-template'],
    }).then(() => null, (error: unknown) => error)
    expect((refusal as Error).message).toContain('Op')
  })

  /**
   * **P8-9.** `é` is one code point in NFC (U+00E9) and two in NFD (`e` + U+0301). macOS hands back
   * both spellings depending on where a name came from, and they render **identically**. Byte
   * equality let the second one register, producing two menu entries a person cannot tell apart —
   * exactly what the refusal above exists to prevent.
   */
  it('refuses a name that only differs by unicode normalisation', async () => {
    await services['templates.register']({
      id: 'nfc', name: 'Caf\u00e9', rootId: 'soil', segments: ['templates', 'op-template'],
    })
    const decomposed = 'Cafe\u0301'
    expect(decomposed).not.toBe('Caf\u00e9')
    expect(decomposed.normalize('NFC')).toBe('Caf\u00e9')

    expect(await codeOf(services['templates.register']({
      id: 'nfd', name: decomposed, rootId: 'soil', segments: ['templates', 'op-template'],
    }))).toBe(ErrorCode.INVALID_ROOT)
  })

  it('refuses a name that only differs by case', async () => {
    await registerOp()
    expect(await codeOf(services['templates.register']({
      id: 'op2', name: 'op', rootId: 'soil', segments: ['templates', 'op-template'],
    }))).toBe(ErrorCode.INVALID_ROOT)
  })

  /**
   * **The other half, and the reason `grammarKey` was not used here.**
   *
   * `grammarKey` strips a leading `NN-` prefix, and every other name comparison in the app goes
   * through it — which is why the finding's note suggested it. It would be wrong here: these two
   * are not confusable in a menu, they are different names, and refusing the second is a false
   * refusal rather than a fix. §3's prefix rule is about folder grammar; a template's name is a
   * label somebody typed.
   */
  it('does NOT refuse a name that differs only by a numeric prefix', async () => {
    await registerOp()
    const made = await services['templates.register']({
      id: 'op2', name: '01-Op', rootId: 'soil', segments: ['templates', 'op-template'],
    })
    expect(made.name).toBe('01-Op')
  })

  /**
   * **P8-11 — the registry has a ceiling.** The security review marked it Trivial and put it with G5, which is the
   * useful framing: cost, not containment. Every template is a row in the `⋯` menu of **every**
   * folder in the tree, so four hundred of them is a menu nobody can use, reached without a single
   * refusal.
   */
  it('refuses a template once the registry is full, and names the limit', async () => {
    for (let i = 0; i < 64; i++) {
      await services['templates.register']({
        id: `t${i}`, name: `T${i}`, rootId: 'soil', segments: ['templates', 'op-template'],
      })
    }
    const refusal = await services['templates.register']({
      id: 'one-too-many', name: 'One too many', rootId: 'soil',
      segments: ['templates', 'op-template'],
    }).then(() => null, (error: unknown) => error)

    expect(refusal, 'the 65th template registered').not.toBeNull()
    // The only action left is removing one, so the refusal has to say how many there is room for.
    expect((refusal as Error).message).toContain('64')
  })

  it('accepts templates well under the cap', async () => {
    // The other half: a ceiling that refuses ordinary use is worse than no ceiling.
    for (let i = 0; i < 10; i++) {
      const made = await services['templates.register']({
        id: `u${i}`, name: `U${i}`, rootId: 'soil', segments: ['templates', 'op-template'],
      })
      expect(made.name).toBe(`U${i}`)
    }
  })

  it('refuses a duplicate id', async () => {
    await registerOp()
    expect(await codeOf(services['templates.register']({
      id: 'op', name: 'Different', rootId: 'soil', segments: ['templates', 'op-template'],
    }))).toBe(ErrorCode.INVALID_ROOT)
  })

  /** The name is what a person reads; leading and trailing space is not part of it. */
  it('trims the name', async () => {
    const made = await services['templates.register']({
      id: 'op', name: '  Op  ', rootId: 'soil', segments: ['templates', 'op-template'],
    })
    expect(made.name).toBe('Op')
  })
})

describe('forgetting a template', () => {
  it('removes the entry', async () => {
    await registerOp()
    await services['templates.deregister']({ id: 'op' })
    expect(services['templates.list']()).toEqual([])
  })

  /**
   * **THE FOLDER IS UNTOUCHED.** The name reads like a removal and this app has none. The operator:
   * *"nothing gets deleted, no files get deleted, I move them, they get archived."*
   */
  it('does not touch the folder it pointed at', async () => {
    await registerOp()
    await services['templates.deregister']({ id: 'op' })
    const still = await fsp.stat(join(rootPath, 'templates', 'op-template'))
    expect(still.isDirectory()).toBe(true)
  })

  it('refuses an id it does not hold', async () => {
    expect(await codeOf(services['templates.deregister']({ id: 'ghost' })))
      .toBe(ErrorCode.INVALID_ROOT)
  })
})

describe('a template whose folder is no longer registered', () => {
  /**
   * **Reported, not filtered.** A template that silently vanishes from Settings looks like data
   * loss; one that is offered and then fails looks like a bug. `available: false` is neither.
   *
   * And it is recoverable: `folderIdFor` derives a root id from the folder's own last segment, so
   * re-adding the same folder makes its templates work again. Dropping them on deregistration
   * would throw away the user's naming work over a folder they might be re-adding in ten seconds.
   */
  it('is still listed, marked unavailable', async () => {
    await registerOp()
    await services['folders.deregister']({ id: 'soil' })

    const listed = services['templates.list']()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.available).toBe(false)
  })
})

describe('scaffolding, which is entry.copy and nothing new', () => {
  /**
   * **THE END-TO-END CLAIM.** A template is a pointer; making one is copying the folder it points
   * at. If this test needs anything the copy does not already do, the design is wrong.
   */
  it('reproduces the template under a name the caller chose', async () => {
    const template = await registerOp()

    await scaffold(template.segments, ['projects', 'op-hollis-outreach'])

    const made = join(rootPath, 'projects', 'op-hollis-outreach')
    expect((await fsp.stat(made)).isDirectory()).toBe(true)
    // Verbatim — the operator: no renaming of any files. `context-template.md` stays as it is.
    expect(await fsp.readFile(join(made, '00-context', 'context-template.md'), 'utf8'))
      .toBe('# context\n')
  })

  /**
   * **The empty folder has to arrive with its `.gitkeep`.** Git cannot record an empty directory,
   * so without this the scaffolded op has the right shape on disk and the wrong shape in the
   * repository — right in Finder, right in the app, and gone from a clone.
   */
  it('carries .gitkeep, so the empty folders exist in git too', async () => {
    const template = await registerOp()
    await scaffold(template.segments, ['projects', 'op-hollis-outreach'])
    const kept = join(rootPath, 'projects', 'op-hollis-outreach', '01-inbox', '.gitkeep')
    expect((await fsp.stat(kept)).isFile()).toBe(true)
  })

  /**
   * §13.7's exclusive rename, reached through the template path. Scaffolding twice into the same
   * name is refused rather than merged or overwritten — and nothing partial is left behind.
   */
  /**
   * **P8-8, and the finding turns out to understate it — measured 2026-08-14 before fixing.**
   *
   * the security review filed it as *"`templates.register` accepts a §3-ignored folder: registers, shows
   * `available: true`, can never be scaffolded"* — a dead entry in a menu, which is Low.
   *
   * **Measured before fixing, and the security review is right.** I read the copy's ignore rule as applying to
   * paths *relative to the source* — which would mean the source folder's own name is never tested,
   * and scaffolding `node_modules` would write its contents into the tree under a chosen name. That
   * would have been a worse finding than the one filed, so it was **run** rather than reasoned
   * about: the scaffold is refused, with `IO_FAILED: no such entry`. §3 keeps the folder out of the
   * index, and the copy resolves through the index.
   *
   * **So the defect is the one filed, and its harm is entirely about what a person is told.** The
   * template registers, appears in the menu marked available, and then fails on use with *"no such
   * entry"* — about a folder they can see in Finder. §6's rule is that a refusal has to say
   * something you can act on; this one says something that is not even true from where they stand.
   */
  it('a §3-ignored folder cannot be named as a template at all', async () => {
    await fsp.mkdir(join(rootPath, 'node_modules', 'some-package'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'node_modules', 'some-package', 'index.js'), 'module.exports={}')

    const refusal = await services['templates.register']({
      id: 'junk', name: 'Junk', rootId: 'soil', segments: ['node_modules'],
    }).then(() => null, (error: unknown) => error)

    expect(refusal, 'an ignored folder was accepted as a template').not.toBeNull()
    expect((refusal as Error).message.toLowerCase()).toContain('node_modules')
  })

  it('nor a folder INSIDE an ignored one', async () => {
    await fsp.mkdir(join(rootPath, 'node_modules', 'pkg', 'src'), { recursive: true })
    const refusal = await services['templates.register']({
      id: 'junk2', name: 'Junk2', rootId: 'soil', segments: ['node_modules', 'pkg', 'src'],
    }).then(() => null, (error: unknown) => error)
    expect(refusal, 'a folder inside an ignored tree was accepted').not.toBeNull()
  })

  it('refuses to scaffold over something already there', async () => {
    const template = await registerOp()
    const to = ['projects', 'op-hollis-outreach']
    await scaffold(template.segments, to)

    expect(await codeOf(scaffold(template.segments, to))).not.toBeNull()
  })
})
