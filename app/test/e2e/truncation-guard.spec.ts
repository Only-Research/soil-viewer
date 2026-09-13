import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page, type TestInfo } from '@playwright/test'

import { openRoot } from './tree-nav'

import { E2E_TREE } from '../../playwright.config'

/**
 * **§13.2's truncation confirmation, end to end.** The question that was specified, built on the
 * server, and asked by nothing.
 *
 * The sweep of 2026-08-16 found `DocumentSession.confirmTruncation` called by exactly two tests and
 * no product code. Everything around it worked: the guard refuses the write, the response carries
 * both byte counts, the wire carries the waiver flag. What shipped at the surface was a banner that
 * named the loss and offered no way to answer it — under a comment calling it *"a question, not a
 * failure."*
 *
 * **These tests exist because a unit test could not have caught that.** The wording had helpers, the
 * session had a method, and both were covered; the missing piece was that nothing joined them. That
 * is this build's signature defect — *"complete, tested and reachable by nothing"* — and the only
 * instrument that detects it is one that drives the real surface and then reads the disk.
 *
 * **So both tests assert against the file, not against the screen.** A dialog that appears and a
 * save that lands are two different claims, and only the second one is the feature.
 */

const SAVE_DEADLINE_MS = 10_000

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

function scratchFolder(testInfo: TestInfo, purpose: string): string {
  return `scratch-${testInfo.project.name}-${purpose}`
}

function subjectPath(testInfo: TestInfo, purpose: string): string {
  return join(E2E_TREE, '02-projects', scratchFolder(testInfo, purpose), 'subject.md')
}

async function openSubject(page: Page, testInfo: TestInfo, purpose: string) {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  const folder = scratchFolder(testInfo, purpose)
  await tree.locator('.tree-row').filter({ has: page.getByText(folder, { exact: true }) }).click()
  await tree.getByText('subject', { exact: true }).click()
  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('the scratch document')
  return editor
}

/** Select everything and replace it with a few characters — well under §13.2's half. */
async function gutTheDocument(page: Page, editor: ReturnType<Page['locator']>): Promise<void> {
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('gone')
}

test('a save that would delete most of the file asks, and writes when told to', async (
  { page }, testInfo,
) => {
  const editor = await openSubject(page, testInfo, 'truncate-yes')
  const file = subjectPath(testInfo, 'truncate-yes')
  const before = await readFile(file, 'utf8')

  await gutTheDocument(page, editor)

  /**
   * **The dialog arrives on the AUTOSAVE, with nothing clicked to summon it.** That is the whole
   * reachability claim: the surface asks by itself, on the path a person actually takes, rather
   * than exposing a method somebody could have called.
   */
  const dialog = page.getByRole('dialog', { name: 'Confirm a large deletion' })
  await expect(dialog).toBeVisible({ timeout: SAVE_DEADLINE_MS })

  // It NAMES the loss — §13.2's actual requirement, not merely that it refused.
  await expect(dialog).toContainText('Saving would delete')
  await expect(dialog).toContainText('bytes from subject.md')
  await expect(dialog).toContainText('Nothing has been written')

  // Untouched while the question is open. The refusal is real, not a warning shown after the fact.
  expect(await readFile(file, 'utf8')).toBe(before)

  await dialog.getByRole('button', { name: 'Delete it and save' }).click()
  await expect(dialog).toHaveCount(0)

  await expect(page.locator('.save-status')).toHaveText('Saved', { timeout: SAVE_DEADLINE_MS })
  /**
   * **The bytes, from disk.** `confirmTruncation` re-issues the identical save with the waiver
   * attached, so this is the assertion that the waiver reached the server and was honoured — the
   * one thing no amount of client-side testing could show.
   */
  await expect.poll(() => readFile(file, 'utf8'), { timeout: SAVE_DEADLINE_MS }).toBe('gone')
})

test('answering no leaves the file alone and does not ask again on every keystroke', async (
  { page }, testInfo,
) => {
  const editor = await openSubject(page, testInfo, 'truncate-no')
  const file = subjectPath(testInfo, 'truncate-no')
  const before = await readFile(file, 'utf8')

  await gutTheDocument(page, editor)

  const dialog = page.getByRole('dialog', { name: 'Confirm a large deletion' })
  await expect(dialog).toBeVisible({ timeout: SAVE_DEADLINE_MS })
  await dialog.getByRole('button', { name: "Don't save" }).click()
  await expect(dialog).toHaveCount(0)

  expect(await readFile(file, 'utf8')).toBe(before)

  /**
   * **The part that makes a modal safe to use here.** A blocked save never clears the dirty flag, so
   * every later autosave is refused exactly the same way. Re-asking on each one would put a dialog
   * in front of somebody once per quiet period — a trap rather than a confirmation.
   *
   * So the second refusal falls back to §13.5's persistent banner: still visible, still says what
   * happened, does not seize the screen again.
   */
  await editor.click()
  await page.keyboard.type(' still gone')

  await expect(page.locator('.feedback-banner').filter({ hasText: 'Saving would delete' }))
    .toBeVisible({ timeout: SAVE_DEADLINE_MS })
  await expect(dialog).toHaveCount(0)

  expect(await readFile(file, 'utf8')).toBe(before)
})
