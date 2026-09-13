import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { type RegisteredRoot } from '../../../src/core/fs/containment'
import { registerRoot } from '../../../src/core/fs/registration'
import {
  exclusiveRename,
  movesIntoOwnDescendant,
  suggestFreeName,
} from '../../../src/core/fs/rename'

/**
 * Real files, real hard links, real directories. §13.6 is a set of claims about what the kernel
 * does when two names point at the same place, and a mock could not disagree with itself.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree, created and destroyed here.
 */
let sandbox: string
let rootPath: string
let root: RegisteredRoot

const MINE = '# mine, and it must survive\n'
const THEIRS = '# theirs, and it must also survive\n'

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p4-rename-'))
  rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })
  const registered = await registerRoot('scratch', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value
})

afterAll(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const read = (...segments: string[]) => fsp.readFile(join(rootPath, ...segments), 'utf8')
const exists = (...segments: string[]) =>
  fsp.lstat(join(rootPath, ...segments)).then(() => true, () => false)

describe('THE DEFECT THIS MODULE EXISTS FOR', () => {
  it('refuses to rename onto an existing file, and leaves both files intact', async () => {
    /**
     * v1 called plain `rename(2)` for user-facing Rename. That call **succeeds** over an existing
     * file and destroys it — no error, no confirmation, no trace, one tap, in an app whose headline
     * promise is that nothing is ever destroyed.
     *
     * The control below is the kernel's: `link` returns `EEXIST` and there is no window between
     * checking and acting. The assertion that matters is the last one — the destination still
     * holds its own bytes.
     */
    await fsp.writeFile(join(rootPath, 'source.md'), MINE)
    await fsp.writeFile(join(rootPath, 'occupied.md'), THEIRS)

    const moved = await exclusiveRename(root, ['source.md'], ['occupied.md'])
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe(ErrorCode.NAME_TAKEN)

    expect(await read('occupied.md'), 'the destination must NOT have been destroyed').toBe(THEIRS)
    expect(await read('source.md'), 'and the source must still be there').toBe(MINE)
  })

  it('refuses to rename a folder onto an existing folder', async () => {
    await fsp.mkdir(join(rootPath, 'from-dir'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'from-dir', 'a.md'), MINE)
    await fsp.mkdir(join(rootPath, 'to-dir'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'to-dir', 'b.md'), THEIRS)

    const moved = await exclusiveRename(root, ['from-dir'], ['to-dir'])
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe(ErrorCode.NAME_TAKEN)
    expect(await read('to-dir', 'b.md')).toBe(THEIRS)
    expect(await read('from-dir', 'a.md')).toBe(MINE)
  })
})

describe('the ordinary move', () => {
  it('renames a file within its folder', async () => {
    await fsp.writeFile(join(rootPath, 'before.md'), MINE)
    const moved = await exclusiveRename(root, ['before.md'], ['after.md'])
    expect(moved.ok).toBe(true)
    expect(await read('after.md')).toBe(MINE)
    expect(await exists('before.md')).toBe(false)
  })

  it('moves a file into another folder', async () => {
    await fsp.mkdir(join(rootPath, 'target'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'travels.md'), MINE)

    const moved = await exclusiveRename(root, ['travels.md'], ['target', 'travels.md'])
    expect(moved.ok).toBe(true)
    expect(await read('target', 'travels.md')).toBe(MINE)
    expect(await exists('travels.md')).toBe(false)
  })

  it('leaves the moved file with a link count of one', async () => {
    /**
     * The mechanism is `link` then `unlink`, so mid-move the inode briefly carries two names. If
     * the `unlink` were skipped the file would sit at both paths forever with `nlink === 2` — and
     * §4 refuses to open a hard-linked file at all, so the "moved" document would be unopenable.
     */
    await fsp.writeFile(join(rootPath, 'counted.md'), MINE)
    const moved = await exclusiveRename(root, ['counted.md'], ['counted-moved.md'])
    expect(moved.ok).toBe(true)
    expect((await fsp.stat(join(rootPath, 'counted-moved.md'))).nlink).toBe(1)
  })

  it('moves a whole folder, contents and all', async () => {
    await fsp.mkdir(join(rootPath, 'project', 'inner'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'project', 'inner', 'deep.md'), MINE)

    const moved = await exclusiveRename(root, ['project'], ['renamed-project'])
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.value.kind).toBe('directory')
    expect(await read('renamed-project', 'inner', 'deep.md')).toBe(MINE)
  })
})

describe('case-only rename — §13.6', () => {
  it('renames notes.md to Notes.md on a case-insensitive volume', async () => {
    /**
     * The destination **is** the source here, so every exclusive mechanism refuses it: `link`
     * returns `EEXIST` against the file itself. v1 mandated case-only rename *and* exclusive
     * rename, which on APFS meant the feature could not work at all.
     *
     * Detected by `(dev, ino)` rather than by comparing strings — a string comparison would have
     * to model the volume's case-folding and normalization rules, and being wrong in the permissive
     * direction destroys a file.
     */
    await fsp.writeFile(join(rootPath, 'casing.md'), MINE)

    const moved = await exclusiveRename(root, ['casing.md'], ['Casing.md'])
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.value.caseOnly, 'must be reported as the case-only path').toBe(true)

    const listed = await fsp.readdir(rootPath)
    expect(listed).toContain('Casing.md')
    expect(listed).not.toContain('casing.md')
    expect(await read('Casing.md')).toBe(MINE)
  })

  it('handles a NORMALIZATION-only rename, which no string comparison catches', async () => {
    /**
     * The test that separates `(dev, ino)` from a clever string comparison.
     *
     * A lowercased string comparison passes every other test in this block, so on its own they do
     * not prove the identity check at all. Here the two names differ in **normalization**, not
     * case: `café.md` composed (U+00E9) and decomposed (`e` + U+0301). They are different strings
     * by any comparison — different lengths, even — and on this volume they are the same file.
     *
     * §4 names this exactly: "overlapping roots, case variants and NFC/NFD all produce two strings
     * for one inode." A string comparison here reports "different file" and the move is refused as
     * a collision, so the user cannot rename their own file. Identity gets it right without
     * knowing anything about Unicode.
     */
    const composed = 'café.md'
    const decomposed = 'café.md'
    expect(composed).not.toBe(decomposed)
    expect(composed.toLowerCase()).not.toBe(decomposed.toLowerCase())

    await fsp.writeFile(join(rootPath, composed), MINE)

    // Only meaningful if this volume really does fold the two together; say so rather than assume.
    const same = await Promise.all([
      fsp.stat(join(rootPath, composed), { bigint: true }),
      fsp.stat(join(rootPath, decomposed), { bigint: true }).catch(() => null),
    ])
    const foldsNormalization = same[1] !== null && same[0].ino === same[1].ino
    expect(
      foldsNormalization,
      'this volume does not fold NFC/NFD — the rest of this test would prove nothing',
    ).toBe(true)

    const moved = await exclusiveRename(root, [composed], [decomposed])
    expect(moved.ok, 'a normalization-only rename must be allowed, not called a collision')
      .toBe(true)
    if (!moved.ok) return
    expect(moved.value.caseOnly).toBe(true)
    await fsp.rm(join(rootPath, composed), { force: true })
  })

  it('refuses two different files of IDENTICAL size — identity, not resemblance', async () => {
    /**
     * The mutation sweep found the gap this closes. Replacing the `(dev, ino)` comparison with
     * `size === size && kind === kind` left every other test green, because no fixture had two
     * distinct files that happened to be the same length — so nothing was actually testing
     * *identity*, only that the files differed somehow.
     *
     * Two same-length notes is an utterly ordinary thing to have. Under a resembles-enough check
     * this rename would be treated as case-only and go straight to a plain `rename`, which
     * destroys the destination — the exact v1 defect, reached through the exception built to
     * handle case changes.
     */
    const a = '# exactly the same length, file one\n'
    const b = '# exactly the same length, file two\n'
    expect(a.length).toBe(b.length)
    await fsp.writeFile(join(rootPath, 'twin-a.md'), a)
    await fsp.writeFile(join(rootPath, 'twin-b.md'), b)

    const moved = await exclusiveRename(root, ['twin-a.md'], ['twin-b.md'])
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe(ErrorCode.NAME_TAKEN)
    expect(await read('twin-b.md'), 'the destination must be untouched').toBe(b)
    expect(await read('twin-a.md')).toBe(a)
  })

  it('does not take the case-only path for two genuinely different files', async () => {
    // The guard that keeps the exception from becoming a hole: same-looking names, different
    // inodes, must still be refused rather than quietly renamed over.
    await fsp.writeFile(join(rootPath, 'distinct-a.md'), MINE)
    await fsp.writeFile(join(rootPath, 'distinct-b.md'), THEIRS)

    const moved = await exclusiveRename(root, ['distinct-a.md'], ['distinct-b.md'])
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe(ErrorCode.NAME_TAKEN)
    expect(await read('distinct-b.md')).toBe(THEIRS)
  })
})

describe('what a move refuses outright', () => {
  it('refuses to move a folder inside itself', async () => {
    await fsp.mkdir(join(rootPath, 'selfmove', 'child'), { recursive: true })
    const moved = await exclusiveRename(root, ['selfmove'], ['selfmove', 'child', 'selfmove'])
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe(ErrorCode.PATH_TRAVERSAL)
  })

  it('compares whole segments, so a name that merely shares a prefix is allowed', () => {
    // The same rule §5 states for containment. A raw prefix test would call `notes-archive` a
    // descendant of `notes` and refuse a perfectly good move.
    expect(movesIntoOwnDescendant(['notes'], ['notes', 'inner'])).toBe(true)
    expect(movesIntoOwnDescendant(['notes'], ['notes-archive', 'inner'])).toBe(false)
    expect(movesIntoOwnDescendant(['notes'], ['notes'])).toBe(false)
    expect(movesIntoOwnDescendant(['a', 'b'], ['a', 'b', 'c'])).toBe(true)
    expect(movesIntoOwnDescendant(['a', 'b'], ['a', 'bc'])).toBe(false)
  })

  it('refuses a hard-linked source', async () => {
    // §4 refuses hard links in both directions: the second name may sit anywhere on the volume,
    // including outside every root, and `link` here would make a third.
    await fsp.writeFile(join(rootPath, 'linked.md'), MINE)
    await fsp.link(join(rootPath, 'linked.md'), join(rootPath, 'linked-second.md'))
    try {
      const moved = await exclusiveRename(root, ['linked.md'], ['linked-moved.md'])
      expect(moved.ok).toBe(false)
      if (moved.ok) return
      expect(moved.code).toBe(ErrorCode.HARDLINKED)
    } finally {
      await fsp.rm(join(rootPath, 'linked-second.md'), { force: true })
      await fsp.rm(join(rootPath, 'linked.md'), { force: true })
    }
  })

  it('refuses a symlink source rather than moving the link', async () => {
    // The refusal comes from containment's walk, which rejects any symlinked segment including the
    // final one — not from a check in the rename module, which would be unreachable.
    const outside = join(sandbox, 'outside.md')
    await fsp.writeFile(outside, 'outside the root\n')
    await fsp.symlink(outside, join(rootPath, 'a-link.md'))
    try {
      const moved = await exclusiveRename(root, ['a-link.md'], ['moved-link.md'])
      expect(moved.ok).toBe(false)
      if (moved.ok) return
      expect(moved.code).toBe(ErrorCode.PATH_SYMLINK)
    } finally {
      await fsp.rm(join(rootPath, 'a-link.md'), { force: true })
      await fsp.rm(outside, { force: true })
    }
  })

  it('refuses a destination folder that does not exist, and creates nothing', async () => {
    await fsp.writeFile(join(rootPath, 'homeless.md'), MINE)
    const moved = await exclusiveRename(root, ['homeless.md'], ['no-such-folder', 'homeless.md'])
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe(ErrorCode.PARENT_MISSING)
    expect(await exists('no-such-folder')).toBe(false)
    expect(await read('homeless.md')).toBe(MINE)
  })

  it('refuses a destination whose parent is a FILE, not a folder', async () => {
    // Found by the sweep: without the parent-kind check this falls through to `link`, which fails
    // ENOTDIR and would be reported as a generic IO failure rather than "that is not a folder".
    await fsp.writeFile(join(rootPath, 'not-a-folder.md'), MINE)
    await fsp.writeFile(join(rootPath, 'wanderer.md'), THEIRS)

    const moved = await exclusiveRename(
      root, ['wanderer.md'], ['not-a-folder.md', 'inside.md'],
    )
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe(ErrorCode.PARENT_MISSING)
    expect(await read('not-a-folder.md'), 'and the file used as a folder is untouched').toBe(MINE)
  })

  it('refuses a source that escapes the root', async () => {
    /**
     * **`PATH_TRAVERSAL`, not `PATH_ESCAPES_ROOT`, since 2026-08-09 — and the change is deliberate.**
     *
     * the security review's P7 review found a live escape: a separator inside ONE segment collapsed two path
     * components into a single `lstat`, so `walkAndVerify` never saw the symlink between them. The
     * fix put the segment rule in Core, at the chokepoint, ahead of composition — so a `..` segment
     * is now refused by the **first** wall rather than reaching the containment re-check.
     *
     * The second wall is untouched: `composedPathIsContained` still runs, still after composition,
     * still answers `PATH_ESCAPES_ROOT`. It is now unreachable from a validated segment array,
     * because no array of separator-free, dot-free, non-empty segments can `join` to somewhere
     * outside the root. That makes it redundant-and-retained — the same disposition the security review gave
     * `O_NOFOLLOW` in the same review, where `O_EXCL` was found to deliver the property first.
     */
    const moved = await exclusiveRename(root, ['..', 'outside.md'], ['landed.md'])
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe(ErrorCode.PATH_TRAVERSAL)
  })

  it('refuses a DESTINATION that escapes the root', async () => {
    // The direction that is easy to forget: containment on the source alone would let a move
    // carry a file out of the registered folder entirely.
    await fsp.writeFile(join(rootPath, 'escapee.md'), MINE)
    const moved = await exclusiveRename(root, ['escapee.md'], ['..', 'escaped.md'])
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    // Same reordering as the source case above — the segment rule now answers first.
    expect(moved.code).toBe(ErrorCode.PATH_TRAVERSAL)
    expect(await exists('escapee.md')).toBe(true)
    expect(await fsp.lstat(join(sandbox, 'escaped.md')).then(() => true, () => false)).toBe(false)
  })

  it('refuses a missing source rather than reporting a successful no-op', async () => {
    const moved = await exclusiveRename(root, ['never-existed.md'], ['somewhere.md'])
    expect(moved.ok).toBe(false)
  })
})

describe('the auto-suffixed alternative — §13.6', () => {
  it('offers the first free name', async () => {
    await fsp.mkdir(join(rootPath, 'suffixes'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'suffixes', 'notes.md'), MINE)
    await fsp.writeFile(join(rootPath, 'suffixes', 'notes-2.md'), MINE)

    const suggested = await suggestFreeName(root, ['suffixes'], 'notes.md')
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return
    expect(suggested.value).toBe('notes-3.md')
  })

  it('keeps the extension where it belongs', async () => {
    await fsp.mkdir(join(rootPath, 'ext'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'ext', 'thing.md'), MINE)
    const suggested = await suggestFreeName(root, ['ext'], 'thing.md')
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return
    expect(suggested.value).toBe('thing-2.md')
  })

  it('only ever SUGGESTS — it never moves anything', async () => {
    await fsp.mkdir(join(rootPath, 'inert'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'inert', 'a.md'), MINE)
    const before = await fsp.readdir(join(rootPath, 'inert'))
    await suggestFreeName(root, ['inert'], 'a.md')
    expect(await fsp.readdir(join(rootPath, 'inert'))).toEqual(before)
  })

  it('never reads a failed lookup as a free name', async () => {
    /**
     * §13.6's rule applied to the suggestion path: "Collision checks discriminate `ENOENT` from
     * 'couldn't determine'. It is never treated as a free destination."
     *
     * The sweep caught this one: turning `if (!found.ok) return found` into `return ok(candidate)`
     * left everything green. A suggestion built on a lookup that *failed* is a name that may well
     * be occupied — and the caller then attempts a move onto it.
     */
    const suggested = await suggestFreeName(root, ['..'], 'notes.md')
    expect(suggested.ok, 'a lookup that could not complete is not a free name').toBe(false)
  })

  it('gives up rather than suggesting a name that will not fit', async () => {
    await fsp.mkdir(join(rootPath, 'toolong'), { recursive: true })
    const suggested = await suggestFreeName(root, ['toolong'], 'x'.repeat(260) + '.md')
    expect(suggested.ok).toBe(false)
    if (suggested.ok) return
    expect(suggested.code).toBe(ErrorCode.NAME_TOO_LONG)
  })
})

/**
 * FT-5 — THE EDITABILITY BOUNDARY. Spec §12.
 *
 * Found unimplemented at P7's state check: `entry.rename` accepted `photo.png` → `photo.md`, and
 * P7 is the phase that puts a Rename button in front of a person.
 */
describe('FT-5 — a rename may not change whether a file is a document', () => {
  it('refuses photo.png → photo.md, the case the spec names', async () => {
    await fsp.writeFile(join(rootPath, 'photo.png'), 'not really a png\n')
    const outcome = await exclusiveRename(root, ['photo.png'], ['photo.md'])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.code).toBe(ErrorCode.EDITABILITY_BOUNDARY)
    // And the file did not move — a refusal that half-happened is worse than no rule.
    expect(await exists('photo.png')).toBe(true)
    expect(await exists('photo.md')).toBe(false)
  })

  it('refuses the other direction too, notes.md → notes.txt', async () => {
    await fsp.writeFile(join(rootPath, 'notes-ft5.md'), MINE)
    const outcome = await exclusiveRename(root, ['notes-ft5.md'], ['notes-ft5.txt'])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.code).toBe(ErrorCode.EDITABILITY_BOUNDARY)
  })

  it('refuses an extensionless file becoming markdown — LICENSE → LICENSE.md', async () => {
    await fsp.writeFile(join(rootPath, 'LICENSE'), 'MIT\n')
    const outcome = await exclusiveRename(root, ['LICENSE'], ['LICENSE.md'])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.code).toBe(ErrorCode.EDITABILITY_BOUNDARY)
  })

  it('ALLOWS a markdown file renamed to another markdown name', async () => {
    // Names unique to this block: the sandbox is created once in `beforeAll` and shared, so
    // `before.md`/`after.md` are already occupied by the ordinary-move suite above.
    await fsp.writeFile(join(rootPath, 'ft5-before.md'), MINE)
    const outcome = await exclusiveRename(root, ['ft5-before.md'], ['ft5-after.md'])
    expect(outcome.ok, 'the ordinary rename must not be caught by this rule').toBe(true)
    expect(await read('ft5-after.md')).toBe(MINE)
  })

  it('ALLOWS a non-markdown file renamed to another non-markdown name', async () => {
    await fsp.writeFile(join(rootPath, 'sheet.csv'), 'a,b\n')
    const outcome = await exclusiveRename(root, ['sheet.csv'], ['sheet-2024.csv'])
    expect(outcome.ok).toBe(true)
  })

  it('ALLOWS renaming a png to a differently-named png across folders', async () => {
    await fsp.mkdir(join(rootPath, 'assets'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'orchard.jpg'), 'bytes\n')
    const outcome = await exclusiveRename(root, ['orchard.jpg'], ['assets', 'orchard-2026.jpg'])
    expect(outcome.ok, 'a move is a rename, and it is not a boundary crossing').toBe(true)
  })

  /**
   * The false positive the rule is deliberately scoped away from.
   *
   * A folder has no extension. Refusing `notes` → `notes.md` on a *directory* would block a rename
   * a person legitimately makes, and would do it to prevent nothing: a directory named `notes.md`
   * is not a document the editor can open, it is a folder with an odd name.
   */
  it('ALLOWS a FOLDER to be renamed to something ending in .md', async () => {
    await fsp.mkdir(join(rootPath, 'folder-ft5'), { recursive: true })
    const outcome = await exclusiveRename(root, ['folder-ft5'], ['folder-ft5.md'])
    expect(outcome.ok, 'the rule is files only').toBe(true)
  })

  /**
   * THE ONE A MUTATION SWEEP ASKED FOR, and the reasoning that nearly skipped it was wrong.
   *
   * The sweep replaced `isMarkdown(nameOf(from))` with `isMarkdown(from.join('/'))` and nothing
   * went red. The first instinct was that the two are the same predicate — the last dot in a path
   * lives in the last segment — so no test was owed. **Checked instead of argued, and they differ
   * in 272 of 4,368 generated paths.**
   *
   * The case that matters is exactly the file §13.6 exists to prevent. A file named literally
   * `.md` is a HIDDEN file with no extension — `extensionOf` refuses a dot at index 0, and
   * `grammar.ts` says so in as many words, because M16's slugification bug produces precisely that
   * name. Join it to a parent and the dot is no longer at index 0: `dir/.md` reads as markdown.
   *
   * So under the joined-path version, renaming `dir/.md` to `dir/notes.md` is a rename from
   * markdown to markdown and FT-5 waves it through — turning an invisible file into a document
   * without a check, which is the M16 failure and the FT-5 failure at the same time.
   */
  it('refuses dir/.md → dir/notes.md — a file named .md is hidden, not markdown', async () => {
    await fsp.mkdir(join(rootPath, 'ft5-dotmd'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'ft5-dotmd', '.md'), 'the M16 file\n')
    const outcome = await exclusiveRename(root, ['ft5-dotmd', '.md'], ['ft5-dotmd', 'notes.md'])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.code).toBe(ErrorCode.EDITABILITY_BOUNDARY)
  })

  it('ALLOWS a case-only rename of a markdown file — .MD is still markdown', async () => {
    await fsp.writeFile(join(rootPath, 'caseft5.md'), MINE)
    // `isMarkdown` lowercases, so this is not a boundary crossing. On this case-insensitive volume
    // it is also the case-only path, which must not be caught on the way past.
    const outcome = await exclusiveRename(root, ['caseft5.md'], ['CaseFT5.MD'])
    expect(outcome.ok).toBe(true)
  })
})
