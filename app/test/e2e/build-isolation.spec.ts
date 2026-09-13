import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { DIST_STAMP } from '../../playwright.config'

/**
 * **THE SUITE MUST NOT WRITE THE PRODUCT'S BUNDLE.**
 *
 * `npm run build` emits to `dist/` and `dist-server/`, and those are exactly the two directories the
 * launchd server loads at startup. The browser harness used to run that script — so every run of
 * this suite replaced the running product's bundle, and a restart during one served whatever the
 * suite had last built.
 *
 * **This is not a hypothetical, which is why it has a test rather than a comment.** On 2026-08-22
 * the operator spent a day on a build a test run had left behind, with the search and settings controls
 * both dead, and the fix was a rebuild from `main`. The sharper version is mutation testing: the
 * source is deliberately broken and rebuilt to prove a test catches it, so a restart at that moment
 * serves code broken **on purpose**.
 *
 * The harness now builds to `dist-e2e/` and `dist-server-e2e/` and is pointed at the first through
 * `SOIL_DIST_DIR`. This asserts that it stayed that way.
 *
 * **The stamp is taken in the config process**, because Playwright starts `webServer` — and with it
 * the build — before `globalSetup` runs. Anything measured later has already missed the event.
 *
 * MUTATION: point `webServer.command` back at `npm run build && npm run serve`. Must redden.
 */
interface Stamp {
  readonly exists: boolean
  readonly mtimeMs: number
}

test('the browser suite does not touch the bundle the real server loads', async () => {
  const stamped = JSON.parse(await readFile(DIST_STAMP, 'utf8')) as Record<string, Stamp>

  for (const [relative, before] of Object.entries(stamped)) {
    const at = join(import.meta.dirname, '..', '..', relative)

    /**
     * **Absent before must mean absent after.** A fresh clone has never run `npm run build`, and a
     * suite that *created* the product's bundle would be just as wrong as one that overwrote it —
     * the next restart would serve a build nobody deployed.
     */
    if (!before.exists) {
      await expect(stat(at), `${relative} must not be created by the suite`).rejects.toThrow()
      continue
    }

    const now = await stat(at)
    expect(now.mtimeMs, `${relative} must be untouched by a test run`).toBe(before.mtimeMs)
  }
})
