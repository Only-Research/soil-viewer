import { expect, test } from '@playwright/test'

import { openRoot } from './tree-nav'

/**
 * §18.4 — ON A PHONE YOU ARE IN THE TREE OR IN THE DOCUMENT, NEVER BOTH.
 *
 * the operator, settling it: *"you're either in one or the other. Trying to have both of them on the
 * screen is the only thing that I know for sure."* The clause this replaced asked for a drawer
 * **and** one-level-at-a-time drilling in the same sentence, which is two different designs.
 *
 * **The case that matters most is the last one.** §18.4 makes "back restores scroll position and
 * open folders" a requirement rather than a nicety, because a back control that returns you to a
 * collapsed tree scrolled to the top is what makes a phone file browser unusable.
 */

const PHONE = { width: 390, height: 844 }

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(PHONE)
  /**
   * **`domcontentloaded`, not the default `load`.** In the full suite this hook timed out at thirty
   * seconds on WebKit, deterministically and at one test -- and it survived clearing the ports, so
   * it was not the stale-server signature it first resembled.
   *
   * `load` waits for every subresource to settle, which is a promise about the network rather than
   * about the app. The readiness this file actually needs is the line below: `#app` attached, which
   * is the client having mounted. Waiting for the weaker event and then asserting the stronger
   * condition is a tighter contract than waiting for `load` and assuming.
   */
  const landed = await page.goto('/', { waitUntil: 'domcontentloaded' })
  expect(landed?.status(), 'the shell itself was refused').toBe(200)
  await expect(page.locator('#app')).toBeAttached()
})

test('starts on the tree, with the document half off screen', async ({ page }) => {
  await openRoot(page)
  await expect(page.locator('.files-pane')).toHaveAttribute('data-screen', 'tree')
  await expect(page.locator('.files-sidebar')).toBeVisible()
  await expect(page.locator('.files-main')).toBeHidden()
  await expect(page.locator('.files-screen-back')).toBeHidden()
})

test('opening a file moves you to the document, and the tree goes away', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: 'readme' }).first().click()

  await expect(page.locator('.files-pane')).toHaveAttribute('data-screen', 'document')
  await expect(page.locator('.files-main')).toBeVisible()
  await expect(page.locator('.files-sidebar'), 'both halves are on screen at once').toBeHidden()
  await expect(page.locator('.files-screen-back')).toBeVisible()
})

test('the way back names where it goes, and is big enough to hit', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: 'readme' }).first().click()

  const back = page.locator('.files-screen-back')
  // A bare chevron is a promise about somewhere you cannot see, since the tree is off screen.
  await expect(back).toContainText('Files')
  expect((await back.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
})

test('back returns to the tree exactly as it was left', async ({ page }) => {
  /**
   * **The requirement, not a nicety.** The implementation hides the tree rather than unmounting it,
   * so this is structural — but that is precisely why it needs a test: the property is invisible
   * until someone "optimises" the hidden half away, and then it is invisible again until a person
   * loses their place.
   */
  const tree = await openRoot(page)

  // Expand something deeper, so there is a state that a rebuild would not reproduce.
  await tree.locator('.tree-row', { hasText: '02-projects' }).first().click()

  /**
   * **Anchored before counting, and the first draft was not.** Expansion is a round trip; the count
   * ran while the tree still showed 3 rows and then compared it against the 72 that arrived. The
   * red said "expected 3, received 72", which reads as a bug in the restore and was a bug in the
   * measurement -- the fourth time in two days a test read a value at a moment nothing pinned.
   */
  await expect(tree.locator('.tree-row', { hasText: 'orchard' }).first()).toBeVisible()
  const expandedBefore = await tree.locator('.tree-row').count()
  expect(expandedBefore, 'nothing was expanded, so the case proves nothing').toBeGreaterThan(3)

  await tree.locator('.tree-row', { hasText: 'readme' }).first().click()
  await expect(page.locator('.files-pane')).toHaveAttribute('data-screen', 'document')

  await page.locator('.files-screen-back').click()

  await expect(page.locator('.files-pane')).toHaveAttribute('data-screen', 'tree')
  await expect(page.locator('.files-sidebar')).toBeVisible()
  // Same rows, still expanded -- a rebuilt tree would have collapsed back to its roots.
  await expect(tree.locator('.tree-row')).toHaveCount(expandedBefore)
})

test('a desktop viewport shows both halves and offers no way back', async ({ page }) => {
  /**
   * The control. A build that applied the split at every width would satisfy every case above and
   * would have taken the tree away from the desktop, where §18.4 says nothing at all.
   */
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.reload()

  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: 'readme' }).first().click()

  await expect(page.locator('.files-sidebar')).toBeVisible()
  await expect(page.locator('.files-main')).toBeVisible()
  await expect(page.locator('.files-screen-back')).toBeHidden()
})
