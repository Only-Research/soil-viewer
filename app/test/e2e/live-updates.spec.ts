import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page, type TestInfo } from '@playwright/test'

import { openRoot } from './tree-nav'

import { E2E_TREE } from '../../playwright.config'

/**
 * **SOMEONE ELSE WRITES A FILE AND THE SCREEN NOTICES.** Spec §15, in a real browser.
 *
 * This is the only test in the suite that writes to the tree from *outside* the application while
 * the browser is watching, and it is the only honest proof of the feature. Every other layer of
 * this channel was proven long before it did anything: the watcher had tests, the reconciler had
 * tests, the broadcast had tests, the client's reconnect-and-resync machinery had the most careful
 * tests in the build — and for the whole of Phase 7 `main.tsx` handed every delivered event to
 * `() => {}`. Nine controls in this build have been complete, tested and reachable by nothing;
 * this was the ninth, and the only one that was a live wrong answer rather than a missing feature.
 *
 * So the assertions below deliberately do not touch a module. They write a file with `fs` and then
 * ask the DOM a question. Nothing between those two points is mocked, stubbed or injected: the real
 * `fs.watch`, the real 250 ms coalescing window, the real index reconcile, the real SSE frame, the
 * real store, the real tree.
 *
 * **The timeouts are generous on purpose.** A live update crosses a filesystem event, a debounce, a
 * subtree reconcile and a network hop before it can reach a pixel. A tight timeout here would not
 * measure the feature, it would measure the machine — and this suite already has a history of
 * timing failures that read as broken features.
 */

const ARRIVAL_MS = 15_000

test.beforeEach(async ({ page }) => {
  const problems: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', error => { problems.push(error.message) })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  ;(test.info() as { problems?: string[] }).problems = problems
})

/** One folder per test, per engine — pre-created by `playwright.config.ts` before the server boots. */
function scratchFolder(testInfo: TestInfo, purpose: string): string {
  return `scratch-${testInfo.project.name}-${purpose}`
}

function scratchPath(testInfo: TestInfo, purpose: string): string {
  return join(E2E_TREE, '02-projects', scratchFolder(testInfo, purpose))
}

/** Opens the tree down to one scratch folder and leaves it expanded. */
async function openScratch(page: Page, testInfo: TestInfo, purpose: string) {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  const folder = scratchFolder(testInfo, purpose)
  await tree.locator('.tree-row').filter({ has: page.getByText(folder, { exact: true }) }).click()
  // The folder's existing fixture proves it is open before anything is written into it. Without
  // this the write can land before the listing has been fetched, and the row that appears proves
  // only that the first fetch worked.
  await expect(tree.getByText('subject', { exact: true })).toBeVisible()
  return tree
}

/**
 * The headline. No reload, no click, no mutation performed by this client — a file simply appears
 * on disk and the tree grows a row.
 */
test('a file written by something else appears in the tree', async ({ page }, testInfo) => {
  const tree = await openScratch(page, testInfo, 'live')

  await writeFile(
    join(scratchPath(testInfo, 'live'), 'written-by-an-agent.md'),
    '# Written by an agent\n\nnobody clicked anything to make this\n',
  )

  // Prettified, because the tree strips `.md` and shows hyphens as spaces for files.
  await expect(tree.getByText('written by an agent', { exact: true }))
    .toBeVisible({ timeout: ARRIVAL_MS })
})

/**
 * The other half, and the one that matters more when it is the operator reading rather than editing: the
 * pane itself is stale, not just the tree.
 *
 * A **clean** document is reopened, because there is nothing to lose and a person reading bytes an
 * agent replaced thirty seconds ago is exactly the failure §15 exists to prevent. A dirty one is
 * never touched — that rule is `openFileVerdict`'s and is asserted directly in the unit suite,
 * because reaching it here would mean racing a real autosave and asserting on the outcome of a
 * race is how a test starts lying.
 */
test('the open document refreshes when its file changes on disk', async ({ page }, testInfo) => {
  const tree = await openScratch(page, testInfo, 'live-open')

  await tree.getByText('subject', { exact: true }).click()
  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('the scratch document')

  await writeFile(
    join(scratchPath(testInfo, 'live-open'), 'subject.md'),
    '# Subject\n\nrewritten while it was open on screen\n',
  )

  await expect(editor).toContainText('rewritten while it was open on screen',
    { timeout: ARRIVAL_MS })
  // And the text it replaced is gone, rather than the new content having merely been appended
  // somewhere — a reopen that leaves the old buffer behind is the stale screen with extra steps.
  await expect(editor).not.toContainText('the scratch document')
})
