import { stat } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { DIST_STAMP } from '../../playwright.harness.config'

/**
 * **THIS SUITE MUST NOT WRITE THE BUNDLE THE INSTALLED SERVER LOADS.**
 *
 * `npm run build` emits to `dist/` and `dist-server/`, and those are the two directories the
 * installed server reads at startup. `startProductServer` ran exactly that script until 2026-09-01,
 * so **every invocation of this suite replaced the running product's bundle.**
 *
 * ## Why the damage is delayed, which is what makes it dangerous
 *
 * The server reads the client into memory **once**, in `bootstrap`. A rebuild underneath a running
 * process therefore changes nothing anyone can see. The damage lands on the *next* start — a reboot,
 * a crash-restart, or the starter being double-clicked — which may be hours later and will not look
 * related to having run tests. **Mutation testing deliberately breaks the source and rebuilds** to
 * prove a test catches it, so what is left behind can be a build broken on purpose.
 *
 * On 2026-08-22 that cost a day: an app apparently broken, two controls dead, and the fix was a
 * rebuild. The browser suite was corrected then, by pointing it at `dist-e2e/` and
 * `dist-server-e2e/`, and given `test/e2e/build-isolation.spec.ts` to keep it corrected.
 *
 * **That fix was never carried across to this suite, and nothing noticed for ten days.** The
 * `.gitignore` above those directories describes the hazard in the past tense; it was live in this
 * file the whole time. A defect fixed in one of two places is not a defect that has been fixed, and
 * the guard belongs everywhere the hazard does — which is the reason this file exists rather than a
 * comment saying to be careful.
 *
 * ## What it asserts
 *
 * `playwright.harness.config.ts` stamps both paths before the run. This compares them afterwards.
 * A file that was absent must still be absent — a fresh clone has never built — so the check cannot
 * pass by measuring nothing.
 */

interface Stamp {
  readonly exists: boolean
  readonly mtimeMs: number
}

test('the harness suite does not touch the bundle the real server loads', async () => {
  const stamped = JSON.parse(await readFile(DIST_STAMP, 'utf8')) as Record<string, Stamp>

  /**
   * An empty stamp would make every assertion below vacuous. Checked, because the failure mode this
   * whole file exists to prevent is a guard that is green while measuring nothing.
   */
  expect(Object.keys(stamped).length, 'the stamp recorded no paths — did the config change?')
    .toBeGreaterThan(0)

  for (const [relative, before] of Object.entries(stamped)) {
    const at = join(import.meta.dirname, '..', '..', relative)

    if (!before.exists) {
      await expect(stat(at), `${relative} must not be created by the suite`).rejects.toThrow()
      continue
    }

    const now = await stat(at)
    expect(now.mtimeMs, `${relative} must be untouched by a test run`).toBe(before.mtimeMs)
  }
})
