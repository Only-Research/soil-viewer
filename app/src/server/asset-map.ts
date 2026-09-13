/**
 * The asset map and the shell route. Spec §2 — and build-plan §3 records that this was
 * *"previously homeless"*: a **security** rule that no phase owned until now.
 *
 * THE RULE, and it is the whole file: **no client route resolves a URL to a disk path.**
 *
 * Every static asset the app serves is read once at build time into an in-memory map keyed by URL
 * path. A request looks up a key. It never joins, never resolves, never touches the filesystem.
 * That is not a hardened version of static file serving — it is the *absence* of static file
 * serving, and the difference matters because every traversal defence ever written is an attempt to
 * make `join(root, userInput)` safe, and this design deletes the join.
 *
 * The build-plan acceptance condition is "**asset map proven: no client route resolves a URL to a
 * disk path**". Proven the way P2's structural claims were: by attempting the thing that must be
 * impossible. `%2e%2e%2f`, absolute paths, NUL bytes, backslashes, encoded separators — all of them
 * are a lookup miss rather than a defended read, because there is nothing to defend.
 *
 * The one exception is the SHELL, and it is not an exception to the rule above: an unknown path
 * under the app's own routes serves the shell document from the same in-memory map, because the
 * client is a single-page app and a deep link must land somewhere. It still resolves to a map key,
 * never to a disk path.
 */

import { securityHeaders } from './csp'

export interface Asset {
  /** The bytes, held in memory from build time. */
  readonly body: Buffer
  readonly contentType: string
  /**
   * `Cache-Control`, per spec §15's path classes. Content-hashed assets are immutable for a year;
   * the shell, the service worker and the manifest are `no-cache`.
   *
   * Explicit on every asset because §15 is emphatic: with no policy stated, Safari applies
   * **heuristic** caching and pins a stale shell on an installed web app — permanently, because the
   * app never relaunches to notice. an earlier app lost a working session to exactly this.
   */
  readonly cacheControl: string
}

export interface AssetMap {
  /** Looks up a URL path. Returns undefined for a miss — never a filesystem read. */
  readonly get: (urlPath: string) => Asset | undefined
  /** The shell document, served for any unknown in-app route so a deep link lands. */
  readonly shell: () => Asset | undefined
  readonly paths: () => readonly string[]
  readonly size: () => number
}

export const IMMUTABLE = 'public, max-age=31536000, immutable'
export const NO_CACHE = 'no-cache'

/** Where the shell lives in the map. A key, not a path. */
export const SHELL_KEY = '/index.html'

/**
 * Content types, by extension, from a fixed table.
 *
 * A table rather than a lookup library, and never derived from the request: the response's
 * `Content-Type` is decided by what we built, not by what was asked for. With `nosniff` set on every
 * response (see `securityHeaders`), a wrong type is a failure to render rather than a chance for the
 * browser to guess its way into executing something.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  woff2: 'font/woff2',
  /*
   * **`ttf` was missing.** Added 2026-08-23 when Open Sans was brought in: without it a font falls
   * through to `application/octet-stream`, which is simply a lie about what was served.
   *
   * **It is correctness, not a fix, and that distinction was measured rather than assumed.** The
   * first version of this comment claimed `nosniff` made the wrong type fatal — that a font served
   * as `octet-stream` would be refused and the editor would quietly stay on its fallback face. It
   * was checked by removing this line: **both Chromium and WebKit loaded the font anyway.** Neither
   * enforces `nosniff` for fonts, whatever it does for scripts and styles.
   *
   * The line stays because serving a font as a generic blob is wrong on its own terms, and nothing
   * guarantees the next client is as forgiving. But it is not load-bearing today and does not get
   * to claim it is.
   */
  ttf: 'font/ttf',
  ico: 'image/x-icon',
  webmanifest: 'application/manifest+json',
}

export function contentTypeFor(urlPath: string): string {
  const dot = urlPath.lastIndexOf('.')
  const extension = dot === -1 ? '' : urlPath.slice(dot + 1).toLowerCase()
  // Unknown extensions get a type the browser will not execute or render, rather than a guess.
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/** Anything under these prefixes is the API, not an asset. Kept so the shell cannot shadow a route. */
const RESERVED_PREFIXES = ['/api/', '/events']

export interface BuiltAsset {
  readonly urlPath: string
  readonly body: Buffer
  /** Content-hashed assets are immutable; the shell and friends are not. */
  readonly immutable: boolean
}

export function createAssetMap(built: readonly BuiltAsset[]): AssetMap {
  // A Map, not an object. A plain object would let `__proto__` and `constructor` resolve to
  // something — the same reason the route table is a Map — and here the keys come from a URL.
  const assets = new Map<string, Asset>()
  for (const asset of built) {
    assets.set(asset.urlPath, {
      body: asset.body,
      contentType: contentTypeFor(asset.urlPath),
      cacheControl: asset.immutable ? IMMUTABLE : NO_CACHE,
    })
  }

  return {
    get: (urlPath: string) => assets.get(urlPath),
    shell: () => assets.get(SHELL_KEY),
    paths: () => [...assets.keys()],
    size: () => assets.size,
  }
}

export type AssetResolution =
  | { readonly kind: 'asset'; readonly asset: Asset }
  | { readonly kind: 'shell'; readonly asset: Asset }
  | { readonly kind: 'reserved' }
  | { readonly kind: 'not-found' }

/**
 * Resolves a request path to an asset, the shell, or nothing.
 *
 * **There is no filesystem call in this function and no path composition.** The query string is
 * dropped, the key is looked up, and that is the entire algorithm. Traversal sequences are not
 * rejected — they simply do not match a key, which is a stronger property than rejecting them,
 * because it does not depend on the rejection list being complete.
 */
export function resolveAsset(map: AssetMap, requestPath: string): AssetResolution {
  const path = requestPath.split('?')[0]?.split('#')[0] ?? ''

  for (const prefix of RESERVED_PREFIXES) {
    if (path === prefix || path.slice(0, prefix.length) === prefix) return { kind: 'reserved' }
  }

  const direct = map.get(path === '/' ? SHELL_KEY : path)
  if (direct !== undefined) return { kind: 'asset', asset: direct }

  // A deep link into the single-page app. Only for paths that could plausibly be an app route —
  // anything carrying a dot is asking for a file, and answering with HTML would let a request for
  // `/app.js` receive the shell, which the browser would then fail to execute in a confusing way.
  if (!path.includes('.')) {
    const shell = map.shell()
    if (shell !== undefined) return { kind: 'shell', asset: shell }
  }

  return { kind: 'not-found' }
}

/** Response headers for an asset: the shared security set, plus its own type and cache policy. */
export function assetHeaders(asset: Asset): Readonly<Record<string, string>> {
  return {
    ...securityHeaders(),
    'content-type': asset.contentType,
    'cache-control': asset.cacheControl,
    'content-length': String(asset.body.byteLength),
  }
}
