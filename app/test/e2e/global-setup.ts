/**
 * Proves the browser tests are talking to THIS application before a single assertion runs.
 *
 * WHY THIS FILE EXISTS, and it is not hypothetical. The first run of the e2e suite pointed at port
 * 8787 with Playwright's `reuseExistingServer` enabled. The operator's *other* system, an earlier app, had been
 * listening on 8787 for ten days. Playwright saw something answering, **did not start the Soil
 * Viewer at all**, and ran the entire suite against a different application. Twelve tests failed —
 * and four PASSED, because they assert the absence of things (no CORS headers, no leaked file
 * contents) and a stranger's server happens not to have them either.
 *
 * That is the shape of the problem. Had the suite been mostly absence-shaped, it would have gone
 * green while testing nothing. This is the same family as spec §6's rule that "an empty-but-
 * successful result never stands in for a failure": a server answering is not evidence it is OUR
 * server, and a test that cannot tell the difference passes for the wrong reason.
 *
 * `reuseExistingServer` is now off unconditionally in `playwright.config.ts`, which prevents the
 * cause. This checks the effect anyway, because a port collision with a process we did not start
 * would otherwise still be diagnosed by reading twelve confusing assertion failures.
 */

import type { FullConfig } from '@playwright/test'

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL
  if (baseURL === undefined) throw new Error('e2e: no baseURL configured')

  const response = await fetch(baseURL)
  const body = await response.text()

  // Three independent markers, so a coincidence on one is not enough. The build stamp is the
  // strongest: it is written by this build and nothing else has a reason to emit that meta name.
  const markers = [
    { name: 'the CSP header', found: (response.headers.get('content-security-policy') ?? '').includes("default-src 'none'") },
    { name: 'the build stamp meta tag', found: body.includes('name="soil-build"') },
    { name: 'the app mount point', found: body.includes('id="app"') },
  ]

  const missing = markers.filter(marker => !marker.found).map(marker => marker.name)
  if (missing.length > 0) {
    throw new Error(
      `e2e: ${baseURL} is answering, but it is NOT the Soil Viewer — missing ${missing.join(', ')}.\n` +
      'Something else is listening on that port. Do not "fix" the failing assertions; find the\n' +
      'process (lsof -nP -iTCP -sTCP:LISTEN) and move this suite to a free port. It has happened\n' +
      'once already: an earlier app was on 8787 and the whole suite ran against it.',
    )
  }
}
