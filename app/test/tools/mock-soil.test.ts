/**
 * The mock-soil generator, and the refusals that keep it away from the real tree.
 *
 * Two things are being proven here and they are not the same weight.
 *
 * The **build** tests say the tree contains what it claims to contain. Useful; a broken fixture
 * wastes a day.
 *
 * The **refusal** tests are the ones that matter. This module holds a recursive delete, and the
 * standing rule it operates under is the operator's: *"before we do anything to actual soil files
 * please let me know"* — *"we can't afford to play with those."* A guard that is only ever
 * exercised by pointing it at the thing it protects is a guard nobody exercises, so
 * `checkTarget` takes the repository root and the home directory as parameters and every refusal
 * below is fired against a temporary tree. One test does aim it at the real repository, and that
 * one is read-only by construction: it asserts a refusal, so nothing can be written even if the
 * assertion is wrong.
 */

import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  checkTarget, findRepositoryRoot, makeMockSoil, MARKER, removeMockSoil,
  type BuildReport,
} from '../support/mock-soil/generate.ts'
import { bulkFiles, NOTABLE } from '../support/mock-soil/tree.ts'

/** A scratch area far from anything real: several segments deep, outside the repo, outside home. */
const scratch = async (): Promise<string> => fsp.mkdtemp(join(tmpdir(), 'mock-soil-test-'))

/** Stand-ins, so the refusals are provable without going anywhere near the actual paths. */
// Deep enough that the "too close to the root" guard is not what fires — each refusal below has
// to be provoked by the rule it names, not by an unrelated rule that happens to run first.
const FAKE_PARENT = `${sep}tmp${sep}pretend${sep}place`
const FAKE_REPO = `${FAKE_PARENT}${sep}repository`
const FAKE_HOME = `${FAKE_PARENT}${sep}home`
const HOME_ELSEWHERE = `${sep}elsewhere${sep}another${sep}home`

describe('checkTarget — what the generator refuses to touch', () => {
  it('refuses a relative path', async () => {
    const verdict = await checkTarget('mock-tree', FAKE_REPO, FAKE_HOME)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('absolute')
  })

  it.each([
    ['/', 'the filesystem root'],
    ['/Users', 'a one-segment path'],
    ['/Users/somebody', 'a two-segment path'],
  ])('refuses %s (%s)', async (target) => {
    const verdict = await checkTarget(target, FAKE_REPO, FAKE_HOME)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('three path segments')
  })

  it('refuses the home directory itself', async () => {
    const verdict = await checkTarget(FAKE_HOME, FAKE_REPO, FAKE_HOME)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('home directory')
  })

  it('refuses an ancestor of the home directory', async () => {
    const verdict = await checkTarget(FAKE_PARENT, FAKE_REPO, FAKE_HOME)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('home directory or contains it')
  })

  it('refuses the repository root', async () => {
    const verdict = await checkTarget(FAKE_REPO, FAKE_REPO, FAKE_HOME)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('inside the repository')
  })

  it('refuses a path inside the repository', async () => {
    const verdict = await checkTarget(`${FAKE_REPO}${sep}apps${sep}mock`, FAKE_REPO, FAKE_HOME)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('inside the repository')
  })

  it('refuses an ancestor of the repository', async () => {
    // Home is deliberately somewhere else here, so the home rule cannot be what refuses this.
    const verdict = await checkTarget(FAKE_PARENT, FAKE_REPO, HOME_ELSEWHERE)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('contains the repository')
  })

  it('compares whole segments — a sibling that merely shares a prefix is allowed', async () => {
    // spec §5's bug, in this module's own guard: `/repository-mock` is not inside `/repository`.
    const verdict = await checkTarget(`${FAKE_REPO}-mock`, FAKE_REPO, FAKE_HOME)
    expect(verdict.ok).toBe(true)
  })

  it('THE ONE THAT MATTERS: refuses the real repository this code lives in', async () => {
    // Read-only by construction — it asserts a refusal, so nothing is written either way.
    const real = await findRepositoryRoot()
    expect(real).not.toBe('')
    for (const target of [real, join(real, 'apps'), join(real, '02-projects', 'anything')]) {
      const verdict = await checkTarget(target, real)
      expect(verdict.ok, `should refuse ${target}`).toBe(false)
    }
  })

  /**
   * **THE ROOT MUST BE THE ROOT EVEN WITH NO `.git`, and this was live for weeks.**
   *
   * `findRepositoryRoot` walks up looking for `.git`. Its fallback used to be `return from` — the
   * directory of `generate.ts` itself, four levels *inside* the repository. Every check above then
   * measured against `test/support/mock-soil` instead of the repository, so **a tree written at the
   * repository top passed the guard whose entire job is to forbid that.**
   *
   * A `.git` directory is present in every ordinary checkout, which is why nothing caught it. It is
   * absent in exactly the two cases where this matters: a copy taken deliberately without history,
   * and a source archive downloaded rather than cloned. Verified 2026-09-01 on such a copy — the
   * generator allowed it, and 1,637 generated files were sitting inside a checkout awaiting release.
   *
   * The assertion is on the *shape* of the answer rather than on a literal path: whatever the root
   * is, `app/` must sit beneath it. That holds under git and without it, and it fails the moment the
   * fallback starts returning somewhere inside the tree again.
   */
  it('resolves the repository root even in a checkout with no git history', async () => {
    const root = await findRepositoryRoot()

    // The marker that this is a repository root and not some directory within it.
    await expect(fsp.stat(join(root, 'app', 'package.json'))).resolves.toBeDefined()

    // And the guard built on it still refuses, which is the property that actually failed.
    for (const target of [root, join(root, '.mock-soil'), join(root, 'app', 'anything')]) {
      expect((await checkTarget(target, root)).ok, `should refuse ${target}`).toBe(false)
    }
  })

  it('refuses a directory that exists without our marker — any real folder, in other words', async () => {
    const dir = await scratch()
    try {
      await fsp.writeFile(join(dir, 'someone-elses-file.md'), 'important')
      const verdict = await checkTarget(dir, FAKE_REPO, FAKE_HOME)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toContain(MARKER)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('allows a directory that carries the marker', async () => {
    const dir = await scratch()
    try {
      await fsp.writeFile(join(dir, MARKER), 'ours')
      expect((await checkTarget(dir, FAKE_REPO, FAKE_HOME)).ok).toBe(true)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a symlink at the target rather than following it', async () => {
    const parent = await scratch()
    try {
      const real = join(parent, 'real-directory')
      await fsp.mkdir(real)
      await fsp.writeFile(join(real, MARKER), 'ours') // marker present at the far end
      const link = join(parent, 'a-link')
      await fsp.symlink(real, link)
      const verdict = await checkTarget(link, FAKE_REPO, FAKE_HOME)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toContain('symlink')
    } finally {
      await fsp.rm(parent, { recursive: true, force: true })
    }
  })

  it('refuses a path that exists and is not a directory', async () => {
    const parent = await scratch()
    try {
      const file = join(parent, 'a-file')
      await fsp.writeFile(file, 'x')
      const verdict = await checkTarget(file, FAKE_REPO, FAKE_HOME)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toContain('not a directory')
    } finally {
      await fsp.rm(parent, { recursive: true, force: true })
    }
  })

  it('makeMockSoil throws on a refusal rather than returning one', async () => {
    await expect(makeMockSoil(FAKE_REPO, { repositoryRoot: FAKE_REPO, home: FAKE_HOME }))
      .rejects.toThrow(/Refusing to build/)
  })
})

describe('removeMockSoil — the recursive delete', () => {
  it('refuses a directory without the marker, even one it is otherwise allowed to touch', async () => {
    const dir = await scratch()
    try {
      await fsp.writeFile(join(dir, 'not-ours.md'), 'important')
      await expect(removeMockSoil(dir, { repositoryRoot: FAKE_REPO, home: FAKE_HOME }))
        .rejects.toThrow(new RegExp(MARKER.replace('.', '\\.')))
      // and the file is still there
      expect(await fsp.readFile(join(dir, 'not-ours.md'), 'utf8')).toBe('important')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('still runs the location checks, even for a directory carrying our marker', async () => {
    // The marker alone must not be a licence. Without this, deleting the `checkTarget` call from
    // `removeMockSoil` changes nothing any test can see — measured, it was one of two GREEN
    // mutations in the first sweep of this module.
    const dir = await scratch()
    try {
      await fsp.writeFile(join(dir, MARKER), 'ours')
      // Claim the repository lives one level up, so this marked directory is inside it.
      await expect(removeMockSoil(dir, { repositoryRoot: join(dir, '..'), home: FAKE_HOME }))
        .rejects.toThrow(/Refusing to remove.*inside the repository/s)
      expect(await fsp.readFile(join(dir, MARKER), 'utf8')).toBe('ours')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('looks for the marker again at the moment of removal, not only up front', async () => {
    // The window: `checkTarget` sees the marker, something removes it, and the delete proceeds.
    // Ordinary operation cannot enter this window, which is why the second check needed a seam —
    // it was the other GREEN mutation in the first sweep, on the recursive delete itself.
    const dir = await scratch()
    try {
      await fsp.writeFile(join(dir, MARKER), 'ours')
      await fsp.writeFile(join(dir, 'a-file.md'), 'should survive')

      await expect(removeMockSoil(dir, {
        repositoryRoot: FAKE_REPO,
        home: FAKE_HOME,
        beforeMarkerCheck: async () => { await fsp.rm(join(dir, MARKER)) },
      })).rejects.toThrow(/no ".*" file at the moment of removal/)

      expect(await fsp.readFile(join(dir, 'a-file.md'), 'utf8')).toBe('should survive')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('reports false, rather than throwing, when there is nothing there', async () => {
    const parent = await scratch()
    try {
      const missing = join(parent, 'never-created')
      expect(await removeMockSoil(missing, { repositoryRoot: FAKE_REPO, home: FAKE_HOME })).toBe(false)
    } finally {
      await fsp.rm(parent, { recursive: true, force: true })
    }
  })

  it('removes a marked tree including a directory whose mode forbids it', async () => {
    // One hazard is a 0555 directory. Its children cannot be unlinked until the mode is restored,
    // so without that step the rebuild fails on the second run and not the first.
    const dir = await scratch()
    const locked = join(dir, 'locked')
    await fsp.writeFile(join(dir, MARKER), 'ours')
    await fsp.mkdir(locked)
    await fsp.writeFile(join(locked, 'inside.md'), 'x')
    await fsp.chmod(locked, 0o555)

    expect(await removeMockSoil(dir, { repositoryRoot: FAKE_REPO, home: FAKE_HOME })).toBe(true)
    await expect(fsp.stat(dir)).rejects.toThrow()
  })
})

describe('bulkFiles — deterministic by construction', () => {
  it('produces byte-identical output for the same seed', () => {
    const a = bulkFiles(1234)
    const b = bulkFiles(1234)
    expect(a.length).toBe(b.length)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('produces different output for a different seed', () => {
    expect(JSON.stringify(bulkFiles(1))).not.toBe(JSON.stringify(bulkFiles(2)))
  })

  it('has no duplicate paths', () => {
    const files = bulkFiles()
    expect(new Set(files.map(([p]) => p)).size).toBe(files.length)
  })
})

describe('THE CONSTRUCT CENSUS — the fake soil carries what the real one does', () => {
  /**
   * **Phase 5 needs this tree to stand in for a corpus of damage**, and the old editor's destruction
   * was per-construct: frontmatter flattened, wikilinks escaped, task boxes lost, footnotes escaped.
   * A corpus missing a construct cannot detect the loss of it.
   *
   * The first version of this generator carried tables, fences, blockquotes and lists — and **zero
   * frontmatter, zero wikilinks, zero task boxes, zero footnotes, zero images, one HTML tag.** It
   * was built for *filesystem* hazards, is excellent at those, and was blind to markdown ones. That
   * gap would have produced a harness reporting a clean sweep over a corpus containing nothing that
   * had ever broken.
   *
   * Shares measured on the real tree, 2026-08-08, as a fraction of files containing each construct.
   *
   * **The floor is a file count, not a ratio, and that is the honest bound.** A ratio floor failed
   * here on the first run: HTML comments came out at 0.8% against a 1.4% draw — twelve files where
   * twenty were expected, which is ordinary variance for a seeded PRNG at n≈1,400 and not a
   * coverage failure at all. Asserting a percentage on a rare construct is asserting that a random
   * draw hit a number, which is how a test becomes flaky and then becomes deleted.
   *
   * So: **at least eight files must carry it** — enough that damage to it is measurable — and the
   * ceiling stays a ratio, since overshoot means the generator has started producing something the
   * real tree does not look like. What this is really guarding against is a return to zero.
   */
  const MINIMUM_FILES = 8
  const EXPECTED: readonly [name: string, pattern: RegExp, share: number][] = [
    ['frontmatter', /^---$/m, 0.49],
    ['code fence', /^```/m, 0.16],
    ['blockquote', /^> /m, 0.14],
    ['table', /^\|.*\|/m, 0.13],
    ['html tag', /<[a-z]/, 0.10],
    ['wikilink', /\[\[/, 0.054],
    ['task box', /^- \[[ x]\]/m, 0.031],
    ['html comment', /<!--/, 0.014],
    // The rare tail, DELIBERATELY over-represented — see `CONSTRUCT_SHARE`. The real tree's own
    // rates put these in five or six files, which is representative and unmeasurable. The share
    // asserted here is the generator's target, not the tree's rate.
    ['image', /!\[/, 0.012],
    ['entity', /&[a-z]+;/, 0.012],
    ['footnote', /\[\^/, 0.012],
  ]

  const bulk = bulkFiles()

  it.each(EXPECTED)('carries %s at roughly the real tree\'s weight', (name, pattern, share) => {
    const matching = bulk.filter(([, body]) => pattern.test(body)).length
    const actual = matching / bulk.length

    expect(
      matching,
      `${name}: only ${matching} files carry it — the corpus cannot measure damage to it`,
    ).toBeGreaterThanOrEqual(MINIMUM_FILES)
    expect(actual, `${name}: ${(100 * actual).toFixed(1)}% vs ${(100 * share).toFixed(1)}% real`)
      .toBeLessThan(share * 1.7 + 0.02)
  })

  it('frontmatter is the FIRST bytes of the file, or it is not frontmatter', () => {
    /**
     * The old editor rendered a leading `---` block as a thematic break plus a setext heading and
     * silently flattened it in 944 files — the single largest category of damage. A generator that
     * put frontmatter after the H1 would produce a corpus where that bug cannot occur.
     */
    const withFrontmatter = bulk.filter(([, body]) => body.startsWith('---\n'))
    expect(withFrontmatter.length).toBeGreaterThan(0)
    for (const [path, body] of withFrontmatter.slice(0, 50)) {
      const end = body.indexOf('\n---\n', 4)
      expect(end, `${path}: the block is never closed`).toBeGreaterThan(0)
      expect(body.slice(end + 5).startsWith('\n# '), `${path}: content follows the block`).toBe(true)
    }
  })
})

describe('the built tree', () => {
  let root: string
  let report: BuildReport

  beforeAll(async () => {
    root = join(await scratch(), 'mock')
    report = await makeMockSoil(root, { repositoryRoot: FAKE_REPO, home: FAKE_HOME })
  }, 120_000)

  afterAll(async () => {
    if (root) {
      await removeMockSoil(root, { repositoryRoot: FAKE_REPO, home: FAKE_HOME }).catch(() => undefined)
      await fsp.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('reaches the scale of the real tree, in files AND in directories', () => {
    // Real soil, measured 2026-08-08: 1,567 markdown files across 1,822 directories — 0.86 files
    // per directory. The first build hit the file count and missed the directory count by half,
    // which is a fixture that looks the right size and exercises the walk at half load. Both
    // numbers are asserted for that reason.
    expect(report.files).toBeGreaterThan(1_400)
    expect(report.directories).toBeGreaterThan(1_300)
    expect(report.files / report.directories).toBeLessThan(1.2)
  })

  it('carries the marker that licenses its own removal', async () => {
    expect(await fsp.readFile(join(root, MARKER), 'utf8')).toContain('MOCK')
  })

  it('says in its own README that none of it is real', async () => {
    expect(await fsp.readFile(join(root, 'README.md'), 'utf8')).toContain('not your soil')
  })

  it.each(NOTABLE.map(n => [n.path, n.expect, n.note] as const))(
    'has %s (%s)', async (relative, expected) => {
      const full = join(root, relative)
      const stats = await fsp.lstat(full)

      switch (expected) {
        case 'symlink':
          expect(stats.isSymbolicLink()).toBe(true)
          return
        case 'dir':
          expect(stats.isDirectory()).toBe(true)
          return
        case 'unreadable':
          expect(stats.mode & 0o777).toBe(0)
          await expect(fsp.readFile(full)).rejects.toThrow()
          return
        case 'read-only':
          expect(stats.mode & 0o222).toBe(0)
          return
        case 'file':
          expect(stats.isFile()).toBe(true)
          return
      }
    })

  it('has a symlink that escapes the tree, and it is not followed by lstat', async () => {
    const link = join(root, 'zz-hazards/links/link-escaping-the-tree')
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fsp.readlink(link)).toBe('/etc')
  })

  it('has a broken symlink — lstat succeeds where stat fails', async () => {
    const link = join(root, 'zz-hazards/links/broken-link.md')
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true)
    await expect(fsp.stat(link)).rejects.toThrow()
  })

  it('has a hard link, so st_nlink is 2 on both names', async () => {
    const one = await fsp.lstat(join(root, 'zz-hazards/links/hardlink-copy.md'))
    const two = await fsp.lstat(join(root, 'zz-hazards/links/hardlink-original.md'))
    expect(one.nlink).toBe(2)
    expect(two.nlink).toBe(2)
    expect(one.ino).toBe(two.ino)
  })

  it('straddles MAX_EDITABLE_BYTES with a file either side', async () => {
    const cap = 2 * 1024 * 1024
    expect((await fsp.stat(join(root, 'zz-hazards/content-edges/just-under-the-cap.md'))).size)
      .toBeLessThan(cap)
    expect((await fsp.stat(join(root, 'zz-hazards/content-edges/over-the-cap.md'))).size)
      .toBeGreaterThan(cap)
  })

  it('has bytes that are not valid UTF-8, and a decode does not round-trip', async () => {
    const bytes = await fsp.readFile(join(root, 'zz-hazards/content-edges/invalid-utf8.md'))
    const roundTripped = Buffer.from(bytes.toString('utf8'), 'utf8')
    expect(roundTripped.equals(bytes)).toBe(false)
  })

  it('has a NUL byte inside a text file', async () => {
    const bytes = await fsp.readFile(join(root, 'zz-hazards/content-edges/nul-byte-inside.md'))
    expect(bytes.includes(0x00)).toBe(true)
  })

  it('keeps CRLF and a lone CR exactly as written', async () => {
    const crlf = await fsp.readFile(join(root, 'zz-hazards/content-edges/crlf-line-endings.md'), 'utf8')
    expect(crlf).toContain('\r\n')
    const cr = await fsp.readFile(join(root, 'zz-hazards/content-edges/lone-cr-line-endings.md'), 'utf8')
    expect(cr).toContain('\r')
    expect(cr).not.toContain('\n')
  })

  it('has an empty file and an empty directory', async () => {
    expect((await fsp.stat(join(root, 'zz-hazards/content-edges/empty.md'))).size).toBe(0)
    const dir = await fsp.stat(join(root, 'zz-hazards/content-edges/an-empty-folder'))
    expect(dir.isDirectory()).toBe(true)
  })

  it('has a conflict artifact sitting beside its canonical file', async () => {
    const dir = await fsp.readdir(join(root, 'zz-hazards/already-conflicted'))
    expect(dir).toContain('harvest-plan.md')
    expect(dir.some(n => /^harvest-plan\.conflict-\d{8}-\d{6}-[a-z0-9]{4}\.md$/.test(n))).toBe(true)
  })

  it('reaches sixteen levels, as the real tree does', async () => {
    const deepest = NOTABLE.find(n => n.note.includes('sixteen levels'))
    expect(deepest).toBeDefined()
    const depth = join(root, deepest!.path).split(sep).length - root.split(sep).length
    expect(depth).toBe(16) // counted the same way the real tree's 16 was counted, from its root
    expect((await fsp.lstat(join(root, deepest!.path))).isFile()).toBe(true)
  })

  it('is rebuildable — a second run over the same location succeeds', async () => {
    // The first build wrote a 0555 directory and a 0000 file. If removal could not cope with
    // those, this is where it would surface, and only here.
    const second = await makeMockSoil(root, { repositoryRoot: FAKE_REPO, home: FAKE_HOME })
    expect(second.files).toBe(report.files)
    expect(second.bytes).toBe(report.bytes)
  }, 120_000)
})
