/**
 * **`file.reveal` REFUSES A PATH THAT LEAVES THE REGISTERED ROOT — the security review's C1, P12 review.**
 *
 * ## Why this file exists
 *
 * `reveal.ts:117-129` said, of the walk-before-compose ordering:
 *
 * > *"The caller in `services.ts` walks first and passes the composed path; **that ordering is
 * > asserted by a test**, because it is the whole security argument."*
 *
 * **It was not.** The security review proved it with a positive control so a zero-match could not be mistaken for
 * evidence — `walkAndVerify` appeared 20 times in `test/`, `resolveVerifiedPath` **zero**, and all
 * five `file.reveal` hits were carriage assertions in `listener.test.ts` and one comment. Nothing
 * drove the handler; nothing exercised `resolveVerifiedPath` at all.
 *
 * The control was **present and correct** — they verified that separately against a real disk. So the
 * finding was never "there is a hole", it was **"the one property that decides whether an
 * attacker-chosen `(rootId, segments)` can point `open -R` outside a registered root is unproven"**.
 * On the largest OS escalation in the build, present-but-unproven is the finding. Record item 25:
 * *"a condition is not met until the proof clause it names has been written."*
 *
 * ## What this asserts that the existing tests do not
 *
 * `test/server/reveal.test.ts` proves the **argument array** is safe against hostile filenames,
 * against a fake seam. `test/security/sanctioned-shell.test.ts` proves the module's **shape**.
 * `test/server/listener.test.ts` proves the route's **carriage**. All three take the path as given.
 *
 * This one asks the question none of them do: **what does the handler do with a path it should
 * refuse, and does anything reach the OS when it refuses?**
 *
 * ## Why the seam is mocked rather than injected
 *
 * `services.ts` imports `revealInFinder` at module scope and calls it with one argument, so there is
 * no seam to hand in — and that is correct for production. Mocking the module is therefore the only
 * way to answer *"was the OS reached?"*, which is the half of this that matters: a refusal that
 * still spawned `open` would be a refusal in name only.
 *
 * **The control case is not optional.** A test that only proves refusals can be satisfied by a
 * handler that refuses everything, which is the failure mode this build has hit repeatedly — so one
 * case must succeed AND reach the mocked seam.
 */
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IndexStore } from '../../src/core/index-store'
import { indexRegisteredRoot } from '../../src/core/indexer'
import { loadConfigService } from '../../src/server/config-service'
import { createRootRegistry, type RootRegistry } from '../../src/server/root-registry'
import { createServices, type Services } from '../../src/server/services'

/**
 * The OS is replaced, not the containment. Everything under test — `requireRootValue`,
 * `resolveVerifiedPath`, the ordering between them — runs for real.
 */
const revealed: string[] = []
vi.mock('../../src/server/reveal', () => ({
  revealInFinder: async (absolutePath: string) => {
    revealed.push(absolutePath)
    return { ok: true as const, value: null }
  },
}))

let sandbox = ''
let rootPath = ''
let registry: RootRegistry
let index: IndexStore
let services: Services

beforeEach(async () => {
  revealed.length = 0
  // `realpath` because macOS hands back `/var/...` for a `/private/var/...` temp dir, and a
  // containment check that compares resolved paths would refuse the fixture itself.
  sandbox = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'soil-reveal-')))
  rootPath = join(sandbox, 'root')

  await fsp.mkdir(join(rootPath, '02-projects', 'cider-line'), { recursive: true })
  await fsp.writeFile(join(rootPath, '02-projects', 'cider-line', 'note.md'), '# Note\n')

  // The thing a reveal must never reach: a real file, outside the root, next to it.
  await fsp.mkdir(join(sandbox, 'outside'), { recursive: true })
  await fsp.writeFile(join(sandbox, 'outside', 'secret.md'), '# Not yours\n')

  // A symlinked segment INSIDE the root pointing out of it. §4 refuses the segment rather than
  // resolving it — resolve-then-open is the TOCTOU window (F4.1).
  await fsp.symlink(join(sandbox, 'outside'), join(rootPath, '02-projects', 'escape'))

  registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)
  index = new IndexStore()
  await indexRegisteredRoot(registered.value, index)

  const config = await loadConfigService({
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

describe('file.reveal — the control, so nothing below passes vacuously', () => {
  it('reveals a real file inside the root, and DOES reach the OS', async () => {
    const result = await services['file.reveal']({
      rootId: 'soil',
      segments: ['02-projects', 'cider-line', 'note.md'],
    })

    expect(result).toEqual({ revealed: true })
    /**
     * **The half that makes the refusals below mean something.** Without this, a handler that
     * refused every input would satisfy the whole file — and "refuses everything" is
     * indistinguishable from "is correct" if you only ever assert refusals.
     */
    expect(revealed).toHaveLength(1)
    expect(revealed[0]).toBe(join(rootPath, '02-projects', 'cider-line', 'note.md'))
  })
})

describe('file.reveal — refuses any path that leaves the root, and reaches nothing when it does', () => {
  /**
   * Each case asserts **both** halves. A thrown error with `open` already spawned is not a refusal,
   * and that distinction is the entire reason this file drives the handler rather than the
   * containment function on its own.
   */
  /**
   * **Each case names the code it must be refused WITH, and that is not decoration.**
   *
   * `rejects.toThrow()` alone would be satisfied by a refusal for an unrelated reason — most
   * obviously "no such file", since several of these paths do not exist. A test that cannot tell
   * *containment refused this* from *the filesystem happened to be missing it* is not testing
   * containment, and this build has shipped that mistake before. The codes below are the ones
   * the security review's own real-disk probe produced.
   */
  const cases: ReadonlyArray<{
    readonly what: string
    readonly segments: readonly string[]
    readonly code: string
  }> = [
    {
      what: 'a symlinked segment inside the root, pointing outside it',
      segments: ['02-projects', 'escape', 'secret.md'],
      code: 'PATH_SYMLINK',
    },
    {
      what: 'the symlinked segment itself, with nothing after it',
      segments: ['02-projects', 'escape'],
      code: 'PATH_SYMLINK',
    },
    {
      what: 'a dot-dot segment climbing out',
      // Built as a raw array element, never through `join` — `path.join` normalises `..` away, so a
      // fixture composed with it proves nothing. That mistake was made once in this build already.
      segments: ['02-projects', '..', '..', 'outside', 'secret.md'],
      code: 'PATH_TRAVERSAL',
    },
    {
      what: 'a separator packed into one array element',
      segments: ['02-projects/../../outside/secret.md'],
      code: 'PATH_TRAVERSAL',
    },
    {
      what: 'an absolute path smuggled in as a segment',
      segments: ['/etc/passwd'],
      code: 'PATH_TRAVERSAL',
    },
    {
      what: 'a NUL byte in a segment',
      // Written as an escape, never a literal control character: the reachability suite bans
      // those in source, and a byte nobody can see in a diff is the wrong way to write one.
      segments: ['02-projects', 'note\u0000.md'],
      code: 'PATH_NUL',
    },
    {
      what: 'an empty segment',
      segments: ['02-projects', '', 'note.md'],
      code: 'PATH_EMPTY',
    },
  ]

  for (const { what, segments, code } of cases) {
    it(`refuses ${what} with ${code}, and never reaches the OS`, async () => {
      await expect(
        services['file.reveal']({ rootId: 'soil', segments: [...segments] }),
      ).rejects.toMatchObject({ code })

      expect(revealed, `the OS was reached despite a refusal: ${what}`).toHaveLength(0)
    })
  }

  it('refuses an unregistered root before it touches the path at all', async () => {
    await expect(
      services['file.reveal']({ rootId: 'not-a-root', segments: ['note.md'] }),
    ).rejects.toThrow()
    expect(revealed).toHaveLength(0)
  })
})
