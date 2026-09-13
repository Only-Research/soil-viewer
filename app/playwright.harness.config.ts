import { realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineConfig, devices } from '@playwright/test'

/**
 * **THE STAMP THAT PROVES THIS SUITE DID NOT OVERWRITE THE INSTALLED APP.**
 *
 * Recorded here, before anything runs, and asserted by `test/harness/build-isolation.spec.ts` after
 * everything has. The browser suite has carried the identical guard since 2026-08-22, when a test
 * run left the installed app broken and cost a day; **this suite had the same defect and no guard
 * at all**, which is why it survived a fix that was believed to be complete.
 *
 * ## Two ways this was written wrong first, both of which passed
 *
 * **The path must be fixed, not a fresh temp directory.** Workers re-import this module in their own
 * processes, so `mkdtempSync` handed each one a *different* directory — the worker read a stamp the
 * config had never written to.
 *
 * **And the worker must not write it.** The guard is `TEST_WORKER_INDEX`, which Playwright sets in
 * workers and leaves absent in the config process. The first version tested `PW_TEST_WORKER_INDEX`,
 * which is never set — so every worker re-stamped on import, replacing the "before" with an "after"
 * taken *after* the build, and the assertion compared a value with itself.
 *
 * Either mistake alone makes this permanently green. **Both were caught by re-introducing the hazard
 * and watching the guard pass anyway** — never by reading it, twice.
 */
export const HARNESS_SANDBOX = realpathSync(tmpdir())
export const DIST_STAMP = join(HARNESS_SANDBOX, 'soil-viewer-harness-dist-stamp.json')

if (process.env['TEST_WORKER_INDEX'] === undefined) {
  const stampOf = (at: string): { exists: boolean; mtimeMs: number } => {
    try {
      return { exists: true, mtimeMs: statSync(at).mtimeMs }
    } catch {
      // Absent is legitimate — a fresh clone has never run `npm run build`. Recorded as such so the
      // assertion becomes "still absent" rather than passing silently on a missing file.
      return { exists: false, mtimeMs: 0 }
    }
  }
  writeFileSync(DIST_STAMP, JSON.stringify({
    'dist/index.html': stampOf(join(import.meta.dirname, 'dist', 'index.html')),
    'dist-server/main.js': stampOf(join(import.meta.dirname, 'dist-server', 'main.js')),
  }))
}

/**
 * **The product server is started by the chain test, not by `webServer`, and that is forced.**
 *
 * `file.load` and `file.save` are local-only, the local listener has its own token, and
 * `session.start` is tailnet-only — so no request obtains the local credential. It is printed to
 * stdout once at startup and nowhere else, because §7's token property 4 forbids it reaching a log.
 * `webServer` gives no access to a server's stdout, so the test spawns the process and reads the
 * line. See `test/harness/server.ts`, including what was deliberately *not* done to make this
 * easier.
 */

/**
 * **A separate config from `playwright.config.ts`, deliberately.**
 *
 * The e2e suite tests the *product*: the committed bundle behind the zero-dependency Node server,
 * where the CSP, the Host allowlist and the two-listener separation are real. Its config argues at
 * length that running those against the dev server would prove nothing, and that argument stands.
 *
 * The harness tests something else. It measures whether the **editor** returns a document
 * unchanged, which is a property of `@codemirror/state` and of the extension list — not of any
 * header, route or listener. So it runs against the dev server, and that is a reasoned difference
 * rather than a shortcut:
 *
 * - The harness page is **not part of the product**. Building it into `dist/` would ship an
 *   instrument that mounts editors on arbitrary input inside the app the phone reaches. The gate
 *   must not require adding a surface to the thing it is gating.
 * - Nothing the production server does can change what `doc.toString()` returns.
 *
 * **The one difference that could matter is named rather than assumed:** a production build
 * minifies, and the dev server does not. Minification cannot alter document text, but it is a
 * difference between what is measured and what ships, so it is written here to be re-argued if the
 * gate is ever close.
 */
export default defineConfig({
  testDir: 'test/harness',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // One worker. The corpus is over a thousand files through one page; parallel workers would race
  // for the same dev server and make the timing — the only thing a second worker buys — unreadable.
  workers: 1,
  reporter: 'list',
  timeout: 10 * 60 * 1000,
  use: {
    baseURL: 'http://127.0.0.1:5273',
    trace: 'off',
  },
  /**
   * **Two servers, and they do different jobs.**
   *
   * The dev server carries the harness page, which is deliberately not built into `dist/` — the
   * gate must not require shipping an instrument that mounts editors on arbitrary input inside the
   * app the phone reaches.
   *
   * The product server is the real server binary, built by `globalSetup` into `dist-server-e2e/` and
   * serving `dist-e2e/` — the same code that ships, emitted somewhere that is not the bundle the
   * installed app loads. It is what the chain test's `file.load` and `file.save` go through. The
   * editor's *fidelity* needs only a browser; the claim "the app does not change your files" needs
   * the app.
   *
   * `reuseExistingServer` off on both, for the reason the e2e config records at length: reusing
   * whatever answers on a port is how a suite ends up measuring a process it did not start, and its
   * first run tested a different application entirely while four assertions passed.
   */
  globalSetup: './test/harness/global-setup.ts',
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5273/harness.html',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    /**
     * WebKit is not optional here. The operator's target is an installed web app on iOS, so "the editor
     * preserves bytes" has to be true in the engine they will actually use. It is a second full pass
     * over the corpus and worth the minutes.
     */
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
