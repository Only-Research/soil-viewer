import { expect, test } from '@playwright/test'

import { openRoot } from './tree-nav'

/**
 * §18.6 IN A REAL BROWSER, AT A REAL PHONE SIZE.
 *
 * **The unit tests prove the branch; only this proves the placement.** A menu can carry the right
 * class and still be positioned wrong — the sheet is placed entirely by the stylesheet, so a
 * mistake there is invisible to every test that reads markup. This file exists for the same reason
 * `files-tab.spec.ts` does: a control that is correct in the DOM and unreachable on screen is the
 * failure this build keeps finding.
 *
 * **390 × 844 is the user's phone**, not a round number chosen to be safely under the breakpoint.
 */

const PHONE = { width: 390, height: 844 }

/**
 * §18.6's floor for the SHEET — a menu, where the neighbouring item moves a file.
 */
const MENU_TOUCH_MIN = 44

/**
 * The floor for a row in the dense scrolling tree, and it is deliberately lower.
 *
 * **ruled 2026-08-13, after using it on their phone:** rows went 23 -> 44 and *"height is
 * just a bit too tall, maybe take it down 10%."* 44 x 0.9 = 39.6, so 40.
 *
 * Mirrors `--touch-row-min` in `tokens.css`, where the reasoning lives. **Under §18.6 and under
 * Apple's guidance, knowingly** — logged as a reduction in `open-items.md`. The test moved because
 * the rule moved, not to make a failure go away.
 */
const TREE_TOUCH_MIN = 40

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(PHONE)
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
})

test('below the breakpoint the app says so, once, where everything can read it', async ({ page }) => {
  // §18.1. Asserted before anything that depends on it, so a failure here does not present as a
  // menu bug three cases later.
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'mobile')
})

test('the row menu opens as a sheet against the bottom edge', async ({ page }) => {
  const tree = await openRoot(page)

  // A real row inside the expanded root, not `.first()` -- the first row is the registered folder
  // itself, and the root row is not an ordinary row. Chosen the same way `files-tab.spec.ts` does.
  await tree.locator('.tree-row', { hasText: 'readme' }).locator('.row-menu-button').click()

  const menu = page.locator('.row-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveClass(/row-menu-sheet/)

  const box = await menu.boundingBox()
  expect(box, 'the menu has no box').not.toBeNull()
  if (box === null) return

  /**
   * **Against the bottom edge and spanning the width**, which is the whole of the placement claim.
   * Asserted as a relationship to the viewport rather than as pixels, so the case survives a change
   * to padding or the safe-area inset — those move the *contents*, not the edge the sheet sits on.
   */
  expect(Math.round(box.y + box.height), 'not flush with the bottom').toBe(PHONE.height)
  expect(Math.round(box.x), 'not flush with the left').toBe(0)
  expect(Math.round(box.width), 'not full width').toBe(PHONE.width)

  /**
   * **And it is in the reachable half.** This is the sentence §18.6 is actually about — a clamped
   * dropdown would also be "on screen", which is why on-screen is not what is asserted.
   */
  expect(box.y, 'the sheet starts in the upper half of the screen').toBeGreaterThan(PHONE.height / 2)
})

/**
 * **§4.8's sheet furniture, and all three answer one problem: a sheet has no visible owner.**
 *
 * A dropdown is anchored to the `⋯` you pressed, so what it acts on is obvious. A sheet rises from
 * the bottom edge with that row possibly scrolled out of sight, and every item on it is a file
 * operation. **The target used to be named in exactly one place — the menu's `aria-label` — which
 * is the one place a person looking at the screen cannot read.**
 */
test('the sheet says what it acts on, and offers a way out that is not the app behind it', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: 'readme' }).locator('.row-menu-button').click()

  const menu = page.locator('.row-menu-sheet')
  await expect(menu).toBeVisible()

  // The subject, on screen. `readme.md` — the true filename, not the tree's spaced display name.
  await expect(menu.locator('.row-menu-subject')).toHaveText('readme.md')
  await expect(menu.locator('.row-menu-grabber')).toBeVisible()

  /**
   * **This asserts Close DISMISSES, not that its own handler is what does it — and the difference
   * was found by mutating.**
   *
   * Emptying the handler leaves this test green, because `onDocument('click', () => close())` has
   * no inside-the-menu exemption and dismisses on any press. So the claim here is the one a person
   * cares about: the button is on screen, thumb-sized, and the sheet goes away. The handler exists
   * for the day an exemption is added, and nothing here can prove that — said plainly rather than
   * left looking like coverage it is not.
   */
  const close = menu.getByRole('button', { name: 'Close' })
  await expect(close).toBeVisible()
  const box = await close.boundingBox()
  expect(box, 'Close must have a box').not.toBeNull()
  if (box === null) return
  expect(box.height, 'and be thumb-sized like everything else here')
    .toBeGreaterThanOrEqual(MENU_TOUCH_MIN)

  await close.click()
  await expect(page.locator('.row-menu')).toHaveCount(0)
})

/**
 * Close is not one of the actions. A screen reader counting through a list of file operations
 * should not find it among them, and neither should anything driving the menu by role.
 */
test('Close is not counted as one of the file actions', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: 'readme' }).locator('.row-menu-button').click()

  const menu = page.locator('.row-menu-sheet')
  const items = menu.getByRole('menuitem')
  await expect(items.filter({ hasText: 'Close' })).toHaveCount(0)
  // And the real actions are still there, so this is not passing against an empty menu.
  await expect(items.filter({ hasText: 'Rename' })).toHaveCount(1)
})

test('its items are big enough to hit with a thumb', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: 'readme' }).locator('.row-menu-button').click()

  const items = page.locator('.row-menu-sheet .row-menu-item')
  const count = await items.count()
  expect(count, 'the sheet has no items').toBeGreaterThan(0)

  for (let index = 0; index < count; index++) {
    const box = await items.nth(index).boundingBox()
    // §18's 44 pt floor. The consequence of a small target here is not a miss but a WRONG HIT, on a
    // list where the neighbouring item may move a file. **This one stays at 44** when the tree's
    // floor came down — see TREE_TOUCH_MIN. That difference is the whole argument.
    expect(box?.height ?? 0, `item ${index} is under the ${MENU_TOUCH_MIN}pt floor`)
      .toBeGreaterThanOrEqual(MENU_TOUCH_MIN)
  }
})

test('the tree ROWS clear the touch floor, and so does the control on them', async ({ page }) => {
  /**
   * **This case exists because a real phone found what 250 browser tests did not.**
   *
   * ruled 2026-08-13, on the first run over the tailnet: *"the lines are very small and hard to
   * click on."* Measured at 375 px before anything changed — **rows 23 px, the `⋯` 12.8 × 22.7 px** —
   * against §18.6's *"Row targets ≥ 44 pt."*
   *
   * **The gap was not that the floor was unwritten. It was that the only test asserting it looked at
   * the bottom sheet's items**, which are a menu you have already opened. Nothing looked at the tree
   * itself — the surface you spend the entire time on, and the one you must hit accurately to open
   * that menu at all. `board-card-menu` had carried the floor in CSS since §18.5; the tree never did.
   *
   * The consequence is the same one the sheet case names, one step earlier: on a dense tree a small
   * target is not a miss, it is a **wrong hit** — the neighbouring row is a different file.
   */
  const tree = await openRoot(page)

  const rows = tree.locator('.tree-row')
  const rowCount = await rows.count()
  expect(rowCount, 'no rows to measure').toBeGreaterThan(0)

  for (let index = 0; index < rowCount; index++) {
    const box = await rows.nth(index).boundingBox()
    expect(box?.height ?? 0, `tree row ${index} is under the ${TREE_TOUCH_MIN}px floor`)
      .toBeGreaterThanOrEqual(TREE_TOUCH_MIN)
  }

  /**
   * **The control is measured on both axes, deliberately.** A button can inherit a tall row and
   * still be a few pixels wide — which is exactly what it was: 22.7 px across inside a 23 px row.
   */
  const buttons = tree.locator('.row-menu-button')
  const buttonCount = await buttons.count()
  expect(buttonCount, 'no row menu buttons to measure').toBeGreaterThan(0)

  for (let index = 0; index < buttonCount; index++) {
    const box = await buttons.nth(index).boundingBox()
    /**
     * **Height tracks the row's floor; width does not.** A button taller than the row would hold
     * every row open to the button's size — which is how the row floor would quietly stop being the
     * row floor. Width keeps the full 44: the button is right-aligned against the edge with nothing
     * beside it, so horizontal room is free and there is no reason to spend the accuracy.
     */
    expect(box?.height ?? 0, `⋯ ${index} is under the ${TREE_TOUCH_MIN}px row floor`)
      .toBeGreaterThanOrEqual(TREE_TOUCH_MIN)
    expect(box?.width ?? 0, `⋯ ${index} is narrower than the full ${MENU_TOUCH_MIN}pt`)
      .toBeGreaterThanOrEqual(MENU_TOUCH_MIN)
  }
})

test('a desktop viewport still gets the anchored dropdown', async ({ page }) => {
  /**
   * The control, and it is not redundant with the unit test: that one proves the *branch* against a
   * fake document, this proves the desktop path still measures and places itself in a real one.
   * A build that made every menu a sheet would satisfy every other case in this file.
   */
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'desktop')

  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: 'readme' }).locator('.row-menu-button').click()

  const menu = page.locator('.row-menu')
  await expect(menu).toBeVisible()
  await expect(menu).not.toHaveClass(/row-menu-sheet/)

  const box = await menu.boundingBox()
  expect(box?.width ?? 9999, 'a dropdown spanning the viewport is a sheet by another name')
    .toBeLessThan(1280)

  /**
   * **The desktop keeps its density, and that is a requirement rather than an accident.**
   *
   * The 44 pt floor was added for a thumb. Applying it to a pointer would nearly double the height
   * of every row in a tree the operator reads all day, on the surface they did not complain about — and the
   * design language is inherited verbatim from the annex, so this is the kind of change that has to
   * be scoped on purpose and proven to be scoped. The CSS is written against
   * `:root[data-layout='mobile']`, and this is what stops a later edit widening it.
   */
  const rowHeight = (await tree.locator('.tree-row').first().boundingBox())?.height ?? 0
  expect(rowHeight, 'the phone floor must not reach the desktop tree')
    .toBeLessThan(TREE_TOUCH_MIN)
})
