import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { IndexStore } from '../../src/core/index-store'
import { indexRoot } from '../../src/core/indexer'
import { registerRoot } from '../../src/core/fs/registration'
import type { RegisteredRoot } from '../../src/core/fs/containment'
import { bigintPathsIn, millisecondsFrom, toWireEntry } from '../../src/contract/encode'
import { createTokenMinter } from '../../src/core/entity-token'

/**
 * A real minter, not a stub returning `''`.
 *
 * The subject of this file is what does and does not reach the wire, and a stub token would make
 * the "identity is absent" assertions below vacuous for the one field that is *derived* from
 * identity. With a real minter the digest is real, and the test can assert that the inode is not
 * recoverable from it.
 */
const minter = createTokenMinter()
const mint = minter.mint

/**
 * The BigInt boundary — the finding P1 recorded as a test rather than a comment, paid here.
 *
 * These run against a REAL indexed tree in a temp sandbox rather than hand-built objects, because
 * the failure being guarded is "a real row reached a real handler", and a hand-built row is exactly
 * the fixture that would have been written to match the assumption. Same reasoning as the
 * adversarial corpus: prove it against the thing that actually occurs.
 */

let sandbox: string
let root: RegisteredRoot
let store: IndexStore

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-wire-'))
  const rootPath = join(sandbox, 'root')
  await fsp.mkdir(join(rootPath, 'nested'), { recursive: true })
  await fsp.writeFile(join(rootPath, 'notes.md'), '# Notes\n\nbody\n')
  await fsp.writeFile(join(rootPath, 'image.png'), 'not markdown')
  await fsp.writeFile(join(rootPath, 'nested', 'deep.md'), '# Deep\n')

  const registered = await registerRoot('soil', rootPath)
  if (!registered.ok) throw new Error(`registration failed: ${registered.code}`)
  root = registered.value

  store = new IndexStore()
  await indexRoot(root, store)
})

afterAll(async () => {
  // The same hard guard every temp teardown in this repo carries. `rm -r` on a mis-set variable is
  // the one mistake in a test suite that reaches outside the test suite.
  const tempBase = process.env['TMPDIR'] ?? tmpdir()
  const ours =
    typeof sandbox === 'string' &&
    sandbox.length > tempBase.length &&
    sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-wire-')
  if (!ours) throw new Error(`refusing to recursively delete: ${String(sandbox)}`)
  await fsp.rm(sandbox, { recursive: true, force: true })
})

describe('the index row that P1 proved unserialisable', () => {
  it('still throws when stringified directly — the defect is real, not historical', () => {
    const entry = store.get('soil', ['notes.md'])
    expect(entry).toBeDefined()
    expect(() => JSON.stringify(entry)).toThrow(TypeError)
  })

  it('serialises once it has crossed the boundary', () => {
    const entry = store.get('soil', ['notes.md'])
    if (entry === undefined) throw new Error('fixture missing')
    expect(() => JSON.stringify(toWireEntry(entry, mint))).not.toThrow()
  })
})

describe('no BigInt reaches the wire, structurally', () => {
  it('every real row in the index converts clean', () => {
    const offenders: string[] = []
    for (const entry of store.all()) {
      const paths = bigintPathsIn(toWireEntry(entry, mint))
      if (paths.length > 0) offenders.push(`${entry.segments.join('/')}: ${paths.join(', ')}`)
    }
    expect(offenders, 'a BigInt survived the boundary').toEqual([])
  })

  it('the whole response envelope round-trips through JSON', () => {
    // The realistic shape: a list response, not a single row. A per-row check would miss a BigInt
    // that only appears in an envelope field.
    const body = { ok: true as const, data: [...store.all()].map(e => toWireEntry(e, mint)) }
    expect(bigintPathsIn(body)).toEqual([])
    const parsed = JSON.parse(JSON.stringify(body)) as typeof body
    expect(parsed.data.length).toBe(store.size)
  })

  it('identity is ABSENT from the wire, not merely converted', () => {
    // The stronger half of the decision. A stringified inode would serialise fine and still be
    // wrong: it becomes a handle the client starts depending on, and an internal identity that
    // leaks into logs. Not sending it is the control.
    const entry = store.get('soil', ['notes.md'])
    if (entry === undefined) throw new Error('fixture missing')
    const wire = toWireEntry(entry, mint) as unknown as Record<string, unknown>
    expect(Object.keys(wire)).not.toContain('dev')
    expect(Object.keys(wire)).not.toContain('ino')
    expect(Object.keys(wire)).not.toContain('mtimeNs')
    // And nothing carries file content — spec §5's budget must not be reintroduced by the contract.
    for (const forbidden of ['content', 'raw', 'head', 'preview', 'body']) {
      expect(Object.keys(wire)).not.toContain(forbidden)
    }

    /**
     * §13.8's token is the one field derived from the identity this decision excludes, so it gets
     * checked rather than trusted: the digest must not carry the numbers it was computed from.
     *
     * Without this, a "simplification" of the token to `${dev}-${ino}` — which is a perfectly
     * reasonable-looking change detector — would put the inode straight onto the wire and every
     * other assertion in this test would still pass, because it would arrive under a field name
     * none of them look for.
     */
    expect(typeof wire['token']).toBe('string')
    expect(wire['token']).not.toContain(String(entry.ino))
    expect(wire['token']).not.toContain(String(entry.dev))
  })
})

describe('bigintPathsIn — the guard itself must fire', () => {
  // the security review's principle: a control that has never rejected anything is assumed non-functional.
  it('finds a BigInt at the top level', () => {
    expect(bigintPathsIn(1n)).toEqual(['$'])
  })

  it('finds one nested in an object', () => {
    expect(bigintPathsIn({ a: { b: 2n } })).toEqual(['$.a.b'])
  })

  it('finds one nested in an array, and names its index', () => {
    expect(bigintPathsIn({ rows: [{ ino: 5n }] })).toEqual(['$.rows[0].ino'])
  })

  it('finds every one, not just the first', () => {
    expect(bigintPathsIn({ a: 1n, b: [2n, { c: 3n }] })).toHaveLength(3)
  })

  it('passes clean data, including null and nested empties', () => {
    expect(bigintPathsIn({ a: null, b: [], c: {}, d: 'x', e: 1, f: false })).toEqual([])
  })
})

describe('millisecondsFrom', () => {
  it('divides in BigInt space rather than through a float', () => {
    // Number(ns) / 1e6 rounds at the top of the range and returns a plausible wrong answer.
    const ns = 1_754_524_800_123_456_789n
    expect(millisecondsFrom(ns)).toBe(1_754_524_800_123)
    expect(Number.isSafeInteger(millisecondsFrom(ns))).toBe(true)
  })

  it('truncates sub-millisecond precision, which is the documented trade', () => {
    expect(millisecondsFrom(1_999_999n)).toBe(1)
  })

  it('handles the zero a recorded symlink carries', () => {
    expect(millisecondsFrom(0n)).toBe(0)
  })

  it('refuses to invent a plausible wrong time when the value cannot be represented', () => {
    // Not expected to fire for four orders of magnitude. Present because "not expected to fire" is
    // what was said about every silent failure this build has produced.
    expect(millisecondsFrom(2n ** 80n)).toBe(0)
  })

  it('matches the real mtime of a real file', () => {
    const entry = store.get('soil', ['notes.md'])
    if (entry === undefined) throw new Error('fixture missing')
    const wire = toWireEntry(entry, mint)
    expect(wire.modifiedMs).toBe(Number(entry.mtimeNs / 1_000_000n))
    // Sanity: a file written seconds ago is within a day of now, so the units are not out by 1e3.
    expect(Math.abs(Date.now() - wire.modifiedMs)).toBeLessThan(86_400_000)
  })
})

describe('the wire row carries what a screen actually needs', () => {
  it('preserves title, kind and the markdown predicate', () => {
    const md = store.get('soil', ['notes.md'])
    const png = store.get('soil', ['image.png'])
    if (md === undefined || png === undefined) throw new Error('fixture missing')
    expect(toWireEntry(md, mint).title).toBe('Notes')
    expect(toWireEntry(md, mint).isMarkdown).toBe(true)
    expect(toWireEntry(png, mint).isMarkdown).toBe(false)
    expect(toWireEntry(png, mint).title).toBe('image')
  })

  it('addresses a file by (rootId, segments) and never by an absolute path', () => {
    // Spec §6: "The API never accepts an absolute path." The response half of that rule is that it
    // never HANDS OUT one either — otherwise the client learns the shape of the user's disk and the
    // next builder has an absolute path to send back.
    const deep = store.get('soil', ['nested', 'deep.md'])
    if (deep === undefined) throw new Error('fixture missing')
    const wire = toWireEntry(deep, mint)
    expect(wire.rootId).toBe('soil')
    expect(wire.segments).toEqual(['nested', 'deep.md'])
    expect(JSON.stringify(wire)).not.toContain(sandbox)
    expect(JSON.stringify(wire)).not.toContain(tmpdir())
  })
})

/**
 * THE WIRE FIELD LIST, pinned as a WHOLE rather than field by field.
 *
 * Dropping `kind`, `size` or `contentUnavailable` from `toWireEntry` left the suite green — only
 * `name` was caught, and by a test in another file entirely. Seventeen tests here and the shape
 * itself was never asserted.
 *
 * This module's own header explains why that matters: the verbosity IS the control. Listing fields
 * explicitly is what stops the index's internals — `ino`, `mtimeNs`, and whatever it gains next —
 * reaching the client by default. A test that checks fields one at a time cannot notice a field
 * going missing, and it is the *missing* direction that turns a working screen into an empty one.
 */
describe('the wire entry carries exactly the declared fields', () => {
  it('has every field, and no more', () => {
    const entry = toWireEntry({
      rootId: 'soil', segments: ['notes', 'a.md'], name: 'a.md', kind: 'file',
      title: 'A', size: 42, mtimeNs: 123n, dev: 3n, ino: 7n, contentUnavailable: false,
      lane: null, archived: false,
    } as unknown as Parameters<typeof toWireEntry>[0], mint)

    expect(
      Object.keys(entry).sort(),
      'a field silently dropped here is a screen that renders without it',
    ).toEqual(
      [
        'rootId', 'segments', 'name', 'kind', 'title', 'size',
        'modifiedMs', 'isMarkdown', 'contentUnavailable', 'token',
      ].sort(),
    )
  })

  it('never leaks the index internals the header names', () => {
    const entry = toWireEntry({
      rootId: 'soil', segments: ['a.md'], name: 'a.md', kind: 'file',
      title: 'A', size: 1, mtimeNs: 99n, dev: 3n, ino: 5n, contentUnavailable: false,
      lane: null, archived: false,
    } as unknown as Parameters<typeof toWireEntry>[0], mint)

    for (const secret of ['ino', 'mtimeNs']) {
      expect(Object.keys(entry), `${secret} is the index's business, not the client's`)
        .not.toContain(secret)
    }
  })
})
