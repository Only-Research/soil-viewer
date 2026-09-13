import { expect, test, type Page } from '@playwright/test'

import { openRoot } from './tree-nav'

/**
 * **THE SELECTION MODEL — packet §4.6, and the operator's report of the defect it removes:**
 *
 * > *"the last picked file also stays highlighted while the one you're picking 3 dots on also is
 * > highlighted."*
 *
 * Three states, three treatments that cannot be mistaken for one another: *open* is a teal left
 * border plus the selected ground, *acted on* is the hover ground and nothing else, *focused* is a
 * ring. Before this they were two, both a background wash, and nothing told you which was which.
 *
 * ## Why these assertions are computed styles rather than class names
 *
 * `toHaveClass('is-selected')` would pass against a stylesheet in which the class does nothing, and
 * the whole complaint here was about **what a person sees**. `.board-card.has-menu` is the proof
 * that matters: the rule existed in the stylesheet for a full design step and **nothing anywhere set
 * the class**, so it read as built and was not. A class assertion would have called that green.
 *
 * The exact teal is `--accent-teal`, `#5b9fa6`.
 */

const TEAL = 'rgb(91, 159, 166)'
const TRANSPARENT = 'rgba(0, 0, 0, 0)'

/**
 * **The whole class token, not a substring of one.**
 *
 * `toHaveClass(/has-menu/)` matches `has-menu-typo` — which is exactly the mutation used to check
 * this suite, and it passed. A bare regex here tests that the class *name* appears somewhere in the
 * attribute, which is not the same claim as the class being set.
 */
const HAS_MENU = /(^|\s)has-menu(\s|$)/

/** A row by the name it shows, scoped to the tree so the document header cannot match. */
const rowNamed = (page: Page, name: string) =>
  page.locator('.files-sidebar .tree-row').filter({ hasText: name }).first()

async function openFilesTree(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await openRoot(page)
}

test.describe('the tree', () => {
  /**
   * **THE REPORTED DEFECT, as a single assertion.** One row open, a different row's menu up, and
   * the two must not be wearing the same treatment.
   *
   * The check is that the *open* row still carries its teal border and the *acted on* row does not.
   * Under the old model both were a grey wash and this could not be expressed at all.
   */
  test('an open file and a menu on another row cannot be confused', async ({ page }) => {
    await openFilesTree(page)

    /**
     * Named rows rather than indexes. With the root open the tree shows `02-projects` and
     * `readme.md`; a `.tree-row-file` at `nth(1)` does not exist, and asking for one is a 30-second
     * timeout rather than a failure that says so. The scratch folders other suites seed mean the
     * count here is not even stable — only the names are.
     */
    const first = rowNamed(page, 'readme')
    await first.click()
    await expect(first).toHaveCSS('border-inline-start-color', TEAL)

    const second = rowNamed(page, '02-projects')
    await second.locator('.row-menu-button').click()
    await expect(page.locator('.row-menu')).toBeVisible()

    // The row the menu belongs to is marked — this is the half that did not exist.
    await expect(second).toHaveClass(HAS_MENU)
    await expect(
      second,
      'the acted-on row must NOT wear the open marker — that is the whole complaint',
    ).toHaveCSS('border-inline-start-color', TRANSPARENT)
    await expect(
      first,
      'and the open row keeps its own, so you can still see what is in the editor',
    ).toHaveCSS('border-inline-start-color', TEAL)
  })

  /**
   * *Acted on* is a state of the menu, so it must not outlive it. Every close path clears it because
   * they all run through one `close()` — this asserts the two that a person actually uses.
   */
  test('the mark goes when the menu does, by Escape and by clicking away', async ({ page }) => {
    await openFilesTree(page)
    const row = page.locator('.tree-row-file').first()

    await row.locator('.row-menu-button').click()
    await expect(row).toHaveClass(HAS_MENU)
    await page.keyboard.press('Escape')
    await expect(page.locator('.row-menu')).toHaveCount(0)
    await expect(row, 'Escape closed the menu; the mark went with it').not.toHaveClass(HAS_MENU)

    await row.locator('.row-menu-button').click()
    await expect(row).toHaveClass(HAS_MENU)
    await page.locator('.pane-body, .files-main').first().click({ position: { x: 5, y: 5 } })
    await expect(row, 'an outside click closed it; likewise').not.toHaveClass(HAS_MENU)
  })

  /**
   * **Exactly one row wears the mark at a time.** Opening a second menu without clearing the first
   * would leave two rows lit — the reported defect, reintroduced from the other direction.
   */
  test('only one row is ever the acted-on one', async ({ page }) => {
    await openFilesTree(page)

    await rowNamed(page, 'readme').locator('.row-menu-button').click()
    await expect(page.locator('.tree-row.has-menu')).toHaveCount(1)

    await rowNamed(page, '02-projects').locator('.row-menu-button').click()
    await expect(page.locator('.tree-row.has-menu'), 'the first row let go').toHaveCount(1)
    await expect(rowNamed(page, '02-projects')).toHaveClass(HAS_MENU)
  })

  /**
   * §4.2: *"every other row reserves 2px transparent so nothing shifts."* Without it the whole tree
   * jumps two pixels sideways around whatever you just opened.
   */
  test('an unopened row reserves the marker width, so nothing moves', async ({ page }) => {
    await openFilesTree(page)

    const row = page.locator('.tree-row-file').first()
    /**
     * **Waited for before it is measured**, and this was a real flake rather than a precaution.
     *
     * `boundingBox()` does not auto-wait. `openRoot` returns once the root has expanded, but a FILE
     * row inside it can still be a frame away — so this read `null` once in a full suite run and
     * reported "the row must have a box", which reads like the tree failed to render. Every
     * measurement in this build has to be preceded by something that polls.
     */
    await expect(row).toBeVisible()
    const before = await row.boundingBox()
    await expect(row).toHaveCSS('border-inline-start-width', '2px')
    await expect(row).toHaveCSS('border-inline-start-color', TRANSPARENT)

    await row.click()
    await expect(row).toHaveCSS('border-inline-start-color', TEAL)

    const after = await row.boundingBox()
    expect(before, 'the row must have a box').not.toBeNull()
    expect(after, 'and still have one').not.toBeNull()
    if (before === null || after === null) return
    expect(Math.round(after.x), 'the row did not move when it was opened').toBe(Math.round(before.x))
  })
})

test.describe('the board', () => {
  /**
   * **`.board-card.has-menu` was styled and set by nothing.** It shipped in the card design step
   * looking complete. This is the assertion that would have caught that, and it is deliberately a
   * behaviour check rather than a CSS one: open the card's status menu, require the card to say so.
   */
  test('a card is marked while its status menu is up, and only that card', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click()

    const board = page.locator('.tasks-pane:not([hidden])')
    const card = board.locator('.board-card').first()
    await expect(card).toBeVisible()

    await card.locator('.board-card-menu').click()
    await expect(page.locator('.row-menu')).toBeVisible()
    await expect(card).toHaveClass(HAS_MENU)
    await expect(board.locator('.board-card.has-menu')).toHaveCount(1)

    await page.keyboard.press('Escape')
    await expect(card).not.toHaveClass(HAS_MENU)
  })
})
