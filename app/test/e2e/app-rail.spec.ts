import { expect, test, type Page } from '@playwright/test'

/**
 * **THE RAIL — packet §4.1, direction 1a, in a real browser at both widths.**
 *
 * The rail is the app's own sidebar, promoted out of the Files pane and parented to the shell. This
 * suite exists for the one thing that promotion costs.
 *
 * ## What it is actually guarding
 *
 * Inside the Files pane, the tree was hidden by the pane being hidden. **One level up, that stops
 * being automatic.** It is now a single line in `showTab` — `rail.toggleAttribute('hidden', …)` —
 * and if that line is ever lost, the failure is not subtle and not local: the file tree lies across
 * the task board on a phone, and takes a 272px bite out of every desktop tab. Nothing else in the
 * suite would notice, because every other Files test opens the Files tab first.
 *
 * ## Geometric, for the same reason `mobile-chrome.spec.ts` is
 *
 * `toBeHidden()` on the rail would pass against a rail that is on screen but empty, and against one
 * whose contents are `visibility: hidden` and still occupying 272px. The question here is *where the
 * board's left edge is*, in pixels, so that is what is asserted. §18.6's lesson, quoted in that
 * suite: *"250 browser tests were green and a thumb was not."*
 *
 * **390 × 844 is the user's phone.** 1280 × 800 is the desktop the packet's numbers are written for.
 */

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

/** §4.1's sidebar, and the token the panes inset against. Asserted rather than read from CSS. */
const RAIL_WIDTH = 272

async function boot(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size)
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
}

const rail = (page: Page) => page.locator('.app-rail')
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

/**
 * The board's own box, scoped to the tab that is actually showing.
 *
 * `.tasks-pane` matches three elements — Tasks, Projects and Inbox each have one — and asking for it
 * unscoped is the ambiguous-locator mistake this build has made three separate times.
 */
const shownBoard = (page: Page) => page.locator('.tasks-pane:not([hidden])')

test.describe('the rail, on a desktop', () => {
  test('holds the tree at the left edge, and the Files pane starts where it ends', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Files').click()

    await expect(rail(page)).toBeVisible()
    // The tree is IN the rail, not beside it. A sidebar that ended up as a second column inside the
    // pane would satisfy every box assertion below while drawing two 272px columns.
    await expect(rail(page).locator('.files-sidebar')).toBeVisible()
    await expect(page.locator('.files-pane .files-sidebar')).toHaveCount(0)

    const railBox = await rail(page).boundingBox()
    const paneBox = await page.locator('.files-pane').boundingBox()
    expect(railBox, 'the rail must have a box').not.toBeNull()
    expect(paneBox, 'the Files pane must have a box').not.toBeNull()
    if (railBox === null || paneBox === null) return

    expect(Math.round(railBox.x), 'the rail sits against the left edge').toBe(0)
    expect(Math.round(railBox.width), 'the rail is §4.1 wide').toBe(RAIL_WIDTH)
    expect(
      Math.round(paneBox.x),
      'the document half starts where the rail ends — no overlap, no gap',
    ).toBe(RAIL_WIDTH)
  })

  /**
   * **The rail is permanent — that is what makes it a rail.** It survives a tab change, and every
   * pane insets against it rather than running under it.
   *
   * This replaces an assertion that the rail was *hidden* on a board tab, which was true only while
   * the rail belonged to Files. The tabs live in it now, so a rail that vanished on Tasks would take
   * the navigation with it.
   *
   * **The overlap check is the real one.** A pane that kept its old full-width inset would still
   * report a box, still be visible, and would simply be drawn under 272px of sidebar — the first
   * lane permanently unreachable, with nothing failing.
   */
  test('survives a tab change, and the board starts where it ends', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Files').click()
    await expect(rail(page)).toBeVisible()

    await tab(page, 'Tasks').click()
    await expect(rail(page), 'the rail holds the tabs now — it cannot leave with them').toBeVisible()

    const boardBox = await shownBoard(page).boundingBox()
    const railBox = await rail(page).boundingBox()
    expect(boardBox, 'the board must have a box').not.toBeNull()
    expect(railBox, 'the rail must have a box').not.toBeNull()
    if (boardBox === null || railBox === null) return
    expect(
      Math.round(boardBox.x),
      'the board starts at the rail edge — under it means a lane nobody can reach',
    ).toBe(Math.round(railBox.x + railBox.width))
    expect(Math.round(boardBox.y), 'and at the top: there is no strip above it any more').toBe(0)

    await tab(page, 'Files').click()
    await expect(rail(page)).toBeVisible()
  })

  /**
   * §4.1: *"active is …a filled pill"* — the operator's *"whatever you're on is highlighted by blue"*,
   * which the reference app draws as a 10% teal wash rather than the underline the packet described.
   *
   * The colour is asserted as a computed value because that is the whole claim. A class name would
   * pass against a rule that was never written.
   */
  test('marks the tab you are on with the teal wash', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Tasks').click()

    const active = rail(page).locator('.tab.is-active')
    await expect(active).toHaveText('Tasks')
    await expect(active).toHaveCSS('background-color', 'rgba(91, 159, 166, 0.1)')

    // And exactly one, because two highlighted tabs is the selection bug this build has had before.
    await expect(rail(page).locator('.tab.is-active')).toHaveCount(1)
  })
})

test.describe('the rail header', () => {
  /**
   * §4.1: *"Wordmark 'Soil Viewer'… with 'N workspaces' beneath it."* The the reference app the operator pointed
   * at draws exactly this, and the count there is `workspaces.length` — the registry, not a label.
   *
   * **The count is cross-checked against the tree's root rows, not against a regular expression.**
   * A hardcoded `"3 workspaces"` satisfies any shape test. The roots come from `store.setRoots`, a
   * different path from the `folders.length` the header reads, so the two agreeing is evidence that
   * the header is reading the registry rather than reciting it. Roots are collapsed at boot —
   * the ruling — so `aria-level="1"` is exactly the registered folders and nothing under them.
   */
  test('names the app and counts the real registry', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Files').click()

    await expect(rail(page).locator('.rail-wordmark')).toHaveText('Soil Viewer')

    const roots = await page.locator('.tree-row[aria-level="1"]').count()
    expect(roots, 'the suite always seeds at least one root').toBeGreaterThan(0)
    await expect(rail(page).locator('.rail-workspaces'))
      .toHaveText(`${roots} workspace${roots === 1 ? '' : 's'}`)
  })

  /**
   * The gear is the desktop's way into Settings, and it presses the same button the phone's strip
   * does — `settingsDoor` in `main.tsx`, which holds the element rather than a copy of its handler.
   * This is the assertion that the wire is actually connected; the dialog opening is the proof.
   */
  test('the gear opens Settings', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Files').click()

    const gear = rail(page).locator('.rail-gear')
    await expect(gear).toBeVisible()
    await expect(gear, 'the icon is aria-hidden, so the button needs its own name')
      .toHaveAttribute('aria-label', 'Settings')

    await gear.click()
    await expect(page.locator('.modal[aria-label="Settings"]')).toBeVisible()
  })

  /**
   * **ONE WAY IN AT EACH WIDTH, and this is the pair that proves it.**
   *
   * Two Settings controls exist in the markup. If both were ever on screen at once the app would
   * offer the same door twice; if neither were, Settings would be unreachable — and on a phone that
   * is the only route to adding a folder at all. Asserted at both widths rather than trusting the
   * two `display` rules to stay opposites.
   */
  test('offers exactly one Settings control, at either width', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Files').click()
    await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(1)
    await expect(rail(page).locator('.rail-gear')).toBeVisible()
    await expect(page.locator('.sidebar-settings')).toBeHidden()

    await page.setViewportSize(PHONE)
    await page.reload()
    await tab(page, 'Files').click()
    await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(1)
    await expect(page.locator('.rail-header'), 'the phone gets a title block, not a sidebar header')
      .toBeHidden()
    await expect(page.locator('.sidebar-settings')).toBeVisible()
  })
})

test.describe('the collapse', () => {
  /** §4.1's collapsed strip. The width is the assertion; the rest of the rail going is the point. */
  const COLLAPSED_WIDTH = 44

  /**
   * the operator, on what they wanted from the reference app: *"the way you can collapse it."*
   *
   * **The pane is measured too, and that is the half worth having.** A rail that narrows while every
   * pane stays inset at 272px leaves a band of empty screen down the left that nothing draws in —
   * the app would look broken in a way no assertion about the rail alone could see. That is why the
   * live width is one variable rather than a condition repeated on each pane.
   */
  test('takes the rail to a 44px strip and gives the width back to the pane', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Tasks').click()

    await page.locator('.rail-collapse').click()

    // The width animates for 200ms; a box read at t=0 is still the old one.
    await expect.poll(async () => {
      const box = await rail(page).boundingBox()
      return box === null ? -1 : Math.round(box.width)
    }, { message: 'the rail must come to rest at the collapsed width' })
      .toBe(COLLAPSED_WIDTH)

    const boardBox = await shownBoard(page).boundingBox()
    expect(boardBox, 'the board must have a box').not.toBeNull()
    if (boardBox === null) return
    expect(
      Math.round(boardBox.x),
      'the board follows the rail in — otherwise there is a dead band down the left',
    ).toBe(COLLAPSED_WIDTH)

    // §4.1: "Nothing else survives; the tabs do not become icons."
    await expect(rail(page).locator('.tabs')).toBeHidden()
    await expect(rail(page).locator('.rail-identity')).toBeHidden()
    // Hidden, not unmounted — §18.4's rule. The tree keeps its scroll position and open folders
    // through a collapse for the same reason it keeps them through a phone's screen change.
    await expect(rail(page).locator('.files-sidebar')).toBeHidden()
    await expect(rail(page).locator('.rail-collapse'), 'the way back out survives').toBeVisible()
  })

  /**
   * One control, one state. *"Collapse sidebar"* announced on a collapsed rail is a lie, and a
   * screen reader is the only place that lie would be heard — so it is the only place to assert it.
   */
  test('the one control names what it will do, both ways', async ({ page }) => {
    await boot(page, DESKTOP)
    const control = page.locator('.rail-collapse')

    await expect(control).toHaveAttribute('aria-label', 'Collapse sidebar')
    await expect(control).toHaveAttribute('aria-expanded', 'true')

    await control.click()
    await expect(control).toHaveAttribute('aria-label', 'Expand sidebar')
    await expect(control).toHaveAttribute('aria-expanded', 'false')

    await control.click()
    await expect(control).toHaveAttribute('aria-label', 'Collapse sidebar')
    await expect.poll(async () => {
      const box = await rail(page).boundingBox()
      return box === null ? -1 : Math.round(box.width)
    }, { message: 'and it comes all the way back' }).toBe(RAIL_WIDTH)
  })

  /**
   * **THE CROSS-WIDTH TRAP.** `data-rail` lives on the root and survives a resize. A phone has no
   * rail to collapse, but it very much has a tab bar and a file tree — both of which the collapsed
   * rules hide. Collapse on a desktop, drag the window narrow, and without the `:not()` guard the
   * phone is left with no navigation at all.
   *
   * The layout flips live on a drag, so this is reachable by hand, not only by reload.
   */
  test('a rail collapsed on a desktop does not strip the phone', async ({ page }) => {
    await boot(page, DESKTOP)
    await page.locator('.rail-collapse').click()
    await expect(page.locator('.tabs')).toBeHidden()

    await page.setViewportSize(PHONE)
    await expect(page.locator('.tabs'), 'the phone keeps its bar whatever the rail was doing')
      .toBeVisible()
    await tab(page, 'Files').click()
    await expect(page.locator('.files-sidebar'), 'and its tree').toBeVisible()
  })
})

test.describe('the rail, on a phone', () => {
  /**
   * §18.4 — *"on a phone you are in the tree or in the document, never both."* The rule survived the
   * promotion by moving from a descendant selector to `data-files-screen` on the root, which is the
   * one change that could have broken it: the tree and the document stopped sharing a parent, so
   * `.files-pane[data-screen] .files-sidebar` matched nothing at all afterwards.
   */
  test('is the whole tree screen, and leaves entirely for the document', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()

    /**
     * **The sidebar, not the rail.** At this width the rail is `display: contents` — it has no box
     * at all, so it can be neither measured nor meaningfully called visible. The tree is what
     * occupies the screen, and the tab bar is what escapes to the bottom edge.
     */
    const tree = page.locator('.files-sidebar')
    await expect(tree).toBeVisible()
    const treeBox = await tree.boundingBox()
    expect(treeBox, 'the tree must have a box').not.toBeNull()
    if (treeBox === null) return
    expect(Math.round(treeBox.width), 'the tree is the whole screen on a phone').toBe(PHONE.width)
    await expect(page.locator('.files-main')).toBeHidden()
  })

  /**
   * **THE PHONE'S MUTATION TARGET, and the most damaging failure in this unit.**
   *
   * Two ways to get it wrong, and both were live during this build. Hiding the rail instead of the
   * sidebar takes the tab bar off the screen and leaves the phone with no navigation. Leaving the
   * tree visible puts it over the board.
   *
   * The third way — the tree on screen but unreachable — is covered by the tree-tap test below.
   */
  test('does not lie over the board, and the board still takes a tap', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Tasks').click()

    await expect(
      page.locator('.files-sidebar'),
      'the tree must not be on screen over a board',
    ).toBeHidden()
    await expect(page.locator('.tabs'), 'the bar must not leave with it').toBeVisible()

    const boardBox = await shownBoard(page).boundingBox()
    expect(boardBox, 'the board must have a box').not.toBeNull()
    if (boardBox === null) return
    expect(Math.round(boardBox.width), 'the board owns the whole phone').toBe(PHONE.width)

    // Reaching the board, not merely seeing it: a card opens its panel.
    const card = shownBoard(page).locator('.board-card').first()
    await expect(card).toBeVisible()
    await card.click()
    await expect(page.getByRole('complementary', { name: 'Card' })).toBeVisible()
  })

  /**
   * The tree screen and the tab bar coexist, which is the arrangement `display: contents` buys.
   * If the rail were hidden per tab as it was in unit 1, this pair could never both be true.
   */
  test('keeps the tab bar reachable over the tree', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()

    await expect(page.locator('.files-sidebar')).toBeVisible()
    const bar = page.locator('.tabs')
    await expect(bar).toBeVisible()

    const barBox = await bar.boundingBox()
    expect(barBox, 'the bar must have a box').not.toBeNull()
    if (barBox === null) return
    expect(
      Math.round(barBox.y + barBox.height),
      'the bar is against the bottom edge, not stacked inside a 272px column',
    ).toBe(PHONE.height)

    // And it works from there: pressing a tab over the tree actually changes tab.
    await tab(page, 'Tasks').click()
    await expect(page.locator('.files-sidebar')).toBeHidden()
  })

  /**
   * **THE TREE MUST BE TAPPABLE, NOT MERELY VISIBLE — and this is the assertion that was missing.**
   *
   * Promoting the sidebar made it a sibling that comes *earlier* in the DOM than `.files-pane`, so
   * at equal z-index the pane paints over it. On a phone that pane is `inset: 0` with its only child
   * hidden on the tree screen: an empty full-screen sheet of glass over the whole tree.
   *
   * It cost 32 browser tests, every one of them a 30-second timeout on a click Playwright described
   * as *"visible, enabled and stable"* — because the element was all three. Something was in front
   * of it. **`toBeVisible()` is blind to this by construction**, so the only honest assertion is to
   * tap a row and require the tree to answer.
   *
   * Written after the fix and then checked against the bug: reverting `z-index` on the mobile
   * sidebar fails this. The first version of this suite asserted a tap on the *board* instead, which
   * passed under the bug and would have let it back in.
   */
  test('the tree takes a tap, rather than sitting under an invisible pane', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()

    const root = page.locator('.files-sidebar .tree-row[aria-level="1"]').first()
    await expect(root).toBeVisible()
    // Roots start collapsed — the ruling — so this is the state the tap has to change.
    await expect(root).toHaveAttribute('aria-expanded', 'false')

    await root.click()
    await expect(root, 'the tap reached the row, not a pane on top of it')
      .toHaveAttribute('aria-expanded', 'true')
  })
})
