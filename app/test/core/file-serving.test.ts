import { describe, expect, it } from 'vitest'

import {
  MAX_SERVED_BYTES,
  MAX_TEXT_BYTES,
  contentDisposition,
  servingDecisionFor,
} from '../../src/core/file-serving'

const decide = (name: string, size = 1024) => servingDecisionFor(name, size)

/**
 * §9'S FORBIDDEN LIST, ENUMERATED.
 *
 * The source implements an allowlist and no deny-list, because two controls saying one thing drift.
 * The spec's deny-list therefore lives **here**, one assertion per extension, checked against
 * behaviour rather than against a second copy of the list in `src/`.
 *
 *   *"`.svg` MUST NEVER be served as `image/svg+xml`. Same exclusion for `.svgz .html .htm .xhtml
 *   .xht .xml .xsl .xslt .mhtml .webmanifest .js .mjs`."*
 */
describe('the extensions that must never carry a renderable type — §9', () => {
  const FORBIDDEN = [
    'svg', 'svgz', 'html', 'htm', 'xhtml', 'xht', 'xml', 'xsl', 'xslt', 'mhtml',
    'webmanifest', 'js', 'mjs',
  ]

  for (const extension of FORBIDDEN) {
    it(`.${extension} downloads as octet-stream`, () => {
      const decision = decide(`payload.${extension}`)
      expect(decision.kind).toBe('download')
      expect(decision.contentType).toBe('application/octet-stream')
    })
  }

  it('and none of them can ever produce image/svg+xml, whatever the case', () => {
    for (const name of ['a.svg', 'a.SVG', 'a.SvG', 'a.svgz', 'a.HTML']) {
      expect(decide(name).contentType).not.toContain('svg')
      expect(decide(name).contentType).not.toContain('html')
    }
  })

  it('a double extension is judged on the LAST one, which is what a browser reads', () => {
    // `report.pdf.svg` is an SVG. Judging on `.pdf` would serve a script as a document.
    expect(decide('report.pdf.svg').kind).toBe('download')
    // And the reverse is still fine: `.svg.pdf` really is a PDF by name.
    expect(decide('drawing.svg.pdf').contentType).toBe('application/pdf')
  })
})

describe('the images and documents that may render in place', () => {
  it.each([
    ['photo.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['photo.gif', 'image/gif'],
    ['photo.webp', 'image/webp'],
    ['photo.heic', 'image/heic'],
    ['report.pdf', 'application/pdf'],
  ])('%s is %s', (name, type) => {
    const decision = decide(name)
    expect(decision.kind).toBe('inline')
    expect(decision.contentType).toBe(type)
  })

  it('matches the extension case-insensitively', () => {
    expect(decide('PHOTO.PNG').contentType).toBe('image/png')
  })

  it('an image stays inline at any size — the 25 MiB refusal is the server\'s, not this', () => {
    expect(decide('huge.png', MAX_SERVED_BYTES * 4).kind).toBe('inline')
  })
})

describe('FT-10, the read-only plain-text pane', () => {
  it.each(['notes.txt', 'data.json', 'config.yml', 'rows.csv'])('%s reads as text', name => {
    const decision = decide(name)
    expect(decision.kind).toBe('text')
    expect(decision.contentType).toBe('text/plain; charset=utf-8')
  })

  it('LICENSE, with no extension at all, in any spelling', () => {
    expect(decide('LICENSE').kind).toBe('text')
    expect(decide('license').kind).toBe('text')
    expect(decide('License').kind).toBe('text')
  })

  /**
   * The set is CLOSED, and these are the near-misses most likely to be waved through by someone
   * reading the source rather than the spec. Extending it is a spec change, not an edit.
   */
  it('does NOT include .yaml, .ini, .log, .conf, .xml or .md', () => {
    for (const name of ['a.yaml', 'a.ini', 'a.log', 'a.conf', 'a.xml']) {
      expect(decide(name).kind, name).toBe('download')
    }
    // `.md` belongs to the editor, and this endpoint must never become a second way to read one.
    expect(decide('notes.md').kind).toBe('download')
  })

  it('does not include README or CHANGELOG — §9 names LICENSE alone', () => {
    expect(decide('README').kind).toBe('download')
    expect(decide('CHANGELOG').kind).toBe('download')
  })

  it('falls back to a download past 256 KiB, rather than a truncated view', () => {
    expect(decide('big.json', MAX_TEXT_BYTES).kind).toBe('text')
    expect(decide('big.json', MAX_TEXT_BYTES + 1).kind).toBe('download')
  })
})

describe('anything unrecognised downloads', () => {
  it.each(['archive.zip', 'binary.bin', 'app.dmg', 'script.sh', 'noextension', ''])(
    '%s is an octet-stream attachment',
    name => {
      expect(decide(name).kind).toBe('download')
    },
  )

  it('a dotfile has no extension and is not text — `.md` is a hidden file, not markdown', () => {
    expect(decide('.md').kind).toBe('download')
    expect(decide('.env').kind).toBe('download')
  })
})

/**
 * §9: *"a raw filename in a header is header injection"*.
 *
 * A macOS filename may legally contain a quote, a newline, and a carriage return. Dropped into a
 * header value unescaped, that is two headers.
 */
describe('Content-Disposition, and the header injection it prevents', () => {
  it('percent-encodes CR and LF out of existence', () => {
    const nasty = 'report.pdf"\r\nSet-Cookie: session=stolen'
    const header = contentDisposition('attachment', nasty)
    expect(header).not.toContain('\r')
    expect(header).not.toContain('\n')
    expect(header).not.toContain('Set-Cookie: session')
  })

  it('leaves no bare quote in the ASCII fallback, which would end the quoted string early', () => {
    const header = contentDisposition('attachment', 'a"b.png')
    const fallback = /filename="([^"]*)"/.exec(header)?.[1]
    expect(fallback).toBe('a_b.png')
  })

  it('carries the real name in the extended form', () => {
    const header = contentDisposition('inline', '日本語のファイル.png')
    expect(header).toContain("filename*=UTF-8''")
    expect(decodeURIComponent(header.split("UTF-8''")[1] ?? '')).toBe('日本語のファイル.png')
  })

  it('gives an unnameable file something nameable rather than filename=""', () => {
    expect(contentDisposition('attachment', '...')).toContain('filename="download"')
    expect(contentDisposition('attachment', '日本語')).toContain('filename="download"')
  })

  it('says inline or attachment as asked', () => {
    expect(contentDisposition('inline', 'a.png').startsWith('inline;')).toBe(true)
    expect(contentDisposition('attachment', 'a.zip').startsWith('attachment;')).toBe(true)
  })

  /**
   * Every character a filename can legally hold, run through the encoder, asserting one property:
   * the result contains no character that can terminate a header or a quoted string.
   */
  it('no legal filename produces a header-breaking value', () => {
    for (let code = 1; code < 0x2100; code += 1) {
      // `/` and NUL are the two bytes a macOS filename cannot contain.
      if (code === 0x2f) continue
      const header = contentDisposition('attachment', `a${String.fromCodePoint(code)}b.png`)
      expect(header, `code point ${code}`).not.toMatch(/[\r\n]/)
      // Exactly two quotes: the pair around the ASCII fallback.
      expect((header.match(/"/g) ?? []).length, `code point ${code}`).toBe(2)
    }
  })
})
