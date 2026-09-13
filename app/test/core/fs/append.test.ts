import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { appendToDocument, openForAppend, type AppendOpener } from '../../../src/core/fs/append'
import { type RegisteredRoot } from '../../../src/core/fs/containment'
import { registerRoot } from '../../../src/core/fs/registration'

/**
 * **The one write in this build that is not a temp-and-rename, and it had no test file at all.**
 * the security review's G5, 2026-08-16.
 *
 * `appendToDocument` is how a message reaches a chatroom. It cannot use the temp-and-rename dance
 * every other write uses — `O_APPEND` is what makes two simultaneous posts both survive — so it is
 * the one place that opens an **existing path** for writing. Until 2026-08-16 it did that with
 * Node's `'a'`: `O_WRONLY | O_CREAT | O_APPEND`, no `O_NOFOLLOW`, no identity check, and no check of
 * how many bytes were actually written. Its only coverage was `test/server/chatroom.test.ts`, at
 * service level, which exercised none of that.
 *
 * **Nothing here goes near `/Users/hallberg/notes`.** Scratch tree per run, created and removed.
 */

let sandbox: string
let rootPath: string
let root: RegisteredRoot

const ORIGINAL = '# Chatroom\n\nfirst message\n'

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-append-'))
  rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })
  const registered = await registerRoot('scratch', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value
})

afterAll(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

async function fixture(name: string, body = ORIGINAL): Promise<string> {
  const path = join(rootPath, name)
  await fsp.writeFile(path, body)
  return path
}

describe('the ordinary append', () => {
  it('adds the bytes at the end and leaves what was there', async () => {
    const path = await fixture('ordinary.md')

    const done = await appendToDocument(root, ['ordinary.md'], 'second message\n')

    expect(done.ok).toBe(true)
    expect(await fsp.readFile(path, 'utf8')).toBe(`${ORIGINAL}second message\n`)
  })

  it('reports what was there before, and the new size', async () => {
    await fixture('outcome.md')

    const done = await appendToDocument(root, ['outcome.md'], 'x\n')

    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.value.existing, 'the content BEFORE this append').toBe(ORIGINAL)
    expect(done.value.size).toBe(Buffer.byteLength(`${ORIGINAL}x\n`))
  })

  /** Every byte, or a named failure — never a silent short write. The loop is what delivers this. */
  it('writes the whole addition, including multi-byte characters', async () => {
    const path = await fixture('utf8.md')
    const addition = 'café ☕ 🚀 — four, three and one\n'

    const done = await appendToDocument(root, ['utf8.md'], addition)

    expect(done.ok).toBe(true)
    const after = await fsp.readFile(path)
    expect(after.length, 'BYTES, not characters').toBe(
      Buffer.byteLength(ORIGINAL) + Buffer.byteLength(addition),
    )
    expect(after.toString('utf8')).toBe(`${ORIGINAL}${addition}`)
  })
})

/**
 * **§4 on the re-opened path.** These are the three checks the security review's G5 required, and each is here
 * because the re-open is a second operation on a path the walk verified a moment earlier.
 */
describe('what the re-open refuses', () => {
  /**
   * **The create is gone rather than argued away.** The old comment said `O_CREAT` could never fire
   * because the read had already refused a missing file — check-then-act stated as a guarantee.
   * With the flag removed there is nothing to argue about: a missing file cannot be created here by
   * any route, and the refusal comes from the read.
   */
  it('never creates a file that is not there', async () => {
    const done = await appendToDocument(root, ['nowhere.md'], 'should not appear\n')

    expect(done.ok).toBe(false)
    await expect(fsp.stat(join(rootPath, 'nowhere.md')), 'nothing was created').rejects.toThrow()
  })

  /**
   * A hard link is refused on the read, and would be refused again on the descriptor. §4's own
   * example: `ln ~/.ssh/id_ed25519 /soil/notes.md` passes containment and the regular-file check.
   */
  it('refuses a hard-linked target', async () => {
    await fsp.writeFile(join(sandbox, 'outside.md'), 'a decoy, not a real secret\n')
    await fsp.link(join(sandbox, 'outside.md'), join(rootPath, 'linked.md'))

    const done = await appendToDocument(root, ['linked.md'], 'must not be appended\n')

    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.HARDLINKED)
    expect(await fsp.readFile(join(sandbox, 'outside.md'), 'utf8'))
      .toBe('a decoy, not a real secret\n')
  })

  it('refuses a symlinked target', async () => {
    await fsp.writeFile(join(sandbox, 'symlink-target.md'), 'outside the root\n')
    await fsp.symlink(join(sandbox, 'symlink-target.md'), join(rootPath, 'link.md'))

    const done = await appendToDocument(root, ['link.md'], 'must not be appended\n')

    expect(done.ok).toBe(false)
    expect(await fsp.readFile(join(sandbox, 'symlink-target.md'), 'utf8'))
      .toBe('outside the root\n')
  })

  it('refuses a file that is not markdown', async () => {
    await fixture('notes.txt')
    const done = await appendToDocument(root, ['notes.txt'], 'nope\n')
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.NOT_MARKDOWN)
  })

  /**
   * §12's gate on the way in. A NUL turns a clean markdown file into one the app can never open
   * again, and an append is the same door with a smaller opening.
   */
  it('refuses content the editor could never load back', async () => {
    const path = await fixture('gate.md')
    const done = await appendToDocument(root, ['gate.md'], 'a NUL: \u0000\n')
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.NOT_EDITABLE)
    expect(await fsp.readFile(path, 'utf8'), 'nothing was written').toBe(ORIGINAL)
  })
})

/**
 * **THE IDENTITY RE-CHECK, driven with a real replacement.**
 *
 * The read closes its descriptor and the write re-opens by path. Between those two there is a
 * window, and it needs no attacker: `chatroom.append` locks the **file** path while `entry.rename`
 * and `card.move` lock the **parent folder**, so the two key namespaces cannot collide and an
 * ordinary rename by another of the operator's own clients is not serialized against this append.
 *
 * the operator deprioritised closing that namespace split on 2026-08-16 and was substantially right. This
 * check is what makes leaving it safe — so this test is the reason that decision holds, not a
 * defence against a hypothetical.
 *
 * Provoked deterministically rather than raced: the file at the path is replaced with a **different
 * inode** carrying the same name, which is exactly what a rename-into-place leaves behind.
 */
describe('the window between the read and the write', () => {
  /**
   * Changes the filesystem at exactly the moment the guards defend, then delegates to the **real**
   * opener — so the flags under test are the module's own, not a copy rebuilt here. That distinction
   * cost a surviving mutation in `read-bytes.test.ts` earlier the same day.
   */
  const meddle = (change: () => Promise<void>): AppendOpener => async path => {
    await change()
    return openForAppend(path)
  }

  /**
   * **THE ONE THAT NEEDS NO ATTACKER.** `chatroom.append` locks the **file** path while
   * `entry.rename` and `card.move` lock the **parent folder**, so the two key namespaces cannot
   * collide and an ordinary rename by another of the operator's own clients is not serialized against
   * this append. The operator deprioritised closing that split on 2026-08-16 and was substantially right;
   * this check is what makes leaving it safe, so this test is the reason that decision holds.
   */
  it('refuses when the file is REPLACED after the read', async () => {
    const path = await fixture('swapped.md')
    const decoy = join(rootPath, 'decoy.md')

    const done = await appendToDocument(root, ['swapped.md'], 'must not land\n', meddle(async () => {
      await fsp.writeFile(decoy, '# A different file entirely\n')
      await fsp.rename(decoy, path)
    }))

    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.IDENTITY_CHANGED)
    expect(await fsp.readFile(path, 'utf8'), 'the replacement is untouched')
      .toBe('# A different file entirely\n')
  })

  it('refuses when the file becomes HARD-LINKED after the read', async () => {
    const path = await fixture('relinked.md')

    const done = await appendToDocument(root, ['relinked.md'], 'must not land\n', meddle(async () => {
      await fsp.link(path, join(rootPath, 'second-name.md'))
    }))

    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.HARDLINKED)
    expect(await fsp.readFile(path, 'utf8'), 'nothing was appended').toBe(ORIGINAL)
  })

  /**
   * **`O_NOFOLLOW` on the re-open, driven.** The read refuses a symlink, so the only way to reach
   * this flag is for the path to *become* one afterwards — which is what the seam produces.
   */
  it('refuses when the path becomes a SYMLINK after the read', async () => {
    const path = await fixture('to-link.md')
    await fsp.writeFile(join(sandbox, 'outside-append.md'), 'outside the root\n')

    const done = await appendToDocument(root, ['to-link.md'], 'must not land\n', meddle(async () => {
      await fsp.rm(path, { force: true })
      await fsp.symlink(join(sandbox, 'outside-append.md'), path)
    }))

    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code, 'ELOOP is an attack signal and is named as one').toBe(ErrorCode.PATH_SYMLINK)
    expect(await fsp.readFile(join(sandbox, 'outside-append.md'), 'utf8'))
      .toBe('outside the root\n')
    await fsp.rm(path, { force: true })
  })

  /**
   * **A short write is reported, never silently truncated.** A conversation that reported a message
   * as posted and then holds half of it is the failure this surface must not have.
   *
   * The full-disk signature, matching `write.test.ts`'s: the first call is short and every call
   * after it writes zero. A volume that is full does not keep making progress.
   */
  it('refuses when the write comes up short', async () => {
    await fixture('short.md')

    const shortWriter: AppendOpener = async target => {
      const handle = await openForAppend(target)
      const original = handle.write.bind(handle)
      let first = true
      Object.assign(handle, {
        write: async (buffer: Buffer, offset: number, length: number) => {
          if (!first) return { bytesWritten: 0, buffer }
          first = false
          return original(buffer, offset, Math.min(length, 3))
        },
      })
      return handle
    }

    const done = await appendToDocument(root, ['short.md'], 'a long enough addition\n', shortWriter)

    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe(ErrorCode.IO_FAILED)
    expect(done.detail, 'says how much of it landed').toContain('of 23 bytes')
  })

  /** CONTROL. The seam itself must not be what refuses — an untouched window still appends. */
  it('CONTROL: an untouched window appends normally through the same seam', async () => {
    const path = await fixture('untouched.md')

    const done = await appendToDocument(root, ['untouched.md'], 'landed\n', meddle(async () => {}))

    expect(done.ok, 'the seam is not what refuses in the four tests above').toBe(true)
    expect(await fsp.readFile(path, 'utf8')).toBe(`${ORIGINAL}landed\n`)
  })
})
