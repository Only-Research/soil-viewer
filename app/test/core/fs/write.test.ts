import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { type RegisteredRoot } from '../../../src/core/fs/containment'
import { MAX_EDITABLE_BYTES, hashBytes, loadDocument } from '../../../src/core/fs/document'
import { registerRoot } from '../../../src/core/fs/registration'
import {
  NAME_MAX_BYTES,
  saveDocument,
  tempNameFor,
  truncationCheck,
} from '../../../src/core/fs/write'

const run = promisify(execFile)

/**
 * Real files, real renames, real permission flags. Spec §13's rules are about what the kernel does
 * to bytes on a disk, and a mock would only prove the mock agrees with the test author.
 *
 * **Nothing here goes near `/Users/hallberg/notes`.** Every file is created by this test in a
 * scratch tree it owns and removes.
 */
let sandbox: string
let rootPath: string
let root: RegisteredRoot

const ORIGINAL = '# Notes\n\nthe original content, long enough to halve\n'

/**
 * The stand-in for "the user's edit" in every test that is not about truncation.
 *
 * Deliberately longer than half of `ORIGINAL`. The first draft of this file used `'# mine\n'`
 * throughout and **ten tests failed for a reason none of them was about**: the truncation guard
 * fired first and returned `TRUNCATION_BLOCKED`, so tests aimed at conflicts and permissions were
 * all asserting against the wrong control. Green would have been worse than red — every one of
 * them would have "passed" the moment its own control was deleted.
 */
const MINE = '# Notes\n\nmy replacement text, comfortably over half the original\n'

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p4-write-'))
  rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })
  const registered = await registerRoot('scratch', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value
})

afterAll(async () => {
  await run('chflags', ['-R', 'nouchg', sandbox]).catch(() => { /* nothing locked */ })
  await fsp.rm(sandbox, { recursive: true, force: true })
})

/** A fresh file per test, so no test can be affected by another's leftovers. */
async function fixture(name: string, body = ORIGINAL): Promise<string> {
  const path = join(rootPath, name)
  await fsp.writeFile(path, body)
  return path
}

async function loadOrThrow(name: string) {
  const loaded = await loadDocument(root, [name])
  if (!loaded.ok) throw new Error(`fixture load failed: ${loaded.code}`)
  return loaded.value
}

const tempsIn = async (dir: string): Promise<string[]> =>
  (await fsp.readdir(dir)).filter(n => n.startsWith('.') && n.includes('.tmp-'))

describe('the ordinary save', () => {
  it('puts the new bytes on disk', async () => {
    await fixture('save.md')
    const doc = await loadOrThrow('save.md')

    const next = Buffer.from('# Notes\n\ncompletely rewritten\n')
    const saved = await saveDocument(root, ['save.md'], doc.baseline, next)
    expect(saved.ok).toBe(true)

    expect((await fsp.readFile(join(rootPath, 'save.md'))).equals(next)).toBe(true)
  })

  it('returns a baseline that describes the file that is now on disk', async () => {
    await fixture('chain.md')
    const doc = await loadOrThrow('chain.md')
    const next = Buffer.from(MINE)

    const saved = await saveDocument(root, ['chain.md'], doc.baseline, next)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const stat = await fsp.stat(join(rootPath, 'chain.md'), { bigint: true })
    expect(saved.value.sha256).toBe(hashBytes(next))
    expect(saved.value.size).toBe(next.length)
    expect(saved.value.ino).toBe(stat.ino)
    expect(saved.value.mtimeNs).toBe(stat.mtimeNs)
  })

  it('hands back a baseline good enough to save AGAIN without reloading', async () => {
    /**
     * The property that makes the returned baseline worth returning. If it described the temp
     * rather than the file now at the path — a plausible mistake, since it is taken from the temp
     * descriptor — the very next save would report a phantom conflict, and the user would be told
     * their file changed underneath them when nothing had touched it.
     */
    await fixture('twice.md')
    const doc = await loadOrThrow('twice.md')

    const first = await saveDocument(root, ['twice.md'], doc.baseline, Buffer.from(MINE))
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await saveDocument(
      root, ['twice.md'], first.value, Buffer.from(MINE + 'and a second round\n'),
    )
    expect(second.ok, 'the second save must not report a conflict').toBe(true)
    expect(await fsp.readFile(join(rootPath, 'twice.md'), 'utf8')).toBe(MINE + 'and a second round\n')
  })

  it('preserves the destination\'s permission bits', async () => {
    // §13.3: the mode is read and reapplied. Without it every save resets the file to the temp's
    // 0600 — "nothing is ever destroyed" should extend to the file's own metadata.
    const path = await fixture('mode.md')
    await fsp.chmod(path, 0o640)
    const doc = await loadOrThrow('mode.md')

    const saved = await saveDocument(root, ['mode.md'], doc.baseline, Buffer.from(MINE))
    expect(saved.ok).toBe(true)
    expect((await fsp.stat(path)).mode & 0o777).toBe(0o640)
  })

  it('leaves no temp file behind', async () => {
    await fixture('tidy.md')
    const doc = await loadOrThrow('tidy.md')
    await saveDocument(root, ['tidy.md'], doc.baseline, Buffer.from(MINE))
    expect(await tempsIn(rootPath)).toEqual([])
  })

  it('writes bytes verbatim — no normalization of line endings, BOM, trailing space or width', async () => {
    /**
     * The 1,610-file property. Nothing in the write path may normalize, re-encode or "clean" the
     * content it was handed.
     *
     * **The fixture changed 2026-08-08, when §12's gate landed on the write path.** It used to
     * carry `0xFF 0xFE`, which `saveDocument` now correctly refuses — so the ill-formed case moved
     * to the refusal test below and this one had to prove "verbatim" using content the function is
     * allowed to accept.
     *
     * **What is gained and what is lost, stated rather than assumed.** Lost: no valid-UTF-8 fixture
     * can catch a re-encode through a string, because encoding is injective on valid input. That
     * is now harmless rather than untested — the gate above guarantees every acceptable input
     * survives the trip, which is the whole reason the gate is on this path too.
     *
     * Gained: this fixture catches the failure that actually happened. The old editor did not
     * mangle bytes at random — it **normalized**, and every construct below is one of the things a
     * normalizing writer silently fixes: CRLF collapsed to LF, a BOM stripped as invisible junk,
     * trailing spaces trimmed (which in markdown is a hard line break, deleted), a missing final
     * newline helpfully added, and multi-byte characters re-encoded to a different width.
     */
    await fixture('bytes.md')
    const doc = await loadOrThrow('bytes.md')
    const raw = Buffer.concat([
      Buffer.from('﻿# heading, padded past the truncation guard so it is not what fails\r\n'),
      // Two trailing spaces: a markdown hard break, and the first thing a "tidy" writer removes.
      Buffer.from('a line ending in a hard break  \r\n'),
      Buffer.from('emoji 🌱 and an em dash — three bytes and four, not one each\r\n'),
      // Deliberately no final newline.
      Buffer.from('last line with no trailing newline'),
    ])

    const saved = await saveDocument(root, ['bytes.md'], doc.baseline, raw)
    expect(saved.ok).toBe(true)

    const onDisk = await fsp.readFile(join(rootPath, 'bytes.md'))
    expect(onDisk.equals(raw)).toBe(true)
    // Named individually, so a failure says which normalization happened instead of "buffers differ".
    expect(onDisk.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM survived').toBe(true)
    expect(onDisk.includes(Buffer.from('  \r\n')), 'hard break survived').toBe(true)
    expect(onDisk[onDisk.length - 1], 'no final newline was added').not.toBe(0x0a)
  })

  it('refuses ill-formed UTF-8 and NUL on the way IN — §12, the half the write path never had', async () => {
    /**
     * **This is the path that was open until P6 opened.** The gate on `loadDocument` stops a bad
     * file being read; nothing stopped bad content being written. A caller that loads an ordinary
     * document, gets its hash, and saves back bytes containing a NUL **turns a clean markdown file
     * into one this app can never open again** — self-inflicted, permanent, and invisible.
     *
     * Both halves are asserted here because they fail for different reasons, and the file is
     * checked afterwards: a refusal must leave the original completely untouched, since the whole
     * risk is that a rejected save does damage on its way to being rejected.
     */
    for (const [name, bad] of [
      ['ill-formed UTF-8', Buffer.from([0xff, 0xfe])],
      ['a NUL byte', Buffer.from([0x00])],
    ] as const) {
      await fixture('gate.md')
      const doc = await loadOrThrow('gate.md')
      const before = await fsp.readFile(join(rootPath, 'gate.md'))
      const raw = Buffer.concat([
        Buffer.from('# heading, padded well past the truncation guard so that is not what fails\n'),
        bad,
      ])

      const saved = await saveDocument(root, ['gate.md'], doc.baseline, raw)
      expect(saved.ok, `${name} must be refused`).toBe(false)
      if (saved.ok) return
      expect(saved.code, name).toBe(ErrorCode.NOT_EDITABLE)
      expect(
        (await fsp.readFile(join(rootPath, 'gate.md'))).equals(before),
        `${name}: the file must be untouched by a refused save`,
      ).toBe(true)
    }
  })
})

describe('the truncation guard — §13.2', () => {
  it('blocks a save that empties the file', async () => {
    await fixture('empty-me.md')
    const doc = await loadOrThrow('empty-me.md')

    const saved = await saveDocument(root, ['empty-me.md'], doc.baseline, Buffer.alloc(0))
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe(ErrorCode.TRUNCATION_BLOCKED)
    expect(await fsp.readFile(join(rootPath, 'empty-me.md'), 'utf8')).toBe(ORIGINAL)
  })

  it('blocks a save under half, and allows one at exactly half', () => {
    // Driven through the predicate so the boundary is pinned precisely. §13.2 says "less than half"
    // is blocked, so half itself must pass — an off-by-one here nags the user on ordinary edits,
    // and a guard that cries wolf is a guard that gets confirmed without reading.
    expect(truncationCheck(100, 49), 'under half is blocked').not.toBeNull()
    expect(truncationCheck(100, 50), 'exactly half is allowed').toBeNull()
    expect(truncationCheck(100, 51), 'over half is allowed').toBeNull()
    expect(truncationCheck(100, 0), 'zero is always blocked').not.toBeNull()
  })

  it('does not fire when the file was already empty', () => {
    // Otherwise a new, empty note could never be saved at all.
    expect(truncationCheck(0, 0)).toBeNull()
  })

  it('reports how much would be lost, so the caller can name it', async () => {
    await fixture('name-the-loss.md')
    const doc = await loadOrThrow('name-the-loss.md')
    const saved = await saveDocument(root, ['name-the-loss.md'], doc.baseline, Buffer.from('x'))
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.detail).toContain(String(ORIGINAL.length))
  })

  it('goes through once the caller confirms', async () => {
    await fixture('confirmed.md')
    const doc = await loadOrThrow('confirmed.md')

    const saved = await saveDocument(
      root, ['confirmed.md'], doc.baseline, Buffer.from('x'), { confirmedTruncation: true },
    )
    expect(saved.ok).toBe(true)
    expect(await fsp.readFile(join(rootPath, 'confirmed.md'), 'utf8')).toBe('x')
  })
})

describe('conflict detection — §13.4', () => {
  it('refuses when the content changed, and does not touch the file', async () => {
    await fixture('conflict.md')
    const doc = await loadOrThrow('conflict.md')

    const theirs = '# Notes\n\nan agent wrote this while the editor was open\n'
    await fsp.writeFile(join(rootPath, 'conflict.md'), theirs)

    const saved = await saveDocument(root, ['conflict.md'], doc.baseline, Buffer.from(MINE))
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe(ErrorCode.CONFLICT_DETECTED)
    expect(
      await fsp.readFile(join(rootPath, 'conflict.md'), 'utf8'),
      'the other writer\'s content must survive untouched',
    ).toBe(theirs)
    expect(await tempsIn(rootPath)).toEqual([])
  })

  it('fires on a same-LENGTH edit, which size and mtime checks would both miss', async () => {
    /**
     * The case that separates a hash from every cheaper token. An agent replacing one word with
     * another of the same length leaves the size identical, and a filesystem that stamps the mtime
     * at second granularity can leave that identical too. Only the content differs.
     */
    const body = '# Notes\n\nalpha\n'
    await fixture('same-length.md', body)
    const doc = await loadOrThrow('same-length.md')

    const theirs = '# Notes\n\nbravo\n'
    expect(theirs.length, 'the fixture only proves the point at equal length').toBe(body.length)
    await fsp.writeFile(join(rootPath, 'same-length.md'), theirs)

    const saved = await saveDocument(root, ['same-length.md'], doc.baseline, Buffer.from(MINE))
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe(ErrorCode.CONFLICT_DETECTED)
  })

  it('does NOT fire when an agent rewrote identical bytes', async () => {
    /**
     * §13.4 is explicit that false positives are equally harmful, and that on the user's tree an
     * agent rewriting identical content is the *common* case, not the exotic one. Each false
     * positive spawns a conflict artifact that can never be deleted, because nothing here deletes.
     *
     * The rewrite below moves the inode and the mtime and leaves the bytes alone — exactly what a
     * tool that reads, formats and writes back does when it finds nothing to change.
     */
    await fixture('identical.md')
    const doc = await loadOrThrow('identical.md')

    const temp = join(rootPath, 'rewritten-elsewhere.tmp')
    await fsp.writeFile(temp, ORIGINAL)
    await fsp.rename(temp, join(rootPath, 'identical.md'))

    const saved = await saveDocument(root, ['identical.md'], doc.baseline, Buffer.from(MINE))
    expect(
      saved.ok,
      'identical bytes are not a conflict, whatever the inode and mtime say',
    ).toBe(true)
  })

  it('catches a DIFFERENT FILE moved into the path — by its bytes, not its inode', async () => {
    /**
     * The `mv draft.md notes.md` case §13.4 leads with, and the reason mtime is the wrong token:
     * `mv` preserves it, so the path acquires an *older* timestamp and an ordered comparison sees
     * nothing wrong at all.
     *
     * It is caught here by content, which is the same test that lets the identical-bytes case
     * through. One rule, both outcomes — see the test above and the note in `verifyDestination`
     * about why the inode is deliberately not consulted.
     */
    await fixture('replaced.md')
    const doc = await loadOrThrow('replaced.md')

    const intruder = join(rootPath, 'intruder.md')
    await fsp.writeFile(intruder, '# an entirely different document, of its own length\n')
    // `mv` preserves mtime; make the fixture say so explicitly rather than hope.
    const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    await fsp.utimes(intruder, longAgo, longAgo)
    await fsp.rename(intruder, join(rootPath, 'replaced.md'))

    const now = await fsp.stat(join(rootPath, 'replaced.md'), { bigint: true })
    expect(now.mtimeNs < doc.baseline.mtimeNs, 'the intruder must look OLDER').toBe(true)

    const saved = await saveDocument(root, ['replaced.md'], doc.baseline, Buffer.from(MINE))
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe(ErrorCode.CONFLICT_DETECTED)
    expect(await fsp.readFile(join(rootPath, 'replaced.md'), 'utf8'))
      .toBe('# an entirely different document, of its own length\n')
  })
})

describe('a file that cannot be written is refused BEFORE the user loses anything', () => {
  it('names an immutable file distinctly, and leaves it alone', async () => {
    /**
     * §13.2: `rename(2)` succeeds over a *non-writable* file when the parent is writable, so
     * nothing later in the sequence would catch this. Node cannot read `st_flags` at all —
     * measured — so the detection is `access(W_OK)` returning EPERM, which is what separates an
     * immutable flag from a permission-bit denial's EACCES. The two need different sentences: one
     * is a Get Info change, the other is `chflags nouchg`.
     */
    const path = await fixture('locked.md')
    const doc = await loadOrThrow('locked.md')
    await run('chflags', ['uchg', path])
    try {
      const saved = await saveDocument(root, ['locked.md'], doc.baseline, Buffer.from(MINE))
      expect(saved.ok).toBe(false)
      if (saved.ok) return
      expect(saved.code).toBe(ErrorCode.FILE_IMMUTABLE)
      expect(await fsp.readFile(path, 'utf8')).toBe(ORIGINAL)
    } finally {
      await run('chflags', ['nouchg', path]).catch(() => { /* already clear */ })
    }
  })

  it('names a permission-bit denial as PERMISSION_DENIED, not as immutable', async () => {
    const path = await fixture('readonly.md')
    const doc = await loadOrThrow('readonly.md')
    await fsp.chmod(path, 0o444)
    try {
      const saved = await saveDocument(root, ['readonly.md'], doc.baseline, Buffer.from(MINE))
      expect(saved.ok).toBe(false)
      if (saved.ok) return
      expect(saved.code).toBe(ErrorCode.PERMISSION_DENIED)
      expect(await fsp.readFile(path, 'utf8')).toBe(ORIGINAL)
    } finally {
      await fsp.chmod(path, 0o644)
    }
  })
})

describe('the chokepoint still applies to writes — §6', () => {
  it('refuses a non-markdown path even with a valid baseline in hand', async () => {
    /**
     * §6: write and append accept only paths satisfying `isMarkdown()` **regardless of what the
     * client asked**. The baseline here is real — loaded from a genuine `.md` file — so this proves
     * the gate is on the write verb itself and not merely inherited from the load.
     */
    await fixture('source.md')
    const doc = await loadOrThrow('source.md')
    await fsp.writeFile(join(rootPath, 'target.txt'), 'not markdown\n')

    const saved = await saveDocument(root, ['target.txt'], doc.baseline, Buffer.from(MINE))
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe(ErrorCode.NOT_MARKDOWN)
    expect(await fsp.readFile(join(rootPath, 'target.txt'), 'utf8')).toBe('not markdown\n')
  })

  it('refuses content over the editable cap', async () => {
    await fixture('cap.md')
    const doc = await loadOrThrow('cap.md')
    const saved = await saveDocument(
      root, ['cap.md'], doc.baseline, Buffer.alloc(MAX_EDITABLE_BYTES + 1, 0x61),
    )
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe(ErrorCode.TOO_LARGE)
  })
})

describe('writes never create anything — §13.3', () => {
  it('fails loudly for a missing file and creates no directory', async () => {
    await fixture('donor.md')
    const doc = await loadOrThrow('donor.md')

    const saved = await saveDocument(
      root, ['no-such-folder', 'note.md'], doc.baseline, Buffer.from(MINE),
    )
    expect(saved.ok).toBe(false)
    await expect(fsp.stat(join(rootPath, 'no-such-folder'))).rejects.toThrow()
  })

  it('refuses to save through a symlink', async () => {
    const outside = join(sandbox, 'outside-target.md')
    await fsp.writeFile(outside, 'must never be written through the root\n')
    await fsp.symlink(outside, join(rootPath, 'link.md'))
    await fixture('donor2.md')
    const doc = await loadOrThrow('donor2.md')
    try {
      const saved = await saveDocument(root, ['link.md'], doc.baseline, Buffer.from(MINE))
      expect(saved.ok).toBe(false)
      expect(await fsp.readFile(outside, 'utf8'))
        .toBe('must never be written through the root\n')
    } finally {
      await fsp.rm(join(rootPath, 'link.md'), { force: true })
      await fsp.rm(outside, { force: true })
    }
  })
})

/**
 * **A SAVE THAT LANDED IS REPORTED AS LANDED**, even when the durability step after it fails.
 *
 * The directory `fsync` runs *after* the rename, so by the time it can fail the bytes are already at
 * the path. Reporting `IO_FAILED` for that is not cautious, it is false — and the client believes
 * it: the buffer stays dirty, the hash never advances, and it re-sends against a baseline the disk
 * has moved past. That bred one byte-identical conflict artifact per retry, permanently, in an app
 * with no delete.
 *
 * **And on the volume that has this, it is not rare — it is total.** A filesystem that refuses
 * `fsync` on a directory descriptor refuses every one, so every save on that disk reported failure
 * while working perfectly. External and network drives are exactly where the code already expects to
 * meet it.
 *
 * The seam exists because that volume cannot be conjured here: mounting one is a change to the
 * machine, and the sandbox refuses it. What is under test is our own sequence — which is where the
 * decision lives.
 */
describe('the durability step fails after the rename — §13.2', () => {
  const refuses = async (): Promise<void> => {
    const error: NodeJS.ErrnoException = new Error('fsync on a directory is not supported here')
    error.code = 'EINVAL'
    throw error
  }

  it('reports the save as SAVED, and the bytes are really there', async () => {
    const path = await fixture('fsync-refused.md')
    const doc = await loadOrThrow('fsync-refused.md')

    const saved = await saveDocument(
      root, ['fsync-refused.md'], doc.baseline, Buffer.from(MINE), {}, undefined, refuses,
    )

    expect(saved.ok, 'the rename already happened — the save did not fail').toBe(true)
    expect(await fsp.readFile(path, 'utf8'), 'and this is why').toBe(MINE)
  })

  /**
   * **The baseline has to be the real one**, not merely "not an error". The returned hash is what
   * the client stores and sends as `expectedHash` next time; handing back anything stale would
   * leave it re-sending forever, which is the loop this whole change exists to close.
   */
  it('returns a baseline describing the bytes now on disk', async () => {
    await fixture('fsync-baseline.md')
    const doc = await loadOrThrow('fsync-baseline.md')

    const saved = await saveDocument(
      root, ['fsync-baseline.md'], doc.baseline, Buffer.from(MINE), {}, undefined, refuses,
    )

    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.value.sha256).toBe(hashBytes(Buffer.from(MINE)))
    expect(saved.value.size).toBe(Buffer.byteLength(MINE))
  })

  /**
   * The guard on the guard: swallowing the directory sync must not have swallowed anything else.
   * A failure *before* the rename still fails, loudly, with the destination untouched.
   */
  it('still fails when the failure comes BEFORE the rename', async () => {
    const path = await fixture('fsync-not-a-shield.md')
    const doc = await loadOrThrow('fsync-not-a-shield.md')

    const openTemp = async (directory: string, fileName: string) => {
      const named = tempNameFor(fileName, 'deadbeefdeadbeef')
      if (!named.ok) throw new Error('temp name failed')
      const temp = join(directory, named.value)
      const handle = await fsp.open(temp, 'w+', 0o600)
      Object.assign(handle, {
        write: async () => {
          const error: NodeJS.ErrnoException = new Error('the write itself failed')
          error.code = 'EIO'
          throw error
        },
      })
      return { ok: true as const, value: { handle, path: temp } }
    }

    const saved = await saveDocument(
      root, ['fsync-not-a-shield.md'], doc.baseline, Buffer.from(MINE), {}, openTemp, refuses,
    )

    expect(saved.ok).toBe(false)
    expect(await fsp.readFile(path, 'utf8'), 'the destination is untouched').toBe(ORIGINAL)
  })
})

describe('nothing reaches the rename after a failed write — §13.2 C3', () => {
  /**
   * **Acceptance condition 1: a full-volume condition renames nothing.**
   *
   * A real full volume would need a mounted disk image of a fixed size — a change to the machine,
   * and one the command sandbox refuses. So the temp *opener* is injected and hands back a
   * descriptor that misbehaves in the two ways a full disk misbehaves. What is under test is our
   * own sequence, which is where the C3 rule lives; the kernel's side of it (that `write` can
   * report success and come up short) is the documented premise, not the claim.
   *
   * The assertion in every case is the same and it is the only one that matters: **the destination
   * still holds the original bytes.**
   */
  const realTemp = async (directory: string, fileName: string) => {
    const named = tempNameFor(fileName, 'deadbeefdeadbeef')
    if (!named.ok) throw new Error('temp name failed')
    const path = join(directory, named.value)
    const handle = await fsp.open(path, 'w+', 0o600)
    return { handle, path }
  }

  /**
   * **THE RENAME ITSELF FAILING, which nothing asserted until 2026-08-16.**
   *
   * Found by mutation while verifying a different change: replacing `return renameFailure(...)` with
   * `renamed = true` — swallowing the failure and reporting success — left **the entire write suite
   * green**. That is the worst outcome this module can produce, silent data loss: the save says it
   * landed, the destination still holds the old bytes, and the client clears its dirty flag and
   * throws the edit away.
   *
   * Everything else in this describe fails *before* the rename, and the pre-flight checks
   * (permissions, the immutable flag, containment) catch the ordinary causes earlier still — which
   * is exactly why the rename's own failure had no test. It is still reachable: `EXDEV`, `EIO`, and
   * any race between the pre-flight and the call.
   *
   * **Provoked without a new seam.** The temp is unlinked after it is opened, so the descriptor
   * stays valid — write, `fsync`, `chmod` and the `fstat` baseline all succeed exactly as they
   * normally would — and `rename(2)` is then handed a path with nothing at it.
   */
  it('a rename that fails is reported, and the destination keeps its old bytes', async () => {
    const path = await fixture('rename-fails.md')
    const doc = await loadOrThrow('rename-fails.md')

    const openTemp = async (directory: string, fileName: string) => {
      const { handle, path: temp } = await realTemp(directory, fileName)
      await fsp.unlink(temp)
      return { ok: true as const, value: { handle, path: temp } }
    }

    const saved = await saveDocument(root, ['rename-fails.md'], doc.baseline,
      Buffer.from(MINE), {}, openTemp)

    expect(saved.ok, 'a save that did not land must never report success').toBe(false)
    expect(await fsp.readFile(path, 'utf8'), 'the destination is untouched').toBe(ORIGINAL)
  })

  it('a SHORT write never renames, and never leaves a truncated file behind', async () => {
    const path = await fixture('short-write.md')
    const doc = await loadOrThrow('short-write.md')

    const openTemp = async (directory: string, fileName: string) => {
      const { handle, path: temp } = await realTemp(directory, fileName)
      /**
       * The full-disk signature, and the first version of this mock had it wrong.
       *
       * It capped every call at 4 bytes, which is an ordinary POSIX short write — the write loop
       * simply calls again and completes, so the save SUCCEEDED and the test failed. A volume that
       * is actually full does not keep making progress: it takes what fits and then takes nothing.
       * So the first call is short and every call after it writes zero.
       */
      const original = handle.write.bind(handle)
      let firstCall = true
      Object.assign(handle, {
        write: async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (!firstCall) return { bytesWritten: 0, buffer }
          firstCall = false
          return original(buffer, offset, Math.min(length, 4), position)
        },
      })
      return { ok: true as const, value: { handle, path: temp } }
    }

    const saved = await saveDocument(root, ['short-write.md'], doc.baseline,
      Buffer.from(MINE), {}, openTemp)

    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe(ErrorCode.WRITE_SIZE_MISMATCH)
    expect(await fsp.readFile(path, 'utf8'), 'the destination must be untouched').toBe(ORIGINAL)
  })

  it('a write that fails ENOSPC reports DISK_FULL and leaves the file alone', async () => {
    const path = await fixture('enospc.md')
    const doc = await loadOrThrow('enospc.md')

    const openTemp = async (directory: string, fileName: string) => {
      const { handle, path: temp } = await realTemp(directory, fileName)
      Object.assign(handle, {
        write: async () => {
          const error: NodeJS.ErrnoException = new Error('no space left on device')
          error.code = 'ENOSPC'
          throw error
        },
      })
      return { ok: true as const, value: { handle, path: temp } }
    }

    const saved = await saveDocument(root, ['enospc.md'], doc.baseline,
      Buffer.from(MINE), {}, openTemp)

    expect(saved.ok).toBe(false)
    if (saved.ok) return
    // §13.2 requires this be its own sticky, named state rather than a generic IO failure — a
    // disk-full save reported generically is one the user retries forever.
    expect(saved.code).toBe(ErrorCode.DISK_FULL)
    expect(await fsp.readFile(path, 'utf8')).toBe(ORIGINAL)

    /**
     * §13.2: "ENOSPC/EDQUOT -> sticky named error, buffer retained, **temp left for the sweep**,
     * never renamed." So the leftover is the specified behaviour, not litter — asserted here
     * rather than discovered later as a mysterious file. (It first showed up as two unrelated
     * tests failing, which is exactly how an unasserted side effect announces itself.)
     *
     * Removed afterwards so it does not leak into the tests that check for a tidy folder; the
     * startup sweep in §13.3 is what collects it in production.
     */
    const left = await tempsIn(rootPath)
    expect(left, 'the temp is deliberately left for the startup sweep').toHaveLength(1)
    await fsp.rm(join(rootPath, left[0] as string), { force: true })
  })

  it('a temp whose fstat disagrees with the content never renames', async () => {
    /**
     * The C3 assertion itself, isolated. Here every `write` call reports the full count — so the
     * short-write check above passes — and the descriptor's own `fstat` still says the file is a
     * different size. That is exactly the shape of a filesystem that accepted the bytes and did
     * not store them, and the assertion inside `baselineFrom` is the last thing between it and a
     * rename over good content.
     */
    const path = await fixture('lying-fstat.md')
    const doc = await loadOrThrow('lying-fstat.md')

    const openTemp = async (directory: string, fileName: string) => {
      const { handle, path: temp } = await realTemp(directory, fileName)
      const originalStat = handle.stat.bind(handle)
      Object.assign(handle, {
        stat: async () => {
          const real = await originalStat({ bigint: true }) as unknown as { size: bigint }
          return { ...real, size: real.size - 1n }
        },
      })
      return { ok: true as const, value: { handle, path: temp } }
    }

    const saved = await saveDocument(root, ['lying-fstat.md'], doc.baseline,
      Buffer.from(MINE), {}, openTemp)

    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe(ErrorCode.WRITE_SIZE_MISMATCH)
    expect(await fsp.readFile(path, 'utf8'), 'the destination must be untouched').toBe(ORIGINAL)
  })

  it('cleans up the temp when the write failed', async () => {
    const path = await fixture('cleanup.md')
    const doc = await loadOrThrow('cleanup.md')

    const openTemp = async (directory: string, fileName: string) => {
      const { handle, path: temp } = await realTemp(directory, fileName)
      const original = handle.write.bind(handle)
      let firstCall = true
      Object.assign(handle, {
        write: async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (!firstCall) return { bytesWritten: 0, buffer }
          firstCall = false
          return original(buffer, offset, Math.min(length, 4), position)
        },
      })
      return { ok: true as const, value: { handle, path: temp } }
    }

    await saveDocument(root, ['cleanup.md'], doc.baseline, Buffer.from(MINE), {}, openTemp)
    expect(await tempsIn(rootPath), 'a failed save must not litter the folder').toEqual([])
    expect(await fsp.readFile(path, 'utf8')).toBe(ORIGINAL)
  })
})

describe('the temp name', () => {
  it('matches the pattern §3 ignores, so the indexer never sees one', () => {
    const named = tempNameFor('notes.md', '0123456789abcdef')
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(named.value).toBe('.notes.md.tmp-0123456789abcdef')
    expect(named.value.startsWith('.')).toBe(true)
    expect(named.value).toContain('.tmp-')
  })

  it('fits inside NAME_MAX in BYTES, not characters', () => {
    /**
     * §13.5 requires every generated path be validated against NAME_MAX in bytes. The failure it
     * prevents is the worst kind in v1: the equivalent overflow hit the *conflict* file, the write
     * failed ENAMETOOLONG, **and the edit it existed to rescue was gone**.
     *
     * Characters are the wrong unit here. The name below is well under 255 characters and well
     * over 255 bytes, because each em dash is three bytes — so a length check in characters passes
     * it straight through to a filesystem that refuses it.
     */
    const wide = '—'.repeat(100) + '.md'
    expect(wide.length, 'under the cap counted in characters').toBeLessThan(NAME_MAX_BYTES)
    expect(Buffer.byteLength(wide, 'utf8'), 'over it in bytes').toBeGreaterThan(NAME_MAX_BYTES)

    const named = tempNameFor(wide, '0123456789abcdef')
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(Buffer.byteLength(named.value, 'utf8')).toBeLessThanOrEqual(NAME_MAX_BYTES)
  })

  it('never truncates the random suffix — that is what makes it unpredictable', () => {
    const named = tempNameFor('x'.repeat(400) + '.md', '0123456789abcdef')
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(named.value.endsWith('.tmp-0123456789abcdef')).toBe(true)
    expect(Buffer.byteLength(named.value, 'utf8')).toBeLessThanOrEqual(NAME_MAX_BYTES)
  })

  it('never emits a partial UTF-8 sequence when it trims', () => {
    // A name cut mid-character is a name no one can type and some tools cannot handle.
    const named = tempNameFor('日'.repeat(200) + '.md', '0123456789abcdef')
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(named.value).not.toContain('�')
    expect(Buffer.byteLength(named.value, 'utf8')).toBeLessThanOrEqual(NAME_MAX_BYTES)
  })

  it('is different every time', async () => {
    // Predictable temp paths are what make the pre-placed-symlink attack in §13.3 possible at all.
    await fixture('random.md')
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const named = tempNameFor('random.md', '')
      expect(named.ok).toBe(true)
    }
    for (let i = 0; i < 50; i++) {
      const doc = await loadOrThrow('random.md')
      const saved = await saveDocument(
        root, ['random.md'], doc.baseline, Buffer.from(`# version ${i} with enough body\n`),
      )
      expect(saved.ok).toBe(true)
      if (saved.ok) seen.add(saved.value.mtimeNs.toString() + saved.value.sha256)
    }
    expect(seen.size, 'fifty saves, fifty distinct results').toBe(50)
    expect(await tempsIn(rootPath)).toEqual([])
  })
})
