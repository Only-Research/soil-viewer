import { describe, expect, it } from 'vitest'

import { CSP_DIRECTIVES, cspHeaderValue, securityHeaders } from '../../src/server/csp'

/**
 * THE CSP HEADER GATE. The security review's second gate-1 ruling, item (d) — the named, blocking Phase 2
 * commitment that **eighteen deleted lint rules were traded for.**
 *
 * The deleted rules scanned the whole codebase for string literals, one selector per directive.
 * They were defeated by writing the policy as a template literal, which is how anyone writes one.
 * This test instead **parses the value the server actually emits**, which is why it does not care
 * how the string was built and needs no hardcoded directive list of its own.
 *
 * The four required assertions, from the ruling:
 *   1. parse the emitted header value, not a literal anywhere in the tree;
 *   2. no `'unsafe-inline'` in any directive except `style-src`;
 *   3. no `'unsafe-eval'` in any directive at all;
 *   4. every directive present is one we meant to ship — an ALLOWLIST, so a new directive is a
 *      failure rather than a silent addition. The old rules hardcoded sixteen names and
 *      `child-src`, `style-src-elem` and `prefetch-src` were holes; an allowlist inverts that.
 */

/** Parses the emitted header the way a browser would: split on `;`, first token is the name. */
function parse(header: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const clause of header.split(';')) {
    const parts = clause.trim().split(/\s+/).filter(p => p.length > 0)
    const [name, ...values] = parts
    if (name === undefined) continue
    out.set(name.toLowerCase(), values)
  }
  return out
}

/**
 * The allowlist. Adding a directive to the policy without adding it here fails the build, which is
 * the inversion the ruling asked for: coverage is no longer a list someone has to remember to
 * extend.
 */
const INTENDED = new Set([
  'default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src',
  'manifest-src', 'worker-src', 'frame-src', 'media-src', 'object-src',
  'base-uri', 'form-action', 'frame-ancestors', 'require-trusted-types-for',
])

describe('the CSP header — parsed as emitted', () => {
  const policy = parse(cspHeaderValue())

  it('parses into directives at all', () => {
    // Guards every assertion below: an unparseable or empty header would make them all vacuous.
    expect(policy.size).toBeGreaterThan(10)
    expect(policy.has('default-src')).toBe(true)
  })

  it("permits 'unsafe-inline' ONLY in style-src", () => {
    const offenders: string[] = []
    for (const [name, values] of policy) {
      if (name === 'style-src') continue
      if (values.includes("'unsafe-inline'")) offenders.push(name)
    }
    expect(offenders, "'unsafe-inline' outside style-src kills the policy").toEqual([])
    expect(policy.get('style-src'), 'style-src legitimately carries it — 316 inline style attributes')
      .toContain("'unsafe-inline'")
  })

  it("contains 'unsafe-eval' in no directive at all", () => {
    for (const [name, values] of policy) {
      expect(values, `${name} must not permit unsafe-eval`).not.toContain("'unsafe-eval'")
    }
    expect(cspHeaderValue()).not.toContain('unsafe-eval')
  })

  it('contains only directives we meant to ship', () => {
    const unexpected = [...policy.keys()].filter(name => !INTENDED.has(name))
    expect(unexpected, 'a directive was added to the policy but not to the allowlist').toEqual([])
  })

  it('ships every directive spec §8 lists — none silently dropped', () => {
    // The converse of the allowlist. The two together mean the emitted set is exactly the intended
    // set, in both directions.
    const missing = [...INTENDED].filter(name => !policy.has(name))
    expect(missing, 'spec §8 names these and the header does not carry them').toEqual([])
  })

  it('locks down the directives v1 left off entirely', () => {
    // v1's policy was missing five. Each of these is a real capability if left unset.
    expect(policy.get('object-src')).toEqual(["'none'"])
    expect(policy.get('base-uri')).toEqual(["'none'"])
    expect(policy.get('form-action')).toEqual(["'none'"])
    expect(policy.get('frame-ancestors')).toEqual(["'none'"])
    expect(policy.get('require-trusted-types-for')).toEqual(["'script'"])
  })

  it("sets default-src to 'none', not 'self'", () => {
    // F3.2: `default-src 'self'` blocks inline style attributes, of which the inherited design
    // language has 316. A builder hitting that adds 'unsafe-inline' — possibly to default-src —
    // and kills the whole policy. 'none' plus explicit per-directive grants avoids the trap.
    expect(policy.get('default-src')).toEqual(["'none'"])
  })

  it('does not allow remote script or connect sources', () => {
    // "Zero outbound network" for content, not just for the app's own calls.
    for (const directive of ['script-src', 'connect-src', 'font-src', 'worker-src']) {
      const values = policy.get(directive) ?? []
      for (const value of values) {
        expect(value, `${directive} must not name a remote origin`).not.toContain('//')
        expect(value, `${directive} must not use a wildcard`).not.toBe('*')
      }
    }
  })

  it('permits data: for images only — never for scripts or frames', () => {
    expect(policy.get('img-src')).toContain('data:')
    for (const directive of ['script-src', 'frame-src', 'object-src', 'worker-src']) {
      expect(policy.get(directive) ?? [], `${directive} must not permit data:`).not.toContain('data:')
    }
  })
})

describe('the emitted string is well-formed', () => {
  it('round-trips: parsing then re-emitting yields the same directives', () => {
    const reparsed = parse(cspHeaderValue())
    expect([...reparsed.keys()].sort()).toEqual(CSP_DIRECTIVES.map(([n]) => n).sort())
  })

  it('has no empty directive and no directive without a value', () => {
    for (const [name, values] of parse(cspHeaderValue())) {
      expect(name.length, 'empty directive name').toBeGreaterThan(0)
      expect(values.length, `${name} has no value, which silently permits nothing or everything`)
        .toBeGreaterThan(0)
    }
  })

  it('contains no newline or control character that could split the header', () => {
    // Header injection: a newline in a header value ends the header and starts another.
    // Escapes, not literals: a raw control character in source is invisible in every editor
    // and review, which is how a check like this ends up asserting nothing.
    expect(/[\u0000-\u001f\u007f]/.test(cspHeaderValue())).toBe(false)
  })

  it('names no directive twice — the second is ignored by browsers', () => {
    const names = CSP_DIRECTIVES.map(([n]) => n)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('the other security headers', () => {
  const headers = securityHeaders()

  it('sends the CSP on every response', () => {
    expect(headers['content-security-policy']).toBe(cspHeaderValue())
  })

  it('sends nosniff, no-referrer and no-store', () => {
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('no-referrer')
    expect(headers['cache-control']).toBe('no-store')
  })

  it('sends NO CORS headers — their absence is the control', () => {
    // Spec §7: answering a preflight is how the preflight stops being a defense. This asserts the
    // absence explicitly, because an absence nobody checks is one a helpful builder later fills in.
    for (const name of Object.keys(headers)) {
      expect(name.toLowerCase(), `${name} is a CORS header`).not.toContain('access-control')
    }
  })
})
