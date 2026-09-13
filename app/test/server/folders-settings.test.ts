import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCode, refusalCodeOf } from '../../src/core/errors'
import { IndexStore } from '../../src/core/index-store'
import { loadConfigService } from '../../src/server/config-service'
import { createRootRegistry } from '../../src/server/root-registry'
import { createServices, type Services } from '../../src/server/services'

/**
 * Settings → Folders, on the server side. Spec §11, and the ruling of 2026-08-09 that this is
 * an ordinary Settings section reachable from every surface.
 *
 * Three things are proven here, and each of them was unproven when the screen was built:
 *
 * 1. **`folders.browse` is scoped at the route, not only in the function.** It answers questions
 *    about paths outside every registered root, and the defect these tests exist for was a *route*
 *    handing back two different error codes for "exists" and "does not exist".
 * 2. **The registration refusals are distinguishable.** They shared `INVALID_ROOT`, and §6
 *    puts a *fixed message per code* on the wire — so one code meant one sentence for three
 *    different problems, and a person re-picking a folder learned nothing each time.
 * 3. **`folders.list` still keeps absolute paths off the wire** while carrying enough path to tell
 *    two folders called `notes` apart. §6 is explicit that the response half of that rule matters
 *    as much as the request half.
 */

let sandbox: string
let rootPath: string
let services: Services
let browseHome: string

beforeEach(async () => {
  /**
   * `realpath` on the sandbox, and it is not incidental.
   *
   * On macOS `tmpdir()` is `/var/folders/…`, and `/var` is a symlink to `/private/var`. The browse
   * scope is compared against `realpath`'s answer (that is the second of its two checks, the one
   * that catches a planted symlink), so a scope named through the symlink refuses **everything** —
   * including itself. The first version of this suite did that and read as three product defects.
   */
  sandbox = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'soil-folders-')))
  rootPath = join(sandbox, 'soil')
  browseHome = join(sandbox, 'browse-home')
  await fsp.mkdir(rootPath, { recursive: true })
  await fsp.mkdir(join(browseHome, 'projects'), { recursive: true })
  await fsp.mkdir(join(sandbox, 'browse-volumes'), { recursive: true })
  // Outside the browse scope entirely, for the oracle test.
  await fsp.mkdir(join(sandbox, 'elsewhere'), { recursive: true })

  const registry = createRootRegistry({ reservedPaths: [join(sandbox, 'log.jsonl')], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)

  const config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })

  services = createServices(registry, new IndexStore(), {
    stagingRoot: join(sandbox, 'app-scratch'),
    archiveRoot: join(sandbox, 'app-archive'),
    browseScope: { home: browseHome, volumes: join(sandbox, 'browse-volumes') },
  }, config)
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

/**
 * **`folders.inspect` lived here and was cut on 2026-08-09 with the backup check it served.**
 *
 * Its scoping tests are kept and retargeted at `folders.browse`, which is the other route that
 * speaks in absolute paths and carries the identical scope rule. They are route-level versions of
 * what `test/core/browse.test.ts` proves about the function — worth having twice, because the
 * defect they exist for was a *route* handing back two different error codes.
 */
describe('folders.browse — the scope, at the route', () => {
  it('lists a folder inside the browsable area', async () => {
    const listed = await services['folders.browse']({ absolutePath: browseHome })
    expect(listed.path).toBe(browseHome)
    expect(listed.directories.map(entry => entry.name)).toContain('projects')
    // `parent` is null at a root, so the UI has no "up" control to walk out of the scope with.
    expect(listed.parent).toBeNull()
  })

  /**
   * **The existence oracle.**
   *
   * Written the obvious way first — resolve, then scope — and a test caught it: an out-of-scope
   * path that *exists* refused with `PATH_ESCAPES_ROOT` and one that does not refused with
   * `IO_FAILED`, because `realpath` failed `ENOENT` before the scope was ever consulted. Two
   * different answers is an existence oracle for every path on the disk, from a route that never
   * reads a file — arriving through the error codes rather than through the data.
   */
  it('refuses an out-of-scope path identically whether or not it exists', async () => {
    const real = await services['folders.browse']({ absolutePath: join(sandbox, 'elsewhere') })
      .then(() => null, (error: unknown) => refusalCodeOf(error))
    const imaginary = await services['folders.browse']({ absolutePath: join(sandbox, 'no-such-thing') })
      .then(() => null, (error: unknown) => refusalCodeOf(error))

    expect(real).toBe(ErrorCode.PATH_ESCAPES_ROOT)
    expect(imaginary).toBe(ErrorCode.PATH_ESCAPES_ROOT)
    expect(real).toBe(imaginary)
  })

  it('refuses a path with dot segments rather than normalising it away', async () => {
    // Built by concatenation, not `join` — `join` normalises the dot segments away, so the first
    // version of this test handed the route a perfectly clean path and asserted it was refused for
    // containing something it no longer contained.
    const code = await services['folders.browse']({
      absolutePath: `${browseHome}/projects/../../elsewhere`,
    }).then(() => null, (error: unknown) => refusalCodeOf(error))
    // Normalising would mean the path the caller named and the path we answered about could differ
    // without anyone saying so — which is how `~/../otheruser` becomes a successful request.
    expect(code).toBe(ErrorCode.PATH_TRAVERSAL)
  })

  it('refuses a relative path', async () => {
    const code = await services['folders.browse']({ absolutePath: 'projects' })
      .then(() => null, (error: unknown) => refusalCodeOf(error))
    expect(code).toBe(ErrorCode.INVALID_ROOT)
  })

  /**
   * A symlink planted inside the scope is in scope *as a string* and may resolve anywhere. This is
   * the second of the two checks, and the one a string-only scope test cannot see.
   */
  it('refuses a symlink inside the scope that points out of it', async () => {
    await fsp.symlink(join(sandbox, 'elsewhere'), join(browseHome, 'escape'))
    const code = await services['folders.browse']({ absolutePath: join(browseHome, 'escape') })
      .then(() => null, (error: unknown) => refusalCodeOf(error))
    expect(code).toBe(ErrorCode.PATH_ESCAPES_ROOT)
  })
})

describe('registration refusals — one code each, because §6 puts one message per code', () => {
  /**
   * The exact-duplicate case, which is the one a person actually produces: they pick the same
   * folder again. It is trivially an overlap with itself, and said as an overlap it reads as
   * nonsense — *"contains, or sits inside, one you have already added"* about the folder they just
   * chose. It does not reach the id check either, because Settings derives a fresh id rather than
   * asking for one, so the ids differ even when the path does not.
   */
  it('says "already registered" when the very same folder is added again', async () => {
    const code = await services['folders.register']({
      id: 'soil-again', absolutePath: rootPath
    }).then(() => null, (error: unknown) => refusalCodeOf(error))
    expect(code).toBe(ErrorCode.ROOT_ALREADY_REGISTERED)
  })

  it('says the folder is already added when the id is taken', async () => {
    const code = await services['folders.register']({
      id: 'soil', absolutePath: join(browseHome, 'projects')
    }).then(() => null, (error: unknown) => refusalCodeOf(error))
    expect(code).toBe(ErrorCode.ROOT_ALREADY_REGISTERED)
  })

  it('says the folder overlaps when it contains, or sits inside, a registered one', async () => {
    const inside = join(rootPath, 'inner')
    await fsp.mkdir(inside)
    const code = await services['folders.register']({
      id: 'inner', absolutePath: inside
    }).then(() => null, (error: unknown) => refusalCodeOf(error))
    expect(code).toBe(ErrorCode.ROOT_OVERLAPS)
  })

  /**
   * The point of the split, asserted as a difference rather than as two separate facts.
   *
   * Two `it` blocks each checking one code would both keep passing if the codes were merged back
   * into one — they would simply both be checking the same value. This is the assertion that
   * cannot.
   */
  it('gives the three refusals three different codes', async () => {
    const taken = await services['folders.register']({
      id: 'soil', absolutePath: join(browseHome, 'projects')
    }).then(() => null, (error: unknown) => refusalCodeOf(error))

    const inside = join(rootPath, 'inner2')
    await fsp.mkdir(inside)
    const overlapping = await services['folders.register']({
      id: 'inner2', absolutePath: inside
    }).then(() => null, (error: unknown) => refusalCodeOf(error))

    const unusable = await services['folders.register']({
      id: 'relative', absolutePath: 'not/absolute'
    }).then(() => null, (error: unknown) => refusalCodeOf(error))

    expect(new Set([taken, overlapping, unusable]).size).toBe(3)
  })

  /**
   * **The backup gate is gone, and this asserts its absence rather than assuming it.**
   *
   * Cut 2026-08-09 on the ruling. The fixture folders in this suite are scratch directories
   * in TMPDIR and are not inside any git repository — which is precisely the case the old check
   * refused — so a registration succeeding here *is* the proof that nothing is gating on backups
   * any more. Written as a test because the alternative is noticing in six months that every folder
   * in the suite happens to be unbacked and wondering whether that was ever meaningful.
   */
  it('registers a folder that is in no git repository, with nothing to type through', async () => {
    const registered = await services['folders.register']({
      id: 'projects', absolutePath: join(browseHome, 'projects'),
    })
    expect(registered.id).toBe('projects')
  })
})

describe('folders.list — enough path to be useful, and no absolute path', () => {
  it('carries a short display path, not the absolute one', async () => {
    const listed = services['folders.list']()
    const soil = listed.find(folder => folder.id === 'soil')

    expect(soil?.displayPath).toBe(`${sandbox.split('/').pop() ?? ''}/soil`)
    // §6, the response half: hand the client a path and it learns the shape of the user's disk, and
    // the next builder has an absolute path to send back.
    expect(soil?.displayPath.startsWith('/')).toBe(false)
    expect(JSON.stringify(listed)).not.toContain(rootPath)
  })

  it('tells two folders with the same name apart', async () => {
    // The case the whole field exists for: `name` is identical, so `displayPath` is the only thing
    // in the row a person can read to know which is which.
    const other = join(browseHome, 'projects', 'soil')
    await fsp.mkdir(other, { recursive: true })
    await services['folders.register']({
      id: 'soil-2', absolutePath: other
    })

    const listed = services['folders.list']()
    const names = listed.map(folder => folder.name)
    const paths = listed.map(folder => folder.displayPath)

    expect(new Set(names).size).toBe(1)
    expect(new Set(paths).size).toBe(2)
  })
})
