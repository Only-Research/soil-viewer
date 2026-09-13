import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import {
  openFileForRead,
  readAllBytes,
  readDirectory,
  readFileBytes,
  readHead,
  walkAndVerify,
  MAX_READ_BYTES,
  type RegisteredRoot,
} from '../../../src/core/fs/containment'
import { probeCaseInsensitive, registerRoot } from '../../../src/core/fs/registration'

/**
 * Real files, real symlinks, real hard links. Spec §4's rules are about what the kernel does;
 * a mock would only prove that the mock agrees with the test author.
 *
 * Layout:
 *   sandbox/
 *     outside/secret.txt        <- the thing an escape is trying to reach
 *     root/                     <- the registered folder
 *       notes.md                (clean: nlink == 1)
 *       sub/deep.md
 *       link-out.md      -> ../../outside/secret.txt
 *       link-in.md       -> notes.md
 *       link-dir         -> sub
 *       linked-original.md      (nlink == 2, paired with hardlink.md)
 *       hardlink.md             (the second name for linked-original.md)
 *     symlinked-root     -> root
 *
 * `notes.md` is deliberately NOT the hard-link source. An earlier version of this fixture
 * linked it, and every ordinary-read test then failed — correctly, because a hard link raises
 * the link count on BOTH names. That behaviour is asserted below rather than worked around.
 */
let sandbox: string
let root: RegisteredRoot

const NOTES_BODY = '# Notes\n\nreal content\n'
const SECRET_BODY = 'TOP SECRET — must never be readable through the root\n'

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p1-'))

  await fsp.mkdir(join(sandbox, 'outside'), { recursive: true })
  await fsp.writeFile(join(sandbox, 'outside', 'secret.txt'), SECRET_BODY)

  const rootPath = join(sandbox, 'root')
  await fsp.mkdir(join(rootPath, 'sub'), { recursive: true })
  await fsp.writeFile(join(rootPath, 'notes.md'), NOTES_BODY)
  await fsp.writeFile(join(rootPath, 'sub', 'deep.md'), 'deep\n')

  await fsp.symlink(join('..', '..', 'outside', 'secret.txt'), join(rootPath, 'link-out.md'))
  await fsp.symlink('notes.md', join(rootPath, 'link-in.md'))
  await fsp.symlink('sub', join(rootPath, 'link-dir'))
  await fsp.writeFile(join(rootPath, 'linked-original.md'), 'linked\n')
  await fsp.link(join(rootPath, 'linked-original.md'), join(rootPath, 'hardlink.md'))

  await fsp.symlink(rootPath, join(sandbox, 'symlinked-root'))

  const registered = await registerRoot('test-root', rootPath)
  if (!registered.ok) throw new Error(`registration failed: ${registered.code}`)
  root = registered.value
})

afterAll(async () => {
  // A recursive delete gets a hard guard, even in a test. Spec §13.7 confines recursive
  // removal to one place and requires it to refuse to run inside a registered folder; test
  // code does not get an exemption from that just because it is "only a fixture". If mkdtemp
  // ever failed, or this path were ever anything but the temp tree this file created, the
  // delete must not happen.
  const tempBase = process.env['TMPDIR'] ?? tmpdir()
  const looksLikeOurSandbox =
    typeof sandbox === 'string' &&
    sandbox.length > tempBase.length &&
    sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-p1-')

  if (!looksLikeOurSandbox) {
    throw new Error(`refusing to recursively delete an unexpected path: ${String(sandbox)}`)
  }
  await fsp.rm(sandbox, { recursive: true, force: true })
})

describe('registration — spec §4 and §5', () => {
  it('records the volume identity rather than trusting the path', () => {
    expect(typeof root.dev).toBe('bigint')
    expect(typeof root.rootIno).toBe('bigint')
    expect(root.rootIno).toBeGreaterThan(0n)
  })

  it('probes case sensitivity instead of assuming it', async () => {
    const probe = await probeCaseInsensitive(root.absolutePath)
    expect(probe.ok).toBe(true)
    if (probe.ok) {
      expect(typeof probe.value.caseInsensitive).toBe('boolean')
      // The probe must have actually measured something, not fallen back to the default.
      expect(probe.value.method).not.toBe('assumed-platform-default')
    }
  })

  it('REFUSES a symlinked root', async () => {
    // The target can be repointed after registration; every later check would then be
    // measuring a tree the user never chose.
    const result = await registerRoot('bad', join(sandbox, 'symlinked-root'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.PATH_SYMLINK)
  })

  it('refuses a file as a root', async () => {
    const result = await registerRoot('bad', join(sandbox, 'root', 'notes.md'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.NOT_REGULAR_FILE)
  })

  it('refuses a root that does not exist', async () => {
    const result = await registerRoot('bad', join(sandbox, 'nope'))
    expect(result.ok).toBe(false)
  })

  it('REFUSES a relative root path', async () => {
    // A relative root resolves against the process working directory, so every containment
    // comparison afterwards would be made against the wrong tree. That is a wrong answer
    // rather than a refusal, which makes it worse than an error.
    const result = await registerRoot('bad', 'some/relative/path')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.INVALID_ROOT)
  })

  it('reports a permission failure at registration as PERMISSION_DENIED', async () => {
    // Spec §5 (M13): the probe must happen AT REGISTRATION, because that is when the operator is
    // present to grant access. A macOS privacy denial arriving as a broken-path error would
    // send them looking for a filesystem problem that does not exist.
    const locked = join(sandbox, 'locked-root')
    await fsp.mkdir(locked, { recursive: true })
    await fsp.chmod(locked, 0o000)
    try {
      const result = await registerRoot('locked', locked)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe(ErrorCode.PERMISSION_DENIED)
    } finally {
      await fsp.chmod(locked, 0o755)
    }
  })

  it('REFUSES the filesystem root itself', async () => {
    // `/` has zero segments, and containment against zero segments is vacuously true — the
    // wall would still be structurally sound while protecting nothing.
    const result = await registerRoot('bad', '/')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.INVALID_ROOT)
  })
})

describe('reading — the ordinary path works', () => {
  it('reads a file byte-for-byte', async () => {
    const result = await readFileBytes(root, ['notes.md'])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.equals(Buffer.from(NOTES_BODY))).toBe(true)
    }
  })

  it('reads a file in a subdirectory', async () => {
    const result = await readFileBytes(root, ['sub', 'deep.md'])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.toString()).toBe('deep\n')
  })

  it('returns bytes, not a decoded string', async () => {
    const result = await readFileBytes(root, ['notes.md'])
    expect(result.ok).toBe(true)
    if (result.ok) expect(Buffer.isBuffer(result.value)).toBe(true)
  })
})

// the security review's required symlink-escape gate. Every case must be REFUSED.
describe('symlink escape — spec §4 refuses, never resolves', () => {
  it('REFUSES a symlink pointing outside the root, and does not leak its contents', async () => {
    const result = await readFileBytes(root, ['link-out.md'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.PATH_SYMLINK)
      // Belt and braces: whatever came back, it is not the secret.
      expect(JSON.stringify(result)).not.toContain('TOP SECRET')
    }
  })

  it('REFUSES a symlink even when it points inside the root', async () => {
    // Spec §4: "refused, not resolved". A resolved link is a path that was valid at check
    // time and can point elsewhere by open time — that is the TOCTOU this closes.
    const result = await readFileBytes(root, ['link-in.md'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.PATH_SYMLINK)
  })

  it('REFUSES a symlinked directory used as an intermediate segment', async () => {
    // Every segment from the root down is checked, not just the last one.
    const result = await readFileBytes(root, ['link-dir', 'deep.md'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.PATH_SYMLINK)
  })

  it('reports a symlink in a directory listing without following it', async () => {
    const result = await readDirectory(root, [])
    expect(result.ok).toBe(true)
    if (result.ok) {
      const byName = new Map(result.value.map(entry => [entry.name, entry.kind]))
      expect(byName.get('link-out.md')).toBe('symlink')
      expect(byName.get('link-dir')).toBe('symlink')
      expect(byName.get('notes.md')).toBe('file')
      expect(byName.get('sub')).toBe('directory')
    }
  })
})

describe('hard links — spec §4 refuses in both directions', () => {
  it('REFUSES a regular file with more than one link', async () => {
    // `ln ~/.ssh/id_ed25519 /soil/notes.md` passes containment, is a regular file, and lives
    // inside the root. Link count is the only check that catches it (F4.2).
    const result = await readFileBytes(root, ['hardlink.md'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.HARDLINKED)
  })

  it('refuses the ORIGINAL too, once it has been hard-linked', async () => {
    // Both names share one inode and one link count. Refusing only the new name would leave
    // the escape open under the old one. This is not a hypothetical: building this fixture
    // with notes.md as the link source made every ordinary-read test fail, which is how the
    // rule proved it applies to the pre-existing name and not just the newly created one.
    const result = await readFileBytes(root, ['linked-original.md'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.HARDLINKED)
  })

  it('leaves an unlinked file readable, so the rule is not simply refusing everything', async () => {
    const result = await readFileBytes(root, ['notes.md'])
    expect(result.ok).toBe(true)
  })
})

describe('permission failures are distinguished from containment failures — spec §5', () => {
  it('reports EACCES as PERMISSION_DENIED, not as a bad path', async () => {
    // Spec §5: a background process meets EPERM on ~/Documents, ~/Desktop, iCloud and
    // external volumes with NO prompt. Conflating that with a containment refusal would send
    // the operator hunting a corrupt file when the fix is a macOS privacy setting.
    const locked = join(sandbox, 'root', 'locked')
    await fsp.mkdir(locked, { recursive: true })
    await fsp.writeFile(join(locked, 'inside.md'), 'x\n')
    await fsp.chmod(locked, 0o000)
    try {
      const result = await readFileBytes(root, ['locked', 'inside.md'])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe(ErrorCode.PERMISSION_DENIED)
    } finally {
      await fsp.chmod(locked, 0o755)
    }
  })
})

describe('non-regular files and absent targets', () => {
  it('refuses a directory where a file was expected', async () => {
    const result = await readFileBytes(root, ['sub'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.NOT_REGULAR_FILE)
  })

  it('reports a missing file as a failure, never as empty success', async () => {
    // Spec §6: "An empty-but-successful result never stands in for a failure."
    const result = await readFileBytes(root, ['does-not-exist.md'])
    expect(result.ok).toBe(false)
  })

  it('reports a missing directory as a failure, never as an empty list', async () => {
    const result = await readDirectory(root, ['nope'])
    expect(result.ok).toBe(false)
  })

  it('reports absence distinctly from refusal when walking', async () => {
    const walked = await walkAndVerify(root, ['does-not-exist.md'])
    expect(walked.ok).toBe(true)
    if (walked.ok) expect(walked.value).toBeNull()
  })
})

describe('a partial read is a failure, never a smaller success — B1, spec §6 and §13.2', () => {
  it('REFUSES a read whose file was truncated after the handle was verified', async () => {
    // The read half of the C2 total-loss path: if this returned {ok:true} with a short buffer,
    // P6's editor mounts an apparently empty document, one keystroke autosaves, and the file
    // is gone. Spec §13.2: "a failed OR PARTIAL read renders a named error."
    const target = join(root.absolutePath, 'shrinks.md')
    await fsp.writeFile(target, 'x'.repeat(5000))

    const opened = await openFileForRead(root, ['shrinks.md'])
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    try {
      expect(opened.value.size).toBe(5000)
      await fsp.truncate(target, 0) // the file shrinks after fstat promised 5000

      const read = await readAllBytes(opened.value)
      expect(read.ok, 'a short read must not report success').toBe(false)
      if (!read.ok) expect(read.code).toBe(ErrorCode.SHORT_READ)
    } finally {
      await opened.value.file.close()
    }
  })

  it('still reads an intact file in full', async () => {
    // So the rule above is not simply refusing everything.
    const target = join(root.absolutePath, 'intact.md')
    await fsp.writeFile(target, 'y'.repeat(5000))
    const read = await readFileBytes(root, ['intact.md'])
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.value.length).toBe(5000)
  })

  it('refuses a truncated head read rather than returning a short head', async () => {
    const target = join(root.absolutePath, 'head.md')
    await fsp.writeFile(target, '# Title\n' + 'z'.repeat(4000))
    const opened = await openFileForRead(root, ['head.md'])
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    try {
      await fsp.truncate(target, 0)
      const head = await readHead(opened.value, 64 * 1024)
      expect(head.ok).toBe(false)
      if (!head.ok) expect(head.code).toBe(ErrorCode.SHORT_READ)
    } finally {
      await opened.value.file.close()
    }
  })
})

describe('containment after composition — spec §4', () => {
  it('refuses traversal segments even if they reach this layer', async () => {
    // validateRelativePath is the first gate; this is the second. Defense in depth, because
    // the spec requires containment be re-verified after composition rather than assumed
    // from validation having run.
    const result = await readFileBytes(root, ['..', 'outside', 'secret.txt'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect([ErrorCode.PATH_ESCAPES_ROOT, ErrorCode.PATH_TRAVERSAL]).toContain(result.code)
      expect(JSON.stringify(result)).not.toContain('TOP SECRET')
    }
  })

  it('detects the registered root being replaced by a different volume or inode', async () => {
    // Spec §5: verify volume identity, never recreate a missing root.
    const impostor: RegisteredRoot = { ...root, rootIno: root.rootIno + 1n }
    const result = await readFileBytes(impostor, ['sub', 'deep.md'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.IDENTITY_CHANGED)
  })

  it('refuses when the registered root has vanished', async () => {
    const gone: RegisteredRoot = { ...root, absolutePath: join(sandbox, 'never-existed') }
    const result = await readFileBytes(gone, ['a.md'])
    expect(result.ok).toBe(false)
  })
})

/**
 * FIVE §4 CONTROLS THAT NOTHING DEFENDED.
 *
 * A whole-suite mutation review deleted each of these and every one of 969 tests stayed green. All
 * five are correct in the code today; none of them had anything watching. They land before Phase 4
 * rather than after, because Phase 4 rewrites this layer — and a test written after a change
 * describes what the code now does, not what it is supposed to do.
 */
describe('the §4 controls Phase 4 leans on', () => {
  it('refuses a file larger than the read cap, on the DESCRIPTOR', async () => {
    // Deleting the cap left the suite green. A sparse file is used deliberately: the check reads the
    // size the kernel reports, so this exercises it exactly while costing no disk.
    const huge = join(root.absolutePath, 'huge.md')
    const handle = await fsp.open(huge, 'w')
    await handle.truncate(MAX_READ_BYTES + 1)
    await handle.close()

    const result = await readFileBytes(root, ['huge.md'])

    expect(result.ok, 'one enormous file must not be allowed to exhaust memory').toBe(false)
    if (!result.ok) expect(result.code).toBe(ErrorCode.TOO_LARGE)

    // The mirror: exactly at the cap is fine, so the rule is a bound and not a blanket refusal.
    const atCap = join(root.absolutePath, 'at-cap.md')
    const second = await fsp.open(atCap, 'w')
    await second.truncate(MAX_READ_BYTES)
    await second.close()
    expect((await readFileBytes(root, ['at-cap.md'])).ok, 'exactly at the cap is allowed').toBe(true)
  })

  /**
   * THE FOUR BELOW ARE PINNED STRUCTURALLY, AND THAT IS A DELIBERATE SECOND-BEST.
   *
   * Each defends against something that cannot be produced on demand from a test:
   *
   * - `O_NOFOLLOW` only matters if the final component becomes a symlink **between** the walk and
   *   the open. The walk already refuses symlinks, so reaching this flag needs a genuine race.
   * - The `(dev, ino)` re-check on the descriptor likewise fires only when the target is swapped
   *   inside that same window.
   * - `Buffer.alloc` vs `allocUnsafe` differs only in whether reused memory is zeroed. A short read
   *   would expose whatever was there — and in a test that is almost always zeros anyway, so a
   *   behavioural assertion would pass against the unsafe version too.
   * - `join` vs `resolve`: `resolve` silently discards everything to its left when a later segment
   *   is absolute, which is why §4 bans it by name. The validator refuses absolute segments before
   *   this layer sees them, so the ban is defence in depth rather than the outer wall.
   *
   * A racing test for the first two would be flaky, and a flaky test gets deleted — which is how a
   * control ends up unguarded a second time. This build already uses source assertions for exactly
   * this shape (`test/security/scope-boundary.test.ts` pins the lint exception list the same way).
   *
   * Stated plainly so nobody upgrades it in their head: this proves the control is PRESENT, not that
   * it FIRES. That is weaker, it is the strongest thing available here, and it is still infinitely
   * more than the nothing that was here before.
   */
  it('keeps the four §4 controls that cannot be provoked from a test', async () => {
    const source = await fsp.readFile(
      new URL('../../../src/core/fs/containment.ts', import.meta.url), 'utf8',
    )

    // The CALL. `toContain('O_NOFOLLOW')` passed with the flag removed from the open, because the
    // comment above it still names the flag. Third time today an assertion matched documentation
    // instead of code — including twice in the tests I wrote to catch exactly that.
    expect(source, 'O_NOFOLLOW: the final component must not be followed at open')
      .toContain('constants.O_RDONLY | constants.O_NOFOLLOW')
    expect(source, 'the TOCTOU close: what we opened must be what we checked')
      .toContain('stat.dev !== walked.value.dev')
    // The CALL, not the word — the source names `allocUnsafe` in the comment explaining the ban,
    // and an assertion that trips on its own documentation is one somebody deletes.
    expect(source, 'Buffer.alloc, never allocUnsafe — a short read must not expose old memory')
      .not.toContain('Buffer.allocUnsafe(')
    // The IMPORT, for the same reason: the source explains the ban by naming
    // `path.resolve(root, '/etc/passwd')`, so matching the call text trips on the documentation.
    // If it is never imported it can never be called.
    expect(source, '§4 bans path.resolve by name: a later absolute segment discards the root')
      .not.toMatch(/import \{[^}]*\bresolve\b[^}]*\} from 'node:path'/)
  })
})
