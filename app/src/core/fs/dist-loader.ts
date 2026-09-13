/**
 * Loads the built `dist/` into memory, once, at startup.
 *
 * It lives in `src/core/fs` because spec §2 confines filesystem access to this directory — and
 * that placement is the point rather than a formality. **This is the only code that ever turns a
 * built asset into bytes, and it runs before the server accepts a connection.** After it returns,
 * the asset map is a `Map` in memory and no request can reach the filesystem, which is what makes
 * build-plan §3's acceptance condition true: *no client route resolves a URL to a disk path.*
 *
 * A static file server would put this read on the request path, where the URL is attacker-supplied.
 * Here the read is on the startup path, where the input is our own build output.
 */

import { promises as fsp } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { errnoOf } from './containment'

export interface LoadedAsset {
  readonly urlPath: string
  readonly body: Buffer
  readonly immutable: boolean
}

/**
 * Vite emits content-hashed filenames into `assets/`. Those are safe to cache forever — the hash
 * changes when the content does, so a stale copy is unreachable rather than merely old.
 *
 * Everything else — the shell, the manifest, the service worker — is `no-cache`. Spec §15 is
 * emphatic: with no policy stated Safari applies heuristic caching and pins a stale shell on an
 * installed web app permanently, because the app never relaunches to notice.
 *
 * **THE MANIFEST IS NAMED IN THAT LIST AND WAS NOT EXEMPT.** The rule was purely positional —
 * anything under `assets/` carrying a hash — and Vite emits `assets/manifest-<hash>.webmanifest`.
 * Measured at the wire against the shipped binary: `cache-control: public, max-age=31536000,
 * immutable`. Two source files (this one and `asset-map.ts`) asserted the manifest was `no-cache`
 * while the socket said otherwise, which is §15's path-class MUST unmet.
 *
 * The hash buys back most of the staleness — the shell is `no-cache` and points at the new URL — so
 * the practical exposure is small. It is closed rather than argued away because §15 names the
 * manifest explicitly, and because "the comment is wrong but it is harmless" is how the previous
 * three comment/code divergences in this build were justified at the time too.
 */
const MANIFEST_SUFFIX = '.webmanifest'

function isContentHashed(urlPath: string): boolean {
  if (urlPath.endsWith(MANIFEST_SUFFIX)) return false
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(urlPath)
}

/** The maximum a single asset may be. A bundle larger than this is a build problem, not a request. */
const MAX_ASSET_BYTES = 16 * 1024 * 1024

/** The whole map. Bounds total memory, so a mis-pointed directory cannot exhaust it. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    // Symlinks are not followed. `dist/` is our own build output and should contain none; if one
    // appears, it is either a build bug or something that does not belong, and following it would
    // read bytes from outside the directory we meant to serve.
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

export interface LoadResult {
  readonly assets: LoadedAsset[]
  /** The build stamp read out of the shell, for the record and for the freshness check. */
  readonly buildStamp: string
}

/**
 * Reads every file under `distDir` into memory.
 *
 * Returns a failure rather than throwing, and refuses to return a *partial* map: a server that
 * starts with half its assets serves a shell whose script 404s, which looks like a broken app
 * rather than a failed startup. Spec §6's rule that a failure must never arrive looking like a
 * success applies to booting as much as to reading.
 */
export async function loadDist(distDir: string): Promise<Result<LoadResult>> {
  let files: string[]
  try {
    files = await walk(distDir)
  } catch (error) {
    const code = errnoOf(error)
    return fail(
      code === 'ENOENT' ? ErrorCode.INVALID_ROOT : ErrorCode.IO_FAILED,
      `could not read the built client at ${distDir}: ${code ?? 'unknown'}. Run the build first.`,
    )
  }

  if (files.length === 0) {
    // An empty dist is not an empty map — it is a build that did not run. Serving nothing would
    // present as a blank page, which is this build's signature failure mode.
    return fail(ErrorCode.INVALID_ROOT, `the built client at ${distDir} is empty. Run the build.`)
  }

  const assets: LoadedAsset[] = []
  let total = 0

  for (const file of files) {
    let body: Buffer
    try {
      body = await fsp.readFile(file)
    } catch (error) {
      return fail(ErrorCode.IO_FAILED, `could not read ${file}: ${errnoOf(error) ?? 'unknown'}`)
    }

    if (body.byteLength > MAX_ASSET_BYTES) {
      return fail(ErrorCode.TOO_LARGE, `${file} is larger than the asset limit`)
    }
    total += body.byteLength
    if (total > MAX_TOTAL_BYTES) {
      return fail(ErrorCode.TOO_LARGE, 'the built client exceeds the total asset limit')
    }

    // POSIX separators on the wire regardless of platform. A Windows-style key would never match a
    // URL, and the failure would be a silent 404 rather than an error.
    const urlPath = `/${relative(distDir, file).split(sep).join('/')}`
    assets.push({ urlPath, body, immutable: isContentHashed(urlPath) })
  }

  const shell = assets.find(a => a.urlPath === '/index.html')
  if (shell === undefined) {
    return fail(ErrorCode.INVALID_ROOT, 'the built client has no index.html')
  }

  const html = shell.body.toString('utf8')
  const stamp = /name="soil-build" content="([^"]*)"/.exec(html)?.[1] ?? ''

  // Spec §15 requires the shell carry a build stamp so freshness is machine-checkable. A shell
  // still carrying the literal placeholder means the build transform did not run — which happened
  // once, silently, because the placeholder appeared twice in the source and `replace` took the
  // first. Asserted here rather than assumed: an unstamped shell makes "is the fix deployed?"
  // unanswerable, which is the exact question the stamp exists to answer.
  if (stamp === '' || stamp === '__BUILD_STAMP__') {
    return fail(ErrorCode.INVALID_ROOT, 'the built shell carries no build stamp; the build transform did not run')
  }

  return ok({ assets, buildStamp: stamp })
}
