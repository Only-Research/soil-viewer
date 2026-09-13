import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfigService } from '../../src/server/config-service'
import { ErrorCode } from '../../src/core/errors'
import { createRootRegistry } from '../../src/server/root-registry'
import { createServices } from '../../src/server/services'
import { IndexStore } from '../../src/core/index-store'
import { indexRoot } from '../../src/core/indexer'
import { openAppendLog } from '../../src/core/fs/append-log'

/**
 * **R2 from the Phase 2 security review**, plus the handlers that carry it.
 *
 * The finding: `openAppendLog` checks that the log sits outside every registered root, but it takes
 * the roots **once, at open time**, and `append` never re-checks. Open the log with no roots — the
 * state at startup — then register a folder containing it, and the log writes inside a registered
 * root forever. The check was real; nothing re-ran it.
 *
 * Registration is the event, so registration is where it is refused.
 */

let sandbox: string

beforeEach(async () => {
  // `realpath` because on macOS the temp directory is reached through symlinked ancestors
  // (`/var` → `/private/var`). The C2 bound compares where a candidate RESOLVES against where the
  // area resolves, so a fixture holding the unresolved spelling would refuse its own sandbox — and
  // it did, which is how the asymmetry in the check was found.
  sandbox = await fsp.realpath(
    await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-reg-')),
  )
})

afterEach(async () => {
  // Resolved, to match the sandbox: `beforeEach` realpaths it, so a raw temp base would never
  // prefix-match and this guard would refuse to clean up its own directory.
  const tempBase = await fsp.realpath(process.env['TMPDIR'] ?? tmpdir())
  const ours =
    typeof sandbox === 'string' &&
    sandbox.length > tempBase.length &&
    sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-reg-')
  if (!ours) throw new Error(`refusing to recursively delete: ${String(sandbox)}`)
  await fsp.rm(sandbox, { recursive: true, force: true })
})

/**
 * `browsableRoots: [], browsableRootsResolved: []` throughout — unbounded, stated rather than omitted.
 *
 * the security review's C2 (2026-08-09) bounded registration to the browse scope, and made the option required so
 * a bootstrap cannot forget it. These tests are about containment, overlap and the reserved-path
 * rule; bounding them would mean every fixture path had to sit under a fake `$HOME`, which tests
 * the bound rather than the rules they are named for. The bound has its own tests below.
 */

const mkdir = async (...parts: string[]): Promise<string> => {
  const path = join(sandbox, ...parts)
  await fsp.mkdir(path, { recursive: true })
  return path
}

describe('R2 — a root may not contain or sit inside the log storage', () => {
  it('refuses a root that CONTAINS the log — the exact scenario the review proved', async () => {
    // Startup order, reproduced: the log opens with no roots registered, and succeeds.
    const appStorage = await mkdir('app-storage')
    const logPath = join(appStorage, 'mutations.log')
    const log = await openAppendLog(logPath, [], { maxBytes: 1024 * 1024 })
    expect(log.ok, 'the log opens cleanly when nothing is registered yet').toBe(true)

    // Then the operator registers the folder above it — their home directory, in real life.
    const registry = createRootRegistry({ reservedPaths: [logPath], browsableRoots: [], browsableRootsResolved: [] })
    const result = await registry.register('soil', sandbox)

    expect(result.ok, 'a root containing the log must be refused').toBe(false)
    expect(registry.list(), 'and must not be registered').toHaveLength(0)
  })

  it('refuses the log\'s own directory as a root', async () => {
    // The immediate-parent case, which is likelier than the grandparent one above: someone points
    // the app at the folder the app itself keeps state in.
    const appStorage = await mkdir('app-storage')
    const registry = createRootRegistry({ reservedPaths: [join(appStorage, 'mutations.log')], browsableRoots: [], browsableRootsResolved: [] })
    expect((await registry.register('soil', appStorage)).ok).toBe(false)
  })

  it('does NOT refuse a folder that merely sits beside the log file', async () => {
    // The converse, and worth pinning: `app-storage/notes` neither contains the log nor sits
    // inside it, so nothing would be written into it. Refusing here would be over-refusal, and an
    // over-refusing control is one that gets switched off.
    const appStorage = await mkdir('app-storage')
    const beside = await mkdir('app-storage', 'notes')
    const registry = createRootRegistry({ reservedPaths: [join(appStorage, 'mutations.log')], browsableRoots: [], browsableRootsResolved: [] })
    expect((await registry.register('soil', beside)).ok).toBe(true)
  })

  it('does NOT refuse a sibling whose name merely shares a prefix', async () => {
    // Whole-segment comparison, spec §5. A raw prefix test would treat `app-storage-2` as inside
    // `app-storage` — the /soil/notes vs /soil/notes-old bug, applied to the app's own storage.
    const appStorage = await mkdir('app-storage')
    const sibling = await mkdir('app-storage-2')
    const registry = createRootRegistry({ reservedPaths: [join(appStorage, 'mutations.log')], browsableRoots: [], browsableRootsResolved: [] })
    expect((await registry.register('soil', sibling)).ok).toBe(true)
  })

  it('registers an unrelated folder normally', async () => {
    const appStorage = await mkdir('app-storage')
    const soil = await mkdir('notes')
    const registry = createRootRegistry({ reservedPaths: [join(appStorage, 'mutations.log')], browsableRoots: [], browsableRootsResolved: [] })
    const result = await registry.register('soil', soil)
    expect(result.ok).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })
})

describe('overlapping roots — spec §11', () => {
  it('refuses a root that contains one already registered', async () => {
    const parent = await mkdir('parent')
    const child = await mkdir('parent', 'child')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
    expect((await registry.register('child', child)).ok).toBe(true)
    // The same file would otherwise have two identities, two index rows and two watchers — which is
    // how a change in one view fails to appear in the other.
    expect((await registry.register('parent', parent)).ok).toBe(false)
  })

  it('ACCEPTS two roots whose names share a prefix — /soil and /soil-old are not related', async () => {
    /**
     * **THE PROOF CLAUSE `overlaps` NEVER HAD.** Replacing whole-segment containment with a raw
     * `startsWith` in either direction — the classic `/soil` vs `/soil-old` bug, named in this
     * build's own minefield map — left all 969 tests green.
     *
     * The sibling-prefix test further up looks like it covers this and does not: it goes through
     * `reservedPaths`, a different code path. Nothing registered two *roots* whose names share a
     * prefix, which is the only shape that reaches `overlaps`.
     *
     * What it costs the operator if it breaks: registering `notes-old` after `notes` is refused
     * with "this folder overlaps a folder already registered", for two folders that have nothing to
     * do with each other. Silent, total, and looks like the app is broken.
     *
     * Phase 4 edits this layer, which is why this lands before Phase 4 rather than after — a test
     * written after a change describes what the code now does, not what it is supposed to do.
     */
    const soil = await mkdir('notes')
    const soilOld = await mkdir('notes-old')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })

    expect((await registry.register('soil', soil)).ok).toBe(true)
    expect(
      (await registry.register('soil-old', soilOld)).ok,
      'a sibling sharing a name prefix is a different folder, not an overlap',
    ).toBe(true)
    expect(registry.list(), 'both are registered').toHaveLength(2)
  })

  it('and the same in the other direction — the shorter name registered second', async () => {
    // `overlaps` checks containment both ways round, so both orderings must be exercised. A
    // one-directional fix would pass the test above and fail here.
    const soilOld = await mkdir('notes-old')
    const soil = await mkdir('notes')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })

    expect((await registry.register('soil-old', soilOld)).ok).toBe(true)
    expect((await registry.register('soil', soil)).ok).toBe(true)
  })

  it('refuses a root inside one already registered', async () => {
    const parent = await mkdir('parent')
    const child = await mkdir('parent', 'child')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
    expect((await registry.register('parent', parent)).ok).toBe(true)
    expect((await registry.register('child', child)).ok).toBe(false)
  })

  it('refuses a duplicate id even for a different folder', async () => {
    const a = await mkdir('a')
    const b = await mkdir('b')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
    expect((await registry.register('soil', a)).ok).toBe(true)
    expect((await registry.register('soil', b)).ok).toBe(false)
  })

  it('permits two genuinely separate folders', async () => {
    const a = await mkdir('a')
    const b = await mkdir('b')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
    expect((await registry.register('a', a)).ok).toBe(true)
    expect((await registry.register('b', b)).ok).toBe(true)
  })
})

describe('the services behind the routes', () => {
  const setUp = async () => {
    const rootPath = await mkdir('notes')
    await fsp.writeFile(join(rootPath, 'notes.md'), '# Notes\n')
    await fsp.mkdir(join(rootPath, 'nested'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'nested', 'deep.md'), '# Deep\n')

    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
    const registered = await registry.register('soil', rootPath)
    if (!registered.ok) throw new Error('registration failed')

    const index = new IndexStore()
    await indexRoot(registered.value, index)
    const config = await loadConfigService({
      registryPath: join(sandbox, 'registry.json'),
      uiStatePath: join(sandbox, 'ui-state.json'),
    })
    return {
      registry,
      index,
      config,
      // Outside the registered root, in this test's own sandbox — the same rule production follows.
      services: createServices(registry, index, {
        stagingRoot: join(sandbox, 'app-scratch'),
        archiveRoot: join(sandbox, 'app-archive'),
      // §11's browsable area, pointed INSIDE this test's sandbox. Never the real home directory:
      // these suites are not about browsing, and a scope that reached `$HOME` would make an
      // unrelated test capable of listing the user's disk.
      browseScope: { home: join(sandbox, 'browse-home'), volumes: join(sandbox, 'browse-volumes') },
      }, config),
      rootPath,
    }
  }

  it('lists a folder by NAME, never by absolute path', async () => {
    // Spec §6 keeps absolute paths off the wire in both directions. Handing the client a path
    // teaches it the shape of the user's disk, and gives the next builder one to send back.
    const { services } = await setUp()
    const folders = services['folders.list']()
    expect(folders).toHaveLength(1)
    expect(folders[0]?.name).toBe('notes')
    expect(JSON.stringify(folders)).not.toContain(sandbox)
    expect(JSON.stringify(folders)).not.toContain(tmpdir())
  })

  it('returns children, and never an absolute path among them', async () => {
    const { services } = await setUp()
    const children = services['tree.children']({ rootId: 'soil', segments: [] })
    expect(children.map(c => c.name).sort()).toEqual(['nested', 'notes.md'])
    expect(JSON.stringify(children)).not.toContain(sandbox)
  })

  it('THROWS for an unregistered root rather than returning an empty list', async () => {
    // The empty-for-failure substitution spec §6 forbids. An empty array here would be
    // indistinguishable from an empty folder.
    const { services } = await setUp()
    expect(() => services['tree.children']({ rootId: 'nope', segments: [] })).toThrow()
  })

  it('THROWS for a missing entry rather than returning a blank one', async () => {
    // The client must be able to tell "this file is gone" from "this file is blank" — the
    // distinction the whole 1,610-file failure turned on.
    const { services } = await setUp()
    expect(() => services['tree.entry']({ rootId: 'soil', segments: ['gone.md'] })).toThrow()
  })

  it('returns one entry by location', async () => {
    const { services } = await setUp()
    const entry = services['tree.entry']({ rootId: 'soil', segments: ['notes.md'] })
    expect(entry.title).toBe('Notes')
    expect(entry.isMarkdown).toBe(true)
  })

  it('drops the index rows when a folder is deregistered', async () => {
    // Leaving them would let a disconnected folder keep answering from cache — a folder the operator
    // believes they have disconnected.
    const { services, index } = await setUp()
    expect(index.size).toBeGreaterThan(0)
    // Async since the registry became durable: the entry is moved to `deregistered` on disk before
    // it leaves memory, so a failed write leaves everything as it was.
    await services['folders.deregister']({ id: 'soil' })
    expect(index.size).toBe(0)
    expect(() => services['tree.children']({ rootId: 'soil', segments: [] })).toThrow()
  })

  it('records the removal in the registry file rather than dropping it — M7', async () => {
    /**
     * §13.8: *"removal appends to a `deregistered` list rather than dropping the entry."* Nothing in
     * this app deletes, and that applies to its own memory of what the operator told it — with the list,
     * a mistaken removal is visible and reversible; without it, the only record that the folder was
     * ever registered is gone.
     */
    const { services, config } = await setUp()
    // Registered THROUGH THE SERVICE, because that is the path that persists. `setUp` talks to the
    // registry directly, so its root is in memory and was never written — which is exactly the
    // state the whole app was in before this wiring existed.
    const second = await mkdir('another-folder')
    await services['folders.register']({
      id: 'second', absolutePath: second
    })
    expect(config.registry().roots.map(r => r.id)).toEqual(['second'])

    await services['folders.deregister']({ id: 'second' })
    expect(config.registry().roots).toEqual([])
    expect(config.registry().deregistered.map(r => r.id)).toEqual(['second'])
  })

  it('refuses to deregister an id that was never registered', async () => {
    const { services, config } = await setUp()
    await expect(services['folders.deregister']({ id: 'nope' })).rejects.toThrow()
    // And the refusal happens before anything is written — a bad id must not touch the file.
    expect(config.registry().deregistered).toEqual([])
  })
})

/**
 * **§11's backup check lived here and was CUT on 2026-08-09 — the operator: "cut it".**
 *
 * Three tests went with it: that a folder with no recovery layer was refused, that the refusal ran
 * *after* the structural rules so an overlap said "overlap" rather than offering a useless
 * override, and that the verdict could be read without registering anything.
 *
 * They were correct tests of a check that measured the wrong thing. It asked whether a `.git`
 * existed above the folder and never whether anything had been committed — so a repo holding three
 * days of unsaved work passed silently, while every folder outside a repo charged a typed override.
 * the operator: *"I don't always back it up and I also run non-soil things in the viewer sometimes."*
 * False comfort where the risk was real, friction where it was not.
 *
 * Recorded rather than silently removed, because "registration used to refuse an unbacked folder"
 * is the kind of fact someone will later look for and fail to find.
 */

/**
 * **C2 — REGISTRATION IS BOUNDED BY THE BROWSABLE AREA.** The security review's P7 review, 2026-08-09.
 *
 * §11: registration is *"the most powerful thing the app does — it's what decides how much of your
 * disk is in play."* It was bounded by nothing except `/`, the overlap rule and the reserved paths.
 * That was survivable only while nothing could reach it — the route was `local-only`, and the
 * client is served by the other listener. The operator's Settings ruling made it reachable from every
 * device on the tailnet, and the security review measured the consequence: `register('/private/etc')` succeeded.
 */
describe('C2 — the area the app may be pointed at', () => {
  it('refuses a folder outside the browsable roots', async () => {
    const home = await mkdir('home')
    const elsewhere = await mkdir('elsewhere')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [home], browsableRootsResolved: [home] })

    const result = await registry.register('out', elsewhere)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ErrorCode.PATH_ESCAPES_ROOT)
  })

  /**
   * **A SYMLINKED PARENT MUST NOT CARRY A ROOT OUT OF THE AREA.**
   *
   * The bound was applied twice and both times to the same string — `registerRoot` stores the
   * caller's path verbatim, so nothing resolved it. Meanwhile `registerRoot` `lstat`s only the final
   * component and `walkAndVerify` starts *at* the root, so a symlinked **parent** was checked by no
   * one at all.
   *
   * The consequence was a real bypass, not a theoretical one: a link anywhere under the permitted
   * area pointing outside it registered a root outside it, after which every ordinary read and write
   * operated there. No race — just a link the machine may already have, and `~/bin`, `~/tmp` and
   * dotfile-manager links are ordinary.
   *
   * The fix resolves and re-scopes rather than refusing any symlinked ancestor, because on macOS
   * `/var`, `/tmp` and `/etc` are themselves symlinks and refusing them refuses nothing useful.
   */
  it('refuses a root reached through a symlinked parent that leaves the area', async () => {
    const home = await mkdir('home')
    const outside = await mkdir('outside', 'secrets')
    // A link inside the permitted area, pointing out of it — the shape of the bypass.
    const link = join(home, 'link')
    await fsp.symlink(join(sandbox, 'outside'), link)

    const registry = createRootRegistry({
      reservedPaths: [], browsableRoots: [home], browsableRootsResolved: [home],
    })

    const result = await registry.register('escaped', join(link, 'secrets'))

    expect(result.ok, 'a symlinked parent must not carry a root out of the area').toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.PATH_ESCAPES_ROOT)
    // And the target really was reachable — otherwise this would pass for the wrong reason.
    await expect(fsp.stat(outside)).resolves.toBeDefined()
  })

  it('accepts a folder inside them, and the area itself', async () => {
    const home = await mkdir('home')
    const inside = await mkdir('home', 'projects')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [home], browsableRootsResolved: [home] })

    expect((await registry.register('inside', inside)).ok).toBe(true)
    // The area itself is a legal root — the operator registering their whole home directory is described
    // in these records as ordinary.
    const second = createRootRegistry({ reservedPaths: [], browsableRoots: [home], browsableRootsResolved: [home] })
    expect((await second.register('home', home)).ok).toBe(true)
  })

  /**
   * **The oracle half, which is the part that is easy to fix wrongly.**
   *
   * the security review measured four different refusal codes for out-of-area paths — `PATH_SYMLINK` for `/etc`,
   * `IO_FAILED` for a path that does not exist, `NOT_REGULAR_FILE` for a file, `INVALID_ROOT` for
   * `/` — which makes the verb a whole-disk existence-and-type oracle. One code for everything
   * outside the area is the fix, and it only works if the check runs **before** the probes that
   * produce the other codes.
   */
  it('refuses everything outside the area identically, whatever is actually there', async () => {
    const home = await mkdir('home')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [home], browsableRootsResolved: [home] })

    const realDirectory = join(sandbox, 'elsewhere-real')
    await fsp.mkdir(realDirectory, { recursive: true })
    const realFile = join(sandbox, 'elsewhere-file')
    await fsp.writeFile(realFile, 'x')

    const codes = new Set<string>()
    for (const [index, candidate] of [
      realDirectory, realFile, join(sandbox, 'no-such-thing-at-all'),
    ].entries()) {
      const result = await registry.register(`probe-${index}`, candidate)
      expect(result.ok).toBe(false)
      if (!result.ok) codes.add(result.code)
    }
    expect(codes.size, 'a different code per case is the oracle').toBe(1)
    expect([...codes][0]).toBe(ErrorCode.PATH_ESCAPES_ROOT)
  })

  it('is unbounded when the list is empty, which every other test in this file relies on', async () => {
    const anywhere = await mkdir('anywhere')
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
    expect((await registry.register('any', anywhere)).ok).toBe(true)
  })
})

/**
 * **G5 — §11's cap of sixteen roots, which until 2026-08-14 existed only in the spec.**
 *
 * the security review filed it Low-medium and framed it exactly right: *"cost, not containment."* A seventeenth
 * folder escapes nothing. But **each root costs a watcher and a blocking index walk**, paid at every
 * startup — so an unbounded registry is a cold start that gets slower forever and a file-descriptor
 * budget with no ceiling. §11 states the number; this is where it became true.
 */
describe('the registry holds at most sixteen folders', () => {
  it('accepts sixteen and refuses the seventeenth, naming the limit', async () => {
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })

    for (let i = 0; i < 16; i++) {
      const folder = join(sandbox, `root-${i}`)
      await fsp.mkdir(folder, { recursive: true })
      const added = await registry.register(`r${i}`, folder)
      expect(added.ok, `folder ${i} was refused below the cap`).toBe(true)
    }

    const extra = join(sandbox, 'root-16')
    await fsp.mkdir(extra, { recursive: true })
    const refused = await registry.register('r16', extra)

    expect(refused.ok, 'a seventeenth folder registered').toBe(false)
    if (refused.ok) return
    // The only action left is removing one, so the refusal has to name the number.
    expect(refused.detail ?? '').toContain('16')
  })

  it('checks the cap LAST, so a bad folder still hears why it is bad', async () => {
    /**
     * A person who picked a symlink should be told about the symlink, not about a quota. Ordering a
     * quota check first is the small unkindness that makes an app feel arbitrary — and it is easy to
     * do, because a cheap check naturally drifts to the top.
     */
    const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
    for (let i = 0; i < 16; i++) {
      const folder = join(sandbox, `full-${i}`)
      await fsp.mkdir(folder, { recursive: true })
      await registry.register(`f${i}`, folder)
    }

    const link = join(sandbox, 'a-symlink')
    await fsp.symlink(join(sandbox, 'full-0'), link)
    const refused = await registry.register('link', link)

    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code, 'the quota answered a question about a symlink').toBe(ErrorCode.PATH_SYMLINK)
  })
})

