import { showOnly } from './board-nav'
import { expect, test, type Page } from '@playwright/test'

import { openRoot } from './tree-nav'

/**
 * **DRILLING INTO FILES FROM ANOTHER TAB LEAVES A WAY BACK.** PRD, navigation:
 *
 * > *"drilling into a file from another tab leaves a back control labeled with the origin tab;
 * > Escape goes back and never fires while a modal or panel is open; the open file's full path is
 * > always visible in the strip above the editor."*
 *
 * Without it the jump out of a slide-over is one-way: you land in a tree you did not open, on a tab
 * you did not choose, and the only route back is to work out which tab you came from and click it.
 *
 * **Labelled with the origin tab, not "Back"** — that is the part of the sentence with a
 * requirement in it. The control has to say *where* it goes, because the whole problem it solves is
 * that the person no longer knows where they were.
 *
 * The second clause is the adversarial half and gets its own cases below. This listener is
 * registered at boot, so on the document it runs **before** every dialog's own Escape handler — one
 * press could dismiss a rename dialog and change tab underneath it.
 */

const backControl = (page: Page) => page.locator('.files-back-button')
/**
 * The bar, asserted separately from the button inside it. Asking only about the button was too
 * weak: with the hide branch broken the bar stayed on screen as an empty strip in the sidebar and
 * every case still passed, because an empty bar has no button to find.
 */
const backBar = (page: Page) => page.locator('.files-back')

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
}

/** Opens the seeded task card in the Tasks slide-over and takes its jump into Files. */
async function drillInFromTasks(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
  await showOnly(page, 'orchard')

  const card = page.locator('.board-card').filter({ hasText: 'Press repair' }).first()
  await expect(card).toBeVisible()
  await card.click()
  await page.getByRole('button', { name: 'View in Files' }).click()
  // The jump has landed when the editor is up, not when the click returns.
  await expect(page.locator('.files-main .cm-content')).toBeVisible()
}

test.describe('the back control', () => {
  test('names the tab you came from, and takes you there', async ({ page }) => {
    await boot(page)
    await drillInFromTasks(page)

    await expect(backBar(page)).toBeVisible()
    await expect(backControl(page)).toHaveText('← Tasks')
    await backControl(page).click()

    await expect(page.getByRole('tab', { name: 'Tasks', exact: true }))
      .toHaveAttribute('aria-selected', 'true')
    // And it is gone once used: there is nothing left to go back to, and a control offering to
    // return you to the tab you are standing on is worse than no control at all.
    await expect(backBar(page)).toBeHidden()
  })

  test('is not there when you opened Files yourself', async ({ page }) => {
    await boot(page)
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await expect(backBar(page)).toBeHidden()
  })

  test('is cleared by choosing another tab, rather than surviving as a stale offer', async ({ page }) => {
    await boot(page)
    await drillInFromTasks(page)
    await expect(backControl(page)).toBeVisible()

    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await expect(backBar(page)).toBeHidden()
  })

  /**
   * The Projects board's jump reveals a **folder** and opens no file at all, so there is no editor
   * header for a back control to live in. That is exactly why the control is mounted in the sidebar
   * instead: one place, drawn once, present for every drill-in rather than most of them.
   */
  test('is left by the Projects jump too, which opens no file', async ({ page }) => {
    await boot(page)
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await expect(page.locator('.board-card').first()).toBeVisible()
    await page.locator('.board-card').filter({
      has: page.locator('.board-card-title', { hasText: /^orchard$/ }),
    }).click()
    await page.getByRole('button', { name: 'View in Files' }).click()

    await expect(backBar(page)).toBeVisible()
    await expect(backControl(page)).toHaveText('← Projects')
  })

  test('Escape goes back', async ({ page }) => {
    await boot(page)
    await drillInFromTasks(page)

    await page.keyboard.press('Escape')
    await expect(page.getByRole('tab', { name: 'Tasks', exact: true }))
      .toHaveAttribute('aria-selected', 'true')
  })

  /**
   * **THE ONE THAT MATTERS.** A rename dialog is open, on the Files tab, with a back control
   * showing. One Escape must close the dialog and leave you exactly where you are.
   *
   * This handler is registered at boot and the dialog's is registered when it opens, so on the
   * document this one runs first. Without the modal check the press would do both: dismiss the
   * dialog *and* change tab, and the person would be looking at a board wondering what happened to
   * the rename they were half-way through.
   */
  test('Escape does NOT go back while a dialog is open — the dialog takes the press', async ({ page }) => {
    await boot(page)
    await drillInFromTasks(page)

    /**
     * A row from the tree rather than the file that was just opened: the jump opens a document, it
     * does not reveal the row it came from, so there is nothing named `press-repair` on screen. Any
     * row with a Rename will do — the subject is the Escape, and this dialog is dismissed rather
     * than used, so nothing on disk is touched.
     */
    const tree = await openRoot(page)
    const row = tree.locator('.tree-row').filter({ hasText: '02-projects' }).first()
    await expect(row).toBeVisible()
    await row.locator('.row-menu-button').click()
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    await expect(page.locator('.modal-backdrop')).toHaveCount(1)

    await page.keyboard.press('Escape')

    await expect(page.locator('.modal-backdrop')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Files', exact: true }))
      .toHaveAttribute('aria-selected', 'true')
    // Still offered — the press was the dialog's, and it did not consume the way back.
    await expect(backControl(page)).toHaveText('← Tasks')
  })
})
