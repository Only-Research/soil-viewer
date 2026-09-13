/**
 * The Content-Security-Policy. Spec §8, verbatim.
 *
 * **This module and its test are the replacement for eighteen deleted lint rules.**
 *
 * Until 2026-08-07 the CSP was policed by seventeen `no-restricted-syntax` selectors — one per
 * directive — plus one for `unsafe-eval`, each scanning the whole codebase for a string literal.
 * the security review's second gate-1 ruling deleted all eighteen, on the finding that they enforced a
 * **single-site invariant with a whole-codebase text scan**: every selector matched `Literal` only,
 * so a policy written as a template literal — the normal way anyone writes one — walked past all of
 * them, as did concatenation and `.join()`. Adding `TemplateLiteral` would have bought one round.
 *
 * The trade was explicit: eighteen hollow controls out, one real one in, and the real one is a
 * **named, blocking Phase 2 gate**. So shipping P2 without the test below is not a deferral, it is
 * a net loss of coverage. It parses the value this module actually emits, which means it does not
 * care how the string was built, needs no hardcoded directive list, and tests what reaches the
 * browser rather than what sits in the source tree.
 *
 * WHY THE POLICY READS THE WAY IT DOES. v1's was missing five directives and set one that is
 * unimplementable: `default-src 'self'` blocks inline `style=` attributes, and the inherited design
 * language carries **316 of them**. A tired builder hitting that would have added `'unsafe-inline'`
 * — quite possibly to `default-src` — and killed the entire policy. So `style-src` carries it
 * explicitly and narrowly, and `default-src` is `'none'` rather than `'self'`.
 */

/**
 * The policy, as directives. Structured rather than one string so the test can assert over it and
 * the header can be built from it — the same reason spec §6's route table is data.
 */
export const CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['default-src', ["'none'"]],
  ['script-src', ["'self'"]],
  // The one place 'unsafe-inline' is permitted, and only here. See the note above.
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', ["'self'", 'data:']],
  ['font-src', ["'self'"]],
  ['connect-src', ["'self'"]],
  ['manifest-src', ["'self'"]],
  ['worker-src', ["'self'"]],
  ['frame-src', ["'self'"]],
  ['media-src', ["'self'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'none'"]],
  ['frame-ancestors', ["'none'"]],
  ['require-trusted-types-for', ["'script'"]],
]

/** The header value. Spec §8: a response header on every response **including errors**. */
export function cspHeaderValue(): string {
  return CSP_DIRECTIVES.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ')
}

/**
 * Every security header sent on every response.
 *
 * `no-store` is here because a response carrying file contents must not sit in a disk cache after
 * the app is closed — the same instinct as §9's "bytes, never documents".
 */
export function securityHeaders(): Readonly<Record<string, string>> {
  return {
    'content-security-policy': cspHeaderValue(),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    // No CORS headers, ever. Spec §7: answering a preflight is how the preflight stops being a
    // defense. Their absence is load-bearing, so it is stated here rather than left implicit.
  }
}
