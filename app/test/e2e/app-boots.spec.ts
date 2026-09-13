/**
 * The app actually runs under its own Content-Security-Policy.
 *
 * **This is the assertion no unit test can make.** The CSP gate proves the header we emit is the
 * header we meant. It cannot prove the application still works once a browser enforces it — and
 * that is the failure mode that matters, because it does not look like a security problem. It looks
 * like a blank page. The tempting fix for a blank page is to widen the policy.
 *
 * The policy here is unusually strict on purpose: `default-src 'none'`, and
 * `require-trusted-types-for 'script'`, which Chromium enforces and which turns any assignment to
 * `innerHTML` into a thrown error at runtime. Spec §8's DOM-construction-only rule is lint-enforced
 * across `src/`, but lint checks the source we wrote; this checks the bundle a browser executes,
 * including whatever the bundler emitted on our behalf.
 */

import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'


/**
 * Collects everything the page complains about.
 *
 * Both channels, because they are different failures: `pageerror` is an uncaught exception (a
 * Trusted Types violation arrives this way), while a blocked resource is reported only as a console
 * error. Listening to one and not the other is how a violation goes unnoticed.
 */
function collectProblems(page: Page): { console: string[]; errors: string[] } {
  const problems = { console: [] as string[], errors: [] as string[] }
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') problems.console.push(message.text())
  })
  page.on('pageerror', error => { problems.errors.push(error.message) })
  return problems
}

/**
 * `EXPECTED_STREAM_NOISE` used to live here — a regex that taught this test to tolerate the
 * live-update route returning 405, because the route did not exist. **the security review's C12 required it be
 * deleted the moment the route shipped**, and the reasoning is the whole point: a test taught to
 * expect the broken state will not notice the broken state. It is gone, and the assertions below
 * now require the stream to actually work.
 */

test('the client mounts and renders under the real policy', async ({ page }) => {
  const problems = collectProblems(page)

  await page.goto('/')

  /**
   * The boundary renders the editor. If the bundle failed to execute — a blocked script, a Trusted
   * Types throw — the mount point stays empty and this is what catches it.
   *
   * **Retargeted at P7 from the editor to the TREE, and the purpose is unchanged.**
   *
   * At P6 the editor mounted on a constant at page load, so it was the thing on screen and this
   * asserted against it. P7 replaced that development surface: the editor now appears when a file
   * is opened, and opening one is blocked — see `files-tab.spec.ts` and `open-items.md` on the
   * write routes' listener carriage.
   *
   * What this test is *for* is that the bundle executes under the real policy — `script-src 'self'`
   * and `require-trusted-types-for 'script'` — and builds DOM. The tree does that: every row is
   * `createElement` plus `textContent`, under the same policy, in both engines. The editor's own
   * coverage is suspended with the format-bar suite and returns with it.
   */
  await expect(page.getByRole('tree', { name: 'Files' })).toBeVisible()
  await expect(page.locator('.tree-row').first()).toBeVisible()
  /**
   * **The live-preview assertion is GONE FROM HERE, not weakened.**
   *
   * It checked that a heading is styled — the only way to see that a crashing `ViewPlugin` has been
   * silently disabled, which is P6's headline browser finding. It cannot run without a document
   * open, so it moved to `files-tab.spec.ts` where it sits as a `test.fixme` beside the reason it
   * cannot run yet. Deleting it here and leaving it nowhere would quietly retire the one check that
   * caught a whole feature being invisible.
   */
  await expect(page.locator('.status')).toBeVisible()

  const cspViolations = problems.console.filter(text => /Content Security Policy|Refused to/i.test(text))
  expect(cspViolations, `CSP violations in console:\n${cspViolations.join('\n')}`).toEqual([])

  // Trusted Types violations surface as uncaught TypeErrors, not console warnings. No exemptions:
  // any uncaught error is now a real defect.
  expect(problems.errors, `uncaught page errors:\n${problems.errors.join('\n')}`).toEqual([])
})

test('the live-update stream actually connects, end to end', async ({ page }) => {
  /**
   * THE ASSERTION THE WHOLE PHASE WAS BUILDING TOWARD, and it can only be made in a browser.
   *
   * Everything has to be right at once for this to pass: the client fetches its credentials from
   * the session route without a token, holds the ticket, builds a relative stream URL, and the
   * server accepts the handshake on `Sec-Fetch-Site: same-origin` with no `Origin` header at all —
   * which is precisely the combination that would have been refused before C1, and precisely the
   * refusal that would have looked like a client bug.
   *
   * It also proves the header flush: the status only reaches "Live" when `EventSource.onopen`
   * fires, and `onopen` only fires when the response head reaches the browser. A server that
   * accepted the connection but buffered its headers would leave this stuck on "Connecting…"
   * forever — which is exactly how that bug was found.
   */
  await page.goto('/')
  await expect(page.locator('.status')).toHaveText('Live', { timeout: 10_000 })
})

test('the credentials never reach browser storage', async ({ page }) => {
  // the security review's B7 and delivery requirement 2: neither value may outlive the process that minted it.
  // A credential cached on the phone survives a Mac restart, is refused by the new server forever,
  // and nothing ever reloads the installed app to fix it.

  // Captured off the wire, so the assertion below is about the ACTUAL values rather than a shape.
  const minted = { token: '', ticket: '' }
  page.on('response', response => {
    if (!response.url().endsWith('/api/session.start')) return
    void response.json().then(
      (body: { data?: { token?: string; streamTicket?: string } }) => {
        minted.token = body.data?.token ?? minted.token
        minted.ticket = body.data?.streamTicket ?? minted.ticket
      },
      () => { /* a failed session is a different test's problem */ },
    )
  })

  await page.goto('/')
  await expect(page.locator('.status')).toHaveText('Live', { timeout: 10_000 })

  const stored = await page.evaluate(() => ({
    local: JSON.stringify(globalThis.localStorage),
    session: JSON.stringify(globalThis.sessionStorage),
    cookies: document.cookie,
  }))

  /**
   * **Rewritten at P7, and the new form is STRONGER than the one it replaces.**
   *
   * This asserted `localStorage === '{}'` — nothing at all. That was right while nothing was meant
   * to be stored, and it stopped being right when §15 and the PRD put view state in per-client
   * storage: *"Which file is open, active tab, sidebar state live in each client's own storage."*
   *
   * Emptiness was never what this test is named for. It is named for credentials, and "empty"
   * is a **proxy** for that — a proxy that fails in both directions: it goes red for a legitimate
   * scroll position, and it would go green for a credential smuggled into a cookie-shaped string
   * it happened not to look at.
   *
   * So it now checks the thing itself: the real token and the real ticket, taken off the wire, must
   * appear nowhere. That catches a credential under ANY key, which the emptiness check could only
   * do by forbidding all keys.
   */
  const everything = `${stored.local}${stored.session}${stored.cookies}`
  expect(everything, 'the per-request token may never be stored').not.toContain(minted.token)
  expect(everything, 'the stream ticket may never be stored').not.toContain(minted.ticket)
  expect(minted.token, 'the test must have actually captured a token').toMatch(/^[0-9a-f]{16,}$/)

  // And no cookies at all, which remains an absolute: the app has none and must not acquire the
  // habit, because a cookie is the one credential a browser attaches without being asked.
  expect(stored.cookies, 'the app has no cookies and must not acquire the habit').toBe('')

  // Whatever IS in storage must be view state and nothing else — one known key, no surprises.
  const keys = await page.evaluate(() => Object.keys(globalThis.localStorage))
  expect(keys.filter(key => key !== 'soil-viewer.view-state.v1')).toEqual([])
  expect(await page.evaluate(() => Object.keys(globalThis.sessionStorage))).toEqual([])
})

test('the shell carries a real build stamp, not the placeholder', async ({ page }) => {
  // Spec §15: freshness must be machine-checkable, because an installed iOS web app is RESUMED and
  // never relaunched, so "is the fix deployed?" is otherwise unanswerable without the phone in
  // hand. A stamp still reading `__BUILD_STAMP__` is worse than none — it looks answered.
  await page.goto('/')
  const stamp = await page.locator('meta[name="soil-build"]').getAttribute('content')
  expect(stamp).toBeTruthy()
  expect(stamp).not.toBe('__BUILD_STAMP__')
  expect(stamp).not.toContain('__')
})

test('the styling tokens are applied, not merely defined', async ({ page }) => {
  // The P3 review found the app loading white: `tokens.css` defined custom properties and nothing
  // consumed them, so A47's "background painted before first paint (kills white flash)" was a token
  // nobody used. A unit test can assert the token exists; only a browser can say what was painted.
  await page.goto('/')
  const background = await page.evaluate(
    () => globalThis.getComputedStyle(document.body).backgroundColor,
  )
  expect(background).not.toBe('rgba(0, 0, 0, 0)')
  expect(background).not.toBe('')
})

test('a deep link lands on the shell rather than a 404', async ({ page }) => {
  // The single-page app contract: an unknown in-app route serves the shell from the same in-memory
  // map — still a map key, never a disk path.
  await page.goto('/notes/some/deep/path')
  // The tree rather than the editor, for the reason given above: the shell is what is being
  // asserted, and the tree is what the shell now renders.
  await expect(page.getByRole('tree', { name: 'Files' })).toBeVisible()
})

test('every icon the app names is actually served, as a PNG', async ({ page, request }) => {
  /**
   * **The unit test reads the source tree; this reads the wire.** They fail for different reasons
   * and both are worth having: an icon can exist in `public/`, be named correctly in the manifest,
   * and still 404 — the build has to copy it, the dist loader has to pick it up, and `asset-map.ts`
   * has to give it a type. Three steps between "the file exists" and "the phone gets it", none of
   * which the unit test can see.
   *
   * **A wrong content type is a silent failure here, not a loud one.** Unknown extensions are served
   * `application/octet-stream` by design (`contentTypeFor`), and a browser handed an icon as a byte
   * stream does not error — it just has no icon.
   */
  await page.goto('/')

  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')]
      .map(link => link.getAttribute('href') ?? '')
      .filter(href => href !== ''),
  )
  expect(hrefs.length, 'the shell links no icons at all').toBeGreaterThan(0)
  expect(hrefs.some(h => h.includes('180')), 'no apple-touch-icon href').toBe(true)

  // The manifest's own icons too — a different list, read by a different consumer, and the one
  // that had no entries at all for seven days.
  const manifestHref = await page.evaluate(
    () => document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? '',
  )
  expect(manifestHref).not.toBe('')
  const manifestReply = await request.get(manifestHref)
  expect(manifestReply.status(), 'the manifest itself is not served').toBe(200)
  expect(manifestReply.headers()['content-type']).toContain('application/manifest+json')

  const manifest = JSON.parse(await manifestReply.text()) as { icons?: { src: string }[] }
  const all = [...new Set([...hrefs, ...(manifest.icons ?? []).map(i => i.src)])]

  for (const href of all) {
    const reply = await request.get(href)
    expect(reply.status(), `${href} is named by the app and is not served`).toBe(200)
    expect(reply.headers()['content-type'], `${href} is not served as a PNG`).toBe('image/png')
    // A zero-length 200 is a 404 wearing a success code, and it is exactly what an empty file in
    // `public/` would produce.
    expect((await reply.body()).byteLength, `${href} is served empty`).toBeGreaterThan(500)
  }
})
