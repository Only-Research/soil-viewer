import { describe, expect, it } from 'vitest'

import {
  IMMUTABLE, SHELL_KEY, assetHeaders, contentTypeFor, createAssetMap, resolveAsset,
} from '../../src/server/asset-map'

/**
 * **Build-plan §3's first acceptance condition for Phase 3: "asset map proven — no client route
 * resolves a URL to a disk path."**
 *
 * Proven the way P2's structural claims were: by attempting the thing that must be impossible.
 *
 * The point of the design is that traversal is not *defended against* — it is *unrepresentable*.
 * There is no `join`, no `resolve`, no filesystem call anywhere in the resolution path, so
 * `%2e%2e%2f` and its thousand cousins are a lookup miss rather than a rejected read. That is a
 * stronger property than a rejection list, because it does not depend on the list being complete —
 * and every traversal defence ever written is an attempt to make `join(root, userInput)` safe.
 */

const map = createAssetMap([
  { urlPath: SHELL_KEY, body: Buffer.from('<!doctype html><div id=app></div>'), immutable: false },
  { urlPath: '/assets/app-a1b2c3.js', body: Buffer.from('export const x = 1'), immutable: true },
  { urlPath: '/assets/app-a1b2c3.css', body: Buffer.from('body{}'), immutable: true },
  { urlPath: '/manifest.webmanifest', body: Buffer.from('{}'), immutable: false },
])

describe('THE ACCEPTANCE CONDITION — no request becomes a disk path', () => {
  it('every traversal shape is a lookup MISS, not a defended read', () => {
    const attacks = [
      '/../package.json',
      '/../../etc/passwd',
      '/assets/../../../etc/passwd',
      '/%2e%2e%2fpackage.json',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/..%2f..%2fetc%2fpasswd',
      '/....//....//etc/passwd',
      '//etc/passwd',
      '/./././../package.json',
      '/assets/..%5c..%5cpackage.json',
      '/C:/Windows/win.ini',
      '/\\..\\..\\package.json',
      '/assets/app-a1b2c3.js/../../../package.json',
      '/%00/package.json',
      '/assets/app-a1b2c3.js%00.png',
      '/.git/config',
      '/.env',
      '/src/server/guards.ts',
      '/node_modules/.bin/vitest',
    ]
    for (const attack of attacks) {
      const result = resolveAsset(map, attack)
      // Each one either misses entirely or falls through to the shell — and the shell is a map
      // entry, not a file. Neither outcome reads from disk.
      expect(['not-found', 'shell'], `${attack} must not resolve to an asset`).toContain(result.kind)
      if (result.kind === 'shell') {
        expect(result.asset.body.toString(), `${attack} got the shell, which is fine`)
          .toContain('<!doctype html>')
      }
    }
  })

  it('a traversal that reaches a REAL file on disk still misses', () => {
    // package.json genuinely exists one directory up from the map's notional root. If resolution
    // touched the filesystem at all, this is the request that would find it.
    expect(resolveAsset(map, '/../package.json').kind).not.toBe('asset')
    expect(resolveAsset(map, '/../../app/package.json').kind).not.toBe('asset')
  })

  it('serves only what the map was built with — the paths are enumerable', () => {
    // The complete list of everything reachable. A static-file server has no such list.
    expect([...map.paths()].sort()).toEqual([
      '/assets/app-a1b2c3.css', '/assets/app-a1b2c3.js', '/index.html', '/manifest.webmanifest',
    ])
  })

  it('resolves keys by exact match — no prefix, no normalisation, no case folding', () => {
    expect(resolveAsset(map, '/assets/app-a1b2c3.js').kind).toBe('asset')
    // Each of these is a near miss that a normalising resolver would have accepted.
    for (const near of [
      '/assets/APP-A1B2C3.JS', '/assets//app-a1b2c3.js', '/assets/./app-a1b2c3.js',
      '/assets/app-a1b2c3.js ', ' /assets/app-a1b2c3.js',
    ]) {
      expect(resolveAsset(map, near).kind, `${near} must not match`).not.toBe('asset')
    }
  })
})

describe('serving', () => {
  it('serves the shell at the root', () => {
    const result = resolveAsset(map, '/')
    expect(result.kind).toBe('asset')
    if (result.kind === 'asset') expect(result.asset.body.toString()).toContain('<!doctype html>')
  })

  it('serves the shell for a deep app route so a link lands', () => {
    for (const route of ['/files', '/projects/field-review', '/tasks']) {
      expect(resolveAsset(map, route).kind, route).toBe('shell')
    }
  })

  it('does NOT serve the shell for something asking for a file', () => {
    // Answering `/app.js` with HTML lets the browser fail to execute it in a confusing way, and
    // hides a genuine 404 behind a 200.
    for (const missing of ['/missing.js', '/assets/gone.css', '/favicon.ico']) {
      expect(resolveAsset(map, missing).kind, missing).toBe('not-found')
    }
  })

  it('never shadows the API or the event stream with the shell', () => {
    for (const reserved of ['/api/tree.children', '/api/', '/events']) {
      expect(resolveAsset(map, reserved).kind, reserved).toBe('reserved')
    }
  })

  it('ignores the query string and fragment', () => {
    expect(resolveAsset(map, '/assets/app-a1b2c3.js?v=2').kind).toBe('asset')
    expect(resolveAsset(map, '/assets/app-a1b2c3.js#x').kind).toBe('asset')
  })

  it('a query string cannot smuggle a traversal', () => {
    expect(resolveAsset(map, '/assets/app-a1b2c3.js?../../package.json').kind).toBe('asset')
    expect(resolveAsset(map, '/?/../package.json').kind).toBe('asset')
  })
})

describe('cache policy — spec §15, stated per path class', () => {
  it('makes content-hashed assets immutable for a year', () => {
    const result = resolveAsset(map, '/assets/app-a1b2c3.js')
    if (result.kind !== 'asset') throw new Error('expected an asset')
    expect(result.asset.cacheControl).toBe(IMMUTABLE)
  })

  it('makes the shell and the manifest no-cache', () => {
    // With no policy stated, Safari applies heuristic caching and pins a stale shell on an
    // installed web app — permanently, because the app never relaunches to notice. an earlier app lost a
    // working session to this.
    for (const path of ['/', '/manifest.webmanifest']) {
      const result = resolveAsset(map, path)
      if (result.kind !== 'asset') throw new Error(`expected an asset at ${path}`)
      /**
       * **THE LITERAL, not the imported constant.** Comparing `cacheControl` to `NO_CACHE` is
       * comparing the constant to itself: redefining `NO_CACHE` to a year-long immutable policy
       * left this green, reinstating the exact failure the comment above describes. A mutation
       * review caught it.
       *
       * `'no-cache'` is what §15 specifies, so changing the constant now fails here and forces
       * whoever changes it to come and change the spec's value too, on purpose.
       */
      expect(result.asset.cacheControl, `${path} must be literally no-cache`).toBe('no-cache')
    }
  })

  it('and the hashed assets are literally immutable, for the same reason', () => {
    // The other half of the same tautology: `IMMUTABLE` was only ever compared to itself.
    const result = resolveAsset(map, '/assets/app-a1b2c3.js')
    if (result.kind !== 'asset') throw new Error('expected an asset')

    expect(result.asset.cacheControl).toBe('public, max-age=31536000, immutable')
  })

  it('states a cache policy on EVERY asset — none left to the browser', () => {
    for (const path of map.paths()) {
      const asset = map.get(path)
      expect(asset?.cacheControl, path).toBeTruthy()
    }
  })
})

describe('content types come from what we built, never from what was asked', () => {
  it('maps known extensions', () => {
    expect(contentTypeFor('/a.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/a.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/a.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/a.svg')).toBe('image/svg+xml')
  })

  /**
   * **Fonts, and this is the one that would have failed silently.** `nosniff` is on every response,
   * so a font served as `application/octet-stream` is **refused** — the stylesheet looks right, the
   * request returns 200, and the text quietly stays on the fallback face. Nothing errors.
   *
   * MUTATION: remove `ttf` from the table. Must redden.
   */
  it('serves a font as a font, because nosniff makes a wrong type fatal', () => {
    expect(contentTypeFor('/fonts/OpenSans-Regular.ttf')).toBe('font/ttf')
    expect(contentTypeFor('/a.woff2')).toBe('font/woff2')
  })

  it('gives an unknown extension a type the browser will not execute', () => {
    for (const path of ['/a.exe', '/a.php', '/a', '/a.']) {
      expect(contentTypeFor(path), path).toBe('application/octet-stream')
    }
  })

  it('is case-insensitive on the extension only', () => {
    expect(contentTypeFor('/A.JS')).toBe('text/javascript; charset=utf-8')
  })
})

describe('asset responses carry the full security header set', () => {
  it('sends the CSP, nosniff and the asset\'s own cache policy', () => {
    const result = resolveAsset(map, '/assets/app-a1b2c3.js')
    if (result.kind !== 'asset') throw new Error('expected an asset')
    const headers = assetHeaders(result.asset)
    expect(headers['content-security-policy']).toContain("default-src 'none'")
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['cache-control']).toBe(IMMUTABLE)
    expect(headers['content-length']).toBe(String(result.asset.body.byteLength))
  })

  it('the asset cache policy overrides the shared no-store, deliberately', () => {
    // `securityHeaders()` sets `no-store` because an API response carrying file contents must not
    // sit in a disk cache. A content-hashed asset is the opposite case — it is safe to cache
    // forever, and caching it is the point. The override is ordered, not accidental.
    const result = resolveAsset(map, '/assets/app-a1b2c3.css')
    if (result.kind !== 'asset') throw new Error('expected an asset')
    expect(assetHeaders(result.asset)['cache-control']).toBe(IMMUTABLE)
  })

  it('sends no CORS headers', () => {
    const result = resolveAsset(map, '/')
    if (result.kind !== 'asset') throw new Error('expected an asset')
    for (const name of Object.keys(assetHeaders(result.asset))) {
      expect(name.toLowerCase()).not.toContain('access-control')
    }
  })
})

describe('the map itself', () => {
  it('cannot be reached through a prototype key', () => {
    // The keys come from a URL, so a plain object would let `__proto__` resolve to something.
    for (const key of ['__proto__', 'constructor', 'toString', '/__proto__']) {
      expect(map.get(key), key).toBeUndefined()
    }
  })

  it('reports an empty map honestly rather than serving a phantom shell', () => {
    const empty = createAssetMap([])
    expect(empty.size()).toBe(0)
    expect(resolveAsset(empty, '/').kind).toBe('not-found')
    expect(resolveAsset(empty, '/files').kind).toBe('not-found')
  })
})
