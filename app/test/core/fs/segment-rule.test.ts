import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import type { RegisteredRoot } from '../../../src/core/fs/containment'
import { walkAndVerify } from '../../../src/core/fs/containment'
import { segmentFault } from '../../../src/core/paths'
import { createRootRegistry } from '../../../src/server/root-registry'

/**
 * **C1 — A PATH SEGMENT MAY NOT CONTAIN A SEPARATOR.**
 *
 * the security review's P7 review, 2026-08-09, demonstrated this live; re-run before acting, per the
 * standing procedure. A single array element carrying `/` collapses two path components into one
 * `lstat`, and `lstat` follows every component except the last — so the symlink in the middle is
 * never seen, and `walkAndVerify`'s central guarantee (*"lstats every segment from the root down
 * and refuses any symlinked segment"*) is not walked. Containment still passes, because the
 * composed string genuinely is under the root.
 *
 * The measured before-state, from the re-run:
 *
 *     REAL TWO-SEGMENT:   {"ok":false,"code":"PATH_SYMLINK","detail":"symlinked segment at depth 1"}
 *     REAL JOINED-SEGMENT: ok= true kind=file
 *     BYTES THAT WOULD BE SERVED: SECRET-BYTES
 *
 * The JSON routes were never exposed — `contract/validate.ts` has refused a separator in a segment
 * since P2. The §9 byte endpoint parsed its path out of a query string and had **no** validator at
 * all. That is the finding: not two validators disagreeing, which this codebase already guards
 * against, but a caller with none. So the rule now lives in Core and runs at the chokepoint every
 * read and write passes through, rather than at each route that remembers to ask.
 */

const plant = async (): Promise<RegisteredRoot> => {
  // `realpath`, because macOS `tmpdir()` is `/var/…` and `/var` is a symlink to `/private/var` —
  // registration refuses a symlinked root, so the fixture would fail before proving anything.
  const area = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'c1-')))
  const rootPath = join(area, 'registered')
  await fsp.mkdir(rootPath, { recursive: true })
  await fsp.mkdir(join(area, 'outside'), { recursive: true })
  await fsp.writeFile(join(area, 'outside', 'secret.png'), 'SECRET-BYTES')
  /**
   * The symlink sits **inside** the registered root and points out of it. §1's threat model makes
   * this the ordinary case rather than an exotic one — *"every markdown file in this tree was
   * written by an agent"* — and these records describe the operator registering their home directory as
   * routine. A home directory contains symlinks.
   */
  await fsp.symlink(join(area, 'outside'), join(rootPath, 'link'))

  const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('r', rootPath)
  if (!registered.ok) throw new Error(`fixture failed: ${registered.code}`)
  return registered.value
}

describe('C1 — one array element is one path segment', () => {
  it('CONTROL: two honest segments are refused at the symlink', async () => {
    const result = await walkAndVerify(await plant(), ['link', 'secret.png'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ErrorCode.PATH_SYMLINK)
  })

  it('refuses the same path smuggled into ONE segment', async () => {
    const result = await walkAndVerify(await plant(), ['link/secret.png'])
    expect(result.ok, 'this returned ok and read bytes from outside the root').toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ErrorCode.PATH_TRAVERSAL)
  })

  it('refuses a backslash too, which a mounted SMB volume may treat as a separator', async () => {
    const result = await walkAndVerify(await plant(), ['link\\secret.png'])
    expect(result.ok).toBe(false)
  })

  it('CONTROL: the other segment faults are refused at the same chokepoint', async () => {
    const root = await plant()
    expect((await walkAndVerify(root, ['..', 'outside', 'secret.png'])).ok).toBe(false)
    expect((await walkAndVerify(root, [''])).ok).toBe(false)
    // Spelled as an escape, never as a literal — a real NUL renders as a space in every tool, and
    // this build has produced four defects of exactly that shape.
    expect((await walkAndVerify(root, ['a\u0000b'])).ok).toBe(false)
  })

  /**
   * The half that keeps the guard from being removed later. A rule that refuses real filenames is
   * a rule someone deletes in a hurry — and the user's tree is full of parentheses, hashes and
   * spaces.
   */
  it('does NOT refuse an ordinary filename', async () => {
    const root = await plant()
    await fsp.writeFile(join(root.absolutePath, 'a note (draft) #2.md'), 'x')
    expect((await walkAndVerify(root, ['a note (draft) #2.md'])).ok).toBe(true)
  })
})

/**
 * The rule itself, directly. Both layers call this — Core's walk and the contract validator — so a
 * change here changes both, which is the point of it existing once.
 */
describe('the segment rule', () => {
  it('names each fault, and passes an ordinary name', () => {
    expect(segmentFault('')).toBe('empty')
    expect(segmentFault('.')).toBe('dot')
    expect(segmentFault('..')).toBe('dot')
    expect(segmentFault('a/b')).toBe('separator')
    expect(segmentFault('a\\b')).toBe('separator')
    expect(segmentFault('a\u0000b')).toBe('nul')
    expect(segmentFault('x'.repeat(256))).toBe('too-long')

    expect(segmentFault('00-context')).toBeNull()
    expect(segmentFault('a note (draft) #2.md')).toBeNull()
    expect(segmentFault('x'.repeat(255))).toBeNull()
  })
})
