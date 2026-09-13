import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadDist } from '../../src/core/fs/dist-loader'
import { createAssetMap, resolveAsset, IMMUTABLE, NO_CACHE } from '../../src/server/asset-map'

/**
 * The startup read that makes build-plan §3's acceptance condition true.
 *
 * The point is *where* this runs: once, before the server accepts a connection, on our own build
 * output. A static file server does the same read on the request path, where the URL is
 * attacker-supplied. After this returns, the map is in memory and no request can reach the disk.
 */

let sandbox: string
const STAMPED_SHELL = '<!doctype html><meta name="soil-build" content="2026-08-07T00:00:00.000Z" /><div id=app></div>'

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-dist-'))
})

afterEach(async () => {
  const tempBase = process.env['TMPDIR'] ?? tmpdir()
  const ours =
    typeof sandbox === 'string' &&
    sandbox.length > tempBase.length &&
    sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-dist-')
  if (!ours) throw new Error(`refusing to recursively delete: ${String(sandbox)}`)
  await fsp.rm(sandbox, { recursive: true, force: true })
})

async function buildDist(files: Record<string, string>): Promise<string> {
  const dist = join(sandbox, 'dist')
  for (const [path, body] of Object.entries(files)) {
    const full = join(dist, path)
    await fsp.mkdir(join(full, '..'), { recursive: true })
    await fsp.writeFile(full, body)
  }
  return dist
}

describe('loading the built client', () => {
  it('reads every file into memory with a URL key', async () => {
    const dist = await buildDist({
      'index.html': STAMPED_SHELL,
      'assets/index-C80glRrC.js': 'export const x = 1',
      'assets/index-DdRgt7V2.css': 'body{}',
      'manifest.webmanifest': '{}',
    })

    const loaded = await loadDist(dist)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.assets.map(a => a.urlPath).sort()).toEqual([
      '/assets/index-C80glRrC.js', '/assets/index-DdRgt7V2.css', '/index.html', '/manifest.webmanifest',
    ])
  })

  it('marks content-hashed assets immutable and everything else no-cache', async () => {
    /**
     * **THIS TEST USED THE SHAPE THE BUILD NEVER EMITS.** It asserted `NO_CACHE` on a root-level
     * `manifest.webmanifest` — the *source* filename in `index.html`. Vite rewrites it to
     * `assets/manifest-<hash>.webmanifest`, which matched the content-hash rule, so the shipped
     * binary served the manifest `immutable` while this test proved the opposite about a path that
     * does not exist. §15 names the manifest in its `no-cache` list; two source comments repeated
     * that; the wire disagreed with all three.
     *
     * Both shapes are asserted now, so the exemption cannot regress on the one that ships.
     */
    const dist = await buildDist({
      'index.html': STAMPED_SHELL,
      'assets/index-C80glRrC.js': 'x',
      'assets/manifest-Bk5AaoAN.webmanifest': '{}',
      'manifest.webmanifest': '{}',
    })
    const loaded = await loadDist(dist)
    if (!loaded.ok) throw new Error('load failed')

    const map = createAssetMap(loaded.value.assets)
    const hashed = resolveAsset(map, '/assets/index-C80glRrC.js')
    const shipped = resolveAsset(map, '/assets/manifest-Bk5AaoAN.webmanifest')
    const source = resolveAsset(map, '/manifest.webmanifest')
    if (hashed.kind !== 'asset' || shipped.kind !== 'asset' || source.kind !== 'asset') {
      throw new Error('expected assets')
    }

    expect(hashed.asset.cacheControl).toBe(IMMUTABLE)
    // With no policy stated, Safari applies heuristic caching and pins a stale shell on an
    // installed web app — permanently, because the app never relaunches to notice.
    expect(source.asset.cacheControl).toBe(NO_CACHE)
    expect(
      shipped.asset.cacheControl,
      'the hashed name Vite actually emits is the one that ships',
    ).toBe(NO_CACHE)
  })

  it('reads the build stamp out of the shell', async () => {
    const dist = await buildDist({ 'index.html': STAMPED_SHELL, 'assets/a-AAAAAAAA.js': 'x' })
    const loaded = await loadDist(dist)
    if (!loaded.ok) throw new Error('load failed')
    expect(loaded.value.buildStamp).toBe('2026-08-07T00:00:00.000Z')
  })
})

describe('a build that did not happen must not look like a working one', () => {
  it('refuses a missing dist rather than serving nothing', async () => {
    const result = await loadDist(join(sandbox, 'never-built'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('Run the build')
  })

  it('refuses an EMPTY dist — that is a build that did not run, not an empty map', async () => {
    // Serving nothing would present as a blank page, which is this build's signature failure mode.
    const dist = join(sandbox, 'dist')
    await fsp.mkdir(dist, { recursive: true })
    expect((await loadDist(dist)).ok).toBe(false)
  })

  it('refuses a dist with no shell', async () => {
    const dist = await buildDist({ 'assets/a-AAAAAAAA.js': 'x' })
    const result = await loadDist(dist)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('index.html')
  })

  it('REFUSES A SHELL STILL CARRYING THE PLACEHOLDER — the transform silently not running', async () => {
    // This happened once, for real: the placeholder appeared twice in the source and `replace` took
    // the first, so the meta tag shipped saying `__BUILD_STAMP__`. An unstamped shell makes "is the
    // fix deployed?" unanswerable, which is the exact question the stamp exists to answer.
    const dist = await buildDist({
      'index.html': '<meta name="soil-build" content="__BUILD_STAMP__" />',
      'assets/a-AAAAAAAA.js': 'x',
    })
    const result = await loadDist(dist)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('build stamp')
  })

  it('refuses a shell with no stamp meta tag at all', async () => {
    const dist = await buildDist({ 'index.html': '<div id=app></div>' })
    expect((await loadDist(dist)).ok).toBe(false)
  })
})

describe('what the loader will not read', () => {
  it('does not follow a symlink out of dist', async () => {
    // dist/ is our own build output and should contain none. If one appears it is a build bug or
    // something that does not belong, and following it reads bytes from outside what we meant to
    // serve — then holds them in memory and serves them to anyone.
    const dist = await buildDist({ 'index.html': STAMPED_SHELL })
    const secret = join(sandbox, 'secret.txt')
    await fsp.writeFile(secret, 'private')
    await fsp.symlink(secret, join(dist, 'leaked.txt'))

    const loaded = await loadDist(dist)
    if (!loaded.ok) throw new Error('load failed')
    expect(loaded.value.assets.map(a => a.urlPath)).not.toContain('/leaked.txt')
    expect(loaded.value.assets.some(a => a.body.toString().includes('private'))).toBe(false)
  })

  it('refuses an asset larger than the per-file limit', async () => {
    const dist = await buildDist({ 'index.html': STAMPED_SHELL })
    await fsp.writeFile(join(dist, 'huge.bin'), Buffer.alloc(17 * 1024 * 1024))
    const result = await loadDist(dist)
    expect(result.ok).toBe(false)
  })
})

describe('the loaded map serves, and still resolves nothing to disk', () => {
  it('serves the shell and a hashed asset, and refuses traversal', async () => {
    const dist = await buildDist({
      'index.html': STAMPED_SHELL,
      'assets/index-C80glRrC.js': 'export const x = 1',
    })
    const loaded = await loadDist(dist)
    if (!loaded.ok) throw new Error('load failed')
    const map = createAssetMap(loaded.value.assets)

    expect(resolveAsset(map, '/').kind).toBe('asset')
    expect(resolveAsset(map, '/assets/index-C80glRrC.js').kind).toBe('asset')

    // The file exists on disk one level up from dist. If resolution touched the filesystem, this
    // is the request that would find it.
    await fsp.writeFile(join(sandbox, 'secret.txt'), 'private')
    expect(resolveAsset(map, '/../secret.txt').kind).not.toBe('asset')
    expect(resolveAsset(map, '/%2e%2e/secret.txt').kind).not.toBe('asset')
  })
})
