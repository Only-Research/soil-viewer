import { expect, test } from '@playwright/test'

import { openBoard } from './board-nav'

/**
 * **A CARD IS A SCREEN ON A PHONE, NOT A PANEL — the operator's number-one complaint.**
 *
 * > *"When you open a card it takes up half the page — which I think is good for desktop, but for
 * > mobile I feel like we should just treat it like Files, where it should open the whole page,
 * > because it gets crunched."*
 *
 * Measured before the change: **262px of a 390px viewport — 70%** — anchored right, leaving a 112px
 * sliver of board that could not be read and could not be dismissed except by hitting one small
 * strip at the top. That strip is the other half of what they reported: *"it's very hard to exit an
 * inbox item; you have to click that little strip on the top."*
 *
 * **Full-screen is what removes the exit problem rather than patching it.** With no sliver behind
 * it, there is no mis-click to make — and a labelled back control replaces a dismiss target you had
 * to know about.
 *
 * **Projects is deliberately excluded, and that distinction is the operator's own**: *"projects is okay
 * as a side file, but tasks should open the whole thing."* Asserted here, because a rule applied to
 * every panel would be the easier thing to write and is not what they asked for.
 */
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

test.describe('the card on a phone', () => {
  test('fills the screen, so there is no sliver to mis-tap', async ({ page }, testInfo) => {
    await page.setViewportSize(PHONE)
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await openBoard(page, `scratch-${testInfo.project.name}-board-refresh`)

    await page.locator('.board-card').first().click()
    /**
     * **`.is-open`, because FOUR panels exist** — Tasks, Projects, Inbox and, since 2026-08-19,
     * Boards, each building one at boot. A bare class selector matched all of them and Playwright's
     * strict mode caught it; only one is ever open, so that is the honest anchor.
     *
     * Either full-screen flavour is accepted. Every panel is `is-fullscreen-phone` today: the Inbox
     * was `is-fullscreen-both` from 2026-08-16 until the operator reversed it on 2026-08-19. `both` is
     * kept in the selector because the option still exists and this suite is about what fills the
     * screen at THIS width, not about which flavour got it there.
     */
    const panel = page.locator(
      '.card-panel.is-fullscreen-phone.is-open, .card-panel.is-fullscreen-both.is-open',
    )
    await expect(panel).toBeVisible()

    /**
     * **Polled, because the panel SLIDES in.** `toBeVisible` passes the moment it stops being
     * hidden, which is 180ms before it arrives — the first version of this read `x: 390` and failed
     * against a correct panel caught mid-transition. Measuring an animation at an arbitrary instant
     * is a flake waiting to be written.
     */
    await expect.poll(async () => (await panel.boundingBox())?.x ?? -1,
      { message: 'the panel never finished sliding in' }).toBe(0)

    const box = await panel.boundingBox()
    /**
     * The whole viewport, not "most of it". 70% was the defect; asserting "wider than before" would
     * pass at 80% and still leave the sliver that caused the mis-taps.
     */
    expect(box?.width).toBe(PHONE.width)
    expect(box?.height).toBe(PHONE.height)
  })

  test('offers a back control that names where you came from, and closes', async ({ page }, testInfo) => {
    await page.setViewportSize(PHONE)
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await openBoard(page, `scratch-${testInfo.project.name}-board-refresh`)

    await page.locator('.board-card').first().click()
    const back = page.locator('.card-panel.is-open .card-panel-back')
    await expect(back).toBeVisible()

    /**
     * **Named, not generic.** `‹ Next` rather than `‹ Back` — the packet's rule. Asserted as
     * "carries the lane's words" rather than as an exact string, so the label can be reworded
     * without reddening a test about the control existing and working.
     */
    await expect(back).toContainText('‹')
    await expect(back).not.toContainText('01-')

    await back.click()
    await expect(page.locator('.card-panel.is-open')).toHaveCount(0)
  })
})

test('the card stays a side panel on the desktop', async ({ page }, testInfo) => {
  await page.setViewportSize(DESKTOP)
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await openBoard(page, `scratch-${testInfo.project.name}-board-refresh`)

  await page.locator('.board-card').first().click()
  const panel = page.locator('.card-panel.is-open')
  await expect(panel).toBeVisible()

  const box = await panel.boundingBox()
  // Beside the board, not over it. The full-screen rule is scoped to the phone and must stay there.
  expect(box?.width ?? 0).toBeLessThan(DESKTOP.width / 2)
  expect(box?.x ?? 0).toBeGreaterThan(0)

  // And the back control belongs to the phone, where it is the only way out.
  await expect(page.locator('.card-panel.is-open .card-panel-back')).toBeHidden()
})
