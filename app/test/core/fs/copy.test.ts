import { promises as fsp } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { type RegisteredRoot } from '../../../src/core/fs/containment'
import { planRecursiveCopy, recursiveCopy } from '../../../src/core/fs/copy'
import { registerRoot } from '../../../src/core/fs/registration'

/**
 * §13.7. The failure that matters most here is not a refusal — it is a **partial tree**: half a
 * project appearing in a filesystem-that-is-the-database. v1's `copyDir` threw mid-copy and left
 * exactly that, with no rollback, from all three of Templates, Duplicate and New Project.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree, created and destroyed per test.
 */
let sandbox: string
let rootPath: string
let stagingRoot: string
let root: RegisteredRoot

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p4-copy-'))
  rootPath = join(sandbox, 'root')
  stagingRoot = join(sandbox, 'staging')
  await fsp.mkdir(rootPath, { recursive: true })
  await fsp.mkdir(stagingRoot, { recursive: true })

  // A small project: two levels, three files, one ignored folder.
  await fsp.mkdir(join(rootPath, 'project', 'inner'), { recursive: true })
  await fsp.writeFile(join(rootPath, 'project', 'a.md'), '# a\n')
  await fsp.writeFile(join(rootPath, 'project', 'inner', 'b.md'), '# b\n')
  await fsp.writeFile(join(rootPath, 'project', 'inner', 'c.md'), '# c\n')
  await fsp.mkdir(join(rootPath, 'project', 'node_modules', 'junk'), { recursive: true })
  await fsp.writeFile(join(rootPath, 'project', 'node_modules', 'junk', 'x.md'), 'ignored\n')

  const registered = await registerRoot('scratch', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const exists = (...segments: string[]) =>
  fsp.lstat(join(rootPath, ...segments)).then(() => true, () => false)

const copy = (from: string[], to: string[], caps = {}) =>
  recursiveCopy(root, from, to, stagingRoot, [root], caps)

describe('the ordinary copy', () => {
  it('reproduces the tree, contents and all', async () => {
    const done = await copy(['project'], ['copied'])
    expect(done.ok).toBe(true)
    if (!done.ok) return

    expect(await fsp.readFile(join(rootPath, 'copied', 'a.md'), 'utf8')).toBe('# a\n')
    expect(await fsp.readFile(join(rootPath, 'copied', 'inner', 'b.md'), 'utf8')).toBe('# b\n')
    expect(await fsp.readFile(join(rootPath, 'copied', 'inner', 'c.md'), 'utf8')).toBe('# c\n')
    expect(done.value.files).toBe(3)
  })

  it('leaves the source untouched', async () => {
    await copy(['project'], ['copied'])
    expect(await fsp.readFile(join(rootPath, 'project', 'a.md'), 'utf8')).toBe('# a\n')
  })

  it('leaves nothing behind in the staging area', async () => {
    await copy(['project'], ['copied'])
    expect(await fsp.readdir(stagingRoot)).toEqual([])
  })

  it('skips the ignore list rather than copying it', async () => {
    // §3's list applies to a copy: node_modules is not content, and copying it turns a 3-file
    // project into a 30,000-file one.
    const done = await copy(['project'], ['copied'])
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(await exists('copied', 'node_modules')).toBe(false)
    expect(done.value.skippedIgnored.length).toBeGreaterThan(0)
  })

  it('copies a hard-linked file BY CONTENT, not by making another link', async () => {
    /**
     * §13.7: "copy `st_nlink > 1` by content, never by `fs.link`." Linking would give the copy and
     * the original the same inode, so editing the "copy" would edit the original — the exact
     * opposite of what Duplicate means, and invisible until someone loses work.
     */
    await fsp.writeFile(join(rootPath, 'project', 'linked.md'), '# linked\n')
    await fsp.link(join(rootPath, 'project', 'linked.md'), join(rootPath, 'project', 'second.md'))

    const done = await copy(['project'], ['copied'])
    expect(done.ok).toBe(true)

    const original = await fsp.stat(join(rootPath, 'project', 'linked.md'), { bigint: true })
    const duplicate = await fsp.stat(join(rootPath, 'copied', 'linked.md'), { bigint: true })
    expect(duplicate.ino, 'the copy must be its own inode').not.toBe(original.ino)
    expect(duplicate.nlink, 'and must not carry the source link count').toBe(1n)
  })
})

describe('symlinks and other things that are not content', () => {
  it('never follows a symlink out of the root', async () => {
    /**
     * v1's `copyDir` dereferenced every symlink — so a link pointing outside the registered folder
     * copied data from outside the root INTO the root. Here it is skipped and reported.
     */
    const outside = join(sandbox, 'outside-secret.md')
    await fsp.writeFile(outside, 'must never be copied in\n')
    await fsp.symlink(outside, join(rootPath, 'project', 'link.md'))

    const done = await copy(['project'], ['copied'])
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(await exists('copied', 'link.md')).toBe(false)
    expect(done.value.skippedSymlinks).toContain('link.md')
  })

  it('reports what it skipped rather than dropping it silently', async () => {
    // A copy that quietly produces fewer files than the source is the shape of the original
    // disaster. Whatever is not copied has to be named.
    await fsp.symlink(join(sandbox, 'nowhere'), join(rootPath, 'project', 'dangling.md'))
    const planned = await planRecursiveCopy(root, ['project'], ['copied'])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.value.skippedSymlinks).toContain('dangling.md')
  })
})

describe('what it refuses, before anything is created', () => {
  it('refuses to copy a folder into itself', async () => {
    const done = await copy(['project'], ['project', 'inner', 'copy'])
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.PATH_TRAVERSAL)
  })

  it('refuses when the destination already exists, and does not touch it', async () => {
    await fsp.mkdir(join(rootPath, 'taken'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'taken', 'keep.md'), 'keep me\n')

    const done = await copy(['project'], ['taken'])
    expect(done.ok).toBe(false)
    if (done.ok) return
    // `NAME_TAKEN` since P7: `CONFLICT_DETECTED`'s one sentence is "The file changed on disk since
    // you opened it", which is false of a name collision — and Duplicate hits this constantly.
    expect(done.code).toBe(ErrorCode.NAME_TAKEN)
    expect(await fsp.readFile(join(rootPath, 'taken', 'keep.md'), 'utf8')).toBe('keep me\n')
  })

  it('refuses over the file cap, creating nothing', async () => {
    const done = await copy(['project'], ['copied'], { maxFiles: 2 })
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.TOO_LARGE)
    expect(await exists('copied'), 'nothing may be created by a refused copy').toBe(false)
    expect(await fsp.readdir(stagingRoot)).toEqual([])
  })

  it('refuses over the byte cap', async () => {
    const done = await copy(['project'], ['copied'], { maxBytes: 1 })
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.TOO_LARGE)
    expect(await exists('copied')).toBe(false)
  })

  it('refuses a destination folder that does not exist', async () => {
    const done = await copy(['project'], ['no-such-folder', 'copied'])
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.PARENT_MISSING)
    expect(await exists('no-such-folder')).toBe(false)
  })

  /**
   * **A single file COPIES as of P7**, where it used to be refused.
   *
   * The build plan put "single-file verbatim copy" in P8 with Templates, but the row action needing
   * it is Duplicate, which the PRD puts on the Files tab: *"Duplicate (file or whole folder)"*. The
   * verb moved to the phase that ships the menu.
   */
  it('copies a single FILE, byte for byte', async () => {
    const done = await copy(['project', 'a.md'], ['copied.md'])
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.value.files).toBe(1)
    expect(done.value.directories).toBe(0)
    expect(await fsp.readFile(join(rootPath, 'copied.md'))).toEqual(
      await fsp.readFile(join(rootPath, 'project', 'a.md')))
  })

  it('a single-file copy leaves the source alone', async () => {
    const before = await fsp.readFile(join(rootPath, 'project', 'a.md'))
    await copy(['project', 'a.md'], ['copied.md'])
    expect(await fsp.readFile(join(rootPath, 'project', 'a.md'))).toEqual(before)
  })

  it('plans a single file as one file and no directories', async () => {
    const planned = await planRecursiveCopy(root, ['project', 'a.md'], ['copied.md'])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.value.files).toBe(1)
    expect(planned.value.directories).toBe(0)
    expect(planned.value.bytes).toBeGreaterThan(0)
    // A plan writes nothing.
    expect(await exists('copied.md')).toBe(false)
  })

  it('refuses to copy a single file over an existing name', async () => {
    await fsp.writeFile(join(rootPath, 'occupied.md'), 'do not destroy me\n')
    const done = await copy(['project', 'a.md'], ['occupied.md'])
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.NAME_TAKEN)
    expect(await fsp.readFile(join(rootPath, 'occupied.md'), 'utf8')).toBe('do not destroy me\n')
  })

  it('refuses a symlink as the source', async () => {
    await fsp.symlink(join(rootPath, 'project'), join(rootPath, 'a-link'))
    const done = await copy(['a-link'], ['copied'])
    expect(done.ok).toBe(false)
  })

  /**
   * **A UNIX SOCKET, because a symlink does not reach the check being tested.**
   *
   * The sweep showed the `kind` refusal green: `walkAndVerify` rejects a symlinked segment with
   * `PATH_SYMLINK` long before `checkShape` sees a kind, so the symlink test above proves the
   * containment rule rather than this one. §13.7's *"skip non-regular files"* is about sockets,
   * FIFOs and device nodes — and named directly as a source there is nothing to skip TO.
   */
  it('refuses a non-regular file — a socket — as the source', async () => {
    const socketPath = join(rootPath, 'a.sock')
    const server = createServer()
    await new Promise<void>(resolve => { server.listen(socketPath, () => { resolve() }) })
    try {
      const done = await copy(['a.sock'], ['copied'])
      expect(done.ok).toBe(false)
      if (done.ok) return
      expect(done.code).toBe(ErrorCode.NOT_REGULAR_FILE)
    } finally {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
  })

  /**
   * §13.7: *"copy `st_nlink > 1` by content, never by `fs.link`"* — and §4 refuses a hard link in
   * both directions, because a second name for the same inode may sit anywhere on the volume,
   * including outside every registered root.
   */
  it('refuses a hard-linked file as the source', async () => {
    await fsp.link(join(rootPath, 'project', 'a.md'), join(rootPath, 'hardlink.md'))
    const done = await copy(['hardlink.md'], ['copied.md'])
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.HARDLINKED)
  })

  it('refuses a single file over the byte cap, creating nothing', async () => {
    // The cap applies to a lone file too. Without this the single-file branch is a way past it.
    const done = await copy(['project', 'a.md'], ['copied.md'], { maxBytes: 1 })
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.TOO_LARGE)
    expect(await exists('copied.md')).toBe(false)
  })

  it('refuses a source outside the root', async () => {
    const done = await copy(['..', 'elsewhere'], ['copied'])
    expect(done.ok).toBe(false)
  })

  it('plans without writing anything at all', async () => {
    const planned = await planRecursiveCopy(root, ['project'], ['copied'])
    expect(planned.ok).toBe(true)
    expect(await exists('copied')).toBe(false)
    expect(await fsp.readdir(stagingRoot)).toEqual([])
  })
})

describe('a failed copy leaves NOTHING behind — the v1 partial tree', () => {
  it('creates no destination when a file vanishes mid-copy', async () => {
    /**
     * **The test this whole module exists for.** v1's copyDir threw part-way through and left a
     * half-written tree at the destination with no rollback — half a project, in a filesystem that
     * *is* the database.
     *
     * Here the copy is made to fail after the pre-flight has succeeded, by removing a file between
     * the plan and the copy. The destination must not exist at all: not empty, not partial,
     * absent.
     */
    const planned = await planRecursiveCopy(root, ['project'], ['copied'])
    expect(planned.ok).toBe(true)

    await fsp.rm(join(rootPath, 'project', 'inner', 'b.md'))

    const done = await recursiveCopy(root, ['project'], ['copied'], stagingRoot, [root])
    // It may succeed with one fewer file (the walk reruns) or fail; what is NOT allowed is a
    // partial tree. Both branches are checked rather than assuming which one happens.
    if (done.ok) {
      expect(await exists('copied', 'a.md')).toBe(true)
      expect(await exists('copied', 'inner', 'c.md')).toBe(true)
    } else {
      expect(await exists('copied'), 'no partial tree may be left at the destination').toBe(false)
    }
    expect(await fsp.readdir(stagingRoot), 'and no scratch is left behind').toEqual([])
  })

  it('creates no destination when the staging area is unusable', async () => {
    // A staging area inside the registered root is refused by staging.ts. The copy must surface
    // that as a refusal with nothing created, not stumble on.
    const done = await recursiveCopy(
      root, ['project'], ['copied'], join(rootPath, 'inside-staging'), [root],
    )
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.INVALID_ROOT)
    expect(await exists('copied')).toBe(false)
    expect(await exists('inside-staging')).toBe(false)
  })

  it('refuses rather than overwriting a destination that appears mid-copy', async () => {
    /**
     * The pre-flight found the destination free. By the time the tree is ready, something else has
     * taken the name — an agent, another device. The move into place must refuse, and the thing
     * that appeared must survive.
     *
     * Driven by planning first, then creating the destination, then copying: the same sequence
     * without the race.
     */
    const planned = await planRecursiveCopy(root, ['project'], ['racy'])
    expect(planned.ok).toBe(true)

    await fsp.mkdir(join(rootPath, 'racy'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'racy', 'theirs.md'), 'arrived first\n')

    const done = await recursiveCopy(root, ['project'], ['racy'], stagingRoot, [root])
    expect(done.ok).toBe(false)
    expect(await fsp.readFile(join(rootPath, 'racy', 'theirs.md'), 'utf8')).toBe('arrived first\n')
    expect(await exists('racy', 'a.md'), 'and none of the copy leaked in').toBe(false)
    expect(await fsp.readdir(stagingRoot)).toEqual([])
  })
})

describe('the four the sweep found undefended', () => {
  it('refuses an EMPTY directory that appears at the destination mid-copy', async () => {
    /**
     * The racy test above uses a *non-empty* destination, and `rename` refuses that on its own with
     * `ENOTEMPTY` — so the explicit check could be deleted and nothing noticed. An **empty**
     * directory is the gap: `rename` will happily replace one, so only the check stands between a
     * destination someone else just created and it quietly disappearing.
     */
    const planned = await planRecursiveCopy(root, ['project'], ['empty-race'])
    expect(planned.ok).toBe(true)

    await fsp.mkdir(join(rootPath, 'empty-race'), { recursive: true })

    const done = await recursiveCopy(root, ['project'], ['empty-race'], stagingRoot, [root])
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.NAME_TAKEN)
    expect(await exists('empty-race', 'a.md'), 'the copy must not have landed').toBe(false)
    expect(await fsp.readdir(stagingRoot)).toEqual([])
  })

  it('makes the PLAN fail on an unreadable directory, not just the copy', async () => {
    /**
     * The copy has its own read check, so a test driven through `recursiveCopy` cannot tell which
     * of the two fired — deleting the pre-flight one left the suite green. Driving the plan
     * directly isolates it.
     *
     * §6 with teeth: a directory silently treated as empty produces a plan that under-counts, a
     * copy missing a whole subtree, and a confirmation dialog quoting a number that is wrong.
     */
    const locked = join(rootPath, 'project', 'locked-plan')
    await fsp.mkdir(locked, { recursive: true })
    await fsp.writeFile(join(locked, 'hidden.md'), '# hidden\n')
    await fsp.chmod(locked, 0o000)
    try {
      const planned = await planRecursiveCopy(root, ['project'], ['copied'])
      expect(planned.ok, 'the plan must not silently skip what it cannot read').toBe(false)
    } finally {
      await fsp.chmod(locked, 0o755)
    }
  })

  it('aborts on a directory it cannot read, rather than copying a smaller tree', async () => {
    /**
     * §6: "an empty-but-successful result never stands in for a failure." Here that rule has teeth
     * — a directory silently treated as empty produces a copy that is missing a whole subtree, and
     * nothing anywhere says so. That is the original disaster in miniature.
     */
    const locked = join(rootPath, 'project', 'locked')
    await fsp.mkdir(locked, { recursive: true })
    await fsp.writeFile(join(locked, 'hidden.md'), '# hidden\n')
    await fsp.chmod(locked, 0o000)
    try {
      const done = await copy(['project'], ['copied'])
      expect(done.ok, 'an unreadable directory must abort the copy').toBe(false)
      expect(await exists('copied'), 'and leave no partial tree').toBe(false)
    } finally {
      await fsp.chmod(locked, 0o755)
    }
  })

  it('re-validates each file during the copy, not just in the pre-flight', async () => {
    /**
     * §13.7 requires the source be re-validated per file *during* the walk. The pre-flight ran
     * earlier; an agent can replace a file with a symlink in between, and a copy that trusts the
     * plan would read straight through it — pulling content from outside the root into the root,
     * which is precisely v1's dereferencing bug arriving by a different door.
     */
    const outside = join(sandbox, 'outside-secret.md')
    await fsp.writeFile(outside, 'must never be copied in\n')

    const planned = await planRecursiveCopy(root, ['project'], ['copied'])
    expect(planned.ok).toBe(true)

    await fsp.rm(join(rootPath, 'project', 'a.md'))
    await fsp.symlink(outside, join(rootPath, 'project', 'a.md'))

    const done = await copy(['project'], ['copied'])

    /**
     * **The first version of this test asserted a refusal and was wrong about why.**
     * `recursiveCopy` re-runs the pre-flight itself, so the swapped-in symlink is caught at plan
     * time and skipped — the copy succeeds with one fewer file. The per-file re-validation only
     * covers a change landing between that internal plan and the copy, which is a genuine race no
     * test here can produce on demand.
     *
     * So this asserts the property that actually matters and is reachable: **content from outside
     * the root never appears inside it.**
     */
    expect(done.ok).toBe(true)
    expect(await exists('copied', 'a.md'), 'the symlink must not have been copied').toBe(false)
    for (const name of ['b.md', 'c.md']) {
      expect(await fsp.readFile(join(rootPath, 'copied', 'inner', name), 'utf8'))
        .not.toContain('must never be copied in')
    }
  })

  it('refuses when the DESTINATION path would exceed PATH_MAX', async () => {
    /**
     * A source that fits can produce a destination that does not — the copy's name is usually
     * longer than the original's, and the overflow lands part-way down the tree. Checked in bytes
     * during the pre-flight, so it refuses before anything is created rather than failing
     * `ENAMETOOLONG` half way through.
     */
    let deep = join(rootPath, 'deep-source')
    const segments = ['deep-source']
    await fsp.mkdir(deep, { recursive: true })
    while (Buffer.byteLength(deep, 'utf8') < 900) {
      const next = 'a-folder-with-a-fairly-long-name'
      segments.push(next)
      deep = join(deep, next)
      await fsp.mkdir(deep, { recursive: true })
    }
    await fsp.writeFile(join(deep, 'leaf.md'), '# leaf\n')

    const longName = 'x'.repeat(200)
    const done = await copy(['deep-source'], [longName])
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.NAME_TOO_LONG)
    expect(await exists(longName)).toBe(false)
  })
})

describe('the plan', () => {
  it('counts files, not directories, against the cap', async () => {
    const planned = await planRecursiveCopy(root, ['project'], ['copied'])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.value.files).toBe(3)
    expect(planned.value.directories).toBeGreaterThanOrEqual(2)
  })

  it('reports the byte total without keying the guard on it', async () => {
    // §13.7 M6: guards are measured in indexed files affected, not bytes — a directory rename
    // moves zero bytes. Bytes are still worth reporting to a person about to copy 400 MB.
    const planned = await planRecursiveCopy(root, ['project'], ['copied'])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.value.bytes).toBe(('# a\n' + '# b\n' + '# c\n').length)
  })
})

/**
 * **THE TEMPLATE SHAPE HAS TO SURVIVE THE COPY, AND `.gitkeep` IS WHAT CARRIES IT.**
 *
 * Phase 8. §3's dot rule keeps 527 `.DS_Store` files out of this app — not shown, not indexed, not
 * watched, not copied — and it was silently keeping `.gitkeep` out of every copy too.
 *
 * `.gitkeep` is the opposite of junk. Git cannot record an empty directory, so an empty folder that
 * is part of a shape exists in the repository **only** because of the zero-byte file inside it.
 * There are 823 in the real tree, and the operator's `op-template` depends on eight of them.
 *
 * Without the exception, scaffolding an op produces all 40 folders on disk — right in Finder, right
 * in the app — and the empty ones are absent from git. A shape that looks correct and does not
 * survive a clone is the worst failure this build collects, because nothing on the screen is wrong.
 */
/**
 * **P8-7 — a tree of nothing but folders walked straight past every cap.**
 *
 * security review, P8 review: *"`plan.directories` counted and never capped — 301 empty directories copied
 * under `maxFiles: 1`."*
 *
 * §13.7 keys the guard on **files**, and that is the right rule for the case it was written for: a
 * copy's cost is usually its bytes. It leaves a hole the shape of a directory. Every folder costs an
 * inode, a `readdir`, a `mkdir` and a queue entry, and a tree made entirely of them registers as
 * **zero** against both caps — so "refuse on cap" could be answered by a copy that never refuses.
 *
 * **Templates are what make it reachable rather than theoretical.** A template is frequently a shape
 * with no content in it at all — that is the entire reason `.gitkeep` gets an exception two describes
 * below. Directory-only trees are not an edge case here; they are the normal case.
 */
describe('a copy made entirely of directories still meets a cap', () => {
  it('refuses a directory-only tree that exceeds the directory cap', async () => {
    // Thirty nested folders and not one file.
    let path = join(rootPath, 'deep')
    for (let i = 0; i < 30; i++) {
      path = join(path, `level-${i}`)
    }
    await fsp.mkdir(path, { recursive: true })

    const result = await copy(['deep'], ['made'], { maxDirectories: 5 })
    expect(result.ok, 'a directory-only tree walked past its cap').toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ErrorCode.TOO_LARGE)
  })

  it('says how many, so the refusal is actionable', async () => {
    let path = join(rootPath, 'deep2')
    for (let i = 0; i < 10; i++) path = join(path, `level-${i}`)
    await fsp.mkdir(path, { recursive: true })

    const result = await copy(['deep2'], ['made2'], { maxDirectories: 3 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // §13.7: "Confirmation names the count." A refusal that names no number cannot be acted on.
    expect(result.detail ?? '').toContain('3')
  })

  it('still copies an ordinary shape well under the cap', async () => {
    // The other half: a cap that refuses real templates is worse than no cap.
    await fsp.mkdir(join(rootPath, 'small', 'a', 'b'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'small', 'a', 'note.md'), '# note\n')

    const result = await copy(['small'], ['made3'])
    expect(result.ok, 'an ordinary template was refused').toBe(true)
    expect(await exists('made3', 'a', 'note.md')).toBe(true)
  })
})

describe('the one ignored name a copy carries through', () => {
  beforeEach(async () => {
    await fsp.mkdir(join(rootPath, 'template', 'empty-folder'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'template', 'empty-folder', '.gitkeep'), '')
    await fsp.writeFile(join(rootPath, 'template', '.DS_Store'), 'finder junk')
    await fsp.writeFile(join(rootPath, 'template', 'context.md'), '# context\n')
  })

  /**
   * **P8-6 — the exception is for a FILE named `.gitkeep`, never a directory of that name.**
   *
   * security review, P8 review: *"The `.gitkeep` exception is a **recursive** carve-out: a directory named
   * `.gitkeep` is descended into and copied whole."*
   *
   * `isCarriedThrough` tested the leaf name and nothing else, so a **directory** called `.gitkeep`
   * passed §3's ignore filter — and the loop then saw a directory and walked into it, carrying
   * everything underneath. §3's whole purpose is that ignored trees are not content; this reopened
   * one of them through a name.
   *
   * **Latent — the security review marked it Low because zero exist in the real tree**, and that is the reason the
   * fixture below has to create one. A defect that needs a specific name to appear is exactly the
   * kind that arrives years later, from a tool nobody chose, and is impossible to explain when it
   * does.
   */
  it('does NOT descend a DIRECTORY named .gitkeep, or carry what is inside it', async () => {
    await fsp.mkdir(join(rootPath, 'template', '.gitkeep', 'nested'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'template', '.gitkeep', 'secret.md'), '# not content\n')
    await fsp.writeFile(join(rootPath, 'template', '.gitkeep', 'nested', 'deep.md'), '# deeper\n')

    const result = await copy(['template'], ['made'])
    expect(result.ok).toBe(true)

    expect(await exists('made', '.gitkeep', 'secret.md'), 'a .gitkeep DIRECTORY was copied')
      .toBe(false)
    expect(await exists('made', '.gitkeep', 'nested', 'deep.md'), 'and it was descended into')
      .toBe(false)
    // And the directory itself does not appear either — an ignored name must not materialise in a
    // copy as an empty folder, which looks like part of the shape and is not.
    expect(await exists('made', '.gitkeep'), 'an ignored DIRECTORY was created in the copy')
      .toBe(false)
  })

  it('copies .gitkeep, so the empty folder still exists in git', async () => {
    const result = await copy(['template'], ['made'])
    expect(result.ok).toBe(true)
    expect(await exists('made', 'empty-folder', '.gitkeep')).toBe(true)
  })

  /** The general rule is untouched. The operator declined exclusion code because none was needed. */
  it('still skips every other dotfile', async () => {
    const result = await copy(['template'], ['made'])
    expect(result.ok).toBe(true)
    expect(await exists('made', '.DS_Store')).toBe(false)
  })

  /**
   * **The plan and the copy must agree exactly**, and they are two separate loops with the same
   * two conditions in them. A file the plan counts and the copy skips is a silently smaller tree;
   * a file the copy writes that the plan never counted is a copy that outruns its own caps. Both
   * are the shape §13.7 exists to prevent, so the count is asserted rather than assumed.
   */
  it('counts the carried file in the plan, so the caps still see it', async () => {
    const planned = await planRecursiveCopy(root, ['template'], ['made'])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    // `context.md` and `.gitkeep`. Not `.DS_Store`.
    expect(planned.value.files).toBe(2)
    expect(planned.value.skippedIgnored).toEqual(['.DS_Store'])
  })

  /**
   * **A `.gitkeep` inside an ignored directory is not rescued**, and the reason is worth stating
   * because a guard was written for it and then deleted.
   *
   * The exception first carried an ancestor check — carry the leaf only if no ancestor is ignored.
   * The sweep would not turn it red: replacing it with `true` changed nothing anywhere, because
   * both loops skip an ignored *directory* before queueing it, so the walk never enters one and
   * the clause could never fire. The property below is real; it is enforced by the skip that never
   * descends, one level above where the guard was sitting.
   */
  it('does not walk into an ignored directory to rescue a .gitkeep inside it', async () => {
    await fsp.mkdir(join(rootPath, 'template', 'node_modules', 'pkg'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'template', 'node_modules', 'pkg', '.gitkeep'), '')

    const result = await copy(['template'], ['made'])
    expect(result.ok).toBe(true)
    expect(await exists('made', 'node_modules')).toBe(false)
  })
})
