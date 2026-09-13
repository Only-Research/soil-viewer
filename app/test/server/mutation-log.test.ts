import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors'
import { openAppendLog } from '../../src/core/fs/append-log'
import { registerRoot } from '../../src/core/fs/registration'
import { createMutationLog, serialiseRecord, type MutationRecord } from '../../src/server/mutation-log'
import { createToken } from '../../src/server/guards'

/**
 * Spec §7's mutation log, and spec §20's named acceptance test: **assert the token's value appears
 * nowhere in the mutation log after a mutation.**
 *
 * This is also the first file write in the build, so the containment rules around it get the same
 * treatment as the read path did in P1 — proven against a real disk, not reasoned about.
 */

let sandbox: string

/** A cap no test here can reach, for the tests that are not about the cap. */
const UNCAPPED = { maxBytes: Number.MAX_SAFE_INTEGER }

const RECORD: MutationRecord = {
  timestamp: '2026-08-07T03:00:00.000Z',
  method: 'POST',
  route: 'tree.children',
  rootId: 'soil',
  relativePath: '02-projects/notes.md',
  sourceAddress: '127.0.0.1',
  forwardedFor: null,
  tailscaleUserLogin: 'hallberg@example.com',
  origin: 'http://localhost:8765',
  outcome: 'ok',
  code: null,
}

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-log-'))
})

afterEach(async () => {
  const tempBase = process.env['TMPDIR'] ?? tmpdir()
  const ours =
    typeof sandbox === 'string' &&
    sandbox.length > tempBase.length &&
    sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-log-')
  if (!ours) throw new Error(`refusing to recursively delete: ${String(sandbox)}`)
  await fsp.rm(sandbox, { recursive: true, force: true })
})

describe('the log lives outside every registered folder', () => {
  it('refuses a path INSIDE a registered root', async () => {
    const rootPath = join(sandbox, 'soil')
    await fsp.mkdir(rootPath, { recursive: true })
    const registered = await registerRoot('soil', rootPath)
    expect(registered.ok).toBe(true)
    if (!registered.ok) return

    const result = await openAppendLog(join(rootPath, 'mutations.log'), [registered.value], UNCAPPED)
    expect(result.ok, 'a log inside the tree is a write path into the operator files').toBe(false)
  })

  it('refuses a path that CONTAINS a registered root', async () => {
    // The other direction: a log at the parent puts the file in a directory the walker enumerates.
    const rootPath = join(sandbox, 'soil')
    await fsp.mkdir(rootPath, { recursive: true })
    const registered = await registerRoot('soil', rootPath)
    if (!registered.ok) throw new Error('registration failed')

    const result = await openAppendLog(sandbox, [registered.value], UNCAPPED)
    expect(result.ok).toBe(false)
  })

  it('does NOT refuse a sibling whose name merely shares a prefix', async () => {
    // Whole-segment comparison, spec §5. A raw prefix test would treat `soil-logs` as inside
    // `soil` — the /soil/notes vs /soil/notes-old bug, in the directory the log itself lives in.
    const rootPath = join(sandbox, 'soil')
    await fsp.mkdir(rootPath, { recursive: true })
    const registered = await registerRoot('soil', rootPath)
    if (!registered.ok) throw new Error('registration failed')

    const siblingDir = join(sandbox, 'soil-logs')
    await fsp.mkdir(siblingDir, { recursive: true })
    const result = await openAppendLog(join(siblingDir, 'mutations.log'), [registered.value], UNCAPPED)
    expect(result.ok, 'soil-logs is not inside soil').toBe(true)
  })

  it('refuses a relative path', async () => {
    expect((await openAppendLog('mutations.log', [], UNCAPPED)).ok).toBe(false)
  })
})

describe('the file itself', () => {
  it('is created owner-read/write only, at creation rather than after', async () => {
    const path = join(sandbox, 'mutations.log')
    const log = await openAppendLog(path, [], UNCAPPED)
    expect(log.ok).toBe(true)
    if (!log.ok) return
    await log.value.append('x')

    const stat = await fsp.stat(path)
    expect(stat.mode & 0o777, 'the log records every path the operator opens').toBe(0o600)
  })

  it('appends rather than truncating, across reopens', async () => {
    const path = join(sandbox, 'mutations.log')
    const first = await openAppendLog(path, [], UNCAPPED)
    if (!first.ok) throw new Error('open failed')
    await first.value.append('one')

    const second = await openAppendLog(path, [], UNCAPPED)
    if (!second.ok) throw new Error('reopen failed')
    await second.value.append('two')

    const contents = await fsp.readFile(path, 'utf8')
    expect(contents).toBe('one\ntwo\n')
  })

  it('refuses a line containing a newline — a record must not span two lines', async () => {
    const log = await openAppendLog(join(sandbox, 'mutations.log'), [], UNCAPPED)
    if (!log.ok) throw new Error('open failed')
    expect((await log.value.append('a\nb')).ok).toBe(false)
    expect((await log.value.append('a\rb')).ok).toBe(false)
  })

  it('returns a failure rather than throwing when the write cannot happen', async () => {
    // Spec §7: "A failed log write fails the operation." The caller can only abort if it is told.
    const dir = join(sandbox, 'locked')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.chmod(dir, 0o500) // read+execute, no write
    try {
      const result = await openAppendLog(join(dir, 'mutations.log'), [], UNCAPPED)
      expect(result.ok).toBe(false)
    } finally {
      await fsp.chmod(dir, 0o700)
    }
  })
})

describe('THE TOKEN NEVER APPEARS — spec §20 acceptance test', () => {
  it('is absent from the log after recording a mutation', async () => {
    const token = createToken()
    const path = join(sandbox, 'mutations.log')
    const sink = await openAppendLog(path, [], UNCAPPED)
    if (!sink.ok) throw new Error('open failed')
    const log = createMutationLog(sink.value)

    const written = await log.record(RECORD)
    expect(written.ok).toBe(true)

    const contents = await fsp.readFile(path, 'utf8')
    expect(contents, 'the token must appear nowhere in the log').not.toContain(token)
    expect(contents.length, 'and the log must actually have recorded something').toBeGreaterThan(0)
  })

  it('cannot carry the token even if a caller tries — there is no field for it', () => {
    // The structural half. `record` takes named fields, never a headers object, so the token has no
    // container to arrive in. A redaction pass would have to know every name a secret travels
    // under; refusing the container is a property of the signature instead.
    const keys = Object.keys(RECORD)
    expect(keys).not.toContain('headers')
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('authorization')
    expect(keys.sort()).toEqual([
      'code', 'forwardedFor', 'method', 'origin', 'outcome', 'relativePath',
      'rootId', 'route', 'sourceAddress', 'tailscaleUserLogin', 'timestamp',
    ])
  })

  it('the absence assertion is not vacuous — a token IS findable when present', async () => {
    // If `toContain` could not find the token even when it is there, the test above proves nothing.
    const token = createToken()
    const path = join(sandbox, 'control.log')
    const sink = await openAppendLog(path, [], UNCAPPED)
    if (!sink.ok) throw new Error('open failed')
    await sink.value.append(`deliberately containing ${token}`)
    expect(await fsp.readFile(path, 'utf8')).toContain(token)
  })
})

describe('serialisation', () => {
  it('writes one JSON line carrying every field spec §7 enumerates', () => {
    const parsed = JSON.parse(serialiseRecord(RECORD)) as MutationRecord
    expect(parsed).toEqual(RECORD)
  })

  it('escapes a filename that tries to inject a second record', async () => {
    // A path can contain almost anything. A delimited format would let a comma or a newline in a
    // filename forge a record; JSON escapes both, and the writer refuses raw newlines besides.
    const hostile: MutationRecord = {
      ...RECORD,
      relativePath: 'evil\n{"outcome":"ok","route":"forged"}',
    }
    const line = serialiseRecord(hostile)
    expect(line.includes('\n'), 'the escape must survive serialisation').toBe(false)

    const path = join(sandbox, 'mutations.log')
    const sink = await openAppendLog(path, [], UNCAPPED)
    if (!sink.ok) throw new Error('open failed')
    expect((await sink.value.append(line)).ok).toBe(true)

    const lines = (await fsp.readFile(path, 'utf8')).split('\n').filter(l => l.length > 0)
    expect(lines, 'one hostile filename must still be exactly one record').toHaveLength(1)
    const parsed = JSON.parse(lines[0] ?? '') as MutationRecord
    expect(parsed.route, 'the forged route must not have taken effect').toBe('tree.children')
  })

  it('records a refusal with its code, and no message', () => {
    const refused: MutationRecord = { ...RECORD, outcome: 'refused', code: 'FORBIDDEN_ORIGIN' }
    const line = serialiseRecord(refused)
    expect(line).toContain('FORBIDDEN_ORIGIN')
    // Spec §6: no verbatim strings, no stack traces. The type has no field for either.
    expect(Object.keys(refused)).not.toContain('message')
    expect(Object.keys(refused)).not.toContain('stack')
  })
})

/**
 * **The size cap — nothing rotated, nothing deleted.** Found 2026-09-02: `session.start` needs no
 * token, so anything on the tailnet could drive this log at the limiter's ceiling — about a
 * gigabyte a day — until the volume was full and every request answered 500. The cap bounds the
 * disk. Refusing rather than rotating keeps every record, because a flood that could push old
 * records off the end is a flood that erases its own approach. The operator moves the file aside
 * and restarts; the app never touches it. Reasoning on `MAX_LOG_BYTES`.
 */
describe('the size cap', () => {
  it('refuses the write that would cross the cap, and the file does not grow', async () => {
    const path = join(sandbox, 'capped.log')
    const log = await openAppendLog(path, [], { maxBytes: 20 })
    if (!log.ok) throw new Error('open failed')
    expect((await log.value.append('123456789')).ok, 'ten bytes with the newline').toBe(true)
    expect((await log.value.append('123456789')).ok, 'twenty — exactly at the cap').toBe(true)
    const before = (await fsp.stat(path)).size

    const refused = await log.value.append('x')

    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe(ErrorCode.LOG_FULL)
    expect(refused.detail, 'names the file and what to do').toContain(path)
    expect(refused.detail).toContain('move it aside')
    expect((await fsp.stat(path)).size, 'the refused line did not land').toBe(before)
  })

  it('counts what was already on disk, not only what this process wrote', async () => {
    // A reopen after a restart must not start the count at zero.
    const path = join(sandbox, 'preexisting.log')
    await fsp.writeFile(path, 'a'.repeat(30))
    const log = await openAppendLog(path, [], { maxBytes: 32 })
    if (!log.ok) throw new Error('open failed')
    expect((await log.value.append('b')).ok, '32 bytes — at the cap').toBe(true)

    const refused = await log.value.append('c')

    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe(ErrorCode.LOG_FULL)
  })

  it('measures bytes, not characters', async () => {
    const path = join(sandbox, 'bytes.log')
    const log = await openAppendLog(path, [], { maxBytes: 4 })
    if (!log.ok) throw new Error('open failed')
    // Three characters plus a newline is four characters — under a cap of four counted that way.
    // Nine bytes plus a newline is ten.
    const refused = await log.value.append('☕☕☕')
    expect(refused.ok, 'counted in bytes, this is over').toBe(false)
  })

  it('CONTROL: under the cap, appends are unaffected', async () => {
    const path = join(sandbox, 'roomy.log')
    const log = await openAppendLog(path, [], { maxBytes: 1024 })
    if (!log.ok) throw new Error('open failed')
    for (let i = 0; i < 10; i++) expect((await log.value.append(`line ${i}`)).ok).toBe(true)
    expect((await fsp.readFile(path, 'utf8')).split('\n').filter(l => l.length > 0)).toHaveLength(10)
  })
})
