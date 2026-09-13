import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/core/errors'
import {
  comparisonKey,
  isWithin,
  relativeTo,
  segmentsEqual,
  splitSegments,
  validateRelativePath,
} from '../../src/core/paths'

/** Asserts a refusal with the exact code, so a test cannot pass on the wrong rejection. */
function expectRefused(input: unknown, code: ErrorCode): void {
  const result = validateRelativePath(input)
  expect(result.ok, `expected refusal for ${JSON.stringify(input)}`).toBe(false)
  if (!result.ok) expect(result.code, `wrong code for ${JSON.stringify(input)}`).toBe(code)
}

function expectAccepted(input: string, segments: string[]): void {
  const result = validateRelativePath(input)
  expect(result.ok, `expected acceptance for ${JSON.stringify(input)}`).toBe(true)
  if (result.ok) expect(result.value).toEqual(segments)
}

describe('validateRelativePath — accepts ordinary paths', () => {
  it('accepts a simple relative path', () => {
    expectAccepted('notes.md', ['notes.md'])
    expectAccepted('02-projects/field-review/context.md', ['02-projects', 'field-review', 'context.md'])
  })

  it('accepts non-ASCII names', () => {
    expectAccepted('café/résumé.md', ['café', 'résumé.md'])
  })

  it('accepts a name containing a percent-decoded space', () => {
    expectAccepted('my%20notes.md', ['my notes.md'])
  })

  it('accepts a backslash as an ordinary character — it is legal in a macOS filename', () => {
    // Not a separator on this platform. It never reaches a shell either: spec §10 bans
    // string interpolation into a command line, and that ban is lint-enforced.
    expectAccepted('weird\\name.md', ['weird\\name.md'])
  })
})

// the security review's required path-traversal containment tests. Every entry must be REFUSED.
// A control that has never rejected anything is assumed non-functional.
describe('validateRelativePath — traversal corpus, all refused', () => {
  it('refuses plain traversal', () => {
    expectRefused('../etc/passwd', ErrorCode.PATH_TRAVERSAL)
    expectRefused('..', ErrorCode.PATH_TRAVERSAL)
    expectRefused('a/../b', ErrorCode.PATH_TRAVERSAL)
    expectRefused('a/..', ErrorCode.PATH_TRAVERSAL)
  })

  it('refuses single-dot segments', () => {
    expectRefused('.', ErrorCode.PATH_TRAVERSAL)
    expectRefused('a/./b', ErrorCode.PATH_TRAVERSAL)
  })

  it('refuses empty segments, including a trailing separator', () => {
    expectRefused('a//b', ErrorCode.PATH_TRAVERSAL)
    expectRefused('a/b/', ErrorCode.PATH_TRAVERSAL)
  })

  it('refuses percent-encoded traversal after one decode', () => {
    expectRefused('..%2f..%2fetc', ErrorCode.PATH_TRAVERSAL)
    expectRefused('%2e%2e/passwd', ErrorCode.PATH_TRAVERSAL)
    expectRefused('%2E%2E/passwd', ErrorCode.PATH_TRAVERSAL)
  })

  it('refuses double-encoding rather than decoding it twice', () => {
    // The classic bypass: one decode yields `%2e%2e`, and a second would yield `..`.
    // We refuse the surviving `%` instead of decoding again.
    expectRefused('%252e%252e/passwd', ErrorCode.PATH_ENCODING)
    expectRefused('a/%252f/b', ErrorCode.PATH_ENCODING)
  })

  it('refuses malformed escapes instead of passing them through', () => {
    // Both throw inside decodeURIComponent rather than leaving a `%` behind: `%ff` is not
    // valid UTF-8, and `%zz` is not a valid escape at all. Refused either way — the code
    // distinguishes them from double-encoding, which fails as PATH_ENCODING above.
    expectRefused('%ff', ErrorCode.PATH_MALFORMED_ESCAPE)
    expectRefused('%zz', ErrorCode.PATH_MALFORMED_ESCAPE)
  })

  it('refuses a bare trailing percent', () => {
    expectRefused('notes.md%', ErrorCode.PATH_MALFORMED_ESCAPE)
  })

  it('refuses absolute paths', () => {
    expectRefused('/etc/passwd', ErrorCode.PATH_NOT_RELATIVE)
    expectRefused('/', ErrorCode.PATH_NOT_RELATIVE)
  })

  it('refuses drive letters and UNC-looking input', () => {
    expectRefused('C:/Windows/System32', ErrorCode.PATH_NOT_RELATIVE)
    expectRefused('c:', ErrorCode.PATH_NOT_RELATIVE)
  })

  it('refuses NUL, raw and encoded', () => {
    expectRefused('a\0b', ErrorCode.PATH_NUL)
    expectRefused('notes.md%00.txt', ErrorCode.PATH_NUL)
  })

  it('refuses empty and non-string input', () => {
    expectRefused('', ErrorCode.PATH_EMPTY)
    expectRefused(null, ErrorCode.PATH_EMPTY)
    expectRefused(undefined, ErrorCode.PATH_EMPTY)
    expectRefused(42, ErrorCode.PATH_EMPTY)
    expectRefused(['a'], ErrorCode.PATH_EMPTY)
    expectRefused({ toString: () => 'a' }, ErrorCode.PATH_EMPTY)
  })
})

describe('validateRelativePath — normalization form is itself a control', () => {
  it('NFC does not manufacture a traversal sequence from fullwidth dots', () => {
    // U+FF0E FULLWIDTH FULL STOP. Under NFKC this becomes '.', which would turn this input
    // into '../'. Under NFC it stays put and is an ordinary (odd) filename.
    // If someone ever "upgrades" the normalization to NFKC, this test fails and tells them why.
    const result = validateRelativePath('．．/notes.md')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value[0]).not.toBe('..')
      expect(result.value).toEqual(['．．', 'notes.md'])
    }
  })

  it('composes a decomposed name without changing its segment count', () => {
    const result = validateRelativePath('cafe\u0301/note.md')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(['café', 'note.md'])
  })
})

describe('isWithin — segment boundaries, not string prefixes', () => {
  const root = ['soil', 'notes']

  it('accepts a path inside the root', () => {
    expect(isWithin(root, ['soil', 'notes', 'a.md'], false)).toBe(true)
  })

  it('accepts the root itself', () => {
    expect(isWithin(root, ['soil', 'notes'], false)).toBe(true)
  })

  it('REFUSES a sibling whose name merely starts with the root name', () => {
    // This is the lab bug, preserved as a test: /soil/notes must not match /soil/notes-old.
    // A raw startsWith would have returned true here and misattributed every watcher event.
    expect(isWithin(root, ['soil', 'notes-old', 'a.md'], false)).toBe(false)
    expect(isWithin(root, ['soil', 'notesold'], false)).toBe(false)
  })

  it('refuses a shorter path', () => {
    expect(isWithin(root, ['soil'], false)).toBe(false)
  })

  it('refuses a different tree', () => {
    expect(isWithin(root, ['other', 'notes', 'a.md'], false)).toBe(false)
  })

  it('honours the per-root case sensitivity flag', () => {
    expect(isWithin(root, ['SOIL', 'NOTES', 'a.md'], true)).toBe(true)
    expect(isWithin(root, ['SOIL', 'NOTES', 'a.md'], false)).toBe(false)
  })

  it('matches across NFC and NFD spellings of the same folder', () => {
    const accented = ['soil', 'caf\u00e9']
    const decomposed = ['soil', 'cafe\u0301', 'a.md']
    expect(isWithin(accented, decomposed, false)).toBe(true)
  })
})

describe('relativeTo', () => {
  it('returns the remainder inside the root', () => {
    expect(relativeTo(['soil'], ['soil', 'a', 'b.md'], false)).toEqual(['a', 'b.md'])
  })

  it('returns an empty array for the root itself', () => {
    expect(relativeTo(['soil'], ['soil'], false)).toEqual([])
  })

  it('returns null for the prefix-sibling case rather than a wrong remainder', () => {
    expect(relativeTo(['soil', 'notes'], ['soil', 'notes-old', 'a.md'], false)).toBeNull()
  })
})

describe('segmentsEqual and comparisonKey', () => {
  it('folds case only when the volume is case-insensitive', () => {
    expect(segmentsEqual('Notes.md', 'notes.md', true)).toBe(true)
    expect(segmentsEqual('Notes.md', 'notes.md', false)).toBe(false)
  })

  it('treats NFC and NFD as equal on both volume kinds', () => {
    expect(segmentsEqual('caf\u00e9', 'cafe\u0301', false)).toBe(true)
    expect(segmentsEqual('caf\u00e9', 'cafe\u0301', true)).toBe(true)
  })

  it('produces one key for every spelling on a case-insensitive volume', () => {
    const keys = new Set([
      comparisonKey(['A', 'Caf\u00e9.md'], true),
      comparisonKey(['a', 'cafe\u0301.md'], true),
      comparisonKey(['A', 'CAFE\u0301.MD'], true),
    ])
    expect(keys.size).toBe(1)
  })

  it('keeps distinct keys on a case-sensitive volume', () => {
    expect(comparisonKey(['A.md'], false)).not.toBe(comparisonKey(['a.md'], false))
  })
})

describe('splitSegments', () => {
  it('drops empty segments from an already-validated path', () => {
    expect(splitSegments('a/b/c.md')).toEqual(['a', 'b', 'c.md'])
  })
})
