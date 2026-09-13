import { expect, test, type Page } from '@playwright/test'

/**
 * **THE STREAM'S STATE, AND WHERE IT IS ALLOWED TO SIT.** Spec §15.
 *
 * the operator, on their phone: *"the live thing on the top right overlays refresh."* Measured at 390px
 * before the fix: the label occupied x 355–378 and the board's Refresh sat at 312–376. There is no
 * free corner at that width — the top right is Refresh on three of the four tabs.
 *
 * **So on a phone the healthy state is not drawn, and the other three are.** §15 requires that *"the
 * resyncing state be VISIBLE"* — it does not require a permanent `Live` badge, and a badge that is
 * always there is one nobody reads by the second day. Desktop keeps all four in the rail's footer,
 * where there is room and nothing to collide with.
 *
 * **The trap this suite is written against:** hiding the healthy state is one line from hiding the
 * unhealthy ones, and that failure is silent by construction — a screen confidently showing stale
 * files, which is the exact thing §15 exists to prevent. So every abnormal state is asserted
 * visible, not just the happy one asserted hidden.
 */

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

/** Everything the stream can report that is NOT "all is well". */
const ABNORMAL = ['resyncing', 'reconnecting', 'idle', 'connecting'] as const

const status = (page: Page) => page.locator('.status')

async function boot(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size)
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
  // The stream settles to `live` on its own; wait for it rather than racing the first paint.
  await expect(status(page)).toHaveAttribute('data-state', 'live')
}

test.describe('on a phone', () => {
  /**
   * **THE REPORTED BUG, as geometry.**
   *
   * This is also what covers the wiring rather than only the stylesheet: the element is stamped
   * `data-state="connecting"` at birth and only `onStateChange` moves it to `live`. Break that line
   * and the label never hides, the boxes overlap again, and this fails.
   */
  test('the healthy state is not drawn, so nothing lands on Refresh', async ({ page }) => {
    await boot(page, PHONE)

    await expect(status(page), 'Live is not worth a badge on a 390px screen').toBeHidden()

    const refresh = page.locator('.tasks-pane:not([hidden])').getByRole('button', { name: /Refresh/ })
    await expect(refresh).toBeVisible()
    const label = await status(page).boundingBox()
    // A hidden element has no box at all, which is the strongest form of "does not overlap".
    expect(label, 'a hidden label cannot collide with anything').toBeNull()
  })

  /**
   * **THE HALF THAT MATTERS MORE.** Every state that means *act, or at least know* has to be on
   * screen. Driven through the attribute because a real resync needs the filesystem and the stream
   * to cooperate on a timer — the wiring that sets this attribute is covered by the test above.
   */
  test('every state that is not healthy IS drawn, clear of Refresh', async ({ page }) => {
    await boot(page, PHONE)
    const refresh = page.locator('.tasks-pane:not([hidden])').getByRole('button', { name: /Refresh/ })
    const refreshBox = await refresh.boundingBox()
    expect(refreshBox, 'Refresh must have a box').not.toBeNull()
    if (refreshBox === null) return

    for (const state of ABNORMAL) {
      await page.locator('.status').evaluate((node, value) => {
        node.setAttribute('data-state', value)
      }, state)

      await expect(status(page), `${state} must be visible — §15`).toBeVisible()
      const box = await status(page).boundingBox()
      expect(box, `${state} must have a box`).not.toBeNull()
      if (box === null) continue

      /**
       * **Clear of Refresh, and specifically BELOW it.** These are the states where you would reach
       * for Refresh, so covering it to say the board is stale would be the same mistake in a new
       * place.
       */
      expect(box.y, `${state} sits below Refresh, not over it`)
        .toBeGreaterThan(refreshBox.y + refreshBox.height)
      expect(Math.round(box.width), `${state} spans the screen`).toBe(PHONE.width)
    }
  })
})

test.describe('on a desktop', () => {
  /**
   * The rail's footer has room and nothing to collide with, so all four states are drawn — including
   * the healthy one. A person at a desktop wants to know the channel is alive; a person on a phone
   * wants the button underneath it.
   */
  test('all four states are drawn, in the rail footer', async ({ page }) => {
    await boot(page, DESKTOP)

    await expect(status(page)).toBeVisible()
    await expect(status(page)).toHaveText('Live')

    const rail = await page.locator('.app-rail').boundingBox()
    const box = await status(page).boundingBox()
    expect(rail, 'the rail must have a box').not.toBeNull()
    expect(box, 'the status must have a box').not.toBeNull()
    if (rail === null || box === null) return
    expect(Math.round(box.x), 'inside the rail, not floating over a pane').toBe(Math.round(rail.x))
    // At the foot of it: the tree above takes the free height.
    expect(box.y + box.height).toBeGreaterThan(rail.y + rail.height - 60)

    for (const state of ABNORMAL) {
      await page.locator('.status').evaluate((node, value) => {
        node.setAttribute('data-state', value)
      }, state)
      await expect(status(page), `${state} stays visible on a desktop`).toBeVisible()
    }
  })
})
