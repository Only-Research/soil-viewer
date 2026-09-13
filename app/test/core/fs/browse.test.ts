import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCode } from '../../../src/core/errors'
import { browseDirectories, browseRoots, type BrowseScope } from '../../../src/core/fs/browse'

/**
 * The folder browser, against real directories and real symlinks.
 *
 * `scope.home` and `scope.volumes` point into a sandbox rather than at the real `$HOME`, which is
 * the reason they are injected at all — these tests must be able to plant a symlink escaping the
 * scope, and doing that in the user's actual home directory is not on.
 *
 * **Nothing goes near `/Users/hallberg/notes`.**
 */
let sandbox: string
let home: string
let volumes: string
let scope: BrowseScope

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p7-browse-'))
  // Resolved, because macOS puts TMPDIR under /private/var via a symlink and every assertion below
  // compares against a realpath.
  sandbox = await fsp.realpath(sandbox)
  home = join(sandbox, 'home')
  volumes = join(sandbox, 'Volumes')
  await fsp.mkdir(home, { recursive: true })
  await fsp.mkdir(volumes, { recursive: true })
  scope = { home, volumes }
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const listing = async (path: string) => {
  const outcome = await browseDirectories(path, scope)
  if (!outcome.ok) throw new Error(`expected a listing, got ${outcome.code}`)
  return outcome.value
}

const codeOf = async (path: string): Promise<ErrorCode | 'ok'> => {
  const outcome = await browseDirectories(path, scope)
  return outcome.ok ? 'ok' : outcome.code
}

describe('what the browser shows', () => {
  it('lists directories, sorted', async () => {
    for (const name of ['projects', 'archive', 'notes']) {
      await fsp.mkdir(join(home, name), { recursive: true })
    }
    const result = await listing(home)
    expect(result.directories.map(d => d.name)).toEqual(['archive', 'notes', 'projects'])
    expect(result.directories[0]?.path).toBe(join(home, 'archive'))
  })

  it('NEVER lists files — the reduction §11 asks for', async () => {
    await fsp.mkdir(join(home, 'a-folder'), { recursive: true })
    await fsp.writeFile(join(home, 'secrets.md'), 'private\n')
    await fsp.writeFile(join(home, 'taxes.pdf'), 'private\n')
    const result = await listing(home)
    expect(result.directories.map(d => d.name)).toEqual(['a-folder'])
    // And nothing anywhere in the payload names a file.
    expect(JSON.stringify(result)).not.toContain('secrets')
    expect(JSON.stringify(result)).not.toContain('taxes')
  })

  it('hands back no sizes, times or contents — only a name and a path', async () => {
    await fsp.mkdir(join(home, 'a-folder'), { recursive: true })
    const result = await listing(home)
    expect(Object.keys(result.directories[0] ?? {}).sort()).toEqual(['name', 'path'])
  })

  it('omits dot-directories', async () => {
    await fsp.mkdir(join(home, '.Trash'), { recursive: true })
    await fsp.mkdir(join(home, 'Library'), { recursive: true })
    const result = await listing(home)
    expect(result.directories.map(d => d.name)).toEqual(['Library'])
  })

  it('reports the RESOLVED path, not the one that was asked for', async () => {
    const real = join(home, 'real')
    await fsp.mkdir(real, { recursive: true })
    await fsp.symlink(real, join(home, 'alias'))
    const result = await listing(join(home, 'alias'))
    expect(result.path).toBe(real)
  })
})

describe('the scope, and it is a positive rule', () => {
  it('allows the home directory and /Volumes', async () => {
    expect(await codeOf(home)).toBe('ok')
    expect(await codeOf(volumes)).toBe('ok')
    expect(browseRoots(scope)).toEqual([home, volumes])
  })

  it('allows an external volume under /Volumes', async () => {
    await fsp.mkdir(join(volumes, 'Backup', 'notes'), { recursive: true })
    const result = await listing(join(volumes, 'Backup'))
    expect(result.directories.map(d => d.name)).toEqual(['notes'])
  })

  it('REFUSES anything outside both roots', async () => {
    const outside = join(sandbox, 'outside')
    await fsp.mkdir(outside, { recursive: true })
    expect(await codeOf(outside)).toBe(ErrorCode.PATH_ESCAPES_ROOT)
  })

  it("REFUSES another user's home directory", async () => {
    // The sibling case §11 names. `home` is `<sandbox>/home`; this is `<sandbox>/home-other`, which
    // a naive `startsWith` without a separator would accept.
    const other = join(sandbox, 'home-other')
    await fsp.mkdir(other, { recursive: true })
    expect(await codeOf(other)).toBe(ErrorCode.PATH_ESCAPES_ROOT)
  })

  it('refuses the volume root', async () => {
    expect(await codeOf('/')).toBe(ErrorCode.PATH_ESCAPES_ROOT)
  })

  it('refuses a relative path rather than resolving it against the working directory', async () => {
    expect(await codeOf('projects')).toBe(ErrorCode.INVALID_ROOT)
  })

  it('refuses dot-segments rather than normalising them away', async () => {
    expect(await codeOf(`${home}/../home-other`)).toBe(ErrorCode.PATH_TRAVERSAL)
    expect(await codeOf(`${home}/.`)).toBe(ErrorCode.PATH_TRAVERSAL)
  })
})

/**
 * THE SYMLINK ESCAPES, which are the whole reason the scope check runs on the realpath.
 *
 * A symlink inside the caller's own home directory is an ordinary thing to create and can point
 * anywhere. If the scope were checked against the string that arrived, every one of these would be
 * a successful listing of somewhere it must never reach.
 */
describe('a symlink cannot be used to leave the scope', () => {
  it('refuses a link pointing outside, even though the link itself is inside home', async () => {
    const outside = join(sandbox, 'outside')
    await fsp.mkdir(join(outside, 'private'), { recursive: true })
    await fsp.symlink(outside, join(home, 'doorway'))

    expect(await codeOf(join(home, 'doorway'))).toBe(ErrorCode.PATH_ESCAPES_ROOT)
  })

  it('refuses a link pointing at the volume root', async () => {
    await fsp.symlink('/', join(home, 'everything'))
    expect(await codeOf(join(home, 'everything'))).toBe(ErrorCode.PATH_ESCAPES_ROOT)
  })

  it('does not LIST a symlinked directory, so the doorway is never even offered', async () => {
    const outside = join(sandbox, 'outside')
    await fsp.mkdir(outside, { recursive: true })
    await fsp.symlink(outside, join(home, 'doorway'))
    await fsp.mkdir(join(home, 'ordinary'), { recursive: true })

    const result = await listing(home)
    expect(result.directories.map(d => d.name)).toEqual(['ordinary'])
  })

  it('does not list a symlink pointing INSIDE the scope either', async () => {
    // Still excluded. It is not a containment question — a link that resolves elsewhere makes the
    // path the caller then sends differ from the path they were shown, and one rule is easier to
    // hold than a rule with an exception.
    await fsp.mkdir(join(home, 'real'), { recursive: true })
    await fsp.symlink(join(home, 'real'), join(home, 'alias'))
    const result = await listing(home)
    expect(result.directories.map(d => d.name)).toEqual(['real'])
  })
})

describe('going up', () => {
  it('offers a parent inside the scope', async () => {
    await fsp.mkdir(join(home, 'projects', 'deep'), { recursive: true })
    const result = await listing(join(home, 'projects', 'deep'))
    expect(result.parent).toBe(join(home, 'projects'))
  })

  it('offers NO parent at an allowed root, so "up" cannot walk out', async () => {
    expect((await listing(home)).parent).toBeNull()
    expect((await listing(volumes)).parent).toBeNull()
  })
})

describe('failures the filesystem reports', () => {
  it('reports an unreadable directory as a permission refusal', async () => {
    const locked = join(home, 'locked')
    await fsp.mkdir(locked, { recursive: true })
    await fsp.chmod(locked, 0o000)
    try {
      expect(await codeOf(locked)).toBe(ErrorCode.PERMISSION_DENIED)
    } finally {
      await fsp.chmod(locked, 0o755)
    }
  })

  it('refuses a path that is a file', async () => {
    await fsp.writeFile(join(home, 'notes.md'), 'x\n')
    expect(await codeOf(join(home, 'notes.md'))).toBe(ErrorCode.NOT_REGULAR_FILE)
  })

  /**
   * The oracle question, and it is why the refusal is deliberately uninformative.
   *
   * A caller who can tell "outside the scope" from "does not exist" can test for the existence of
   * any path on the machine without ever being permitted to list one. Both answer the same.
   */
  it('cannot distinguish a missing path outside the scope from an existing one', async () => {
    const exists = join(sandbox, 'outside')
    await fsp.mkdir(exists, { recursive: true })
    const missing = join(sandbox, 'does-not-exist-at-all')

    const a = await browseDirectories(exists, scope)
    const b = await browseDirectories(missing, scope)
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    if (a.ok || b.ok) throw new Error('unreachable')
    expect(a.code, 'the two must be indistinguishable').toBe(b.code)
  })
})
