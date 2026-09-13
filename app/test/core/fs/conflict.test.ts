import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { type RegisteredRoot } from '../../../src/core/fs/containment'
import {
  PATH_MAX_BYTES,
  conflictNameFor,
  conflictStamp,
  writeConflictArtifact,
} from '../../../src/core/fs/conflict'
import { NAME_MAX_BYTES } from '../../../src/core/fs/write'
import {
  CONFLICT_SUFFIX_ALPHABET,
  isConflictArtifact,
  isMarkdown,
} from '../../../src/core/grammar'
import { registerRoot } from '../../../src/core/fs/registration'

/**
 * The rescue path. Everything here is about one sentence in §13.5: *"An edit is never discarded
 * because its rescue file failed."*
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree, created and removed here.
 */
let sandbox: string
let rootPath: string
let root: RegisteredRoot

/** A fixed second, so the collision behaviour is deterministic rather than lucky. */
const FIXED = new Date(2026, 7, 8, 14, 32, 5)
const fixedClock = () => FIXED

const MY_EDIT = Buffer.from('# Notes\n\nthe edit that must not be lost\n')

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p4-conflict-'))
  rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })
  const registered = await registerRoot('scratch', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value
})

afterAll(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const conflictsIn = async (dir: string): Promise<string[]> =>
  (await fsp.readdir(dir)).filter(isConflictArtifact)

describe('the rescue file', () => {
  it('lands beside the document, carrying the edit verbatim', async () => {
    await fsp.writeFile(join(rootPath, 'notes.md'), '# theirs\n')

    const written = await writeConflictArtifact(root, ['notes.md'], MY_EDIT, fixedClock)
    expect(written.ok).toBe(true)
    if (!written.ok) return

    const landed = join(rootPath, ...written.value.segments)
    expect((await fsp.readFile(landed)).equals(MY_EDIT)).toBe(true)
    expect(written.value.segments.slice(0, -1)).toEqual([])
  })

  it('is named the way §13.5 specifies, with the seconds in it', async () => {
    await fsp.writeFile(join(rootPath, 'stamped.md'), '# theirs\n')
    const written = await writeConflictArtifact(root, ['stamped.md'], MY_EDIT, fixedClock)
    expect(written.ok).toBe(true)
    if (!written.ok) return

    expect(written.value.fileName).toMatch(
      /^stamped\.conflict-20260808-143205-[A-Z2-7]{4}\.md$/,
    )
  })

  it('is recognised by the grammar that has to exclude it — C5', async () => {
    /**
     * The generator and the detector must agree, and P1 wrote the instruction in capitals: an
     * artifact the grammar fails to recognise becomes a task card on the board **that can never be
     * removed**, because nothing in this app deletes. That is C5, and it is the specific failure
     * §13.5 was rewritten to eliminate.
     *
     * This is the test that fails if someone later picks a different base32 variant — Crockford's,
     * say, which includes digits this alphabet excludes.
     */
    await fsp.writeFile(join(rootPath, 'grammar.md'), '# theirs\n')
    const written = await writeConflictArtifact(root, ['grammar.md'], MY_EDIT, fixedClock)
    expect(written.ok).toBe(true)
    if (!written.ok) return

    expect(isConflictArtifact(written.value.fileName)).toBe(true)
  })

  it('is still a markdown file, so the app that made it can open it', async () => {
    // The suffix goes BEFORE the extension for exactly this reason. `.md.conflict-…` would fall
    // outside isMarkdown() and produce a rescue file the editor refuses to load.
    await fsp.writeFile(join(rootPath, 'openable.md'), '# theirs\n')
    const written = await writeConflictArtifact(root, ['openable.md'], MY_EDIT, fixedClock)
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(isMarkdown(written.value.fileName)).toBe(true)
  })

  it('draws its suffix only from the grammar\'s alphabet', async () => {
    await fsp.writeFile(join(rootPath, 'alphabet.md'), '# theirs\n')
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const written = await writeConflictArtifact(root, ['alphabet.md'], MY_EDIT, fixedClock)
      expect(written.ok).toBe(true)
      if (!written.ok) return
      const suffix = /-([A-Z0-9]{4})\.md$/i.exec(written.value.fileName)?.[1] ?? ''
      for (const character of suffix) {
        expect(CONFLICT_SUFFIX_ALPHABET, `unexpected character ${character}`).toContain(character)
      }
      seen.add(suffix)
    }
    expect(seen.size, 'forty draws should not all be the same suffix').toBeGreaterThan(1)
  })
})

describe('two conflicts in the same second — the v1 clobber', () => {
  it('keeps BOTH edits', async () => {
    /**
     * v1 used `HHMM` granularity, and two autosaves a second apart produced the same name — so the
     * second conflict **overwrote the first**, destroying an edit inside the mechanism built to
     * rescue edits.
     *
     * The clock here is frozen, so both artifacts are generated for the identical second. They
     * survive because the random suffix differs and because the create is exclusive: a collision
     * becomes a retry, never an overwrite.
     */
    await fsp.writeFile(join(rootPath, 'twice.md'), '# theirs\n')
    const first = Buffer.from('# the first rescued edit, which must survive\n')
    const second = Buffer.from('# the second rescued edit, also required\n')

    const a = await writeConflictArtifact(root, ['twice.md'], first, fixedClock)
    const b = await writeConflictArtifact(root, ['twice.md'], second, fixedClock)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(a.value.fileName, 'the two names must differ').not.toBe(b.value.fileName)
    expect(await fsp.readFile(join(rootPath, ...a.value.segments), 'utf8')).toBe(first.toString())
    expect(await fsp.readFile(join(rootPath, ...b.value.segments), 'utf8')).toBe(second.toString())
  })

  it('a genuine NAME COLLISION retries instead of overwriting — and this is the real test', async () => {
    /**
     * **The two tests around this one do not prove the exclusive create, and the mutation sweep
     * said so.** Removing `O_EXCL` left the entire file green, because four random base32
     * characters collide about once in a million attempts — so a test using the real generator
     * never reaches the collision path at all. It proves the names differ, which is a property of
     * the random number generator, not of this module.
     *
     * So the suffix is forced. The first artifact takes `AAAA`. The second asks for `AAAA` too,
     * must be refused by the kernel, and must come back with `BBBB`.
     *
     * With a truncating create instead of an exclusive one, the second write lands on top of the
     * first: one file, the first edit gone, and no error anywhere. That is v1's clobber exactly,
     * and it is what the assertions below refuse.
     */
    await fsp.writeFile(join(rootPath, 'collide.md'), '# theirs\n')
    const first = Buffer.from('# the FIRST rescued edit, which must survive intact\n')
    const second = Buffer.from('# the SECOND rescued edit, which must not clobber\n')

    const forced = (values: string[]): (() => string) => {
      let index = 0
      return () => values[Math.min(index++, values.length - 1)] as string
    }

    const a = await writeConflictArtifact(
      root, ['collide.md'], first, fixedClock, forced(['AAAA']),
    )
    const b = await writeConflictArtifact(
      root, ['collide.md'], second, fixedClock, forced(['AAAA', 'BBBB']),
    )
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(a.value.fileName).toBe('collide.conflict-20260808-143205-AAAA.md')
    expect(b.value.fileName, 'the collision must have forced a retry')
      .toBe('collide.conflict-20260808-143205-BBBB.md')

    // The point of the whole module: the first edit is still there.
    expect(await fsp.readFile(join(rootPath, ...a.value.segments), 'utf8')).toBe(first.toString())
    expect(await fsp.readFile(join(rootPath, ...b.value.segments), 'utf8')).toBe(second.toString())
  })

  it('gives up rather than looping when every name is taken', async () => {
    // A generator stuck on one value must terminate with a reported failure, not spin. The edit is
    // still safe — the caller keeps the buffer — but it must be TOLD.
    await fsp.writeFile(join(rootPath, 'stuck.md'), '# theirs\n')
    const always = () => 'ZZZZ'

    const first = await writeConflictArtifact(root, ['stuck.md'], MY_EDIT, fixedClock, always)
    expect(first.ok).toBe(true)

    const second = await writeConflictArtifact(root, ['stuck.md'], MY_EDIT, fixedClock, always)
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe(ErrorCode.IO_FAILED)
    expect(second.detail).toContain('collided')
  })

  it('keeps twenty of them, all distinct, all intact', async () => {
    await fsp.writeFile(join(rootPath, 'many.md'), '# theirs\n')
    const bodies = Array.from({ length: 20 }, (_, i) => `# rescued edit number ${i}\n`)

    const landed: string[] = []
    for (const body of bodies) {
      const written = await writeConflictArtifact(root, ['many.md'], Buffer.from(body), fixedClock)
      expect(written.ok).toBe(true)
      if (written.ok) landed.push(join(rootPath, ...written.value.segments))
    }

    expect(new Set(landed).size).toBe(20)
    for (const [index, path] of landed.entries()) {
      expect(await fsp.readFile(path, 'utf8')).toBe(bodies[index])
    }
  })
})

describe('a conflict never spawns a conflict child — §13.5', () => {
  it('refuses to write a conflict beside a conflict artifact', async () => {
    /**
     * Without this the names chain — each one longer than the last — marching toward the
     * `NAME_MAX` overflow whose consequence in v1 was a failed write and a **lost edit**.
     */
    const name = 'notes.conflict-20260808-143205-ABCD.md'
    await fsp.writeFile(join(rootPath, name), '# an earlier rescue\n')

    const written = await writeConflictArtifact(root, [name], MY_EDIT, fixedClock)
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.code).toBe(ErrorCode.NOT_MARKDOWN)
  })
})

describe('names are validated in BYTES before anything is written — §13.5', () => {
  it('trims a long base so the name fits NAME_MAX', () => {
    // Characters are the wrong unit: each em dash is three bytes, so this name is comfortably
    // under 255 characters and comfortably over 255 bytes.
    const wide = '—'.repeat(100) + '.md'
    expect(wide.length).toBeLessThan(NAME_MAX_BYTES)
    expect(Buffer.byteLength(wide, 'utf8')).toBeGreaterThan(NAME_MAX_BYTES)

    const named = conflictNameFor(wide, FIXED, 'ABCD')
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(Buffer.byteLength(named.value, 'utf8')).toBeLessThanOrEqual(NAME_MAX_BYTES)
  })

  it('keeps the stamp and suffix intact when it trims, and stays recognisable', () => {
    const named = conflictNameFor('x'.repeat(400) + '.md', FIXED, 'ABCD')
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(named.value.endsWith('.conflict-20260808-143205-ABCD.md')).toBe(true)
    expect(isConflictArtifact(named.value), 'a trimmed name must still be detected').toBe(true)
    expect(Buffer.byteLength(named.value, 'utf8')).toBeLessThanOrEqual(NAME_MAX_BYTES)
  })

  it('never leaves a partial UTF-8 sequence in the name', () => {
    const named = conflictNameFor('日'.repeat(200) + '.md', FIXED, 'ABCD')
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(named.value).not.toContain('�')
  })

  it('refuses a path that would exceed PATH_MAX rather than attempting the write', async () => {
    /**
     * The composed path, not just the name. A name that fits on its own can still overflow at the
     * bottom of a deep tree — and this refusal must arrive as a value, because a throw here is an
     * edit that never reaches its rescue file.
     */
    /**
     * The window this has to land in is narrow, and the first version of this test missed it: the
     * ORIGINAL file must be creatable — so its path is under PATH_MAX — while its conflict name,
     * which adds 30 bytes, is over. A fixture that is simply "very deep" cannot be created at all
     * and proves nothing.
     */
    const deep: string[] = []
    let built = rootPath
    while (Buffer.byteLength(built, 'utf8') < PATH_MAX_BYTES - 80) {
      const segment = 'nested-folder-with-a-long-name'
      deep.push(segment)
      built = join(built, segment)
      await fsp.mkdir(built, { recursive: true })
    }
    // Land the original a few bytes short of the cap.
    const room = PATH_MAX_BYTES - 10 - Buffer.byteLength(built, 'utf8') - 1
    const leaf = 'x'.repeat(Math.max(1, room - 3)) + '.md'
    const original = join(built, leaf)
    expect(Buffer.byteLength(original, 'utf8'), 'the fixture itself must be creatable')
      .toBeLessThan(PATH_MAX_BYTES)
    await fsp.writeFile(original, '# theirs\n')

    const written = await writeConflictArtifact(root, [...deep, leaf], MY_EDIT, fixedClock)
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.code).toBe(ErrorCode.NAME_TOO_LONG)
  })
})

describe('failures arrive as values, never as throws', () => {
  it('refuses a non-markdown source', async () => {
    await fsp.writeFile(join(rootPath, 'thing.txt'), 'not markdown\n')
    const written = await writeConflictArtifact(root, ['thing.txt'], MY_EDIT, fixedClock)
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.code).toBe(ErrorCode.NOT_MARKDOWN)
  })

  it('reports a vanished folder rather than throwing', async () => {
    const written = await writeConflictArtifact(
      root, ['no-such-folder', 'notes.md'], MY_EDIT, fixedClock,
    )
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.code).toBe(ErrorCode.PARENT_MISSING)
  })

  it('creates no conflict file when it refuses', async () => {
    const before = await conflictsIn(rootPath)
    await writeConflictArtifact(root, ['thing.txt'], MY_EDIT, fixedClock)
    expect(await conflictsIn(rootPath)).toEqual(before)
  })
})

describe('the timestamp', () => {
  it('is the clock it was given, to the second', () => {
    expect(conflictStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405')
  })

  it('pads every field, so the name is fixed-width and sorts', () => {
    // A name that is sometimes 14 characters and sometimes 15 breaks both the detection pattern
    // and any ordering a person does by eye.
    expect(conflictStamp(new Date(2026, 10, 30, 23, 59, 59))).toBe('20261130-235959')
    expect(conflictStamp(new Date(2026, 0, 2, 3, 4, 5))).toHaveLength(15)
  })
})
