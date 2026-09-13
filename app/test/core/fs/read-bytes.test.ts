import { constants, createReadStream, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { type RegisteredRoot } from '../../../src/core/fs/containment'
import { loadDocument } from '../../../src/core/fs/document'
import { NOFOLLOW_READ, openForReading } from '../../../src/core/fs/read-bytes'
import { registerRoot } from '../../../src/core/fs/registration'

/**
 * **`GET /file`'s opener, and the check it does not make.** The security review's finding N1, 2026-08-16.
 *
 * `read-bytes.ts` had no test file at all. It is the module behind the byte-serving route — images,
 * PDFs, video, anything the editor will not open — and it is the one read path in this build that
 * does not refuse a hard link.
 *
 * §4's own header states the case it exists to stop, in its own words:
 * *"`ln ~/.ssh/id_ed25519 /soil/notes.md` passes every other check."* `openFileForRead` refuses it
 * at two separate points, `copy.ts` and `rename.ts` refuse it, and this path performs no `nlink`
 * check anywhere — nor does anything downstream in `file-route.ts`.
 *
 * **Nothing here goes near `/Users/hallberg/notes`, and nothing links to a real secret.** The
 * "outside" file is a decoy this test creates in its own sandbox, named to be unmistakable in
 * output. The link is made from that decoy into a scratch root.
 *
 * **The controls are not decoration.** The security review's ruling requires them in the same run, because a probe
 * that never reached its subject produces output indistinguishable from one that did: if the fixture
 * were not genuinely hard-linked, the probe would pass and prove nothing.
 */

let sandbox: string
let rootPath: string
let root: RegisteredRoot

const OUTSIDE = 'DECOY-NOT-A-REAL-SECRET-------- if this appears in a response, N1 is real\n'
const INSIDE = '# An ordinary file\n\nplain content that is allowed to be served\n'

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-n1-'))
  rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })
  const registered = await registerRoot('scratch', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)
  root = registered.value

  await fsp.writeFile(join(rootPath, 'ordinary.md'), INSIDE)
  // The decoy lives OUTSIDE the registered root, exactly like a key in a home directory.
  await fsp.writeFile(join(sandbox, 'outside-secret.md'), OUTSIDE)
  // The attack: one hard link into the root. No symlink — a symlink is already refused.
  await fsp.link(join(sandbox, 'outside-secret.md'), join(rootPath, 'innocent.md'))
})

afterAll(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

async function bytesOf(opened: { open: () => NodeJS.ReadableStream }): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of opened.open()) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

describe('N1 — the byte route and hard links', () => {
  /** CONTROL. An honest file must be served, or a refusal below proves only that nothing works. */
  it('CONTROL: serves an ordinary file', async () => {
    const opened = await openForReading(root, ['ordinary.md'])
    expect(opened.ok, 'the honest path must succeed in this same run').toBe(true)
    if (!opened.ok) return
    expect(await bytesOf(opened.value)).toBe(INSIDE)
  })

  /**
   * CONTROL. Proves the fixture is **genuinely hard-linked** and that this build refuses it
   * elsewhere. Without this, a passing probe could just mean `fsp.link` silently did nothing.
   */
  it('CONTROL: the editing path refuses the very same file as HARDLINKED', async () => {
    const loaded = await loadDocument(root, ['innocent.md'])
    expect(loaded.ok, 'file.load must refuse it — that is what makes the probe meaningful').toBe(false)
    if (loaded.ok) return
    expect(loaded.code).toBe(ErrorCode.HARDLINKED)
  })

  /**
   * **THE PROBE.** Same root, same path, the other route.
   *
   * §1 grants a tailnet caller read access *inside a registered folder*. A hard link is not a
   * grant — it is one call by anything that can write in the root, which §1's threat model treats
   * as ordinary traffic. If this serves the decoy, the byte route reads arbitrary files the JSON
   * route refuses, and the two are not granting the same thing.
   */
  it('THE PROBE: the byte route must refuse it too', async () => {
    const opened = await openForReading(root, ['innocent.md'])

    if (opened.ok) {
      const served = await bytesOf(opened.value)
      expect(served, 'N1 IS REAL: the byte route served a file from outside every root').not.toBe(OUTSIDE)
    }

    expect(opened.ok, 'the byte route must refuse a hard link, as every other read path does').toBe(false)
    if (opened.ok) return
    expect(opened.code).toBe(ErrorCode.HARDLINKED)
  })
})

/**
 * **`O_NOFOLLOW` reaches the syscall, proven rather than reasoned.**
 *
 * The flag is passed to `createReadStream` as a **number**, and its documented option type is a
 * string. Node's `stringToFlags` returns a numeric argument unchanged, so this works — but "the
 * docs say string and we pass a number" is exactly the kind of assumption that silently degrades
 * into no protection at all, and a comment claiming the flag is set would then be the ninth false
 * claim in this build rather than the fix for the eighth.
 *
 * The walk already refuses a symlinked final component, so this cannot be driven through
 * `openForReading` — the refusal that fires would be the walk's. It is therefore asserted directly
 * against the same call shape: if the flag were ignored, this read would succeed.
 */
describe('the flag on the deferred open is real', () => {
  it('refuses to follow a symlink with the flags openForReading uses', async () => {
    const target = join(sandbox, 'symlink-target.md')
    await fsp.writeFile(target, 'must not be read through the link\n')
    const link = join(rootPath, 'a-link.md')
    await fsp.symlink(target, link)

    // Cast for the same reason `read-bytes.ts` casts: Node takes the number, the types say string.
    const readThrough = (flags?: number): Promise<string> => new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = createReadStream(link, flags === undefined
        ? undefined
        : { flags: flags as unknown as string })
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
      stream.on('error', reject)
    })

    // CONTROL: without the flag the link IS followed — so the refusal below is the flag's doing
    // and not the fixture being broken.
    await expect(readThrough()).resolves.toBe('must not be read through the link\n')

    /**
     * **The module's OWN constant, not a combination rebuilt here.** The first version of this
     * test wrote `O_RDONLY | O_NOFOLLOW` inline, and blanking `NOFOLLOW_READ` in the source left
     * it green: it proved the kernel honours a flag nobody was passing.
     */
    expect(Number(NOFOLLOW_READ) & constants.O_NOFOLLOW,
      'the module must actually set O_NOFOLLOW').toBe(constants.O_NOFOLLOW)

    await expect(
      readThrough(Number(NOFOLLOW_READ)),
      'ELOOP — the kernel honoured the numeric flag this module passes',
    ).rejects.toMatchObject({ code: 'ELOOP' })

    await fsp.rm(link, { force: true })
  })
})
