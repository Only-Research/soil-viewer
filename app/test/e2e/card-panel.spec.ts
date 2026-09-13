import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { showOnly } from './board-nav'
import { expect, test, type Page } from '@playwright/test'

import { E2E_TREE } from '../../playwright.config'

/**
 * **THE SLIDE-OVER, A25, IN A REAL BROWSER.** Phase 9.
 *
 * The contract, quoted rather than paraphrased:
 *
 * > `min(560px, 70%)`, 180ms translateX, xl shadow, left hairline, over a board that stays mounted
 * > and interactive; Esc closes; outside click closes (board-card exemption); different card swaps;
 * > same card closes; Esc ownership handoff; mount-then-animate.
 *
 * ## Why this suite exists, and what it is really guarding
 *
 * The first version of this panel shipped **open into nothing**. It un-hid, rendered its contents
 * correctly, and sat parked one panel-width off the right edge of the viewport — permanently,
 * because the single `requestAnimationFrame` that added `is-open` never fired. rAF only runs while
 * the page is actually rendering, so an occluded, backgrounded or minimised tab starves it. Measured
 * at the time: **zero callbacks in 300ms**, and a panel at `x: 1280` in a 1280 viewport.
 *
 * **`toBeVisible()` does not catch that**, which is the whole reason the assertions below are about
 * geometry. Under the bug the element was attached, displayed, non-empty and had a real bounding
 * box — everything Playwright's visibility heuristic asks for. It was simply not on the screen. So
 * every open here asserts the panel's box is **inside the viewport**, and the negative case asserts
 * it is gone from the layout entirely rather than merely see-through.
 *
 * `noFrames` reproduces the starved tab deterministically: rAF is replaced before any app code runs
 * with a function that registers the callback and never calls it. If the panel ever goes back to
 * depending on a frame being painted, these fail.
 */

const TAB = 'Projects'

/**
 * A tab that never paints. Installed as an init script so it is in place before the bundle
 * evaluates — a stub applied after boot would be testing a different program.
 *
 * It returns a plausible handle rather than nothing, because a caller that stores the id and later
 * cancels it must not throw: the point is to starve the callback, not to break the API around it.
 */
async function noFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let handle = 0
    window.requestAnimationFrame = ((): number => ++handle) as typeof window.requestAnimationFrame
    window.cancelAnimationFrame = ((): void => {}) as typeof window.cancelAnimationFrame
  })
}

async function openProjects(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  // `role="tab"`, not `button` — the tab bar is a real tablist, and asking for a button here found
  // nothing for six tests in a row.
  await page.getByRole('tab', { name: TAB, exact: true }).click()
  // The board is drawn from the index, which is fetched — wait for cards rather than for a timeout.
  await expect(page.locator('.board-card').first()).toBeVisible()
}

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Card' })

/**
 * A card **by its title**, not by any text it happens to contain.
 *
 * `hasText: 'orchard'` matched both cards: `cider-line` is nested at
 * `02-projects/orchard/02-work/projects`, so its breadcrumb carries the other card's name. The
 * first version of this suite asserted a swap and got back the card it had opened to begin with.
 */
const cardNamed = (page: Page, name: string) =>
  page.locator('.board-card').filter({
    has: page.locator('.board-card-title', { hasText: new RegExp(`^${name}$`) }),
  })

const viewportOf = (page: Page) => page.evaluate(() => document.documentElement.clientWidth)

/**
 * **On screen, not merely rendered — and measured once the slide has finished.**
 *
 * Polled rather than read straight after the click, because A25's transform takes 180ms and a box
 * sampled at t=0 is still at the closed position. The first run of this suite reported `1841`
 * against a 1280 viewport and looked exactly like the rAF bug it was written to catch, which is its
 * own lesson: **a measurement taken at the wrong moment is indistinguishable from the fault.**
 *
 * The poll is still the assertion that catches the real thing. Under the bug the panel never moves
 * at all, so this times out rather than passing on a technicality.
 */
async function settledBox(page: Page) {
  const panel = panelOf(page)
  const viewport = await viewportOf(page)
  await expect.poll(async () => {
    const box = await panel.boundingBox()
    return box === null ? -1 : Math.round(box.x + box.width)
  }, { message: 'the panel must come to rest with its right edge at the viewport edge' })
    .toBe(viewport)
  const box = await panel.boundingBox()
  expect(box, 'the panel must have a box at all').not.toBeNull()
  return { box, viewport }
}

test.describe('the slide-over', () => {
  test('opens on screen in a tab that never paints a frame', async ({ page }) => {
    await noFrames(page)
    /**
     * **1600, and the width is now load-bearing.** The percentage in `min(560px, 45%)` is measured
     * against the PANE, and the pane lost 272px to the rail. At 1280 the board is 1008 and 45% of
     * it is 454 — the percentage branch, which the test below already covers. 1600 leaves a 1328px
     * board, so the 560px cap wins and this still exercises the branch it was written for.
     */
    await page.setViewportSize({ width: 1600, height: 800 })
    await openProjects(page)

    await cardNamed(page, 'orchard').click()

    const { box, viewport } = await settledBox(page)
    if (box === null) return
    /**
     * A25's first branch: 560px wins at this width, and the border adds one. The tolerance is a
     * pixel, not a percentage — a panel that is 40px off is a panel whose width rule changed, and
     * that is worth failing over.
     */
    expect(box.width).toBeGreaterThanOrEqual(559)
    expect(box.width).toBeLessThanOrEqual(562)
    // The left edge is inside the viewport. Under the rAF bug it sat *at* the viewport width.
    expect(box.x).toBeGreaterThan(0)
    expect(box.x).toBeLessThan(viewport)
  })

  test('takes the percentage branch on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 })
    await openProjects(page)

    await cardNamed(page, 'orchard').click()

    const { box } = await settledBox(page)
    if (box === null) return
    /**
     * **45% of 600 is 270**, plus the hairline. 600 is below the 768px breakpoint, so the layout is
     * the phone's: the rail has no box there and the pane is the full width, which is why the
     * percentage is taken against 600 rather than 328.
     *
     * Asserted because a panel that always took 560px would pass every test above and cover a
     * phone's screen entirely, leaving no board to drag behind it. Projects keeps a side panel at
     * this width by the ruling — Tasks and Inbox go full screen instead.
     */
    expect(box.width).toBeGreaterThanOrEqual(269)
    expect(box.width).toBeLessThanOrEqual(272)
  })

  test('the closed panel is out of the layout, not just off the edge', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openProjects(page)

    /**
     * **The phantom-scroll regression.** `display: flex` on the class beat the user agent's
     * `[hidden] { display: none }`, so the closed panel stayed in the layout parked past the right
     * edge — `scrollWidth` 1841 against a 1280 viewport, a page that rubber-bands sideways onto
     * nothing. Measured before the fix; asserted here so it cannot come back quietly.
     */
    const scroll = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    expect(scroll.width).toBe(scroll.client)
    await expect(panelOf(page)).toBeHidden()
  })

  test('a different card swaps in place; the same card closes', async ({ page, browserName }) => {
    /**
     * **SKIPPED ON CI, WEBKIT ONLY — and it is now diagnosed rather than mysterious.** 2026-08-18.
     *
     * The cause is the overlap this test's own viewport arithmetic exists to dodge: the panel is
     * `position: absolute; right: 0`, nothing moves the board beneath it, and a card whose CENTRE
     * falls under the panel cannot be tapped — Playwright reports it as *"intercepts pointer
     * events"*. Measured at 1280 on both engines: panel from x=826, a card at 1010–1280 with its
     * centre at 1145. The runner's layout puts a card there at 1872 too; this Mac's does not.
     *
     * **That overlap is ACCEPTED BEHAVIOUR, ruled on 2026-08-18** — see
     * `build/design-pass-not-in-v1.md`. It is an overlay behaving like an overlay: one tap on the
     * board closes the panel and every card is reachable again. What it costs is the card-to-card
     * shortcut for cards underneath, which is a shortcut and not a route.
     *
     * So this is skipped where the layout happens to trip it, not because anything is broken. The
     * behaviour under test — a different card swaps in place, the same card closes — still runs on
     * every local run in both engines and on Chromium in CI.
     *
     * **A guard test for the overlap was written, confirmed the defect, and then removed** on their
     * ruling: a test asserting no card may sit under the panel demands a stricter property than the
     * app needs, and leaving it would have told every future reader to go fix something they had
     * decided was fine.
     */
    test.skip(
      browserName === 'webkit' && Boolean(process.env['CI']),
      'Fails only on the CI runner; the same behaviour is covered locally in both engines and on Chromium in CI. See the comment above.',
    )

    /**
     * **Wider than the other tests, and that is a finding rather than a convenience.**
     *
     * At 1280 this failed on WebKit with the panel *intercepting the click*: the board's four
     * columns put `Unfiled` — where every project starts life — under the open slide-over, so the
     * second card could not be reached at all. Real behaviour, reproducible by hand, and logged for
     * the UI pass. A wide viewport puts both cards clear of the panel so this test measures the swap
     * rather than the overlap.
     *
     * **1600 → 1872 when the rail arrived**, which is 1600 plus the sidebar's 272px. The board is
     * inset by the rail now, so every lane moved right by exactly that much and the fourth one slid
     * back under the panel — the same interception, reported the same way, for a new reason. The
     * number is not arbitrary: it restores the board width this test was calibrated against.
     */
    await page.setViewportSize({ width: 1872, height: 900 })
    await openProjects(page)
    const panel = panelOf(page)

    /**
     * Narrowed to the two seeded projects first. The e2e tree is shared and mutated by other
     * suites — it stood at forty projects on the run that found this — so anything that counts or
     * positions cards has to filter down to the ones it seeded. `orchard` matches both: one by
     * name, the other by the breadcrumb it is nested under.
     */
    await page.locator('.board-filter-field').fill('orchard')
    await expect(page.locator('.board-card')).toHaveCount(2)

    await cardNamed(page, 'orchard').click()
    await expect(panel.locator('.card-panel-title')).toHaveText('orchard')

    /**
     * A25's board-card exemption. Without it the document click listener treats this as an outside
     * click and closes, and the card's own handler then reopens — a flicker, and worse, the outgoing
     * contents are torn down through the *close* path instead of the swap path.
     *
     * Asserted as a swap by checking the panel never became hidden: the title changing alone would
     * also be true of a close-then-reopen.
     */
    await cardNamed(page, 'cider-line').click()
    await expect(panel.locator('.card-panel-title')).toHaveText('cider-line')
    await expect(panel).toBeVisible()

    await cardNamed(page, 'cider-line').click()
    await expect(panel).toBeHidden()
  })

  test('Escape closes it, and the board behind it stays live', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openProjects(page)
    const panel = panelOf(page)

    await cardNamed(page, 'orchard').click()
    await expect(panel).toBeVisible()

    /**
     * **Not a modal.** The board is still there and still takes input while the panel is open —
     * that is the difference between a slide-over and a dialog, and the reason there is no backdrop.
     * Proven by typing into the filter *through* the open panel.
     */
    /**
     * `cider`, not `orch`. Filtering on `orch` correctly returns **both** cards — `cider-line` sits
     * under `02-projects/orchard`, and the filter searches the breadcrumb as well as the name, by
     * design. The term has to be one that only one card can match, or this asserts nothing about
     * filtering.
     */
    await page.locator('.board-filter-field').fill('cider')
    await expect(page.locator('.board-card')).toHaveCount(1)
    // Cleared, but NOT asserted back to a number: the e2e tree is shared and its project count moves
    // with whatever the other suites created. `1` is the assertion that means something here.
    await page.locator('.board-filter-field').fill('')

    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
  })

  /**
   * **The editor, in the panel** — the PRD's *"card tap opens a slide-over panel with the full
   * editor beside the board"*, and the reason `opener.run` grew a host parameter at all.
   *
   * Asserted as a *CodeMirror surface with the file's text in it*, not as "the panel has content".
   * A panel that rendered a filename and a stub would satisfy anything weaker, and a control that
   * exists but is reachable by no product code is this build's signature failure — twelve times so
   * far. The second half of the test is the other half of that contract: leaving the tab closes the
   * panel, and the Files pane is not left holding an editor whose session has been closed.
   */
  test('a task card opens the real editor, and leaving the tab closes it', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click()

    /**
     * By index, resolved in the page. `{ label: /orchard/ }` does not typecheck — `selectOption`
     * takes exact strings — and matching on the text would also hit `cider-line`, whose breadcrumb
     * is `02-projects/orchard/02-work/projects`. `startsWith` is what distinguishes the project
     * from the projects nested under it.
     */
    await showOnly(page, 'orchard')
    const card = page.locator('.board-card').filter({ hasText: 'Press repair' }).first()
    await expect(card).toBeVisible()
    await card.click()

    const panel = panelOf(page)
    await expect(panel).toBeVisible()
    // The real editor, holding the real bytes.
    await expect(panel.locator('.cm-content')).toContainText('the card the slide-over opens')
    // The jump is still offered — the panel is the quick look, not a replacement for the Files pane.
    await expect(panel.getByRole('button', { name: 'View in Files' })).toBeVisible()

    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await expect(panel).toBeHidden()

    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    /**
     * §4.2's empty pane, asserted here because this is the one place in the suite that reaches it —
     * the app reopens your last file at boot, so the Files tab is almost never genuinely empty.
     *
     * **Two lines, and the first one is the point.** *"Nothing open"* says the screen is empty on
     * purpose; the single grey sentence it replaced reads at a glance like a failure to load.
     */
    const empty = page.locator('.files-main .files-placeholder')
    await expect(empty.locator('.files-placeholder-title')).toHaveText('Nothing open')
    await expect(empty).toContainText('Choose a file on the left.')
    await expect(page.locator('.files-main .cm-content')).toHaveCount(0)
  })

  /**
   * **THE PATH SITS UNDER THE TITLE, IN THE NARROWEST PLACE THE HEADER APPEARS.**
   *
   * ruled 2026-08-15: *"on the task card lets just move the filepath under the title, it's
   * cramming up with the copy path button and disrupts the whole header section."*
   *
   * Asserted as **geometry, not as CSS**. Reading `flex-direction` back off the element would only
   * restate the stylesheet — it would pass on a rule that is present but overridden, and it says
   * nothing about where the path actually lands. Boxes are the thing the operator was looking at.
   *
   * The header used to be one row with `flex-wrap: wrap` here, so the path went beside the filename
   * on a short name and below it on a long one. **That is the failure this pins**: under the old
   * rules the path's box overlaps the title row's vertically, and the two comparisons below both go
   * red. Mutation-checked by restoring `flex-direction: row` — the first assertion fails.
   *
   * The width comparison is the second half. The wrap existed because the header could otherwise
   * force itself wider than the panel; that pressure is gone, but nothing else asserts it stayed
   * gone, and a header wider than its panel is the bug the hack was originally hiding.
   */
  test('the header keeps the path on its own line under the title, inside the panel', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
    await showOnly(page, 'orchard')

    const card = page.locator('.board-card').filter({ hasText: 'Press repair' }).first()
    await expect(card).toBeVisible()
    await card.click()

    const panel = panelOf(page)
    await expect(panel).toBeVisible()
    // The document, not the card summary — this header belongs to the editor inside the panel.
    await expect(panel.locator('.cm-content')).toContainText('the card the slide-over opens')

    const titleRow = panel.locator('.pane-header-top')
    const path = panel.locator('.pane-path')
    await expect(titleRow).toBeVisible()
    /**
     * **A path with no text would satisfy every box comparison below and prove nothing.** The
     * element is only rendered when `headerPath` has a folder to name, so an empty one here means
     * the fixture moved rather than that the layout is right.
     */
    await expect(path).not.toBeEmpty()

    // Settled: the panel translates for 180ms and a box read at t=0 is still at the closed position.
    await expect.poll(async () => {
      const box = await panel.boundingBox()
      return box === null ? -1 : Math.round(box.x + box.width)
    }, { message: 'the panel must come to rest inside the viewport' })
      .toBe(await viewportOf(page))

    const titleBox = await titleRow.boundingBox()
    const pathBox = await path.boundingBox()
    const panelBox = await panel.boundingBox()
    expect(titleBox, 'the title row must have a box').not.toBeNull()
    expect(pathBox, 'the path must have a box').not.toBeNull()
    expect(panelBox, 'the panel must have a box').not.toBeNull()
    if (titleBox === null || pathBox === null || panelBox === null) return

    expect(
      pathBox.y,
      'the path must start at or below the bottom of the title row, never beside it',
    ).toBeGreaterThanOrEqual(titleBox.y + titleBox.height)

    expect(
      Math.round(pathBox.x + pathBox.width),
      'the path must not run past the edge of the panel holding it',
    ).toBeLessThanOrEqual(Math.round(panelBox.x + panelBox.width))
  })

  /**
   * **THE SECURITY REVIEW'S C3 / P9-3, and it needs no race at all.**
   *
   * An agent rewrites the file you have open in the slide-over. The live-update channel decides to
   * reopen it — correctly, the buffer is clean — and the reopen called `opener.run(entry)` with **no
   * host**, so it remounted the document into the Files pane. Which is hidden, because a board tab
   * is showing. What was left on screen was the panel's *old* editor attached to a session that had
   * just been closed underneath it: a surface that takes keystrokes and saves none of them, with no
   * error anywhere. Closing the panel then flushed and closed the **Files pane's** session and
   * nulled the global, so the orphan was never closed either.
   *
   * Both halves are asserted, because each fails independently under the bug: the panel must show
   * the new bytes, and the Files pane must still be holding nothing.
   *
   * The timeout is 15s, matching `live-updates.spec.ts` — a change crosses a filesystem event, a
   * 250ms coalescing window, a subtree reconcile and a network hop before it can reach a pixel, and
   * a tight bound here would measure the machine rather than the feature.
   *
   * ## It never touches the Files tree, and that is the second thing it proves
   *
   * The first version of this test walked the tree open down to the file, and it only passed
   * *because* it did. The reopen path used to be gated on the parent folder having a cached
   * listing: `onFilesChanged` read the entry out of `store.childrenOf(parent)` and returned
   * silently when that was `undefined`, which was fine while clicking a tree row was the only way
   * to open a file — clicking the row is what lists the folder. **A board card is not a tree row.**
   *
   * So without the expansion this failed in both engines for a reason that was not C3 at all:
   * nothing was yanked anywhere, the update simply never arrived. A file opened from a board got no
   * live update, ever, unless its folder happened to be open in Files — silent staleness on the
   * main way a task file is opened. `onFilesChanged` now fetches the listing when the tree has
   * never seen it, and the expansion is gone from this test so that stays proven.
   */
  test('a rewrite on disk is redrawn in the panel, not yanked into the hidden Files pane',
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1600, height: 900 })
      const problems: string[] = []
      page.on('pageerror', error => { problems.push(error.message) })
      await page.goto('/')
      await expect(page.locator('#app')).toBeAttached()
      const project = `scratch-${testInfo.project.name}-panel-live`
      await page.getByRole('tab', { name: 'Tasks', exact: true }).click()

      await showOnly(page, project)

      const card = page.locator('.board-card').filter({ hasText: 'Valve' }).first()
      await expect(card).toBeVisible()
      await card.click()

      const panel = panelOf(page)
      await expect(panel.locator('.cm-content')).toContainText('the text this test starts from')

      await writeFile(
        join(E2E_TREE, '02-projects', project, '02-work', 'tasks', 'urgent', 'valve.md'),
        '# Valve\n\nrewritten by someone else\n',
      )

      await expect(panel.locator('.cm-content'))
        .toContainText('rewritten by someone else', { timeout: 15_000 })
      await expect(page.locator('.files-main .cm-content'),
        'the document was remounted into the hidden Files pane').toHaveCount(0)

      // And the panel still closes cleanly afterwards — the teardown now asks whether the live
      // document is the one it drew, and after a reopen into this same surface it still is.
      await page.keyboard.press('Escape')
      await expect(panel).toBeHidden()
      expect(problems).toEqual([])
    })

  test('a click on the board closes it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openProjects(page)
    const panel = panelOf(page)

    await cardNamed(page, 'orchard').click()
    await expect(panel).toBeVisible()

    // The filter bar: inside the board, outside the panel, and not a card — so no exemption applies.
    await page.locator('.board-filter').click()
    await expect(panel).toBeHidden()
  })
})
