/**
 * The security headers, asserted against the REAL server serving the REAL bundle.
 *
 * There is already a unit test that parses the emitted CSP — the one the security review took in trade for
 * eighteen deleted lint rules. This is not that test repeated. That test proves the string this
 * codebase *builds* is correct; this proves the string actually *reaches a browser* on the product
 * a user runs, across the routes a user hits, including the ones that fail.
 *
 * Spec §8: the policy is "a response header on every response **including errors**." A test that
 * only checks the happy path cannot see the case that sentence was written about.
 */

import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, request as playwrightRequest, test } from '@playwright/test'

import { E2E_ROOT_ID, E2E_TREE } from '../../playwright.config'
import { PORT_TAILNET } from './ports'

/** Directives whose absence or weakening would be the whole point. Not the full policy — the gate. */
const REQUIRED = [
  "default-src 'none'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
]

test('the shell carries the full policy and the sniffing defences', async ({ request }) => {
  const response = await request.get('/')
  expect(response.status()).toBe(200)

  const csp = response.headers()['content-security-policy'] ?? ''
  for (const directive of REQUIRED) expect(csp).toContain(directive)

  // `'unsafe-inline'` is permitted in exactly one directive and nowhere else — the design language
  // carries 316 inline style attributes, which is why `style-src` has it and `default-src` is
  // `'none'`. Anywhere else it appears, the policy has been quietly widened.
  const withoutStyleSrc = csp
    .split(';')
    .map(part => part.trim())
    .filter(part => !part.startsWith('style-src'))
    .join('; ')
  expect(withoutStyleSrc).not.toContain("'unsafe-inline'")
  expect(csp).not.toContain("'unsafe-eval'")

  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['referrer-policy']).toBe('no-referrer')

  // `no-cache`, NOT `no-store`, and the difference is deliberate. `securityHeaders()` sets
  // `no-store` as the default, and `assetHeaders()` then lets each asset's own policy win: hashed
  // assets are immutable, the shell is `no-cache`. §15 requires an explicit policy on every
  // response because with none stated Safari applies **heuristic** caching and pins a stale shell on
  // an installed web app permanently — the app never relaunches to notice. `no-cache` means
  // revalidate, which is what lets a new build reach the phone at all.
  expect(response.headers()['cache-control']).toBe('no-cache')
})

test('there are no CORS headers, and their absence is the control', async ({ request }) => {
  // Spec §7: answering a preflight is how the preflight stops being a defence. This asserts an
  // absence, which is exactly the kind of property that rots silently when someone debugging a
  // fetch failure adds a permissive header "just to check".
  const response = await request.get('/')
  const headers = response.headers()
  expect(headers['access-control-allow-origin']).toBeUndefined()
  expect(headers['access-control-allow-credentials']).toBeUndefined()
  expect(headers['access-control-allow-headers']).toBeUndefined()
})

test('an ERROR response carries the policy too', async ({ request }) => {
  // The sentence in §8 that this test exists for. An error page that drops the CSP is an error page
  // an injected payload can execute in, and error paths are exactly where headers get forgotten
  // because the response is assembled somewhere other than the success path.
  const response = await request.get('/definitely-not-a-real-asset.png')
  expect(response.status()).toBe(404)

  const csp = response.headers()['content-security-policy'] ?? ''
  for (const directive of REQUIRED) expect(csp).toContain(directive)
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
})

test('path traversal is refused through a real browser request, with nothing leaked', async ({ request }) => {
  // Aimed at files that genuinely exist on disk beside the served directory. A traversal test
  // against a target that does not exist passes whether or not the containment works.
  const attacks = [
    '/../package.json',
    '/%2e%2e/package.json',
    '/assets/../../package.json',
    '/../src/server/main.ts',
    '/..%2fpackage.json',
    '/%2e%2e%2fpackage.json',
  ]

  for (const attack of attacks) {
    const response = await request.get(attack)
    const body = await response.text()

    // Not just "not 200". The shell is served for unknown in-app routes so a deep link lands, so a
    // traversal could plausibly come back 200 with the shell — which is correct. What must never
    // appear is the CONTENT of the file being aimed at.
    expect(body).not.toContain('"devDependencies"')
    expect(body).not.toContain('soil-viewer failed to start')
    expect(body).not.toContain('SOIL_PORT_LOCAL')
    expect(response.status()).not.toBe(500)
  }
})

test('F1.1 — a forged write is refused AND changes nothing on disk', async () => {
  /**
   * **§20's clause, and the reason it is worded the way it is.**
   *
   * > *"The CSRF test asserts **ZERO STATE CHANGE**, not 'the response was unreadable' — v1's test
   * > passed on a vulnerable build (F1.1)."*
   *
   * The refusals are proven fifty-five ways in `guards.test.ts` — missing Origin, `Origin: null`,
   * foreign origin, repeated headers, every `Sec-Fetch-Site` value. Every one of those calls the
   * guard **function**. None sends a request at a real server holding a real write route and then
   * looks at the disk. A guard that returns "refuse" and a server that refuses are two claims.
   *
   * **`entry.create`, not `file.save`, and getting there took four wrong versions — each of which
   * passed.** Written on 2026-08-15 for P12's U10 inventory:
   *
   *   1. a stale `expectedHash` — refused as stale, nothing to do with CSRF;
   *   2. a guessed `rootId` (`soil-viewer-e2e-tree`; the registry seeds `e2e`) — refused as an
   *      unknown folder;
   *   3. both fixed, and still green with the **entire CSRF stack disabled** — because §13.2's *"no
   *      save without a load"* means a cold `file.save` can never land whatever the guards do. The
   *      test was unfalsifiable, which by this build's own standard makes it decoration;
   *   4. moved to `entry.create` and sent `segments` — the field is `parent`, so the validator
   *      refused it, and a 400 from a contract check looks exactly like a 403 from a guard.
   *
   * `entry.create` writes with no prior session state, so it is a request that **would** succeed if
   * the guards were absent — which is the only kind of forged request that proves anything.
   *
   * **F1.1's failure, reproduced four times while writing the test named after it.** The lesson is
   * not "check your fixtures": it is that a security test which has never been watched fail against
   * a deliberately broken build is indistinguishable from one that cannot fail.
   */
  const created = join(E2E_TREE, 'owned-by-a-forged-request.md')

  /**
   * **Cleared first, because a leftover here makes this test fail forever.**
   *
   * The tree path is fixed rather than random, and the fixture prune only reaches `scratch-` folders
   * under `02-projects` — so a file written at the tree root survives every later run. One arrives
   * exactly when this test has done its job: **verifying it by disabling the CSRF stack lets the
   * forged write through, which is the point, and that run leaves the file behind.**
   *
   * The same reasoning `playwright.config.ts` gives for clearing its scratch folders, and the same
   * safety: this path is composed from `tmpdir()` and a literal name, and can reach nothing of
   * the operator's.
   */
  await rm(created, { force: true })

  // A real attacker's shape: another origin, no session token, a request that would otherwise work.
  const attacker = await playwrightRequest.newContext()
  try {
    const forged = await attacker.post(`http://127.0.0.1:${PORT_TAILNET}/api/entry.create`, {
      headers: {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      data: {
        rootId: E2E_ROOT_ID,
        parent: [],
        name: 'owned-by-a-forged-request',
        kind: 'file',
      },
    })
    expect(forged.status(), 'a cross-origin write was not refused').toBeGreaterThanOrEqual(400)
  } finally {
    await attacker.dispose()
  }

  // The subject of the test. The status above is secondary; this is the assertion.
  const existsAfter = await stat(created).then(() => true, () => false)
  expect(existsAfter, 'THE FORGED WRITE LANDED — the refusal did not prevent it').toBe(false)
})
