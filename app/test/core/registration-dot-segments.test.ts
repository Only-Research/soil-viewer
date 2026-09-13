import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { registerRoot } from '../../src/core/fs/registration'
import { walkAndVerify } from '../../src/core/fs/containment'
import { ErrorCode } from '../../src/core/errors'

/**
 * **G6 — a root path containing `..` registers, and then nothing under it works.**
 *
 * security review, P7 review, 2026-08-09, filed **Open** and never carried onto the ledger until 2026-08-13:
 *
 * > *"A root path containing `..` registers and is stored verbatim; every child then fails —
 * > silently bricked instead of refused."*
 *
 * **Why it registers.** `registerRoot` asks the filesystem, and the filesystem is happy: the kernel
 * resolves `..` before it ever answers, so `lstat` reports a real directory, `opendir` succeeds, and
 * every check in that function passes. Nothing there looks at the *segments* of the path.
 *
 * **Why it then breaks.** Containment is decided by comparing whole segments (`isWithin`), because
 * spec §5 forbids `startsWith` on paths. A stored root of `/a/b/../c` has the literal segments
 * `['a','b','..','c']`, and a child composed from it inherits them — so the comparison is being made
 * against a path that names a place other than where it sits. `walkAndVerify` then refuses.
 *
 * **The severity is Low for one reason only: it fails closed.** Nothing escapes containment. The
 * folder simply never works, with no message anywhere saying why — which is the failure this build
 * calls silent-bricking, and it is exactly what §17's "a failure must never arrive looking like a
 * success" is about, one layer earlier.
 */

let base = ''
let real = ''

beforeAll(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'soil-g6-'))
  real = join(base, 'inner', 'tree')
  await fsp.mkdir(real, { recursive: true })
  await fsp.writeFile(join(real, 'note.md'), '# note\n')
})

afterAll(async () => {
  // Moved aside rather than removed would be the rule for anything of the operator's; this is a
  // mkdtemp directory this test created, which is the harness's own scratch.
  await fsp.rm(base, { recursive: true, force: true })
})

describe('a root path that names somewhere other than where it sits', () => {
  it('is refused at registration, rather than registering and failing later', async () => {
    // `<base>/inner/decoy/../tree` — the same directory as `real`, spelled with a traversal.
    //
    // **Composed as a raw string, never with `join`.** `join` normalises `..` away, so a test
    // written that way registers an ordinary path and proves nothing — which is exactly what the
    // first version of this case did. A client sends this over JSON; nothing normalises it on the
    // way in, which is the entire reason the segment check has to exist at the door.
    await fsp.mkdir(join(base, 'inner', 'decoy'), { recursive: true })
    const spelled = `${base}/inner/decoy/../tree`
    expect(spelled).toContain('/../')

    const registered = await registerRoot('g6', spelled)

    expect(registered.ok, 'a `..` segment registered successfully').toBe(false)
    if (registered.ok) return
    expect(registered.code).toBe(ErrorCode.PATH_TRAVERSAL)
  })

  it('refuses a `.` segment for the same reason', async () => {
    const spelled = join(base, 'inner', '.', 'tree')
    // `join` normalises `.` away, so this is composed by hand — the input a client sends is not
    // put through `join` before it arrives.
    const raw = `${base}/inner/./tree`
    expect(spelled).not.toBe(raw)

    const registered = await registerRoot('g6-dot', raw)
    expect(registered.ok, 'a `.` segment registered successfully').toBe(false)
  })

  it('still accepts the same directory spelled plainly', async () => {
    // The other half, and the one that stops this becoming a rule that refuses real folders: the
    // refusal is about the spelling, not about the place.
    const registered = await registerRoot('g6-ok', real)
    expect(registered.ok, 'a plain absolute path was refused').toBe(true)
  })

  it('and the plainly-spelled root can actually read its children', async () => {
    const registered = await registerRoot('g6-ok2', real)
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    const walked = await walkAndVerify(registered.value, ['note.md'])
    expect(walked.ok, 'a plain root could not reach its own child').toBe(true)
  })

  it('documents the breakage the refusal replaces', async () => {
    /**
     * **The proof that the refusal is worth having**, kept as a test rather than as a sentence.
     *
     * This constructs the state G6 describes — a root stored with a `..` in it — and shows that a
     * child under it cannot be reached. If someone ever "simplifies" the registration check away,
     * this is the behaviour that comes back, and it comes back silently.
     */
    const bricked = {
      id: 'g6-bricked',
      absolutePath: `${base}/inner/decoy/../tree`,
      // Verbatim on purpose — this fixture exists to prove a `..` root bricks its children.
      resolvedPath: `${base}/inner/decoy/../tree`,
      caseInsensitive: false,
      dev: 0n,
      rootIno: 0n,
    }
    const walked = await walkAndVerify(bricked, ['note.md'])
    expect(walked.ok, 'a `..` root reached its child, so the premise of G6 has changed').toBe(false)
  })
})
