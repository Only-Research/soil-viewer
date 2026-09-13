import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * **EVERY ICON THE APP NAMES EXISTS, IS THE SIZE IT CLAIMS, AND IS SQUARE.**
 *
 * The failure this is written against is quiet in the worst way: a manifest naming an icon that
 * 404s produces **no error anywhere**. The browser asks, gets nothing, and falls back — on iOS, to a
 * screenshot of the page. Nothing is logged, no test goes red, and the only symptom is a home screen
 * that looks wrong months later. The same shape as `design-tokens.test.ts`, which exists because
 * twenty `var()` uses named two tokens that were never defined.
 *
 * **The size claim is checked against the file's own header, not trusted.** A manifest that says
 * `512x512` beside a 192px image is a lie a browser acts on — it will pick that entry for a 512 slot
 * and upscale. Read straight out of the PNG's IHDR, which needs no decoder and no dependency.
 */

const CLIENT = join(import.meta.dirname, '../../src/client')
const PUBLIC = join(CLIENT, 'public')

interface Png { readonly width: number; readonly height: number; readonly colourType: number }

/**
 * Width, height and colour type from a PNG's IHDR — the first chunk, at a fixed offset, in a format
 * that has not changed since 1996. Also proves the file really is a PNG rather than something
 * renamed, which is what `type: "image/png"` in the manifest asserts to the browser.
 */
function readPng(path: string): Png {
  const bytes = readFileSync(path)
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(bytes.subarray(0, 8), `${path} is not a PNG`).toEqual(SIGNATURE)
  expect(bytes.subarray(12, 16).toString('ascii'), `${path} has no IHDR`).toBe('IHDR')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colourType: bytes.readUInt8(25),
  }
}

interface ManifestIcon { src: string; sizes: string; type: string; purpose?: string }

const manifest = JSON.parse(
  readFileSync(join(CLIENT, 'manifest.webmanifest'), 'utf8'),
) as { icons?: ManifestIcon[]; name?: string }

const shell = readFileSync(join(CLIENT, 'index.html'), 'utf8')

/** Every `href` on a `<link rel="…icon…">`, which is how the shell names an icon. */
const shellIconHrefs = (): { rel: string; href: string }[] => {
  const out: { rel: string; href: string }[] = []
  for (const tag of shell.match(/<link[^>]*>/g) ?? []) {
    const rel = /rel="([^"]*)"/.exec(tag)?.[1] ?? ''
    const href = /href="([^"]*)"/.exec(tag)?.[1] ?? ''
    if (rel.includes('icon') && href !== '') out.push({ rel, href })
  }
  return out
}

describe('the manifest names icons, and they are real', () => {
  it('declares icons at all', () => {
    // The manifest shipped with no `icons` array from 2026-08-07 to 2026-08-14 — seven days in which
    // adding the app to a home screen produced a screenshot of the page.
    expect(manifest.icons ?? [], 'the manifest declares no icons').not.toHaveLength(0)
  })

  it('every declared icon exists on disk', () => {
    for (const icon of manifest.icons ?? []) {
      const path = join(PUBLIC, icon.src.replace(/^\//, ''))
      expect(existsSync(path), `${icon.src} is named by the manifest and does not exist`).toBe(true)
    }
  })

  it('every declared size matches the file, and every icon is square', () => {
    for (const icon of manifest.icons ?? []) {
      const png = readPng(join(PUBLIC, icon.src.replace(/^\//, '')))
      const [declared] = icon.sizes.split(' ')
      expect(`${png.width}x${png.height}`, `${icon.src} is not the size it claims`).toBe(declared)
      expect(png.width, `${icon.src} is not square`).toBe(png.height)
      expect(icon.type, `${icon.src} declares a type it is not`).toBe('image/png')
    }
  })

  it('offers a maskable icon, so Android does not crop the artwork', () => {
    const purposes = (manifest.icons ?? []).map(i => i.purpose)
    expect(purposes, 'no maskable icon: Android crops a circle out of a square one')
      .toContain('maskable')
  })
})

describe('the shell names the icon iOS actually reads', () => {
  it('carries an apple-touch-icon link', () => {
    /**
     * **The one that matters most, and the one easiest to leave out**, because it looks redundant
     * beside a manifest that already declares icons. Safari ignores the manifest's `icons` for Add
     * to Home Screen and reads this link alone. §13.8 makes that install the only documented
     * exemption from WebKit's seven-day storage eviction, which the retained buffer depends on.
     */
    const apple = shellIconHrefs().filter(l => l.rel.includes('apple-touch-icon'))
    expect(apple, 'no apple-touch-icon: iOS will screenshot the page instead').toHaveLength(1)
    expect(apple[0]?.href).toMatch(/\.png$/)
  })

  it('every icon the shell links exists and is square', () => {
    const links = shellIconHrefs()
    expect(links.length).toBeGreaterThan(0)
    for (const { rel, href } of links) {
      const path = join(PUBLIC, href.replace(/^\//, ''))
      expect(existsSync(path), `${href} (rel="${rel}") is linked and does not exist`).toBe(true)
      const png = readPng(path)
      expect(png.width, `${href} is not square`).toBe(png.height)
    }
  })

  it('the apple-touch-icon declares the size it really is', () => {
    const tag = (shell.match(/<link[^>]*apple-touch-icon[^>]*>/g) ?? [])[0] ?? ''
    const sizes = /sizes="(\d+)x(\d+)"/.exec(tag)
    const href = /href="([^"]*)"/.exec(tag)?.[1] ?? ''
    expect(sizes, 'the apple-touch-icon declares no size').not.toBeNull()
    const png = readPng(join(PUBLIC, href.replace(/^\//, '')))
    expect(png.width).toBe(Number(sizes?.[1]))
  })
})

describe('the icons live where the build will actually emit them', () => {
  it('are under the client public directory', () => {
    /**
     * **Not an arrangement detail — it is the reason the paths in the manifest work.** Vite rewrites
     * asset URLs it finds in HTML and CSS; it does not parse the manifest's JSON. An icon imported
     * as a module would be content-hashed, and the manifest's unhashed reference to it would 404
     * silently. `public/` is copied to the dist root verbatim, so these names stay true.
     */
    for (const icon of manifest.icons ?? []) {
      expect(icon.src.startsWith('/'), `${icon.src} is not a root-absolute path`).toBe(true)
      expect(icon.src, `${icon.src} points into the hashed asset directory`).not.toContain('/assets/')
    }
  })

  it('the apple-touch-icon is opaque RGB or RGBA, never a palette', () => {
    // iOS composites a transparent icon onto black and then masks it, which puts a dark seam where
    // the artwork's own rounded corners were. `make-icons.py` fills the corners for exactly this
    // reason; colour type 2 (RGB) or 6 (RGBA) is what that produces.
    const png = readPng(join(PUBLIC, 'icon-180.png'))
    expect([2, 6]).toContain(png.colourType)
  })
})
