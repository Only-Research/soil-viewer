import { expect, test, type Locator, type Page } from '@playwright/test'

import { openFolder, openRoot } from './tree-nav'

/**
 * §18.2 AND §18.3 IN A REAL BROWSER, AT A REAL PHONE SIZE.
 *
 * **`core/chrome-retreat.ts` proves the rule; only this proves the bar moves.** The decision about
 * when to retreat is nineteen unit tests over scroll sequences no hand can produce. None of them
 * touch a stylesheet, and every one of them would still pass against a `data-chrome` attribute that
 * nothing in the CSS reads — which is the exact shape of the §18.6 failure recorded in the spec:
 * *"250 browser tests were green and a thumb was not."*
 *
 * So the assertions here are **geometric**. Where is the bar, in pixels, relative to the viewport.
 *
 * **390 × 844 is the user's phone**, not a round number chosen to be safely under the breakpoint.
 */

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

/**
 * §18.3's bar is the app's primary navigation, at the screen edge where horizontal room is free.
 * Unlike the tree's 40 (§18.6, and the reasoning there), there is nothing to buy by going under 44.
 */
const TAB_TOUCH_MIN = 44

/**
 * Waits until the app has actually **processed** the scroll, then until the transition has finished.
 *
 * **Both halves are load-bearing, and the first one was missing.** Setting `scrollTop` returns
 * before the browser dispatches the scroll event, so a test that asserted immediately afterwards
 * read the state as it was *before* the thing under test happened. Every "it stays present"
 * assertion then passed vacuously — `toHaveAttribute` succeeds on its first check and never waits to
 * see whether the value changes a frame later. Two mutations of the rule went undetected that way,
 * and the mutation sweep is the only reason that is known rather than shipped.
 *
 * Two frames, because the scroll event is dispatched before the next paint and the handler's
 * attribute write lands in that same frame.
 *
 * This is the hazard the P12 brief already names — *"a value read at a moment nothing pinned"* —
 * arriving for the fifth time in three days, now in a test rather than in the app.
 */
const settled = async (page: Page): Promise<void> => {
  await page.evaluate(
    () => new Promise<void>(resolve => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }),
  )
  await page.waitForFunction(() => {
    const bar = document.querySelector('.tabs')
    if (bar === null) return true
    return bar.getAnimations().every(a => a.playState !== 'running')
  })
}

/**
 * Scrolls a surface to an absolute position, **in steps**, and lets the chrome react.
 *
 * The steps are not decoration. A real scroll fires an event per frame; a single assignment fires
 * exactly one — and the first event after a reset deliberately only *adopts* the anchor without
 * deciding anything (see `RetreatState`, and the bug that clause exists for). A one-shot jump
 * therefore tests a sequence no browser produces, and the first version of this file did exactly
 * that and reported the feature broken when it was the harness that was wrong.
 */
const STEP_PX = 50

const scrollTo = async (surface: Locator, top: number, page: Page): Promise<void> => {
  // **A frame between steps, and WebKit is the reason.** Written first as a burst of `scrollTop`
  // assignments, it passed on Chromium and failed on WebKit — which coalesces writes made inside one
  // frame into a *single* scroll event. The stepped scroll then collapsed back to the one-shot jump
  // this helper exists to avoid, and the retreat never fired. Real scrolling delivers an event per
  // frame on both engines; this now does the same.
  await surface.evaluate(async (node, options) => {
    const frame = (): Promise<void> =>
      new Promise(resolve => { requestAnimationFrame(() => { resolve() }) })
    const from = node.scrollTop
    const direction = options.to >= from ? 1 : -1
    for (
      let at = from + direction * options.step;
      direction * (options.to - at) > 0;
      at += direction * options.step
    ) {
      node.scrollTop = at
      await frame()
    }
    node.scrollTop = options.to
    await frame()
  }, { to: top, step: STEP_PX })
  await settled(page)
}

/** The tree, opened far enough that it genuinely overflows a phone screen. */
const scrollableTree = async (page: Page): Promise<Locator> => {
  await openRoot(page)
  await openFolder(page, '02-projects')
  const tree = page.locator('.tree')
  // Asserted rather than assumed. A tree that fits the screen cannot retreat anything — §18.2 says
  // so explicitly — and a test that scrolled it anyway would pass or fail on the fixture's size
  // rather than on the rule.
  await expect
    .poll(async () => tree.evaluate(node => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(200)
  return tree
}

test.describe('the phone', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE)
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'mobile')
  })

  test('§18.3 — the tab bar sits against the bottom edge, thumb-reachable', async ({ page }) => {
    const bar = page.locator('.tabs')
    const box = (await bar.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }

    // Bottom edge, not merely "lower half": the home indicator inset is inside the bar's own
    // padding, so the element itself still reaches the viewport floor.
    expect(box.y + box.height).toBeGreaterThanOrEqual(PHONE.height - 1)
    expect(box.y).toBeGreaterThan(PHONE.height / 2)

    /**
     * **FIVE since P14**, and the count is asserted rather than loosened to "at least one".
     *
     * §18.3 was written as *"the four tabs"* and Boards is the operator's addition to it, recorded in
     * the spec under §21's precedence rule rather than left as a silent divergence. The literal
     * count stays because it is the thing that fails when a sixth tab arrives without anyone
     * measuring — which is exactly the check this test exists to be.
     *
     * Five fit at 76×48 with nothing clipped; `boards-tab.spec.ts` measures each one's box and its
     * label's overflow.
     */
    const tabs = page.locator('.tab')
    await expect(tabs).toHaveCount(5)
    for (const tab of await tabs.all()) {
      const t = (await tab.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
      expect(t.height).toBeGreaterThanOrEqual(TAB_TOUCH_MIN)
    }
  })

  test('§18.2 — scrolling down into content takes the bar off screen', async ({ page }) => {
    const tree = await scrollableTree(page)
    const bar = page.locator('.tabs')

    const before = (await bar.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
    expect(before.y).toBeLessThan(PHONE.height)

    await scrollTo(tree, 400, page)

    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'retreated')
    // The assertion that matters: it is actually gone, not merely labelled gone.
    await expect
      .poll(async () => (await bar.boundingBox())?.y ?? PHONE.height)
      .toBeGreaterThanOrEqual(PHONE.height)
  })

  /**
   * **A ROTATION LEAVES THE BAR OFF SCREEN WITH NOTHING TO BRING IT BACK.** Sweep finding 10.
   *
   * The retreat is remembered in `data-chrome`, and **only a scroll ever clears it**. Turning the
   * phone sideways crosses the 768px breakpoint into the desktop layout, where the retreat CSS does
   * not apply — so it looks fine and the app is still privately holding "hidden". Turning back
   * restores the mobile layout and the bar is gone immediately, before anything has been scrolled.
   *
   * **The trap is the surface with nothing to scroll**, which is most of them: a short file, a small
   * folder. No scroll is possible, so nothing clears the state, so all four tabs stay off screen and
   * the only way out is relaunching the app.
   *
   * `onLayoutChange` exists in `layout-mode.ts` for exactly this and had **no consumers at all** —
   * the same complete-and-wired-to-nothing shape as three other findings in this sweep.
   *
   * ruled 2026-08-16, on hitting it themselves: *"I have no issues restarting an app if that ever
   * happens. I'm not gonna be turning my phone sideways."* Fixed anyway, on the dead-code argument
   * rather than the likelihood one — their call, delegated.
   */
  test('§18.2 — rotating away and back does not strand the bar off screen', async ({ page }) => {
    const tree = await scrollableTree(page)
    const bar = page.locator('.tabs')

    await scrollTo(tree, 400, page)
    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'retreated')

    // Sideways: past the breakpoint, so the desktop layout takes over and the bar shows regardless.
    await page.setViewportSize({ width: 900, height: 390 })
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'desktop')

    // And back to portrait.
    await page.setViewportSize(PHONE)
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'mobile')

    await expect(page.locator('html'), 'the layout changed, so the retreat is stale')
      .toHaveAttribute('data-chrome', 'present')
    // The assertion that matters: on screen, not merely labelled on screen.
    await expect
      .poll(async () => (await bar.boundingBox())?.y ?? PHONE.height)
      .toBeLessThan(PHONE.height)
  })

  test('§18.2 — any upward scroll brings it straight back, without reaching the top', async ({ page }) => {
    const tree = await scrollableTree(page)
    const bar = page.locator('.tabs')

    await scrollTo(tree, 400, page)
    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'retreated')

    // Twenty pixels up, from four hundred down. "Must not require reaching the top" is the clause.
    await scrollTo(tree, 380, page)

    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'present')
    await expect
      .poll(async () => (await bar.boundingBox())?.y ?? PHONE.height)
      .toBeLessThan(PHONE.height)
    // And we are still deep in the tree, so the return was not a side effect of scrolling home.
    expect(await tree.evaluate(node => node.scrollTop)).toBeGreaterThan(300)
  })

  test('§18.2 — it never hides while the row menu sheet is open', async ({ page }) => {
    const tree = await scrollableTree(page)

    // §18.6's sheet rises from the bottom edge, exactly where the tab bar is, and scrolls its own
    // items. This is also the case that proves the overlay selector in `main.tsx` matches something
    // real: were it misspelled, the guard would silently never fire and this test would go red.
    //
    // **`02-projects`, and the choice is not arbitrary.** It is the first row under the root, so the
    // tree stays near the top when Playwright scrolls it into view. The obvious pick, `readme`,
    // sorts *below* all sixty-seven project folders — clicking it scrolls the tree to 2,433, and the
    // "scroll to 400" below then scrolls **up**, which keeps the chrome present whatever the guard
    // does. That version of this test passed with the guard deleted.
    await tree.locator('.tree-row', { hasText: '02-projects' }).locator('.row-menu-button').click()
    await expect(page.locator('.row-menu')).toBeVisible()
    expect(await tree.evaluate(node => node.scrollTop), 'the sheet test must scroll DOWN')
      .toBeLessThan(100)

    await scrollTo(tree, 400, page)

    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'present')
  })

  test('§18.3 — the tab bar is absent entirely in the document view', async ({ page }) => {
    const tree = await scrollableTree(page)
    // The tree renders display names, so the row reads `readme` rather than `readme.md`.
    await tree.locator('.tree-row', { hasText: 'readme' }).click()

    await expect(page.locator('.files-pane')).toHaveAttribute('data-screen', 'document')
    await expect(page.locator('html')).toHaveAttribute('data-document-view', 'true')

    // Absent, not retreated: there is no gesture in a document that should produce the four tabs.
    await expect(page.locator('.tabs')).toBeHidden()

    // And back out restores it, so "absent" is a property of the screen rather than a one-way trip.
    await page.locator('.files-screen-back').click()
    await expect(page.locator('html')).toHaveAttribute('data-document-view', 'false')
    await expect(page.locator('.tabs')).toBeVisible()
  })

  test('§18.2 — leaving a scrolled surface and coming back does not hide the bar on the first flick', async ({ page }) => {
    /**
     * **The regression test for the bug the browser found and the unit tests did not.**
     *
     * `reset()` used to set the anchor to 0 while the tree was still sitting at 400, so the first
     * scroll event after coming back measured four hundred pixels of movement nobody made and the
     * chrome vanished instantly. The unit suite could not see it: it tests the rule, and the rule
     * was never handed the lie — the wiring was.
     *
     * **The route is the real one.** A retreated bar is genuinely off screen, so you cannot tap a
     * tab while it is hidden; you flick up, it comes back, you tap. Forcing a click at coordinates
     * outside the viewport tests a gesture no phone can produce, and the two engines disagree about
     * what it even means.
     */
    const tree = await scrollableTree(page)
    await scrollTo(tree, 400, page)
    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'retreated')

    // The flick that makes the bar reachable again — §18.2's whole promise.
    await scrollTo(tree, 380, page)
    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'present')

    await page.locator('.tab', { hasText: 'Tasks' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'present')

    // Back to Files, where the tree is still scrolled to ~380. One small movement from there must
    // not hide anything: it is a nudge, not a scroll down into content.
    await page.locator('.tab', { hasText: 'Files' }).click()
    expect(await tree.evaluate(node => node.scrollTop)).toBeGreaterThan(300)
    await scrollTo(tree, 390, page)
    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'present')
  })
})

test.describe('the desktop keeps its chrome', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'desktop')
  })

  test('the tab bar stays at the top and does not retreat when scrolled', async ({ page }) => {
    // §18.2 is a phone rule. This is the case that stops it leaking upward — the mirror of the
    // desktop row-height assertion §18.6 asked for, and for the same reason: a mobile rule that
    // silently widened its scope would be found rather than by the suite.
    const tree = await scrollableTree(page)
    const bar = page.locator('.tabs')

    const before = (await bar.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
    expect(before.y).toBeLessThan(100)

    await scrollTo(tree, 400, page)

    const after = (await bar.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
    expect(after.y).toBe(before.y)
    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'present')
  })
})

test.describe('§10 Reveal in Finder — desktop only, in the interface', () => {
  test('the row menu offers it on the desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'desktop')

    const tree = await openRoot(page)
    await tree.locator('.tree-row', { hasText: 'readme' }).locator('.row-menu-button').click()
    await expect(page.locator('.row-menu')).toBeVisible()
    await expect(page.locator('.row-menu-item', { hasText: 'Reveal in Finder' })).toBeVisible()
  })

  test('the row menu does NOT offer it on a phone, and offers everything else', async ({ page }) => {
    /**
     * **§18.8: it "must not render as a dead control".** Absent, never disabled.
     *
     * **This is the only thing keeping Reveal off the phone**, and that is by design rather than by
     * omission. The route is carried on both listeners — `local-only` turned out to be unreachable
     * by any interface at all (ruled 2026-08-14) — and §7 forbids a runtime check on the
     * server. So the guard is here, in what the menu offers, and it is worth a browser test rather
     * than a unit test alone: a unit test proves the list, and only this proves the list is what a
     * thumb is shown.
     */
    await page.setViewportSize(PHONE)
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'mobile')

    const tree = await openRoot(page)
    await tree.locator('.tree-row', { hasText: 'readme' }).locator('.row-menu-button').click()
    const sheet = page.locator('.row-menu')
    await expect(sheet).toBeVisible()

    await expect(sheet.locator('.row-menu-item', { hasText: 'Reveal in Finder' })).toHaveCount(0)
    // And the sheet is not simply empty — the gate removes one item, not the tail of the list.
    await expect(sheet.locator('.row-menu-item', { hasText: 'Copy path' })).toBeVisible()
    await expect(sheet.locator('.row-menu-item', { hasText: 'Rename' })).toBeVisible()
  })
})
