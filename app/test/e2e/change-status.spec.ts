import { type Page, expect, test } from '@playwright/test'

import { showOnly } from './board-nav'

/**
 * §18.5 — CHANGE STATUS, IN A REAL BROWSER, MOVING A REAL FILE.
 *
 * **This is the phone's only way to move a card**, because §18.5 removed the drag there. It ships on
 * the desktop too, and that is the point rather than a convenience: one mechanism, one set of tests,
 * with the drag demoted to an accelerator. A phone-only path would be a second way to move a file
 * with only one of the two proven.
 *
 * Driven at a desktop size **and** at 390 × 844, because the two differ in how the menu is presented
 * (§18.6) and not at all in what it does — and a claim that they are the same operation is worth a
 * test rather than a sentence.
 */

const laneNamed = (page: Page, name: string) =>
  page.locator('.board-lane').filter({
    has: page.locator('.board-lane-name', { hasText: new RegExp(`^${name}$`) }),
  })

const cardNamed = (page: Page, title: string) =>
  page.locator('.board-card').filter({
    has: page.locator('.board-card-title', { hasText: new RegExp(`^${title}$`) }),
  })

async function openTheBoard(page: Page, project: string, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
  await showOnly(page, project)
  await expect(laneNamed(page, 'Next')).toBeVisible()
}

/** The first card in a lane, by the title the board drew — the same handle a person would use. */
async function firstCardTitleIn(page: Page, lane: string): Promise<string> {
  const title = await laneNamed(page, lane).locator('.board-card-title').first().textContent()
  expect(title, `no card in ${lane}`).toBeTruthy()
  return (title ?? '').trim()
}

test.describe('change status', () => {
  test('moves the card to the chosen lane, with no confirmation in the way',
    async ({ page }, testInfo) => {
      await openTheBoard(page, `scratch-${testInfo.project.name}-change-status`, 1600, 900)

      const title = await firstCardTitleIn(page, 'Next')
      await expect(cardNamed(page, title)).toHaveCount(1)

      await cardNamed(page, title).locator('.board-card-menu').click()

      /**
       * **No confirmation step is asserted by its absence being impossible to fake:** the very next
       * thing after the choice is the card being in the other lane. If a dialog had appeared, this
       * would time out rather than pass — §18.5 and the operator directly: *"I agree it should not ask
       * are you sure?"*
       */
      await page.locator('.row-menu-item', { hasText: /^Doing$/ }).click()

      await expect(laneNamed(page, 'Doing').locator('.board-card-title', { hasText: title }))
        .toHaveCount(1)
      await expect(laneNamed(page, 'Next').locator('.board-card-title', { hasText: title }))
        .toHaveCount(0)
    })

  test('offers the lane the card is already in, marked, and choosing it changes nothing',
    async ({ page }, testInfo) => {
      /**
       * The current lane is offered so the list keeps its shape wherever the card is — otherwise the
       * same status sits under a different finger each time, on a list whose neighbouring row moves
       * a file. Choosing it must be inert rather than a round trip that changes nothing.
       */
      await openTheBoard(page, `scratch-${testInfo.project.name}-change-status-same`, 1600, 900)

      const title = await firstCardTitleIn(page, 'Next')
      await cardNamed(page, title).locator('.board-card-menu').click()

      const current = page.locator('.row-menu-item', { hasText: /^Next — now$/ })
      await expect(current, 'the current lane is not marked').toHaveCount(1)
      await current.click()

      await expect(laneNamed(page, 'Next').locator('.board-card-title', { hasText: title }))
        .toHaveCount(1)
    })

  test('is reachable on a phone, where there is no drag at all', async ({ page }, testInfo) => {
    await openTheBoard(page, `scratch-${testInfo.project.name}-change-status-phone`, 390, 844)
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'mobile')

    const title = await firstCardTitleIn(page, 'Next')
    await cardNamed(page, title).locator('.board-card-menu').click()

    // §18.6: the same operation, presented as a sheet rather than a dropdown.
    await expect(page.locator('.row-menu')).toHaveClass(/row-menu-sheet/)
    await page.locator('.row-menu-item', { hasText: /^Doing$/ }).click()

    await expect(laneNamed(page, 'Doing').locator('.board-card-title', { hasText: title }))
      .toHaveCount(1)
  })

  test('opening the menu does not open the card', async ({ page }, testInfo) => {
    /**
     * The card's own click handler is on the element the button lives inside, so without
     * `stopPropagation` every Change status would also open the task in the panel behind the menu.
     * Asserted because it is invisible when correct and obvious only once it is wrong.
     */
    await openTheBoard(page, `scratch-${testInfo.project.name}-change-status-same`, 1600, 900)

    const title = await firstCardTitleIn(page, 'Next')
    await cardNamed(page, title).locator('.board-card-menu').click()

    await expect(page.locator('.row-menu')).toBeVisible()
    /**
     * **`is-open` is the signal, and neither presence nor visibility is.** The panel element is
     * built once at boot and carries `hidden` plus an `is-open` class it gains and loses; the
     * first draft asserted absence (it is always present) and the second asserted hidden (the
     * attribute comes off before the slide-out finishes, so it is not a truthful read of "open").
     * `is-open` is what the view itself uses to mean open -- checked in `card-panel.ts` on the very
     * next line of its own code.
     */
    await expect(page.locator('.card-panel.is-open'), 'the card opened under the menu').toHaveCount(0)
  })
})
