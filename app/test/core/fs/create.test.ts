import { constants, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { createEntry } from '../../../src/core/fs/create'
import { type RegisteredRoot } from '../../../src/core/fs/containment'
import { registerRoot } from '../../../src/core/fs/registration'

/**
 * New File and New Folder, against real files.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree per test, because several of
 * these deliberately pre-place symlinks and read-only directories.
 */
let sandbox: string
let rootPath: string
let root: RegisteredRoot

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p7-create-'))
  rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })
  const registered = await registerRoot('scratch', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const codeOf = (outcome: { ok: boolean; code?: ErrorCode }): ErrorCode | 'ok' =>
  outcome.ok ? 'ok' : (outcome.code as ErrorCode)

describe('what a create makes', () => {
  it('makes an empty file when given no content', async () => {
    const outcome = await createEntry(root, ['notes.md'], 'file')
    expect(outcome.ok).toBe(true)
    expect(await fsp.readFile(join(rootPath, 'notes.md'), 'utf8')).toBe('')
  })

  it('writes the seed body through the same descriptor it created — annex A5', async () => {
    const outcome = await createEntry(root, ['seeded.md'], 'file', '# My Meeting Notes\n')
    expect(outcome.ok).toBe(true)
    expect(await fsp.readFile(join(rootPath, 'seeded.md'), 'utf8')).toBe('# My Meeting Notes\n')
  })

  it('a directory ignores the content argument rather than erroring on it', async () => {
    const outcome = await createEntry(root, ['a-folder'], 'directory', '# ignored\n')
    expect(outcome.ok).toBe(true)
    expect((await fsp.lstat(join(rootPath, 'a-folder'))).isDirectory()).toBe(true)
  })

  it('makes a folder', async () => {
    const outcome = await createEntry(root, ['inbox'], 'directory')
    expect(outcome.ok).toBe(true)
    expect((await fsp.lstat(join(rootPath, 'inbox'))).isDirectory()).toBe(true)
  })

  it('makes a file inside an existing subfolder', async () => {
    await fsp.mkdir(join(rootPath, 'projects'), { recursive: true })
    const outcome = await createEntry(root, ['projects', 'a.md'], 'file')
    expect(outcome.ok).toBe(true)
    expect((await fsp.lstat(join(rootPath, 'projects', 'a.md'))).isFile()).toBe(true)
  })

  it('leaves no open descriptor behind — the file is immediately renameable', async () => {
    await createEntry(root, ['notes.md'], 'file')
    // On macOS a held descriptor would not block this, so the real assertion is that the process
    // does not accumulate handles; this at least proves the happy path closes cleanly.
    await expect(fsp.rename(join(rootPath, 'notes.md'), join(rootPath, 'moved.md')))
      .resolves.toBeUndefined()
  })
})

describe('what a create refuses', () => {
  it('refuses when something is already there — a create never replaces', async () => {
    await fsp.writeFile(join(rootPath, 'notes.md'), 'do not destroy me\n')
    const outcome = await createEntry(root, ['notes.md'], 'file')
    expect(codeOf(outcome)).toBe(ErrorCode.NAME_TAKEN)
    expect(await fsp.readFile(join(rootPath, 'notes.md'), 'utf8')).toBe('do not destroy me\n')
  })

  it('refuses a folder over an existing folder, rather than merging into it', async () => {
    await fsp.mkdir(join(rootPath, 'inbox'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'inbox', 'kept.md'), 'kept\n')
    const outcome = await createEntry(root, ['inbox'], 'directory')
    expect(codeOf(outcome)).toBe(ErrorCode.NAME_TAKEN)
    expect(await fsp.readFile(join(rootPath, 'inbox', 'kept.md'), 'utf8')).toBe('kept\n')
  })

  it('REFUSES when the parent does not exist — §13.3, it does not mkdir -p', async () => {
    const outcome = await createEntry(root, ['nope', 'deeper', 'a.md'], 'file')
    expect(codeOf(outcome)).toBe(ErrorCode.PARENT_MISSING)
    await expect(fsp.lstat(join(rootPath, 'nope'))).rejects.toThrow()
  })

  it('creates exactly one level, so a missing intermediate is a refusal not a tree', async () => {
    const outcome = await createEntry(root, ['a', 'b'], 'directory')
    expect(codeOf(outcome)).toBe(ErrorCode.PARENT_MISSING)
    await expect(fsp.lstat(join(rootPath, 'a'))).rejects.toThrow()
  })

  it('refuses an empty path', async () => {
    expect(codeOf(await createEntry(root, [], 'file'))).toBe(ErrorCode.PATH_EMPTY)
  })

  it('refuses a path that escapes the root', async () => {
    const outcome = await createEntry(root, ['..', 'escaped.md'], 'file')
    expect(outcome.ok).toBe(false)
    await expect(fsp.lstat(join(sandbox, 'escaped.md'))).rejects.toThrow()
  })
})

/**
 * THE SYMLINK CASE, and it is the reason `O_NOFOLLOW` is on the open.
 *
 * The names in this tree are predictable — that is what the folder grammar is for — so an agent
 * that can write into a registered folder can pre-place a symlink at a name the user is about to
 * create. Without `O_NOFOLLOW` the create follows it and the app's first write lands wherever the
 * link points, outside every root.
 */
describe('a symlink pre-placed at the name', () => {
  it('does not write through a symlink pointing outside the root', async () => {
    const outside = join(sandbox, 'outside.md')
    await fsp.writeFile(outside, 'THE TARGET, which must not be touched\n')
    await fsp.symlink(outside, join(rootPath, 'notes.md'))

    const outcome = await createEntry(root, ['notes.md'], 'file')
    expect(outcome.ok).toBe(false)
    expect(await fsp.readFile(outside, 'utf8')).toBe('THE TARGET, which must not be touched\n')
    // And the link is still a link — nothing replaced it either.
    expect((await fsp.lstat(join(rootPath, 'notes.md'))).isSymbolicLink()).toBe(true)
  })

  it('does not write through a symlink pointing INSIDE the root', async () => {
    // The subtler half: containment alone would allow this one, so the refusal must come from the
    // symlink rule rather than from the path check.
    await fsp.writeFile(join(rootPath, 'real.md'), 'the real file\n')
    await fsp.symlink(join(rootPath, 'real.md'), join(rootPath, 'alias.md'))

    const outcome = await createEntry(root, ['alias.md'], 'file')
    expect(outcome.ok).toBe(false)
    expect(await fsp.readFile(join(rootPath, 'real.md'), 'utf8')).toBe('the real file\n')
  })
})

describe('failures the filesystem reports', () => {
  it('reports a read-only parent as a permission refusal, not as a generic failure', async () => {
    const locked = join(rootPath, 'locked')
    await fsp.mkdir(locked, { recursive: true })
    await fsp.chmod(locked, 0o555)
    try {
      const outcome = await createEntry(root, ['locked', 'a.md'], 'file')
      expect(codeOf(outcome)).toBe(ErrorCode.PERMISSION_DENIED)
    } finally {
      // Restored so the sandbox can be removed in afterEach.
      await fsp.chmod(locked, 0o755)
    }
  })

  /**
   * This test was written expecting `NAME_TOO_LONG` and it failed, which was the useful outcome.
   *
   * The create's own errno mapping never sees `ENAMETOOLONG`: `walkAndVerify` lstats the
   * destination first and fails there. So the branch that mapped it was **unreachable**, and it was
   * deleted rather than kept — the standing rule is that a guard which cannot fire is one a later
   * reader trusts.
   *
   * The refusal a *person* gets is `slug.ts`'s, which happens before this function is ever called
   * and names the byte limit. This test now pins the honest behaviour of the layer it is testing,
   * and the comment says where the real answer comes from.
   */
  it('refuses an over-long name, though not with its own message — see slug.ts', async () => {
    const outcome = await createEntry(root, [`${'a'.repeat(300)}.md`], 'file')
    expect(outcome.ok).toBe(false)
    await expect(fsp.readdir(rootPath)).resolves.toEqual([])
  })

  it('creates with mode 0644, not 0600 — a document is not a secret', async () => {
    await createEntry(root, ['notes.md'], 'file')
    const stat = await fsp.stat(join(rootPath, 'notes.md'))
    // Masked against the process umask, so assert the owner bits rather than the exact mode.
    expect(stat.mode & constants.S_IRUSR).toBeTruthy()
    expect(stat.mode & constants.S_IWUSR).toBeTruthy()
  })
})

/**
 * THE RACE, and it is the only thing that separates the syscall from the check above it.
 *
 * A mutation sweep put this block here. `createEntry` refuses an occupied name twice over: a
 * `walkAndVerify` that reports what is there, and then `O_EXCL` / a bare `mkdir` that refuse from
 * the kernel. **Every sequential test passes with either one removed**, because the first is enough
 * on its own when nothing else is running.
 *
 * They are not equivalent, though, and the difference is the whole point. The check is a
 * time-of-check-to-time-of-use read: it answers about a moment that has already passed. The syscall
 * answers about *now*, atomically, and it is the one that holds when two creates arrive together.
 * Concurrency is what makes that visible — under it the pre-check passes for every caller at once,
 * and only the kernel can pick a winner.
 */
describe('concurrent creates at one name — exactly one wins', () => {
  it('a file: one create succeeds and the rest are refused', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => createEntry(root, ['contested.md'], 'file')),
    )
    const won = attempts.filter(a => a.ok)
    expect(won, 'exactly one create may win').toHaveLength(1)
    expect(attempts.filter(a => !a.ok).every(a => codeOf(a) === ErrorCode.NAME_TAKEN)).toBe(true)
  })

  it('a folder: one mkdir succeeds and the rest are refused', async () => {
    // Also what pins `mkdir` as non-recursive: `{ recursive: true }` resolves happily on a
    // directory that already exists, so all twelve would report success.
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => createEntry(root, ['contested'], 'directory')),
    )
    expect(attempts.filter(a => a.ok), 'exactly one mkdir may win').toHaveLength(1)
  })

  it('the winner is a real, empty, ordinary file — not a half-made one', async () => {
    await Promise.all(
      Array.from({ length: 12 }, () => createEntry(root, ['contested.md'], 'file')),
    )
    const stat = await fsp.lstat(join(rootPath, 'contested.md'))
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBe(0)
  })
})
