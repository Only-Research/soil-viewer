import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page, type TestInfo } from '@playwright/test'

import { openFolder, openRoot } from './tree-nav'

import { E2E_TREE } from '../../playwright.config'

/**
 * **TEMPLATES, END TO END.** Phase 8, in a real browser against real folders.
 *
 * the operator's design, in their own words: *"anything that is a combination of files and folders grouped
 * together in a named template… I pick the folder path that I want to point to… and then when I
 * click it, it knows to make a copy of that folder path and everything underneath it."*
 *
 * Three of their rulings are asserted here rather than described:
 *
 * - **No renaming of anything.** `context-template.md` arrives as `context-template.md`.
 * - **A location and a name are both required.** The location is the folder whose menu was used;
 *   the name is typed and nothing is created until it is.
 * - **`.gitkeep` comes through**, so the empty folder in the shape exists in git as well as on
 *   disk. *"We're keeping the git keep… for GitHub."*
 *
 * Everything is per-engine. The template registry is server-global and both projects run against
 * one server, so a template named `Op` from Chromium is still registered when WebKit adds its own —
 * and the server refuses a duplicate name, correctly. This suite has met that shape twice before.
 */

const TREE = 'soil-viewer-e2e-tree'

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

const templateFolder = (testInfo: TestInfo) => `template-source-${testInfo.project.name}`
/**
 * **A distinct name per test, not just per engine.**
 *
 * The template registry is server state and the state directory is created once per run, so a
 * template added by one test is still registered when the next one runs. Sharing a name would mean
 * the second `addTemplate` is *refused* as a duplicate while the assertion that follows it passes
 * anyway — the name is on screen, just not because this test put it there. A test that passes
 * without exercising its own subject is the shape this suite keeps finding.
 */
const templateName = (testInfo: TestInfo, tag: string) => `Op ${testInfo.project.name} ${tag}`
const scaffoldFolder = (testInfo: TestInfo) => `scratch-${testInfo.project.name}-scaffold`

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  return settings
}

/** Names this engine's template folder as a template, through the real Settings flow. */
async function addTemplate(page: Page, testInfo: TestInfo, tag: string): Promise<void> {
  const settings = await openSettings(page)
  await settings.getByRole('button', { name: 'Add Template' }).click()

  // The folder picker, over the registered tree — the same widget Move uses, which is why there is
  // one of it rather than two.
  const picker = page.getByRole('dialog', { name: 'Which folder is the template?' })
  await expect(picker).toBeVisible()
  /**
   * By ROW, never by index. `settings-folders.spec.ts` registers a second folder and runs first
   * alphabetically, so the picker can hold two root rows by the time this does — and `nth(1)` then
   * expands the wrong one.
   */
  await picker.locator('.picker-row')
    .filter({ has: page.getByText('02-projects', { exact: true }) })
    .locator('.picker-twisty').click()
  await picker.getByText(templateFolder(testInfo), { exact: true }).click()
  await picker.getByRole('button', { name: 'Use This Folder' }).click()

  await page.locator('.modal-input').fill(templateName(testInfo, tag))
  await page.getByRole('button', { name: 'Add Template' }).last().click()

  await expect(settings.getByText(templateName(testInfo, tag), { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Close' }).click()
}

test('a folder can be named as a template, and it appears in the row menu', async (
  { page }, testInfo,
) => {
  await addTemplate(page, testInfo, 'menu')

  await openRoot(page)
  const tree = await openFolder(page, '02-projects')
  const target = tree.locator('.tree-row')
    .filter({ has: page.getByText(scaffoldFolder(testInfo), { exact: true }) })
  await target.locator('.row-menu-button').click()

  // Named for the template, so the menu reads the way the operator described the action.
  await expect(page.getByRole('menuitem', { name: `New ${templateName(testInfo, 'menu')}` }))
    .toBeVisible()
  await page.keyboard.press('Escape')
})

/**
 * **THE WHOLE FEATURE, IN ONE TEST.** Click the template, name the thing, and the shape appears
 * where you asked for it — copied verbatim, with the empty folder intact.
 */
test('scaffolding copies the shape verbatim, including the .gitkeep', async (
  { page }, testInfo,
) => {
  await addTemplate(page, testInfo, 'scaffold')

  await openRoot(page)
  const tree = await openFolder(page, '02-projects')
  const target = tree.locator('.tree-row')
    .filter({ has: page.getByText(scaffoldFolder(testInfo), { exact: true }) })
  await target.locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: `New ${templateName(testInfo, 'scaffold')}` }).click()

  /**
   * **Nothing is created until the name is filled.** The operator: *"a field that has to be filled with
   * op-hollis-outreach or whatever before it scaffolds where you tell it to scaffold."*
   */
  await expect(page.locator('.modal-confirm')).toBeDisabled()
  await page.locator('.modal-input').fill('op-hollis-outreach')
  await expect(page.locator('.modal-confirm')).toBeEnabled()
  await page.locator('.modal-confirm').click()

  // On screen, in the folder whose menu was used, and that folder is opened so it is visible.
  await expect(tree.getByText('op-hollis-outreach', { exact: true }))
    .toBeVisible({ timeout: 15_000 })

  const made = join(E2E_TREE, '02-projects', scaffoldFolder(testInfo), 'op-hollis-outreach')
  // Verbatim. No renaming of any file, by their ruling.
  expect(await readFile(join(made, '00-context', 'context-template.md'), 'utf8'))
    .toBe('# context\n')
  // And the empty folder still exists in git, because its .gitkeep came through.
  expect((await stat(join(made, '01-inbox', '.gitkeep'))).isFile()).toBe(true)
})

/**
 * Removing a template takes the menu item with it — and touches no file. The same sentence Remove-a-
 * folder carries, for the same reason: in an app whose promise is that nothing is deleted, a button
 * named Remove has to say which kind it is.
 */
test('removing a template leaves the folder alone and takes the menu item away', async (
  { page }, testInfo,
) => {
  await addTemplate(page, testInfo, 'remove')

  const settings = await openSettings(page)
  await settings
    .getByRole('button', { name: `Remove the ${templateName(testInfo, 'remove')} template` })
    .click()
  await expect(settings.getByText('The folder is untouched.', { exact: false })).toBeVisible()
  await settings.getByRole('button', { name: 'Close' }).click()

  // The folder it pointed at is still there.
  const source = join(E2E_TREE, '02-projects', templateFolder(testInfo))
  expect((await stat(source)).isDirectory()).toBe(true)

  // And the row menu no longer offers it.
  await openRoot(page, TREE)
  const tree = await openFolder(page, '02-projects')
  const target = tree.locator('.tree-row')
    .filter({ has: page.getByText(scaffoldFolder(testInfo), { exact: true }) })
  await target.locator('.row-menu-button').click()
  await expect(page.getByRole('menuitem', { name: `New ${templateName(testInfo, 'remove')}` }))
    .toHaveCount(0)
  await page.keyboard.press('Escape')
})
