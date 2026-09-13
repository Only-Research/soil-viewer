import { expect, test, type Page } from '@playwright/test'

import { E2E_BROWSE } from '../../playwright.config'

/**
 * **Settings, by its accessible name rather than by which control happens to carry it.**
 *
 * There are two in the markup and never two on a screen: the rail's gear on a desktop, the strip
 * above the tab bar on a phone. Both are `aria-label="Settings"` and both press the same button.
 * Whichever is hidden is `display: none`, so it is out of the accessibility tree and this resolves
 * to exactly one element at either width.
 *
 * Deliberately not `.rail-gear`. The claim this file makes is *"Settings is reachable from the
 * interface"* — a class name would tie that claim to one width and one design, and this suite has
 * already outlived one arrangement of it.
 */
const settingsControl = (page: Page) => page.getByRole('button', { name: 'Settings' })

/**
 * SETTINGS → FOLDERS, IN A REAL BROWSER, AGAINST A REAL SERVER.
 *
 * the ruling of 2026-08-09: *"I want this just to be a normal settings menu within the main
 * interface just like it is in the app as it exists today where I can click around in settings and
 * add a folder to the file tree."*
 *
 * **This file is the point of the phase, not a nicety.** P7's recurring finding is a module that is
 * individually correct, thoroughly unit-tested, and reachable by nothing — six of them so far,
 * including `indexRoot`, `document-session`, `feedback`, the editor's whole write surface, and
 * `inspectBackup`, whose §11 warning had never once been shown to a person. Every one of them had
 * green tests. What none of them had was a caller.
 *
 * So these assertions are about **a person clicking**: the button exists on screen, the dialog it
 * opens shows the real registry, the picker walks the real filesystem, and the folder that comes
 * out the other end **appears in the tree without a reload** — then comes back out of it again.
 * Anything short of that is a unit test wearing a browser.
 *
 * The browsable area is `SOIL_BROWSE_HOME`, pointed at the suite's own sandbox by
 * `playwright.config.ts`. Never `$HOME` — the standing rule is that tests run against a mock.
 */

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

test('Settings is reachable from the interface and shows the real registry', async ({ page }) => {
  const button = settingsControl(page)
  await expect(button).toBeVisible()

  await button.click()
  const dialog = page.locator('.modal[aria-label="Settings"]')
  await expect(dialog).toBeVisible()

  /**
   * The folder seeded into the registry before boot, read back through `folders.list`.
   *
   * Scoped to *this* row rather than asserting the list's whole contents: both engines run against
   * one server, so a folder the other engine's registration test added is legitimately present by
   * the time this runs. Asserting the full list made this test fail on whichever engine went
   * second — a real cross-engine coupling, reported as a defect in the screen.
   */
  const seeded = dialog.locator('.settings-row', { hasText: 'soil-viewer-e2e-tree' })
  await expect(seeded.locator('.settings-row-name')).toHaveText('soil-viewer-e2e-tree')

  /**
   * §6, in the browser: the response half of "no absolute paths on the wire".
   *
   * A row that showed the absolute path would pass a visual check and quietly hand the client the
   * shape of the user's disk. This asserts the short path is what renders — and that it is short.
   */
  const shown = await seeded.locator('.settings-row-path').textContent()
  expect(shown?.startsWith('/')).toBe(false)
  expect(shown).toContain('soil-viewer-e2e-tree')
})

test('the picker walks the real filesystem, inside the scope and no further', async ({ page }) => {
  await settingsControl(page).click()
  await page.getByRole('button', { name: 'Add Folder' }).click()

  const picker = page.locator('.modal[aria-label="Choose a folder"]')
  await expect(picker).toBeVisible()

  // Standing in the scope's home, which the client never named — it sent `''` and was told.
  await expect(picker.locator('.browser-path')).toHaveText(E2E_BROWSE)

  /**
   * `parent` is `null` at a root, so there is no "up" control to walk out of the browsable area
   * with. The server would refuse anyway; this is about not offering a button whose only outcome is
   * an error.
   */
  await expect(picker.locator('.picker-row.is-up')).toHaveCount(0)

  const candidate = picker.locator('.picker-row', { hasText: `candidate-${test.info().project.name}` })
  await expect(candidate).toBeVisible()
  await candidate.click()

  await expect(picker.locator('.browser-path'))
    .toHaveText(`${E2E_BROWSE}/candidate-${test.info().project.name}`)
  // One level down, "up" exists — the pair proves the control is conditional rather than absent.
  await expect(picker.locator('.picker-row.is-up')).toBeVisible()
})

/**
 * **§11's backup warning was tested here and is cut** (2026-08-09, the operator: *"cut it"*). It fired
 * when a folder was not inside a git repository and made the person type `ADD` to continue. It
 * never checked whether anything had been *committed*, so it said nothing about the tree it was
 * meant to protect and charged friction on every folder outside a repo — which is a routine case
 * for them, not an edge one. Picking a folder now adds it.
 */
/**
 * **The whole chain, and the assertion that only a browser can make.**
 *
 * Click Settings → pick a folder → type through the warning → the folder is registered, indexed,
 * and **appears as a new root in the tree with no reload**. Every link in that is separately
 * proven; this is the one test that would notice if any of them were not connected to the next.
 */
test('adding a folder puts it in the tree, without a reload', async ({ page }) => {
  const engine = test.info().project.name
  const rootsBefore = await page.locator('.tree-row').count()

  await settingsControl(page).click()
  await page.getByRole('button', { name: 'Add Folder' }).click()

  const picker = page.locator('.modal[aria-label="Choose a folder"]')
  await picker.locator('.picker-row', { hasText: `candidate-${engine}` }).click()
  await picker.locator('.modal-confirm').click()

  const settings = page.locator('.modal[aria-label="Settings"]')
  // The registry, re-read and re-rendered — not the row the client optimistically drew.
  await expect(settings.locator('.settings-row-name', { hasText: `candidate-${engine}` }))
    .toBeVisible()

  await settings.locator('.modal-cancel').click()
  await expect(settings).toBeHidden()

  /**
   * **In the TREE, as its own row — collapsed**, like every root. The operator: *"it is collapsed by
   * default."* The row appearing at all is the assertion; what is inside it is one click away. `setRoots` announces, the view redraws, no page load.
   *
   * The row exists at all only because root rows were added alongside this screen. The tree drew a
   * registered folder's *contents* at depth 0 and never the folder — right for one folder, unusable
   * for two — so a newly added empty folder contributed no rows and simply did not appear. The
   * feature was "add a folder to the file tree" and the folder was invisible.
   */
  await expect(page.locator('.tree-row', { hasText: `candidate-${engine}` })).toBeVisible()
  expect(await page.locator('.tree-row').count()).toBeGreaterThan(rootsBefore)

  // And the folder that was already there is still on screen — adding one must not hide the other.
  await expect(page.locator('.tree-row', { hasText: 'soil-viewer-e2e-tree' })).toBeVisible()
})

/**
 * §6's message table, arriving as a sentence a person can act on.
 *
 * The three registration refusals shared `INVALID_ROOT` until 2026-08-09, and the client discarded
 * the envelope on every non-200 anyway — so this said *"the server refused the request"* for a
 * folder that was simply already added, and the person would re-pick it forever.
 *
 * Ordered after the test above, and depends on it: the folder it re-adds is the one that test
 * registered. Playwright runs a file's tests in order within a worker, and both share one server.
 */
/**
 * **Ordered before the removal test, and the order is load-bearing.** Its subject is a folder that
 * is *already registered* — the one the test above added. Written after the removal test, it found
 * the folder gone, re-added it successfully, and failed looking for a refusal that was correctly
 * never issued.
 */
test('adding the same folder twice says so, rather than refusing anonymously', async ({ page }) => {
  const engine = test.info().project.name
  await settingsControl(page).click()
  await page.getByRole('button', { name: 'Add Folder' }).click()

  const picker = page.locator('.modal[aria-label="Choose a folder"]')
  await picker.locator('.picker-row', { hasText: `candidate-${engine}` }).click()
  await picker.locator('.modal-confirm').click()

  const settings = page.locator('.modal[aria-label="Settings"]')
  await expect(settings.locator('.modal-note.is-refused')).toContainText('already added')
  // Not the overlap sentence. Re-adding the same folder used to say "contains, or sits inside, one
  // you have already added" — true of a path against itself, and nonsense to read.
  await expect(settings.locator('.modal-note.is-refused')).not.toContainText('sits inside')
})

/**
 * REMOVE. Ruled 2026-08-09: *"it should act as the original app, you can add and remove a folder
 * tree."*
 *
 * **The confirmation is the feature, not the button.** `folders.deregister` moves the registry
 * entry to a `deregistered` list, clears the index and stops the watcher, and touches **not one
 * byte on disk**. In an app whose promise is that nothing is ever deleted — *"nothing gets deleted,
 * no files get deleted, I move them, they get archived"* — a control named Remove has to say which
 * kind of removal it is before it runs. This asserts it says so.
 *
 * **Last in the file**, because it takes away the folder every test above works with.
 */
test('a folder can be removed from the list, and the dialog says nothing is deleted', async ({ page }) => {
  const engine = test.info().project.name
  await settingsControl(page).click()

  const settings = page.locator('.modal[aria-label="Settings"]')
  const row = settings.locator('.settings-row', { hasText: `candidate-${engine}` })
  await expect(row).toBeVisible()
  await row.locator('.settings-remove').click()

  const confirm = page.locator('.modal[aria-label="Remove a folder"]')
  await expect(confirm).toBeVisible()
  await expect(confirm.locator('.modal-warning')).toContainText('Nothing is deleted')
  await expect(confirm.locator('.modal-warning')).toContainText('stay exactly where they are')

  // Escape backs out, and the folder is still there. A confirmation that cannot be declined is not
  // a confirmation.
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(row).toBeVisible()

  await row.locator('.settings-remove').click()
  await page.locator('.modal[aria-label="Remove a folder"] .modal-confirm').click()

  await expect(settings.locator('.settings-row', { hasText: `candidate-${engine}` })).toHaveCount(0)
  await settings.locator('.modal-cancel').click()

  // Out of the tree too, without a reload — the same announce path adding one uses.
  await expect(page.locator('.tree-row', { hasText: `candidate-${engine}` })).toHaveCount(0)
  // And the folder that was always there is untouched.
  await expect(page.locator('.tree-row', { hasText: 'soil-viewer-e2e-tree' })).toBeVisible()
})

