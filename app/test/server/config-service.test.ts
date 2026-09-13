import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IndexStore } from '../../src/core/index-store'
import { loadConfigService, restoreRegisteredRoots } from '../../src/server/config-service'
import { createRootRegistry } from '../../src/server/root-registry'
import { createServices, type Services } from '../../src/server/services'
import type { ConfigService } from '../../src/server/config-service'

/**
 * The app remembering itself across a restart. Spec §13.8, phase item J.
 *
 * **This suite exists because `config-store.ts` was complete, tested, mutation-swept and imported
 * by nothing.** Registered folders lived in a `Map` and were gone when the process stopped: add a
 * folder, be told it worked, restart, and it is forgotten. The brief said item J was *"implemented
 * here and verified end-to-end at P9"* — P9 would have been the first moment anyone noticed.
 *
 * So the central test below does not check that a function was called. It **stands the whole thing
 * up twice** against the same files, which is the only way to prove a restart.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree per test.
 */
let sandbox: string
let stateDir: string
let registryPath: string
let uiStatePath: string

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-cfg-'))
  stateDir = join(sandbox, 'state')
  await fsp.mkdir(stateDir, { recursive: true })
  registryPath = join(stateDir, 'registry.json')
  uiStatePath = join(stateDir, 'ui-state.json')
})

afterEach(async () => {
  // The 0555 test can leave the state directory unwritable; put it back so the cleanup succeeds.
  await fsp.chmod(stateDir, 0o755).catch(() => { /* already gone or already writable */ })
  await fsp.rm(sandbox, { recursive: true, force: true })
})

/**
 * One run of the app's composition, as far as the config reaches. Calling it twice is a restart.
 *
 * Everything is rebuilt — a fresh registry, a fresh index, a fresh config service — because a test
 * that reuses the in-memory registry proves nothing about what survived on disk.
 */
interface Run {
  readonly services: Services
  readonly config: ConfigService
  readonly index: IndexStore
  readonly restored: readonly string[]
  readonly failedToRestore: readonly { readonly id: string; readonly reason: string }[]
}

async function startApp(): Promise<Run> {
  const registry = createRootRegistry({ reservedPaths: [registryPath, uiStatePath], browsableRoots: [], browsableRootsResolved: [] })
  const index = new IndexStore()
  const config = await loadConfigService({ registryPath, uiStatePath })
  const services = createServices(registry, index, {
    stagingRoot: join(sandbox, 'app-scratch'),
    archiveRoot: join(sandbox, 'app-archive'),
      // §11's browsable area, pointed INSIDE this test's sandbox. Never the real home directory:
      // these suites are not about browsing, and a scope that reached `$HOME` would make an
      // unrelated test capable of listing the user's disk.
      browseScope: { home: join(sandbox, 'browse-home'), volumes: join(sandbox, 'browse-volumes') },
  }, config)
  const report = await restoreRegisteredRoots(config, registry, index)
  return { services, config, index, restored: report.restored, failedToRestore: report.failed }
}

/** A folder with a document in it, outside the state directory. */
async function makeFolder(name: string): Promise<string> {
  const path = join(sandbox, name)
  await fsp.mkdir(join(path, 'nested'), { recursive: true })
  await fsp.writeFile(join(path, 'notes.md'), '# Notes\n\nsomething worth indexing\n')
  await fsp.writeFile(join(path, 'nested', 'deep.md'), '# Deep\n')
  return path
}

describe('THE FOLDER LIST SURVIVES A RESTART — §13.8, item J', () => {
  it('THE ONE THAT MATTERS: a folder registered in one run is there in the next, indexed', async () => {
    const folder = await makeFolder('the-orchard')

    const first = await startApp()
    await first.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })
    expect(first.services['folders.list']().map(f => f.id)).toEqual(['orchard'])

    // The process stops. Nothing is carried over but the files on disk.
    const second = await startApp()

    expect(second.restored).toEqual(['orchard'])
    expect(second.services['folders.list']().map(f => f.id)).toEqual(['orchard'])
    /**
     * **And indexed, not merely listed.** Restoring the registration without indexing would give
     * back a folder whose every read route answers `[]` — the `indexRoot` defect, reintroduced at
     * startup instead of at registration. An empty-but-successful result standing in for something
     * that never happened is §6's banned shape wherever it appears.
     */
    const children = second.services['tree.children']({ rootId: 'orchard', segments: [] })
    expect(children.map(c => c.name).sort()).toEqual(['nested', 'notes.md'])
  })

  it('a folder removed in one run is not back in the next', async () => {
    const folder = await makeFolder('the-orchard')

    const first = await startApp()
    await first.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })
    await first.services['folders.deregister']({ id: 'orchard' })

    const second = await startApp()
    expect(second.services['folders.list']()).toEqual([])
    // But the record that it was ever registered survives — M7's append, on disk.
    expect(second.config.registry().deregistered.map(r => r.id)).toEqual(['orchard'])
  })

  it('restores a folder that has no backup, WITHOUT re-asking §11\'s question', async () => {
    /**
     * The sandbox is not a git repository, so §11's backup check refuses it without an override.
     * the operator answered that question once, by typing through it. There is no human at startup and
     * no prompt to show one, so re-asking would mean **silently refusing to restore every folder
     * that is not in git** — a safety warning turned into the loss it exists to prevent.
     */
    const folder = await makeFolder('no-git-here')
    const first = await startApp()
    await first.services['folders.register']({
      id: 'nogit', absolutePath: folder
    })

    const second = await startApp()
    expect(second.restored).toEqual(['nogit'])
  })

  it('KEEPS a folder it could not restore, rather than dropping it', async () => {
    /**
     * §13.8's retained-not-dropped rule, applied to the registry. An external drive unplugged this
     * morning is plugged in this afternoon; deleting the entry because the path did not resolve
     * once would make an unplugged drive permanently erase the fact it was ever registered.
     */
    const folder = await makeFolder('on-a-drive')
    const first = await startApp()
    await first.services['folders.register']({
      id: 'drive', absolutePath: folder
    })

    await fsp.rm(folder, { recursive: true, force: true })   // the drive is unplugged

    const second = await startApp()
    expect(second.restored).toEqual([])
    expect(second.failedToRestore.map(f => f.id)).toEqual(['drive'])
    expect(second.services['folders.list'](), 'not registered').toEqual([])
    expect(second.config.registry().roots.map(r => r.id), 'but still on the record').toEqual(['drive'])

    // And it comes back when the drive does. Nothing had to be re-added by hand.
    await makeFolder('on-a-drive')
    const third = await startApp()
    expect(third.restored).toEqual(['drive'])
  })
})

describe('A DAMAGED FILE IS PRESERVED, never overwritten — §13.8', () => {
  const DAMAGED = '{ "roots": [ {"id": "orchard", "absolutePa'

  it('starts, reports the damage, and registers nothing', async () => {
    await fsp.writeFile(registryPath, DAMAGED)
    const run = await startApp()

    expect(run.config.registryDamage, 'the damage is carried, not thrown').not.toBeNull()
    expect(run.services['folders.list'](), 'and no folder is invented').toEqual([])
  })

  it('THE ONE THAT MATTERS: a write is refused, and the damaged bytes are untouched', async () => {
    /**
     * §13.8: *"a config that fails to parse is preserved and surfaced, never silently replaced with
     * defaults, which would deregister everything."* The dangerous version of this bug is not the
     * failed read — it is the **helpful** write afterwards: come up empty, then save that emptiness
     * over the only record of what was registered.
     *
     * So registering must fail rather than succeed-and-overwrite, and the file must be byte-for-byte
     * what it was.
     */
    await fsp.writeFile(registryPath, DAMAGED)
    const run = await startApp()
    const folder = await makeFolder('the-orchard')

    await expect(run.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })).rejects.toThrow()

    expect(await fsp.readFile(registryPath, 'utf8')).toBe(DAMAGED)
    expect(run.services['folders.list'](), 'and nothing is left half-registered').toEqual([])
  })

  it('damage to the layout file does not disable the folder list', async () => {
    // Two files, and this is the point of two files: the frequent, careless writer cannot take the
    // rare, precious record down with it.
    await fsp.writeFile(uiStatePath, 'not json at all')
    const run = await startApp()
    expect(run.config.uiStateDamage).not.toBeNull()
    expect(run.config.registryDamage).toBeNull()

    const folder = await makeFolder('the-orchard')
    await run.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })
    expect(run.services['folders.list']().map(f => f.id)).toEqual(['orchard'])

    const next = await startApp()
    expect(next.restored).toEqual(['orchard'])
  })
})

describe('a registration that cannot be remembered is not a registration', () => {
  it('rolls back when the write fails, rather than claiming a folder it will forget', async () => {
    /**
     * The honest answer to a failed config write. A folder registered in memory and absent from
     * disk is one the app says it has and will not remember — which is the exact silent forgetting
     * this whole wiring exists to end, arriving one restart later instead of immediately.
     *
     * Provoked by making the state directory unwritable, which is a real cause: permissions changed
     * by something else, or a volume mounted read-only.
     */
    const folder = await makeFolder('the-orchard')
    const run = await startApp()
    await fsp.chmod(stateDir, 0o555)

    await expect(run.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })).rejects.toThrow()

    expect(run.services['folders.list'](), 'not registered').toEqual([])
    expect(run.index.size, 'and its index rows are gone with it').toBe(0)
    /**
     * **Memory follows disk, never the other way round.** If the in-memory config had taken the
     * change before the write was known to have landed, this would hold a folder that is on no
     * disk anywhere — and the next successful write, for anything at all, would put it there.
     */
    expect(run.config.registry().roots, 'and the in-memory record did not move either').toEqual([])
  })

  it('a deregistration that cannot be written leaves the folder registered', async () => {
    /**
     * The mirror of the above, and the reason the two verbs write in opposite orders. Rolling a
     * removal back would mean re-registering — an async probe of a path that may have changed —
     * so a rollback that can itself fail. Writing first means a failed write changes nothing.
     */
    const folder = await makeFolder('the-orchard')
    const run = await startApp()
    await run.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })
    await fsp.chmod(stateDir, 0o555)

    await expect(run.services['folders.deregister']({ id: 'orchard' })).rejects.toThrow()
    expect(run.services['folders.list']().map(f => f.id), 'still there').toEqual(['orchard'])
    expect(run.index.size, 'and still readable').toBeGreaterThan(0)
  })
})

describe('the saved layout follows the paths it describes — §13.8', () => {
  it('a rename retargets the keys, and the retarget is on disk', async () => {
    const folder = await makeFolder('the-orchard')
    await fsp.mkdir(join(folder, 'projects', 'old-name'), { recursive: true })

    const first = await startApp()
    await first.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })
    // The board arrangement the user made by hand, keyed by project path.
    await first.config.updateUiState(current => ({
      ...current,
      pathKeys: [{ rootId: 'orchard', segments: ['projects', 'old-name'], value: { column: 3 } }],
    }))

    await first.services['entry.rename']({
      rootId: 'orchard', from: ['projects', 'old-name'], to: ['projects', 'new-name'],
      token: first.services['tree.entry'](
        { rootId: 'orchard', segments: ['projects', 'old-name'] }).token,
    })

    // Survives the restart, pointing at the new name. Without the retarget the key would be
    // orphaned and the column arrangement would silently revert to the default.
    const second = await startApp()
    expect(second.config.uiState().pathKeys).toEqual([
      { rootId: 'orchard', segments: ['projects', 'new-name'], value: { column: 3 } },
    ])
  })

  it('a REFUSED rename leaves the keys alone', async () => {
    /**
     * The other half, and the reason the retarget runs *after* the rename rather than before.
     * A rename failing is ordinary — a name collision produces one — so retargeting first would
     * scramble the arrangement on the common path to guard against a crash on the rare one.
     */
    const folder = await makeFolder('the-orchard')
    await fsp.mkdir(join(folder, 'projects', 'old-name'), { recursive: true })
    await fsp.mkdir(join(folder, 'projects', 'taken'), { recursive: true })

    const run = await startApp()
    await run.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })
    const keys = [{ rootId: 'orchard', segments: ['projects', 'old-name'], value: { column: 3 } }]
    await run.config.updateUiState(current => ({ ...current, pathKeys: keys }))

    await expect(run.services['entry.rename']({
      rootId: 'orchard', from: ['projects', 'old-name'], to: ['projects', 'taken'],
      // Valid, so the refusal below is the collision and not a stale target.
      token: run.services['tree.entry'](
        { rootId: 'orchard', segments: ['projects', 'old-name'] }).token,
    })).rejects.toThrow()

    expect(run.config.uiState().pathKeys).toEqual(keys)
  })
})

describe('a key whose path is gone is RETAINED and marked — §13.8', () => {
  const seedKey = async (run: Run, segments: string[]) => {
    await run.config.updateUiState(current => ({
      ...current,
      pathKeys: [{ rootId: 'orchard', segments, value: { column: 3 } }],
    }))
  }

  it('marks it at startup rather than dropping it, and clears the mark when it returns', async () => {
    /**
     * The build plan names the case this protects: during the copy-first trial week every key
     * points into the copy, so switching to the real tree makes them all unresolved at once. A
     * build that dropped them would discard a week of arrangement in one startup.
     */
    const folder = await makeFolder('the-orchard')
    await fsp.mkdir(join(folder, 'projects', 'a-project'), { recursive: true })

    const first = await startApp()
    await first.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })
    await seedKey(first, ['projects', 'a-project'])

    // Restarting while the path still exists leaves it alone.
    const second = await startApp()
    expect(second.config.uiState().pathKeys[0]?.unresolved).toBeUndefined()

    // Now it is gone — an agent archived the project, or the drive is unplugged.
    await fsp.rm(join(folder, 'projects', 'a-project'), { recursive: true, force: true })
    const third = await startApp()
    expect(third.config.uiState().pathKeys, 'retained, never dropped').toHaveLength(1)
    expect(third.config.uiState().pathKeys[0]?.unresolved).toBe(true)

    // And back again. A mark that is never cleared teaches the user to ignore the warning.
    await fsp.mkdir(join(folder, 'projects', 'a-project'), { recursive: true })
    const fourth = await startApp()
    expect(fourth.config.uiState().pathKeys[0]?.unresolved).toBeUndefined()
    expect(fourth.config.uiState().pathKeys[0]?.value).toEqual({ column: 3 })
  })

  it('does not rewrite the layout file when nothing changed', async () => {
    /**
     * An unconditional write every boot would put the registry's frequent-writer hazard onto a file
     * the app had no reason to touch. The inode is the evidence: an atomic write installs a new one.
     */
    const folder = await makeFolder('the-orchard')
    await fsp.mkdir(join(folder, 'projects', 'a-project'), { recursive: true })
    const first = await startApp()
    await first.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })
    await seedKey(first, ['projects', 'a-project'])

    await startApp()
    const before = await fsp.stat(uiStatePath, { bigint: true })
    await startApp()
    const after = await fsp.stat(uiStatePath, { bigint: true })
    expect(after.ino).toBe(before.ino)
  })

  it('does not rewrite the registry file for a change that changes nothing', async () => {
    /**
     * The same rule on the other file, and it is reachable: `deregisterRoot` returns its input
     * untouched for an id that is not in the list. Found by a mutation sweep that showed the
     * registry's half of this guard asserted by nothing while the layout file's half was covered.
     */
    const folder = await makeFolder('the-orchard')
    const run = await startApp()
    await run.services['folders.register']({
      id: 'orchard', absolutePath: folder
    })
    const before = await fsp.stat(registryPath, { bigint: true })

    await run.config.updateRegistry(current => current)
    expect((await fsp.stat(registryPath, { bigint: true })).ino).toBe(before.ino)
  })
})

describe('concurrent updates do not lose each other', () => {
  it('applies every change, even when they are issued at once', async () => {
    /**
     * Read-change-write is the shape the mutation lock exists for, and config is not exempt. Two
     * updates that each capture the current value and write it back would interleave: the second
     * write lands the first's stale copy, and one of the two changes is gone with no error
     * anywhere. **That is M7's loss with no stale file involved — just two callers racing.**
     *
     * Which is why the change function is applied *inside* the queue, against whatever the state is
     * by then, rather than against a value the caller captured beforehand.
     */
    const run = await startApp()
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => run.config.updateUiState(current => ({
        ...current,
        pathKeys: [...current.pathKeys, { rootId: 'r', segments: [`k${i}`], value: i }],
      }))),
    )

    expect(run.config.uiState().pathKeys).toHaveLength(10)
    const next = await startApp()
    expect(next.config.uiState().pathKeys, 'and all ten are on disk').toHaveLength(10)
  })
})

/**
 * **"NOTHING REGISTERED" AND "THE RECORD IS DAMAGED" ARE DIFFERENT ANSWERS.** The security review, P11 C4.
 *
 * The server has always kept them apart — `config-store.ts`: *"a missing file is first run and the
 * right response is defaults; an unparseable one is a damaged record and the right response is to
 * stop and say so"* — and the distinction **stopped at the wire**. Both produce
 * `folders.list() === []`.
 *
 * That was harmless until P11 made the first thing in the app to *act* on an empty list: §17's
 * welcome card, which would greet someone whose folder list had just failed to load as a brand-new
 * user, over one button that is then refused. `config-store.ts` wrote the rule two phases ago:
 * *"reading it as 'no folders' is precisely the total loss §13.8 forbids."* Nothing is lost on
 * disk; what is lost is the ability to know that.
 */
describe('config.health — telling first run apart from a damaged record', () => {
  it('reports healthy when nothing has ever been registered', async () => {
    // The genuine first run: no file has ever been written.
    const app = await startApp()
    expect(app.services['folders.list']()).toEqual([])
    expect(app.services['config.health']().registryDamaged).toBe(false)
  })

  it('reports healthy when folders are registered and readable', async () => {
    const first = await startApp()
    await first.services['folders.register']({ id: 'alpha', absolutePath: await makeFolder('alpha') })
    const second = await startApp()
    expect(second.services['folders.list']().length).toBe(1)
    expect(second.services['config.health']().registryDamaged).toBe(false)
  })

  /**
   * **Four damage shapes, because one proves the branch and four prove the class.** Each is a way a
   * real file goes wrong — a write cut short, a hand edit, a key renamed, an empty file left by a
   * failed truncate — and every one must report damaged rather than empty.
   */
  it('reports damaged for every shape of an unreadable record, not empty', async () => {
    const damage: Record<string, string> = {
      'truncated mid-write': '{"roots":[{"id":"alpha","absolutePath":"/tmp/a"',
      'not an object at all': '"a string"',
      'the roots key renamed': '{"rootz":[]}',
      'an empty file': '',
    }
    for (const [shape, bytes] of Object.entries(damage)) {
      await fsp.writeFile(registryPath, bytes)
      const app = await startApp()
      expect(app.services['folders.list'](), `${shape}: folders`).toEqual([])
      expect(app.services['config.health']().registryDamaged, `${shape}: damaged`).toBe(true)
    }
  })

  /**
   * **The bytes survive.** This is the half §13.8 actually cares about, and it is why the app
   * refuses to write rather than "helpfully" starting empty and saving the emptiness.
   */
  it('leaves the damaged file exactly as it found it', async () => {
    const original = '{"roots":[{"id":"alpha","absolutePath":"/tmp/a"'
    await fsp.writeFile(registryPath, original)
    const app = await startApp()
    // A registration attempt is refused, and the file is untouched by it.
    await app.services['folders.register']({ id: 'beta', absolutePath: await makeFolder('beta') })
      .catch(() => { /* refused, which is the point */ })
    expect(await fsp.readFile(registryPath, 'utf8')).toBe(original)
  })
})
