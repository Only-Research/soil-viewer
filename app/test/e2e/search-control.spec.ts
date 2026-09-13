import { expect, test, type Page } from '@playwright/test'

/**
 * **THE SEARCH CONTROL — P13, in a real browser at both widths.**
 *
 * §16 has always said *"⌘K on desktop, a search field on phone."* The desktop half shipped in P11;
 * the phone half never did, and no on-screen control was built at any width — so on a phone the
 * feature existed and could not be opened at all. This suite is what says it can be.
 *
 * ## What it is actually guarding
 *
 * **Not the search.** The ranking, the 64-character cap, the linear scan and the time budget are
 * proven in `test/core/quick-open.test.ts`, and the panel's keyboard behaviour in
 * `test/client/quick-open-panel.test.ts`. Nothing here re-asserts any of it.
 *
 * What only a browser answers is whether the two new buttons **reach** that work — and, on the
 * phone, whether splitting the strip above the tab bar left it where it was. The operator's condition on
 * this unit, verbatim: *"make sure that the spacing doesn't get fucked up on the bottom of the app
 * for the phone."*
 *
 * ## Geometric, for the reason the whole build is by now
 *
 * `toBeVisible()` on the strip passes against a strip sitting underneath the tab bar, and against
 * one hanging off the bottom of the screen. §18.6's lesson, quoted in `mobile-chrome.spec.ts`:
 * *"250 browser tests were green and a thumb was not."* And on 2026-08-16 a guard that measured a
 * panel **mid-slide** returned green here and red on CI for identical code. So the measurements
 * below are taken after the layout has settled, and every test in this file was run against the
 * mutation named above it to prove it can fail.
 *
 * **390 × 844 is the user's phone.** 1280 × 800 is the desktop the packet's numbers are written for.
 */

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

async function boot(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size)
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

/**
 * Waits until nothing on screen is still moving.
 *
 * **This is the instrument, and validating it is the point.** The strip transitions on `transform`,
 * and `toBeVisible` is satisfied at the *start* of a transition — which is exactly how the
 * card-panel guard came to measure a panel ten pixels onto the screen and report whatever the
 * timing happened to produce. A box read mid-transition is not a measurement of anything.
 */
const settled = async (page: Page): Promise<void> => {
  await page.evaluate(
    () => new Promise<void>(resolve => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }),
  )
  await page.waitForFunction(() => document
    .getAnimations()
    .every(animation => animation.playState !== 'running'))
}

const boxOf = async (page: Page, selector: string): Promise<DOMRect> => {
  await settled(page)
  const box = await page.locator(selector).boundingBox()
  if (box === null) throw new Error(`${selector} has no box — it is not being laid out`)
  return box as DOMRect
}

test.describe('search, on a desktop', () => {
  /**
   * MUTATION: remove the click listener on `railSearch`. Must redden.
   *
   * The `aria-label` is asserted for the reason the gear's is — the icon inside is `aria-hidden`,
   * so a button with no text has no accessible name at all, and a nameless button is one a screen
   * reader announces as nothing.
   */
  test('the rail header has a search control, and it opens the panel', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Files').click()

    const search = page.locator('.app-rail .rail-search')
    await expect(search).toBeVisible()
    await expect(search, 'the icon is aria-hidden, so the button needs its own name')
      .toHaveAttribute('aria-label', 'Search')

    await search.click()
    await expect(page.locator('.quick-open')).toBeVisible()
  })

  /**
   * MUTATION: point the button at a second, empty `mountQuickOpen` instead of the shared opener.
   * The panel would still appear and typing would still be accepted; **no result would ever come
   * back**, because the query protocol lives with the caller. Must redden.
   *
   * This is the test that makes the button worth having. A panel that opens is not the feature —
   * *"paste it into search and get to it within two seconds"* is.
   *
   * **Two things are asserted and neither is the ranking.** That results come back at all proves the
   * query protocol is wired, which the second mount would not be. That choosing one lands on **Files
   * from a different tab** proves `onChoose` ran — the shared handler, whose whole job is that the
   * jump is a jump.
   *
   * **Started from Tasks on purpose.** Asserting "Files is selected" from Files would pass against a
   * button that did nothing at all, which is the shape of vacuous assertion this build has shipped
   * before. It also happens to prove the desktop control works from a tab that is not Files.
   *
   * **Not asserting an editor**, following `quick-open.spec.ts`, which records why: where a chosen
   * document lands depends on which host `opener.run` is given, quick-open passes none, and that is
   * worth deciding on its own rather than being pinned in passing by a test about a button.
   */
  test('clicking it, typing, and choosing a result jumps to the document', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Tasks').click()
    await expect(tab(page, 'Files')).toHaveAttribute('aria-selected', 'false')

    await page.locator('.app-rail .rail-search').click()
    await expect(page.locator('.quick-open')).toBeVisible()

    await page.keyboard.type('chatroom')
    const first = page.locator('.quick-open-result').first()
    await expect(first, 'results come back, so the button reached the real search').toBeVisible()
    await first.click()

    await expect(page.locator('.quick-open')).toHaveCount(0)
    await expect(tab(page, 'Files'), 'the jump lands in Files, so onChoose ran')
      .toHaveAttribute('aria-selected', 'true')
  })

  /**
   * MUTATION: drop `.rail-search` from the collapsed hide list in `tokens.css`. Must redden.
   *
   * §4.1: a collapsed rail is *"44px holding only the expand chevron, centred, 22px down. Nothing
   * else survives; the tabs do not become icons."* A second button in a strip specified to hold one
   * is the kind of thing nobody looks at after adding a button, which is why it is asserted rather
   * than assumed from having edited the right line.
   */
  test('collapsing the rail takes the search control with it', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Files').click()
    await expect(page.locator('.rail-search')).toBeVisible()

    await page.locator('.rail-collapse').click()
    await expect(page.locator('.rail-search')).toBeHidden()
    await expect(page.locator('.rail-collapse'), 'the way back out is the one thing that survives')
      .toBeVisible()
  })
})

test.describe('search, on a phone', () => {
  /**
   * MUTATION: swap the two click handlers. Must redden — each assertion catches the other's half.
   *
   * The strip is the phone's only route to Settings, so a split that reached search by breaking
   * that would trade one unreachable feature for another.
   */
  test('the strip holds both, and each opens its own thing', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()

    const strip = page.locator('.sidebar-strip')
    await expect(strip).toBeVisible()

    await strip.locator('.sidebar-search').click()
    await expect(page.locator('.quick-open')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.quick-open')).toHaveCount(0)

    await strip.locator('.sidebar-settings').click()
    await expect(page.locator('.modal[aria-label="Settings"]')).toBeVisible()
  })

  /**
   * **THE SPACING TEST. This is the one the operator asked for.**
   *
   * MUTATION: leave the pinned block on `.sidebar-settings` instead of moving it to the container.
   * **Run, and it reddens by 41 pixels** — the strip lands mid-flow instead of on the bar.
   *
   * **The safe-area term is NOT guarded here, and the first draft of this comment claimed it was.**
   * Removing `env(safe-area-inset-bottom, 0px)` was run as its own mutation and **all eight tests
   * stayed green**: Playwright's browsers have no notch, so the term resolves to 0 and deleting it
   * changes nothing this harness can measure. A mutation the harness cannot express is not a
   * mutation that passed — it is one that was never run. It is guarded by `the safe-area offset
   * survives` below instead, which is a weaker, source-level check and says so.
   *
   * Four separate ways the split could go wrong, and each is a real failure someone would hit:
   *
   * 1. **A gap** between the strip and the tab bar — the strip has come loose from the bar it is
   *    pinned above, and the gap shows the tree scrolling through it.
   * 2. **An overlap** — the strip sits on the bar and eats a tab, or the bar covers the controls.
   * 3. **Clipping** — either control running past the screen edge, which is precisely what the operator
   *    ruled on when they accepted this strip in the first place: *"as long as it doesn't get cutoff."*
   * 4. **Unequal halves** — *"left half stays settings, right half becomes search"*, and a
   *    percentage width would have overflowed onto the right-hand one.
   */
  test('sits flush on the tab bar, unclipped, in two equal halves', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()

    const strip = await boxOf(page, '.sidebar-strip')
    const bar = await boxOf(page, '.tabs')
    const settings = await boxOf(page, '.sidebar-settings')
    const search = await boxOf(page, '.sidebar-search')

    // 1 + 2 — flush. One pixel of tolerance for sub-pixel layout, and no more: the failures this
    // guards against are tens of pixels, not fractions of one.
    expect(Math.abs((strip.y + strip.height) - bar.y),
      'the strip must sit directly on the tab bar — no gap, no overlap').toBeLessThanOrEqual(1)

    // 3 — nothing off either edge, and nothing under the bar.
    expect(strip.x, 'the strip starts at the left edge').toBeGreaterThanOrEqual(0)
    expect(strip.x + strip.width, 'and ends at the right one').toBeLessThanOrEqual(PHONE.width)
    for (const [name, box] of [['Settings', settings], ['Search', search]] as const) {
      expect(box.width, `${name} must have real width`).toBeGreaterThan(0)
      expect(box.height, `${name} must have real height`).toBeGreaterThan(0)
      expect(box.x + box.width, `${name} must not run off the screen`)
        .toBeLessThanOrEqual(PHONE.width + 1)
      expect(box.y + box.height, `${name} must not sit under the tab bar`)
        .toBeLessThanOrEqual(bar.y + 1)
    }

    // 4 — equal halves. The hairline between them is a border, so allow it in the comparison.
    expect(Math.abs(settings.width - search.width),
      'left half and right half, as ruled').toBeLessThanOrEqual(2)
    expect(settings.x, 'Settings is the left one').toBeLessThan(search.x)
  })

  /**
   * **A WEAKER GUARD, AND IT IS LABELLED ONE.** It asserts the declaration, not the layout.
   *
   * `env(safe-area-inset-bottom)` is what lifts the strip clear of the home indicator on the operator's
   * phone. No harness here can see it — it resolves to 0 in a browser with no notch, which the
   * mutation above proves rather than assumes — and `getComputedStyle` reports the resolved pixel
   * value, so it cannot see it either. The only thing left that can catch the deletion is the rule
   * itself.
   *
   * **Asserting source is close to a tautology and normally is not worth writing.** It is worth it
   * exactly here: the failure is invisible in every instrument available, appears only on the one
   * device the app is actually used on, and the symptom — a strip sitting under the home indicator
   * — is one the operator already ruled on once when they accepted this strip: *"as long as it doesn't get
   * cutoff."*
   *
   * MUTATION: delete the `env(...)` term. Must redden. (It does; that is how this test was checked.)
   */
  test('the safe-area offset survives — guarded at the source, for want of anywhere else', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()

    const declared = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try { rules = sheet.cssRules } catch { continue }
        for (const rule of Array.from(rules)) {
          const text = rule.cssText
          if (text.includes('.sidebar-strip') && text.includes('inset-block-end')) return text
        }
      }
      return null
    })

    expect(declared, 'the strip must have a pinned block to read at all').not.toBeNull()
    expect(declared ?? '', 'the offset must still clear the home indicator, not just the tab bar')
      .toContain('safe-area-inset-bottom')
  })

  /**
   * MUTATION: leave the retreat transform on `.sidebar-settings` instead of moving it to
   * `.sidebar-strip`. **Run, and it reddens**: the container stops 88px short of clearing the
   * screen, because only its left half slides.
   *
   * §18.2 says *every* persistent bar retreats, and a control pinned to the bottom edge is one
   * whether or not it is called a bar. Asserted geometrically: the strip's top edge must end up at
   * or below the bottom of the screen, not merely be reported as invisible.
   */
  test('retreats with the chrome and comes back', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()
    await expect(page.locator('.sidebar-strip')).toBeVisible()

    await page.evaluate(() => {
      document.documentElement.setAttribute('data-chrome', 'retreated')
    })
    const gone = await boxOf(page, '.sidebar-strip')
    expect(gone.y, 'the whole strip clears the screen, both halves of it')
      .toBeGreaterThanOrEqual(PHONE.height)

    await page.evaluate(() => {
      document.documentElement.setAttribute('data-chrome', 'present')
    })
    const back = await boxOf(page, '.sidebar-strip')
    expect(back.y + back.height, 'and it comes back on screen').toBeLessThanOrEqual(PHONE.height)
  })

  /**
   * MUTATION: none — this guards behaviour that already existed against being broken by the split.
   *
   * §18.3: the tab bar is *"absent entirely in the document view"*, and the strip goes with it. The
   * old rule reached the strip because the strip **was** the Settings button, which lives in the
   * Files sidebar; the container has to inherit that by sitting in the same place, not by a new
   * rule. Cheap to assert, and silent if it broke.
   */
  test('is absent in the document view, as the bar it sits on is', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()
    await expect(page.locator('.sidebar-strip')).toBeVisible()

    await page.locator('.sidebar-search').click()
    await page.keyboard.type('chatroom')
    const first = page.locator('.quick-open-result').first()
    await expect(first).toBeVisible()
    await first.click()

    await expect(page.locator('.tabs')).toBeHidden()
    await expect(page.locator('.sidebar-strip')).toBeHidden()
  })
})

/**
 * **ONE SEARCH CONTROL AT EACH WIDTH**, the mirror of the Settings pair in `app-rail.spec.ts` and
 * for the same reason.
 *
 * Two controls exist in the markup. If both were ever on screen at once the app would offer the same
 * door twice; if neither were, search would be unreachable — which is the bug this whole unit fixes,
 * and it would be a shame to reintroduce it at the other width.
 *
 * MUTATION: delete the desktop hide on `.sidebar-strip`. **Run, and it reddens** — two Search
 * buttons on one screen — and it takes the pre-existing Settings pair in `app-rail.spec.ts` down
 * with it, which is the right blast radius for deleting that rule.
 *
 * **This test does NOT catch the collapsed-rail case, and an earlier draft of this comment said it
 * did.** Dropping `.rail-search` from the collapsed hide list was run as its own mutation and this
 * test stayed green: it never collapses the rail, so it never looks. `collapsing the rail takes the
 * search control with it` is the one that catches that, and it does. Left visible rather than
 * quietly corrected, because a comment claiming coverage a test does not have is worse than no
 * comment — it is what stops the missing test from being written.
 */
test('offers exactly one search control, at either width', async ({ page }) => {
  await boot(page, DESKTOP)
  await tab(page, 'Files').click()
  await expect(page.getByRole('button', { name: 'Search' })).toHaveCount(1)
  await expect(page.locator('.rail-search')).toBeVisible()
  await expect(page.locator('.sidebar-search')).toBeHidden()

  await page.setViewportSize(PHONE)
  await page.reload()
  await tab(page, 'Files').click()
  await expect(page.getByRole('button', { name: 'Search' })).toHaveCount(1)
  await expect(page.locator('.rail-search')).toBeHidden()
  await expect(page.locator('.sidebar-search')).toBeVisible()
})
