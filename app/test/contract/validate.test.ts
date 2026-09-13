import { describe, expect, it } from 'vitest'

import { ROUTES } from '../../src/contract/routes'
import {
  MAX_PATH_SEGMENTS, arrayOf, bool, displayName, int, location, object, pathSegment, str,
} from '../../src/contract/validate'
import { TransportErrorCode } from '../../src/contract/wire'

/**
 * The boundary's refusals. Spec §6 names four by hand — unknown keys, non-string paths,
 * prototype-pollution keys, over-limit bodies — and each one gets a test that fails without the
 * check, per the security review's standing principle that a control which has never rejected anything is
 * assumed non-functional.
 */

describe('strict objects — unknown keys are an error, not a warning', () => {
  const schema = object({ name: str() })

  it('accepts exactly the declared shape', () => {
    const result = schema({ name: 'ok' }, '$')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.name).toBe('ok')
  })

  it('refuses an extra key', () => {
    const result = schema({ name: 'ok', extra: 1 }, '$')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.code).toBe(TransportErrorCode.UNKNOWN_FIELD)
      expect(result.failure.at).toBe('$.extra')
    }
  })

  it('refuses an array where an object belongs', () => {
    // typeof [] === 'object', so this is the case a naive check misses.
    expect(schema([], '$').ok).toBe(false)
  })

  it('refuses null where an object belongs', () => {
    // typeof null === 'object' too.
    expect(schema(null, '$').ok).toBe(false)
  })

  it('names the failing field without echoing its value', () => {
    // Spec §6: errors carry no verbatim client strings. A path is safe; a value is not.
    const result = object({ name: str() })({ name: 12345 }, '$')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.at).toBe('$.name')
      expect(JSON.stringify(result.failure)).not.toContain('12345')
    }
  })
})

describe('prototype pollution — refused at the door', () => {
  // JSON.parse('{"__proto__":{}}') creates a REAL own property named __proto__. The damage happens
  // later, when something spreads or assigns it, which is why this is checked here and not there.
  const schema = object({ name: str() })

  it('refuses __proto__ as sent by a real JSON parse, not just an object literal', () => {
    const parsed = JSON.parse('{"name":"ok","__proto__":{"polluted":true}}') as unknown
    const result = schema(parsed, '$')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.detail).toBe('forbidden key')
  })

  it('refuses constructor and prototype too — the routes a partial defense misses', () => {
    /**
     * **ASSERTS THE REASON, NOT JUST THE REFUSAL — and it did not.** The old version checked only
     * `.ok === false`, which the UNKNOWN_FIELD branch three lines below also delivers. So cutting
     * `POISON_KEYS` down to `['__proto__']` left this green: `constructor` and `prototype` were
     * still refused, but as *unknown fields*, entirely by accident of not being in the shape.
     *
     * That accident is not a defence. The moment a schema legitimately has a field named
     * `constructor`, the unknown-field branch stops firing and the poison key sails through — and
     * this test would still be green.
     */
    for (const key of ['constructor', 'prototype', '__proto__']) {
      const parsed = JSON.parse(`{"name":"ok","${key}":{}}`) as unknown
      const result = schema(parsed, '$')

      expect(result.ok, `${key} must be refused`).toBe(false)
      if (!result.ok) {
        expect(result.failure.detail, `${key} is a POISON KEY, not merely unrecognised`)
          .toBe('forbidden key')
        expect(result.failure.code, 'and refused as a bad request, not an unknown field')
          .toBe(TransportErrorCode.BAD_REQUEST)
      }
    }
  })

  it('nothing was actually polluted while proving the above', () => {
    // If the checks were absent AND something assigned, this is what would have broken.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('a validated result has a null prototype, so a survivor could not reach Object.prototype', () => {
    const result = schema({ name: 'ok' }, '$')
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.getPrototypeOf(result.value)).toBeNull()
  })
})

describe('path segments', () => {
  const seg = pathSegment()

  it('accepts an ordinary name, including one with spaces', () => {
    expect(seg('notes.md', '$').ok).toBe(true)
    expect(seg('Field Report 2026.md', '$').ok, 'spaces are legal in filenames').toBe(true)
  })

  it('refuses a non-string', () => {
    for (const bad of [1, null, undefined, {}, []]) {
      expect(seg(bad, '$').ok, `${JSON.stringify(bad)} must be refused`).toBe(false)
    }
  })

  it('refuses empty, dot and dot-dot', () => {
    for (const bad of ['', '.', '..']) {
      expect(seg(bad, '$').ok, `"${bad}" must be refused`).toBe(false)
    }
  })

  it('refuses separators, so an absolute path cannot be smuggled through a segment', () => {
    for (const bad of ['a/b', '/etc', 'a\\b', '..\\..\\x']) {
      expect(seg(bad, '$').ok, `"${bad}" must be refused`).toBe(false)
    }
  })

  it('refuses a real NUL — and accepts a space, which is what makes the check reviewable', () => {
    // These two assertions exist as a pair on purpose. A literal NUL in source renders as a space,
    // so a check written with a typed NUL and one written with a typed space are visually
    // IDENTICAL in every editor, diff and code review — including this comment, whose first
    // draft demonstrated the problem by containing one.
    // The pair distinguishes them: only the correct version passes both lines.
    expect(seg('bad\u0000name.md', '$').ok, 'NUL must be refused').toBe(false)
    expect(seg('good name.md', '$').ok, 'a space must NOT be refused').toBe(true)
  })

  it('refuses an over-long segment', () => {
    expect(seg('x'.repeat(256), '$').ok).toBe(false)
    expect(seg('x'.repeat(255), '$').ok).toBe(true)
  })
})

describe('location — the only way the API addresses a file', () => {
  const loc = location()

  it('accepts a rootId and segments', () => {
    const result = loc({ rootId: 'soil', segments: ['02-projects', 'notes.md'] }, '$')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.segments).toEqual(['02-projects', 'notes.md'])
  })

  it('accepts an empty segment list — that is the root itself, not a failure', () => {
    expect(loc({ rootId: 'soil', segments: [] }, '$').ok).toBe(true)
  })

  it('has NO SHAPE that can carry an absolute path', () => {
    // Spec §6's rule is enforced by absence, not by a leading-slash check: an absolute path has to
    // arrive either as a separator inside a segment or as an empty first segment, and both are
    // refused by pathSegment. There is no third route, which is why there is no fourth assertion.
    expect(loc({ rootId: 'soil', segments: ['/Users/hallberg/notes'] }, '$').ok).toBe(false)
    expect(loc({ rootId: 'soil', segments: ['', 'Users'] }, '$').ok).toBe(false)
    expect(loc({ rootId: 'soil', path: '/Users/hallberg' }, '$').ok, 'no path field exists').toBe(false)
  })

  it('refuses a traversal attempt', () => {
    expect(loc({ rootId: 'soil', segments: ['..', '..', 'etc'] }, '$').ok).toBe(false)
  })

  it('refuses more segments than the limit, as a payload failure not a path failure', () => {
    const result = loc({ rootId: 'soil', segments: Array(MAX_PATH_SEGMENTS + 1).fill('a') }, '$')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe(TransportErrorCode.PAYLOAD_TOO_LARGE)
  })

  it('reports the failing segment by index', () => {
    const result = loc({ rootId: 'soil', segments: ['ok', '..'] }, '$')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.at).toBe('$.segments[1]')
  })
})

describe('scalars', () => {
  it('int refuses NaN, Infinity and unsafe integers, which are all typeof number', () => {
    const v = int(0, 100)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 1.5]) {
      expect(v(bad, '$').ok, `${String(bad)} must be refused`).toBe(false)
    }
    expect(v(50, '$').ok).toBe(true)
  })

  it('int enforces its bounds at both ends', () => {
    const v = int(1, 10)
    expect(v(0, '$').ok).toBe(false)
    expect(v(11, '$').ok).toBe(false)
    expect(v(1, '$').ok).toBe(true)
    expect(v(10, '$').ok).toBe(true)
  })

  it('str and bool refuse coercible lookalikes rather than coercing them', () => {
    expect(str()(1, '$').ok).toBe(false)
    expect(bool()('true', '$').ok).toBe(false)
    expect(bool()(1, '$').ok).toBe(false)
  })

  it('arrayOf refuses a non-array and enforces its length cap', () => {
    const v = arrayOf(str(), 2)
    expect(v('nope', '$').ok).toBe(false)
    expect(v(['a', 'b', 'c'], '$').ok).toBe(false)
    expect(v(['a', 'b'], '$').ok).toBe(true)
  })
})

/**
 * **the security review's P9F-5.** A control character typed into quick-add reached the file, because the path is
 * slugified but annex A5's seed carries the raw name. **A file containing a NUL is classified as
 * binary and silently skipped by every plain `grep`** -- in the user's notes tree, where their own
 * agents are told to search by grepping.
 *
 * The concession and the danger are the same mechanism, which is why they are tested together: the
 * check runs against `input.trim()`, so a pasted trailing newline is fine -- and **`trim()` does not
 * remove NUL**, so the character that motivated the rule cannot ride in on the concession made for
 * the ones that are harmless.
 *
 * **The control characters are BUILT, never typed.** `ctrl()` keeps this file printable end to end.
 * The first draft used literals; they were stripped in transit, which silently turned each subject
 * into its own control and would have inverted every assertion without failing loudly. A literal
 * NUL would also trip this build's own NUL gate over `test/`. Line terminators and tab stay as
 * ordinary escapes because those survive being written down.
 */
const ctrl = (code: number): string => String.fromCharCode(code)
const NUL = ctrl(0)

describe('displayName -- a control character never reaches a file', () => {
  const v = displayName()

  it('refuses a NUL, which is the whole point', () => {
    expect(v('quarterly' + NUL + ' review', '$').ok).toBe(false)
  })

  it('refuses a NUL that surrounding whitespace would seem to excuse', () => {
    // trim() strips whitespace and line terminators. NUL is neither, so it survives and is caught.
    expect(v('  \n ' + NUL + ' \t ', '$').ok).toBe(false)
    expect(v('\n  review ' + NUL + '   \n', '$').ok).toBe(false)
  })

  it('refuses an interior newline, which would split A5 seed into two blocks', () => {
    expect(v('quarterly\nreview', '$').ok).toBe(false)
    expect(v('quarterly\r\nreview', '$').ok).toBe(false)
  })

  it('refuses an interior tab, DEL, and the rest of the C0 range', () => {
    expect(v('quarterly\treview', '$').ok).toBe(false)
    expect(v('quarterly' + ctrl(0x7f) + 'review', '$').ok).toBe(false)
    for (let code = 0; code <= 0x1f; code++) {
      expect(v('quarterly' + ctrl(code) + 'review', '$').ok, 'C0 ' + code).toBe(false)
    }
  })

  it('ACCEPTS a name pasted with surrounding whitespace, because the seed trims it anyway', () => {
    expect(v('  Quarterly review\n', '$').ok).toBe(true)
    expect(v('\tQuarterly review\r\n', '$').ok).toBe(true)
  })

  it('does not over-refuse: ordinary names, punctuation and non-ASCII all pass', () => {
    // The failure opposite to letting NUL through, and this build has produced it before: a rule
    // aimed at control characters that quietly refuses the user's real filenames.
    for (const name of ['Quarterly review', 'Cafe -- notes (v2)', '#1: 50%', 'plan']) {
      expect(v(name, '$').ok, name).toBe(true)
    }
  })

  it('refuses a non-string rather than coercing it', () => {
    expect(v(1, '$').ok).toBe(false)
    expect(v(null, '$').ok).toBe(false)
    expect(v(['a'], '$').ok).toBe(false)
  })

  it('leaves emptiness to someone else -- this is about characters, not length', () => {
    // Recorded rather than assumed: a blank name is refused downstream by slugification, and
    // bounding a field's SIZE is P8-10's business. Asserting otherwise here would claim coverage
    // this validator does not provide.
    expect(v('', '$').ok).toBe(true)
    expect(v('   ', '$').ok).toBe(true)
  })
})

/**
 * The rule is only real where it is wired. Each route here turns a typed name into a filename, into
 * the heading seeded into a new file, or into a label persisted in the config -- the two shapes
 * P9F-5 and P9-5 named.
 */
describe('every route carrying a typed name refuses a control character in it', () => {
  const CLEAN = 'quarterly review'
  const DIRTY = 'quarterly ' + NUL + ' review'

  /**
   * Built from the name rather than substituted into a serialised copy: `JSON.stringify` escapes a
   * NUL, so a split/join over the JSON text would never match and the control would be identical to
   * the subject. Caught while writing this.
   */
  const payloadsFor = (name: string): Record<string, Record<string, unknown>> => ({
    'card.create': { rootId: 'soil', project: ['02-projects', 'cider-line'], laneId: 'next', name },
    'entry.create': { rootId: 'soil', parent: ['02-projects'], name, kind: 'file' },
    'templates.register': { id: 't1', name, rootId: 'soil', segments: ['templates', 'project'] },
    'projects.stage': { id: '', name, body: 'ordinary prose', columnId: 'c1' },
    'projects.setColumns': { columns: [{ id: 'c1', name }] },
  })

  for (const route of Object.keys(payloadsFor(CLEAN))) {
    it(route + ' refuses it', () => {
      const input = ROUTES[route as keyof typeof ROUTES].input
      if (input === undefined) throw new Error(route + ' declares no input schema')

      // The control. Without it a refusal proves nothing: a typo in the payload reds identically.
      expect(input(payloadsFor(CLEAN)[route], '$').ok, route + ' control').toBe(true)
      expect(input(payloadsFor(DIRTY)[route], '$').ok, route + ' subject').toBe(false)
    })
  }
})
