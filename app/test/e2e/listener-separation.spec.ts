/**
 * The two listeners are not interchangeable, and this pins the difference against the real process.
 *
 * Spec §7: **privilege is decided by which listener accepted the connection** — never by an address
 * and never by a header. v1's loopback gate was *inverted* precisely because it inferred privilege
 * from the connection's address, and `tailscale serve` opens a fresh loopback connection to the
 * backend, so every remote request looked local.
 *
 * `bootstrap.ts` expresses that asymmetry by giving the local listener **no asset map at all**: it
 * carries the privileged handlers and serves no UI. The client is reached only through the tailnet
 * listener, the sole `serve` target.
 *
 * This is worth a test rather than a comment because the failure is so inviting. Point a browser at
 * the local port, get a 405 on `/`, and the natural "fix" is to hand the local listener an asset
 * map — which dissolves the separation to make a test pass. Asserting the 405 makes the separation
 * something that breaks loudly when someone does that.
 */

import { expect, request as playwrightRequest, test } from '@playwright/test'


import { PORT_LOCAL } from './ports'

const LOCAL = `http://127.0.0.1:${PORT_LOCAL}`

test('the local listener serves no UI', async () => {
  // Its own request context: the shared one is bound to the tailnet baseURL.
  const context = await playwrightRequest.newContext()
  try {
    const response = await context.get(`${LOCAL}/`)

    // 405, not 404 and not 200. There is no asset map, so the request falls through to the API
    // path, where the method policy refuses GET. A 200 here means the client is being served from
    // the privileged listener.
    expect(response.status()).toBe(405)

    const body = await response.text()
    expect(body).not.toContain('id="app"')
    expect(body).not.toContain('soil-build')
  } finally {
    await context.dispose()
  }
})

test('the local listener still carries the full security headers', async () => {
  // Spec §8: on every response including errors. A listener that serves no documents is exactly
  // where someone would reason the headers are unnecessary.
  const context = await playwrightRequest.newContext()
  try {
    const response = await context.get(`${LOCAL}/`)
    const csp = response.headers()['content-security-policy'] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
  } finally {
    await context.dispose()
  }
})

test('the tailnet listener serves the UI', async ({ request }) => {
  // The other half of the pair. Together these say the asymmetry is intentional and which way round.
  const response = await request.get('/')
  expect(response.status()).toBe(200)
  expect(await response.text()).toContain('id="app"')
})
