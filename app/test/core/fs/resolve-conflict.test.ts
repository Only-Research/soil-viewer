import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { type RegisteredRoot } from '../../../src/core/fs/containment'
import { resolveConflict } from '../../../src/core/fs/resolve-conflict'
import { registerRoot } from '../../../src/core/fs/registration'
import { isConflictArtifact } from '../../../src/core/grammar'

/**
 * §13.5's resolution. This is the only operation in the build that removes a file from a registered
 * folder, so most of these tests are about what survives.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree per test.
 */
let sandbox: string
let rootPath: string
let archiveRoot: string
let root: RegisteredRoot

const THEIRS = '# Notes\n\nwhat was on disk when the save was refused\n'
const MINE = '# Notes\n\nthe edit the user was holding, rescued to a sibling\n'
const ARTIFACT = 'notes.conflict-20260808-143205-ABCD.md'

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p4-resolve-'))
  rootPath = join(sandbox, 'root')
  archiveRoot = join(sandbox, 'archive')
  await fsp.mkdir(rootPath, { recursive: true })
  await fsp.writeFile(join(rootPath, 'notes.md'), THEIRS)
  await fsp.writeFile(join(rootPath, ARTIFACT), MINE)

  const registered = await registerRoot('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const read = (...segments: string[]) => fsp.readFile(join(rootPath, ...segments), 'utf8')
const exists = (...segments: string[]) =>
  fsp.lstat(join(rootPath, ...segments)).then(() => true, () => false)
const archived = async (): Promise<string[]> =>
  fsp.readdir(archiveRoot).catch(() => [] as string[])

const resolve = (choice: 'mine' | 'theirs' | 'both') =>
  resolveConflict(root, ['notes.md'], [ARTIFACT], choice, archiveRoot, [root])

describe('Keep Theirs', () => {
  it('leaves the canonical file alone and archives the rescue file', async () => {
    const done = await resolve('theirs')
    expect(done.ok).toBe(true)

    expect(await read('notes.md')).toBe(THEIRS)
    expect(await exists(ARTIFACT), 'the artifact leaves the folder').toBe(false)
    expect(await archived()).toHaveLength(1)
  })

  it('archives the rescued edit rather than destroying it', async () => {
    // The user chose the other version; that does not make their edit disposable. Nothing in this
    // app deletes, and the archive is how that holds even here.
    const done = await resolve('theirs')
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(await fsp.readFile(done.value.archived as string, 'utf8')).toBe(MINE)
  })
})

describe('Keep Mine', () => {
  it('makes the rescued edit canonical', async () => {
    const done = await resolve('mine')
    expect(done.ok).toBe(true)
    expect(await read('notes.md')).toBe(MINE)
  })

  it('archives the LOSER, not the winner', async () => {
    /**
     * The mistake this ordering exists to prevent. The canonical file's *current* content is what
     * loses, so it has to be archived **before** it is overwritten. Archiving afterwards would
     * capture the winning content and lose the very thing the archive is for — and the resolution
     * would report success.
     */
    const done = await resolve('mine')
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(
      await fsp.readFile(done.value.archived as string, 'utf8'),
      'the archived copy must be what was overwritten',
    ).toBe(THEIRS)
  })

  it('clears the artifact away once its content is the document', async () => {
    // A leftover artifact keeps appearing in the "Needs attention" list forever.
    const done = await resolve('mine')
    expect(done.ok).toBe(true)
    expect(await exists(ARTIFACT)).toBe(false)
    expect(await archived(), 'both the old canonical and the artifact').toHaveLength(2)
  })
})

describe('Keep Both', () => {
  it('keeps the canonical file and turns the artifact into an ordinary document', async () => {
    /**
     * §13.5 makes a conflict artifact grammar-excluded everywhere except Files. An artifact kept
     * as-is would therefore be a document the user *chose to keep* and can never see on a board or
     * in an inbox — so keeping both has to mean renaming it out of that state.
     */
    const done = await resolve('both')
    expect(done.ok).toBe(true)
    if (!done.ok) return

    expect(await read('notes.md')).toBe(THEIRS)
    expect(await exists(ARTIFACT)).toBe(false)

    const kept = done.value.keptAlongside as string[]
    expect(await read(...kept)).toBe(MINE)
    expect(isConflictArtifact(kept[kept.length - 1] as string), 'no longer excluded').toBe(false)
  })

  it('archives nothing — both versions are staying', async () => {
    await resolve('both')
    expect(await archived()).toHaveLength(0)
  })

  it('picks a name that is actually free', async () => {
    await fsp.writeFile(join(rootPath, 'notes-2.md'), 'already here\n')
    const done = await resolve('both')
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.value.keptAlongside?.[0]).toBe('notes-3.md')
    expect(await read('notes-2.md'), 'and does not touch the one that was there').toBe('already here\n')
  })
})

describe('what it refuses to pair', () => {
  it('refuses a second path that is not a conflict artifact', async () => {
    /**
     * Without this the function is a data-loss primitive: point it at any two documents and it
     * archives one of them. The artifact test is what makes the operation only usable for the
     * situation it names.
     */
    await fsp.writeFile(join(rootPath, 'unrelated.md'), 'an ordinary document\n')
    const done = await resolveConflict(
      root, ['notes.md'], ['unrelated.md'], 'theirs', archiveRoot, [root],
    )
    expect(done.ok).toBe(false)
    expect(await read('unrelated.md')).toBe('an ordinary document\n')
  })

  it('refuses when the two are not siblings', async () => {
    // A rescue file is always written beside the file it rescues, so this costs nothing legitimate
    // — and without it, one wrong argument archives a document from another folder.
    await fsp.mkdir(join(rootPath, 'elsewhere'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'elsewhere', ARTIFACT), MINE)

    const done = await resolveConflict(
      root, ['notes.md'], ['elsewhere', ARTIFACT], 'theirs', archiveRoot, [root],
    )
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.PATH_TRAVERSAL)
    expect(await exists('elsewhere', ARTIFACT)).toBe(true)
  })

  it('refuses two files at the SAME depth in different folders', async () => {
    /**
     * The sweep found the previous sibling test insufficient. It paired `notes.md` with
     * `elsewhere/<artifact>` — different depths — so a simple length comparison caught it and the
     * parent comparison could be broken with nothing noticing.
     *
     * Same depth, different parent is the case only the parent comparison can refuse, and it is
     * the realistic one: two folders that each contain a document and its rescue file.
     */
    await fsp.mkdir(join(rootPath, 'alpha'), { recursive: true })
    await fsp.mkdir(join(rootPath, 'beta'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'alpha', 'notes.md'), THEIRS)
    await fsp.writeFile(join(rootPath, 'beta', ARTIFACT), MINE)

    const done = await resolveConflict(
      root, ['alpha', 'notes.md'], ['beta', ARTIFACT], 'theirs', archiveRoot, [root],
    )
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.PATH_TRAVERSAL)
    expect(await exists('beta', ARTIFACT), 'the other folder is untouched').toBe(true)
  })

  it('refuses when the canonical path is itself an artifact', async () => {
    const second = 'notes.conflict-20260808-143206-EFGH.md'
    await fsp.writeFile(join(rootPath, second), 'another rescue\n')
    const done = await resolveConflict(root, [ARTIFACT], [second], 'theirs', archiveRoot, [root])
    expect(done.ok).toBe(false)
    expect(await exists(second)).toBe(true)
  })

  it('refuses when the archive would sit inside a registered folder', async () => {
    /**
     * The archive holds the losing side of every resolution. Inside a registered root it would be
     * indexed, searchable, and — being full of near-duplicates of real documents — actively
     * confusing. Validated on every call rather than at startup, because a folder registered later
     * can swallow a location that was fine before.
     */
    const done = await resolveConflict(
      root, ['notes.md'], [ARTIFACT], 'theirs', join(rootPath, 'inside'), [root],
    )
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.INVALID_ROOT)
    expect(await exists(ARTIFACT), 'and nothing was moved').toBe(true)
  })

  it('refuses a missing file rather than half-resolving', async () => {
    await fsp.rm(join(rootPath, ARTIFACT))
    const done = await resolve('theirs')
    expect(done.ok).toBe(false)
    expect(await read('notes.md')).toBe(THEIRS)
  })
})

describe('nothing is removed before its content is provably elsewhere', () => {
  it('leaves the original untouched when the archive cannot be written', async () => {
    /**
     * The ordering that makes this operation safe: copy, **read back and compare hashes**, and only
     * then unlink. A read-only archive directory exercises the failure — the original must still be
     * there afterwards, because the unlink is unreachable until the copy is verified.
     */
    await fsp.mkdir(archiveRoot, { recursive: true })
    await fsp.chmod(archiveRoot, 0o500)
    try {
      const done = await resolve('theirs')
      expect(done.ok).toBe(false)
      expect(await exists(ARTIFACT), 'the rescued edit must survive a failed archive').toBe(true)
      expect(await read(ARTIFACT)).toBe(MINE)
      expect(await read('notes.md')).toBe(THEIRS)
    } finally {
      await fsp.chmod(archiveRoot, 0o755)
    }
  })

  it('leaves BOTH files untouched when Keep Mine cannot archive the loser', async () => {
    // The worse version of the same failure: if the archive fails after the overwrite, the losing
    // content is gone for good. It has to fail before anything is written.
    await fsp.mkdir(archiveRoot, { recursive: true })
    await fsp.chmod(archiveRoot, 0o500)
    try {
      const done = await resolve('mine')
      expect(done.ok).toBe(false)
      expect(await read('notes.md'), 'the canonical file is not overwritten').toBe(THEIRS)
      expect(await read(ARTIFACT)).toBe(MINE)
    } finally {
      await fsp.chmod(archiveRoot, 0o755)
    }
  })
})

describe('the archived copy is verified before anything is removed', () => {
  /**
   * **These two tests exist because the sweep found the verification undefended.** The read-only
   * directory case above fails at the *open*, so the hash comparison was never reached — the check
   * standing between a lying write and the unlink of a user's only copy had no proof.
   *
   * A write that reports success and stores something else is what a failing drive does. The seam
   * reproduces it: the archived copy reads back as different bytes.
   */
  const lyingReadBack = async () => Buffer.from('not what was written\n')

  it('refuses, and keeps the original, when the archived copy does not match', async () => {
    const done = await resolveConflict(
      root, ['notes.md'], [ARTIFACT], 'theirs', archiveRoot, [root], lyingReadBack,
    )
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.WRITE_SIZE_MISMATCH)
    expect(await exists(ARTIFACT), 'the rescued edit must still be there').toBe(true)
    expect(await read(ARTIFACT)).toBe(MINE)
  })

  it('refuses BEFORE overwriting anything on Keep Mine', async () => {
    // The worse case: a bad archive followed by an overwrite would destroy the losing content for
    // good, and report success.
    const done = await resolveConflict(
      root, ['notes.md'], [ARTIFACT], 'mine', archiveRoot, [root], lyingReadBack,
    )
    expect(done.ok).toBe(false)
    expect(await read('notes.md'), 'the canonical file is untouched').toBe(THEIRS)
    expect(await read(ARTIFACT), 'and so is the artifact').toBe(MINE)
  })
})
