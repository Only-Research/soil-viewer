import { expect, test, type Page } from '@playwright/test'

/**
 * **THE PROJECT FILTER IS A POPOVER, AND EVERY PROJECT IN IT IS REACHABLE.**
 *
 * the operator found this on their phone, 2026-08-15:
 *
 * > *"it's just like a bunch of boxes and then a few spaces in another box and it cuts off and you
 * > can't scroll the whole thing… it's just a giant clump."*
 *
 * **`project-filter.ts` shipped emitting seven class names and `tokens.css` matched none of them.**
 * Not "under-styled" — the control had **no CSS at all**, so every rule was a browser default, and
 * three separate failures came out of that one absence. Measured on a 375×812 viewport before the
 * fix:
 *
 *   1. `<label>` defaults to `display: inline`, so sixty-six rows laid out as **running text** —
 *      tick, name, tick, name — wrapped like a paragraph, breaking names mid-word (`op-bin-` /
 *      `logistics-1`).
 *   2. No `max-height` and no `overflow`, so the open list measured **1,287px tall inside an 812px
 *      viewport**, ending at y=1315. The projects past the fold were not scrolled away; they were
 *      unreachable.
 *   3. The list was **in flow** inside `.board-bar`, so opening it grew the bar — and because the
 *      bar is `align-items: center`, that stranded the Refresh button at **y=650**, in the middle
 *      of the list. One defect presenting as two.
 *
 * ## Why this is a browser test and not a stylesheet grep
 *
 * `design-tokens.test.ts` can assert a rule *exists*. It cannot assert that sixty-six rows occupy
 * sixty-six lines, because that is the browser's layout answer to `display: flex` plus the width
 * available — exactly the kind of thing that was wrong here, and exactly what a grep would have
 * declared fine on the day the operator was looking at the clump.
 *
 * ## What each assertion is really pinning
 *
 * **Not the visual design.** The design pass may change the popover's width, its shadow, its row
 * height and its colours, and none of that should redden this file. What is asserted is the three
 * properties that were false: rows are rows, everything is reachable, and **opening the control
 * does not move the controls beside it** — which is the definition of a popover and the one a
 * later "let's just inline it again" would break silently.
 */

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 860 }

/** Opens Tasks and then the project filter, and waits for the list to actually be on screen. */
async function openFilter(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
  const summary = page.locator('.project-filter-summary')
  await expect(summary).toBeVisible()
  await summary.click()
  await expect(page.locator('.project-filter-list')).toBeVisible()
  // The rows are drawn with the list; without this the first measurement can land on an empty box.
  await expect.poll(async () => page.locator('.project-filter-row').count()).toBeGreaterThan(1)
}

test.describe('the project filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE)
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'mobile')
  })

  test('every row is on its own line — the clump was `display: inline`', async ({ page }) => {
    await openFilter(page)

    const tops = await page.locator('.project-filter-row').evaluateAll(nodes =>
      nodes.map(node => Math.round(node.getBoundingClientRect().top)))

    expect(tops.length).toBeGreaterThan(2)

    /**
     * **Distinct tops, not "display is flex".** Asserting the computed `display` would pass on a
     * `flex` row that still shared a line with its neighbour — which is precisely what an inline
     * *parent* would produce. Position is the thing a reader sees and the thing that was wrong.
     */
    expect(new Set(tops).size).toBe(tops.length)

    // And in order, so a row is below its predecessor rather than merely elsewhere.
    for (let at = 1; at < tops.length; at += 1) {
      expect(tops[at] as number).toBeGreaterThan(tops[at - 1] as number)
    }
  })

  test('a name too long for the row is ellipsised, never broken mid-word', async ({ page }) => {
    await openFilter(page)

    const wraps = await page.locator('.project-filter-name').evaluateAll(nodes =>
      nodes.filter(node => {
        const style = getComputedStyle(node)
        return style.whiteSpace !== 'nowrap' || style.textOverflow !== 'ellipsis'
      }).length)

    expect(wraps, 'a wrapping name is what produced `op-bin-` / `logistics-1`').toBe(0)

    /**
     * **A name too long for its row must be clipped, not allowed to widen the row.**
     *
     * **This assertion has been wrong twice, and both corrections came from the sweep.**
     *
     * *First:* it measured the real rows, and **no project in the fixture has a name long enough to
     * overflow a 343px row** — so it was testing a condition the data never produced. The name is
     * lengthened here rather than added to the fixtures: adding a project to the e2e tree moves the
     * row counts and refresh timings other suites measure, and this needs one long string, not a
     * sixty-seventh project.
     *
     * *Second:* it was framed as testing `min-width: 0`, on the usual flexbox reasoning that an
     * item's automatic minimum size refuses to shrink below its content. **Removing `min-width: 0`
     * changed nothing**, and measuring all four combinations showed why: the automatic minimum
     * applies only while `overflow` is `visible`, and this item's is `hidden`, which has already
     * zeroed it. `min-width: 0` was removed from the stylesheet as a result.
     *
     * So what is pinned here is **`overflow: hidden`** — the declaration that actually holds the row
     * together, proven by a mutation that reddens this test rather than by the explanation that
     * sounded right.
     */
    const row = page.locator('.project-filter-row').first()
    await row.locator('.project-filter-name').evaluate(node => {
      node.textContent = 'a-project-name-far-longer-than-any-row-could-ever-hope-to-display-'.repeat(3)
    })

    const overflow = await row.evaluate(node => ({
      row: node.scrollWidth - node.clientWidth,
      name: node.querySelector('.project-filter-name')?.scrollWidth ?? 0,
      box: node.querySelector('.project-filter-name')?.clientWidth ?? 0,
    }))

    expect(overflow.row, 'a row wider than itself is `min-width: auto` refusing to shrink')
      .toBeLessThanOrEqual(1)
    // And the name really is being clipped rather than the row having quietly grown to fit it.
    expect(overflow.name).toBeGreaterThan(overflow.box)
  })

  test('the whole list is reachable — bounded by the screen, and scrollable inside it',
    async ({ page }) => {
      await openFilter(page)
      const list = page.locator('.project-filter-list')

      const box = await list.evaluate(node => {
        const rect = node.getBoundingClientRect()
        return {
          left: rect.left, right: rect.right, bottom: rect.bottom,
          scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
          overflowY: getComputedStyle(node).overflowY,
        }
      })

      // Inside the viewport on every edge. The right edge is the one that was off by 63px.
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(PHONE.width)
      expect(box.bottom).toBeLessThanOrEqual(PHONE.height)

      /**
       * **Bounded AND scrollable, asserted together.** Either alone is satisfied by the bug: an
       * unbounded list "scrolls" with the page, and a bounded list without `overflow` simply clips
       * the projects off the end — which is a worse failure than the original, because it looks
       * finished.
       */
      expect(box.overflowY).not.toBe('visible')
      expect(box.scrollHeight).toBeGreaterThan(box.clientHeight)

      // And the scroll actually reaches the end, rather than being a container that merely reports one.
      const reached = await list.evaluate(node => {
        node.scrollTop = node.scrollHeight
        return node.scrollTop > 0
      })
      expect(reached).toBe(true)
    })

  test('the last project can be ticked, not just seen', async ({ page }) => {
    await openFilter(page)
    const list = page.locator('.project-filter-list')
    await list.evaluate(node => { node.scrollTop = node.scrollHeight })

    /**
     * The point of the whole fix, stated as a gesture rather than a geometry: **a project at the
     * bottom of sixty-six is selectable.** Before, it was not on the screen at any scroll position,
     * so this is the assertion that would have been red for the reason the operator reported.
     */
    const last = page.locator('.project-filter-row').last()
    await expect(last).toBeVisible()
    await last.locator('.project-filter-tick').check()
    await expect(last.locator('.project-filter-tick')).toBeChecked()
  })

  test('opening it does not move the controls beside it — that is what a popover means',
    async ({ page }) => {
      await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
      /**
       * **By its label, not by `.board-refresh`.** The class matches two buttons — the Tasks board's
       * and the Inbox's — and Playwright's strict mode caught the first draft of this test doing
       * exactly what a human reader would have missed. The Inbox's control is mounted and off
       * screen, so a loose locator would have measured a button on another tab and reported it as
       * not moving, which is a test that passes for a reason unrelated to its subject.
       */
      const refresh = page.getByRole('button', { name: 'Refresh the tasks board' })
      await expect(refresh).toBeVisible()

      const before = await refresh.boundingBox()

      const summary = page.locator('.project-filter-summary')
      await summary.click()
      await expect(page.locator('.project-filter-list')).toBeVisible()
      await expect.poll(async () => page.locator('.project-filter-row').count()).toBeGreaterThan(1)

      const after = await refresh.boundingBox()

      /**
       * **This is the assertion that fails loudest if the list ever returns to the flow.** Refresh
       * was measured at `y: 650` with the filter open and `y: 10` with it closed — a 640px jump,
       * because `.board-bar` grew to hold a 1,287px list and centred its children in it.
       *
       * Tolerance of 1px for sub-pixel rounding between two engines, and no more: the failure this
       * guards against is measured in hundreds.
       */
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1)
      expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThanOrEqual(1)
    })

  test('a click outside closes it, so it stops covering the board', async ({ page }) => {
    await openFilter(page)
    const box = page.locator('.project-filter')
    await expect(box).toHaveAttribute('open', '')

    /**
     * **The regression this exists for.** While the list was in flow, opening it *pushed* the board
     * down and the cards stayed reachable. As a popover it covers them — and a `details` closes
     * only on its own summary. Twenty-two tests across four suites went red on exactly this, every
     * one a 30s timeout with the card resolving but never becoming "visible, enabled and stable".
     */
    /**
     * **A viewport coordinate, not a locator.** `.board-host` matches three elements — Tasks,
     * Projects and Inbox all have one — and the first draft of this line was a strict-mode
     * violation, the second such locator this file has had. A point is also the more faithful
     * gesture: the question is what happens when a *finger lands somewhere that is not the filter*,
     * and this is below the popover's measured bottom edge and above the tab bar.
     */
    const belowThePopover = { x: 200, y: PHONE.height - 120 }
    await page.mouse.click(belowThePopover.x, belowThePopover.y)
    await expect(box).not.toHaveAttribute('open', '')
  })

  test('ticking two projects keeps it open — dismissal must not eat multi-select',
    async ({ page }) => {
      await openFilter(page)

      /**
       * **The risk the outside-click listener introduces, pinned rather than reasoned about.**
       * Ticking redraws the whole control, so the listener is removed and re-added *while the click
       * that caused it is still propagating*. If the new listener sees that click, its target is a
       * checkbox belonging to the now-detached old control — `contains` says false, and the popover
       * closes on the first tick, making multi-select impossible.
       *
       * A checkbox's `change` fires during the click's activation behaviour, so the ordering here
       * is genuinely subtle and not something to settle by reading the spec.
       */
      /**
       * **Cleared first, because the selection outlives the test.** It is view state, persisted per
       * client, so a tick left by an earlier case in this file arrives here as a third checked box
       * and the count below reads 3. `board-nav.ts`'s `showOnly` opens with the same two lines for
       * the same reason: *"`showOnly` means only."*
       */
      const clear = page.locator('.project-filter-clear')
      if (await clear.count() > 0) await clear.click()
      await expect(page.locator('.project-filter-tick:checked')).toHaveCount(0)

      const ticks = page.locator('.project-filter-tick')
      await ticks.nth(0).check()
      await expect(page.locator('.project-filter')).toHaveAttribute('open', '')

      await page.locator('.project-filter-tick').nth(1).check()
      await expect(page.locator('.project-filter')).toHaveAttribute('open', '')

      // Both, not the second one alone — a control that silently replaces the selection is a
      // different bug wearing the same face.
      await expect(page.locator('.project-filter-tick:checked')).toHaveCount(2)
      await expect(page.locator('.project-filter-summary')).toHaveText('2 projects')
    })

  test('on the desktop it hangs under its own summary', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'desktop')
    await openFilter(page)

    const summary = await page.locator('.project-filter-summary').boundingBox()
    const list = await page.locator('.project-filter-list').boundingBox()

    /**
     * The mobile rule spans the bar because a popover anchored to a summary at x≈95 would run off a
     * 390px screen. **The desktop must NOT inherit that** — a full-width list under a small control
     * on a wide screen is a menu that has lost its anchor. Asserted because the mobile rule works by
     * moving the positioning context, which is the kind of change that leaks upward if the
     * attribute selector is ever loosened.
     */
    expect(Math.abs((list?.x ?? 0) - (summary?.x ?? 0))).toBeLessThanOrEqual(2)
    expect(list?.width ?? 0).toBeLessThan(DESKTOP.width / 2)
    expect((list?.y ?? 0) + (list?.height ?? 0)).toBeLessThanOrEqual(DESKTOP.height)
  })
})
