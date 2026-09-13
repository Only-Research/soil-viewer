import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { type RegisteredRoot } from '../../../src/core/fs/containment'
import { registerRoot } from '../../../src/core/fs/registration'
import {
  VOLUME_SCRATCH_NAME,
  checkStagingArea,
  findMountPoint,
  makeStagingDirectory,
  removeStagedTree,
  resolveStagingArea,
} from '../../../src/core/fs/staging'

/**
 * **The most dangerous function in this build gets the most adversarial tests.**
 *
 * `removeStagedTree` is the only recursive removal in the codebase. The previous version of this
 * app destroyed 1,610 of 1,611 files; if anything here is going to do that again, it is this. So
 * these tests spend most of their effort trying to make it delete something it must not, and every
 * one of them checks that the thing it was aimed at is still on disk afterwards.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Every path is created by this file.
 */
let sandbox: string
let stagingRoot: string
let rootPath: string
let root: RegisteredRoot

const PRECIOUS = '# a file that must survive every test in this file\n'

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p4-staging-'))
  rootPath = join(sandbox, 'registered-root')
  stagingRoot = join(sandbox, 'staging')
  await fsp.mkdir(rootPath, { recursive: true })
  await fsp.mkdir(stagingRoot, { recursive: true })
  await fsp.writeFile(join(rootPath, 'precious.md'), PRECIOUS)
  await fsp.mkdir(join(rootPath, 'deep', 'nested'), { recursive: true })
  await fsp.writeFile(join(rootPath, 'deep', 'nested', 'also-precious.md'), PRECIOUS)

  const registered = await registerRoot('scratch', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

/** Every refusal test ends here: the user's files are still on disk. */
async function rootIsIntact(): Promise<boolean> {
  const [a, b] = await Promise.all([
    fsp.readFile(join(rootPath, 'precious.md'), 'utf8').catch(() => null),
    fsp.readFile(join(rootPath, 'deep', 'nested', 'also-precious.md'), 'utf8').catch(() => null),
  ])
  return a === PRECIOUS && b === PRECIOUS
}

describe('what it refuses to remove', () => {
  it('refuses a path inside a registered root', async () => {
    const removed = await removeStagedTree(join(rootPath, 'deep'), stagingRoot, [root])
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.code).toBe(ErrorCode.INVALID_ROOT)
    expect(await rootIsIntact()).toBe(true)
  })

  it('refuses the registered root itself', async () => {
    const removed = await removeStagedTree(rootPath, stagingRoot, [root])
    expect(removed.ok).toBe(false)
    expect(await rootIsIntact()).toBe(true)
  })

  it('refuses the staging area ITSELF, not just things outside it', async () => {
    /**
     * `isWithin` counts an equal path as contained, which is correct for containment and wrong
     * here. Removing the staging area would take every other in-flight copy with it, and an
     * off-by-one that produces exactly the staging path is an entirely plausible bug.
     */
    const staged = await makeStagingDirectory(stagingRoot, [root])
    expect(staged.ok).toBe(true)

    const removed = await removeStagedTree(stagingRoot, stagingRoot, [root])
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.code).toBe(ErrorCode.INVALID_ROOT)
    expect(await fsp.stat(stagingRoot).then(s => s.isDirectory())).toBe(true)
    if (staged.ok) expect(await fsp.stat(staged.value).then(s => s.isDirectory())).toBe(true)
  })

  it('refuses a path outside both the staging area and every root', async () => {
    const elsewhere = join(sandbox, 'unrelated')
    await fsp.mkdir(elsewhere, { recursive: true })
    await fsp.writeFile(join(elsewhere, 'keep.md'), PRECIOUS)

    const removed = await removeStagedTree(elsewhere, stagingRoot, [root])
    expect(removed.ok).toBe(false)
    expect(await fsp.readFile(join(elsewhere, 'keep.md'), 'utf8')).toBe(PRECIOUS)
  })

  it('refuses a relative path', async () => {
    const removed = await removeStagedTree('staging/copy-abc', stagingRoot, [root])
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.code).toBe(ErrorCode.INVALID_ROOT)
  })

  it('refuses the filesystem root', async () => {
    const removed = await removeStagedTree('/', stagingRoot, [root])
    expect(removed.ok).toBe(false)
  })

  it('refuses a path that merely SHARES A PREFIX with the staging area', async () => {
    /**
     * §5's rule, and the reason it is stated as whole-segment comparison everywhere: a raw string
     * prefix test says `/tmp/x/staging-old` is inside `/tmp/x/staging`. Here that is not a leaked
     * read — it is a recursive delete of a directory nobody asked about.
     */
    const lookalike = `${stagingRoot}-old`
    await fsp.mkdir(lookalike, { recursive: true })
    await fsp.writeFile(join(lookalike, 'keep.md'), PRECIOUS)

    const removed = await removeStagedTree(lookalike, stagingRoot, [root])
    expect(removed.ok).toBe(false)
    expect(await fsp.readFile(join(lookalike, 'keep.md'), 'utf8')).toBe(PRECIOUS)
  })

  it('refuses when a root was registered INSIDE the staging area after the fact', async () => {
    /**
     * P2's R2 finding, in a place where it deletes rather than logs: a containment decision made
     * once at startup is wrong the moment the set of roots changes. The operator registering a folder
     * that happens to contain the app's scratch directory is an ordinary thing to do.
     *
     * So the staging area is re-validated against the CURRENT roots on every removal, not trusted
     * from setup.
     */
    const swallowing = await registerRoot('swallowing', sandbox)
    expect(swallowing.ok).toBe(true)
    if (!swallowing.ok) return

    const target = join(stagingRoot, 'copy-something')
    await fsp.mkdir(target, { recursive: true })
    await fsp.writeFile(join(target, 'staged.md'), 'staged\n')

    const removed = await removeStagedTree(target, stagingRoot, [swallowing.value])
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.code).toBe(ErrorCode.INVALID_ROOT)
    expect(await fsp.readFile(join(target, 'staged.md'), 'utf8')).toBe('staged\n')
  })

  it('refuses a prefix lookalike that is DEEPER than the staging area', async () => {
    /**
     * The sweep found this. The earlier prefix test used `<staging>-old`, which has the same number
     * of segments as the staging area — so the strictly-inside length check refused it, and the
     * containment test could be replaced with a raw `startsWith` and nothing noticed.
     *
     * One segment deeper defeats the length check and leaves only the containment rule standing.
     * `<staging>-old/inner` starts with the staging path as a string and is not inside it, and
     * under `startsWith` it would be recursively deleted.
     */
    const lookalike = `${stagingRoot}-old`
    await fsp.mkdir(join(lookalike, 'inner'), { recursive: true })
    await fsp.writeFile(join(lookalike, 'inner', 'keep.md'), PRECIOUS)

    const removed = await removeStagedTree(join(lookalike, 'inner'), stagingRoot, [root])
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.code).toBe(ErrorCode.INVALID_ROOT)
    expect(await fsp.readFile(join(lookalike, 'inner', 'keep.md'), 'utf8')).toBe(PRECIOUS)
  })

  it('refuses when the staging area CONTAINS a root, even for a target outside that root', async () => {
    /**
     * Also from the sweep: every other test that exercises the staging re-validation is *also*
     * caught by the per-target root check, so removing the re-validation entirely left the suite
     * green. This is the case only the re-validation can catch.
     *
     * The staging area is the sandbox, which contains the registered root. The target sits inside
     * the staging area but outside that root — so the per-target check has nothing to say. What is
     * wrong is the staging area itself: it is far too broad, and treating it as scratch would put
     * a recursive delete one bug away from the user's folder next door.
     */
    const tooBroad = sandbox
    const target = join(tooBroad, 'some-copy')
    await fsp.mkdir(target, { recursive: true })
    await fsp.writeFile(join(target, 'staged.md'), 'staged\n')

    const removed = await removeStagedTree(target, tooBroad, [root])
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.code).toBe(ErrorCode.INVALID_ROOT)
    expect(await fsp.readFile(join(target, 'staged.md'), 'utf8')).toBe('staged\n')
    expect(await rootIsIntact()).toBe(true)
  })

  it('never follows a symlink out of the staging area', async () => {
    /**
     * The one route by which every check above could be satisfied and the removal still land
     * somewhere else: the staged path itself is replaced by a symlink pointing into the root.
     * The link is unlinked; nothing is followed.
     */
    const link = join(stagingRoot, 'copy-poisoned')
    await fsp.symlink(join(rootPath, 'deep'), link)

    const removed = await removeStagedTree(link, stagingRoot, [root])
    expect(removed.ok).toBe(true)
    expect(await rootIsIntact(), 'the symlink target must be untouched').toBe(true)
    expect(await fsp.lstat(link).then(() => true, () => false), 'the link itself is gone')
      .toBe(false)
  })
})

describe('what it does remove', () => {
  it('removes a staged tree, contents and all', async () => {
    const staged = await makeStagingDirectory(stagingRoot, [root])
    expect(staged.ok).toBe(true)
    if (!staged.ok) return

    await fsp.mkdir(join(staged.value, 'inner'), { recursive: true })
    await fsp.writeFile(join(staged.value, 'inner', 'a.md'), 'staged\n')

    const removed = await removeStagedTree(staged.value, stagingRoot, [root])
    expect(removed.ok).toBe(true)
    expect(await fsp.lstat(staged.value).then(() => true, () => false)).toBe(false)
    expect(await rootIsIntact()).toBe(true)
  })

  it('treats an already-gone tree as success', async () => {
    // Cleanup that errors because there was nothing to clean would turn every successful copy
    // into a reported failure.
    const removed = await removeStagedTree(join(stagingRoot, 'never-existed'), stagingRoot, [root])
    expect(removed.ok).toBe(true)
  })
})

describe('the staging area itself', () => {
  it('accepts a directory outside every root', () => {
    expect(checkStagingArea(stagingRoot, [root]).ok).toBe(true)
  })

  it('refuses a staging area inside a registered root', () => {
    const bad = checkStagingArea(join(rootPath, 'scratch'), [root])
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.code).toBe(ErrorCode.INVALID_ROOT)
  })

  it('refuses a staging area that CONTAINS a registered root', () => {
    // The direction that is easy to miss: `/Users/hallberg` is inside no root while having every
    // root inside it, and the removal would take the lot.
    const bad = checkStagingArea(sandbox, [root])
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.code).toBe(ErrorCode.INVALID_ROOT)
  })

  it('refuses a relative staging area', () => {
    expect(checkStagingArea('scratch/staging', [root]).ok).toBe(false)
  })

  it('refuses the filesystem root as a staging area', () => {
    expect(checkStagingArea('/', [root]).ok).toBe(false)
  })

  it('refuses the filesystem root even when NO roots are registered', () => {
    /**
     * The sweep found that the previous test proved nothing about the rule it was named for. With
     * a root registered, `/` is refused because that root sits inside it — so deleting the
     * filesystem-root check left the test green.
     *
     * With no roots registered there is nothing else to catch it, and `/` as a staging area means
     * a recursive delete rooted at the volume. First run, before any folder is registered, is
     * exactly when that state exists.
     */
    const bad = checkStagingArea('/', [])
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.code).toBe(ErrorCode.INVALID_ROOT)
  })

  it('makes a uniquely named directory each time', async () => {
    const a = await makeStagingDirectory(stagingRoot, [root])
    const b = await makeStagingDirectory(stagingRoot, [root])
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value).not.toBe(b.value)
  })

  it('refuses to make one inside a registered root', async () => {
    const made = await makeStagingDirectory(join(rootPath, 'scratch'), [root])
    expect(made.ok).toBe(false)
    expect(await fsp.lstat(join(rootPath, 'scratch')).then(() => true, () => false),
      'and creates nothing').toBe(false)
  })
})

describe('picking a staging area per volume', () => {
  it('uses the app\'s own scratch when the destination is on the same volume', async () => {
    // The ordinary case: soil and scratch both on the internal disk.
    const chosen = await resolveStagingArea(stagingRoot, rootPath, [root])
    expect(chosen.ok).toBe(true)
    if (!chosen.ok) return
    expect(chosen.value).toBe(stagingRoot)
  })

  it('works before the app\'s scratch directory has ever been created', async () => {
    // First run. The scratch path does not exist yet, so the volume has to be read from its parent.
    const neverMade = join(sandbox, 'not-created-yet', 'scratch')
    const chosen = await resolveStagingArea(neverMade, rootPath, [root])
    expect(chosen.ok).toBe(true)
    if (!chosen.ok) return
    expect(chosen.value).toBe(neverMade)
  })

  it('refuses when the preferred scratch overlaps a registered root', async () => {
    const chosen = await resolveStagingArea(join(rootPath, 'inside'), rootPath, [root])
    expect(chosen.ok).toBe(false)
    if (chosen.ok) return
    expect(chosen.code).toBe(ErrorCode.INVALID_ROOT)
  })

  it('finds the mount point of a path on the boot volume', async () => {
    // Everything in TMPDIR is on the boot volume, so the walk should terminate at its mount point
    // rather than at the first directory it cannot read.
    const found = await findMountPoint(rootPath)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value).toBe('/')
  })

  it('terminates rather than walking forever from the filesystem root', async () => {
    const found = await findMountPoint('/')
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value).toBe('/')
  })
})

describe('the scratch directory left on someone else\'s drive', () => {
  it('is hidden and names the app that created it', () => {
    /**
     * This name appears at the top level of a user's external drive. Someone finding it there needs
     * to be able to tell what put it there and that removing it is safe — an opaque name would be
     * indistinguishable from something they must not touch.
     *
     * A naming contract rather than a behaviour test, and deliberate: it is the only part of the
     * cross-volume path this suite can reach without mounting a second volume.
     */
    expect(VOLUME_SCRATCH_NAME.startsWith('.'), 'hidden').toBe(true)
    expect(VOLUME_SCRATCH_NAME).toContain('soil-viewer')
    expect(VOLUME_SCRATCH_NAME).toContain('scratch')
  })
})
