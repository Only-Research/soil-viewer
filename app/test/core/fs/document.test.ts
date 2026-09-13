import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { openFileForRead, type RegisteredRoot } from '../../../src/core/fs/containment'
import {
  MAX_EDITABLE_BYTES,
  confirmUnchangedDuringRead,
  editabilityRefusal,
  hashBytes,
  loadDocument,
  type DocumentBaseline,
} from '../../../src/core/fs/document'
import { MAX_EDITABLE_BYTES as SERVER_MAX_EDITABLE_BYTES } from '../../../src/server/limits'
import { registerRoot } from '../../../src/core/fs/registration'

/**
 * Real files in a scratch tree this file creates and owns. Spec §4's and §13's rules are about what
 * the kernel does; a mock would only prove the mock agrees with the test author.
 *
 * **Nothing here goes near `/Users/hallberg/notes`.** P4 is the first phase with a write path,
 * and the operator's standing rule is that their real files are asked about before anything touches them.
 */
let sandbox: string
let root: RegisteredRoot

const NOTES = '# Notes\n\nreal content\n'

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p4-doc-'))
  const rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })

  await fsp.writeFile(join(rootPath, 'notes.md'), NOTES)
  await fsp.writeFile(join(rootPath, 'empty.md'), '')
  await fsp.writeFile(join(rootPath, 'notes.txt'), 'not markdown\n')
  await fsp.writeFile(join(rootPath, 'notes.markdown'), 'still not markdown\n')
  await fsp.writeFile(join(rootPath, 'notes.mdx'), 'still not markdown\n')
  await fsp.writeFile(join(rootPath, 'unicode.md'), '# 日本語 — em dash and “curly quotes”\n')

  const registered = await registerRoot('scratch', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value
})

afterAll(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

describe('the load, and what it hands forward', () => {
  it('returns the exact bytes on disk', async () => {
    const loaded = await loadDocument(root, ['notes.md'])
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.bytes.equals(Buffer.from(NOTES))).toBe(true)
  })

  it('carries a baseline whose hash matches the file on disk', async () => {
    const loaded = await loadDocument(root, ['unicode.md'])
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const onDisk = await fsp.readFile(join(sandbox, 'root', 'unicode.md'))
    expect(loaded.value.baseline.sha256).toBe(hashBytes(onDisk))
  })

  it('hashes the BYTES, not a decoded string — proven on ill-formed UTF-8, at the only level where it still can be', () => {
    /**
     * **REWRITTEN 2026-08-08, when §12's editability gate landed on `loadDocument`.**
     *
     * The original drove this through `loadDocument` and asserted the baseline's digest. That is
     * no longer reachable, and the reason is worth stating rather than absorbing: **the gate
     * refuses ill-formed UTF-8, and ill-formed UTF-8 is the only input that separates a
     * byte-hashing implementation from a string-hashing one.** Encoding is injective on valid
     * input, so for every file that can now obtain a baseline through a load, the two produce the
     * identical digest.
     *
     * **So this is a real, permanent reduction in what a fixture can prove about `loadDocument`,
     * caused by a correct control.** It is recorded in `open-items.md` rather than left as a test
     * that quietly stopped separating the two things it was written to separate. What remains
     * provable is proven here, one level down, on the function that actually does the hashing —
     * and the load path's new behaviour on the very same bytes is the test immediately below, so
     * the fixture is not lost, only re-aimed.
     *
     * The original reasoning, still exactly right about why the fixture must be ill-formed: `0xFF`
     * is not a legal UTF-8 byte; decoding replaces it with U+FFFD, which re-encodes to three
     * completely different bytes. A string-hashing implementation therefore digests content that
     * is not on disk — and hashes two files that differ on disk to the same value, which is a
     * conflict that never fires.
     */
    const raw = Buffer.from([0x23, 0x20, 0x54, 0x69, 0x74, 0x6c, 0x65, 0x0a, 0xff, 0xfe, 0x0a])
    const throughAString = hashBytes(Buffer.from(raw.toString('utf8'), 'utf8'))
    expect(
      hashBytes(raw),
      'hashing via a decoded string must not produce the same digest',
    ).not.toBe(throughAString)
  })

  it('refuses ill-formed UTF-8 — §12, and this is the fixture the test above used to load', async () => {
    const raw = Buffer.from([0x23, 0x20, 0x54, 0x69, 0x74, 0x6c, 0x65, 0x0a, 0xff, 0xfe, 0x0a])
    const path = join(sandbox, 'root', 'ill-formed.md')
    await fsp.writeFile(path, raw)
    try {
      const loaded = await loadDocument(root, ['ill-formed.md'])
      expect(loaded.ok).toBe(false)
      if (loaded.ok) return
      expect(loaded.code).toBe(ErrorCode.NOT_EDITABLE)
      // The file is untouched. A refusal reads and declines; it never repairs.
      expect((await fsp.readFile(path)).equals(raw)).toBe(true)
    } finally {
      await fsp.rm(path, { force: true })
    }
  })

  it('refuses a NUL byte — §12’s other half, which was missing until P6 opened', async () => {
    /**
     * The half that was absent. **NUL is a perfectly legal code point**, so this file decodes,
     * re-encodes byte-identically, and sails through a round-trip check — which is exactly how it
     * was editable while the app looked correct. Nothing about the UTF-8 clause implies this one.
     */
    const raw = Buffer.from([0x23, 0x20, 0x54, 0x69, 0x74, 0x6c, 0x65, 0x0a, 0x00, 0x62, 0x0a])
    expect(
      Buffer.from(raw.toString('utf8'), 'utf8').equals(raw),
      'the fixture must pass a UTF-8 round trip, or it is not testing the NUL clause',
    ).toBe(true)

    const path = join(sandbox, 'root', 'nul-bearing.md')
    await fsp.writeFile(path, raw)
    try {
      const loaded = await loadDocument(root, ['nul-bearing.md'])
      expect(loaded.ok).toBe(false)
      if (loaded.ok) return
      expect(loaded.code).toBe(ErrorCode.NOT_EDITABLE)
    } finally {
      await fsp.rm(path, { force: true })
    }
  })

  it('carries identity from the descriptor, matching what the kernel reports', async () => {
    const loaded = await loadDocument(root, ['notes.md'])
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const stat = await fsp.stat(join(sandbox, 'root', 'notes.md'), { bigint: true })
    expect(loaded.value.baseline.dev).toBe(stat.dev)
    expect(loaded.value.baseline.ino).toBe(stat.ino)
    expect(loaded.value.baseline.size).toBe(Buffer.byteLength(NOTES))
  })

  it('loads a genuinely empty file as a success — 0 bytes is content, not failure', async () => {
    /**
     * The distinction the whole C2 path turns on. §13.2's rule is that a *failed* read must never
     * present as an empty document; a file that really is empty must still open, or every new note
     * is unopenable. The two are told apart by whether the read succeeded, never by the byte count.
     */
    const loaded = await loadDocument(root, ['empty.md'])
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.bytes.length).toBe(0)
    // The SHA-256 of zero bytes. Spelled out so the assertion is about a known value rather than
    // about whatever the implementation happened to produce.
    expect(loaded.value.baseline.sha256)
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('"no save without a load" is a TYPE property, not a remembered rule', () => {
  it('a baseline cannot be assembled by hand', () => {
    /**
     * §13.2's rule is *"no save without a load"*, and this build has watched too many controls be
     * correct-and-unreached to trust a rule phrased that way. The write path (landing later this
     * phase) will require a `DocumentBaseline`, and the brand means the only way to hold one is to
     * have completed a real read.
     *
     * **The proof clause is the `@ts-expect-error` below, and it bites at typecheck rather than at
     * runtime.** If the brand is ever dropped, this literal starts compiling, the suppression
     * becomes unused, and `tsc` fails on it by name. A runtime assertion could not test this at
     * all — there is nothing to observe, because the brand has no runtime existence.
     *
     * The threat is our own future code taking a shortcut, not an attacker; anyone running
     * arbitrary code in this process does not need to forge a struct.
     */
    // @ts-expect-error a DocumentBaseline carries a brand no module outside document.ts can name
    const forged: DocumentBaseline = {
      dev: 1n, ino: 2n, size: 3, mtimeNs: 4n,
      sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    }
    expect(forged.sha256).toHaveLength(64)
  })

  it('and a real load produces one', async () => {
    const loaded = await loadDocument(root, ['notes.md'])
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const accepted: DocumentBaseline = loaded.value.baseline
    expect(accepted.sha256).toBe(hashBytes(Buffer.from(NOTES)))
  })
})

describe('the markdown gate is server-side law — §6', () => {
  it('refuses a .txt file even though it exists and is readable', async () => {
    const loaded = await loadDocument(root, ['notes.txt'])
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.code).toBe(ErrorCode.NOT_MARKDOWN)
  })

  it('refuses .markdown and .mdx, which §6 names and excludes', async () => {
    // FT-12 names these explicitly so a helpful builder does not quietly widen the set.
    for (const name of ['notes.markdown', 'notes.mdx']) {
      const loaded = await loadDocument(root, [name])
      expect(loaded.ok, name).toBe(false)
      if (!loaded.ok) expect(loaded.code, name).toBe(ErrorCode.NOT_MARKDOWN)
    }
  })

  it('refuses BEFORE opening the file — the gate is not a post-read filter', async () => {
    /**
     * §6: write and append accept only paths satisfying `isMarkdown()` **regardless of what the
     * client asked**. A gate applied after the open would still return the right code while having
     * already read bytes it had no business reading — and it would make the not-markdown refusal
     * indistinguishable from a missing file, because a nonexistent path would fail on the open
     * first. A nonexistent `.txt` must still refuse as NOT_MARKDOWN.
     */
    const loaded = await loadDocument(root, ['does-not-exist-at-all.txt'])
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.code).toBe(ErrorCode.NOT_MARKDOWN)
  })

  it('refuses a path with no segments at all rather than reading the root directory', async () => {
    const loaded = await loadDocument(root, [])
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.code).toBe(ErrorCode.NOT_MARKDOWN)
  })
})

describe('the editable cap', () => {
  it('is the literal §6 figure', () => {
    expect(MAX_EDITABLE_BYTES, '§6: MAX_EDITABLE_BYTES = 2 MiB').toBe(2 * 1024 * 1024)
  })

  it('is ONE number — the server re-exports Core rather than keeping a copy', () => {
    /**
     * §6 says of the markdown predicate that "divergence is a build failure", and the same holds
     * for the size that decides whether an edit is possible at all. Two copies of this number, one
     * gating the editor and one deriving the request body cap, is FT-3: an edit accepted by the
     * screen and refused by the server, which presents as losing work.
     */
    expect(SERVER_MAX_EDITABLE_BYTES).toBe(MAX_EDITABLE_BYTES)
  })

  it('refuses a file over the cap, and refuses it on the DESCRIPTOR size', async () => {
    const big = join(sandbox, 'root', 'big.md')
    await fsp.writeFile(big, Buffer.alloc(MAX_EDITABLE_BYTES + 1, 0x61))
    try {
      const loaded = await loadDocument(root, ['big.md'])
      expect(loaded.ok).toBe(false)
      if (loaded.ok) return
      expect(loaded.code).toBe(ErrorCode.TOO_LARGE)
    } finally {
      await fsp.rm(big, { force: true })
    }
  })

  it('accepts a file exactly AT the cap — the boundary is inclusive', async () => {
    // An off-by-one here makes the largest legitimately editable file unopenable, and the symptom
    // ("this one file won't open") looks nothing like a limit.
    const atCap = join(sandbox, 'root', 'at-cap.md')
    await fsp.writeFile(atCap, Buffer.alloc(MAX_EDITABLE_BYTES, 0x61))
    try {
      const loaded = await loadDocument(root, ['at-cap.md'])
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) return
      expect(loaded.value.bytes.length).toBe(MAX_EDITABLE_BYTES)
    } finally {
      await fsp.rm(atCap, { force: true })
    }
  })
})

describe('§4 still applies — the load does not open its own door', () => {
  it('refuses a symlink, resolving nothing', async () => {
    const outside = join(sandbox, 'outside-secret.md')
    await fsp.writeFile(outside, 'must never be readable through the root\n')
    const link = join(sandbox, 'root', 'link-out.md')
    await fsp.symlink(outside, link)
    try {
      const loaded = await loadDocument(root, ['link-out.md'])
      expect(loaded.ok).toBe(false)
      if (loaded.ok) return
      expect([ErrorCode.PATH_SYMLINK, ErrorCode.NOT_REGULAR_FILE]).toContain(loaded.code)
    } finally {
      await fsp.rm(link, { force: true })
      await fsp.rm(outside, { force: true })
    }
  })

  it('refuses traversal out of the root — caught by the SECOND wall, and that is the point', async () => {
    /**
     * `..` is normally refused by `validateRelativePath` at the contract boundary, long before
     * Core sees it. This test calls Core directly with a `..` segment, which is the shape of a
     * future bug: a new internal caller that composes segments itself and forgets the validator.
     *
     * It is refused anyway, and the code says which wall stopped it — `PATH_ESCAPES_ROOT`, the
     * containment re-check performed *after* composition, not `PATH_TRAVERSAL` from segment
     * validation. §4 requires that re-check precisely because validation and composition are
     * separate steps and only the second one proves where the path actually landed.
     *
     * Asserting the specific code rather than "some failure" is deliberate: this test predicted
     * its own future correctly — *"if this ever comes back as `PATH_TRAVERSAL`, the segment
     * validator has been pulled into Core"* — and on 2026-08-09 it did, for the reason below.
     */
    const outside = join(sandbox, 'outside-target.md')
    await fsp.writeFile(outside, 'must never be readable through the root\n')
    try {
      const loaded = await loadDocument(root, ['..', 'outside-target.md'])
      expect(loaded.ok).toBe(false)
      if (loaded.ok) return
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
      expect(loaded.code).toBe(ErrorCode.PATH_TRAVERSAL)
    } finally {
      await fsp.rm(outside, { force: true })
    }
  })

  it('refuses a hard-linked file', async () => {
    // `ln ~/.ssh/id_ed25519 root/notes.md` passes containment and is a regular file inside the
    // root. Link count is the only thing that catches it, and it must catch it on the way to an
    // EDITOR too, not only on a plain read.
    const original = join(sandbox, 'root', 'linked-original.md')
    const second = join(sandbox, 'root', 'linked-second.md')
    await fsp.writeFile(original, 'linked\n')
    await fsp.link(original, second)
    try {
      const loaded = await loadDocument(root, ['linked-original.md'])
      expect(loaded.ok).toBe(false)
      if (loaded.ok) return
      expect(loaded.code).toBe(ErrorCode.HARDLINKED)
    } finally {
      await fsp.rm(second, { force: true })
      await fsp.rm(original, { force: true })
    }
  })

  it('refuses a directory where a document was due', async () => {
    const dir = join(sandbox, 'root', 'folder.md')
    await fsp.mkdir(dir, { recursive: true })
    try {
      const loaded = await loadDocument(root, ['folder.md'])
      expect(loaded.ok).toBe(false)
      if (loaded.ok) return
      expect(loaded.code).toBe(ErrorCode.NOT_REGULAR_FILE)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the mid-read check, driven directly', () => {
  /**
   * The end-to-end rig below has to win a race. This block does not, and it can reach the one
   * property the rig is structurally incapable of testing: that the comparison is **inequality,
   * never ordering** (§13.4). A rig whose clock only moves forward cannot tell `!==` from `>`.
   */
  const openHandle = async (name: string) => {
    const opened = await openFileForRead(root, [name])
    if (!opened.ok) throw new Error(`fixture open failed: ${opened.code}`)
    return opened.value
  }

  it('passes an untouched file through', async () => {
    const handle = await openHandle('notes.md')
    try {
      const result = await confirmUnchangedDuringRead(handle)
      expect(result.ok).toBe(true)
    } finally {
      await handle.file.close()
    }
  })

  it('refuses on SIZE ALONE, with the mtime restored to exactly what it was', async () => {
    /**
     * **This test was rewritten because the first version proved nothing.** It appended bytes and
     * asserted the refusal — but appending moves the size *and* the mtime, so the mtime half of
     * the check caught it and the size half was never exercised. Deleting the size comparison left
     * the whole suite green. The mutation sweep found it; reading the test did not.
     *
     * So the mtime is put back. An integer number of seconds is used because `utimes` takes a
     * float and nanoseconds do not survive a double — at a whole second the nanosecond field is
     * zero and the value is restored exactly, which the assertion below proves rather than assumes.
     *
     * The real-world case is a writer that preserves timestamps: `mv`, `rsync -t`, `cp -p`, an
     * editor restoring metadata. Under a size-blind check the file is a different length and the
     * app calls it unchanged.
     */
    const path = join(sandbox, 'root', 'resized.md')
    await fsp.writeFile(path, 'exactly this\n')
    const fixed = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000)
    await fsp.utimes(path, fixed, fixed)

    const handle = await openHandle('resized.md')
    try {
      await fsp.appendFile(path, 'and then some more\n')
      await fsp.utimes(path, fixed, fixed)

      const after = await handle.file.stat({ bigint: true })
      expect(after.mtimeNs, 'the mtime must be byte-identical or the size half is not isolated')
        .toBe(handle.mtimeNs)
      expect(Number(after.size)).not.toBe(handle.size)

      const result = await confirmUnchangedDuringRead(handle)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe(ErrorCode.CHANGED_DURING_READ)
    } finally {
      await handle.file.close()
      await fsp.rm(path, { force: true })
    }
  })

  it('refuses when the mtime moved BACKWARDS at an unchanged size', async () => {
    /**
     * The §13.4 rule, isolated: *"Timestamps are advisory, compared with `!=`, never ordered."*
     *
     * This is not a hypothetical. `mv` preserves mtime, so a file replaced by an agent's
     * `mv draft.md notes.md` carries an *older* stamp than the one we opened. NTP correction and
     * waking from sleep both step the clock backwards too. Under a `>` comparison every one of
     * those reads as "nothing happened" — and the size is identical here, so the size check does
     * not cover for it.
     *
     * An implementation using `>` passes every other test in this file and fails only this one.
     */
    const path = join(sandbox, 'root', 'backwards.md')
    await fsp.writeFile(path, 'exactly this many bytes\n')
    const handle = await openHandle('backwards.md')
    try {
      const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      await fsp.utimes(path, longAgo, longAgo)

      const after = await handle.file.stat({ bigint: true })
      expect(Number(after.size), 'the size must be unchanged or this proves nothing')
        .toBe(handle.size)
      expect(after.mtimeNs < handle.mtimeNs, 'the clock must have gone backwards').toBe(true)

      const result = await confirmUnchangedDuringRead(handle)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe(ErrorCode.CHANGED_DURING_READ)
    } finally {
      await handle.file.close()
      await fsp.rm(path, { force: true })
    }
  })
})

/**
 * §12's gate as a **rule**, independent of either call site.
 *
 * Written against the sentence in the spec — *"a `.md` file is editable only if its bytes decode as
 * valid UTF-8 with no NUL"* — and not against the implementation, because the defect this closes
 * was invisible to anyone reading the implementation. The old check did exactly what its name and
 * its comment said; it just answered a different question from the one the rule asks.
 */
describe('§12 editability — the rule, clause by clause', () => {
  it('accepts ordinary text, and everything valid that looks alarming', () => {
    for (const [name, bytes] of [
      ['plain ASCII', Buffer.from('# Title\n\nBody.\n')],
      ['empty', Buffer.alloc(0)],
      ['CRLF', Buffer.from('a\r\nb\r\n')],
      ['a BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x61])],
      ['multi-byte', Buffer.from('日本語 — 🌱')],
      ['no trailing newline', Buffer.from('a')],
      ['0x7F DEL, which is legal', Buffer.from([0x7f])],
    ] as const) {
      expect(editabilityRefusal(bytes), name).toBeNull()
    }
  })

  it('refuses a NUL wherever it sits', () => {
    for (const [name, bytes] of [
      ['leading', Buffer.from([0x00, 0x61])],
      ['interior', Buffer.from([0x61, 0x00, 0x62])],
      ['trailing', Buffer.from([0x61, 0x00])],
      ['alone', Buffer.from([0x00])],
    ] as const) {
      expect(editabilityRefusal(bytes), name).not.toBeNull()
    }
  })

  it('refuses bytes that do not survive a round trip through a string', () => {
    for (const [name, bytes] of [
      ['a lone 0xFF, which is legal in no encoding', Buffer.from([0xff])],
      ['a truncated three-byte sequence', Buffer.from([0xe2, 0x82])],
      ['a continuation byte with nothing to continue', Buffer.from([0x80])],
      ['a lone surrogate in WTF-8', Buffer.from([0xed, 0xa0, 0x80])],
    ] as const) {
      expect(editabilityRefusal(bytes), name).not.toBeNull()
    }
  })

  it('refuses an overlong NUL — the case each clause misses and the other catches', () => {
    /**
     * `C0 80` is the classic overlong encoding of U+0000: a NUL smuggled in a form that
     * **`bytes.includes(0)` cannot see**, because no byte in it is zero. It is caught by the other
     * clause, since overlong sequences are invalid UTF-8.
     *
     * This is the test that says why the rule has two clauses rather than one. Each covers a case
     * the other is blind to, which is also why implementing one of them looked complete.
     */
    const overlong = Buffer.from([0xc0, 0x80])
    expect(overlong.includes(0), 'the fixture must contain no literal NUL byte').toBe(false)
    expect(editabilityRefusal(overlong)).not.toBeNull()
  })

  it('gives a reason that names which clause failed', () => {
    // The refusal reaches a pane that has to explain itself to the operator. "Not editable" is not an
    // explanation; which of the two things went wrong is.
    expect(editabilityRefusal(Buffer.from([0x00]))).toMatch(/NUL/)
    expect(editabilityRefusal(Buffer.from([0xff]))).toMatch(/UTF-8/)
  })
})

describe('a torn read is a failure, never a baseline', () => {
  it('refuses when the file is rewritten IN PLACE while it is being read', async () => {
    /**
     * The failure this closes is silent and the consequence is worse than a failed save.
     *
     * `readAllBytes` issues a sequence of `read(2)` calls against one descriptor. An agent using a
     * plain `open`/`write` — which is what a script that has never heard of atomic writes does —
     * can land between two of them, and the buffer becomes a mix of the old file and the new one.
     * Right length, decodes fine, nothing above notices.
     *
     * Hash that and the baseline describes a document that has never existed on disk. At save time
     * a conflict fires *correctly*, and then §13.5's two-pane "mine" side shows the user a document
     * half of which they never wrote — and Keep Mine writes it over the real file. The control
     * works and the data is still wrong.
     *
     * The rig: a file large enough that the read cannot complete in one syscall, rewritten in place
     * from a concurrent loop. Driven through the real filesystem because the whole property is
     * about what the kernel does between two reads.
     */
    const churn = join(sandbox, 'root', 'churn.md')
    const size = 8 * 1024 * 1024 > MAX_EDITABLE_BYTES ? MAX_EDITABLE_BYTES : 8 * 1024 * 1024
    await fsp.writeFile(churn, Buffer.alloc(size, 0x61))

    let stop = false
    const rewriter = (async () => {
      let fill = 0x62
      while (!stop) {
        // Open WITHOUT truncation and write over the top: in-place, same inode, same length.
        const handle = await fsp.open(churn, 'r+')
        try {
          await handle.write(Buffer.alloc(size, fill), 0, size, 0)
        } finally {
          await handle.close()
        }
        fill = fill === 0x62 ? 0x63 : 0x62
      }
    })()

    const codes = new Set<string>()
    try {
      for (let attempt = 0; attempt < 40; attempt++) {
        const loaded = await loadDocument(root, ['churn.md'])
        codes.add(loaded.ok ? 'ok' : loaded.code)
      }
    } finally {
      stop = true
      await rewriter
      await fsp.rm(churn, { force: true })
    }

    /**
     * The assertion is deliberately one-sided. A load that completes cleanly between two rewrites
     * is a legitimate success, so "every attempt failed" is not the property and asserting it would
     * make the test flaky in the direction that hides a regression. What must hold is that when the
     * collision DOES happen it is reported, and that it is never reported as anything else.
     */
    expect([...codes].sort()).not.toContain(ErrorCode.SHORT_READ)
    expect(
      codes.has(ErrorCode.CHANGED_DURING_READ),
      `40 loads against a file being rewritten in place produced only ${[...codes].join(', ')} — ` +
      'if this is flaky the rig is too slow, not the control too strict',
    ).toBe(true)
  })
})
