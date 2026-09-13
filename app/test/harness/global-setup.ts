import { spawnSync } from 'node:child_process'

/**
 * **THE ISOLATED BUILD, ONCE, BEFORE ANY TEST RUNS.**
 *
 * `startProductServer` used to run this itself, on every call. Two things were wrong with that and
 * only the first was obvious.
 *
 * **It built the product's own bundle.** `npm run build` emits to `dist/` and `dist-server/`, the
 * two directories the installed server reads at startup — so every invocation of this suite replaced
 * the running app. The server does not notice while it is up, because it loads the client into
 * memory once in `bootstrap`; the damage lands on the *next* start, which may be a reboot hours
 * later and will not look related to having run tests. On 2026-08-22 that cost a day. The browser
 * suite was corrected then and this one was not.
 *
 * **And moving the build here rather than fixing it in place is what makes the guard mean anything.**
 * `test/harness/build-isolation.spec.ts` compares the product bundle's timestamps against a stamp
 * taken before the run. With the build inside `startProductServer`, that guard passed **only if
 * Playwright happened to schedule it after the suite that builds** — and Playwright orders spec
 * files alphabetically, so `build-isolation` ran *first* and measured the timestamps before anything
 * could have touched them. It was green, and it was green for no reason.
 *
 * Found by re-introducing the hazard on purpose and watching the guard pass anyway. A `globalSetup`
 * runs before every test by construction, so the ordering question no longer exists.
 */
export default function globalSetup(): void {
  const built = spawnSync('npm', ['run', 'build:e2e'], { cwd: process.cwd(), encoding: 'utf8' })
  if (built.status !== 0) {
    throw new Error(`the isolated build failed:\n${built.stdout}\n${built.stderr}`)
  }
}
