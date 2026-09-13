import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

import { PORT_TAILNET } from './ports'

/**
 * **FIRST RUN, FROM A STATE DIRECTORY THAT HAS NEVER EXISTED.** Spec §17, and the phase gate names
 * that condition in exactly those words.
 *
 * The distinction is the whole point and it is not pedantry. Emptying the registry of a *running*
 * installation is a different code path from starting with nothing: the config reader distinguishes
 * **missing** from **unreadable** deliberately — *"a missing file is first run and the right
 * response is defaults; an unparseable one is a damaged record and the right response is to stop and
 * say so"* — and a test that deletes a file it just wrote proves the wrong branch.
 *
 * So this boots a **second server**, on its own port, with `SOIL_STATE_DIR` pointing somewhere no
 * process has ever written. Nothing is registered because nothing has ever been.
 *
 * **Nothing goes near `/Users/hallberg/notes`**, and this server is torn down with its
 * directory.
 */

let child: import('node:child_process').ChildProcess | null = null
let stateDir = ''
const PORT = PORT_TAILNET + 7

test.beforeAll(async () => {
  const { spawn } = await import('node:child_process')
  // Named, not created: the point is that it has never existed when the server starts.
  stateDir = join(await fsp.realpath(tmpdir()), `soil-first-run-${process.pid}`)

  /**
   * **`dist-server-e2e`, not `dist-server` — this spec was testing a build nothing here produces.**
   *
   * Every other browser spec runs against `dist-e2e/` + `dist-server-e2e/`, which `webServer`
   * rebuilds from source on every run. This one spawned its own server from `dist-server/` — the
   * **installed product's** bundle, which the e2e path never builds. So it measured whatever
   * `npm run build` had last left there, from any time and any branch, and a change to the first-run
   * screen could be deleted outright with these tests still green.
   *
   * Two harms in one line. It is stale, and it reads and executes the exact bundle that
   * `build-isolation.spec.ts` exists to keep this suite away from.
   */
  child = spawn(process.execPath, [join(process.cwd(), 'dist-server-e2e', 'main.js')], {
    env: {
      ...process.env,
      SOIL_DIST_DIR: 'dist-e2e',
      SOIL_STATE_DIR: stateDir,
      SOIL_PORT_TAILNET: String(PORT),
      /**
       * **Both listeners, or neither.** §7's two-door design means this process opens a local
       * listener as well, and leaving that on its default collided with whatever else is running —
       * the tailnet door came up, the local one threw EADDRINUSE, and the process died after
       * printing a perfectly healthy banner. A test server has to move both doors.
       */
      SOIL_PORT_LOCAL: String(PORT + 1),
      SOIL_BROWSE_HOME: stateDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Captured, not discarded: a server that will not start is the thing this test most needs to be
  // able to say something about, and `ignore` turns that into a bare timeout.
  let output = ''
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })

  // Wait for it to answer rather than sleeping a guessed amount.
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const probe = await fetch(`http://127.0.0.1:${PORT}/`)
      if (probe.ok) break
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`the first-run server never answered:\n${output}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
})

/**
 * **Killed on every exit path, not only a clean one.**
 *
 * `afterAll` does not run when the process is interrupted — and that is not hypothetical here: the
 * servers this spec left behind held ports for the rest of a session, so later runs raced processes
 * they had not started. Two full runs were read as regressions before the wall clock gave it away
 * (9.7 minutes against a normal 1.9). `playwright.config.ts` refuses `reuseExistingServer` for
 * exactly this reason; a spec that spawns its own has to hold the same line.
 */
process.once('exit', () => { child?.kill('SIGKILL') })
process.once('SIGINT', () => { child?.kill('SIGKILL') })
process.once('SIGTERM', () => { child?.kill('SIGKILL') })

test.afterAll(async () => {
  child?.kill()
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test.describe('first run', () => {
  test('says what this is, promises never to delete, and offers one action', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT}/`)
    await expect(page.locator('#app')).toBeAttached()

    const card = page.locator('.first-run')
    await expect(card).toBeVisible()

    // §17: what it is, and that it works on the real files in place.
    await expect(card).toContainText(/reads and writes/i)
    /**
     * **The sentence this whole rebuild exists to keep.** The previous version destroyed 1,610 of
     * 1,611 files; §17 asks for the promise on the first screen by name. Asserted as its own
     * expectation rather than folded into the one above, so removing it fails on its own.
     */
    await expect(card).toContainText(/never deletes anything/i)

    // One action, not a menu.
    await expect(card.getByRole('button', { name: 'Choose a folder' })).toBeVisible()
  })

  test('the tree is not offered as an empty shell instead', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT}/`)
    await expect(page.locator('.first-run')).toBeVisible()
    // An empty tree with "Choose a file on the left" is the state §17 exists to replace: it tells
    // someone who has given the app nothing that they have failed to pick something.
    await expect(page.locator('.tree-row')).toHaveCount(0)
  })
})

test('A33 — the app comes back to the tab you were on', async ({ page }) => {
  /**
   * **Annex A33's third field**, added 2026-08-15. It remembered the open file and the expanded
   * folders and dropped which tab you were looking at.
   *
   * **The phone is why it is worth anything.** On the Mac a reload is rare; an installed web app on
   * iOS is suspended and resumed constantly, and every resume landed on Files however long the
   * person had been on Tasks.
   *
   * A browser test rather than a unit one: the unit suite proves the value round-trips through
   * storage, and only this proves the app *acts* on it — a value written and read and then ignored
   * would pass every assertion in `session-memory.test.ts`.
   */
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Tasks', exact: true })).toHaveAttribute('aria-selected', 'true')

  await page.reload()
  await expect(page.locator('#app')).toBeAttached()
  await expect(
    page.getByRole('tab', { name: 'Tasks', exact: true }),
    'the app forgot which tab was open',
  ).toHaveAttribute('aria-selected', 'true')
})

test('A33 — an unknown remembered tab falls back to Files rather than nothing', async ({ page }) => {
  // Storage is editable by anything with devtools, and a tab id that no longer exists is the
  // ordinary case after a rename. Falling back is what stops the app opening on no tab at all.
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await page.evaluate(() => {
    const key = 'soil-viewer.view-state.v1'
    const held = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
    localStorage.setItem(key, JSON.stringify({ ...held, activeTab: 'a-tab-that-never-existed' }))
  })

  await page.reload()
  await expect(page.getByRole('tab', { name: 'Files', exact: true }))
    .toHaveAttribute('aria-selected', 'true')
})
