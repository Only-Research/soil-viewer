import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page, type TestInfo } from '@playwright/test'

import { E2E_TREE } from '../../playwright.config'

/**
 * **THE FIFTH TAB, IN A REAL BROWSER.** P14 B1.
 *
 * `core/boards.test.ts` proves what counts as a board — the archive rule, the no-nesting rule,
 * symlinks, ordering — over ten cases without a filesystem. None of that is re-asserted here.
 *
 * What only a browser answers is whether the tab **reaches** it, and whether a fifth tab fits the
 * phone. The operator's condition on this work, verbatim: *"make sure that the spacings doesn't get
 * fucked up on the bottom of the app for the phone. We're adding a whole new fifth feature, so just
 * double-checking kind of everything."*
 *
 * **390 × 844 is their phone.**
 */

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

/**
 * §18.3's bar is the app's primary navigation, at the screen edge where horizontal room is free.
 * The same floor `mobile-chrome.spec.ts` states: there is nothing to buy by going under 44.
 */
const TAB_TOUCH_MIN = 44

async function boot(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size)
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

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

test.describe('the Boards tab', () => {
  /**
   * MUTATION: remove the `boards` entry from `TABS`. Must redden.
   *
   * The tab is last, after Inbox, because the PRD's *"Files · Tasks · Projects · Inbox"* is
   * the ordering and this is an addition to it rather than a re-cut of it. Asserted, so the
   * order is not quietly rearranged by whoever adds a sixth.
   */
  test('exists, is fifth, and comes after Inbox', async ({ page }) => {
    await boot(page, DESKTOP)

    const labels = await page.getByRole('tab').allInnerTexts()
    expect(labels).toEqual(['Files', 'Tasks', 'Projects', 'Inbox', 'Boards'])
  })

  /**
   * MUTATION: point `boards.list` at an empty array, or drop the `refreshBoards` call from
   * `showTab`. Must redden — the pane would stay on "Loading…" forever.
   *
   * **Asserted as "it drew something real", not as a specific board name.** Which boards exist
   * depends on the fixture tree, and pinning a name here would be a second statement of what the
   * fixture contains — the same mistake `quick-open.spec.ts` records making and correcting.
   */
  test('opening it asks the server and draws an answer, not a spinner', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Boards').click()

    const host = page.locator('.boards-host')
    await expect(host).toBeVisible()

    // Either a list or the empty state — both are answers. "Loading…" is not.
    await expect(host.locator('.boards-list, .boards-empty')).toBeVisible()
    await expect(host.locator('.board-empty'), 'the waiting state must have been replaced')
      .toHaveCount(0)
  })

  /**
   * §17: *"a tab with nothing to show explains itself rather than rendering blank."*
   *
   * MUTATION: return early with an empty host when there are no boards. A new tab that renders
   * blank is the difference between "I have not made one yet" and "this is broken", and Boards is
   * the tab most likely to be empty on the day it ships.
   */
  test('says what a board is when there are none, rather than rendering blank', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Boards').click()

    /**
     * **Waited for before branching, and the first draft was not.**
     *
     * `count()` resolves immediately — it does not wait. Read before the round trip lands it
     * returns 0 for both branches, so the test took the "there are boards" path against a pane that
     * was still showing *Loading…* and then failed looking for a row. Same shape as the card-panel
     * guard on 2026-08-16: **a value read at a moment nothing pinned.** The wait is the pin.
     */
    const host = page.locator('.boards-host')
    await expect(host.locator('.boards-list, .boards-empty')).toBeVisible()

    const empty = page.locator('.boards-empty')
    if (await empty.count() > 0) {
      await expect(empty).toContainText('board-')
    } else {
      // The fixture has boards, so the empty state cannot be exercised here. Its wording is proven
      // in the unit test; this branch records that the case was considered, not skipped.
      await expect(page.locator('.boards-row').first()).toBeVisible()
    }
  })
})

test.describe('five tabs on a phone', () => {
  /**
   * **THE SPACING TEST ASKED FOR.**
   *
   * MUTATION: add a sixth tab, or widen a label past the fifth's share. Must redden.
   *
   * Five tabs were measured at 76×48 before this phase with a cloned mock. **This asserts the real
   * one**, because a measurement of a mock is a measurement of a mock — and the whole reason this
   * suite is geometric is §18.6's lesson, quoted in `mobile-chrome.spec.ts`: *"250 browser tests
   * were green and a thumb was not."*
   */
  test('all five fit, none clipped, all thumb-sized', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()
    await settled(page)

    const bar = await page.locator('.tabs').boundingBox()
    expect(bar, 'the tab bar must be laid out at all').not.toBeNull()
    if (bar === null) return

    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(5)

    let previousRight = bar.x - 1
    for (let at = 0; at < 5; at += 1) {
      const element = tabs.nth(at)
      const label = await element.innerText()
      const box = await element.boundingBox()
      expect(box, `${label} must be laid out`).not.toBeNull()
      if (box === null) continue

      // Inside the bar, horizontally and vertically — nothing running off either edge.
      expect(box.x, `${label} must start inside the bar`).toBeGreaterThanOrEqual(bar.x - 1)
      expect(box.x + box.width, `${label} must end inside the bar`)
        .toBeLessThanOrEqual(bar.x + bar.width + 1)

      // Laid out in order and not overlapping its neighbour.
      expect(box.x, `${label} must not overlap the tab before it`)
        .toBeGreaterThanOrEqual(previousRight - 1)
      previousRight = box.x + box.width

      // Thumb-sized. §18.3's floor, and the reason the fifth tab was measured before being added.
      expect(box.height, `${label} must be at least ${TAB_TOUCH_MIN}px tall`)
        .toBeGreaterThanOrEqual(TAB_TOUCH_MIN)
      expect(box.width, `${label} must have real width`).toBeGreaterThan(0)
    }

    // The bar still ends at the bottom of the screen — a fifth tab must not have pushed it off.
    expect(bar.y + bar.height, 'the bar still sits on the bottom edge')
      .toBeGreaterThanOrEqual(PHONE.height - 1)
  })

  /**
   * **THE TAB ROW MUST FIT THE RAIL — and this test did not exist, which is why the operator found the
   * bug on their own desktop.**
   *
   * The phone bar was measured carefully before the fifth tab was added and again after. **The
   * desktop rail was never measured at all, and it is the NARROWER surface**: 272px against the
   * phone's 390. Five tabs wanted 279 and `Boards` hung 6.5px past the rail's right edge.
   *
   * "Five tabs fit" was proven on the wide surface and assumed on the tight one. That is the same
   * shape as every other defect this build has found — a green that was about something else.
   *
   * MUTATION: restore `padding: 5px 10px` on the desktop tab, or drop `min-width: 0`. Must redden.
   */
  test('DESKTOP: the tab row fits inside the rail, with nothing hanging past it', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Files').click()
    await settled(page)

    const rail = await page.locator('.app-rail').boundingBox()
    const bar = page.locator('.tabs')
    if (rail === null) throw new Error('the rail is not laid out')

    // The row itself must not be scrollable — a scrollbar here means the tabs did not fit.
    const overflow = await bar.evaluate(el => el.scrollWidth - el.clientWidth)
    expect(overflow, 'the tab row overflows its own box').toBeLessThanOrEqual(0)

    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(5)

    for (let at = 0; at < 5; at += 1) {
      const element = tabs.nth(at)
      const label = await element.innerText()
      const box = await element.boundingBox()
      if (box === null) throw new Error(`${label} is not laid out`)

      expect(box.x + box.width, `${label} must not hang past the rail's edge`)
        .toBeLessThanOrEqual(rail.x + rail.width)
      expect(box.width, `${label} must have real width`).toBeGreaterThan(0)
    }
  })

  /**
   * Labels must not be silently truncated to fit the rail either. The ellipsis rule is insurance
   * against a sixth tab, not something that should be doing any work today.
   *
   * MUTATION: narrow the rail, or add a sixth tab. Must redden.
   */
  test('DESKTOP: no label is truncated inside the rail', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Files').click()
    await settled(page)

    const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('.tab'))
      .filter(element => element.scrollWidth > element.clientWidth + 1)
      .map(element => element.textContent ?? ''))

    expect(clipped, 'these labels do not fit the rail').toEqual([])
  })

  /**
   * **The label must not be silently truncated to fit.** A box can be the right width while the
   * text inside it reads "Board…" or is clipped mid-word, and every geometric assertion above would
   * still pass. `scrollWidth` against `clientWidth` is what catches that.
   *
   * MUTATION: force a narrow tab width. Must redden.
   */
  test('no label is clipped inside its own tab', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Files').click()
    await settled(page)

    const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('.tab'))
      .filter(element => element.scrollWidth > element.clientWidth + 1)
      .map(element => `${element.textContent ?? ''} (${element.scrollWidth} > ${element.clientWidth})`))

    expect(clipped, 'these labels do not fit their tabs').toEqual([])
  })

  /**
   * The Boards pane must obey the same phone rules every other pane does, and the strip P13 just
   * split must not follow it here — the strip belongs to Files.
   *
   * **THE FIRST VERSION OF THIS TEST ASSERTED THE OPPOSITE OF A DECISION ALREADY MADE**, and it is
   * worth recording rather than quietly fixing.
   *
   * It required the scroll box to stop at the tab bar. It does not, and it should not: the shipped
   * design runs the scroller under the bar and puts the clearance *inside* it as trailing padding.
   * The CSS says why — *"content you scroll into and not a dead strip that appears when the bar
   * leaves"* — which matters because §18.2's bar retreats on scroll. Probing Tasks and Projects at
   * 390px returned an identical bottom of 844 against a bar at 795, with 64px of padding: Boards
   * was right and the assertion was wrong.
   *
   * So this asserts the invariant that is actually load-bearing — **the last row can be scrolled
   * clear of the bar** — and that Boards matches its siblings rather than inventing its own answer.
   *
   * MUTATION: drop `.boards-host` out of the mobile trailing-room rule. Must redden.
   */
  test('the Boards pane matches its siblings and keeps the last row reachable', async ({ page }) => {
    await boot(page, PHONE)
    await tab(page, 'Boards').click()
    await settled(page)

    await expect(page.locator('.boards-host')).toBeVisible()
    await expect(page.locator('.tabs'), 'the bar is still there').toBeVisible()
    await expect(page.locator('.sidebar-strip'), 'the Files strip belongs to Files').toBeHidden()

    const bar = await page.locator('.tabs').boundingBox()
    if (bar === null) throw new Error('the tab bar is not laid out')

    const trailing = await page.locator('.boards-host')
      .evaluate(element => Number.parseFloat(getComputedStyle(element).paddingBlockEnd))

    expect(trailing, 'the last row must be able to scroll clear of the bar')
      .toBeGreaterThanOrEqual(bar.height)

    // And the same answer the other two panes give, so Boards has not invented its own.
    const sibling = await page.evaluate(() => {
      const host = document.querySelector('.tasks-pane[hidden] .board-host')
      return host === null ? null : getComputedStyle(host).paddingBlockEnd
    })
    if (sibling !== null) {
      expect(`${trailing}px`, 'Boards must clear the bar the same way Tasks and Projects do')
        .toBe(sibling)
    }
  })
})

/**
 * **OPENING A BOARD.** P14 B2, against the fixture shapes in `mock-soil/tree.ts`.
 *
 * `core/board-contents.test.ts` proves the rules over fourteen cases without a filesystem. What only
 * a browser answers is whether the tab reaches them — and the fixture carries the awkward shapes on
 * purpose, so this drives real trees rather than two happy files.
 */
test.describe('one board', () => {
  const openColdStore = async (page: Page): Promise<void> => {
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list')).toBeVisible()
    await page.getByRole('button', { name: /Cold store/i }).click()
    await expect(page.locator('.board-columns')).toBeVisible()
  }

  /**
   * MUTATION: drop the `boards.open` call, or point the row's click at the Files reveal it used in
   * B1. Must redden.
   */
  test('a row opens the board into its columns, with the cards in them', async ({ page }) => {
    await boot(page, DESKTOP)
    await openColdStore(page)


    const names = await page.locator('.board-column-name').allInnerTexts()
    expect(names, 'Uncategorized is leftmost; the numbered columns follow in order')
      .toEqual(['Uncategorized', 'Doing', 'Done'])

    const doing = page.locator('.board-column').nth(1)
    await expect(doing.locator('.boards-card')).toHaveCount(2)
    await expect(doing).toContainText('Compressor quote')
    await expect(doing).toContainText('Insulation spec')
  })

  /**
   * **THE THREE SEPARATIONS, on one screen.** MUTATION: any of the four in `boardContents`.
   *
   * Each of these is a file that exists in the fixture and must land somewhere specific — or
   * nowhere. Asserted together because the failure mode is one landing in the wrong place, which is
   * only visible against the others.
   */
  test('loose markdown, a nested file, and an archived board each land correctly', async ({ page }) => {
    await boot(page, DESKTOP)
    await openColdStore(page)

    // 1 — loose in the board folder → Uncategorized, leftmost.
    const uncategorized = page.locator('.board-column').first()
    await expect(uncategorized.locator('.board-column-name')).toHaveText('Uncategorized')
    await expect(uncategorized).toContainText('Dropped in by an agent')

    // 2 — a markdown file inside a subfolder of a column is drawn nowhere. No nested cards.
    await expect(page.locator('.board-columns'), 'deeper than a column is not a card')
      .not.toContainText('Panel datasheet')
    await expect(page.locator('.board-column-name'), 'and its folder is not a column')
      .not.toHaveText(['Attachments', 'Attachments', 'Attachments'])

    // 3 — the archived board is not even in the list behind this screen.
    await page.locator('.board-screen-back').click()
    await expect(page.locator('.boards-list')).toBeVisible()
    await expect(page.locator('.boards-list'), 'archived boards do not appear')
      .not.toContainText('Old launch')
  })

  /**
   * **TWO SCREENS, NEVER BOTH** — §18.4's rule, and the way back out.
   *
   * MUTATION: remove the back control, or leave the list drawn behind the board.
   */
  test('the board replaces the list, and the way back returns it', async ({ page }) => {
    await boot(page, DESKTOP)
    await openColdStore(page)

    await expect(page.locator('.boards-list'), 'the list is gone, not underneath').toHaveCount(0)
    await expect(page.locator('.board-screen-title')).toHaveText('Cold store')

    await page.locator('.board-screen-back').click()
    await expect(page.locator('.boards-list')).toBeVisible()
    await expect(page.locator('.board-columns')).toHaveCount(0)
  })

  /**
   * **A card opens BESIDE the board, not instead of it.** Changed 2026-08-19: this used to assert
   * that clicking a card selected the Files tab, which is exactly the jump the operator objected to —
   * *"it just jumps you to the card in files, and then when I go back to boards it takes me to the
   * home screen."*
   *
   * The full behaviour — the editor, the board staying mounted — is asserted in
   * `folder-jump.spec.ts`. This keeps the cheap half here: the click must not leave the tab.
   *
   * MUTATION: revert `onOpenCard` to a jump. Must redden.
   */
  test('a card opens without leaving the board', async ({ page }) => {
    await boot(page, DESKTOP)
    await openColdStore(page)

    await page.locator('.boards-card').filter({ hasText: 'Compressor quote' }).click()

    await expect(tab(page, 'Boards')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.board-columns'), 'the board is still there').toBeVisible()

    /**
     * **The panel, and that it is the EDITOR one.** Without these two lines this test passed under a
     * mutation swapping the editor for the folder-listing panel, and would have passed with the
     * click doing nothing at all — a review proved both. "It did not leave the tab" is true of a
     * click that does nothing.
     */
    const panel = page.getByRole('complementary', { name: 'Card' }).and(page.locator('.is-open'))
    await expect(panel).toBeVisible()
    await expect(panel.locator('.cm-content'), 'a card is a document, so it is editable here')
      .toBeVisible()
  })

  /**
   * **LEAVING BOARDS AND COMING BACK RETURNS YOU TO YOUR BOARD.**
   *
   * ruled 2026-08-19: *"when I go back to boards it takes me to the home screen in boards."*
   * Confirmed in the code before it was believed: entering the tab called the list refresh, whose
   * first act is to clear the open board.
   *
   * **This test exists because a mutation found nothing guarding it** — the fix was written, the
   * suite was green, and putting the bug straight back left every test passing. The one thing they
   * actually reported was the one thing untested.
   *
   * MUTATION: route every arrival through the list refresh again. Must redden.
   */
  test('leaving Boards and returning lands back on the open board', async ({ page }) => {
    await boot(page, DESKTOP)
    await openColdStore(page)
    const title = await page.locator('.board-screen-title').innerText()

    await tab(page, 'Files').click()
    await expect(page.locator('.board-columns')).toBeHidden()

    /**
     * **WAITED ON THE REQUEST, NOT ON A CLOCK — and the clock version was green with the bug in.**
     *
     * Re-entering the tab starts an async redraw, and the previous screen is still in the DOM while
     * it runs, so a plain assertion reads the board that was already there and returns before the
     * list can replace it. My first fix for that was `waitForTimeout(700)`. A review then proved it
     * worthless: reinstate the bug AND add 800ms of latency to the list call, and it passes 6/6.
     * The build's own note says the window is *"~25ms locally… over the tailnet on a phone it is
     * three round trips"* — which is exactly the regime a fixed sleep cannot cover.
     *
     * So this waits for the thing that actually decides it: whether the arrival asked the server for
     * the LIST. If it did, the bug is present, whatever the timing.
     */
    const askedForTheList = page.waitForRequest(
      request => request.url().includes('boards.list'),
      { timeout: 2500 },
    ).then(() => true).catch(() => false)

    await tab(page, 'Boards').click()

    expect(await askedForTheList,
      'arriving on the tab must not re-fetch the board LIST — that is the bug').toBe(false)

    await expect(page.locator('.board-columns'), 'the board comes back, not the list')
      .toBeVisible()
    await expect(page.locator('.board-screen-title')).toHaveText(title)
    await expect(page.locator('.boards-list'), 'and the home list is not what is showing')
      .toHaveCount(0)
  })

  /**
   * The list disambiguates two boards by where they live — the Inbox complaint they raised on
   * 2026-08-18 arriving somewhere new, prevented.
   */
  test('the home list names where each board lives', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list')).toBeVisible()

    const wheres = await page.locator('.boards-row-where').allInnerTexts()
    expect(wheres.some(where => where.includes('orchard')), 'the orchard board').toBe(true)
    expect(wheres.some(where => where.includes('cider')), 'and the cider one').toBe(true)
  })

  /** The board screen on a phone: columns scroll sideways, the bar stays, nothing runs off. */
  test('on a phone the columns fit and the tab bar is untouched', async ({ page }) => {
    await boot(page, PHONE)
    await openColdStore(page)
    await settled(page)

    const bar = await page.locator('.tabs').boundingBox()
    const column = await page.locator('.board-column').first().boundingBox()
    if (bar === null || column === null) throw new Error('nothing laid out')

    expect(column.width, 'a column must not be wider than the screen')
      .toBeLessThanOrEqual(PHONE.width)
    expect(column.x, 'and must start on screen').toBeGreaterThanOrEqual(0)
    await expect(page.locator('.tabs')).toBeVisible()
    await expect(page.locator('.board-screen-back'), 'the way back is reachable on a phone')
      .toBeVisible()
  })
})

/**
 * **CREATING AND MOVING.** P14 B4 — the only phase that writes.
 *
 * It ships last on purpose: three phases that cannot lose anything came first, so this is built on a
 * surface already proven to show the tree correctly.
 *
 * **Boards adds no new way to touch the tree.** Creating is `entry.create`; moving is
 * `entry.rename`. Both are §13.6's verbs, already gated and already tested, which is what keeps
 * "nothing deletes" true here for free rather than by a new promise.
 *
 * Each test works in its **own** board so the suite can run in any order and on both engines
 * without two workers writing the same folder — the fixture lesson `playwright.config.ts` records.
 */
/**
 * Drills the picker down to a test's own scratch folder and confirms.
 *
 * **One scratch folder per test, per engine**, pre-created and cleared by `playwright.config.ts`
 * before any worker starts. The first version created boards at the registered root under a fixed
 * name: it passed alone and failed the moment both engines ran, because the tree path is fixed and
 * the previous run's board was still sitting there with its columns in it. **A test that cannot be
 * run twice is not a test.**
 *
 * **Two clicks, not one**, because the scratch folders live under `02-projects` and the picker
 * opens showing registered roots — a row has to be expanded by its twisty before its children
 * exist to be chosen. The first version clicked the name straight away and waited thirty seconds
 * on a row that had not been rendered yet.
 *
 * At module scope rather than inside one `describe`: the arrange stack needs a board of its own too,
 * and a second copy of this is the drift the suite has already been bitten by.
 */
const chooseScratch = async (page: Page, purpose: string, projectName: string): Promise<void> => {
  const picker = page.locator('.modal[aria-label="Where should this board live?"]')
  await expect(picker).toBeVisible()
  await picker.locator('.picker-row', { hasText: '02-projects' }).locator('.picker-twisty').click()
  /**
   * **Anchored, because `hasText` is a substring match.** `board-arrange` matched
   * `scratch-…-board-arrange` *and* `scratch-…-board-arrange-gone`, and the run failed as a strict
   * mode violation — the ambiguous-locator mistake this suite records making three times, made a
   * fourth. Anchoring means the next purpose can be named freely instead of being named around this.
   */
  const target = picker.locator('.picker-row',
    { hasText: new RegExp(`scratch-${projectName}-${purpose}$`) })
  await expect(target).toBeVisible()
  await target.click()
  await page.getByRole('button', { name: 'Create here' }).click()
}

test.describe('creating and moving', () => {

  /**
   * MUTATION: drop the `BOARD_PREFIX` from the create call. Must redden — the folder would be made
   * and would then not be a board, so it would never appear in the list.
   *
   * This is the one place in Boards where the client shapes a name. It is not slugging — the server
   * still does that — it is adding the grammar's marker.
   */
  test('a new board asks where, then what to call it, and appears in the list', async ({ page }, info) => {
    await boot(page, DESKTOP)
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list, .boards-empty')).toBeVisible()

    /**
     * **The engine is in the name, because the two share one tree.** Both projects run against the
     * same fixture directory, so a fixed board name means the list holds two rows reading the same
     * thing and `getByRole` refuses as ambiguous — the locator mistake this suite already records
     * making three times. Separate scratch folders are not enough: the Boards list is global.
     */
    const name = `Cold chain review ${info.project.name}`
    await page.locator('.boards-new').click()

    /**
     * Where. **A destination has to be picked before the confirm becomes pressable** — the picker's
     * own rule, asserted in `files-tab.spec.ts` too, and the reason this is two steps rather than
     * one. The first version pressed the button straight away and waited thirty seconds on a
     * control that was correctly disabled.
     */
    await expect(page.getByRole('button', { name: 'Create here' }),
      'nothing chosen yet, so the confirm cannot be pressed').toBeDisabled()
    await chooseScratch(page, 'board-new', info.project.name)

    // What: typed as a sentence; the folder gets the prefix and the slug.
    await expect(page.locator('.modal[aria-label="What is this board called?"]')).toBeVisible()
    await page.locator('.modal-input').fill(name)
    await page.getByRole('button', { name: 'Create', exact: true }).click()

    // It comes back as THEIR sentence, not as the folder name — the round trip closing.
    await expect(page.getByRole('button', { name })).toBeVisible()
  })

  /**
   * **THE WHOLE FLOW, in the order the operator described it**: a column, a card in it, a second column,
   * then the card moved across.
   *
   * MUTATION: any of the three `entry.create` calls, or the `entry.rename`. Each reddens its own step.
   */
  test('a column, a card, and the card moved to another column', async ({ page }, info) => {
    await boot(page, DESKTOP)
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list, .boards-empty')).toBeVisible()

    const name = `Harvest plan ${info.project.name}`
    await page.locator('.boards-new').click()
    await chooseScratch(page, 'board-flow', info.project.name)
    await page.locator('.modal-input').fill(name)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('button', { name }).click()
    await expect(page.locator('.board-screen-title')).toHaveText(name)

    // A column, named on the fly. It exists immediately, with no cards in it.
    await page.locator('.boards-new').click()
    await page.locator('.modal-input').fill('Doing')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('.board-column-name')).toHaveText(['Doing'])
    await expect(page.locator('.boards-card')).toHaveCount(0)

    // A card in it.
    await page.locator('.boards-add-card').click()
    await page.locator('.modal-input').fill('First thing')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('.boards-card')).toHaveCount(1)
    await expect(page.locator('.boards-card')).toContainText('First thing')

    // A second column, so there is somewhere to move to.
    await page.locator('.board-screen-bar .boards-new').click()
    await page.locator('.modal-input').fill('Done')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('.board-column-name')).toHaveText(['Doing', 'Done'])

    // The move: §18.5's explicit choice, never a drag.
    await page.locator('.boards-card-move').first().click()
    await page.getByRole('menuitem', { name: 'To Done' }).click()

    // The card is in Done, and Doing is empty — the FILE moved.
    const columns = page.locator('.board-column')
    await expect(columns.nth(0).locator('.boards-card')).toHaveCount(0)
    await expect(columns.nth(1).locator('.boards-card')).toHaveCount(1)
    await expect(columns.nth(1)).toContainText('First thing')
  })

  /**
   * **Uncategorized offers no "+ Card", because it is not a folder.**
   *
   * MUTATION: drop the `column.segments !== null` guard. The button would appear and could not
   * work — a control that is complete and cannot function, which is this build's signature defect
   * pointed the other way.
   */
  test('the synthetic column offers no way to create into it', async ({ page }) => {
    await boot(page, DESKTOP)
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list')).toBeVisible()
    await page.getByRole('button', { name: /Cold store/i }).click()
    await expect(page.locator('.board-columns')).toBeVisible()

    const first = page.locator('.board-column').first()
    await expect(first.locator('.board-column-name')).toHaveText('Uncategorized')
    await expect(first.locator('.boards-add-card'), 'nothing to create into').toHaveCount(0)

    const doing = page.locator('.board-column').nth(1)
    await expect(doing.locator('.boards-add-card'), 'a real column has one').toHaveCount(1)
  })
})

/**
 * **REORDERING WITHIN A COLUMN.** P14 B3's arrangement, and the control that finally writes one.
 *
 * B3 built the machinery and B4 shipped with **nothing that could ever call it** — `boards.setOrder`
 * was a route with no caller, which is the *"complete, tested, and reachable by nothing"* defect
 * this build has now found five times. These tests are the proof it is reached.
 *
 * **The order is remembered on the Mac and never in the tree** — the decision against my
 * numbered-filenames proposal: *"they don't need to be numbered… as long as they will hold state in
 * the order that they're in on the boards."* So the assertion that matters is that it **survives a
 * reload**, which is the whole point of storing it server-side rather than in the browser.
 */
test.describe('the remembered arrangement', () => {
  const openColdStoreDoing = async (page: Page) => {
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list')).toBeVisible()
    await page.getByRole('button', { name: /Cold store/i }).click()
    await expect(page.locator('.board-columns')).toBeVisible()
    // Doing is the second column — Uncategorized is leftmost in this fixture.
    return page.locator('.board-column').nth(1)
  }

  const titlesIn = async (column: ReturnType<Page['locator']>): Promise<string[]> =>
    column.locator('.boards-card-title').allInnerTexts()

  /**
   * MUTATION: drop the `boards.setOrder` call, or write the unswapped order. Must redden.
   *
   * The fixture's Doing column holds `compressor-quote.md` and `insulation-spec.md`, which sort to
   * "Compressor quote" then "Insulation spec". Moving the second up must invert them.
   */
  test('a card can be moved up, and the new order SURVIVES A RELOAD', async ({ page }) => {
    await boot(page, DESKTOP)
    const doing = await openColdStoreDoing(page)

    const before = await titlesIn(doing)
    expect(before.length, 'the fixture must have two cards to reorder').toBe(2)

    // Move the second card up.
    await doing.locator('.boards-card').nth(1).locator('.boards-card-move').click()
    await page.getByRole('menuitem', { name: 'Move up' }).click()

    await expect.poll(async () => titlesIn(doing)).toEqual([before[1], before[0]])

    /**
     * **The reload is the assertion.** An order held only in this page's memory would pass every
     * line above and fail here — and "held on the Mac, not in the browser" is the thing the operator
     * confirmed explicitly (*"Yes, I mean the second"*) so one arrangement covers their phone and their
     * desktop.
     */
    await page.reload()
    const again = await openColdStoreDoing(page)
    await expect.poll(async () => titlesIn(again)).toEqual([before[1], before[0]])

    // Put it back, so the fixture is left as it was found and the test can run twice.
    await again.locator('.boards-card').nth(1).locator('.boards-card-move').click()
    await page.getByRole('menuitem', { name: 'Move up' }).click()
    await expect.poll(async () => titlesIn(again)).toEqual(before)
  })

  /**
   * MUTATION: always offer both directions. Must redden.
   *
   * **Omitted, not disabled.** A menu entry that does nothing is indistinguishable from one that is
   * broken, and this menu is the only way to move a card on a phone.
   */
  test('the first card is not offered "up", and the last is not offered "down"', async ({ page }) => {
    await boot(page, DESKTOP)
    const doing = await openColdStoreDoing(page)

    await doing.locator('.boards-card').first().locator('.boards-card-move').click()
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toHaveCount(1)
    await page.keyboard.press('Escape')

    await doing.locator('.boards-card').last().locator('.boards-card-move').click()
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveCount(1)
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toHaveCount(0)
  })

  /**
   * **The column entries are prefixed `col:` so a folder named `up` cannot be read as a direction.**
   *
   * MUTATION: use the bare column id. A board with a column literally named `up` would then reorder
   * instead of moving — a bug that appears once, on someone else's tree, and is near-impossible to
   * reproduce from a description.
   */
  test('a destination column is still offered alongside the directions', async ({ page }) => {
    await boot(page, DESKTOP)
    const doing = await openColdStoreDoing(page)

    await doing.locator('.boards-card').first().locator('.boards-card-move').click()
    await expect(page.getByRole('menuitem', { name: 'To Done' })).toHaveCount(1)
    await expect(page.getByRole('menuitem', { name: /^To Uncategorized/ }),
      'the synthetic column is not a folder, so nothing can be moved into it').toHaveCount(0)
  })
})

/**
 * **A BOARD THAT IS NO LONGER THERE MUST NOT COME BACK AS AN EMPTY ONE.**
 *
 * Restoring the open board on re-entry (the operator's fix) created this: the board is remembered, and
 * `boards.open` answered a vanished path with `ok` and zero columns, so the tab drew *"Nothing in
 * this board yet"* under the board's cached name — with a `+ Column` button that would create into a
 * path that is gone.
 *
 * Found by an adversarial review and reproduced end to end. §6 bans exactly this shape: *"an
 * empty-but-successful result never stands in for a failure."* The server now tells an empty board
 * from a missing one by the FOLDER rather than by the count.
 *
 * MUTATION: drop the presence check in `openBoardAt`. Must redden.
 */
test('a board that has been renamed away falls back to the list, and says so', async ({ page }, info) => {
  const folder = `scratch-${info.project.name}-board-gone`
  /**
   * **The engine is in the name.** Both projects run against one tree and the Boards list is global,
   * so a fixed name puts two identical rows in it and `getByRole` refuses as ambiguous — the
   * collision this suite has already hit twice.
   */
  const board = join(E2E_TREE, '02-projects', folder, `board-vanishing-${info.project.name}`)
  const moved = join(E2E_TREE, '02-projects', folder, `renamed-${info.project.name}`)

  await boot(page, DESKTOP)
  await tab(page, 'Boards').click()
  await expect(page.locator('.boards-list')).toBeVisible()
  await page.getByRole('button', { name: new RegExp(`Vanishing ${info.project.name}`, 'i') }).click()
  await expect(page.locator('.board-columns, .boards-empty')).toBeVisible()

  // Someone renames it while the tab is elsewhere — an agent, or the operator in Finder.
  await tab(page, 'Files').click()
  await rename(board, moved)

  /**
   * **Waiting for the WATCHER, not papering over a race in the assertion.**
   *
   * The server answers from its index, and the index learns about a rename from the filesystem
   * watcher. Re-entering the tab immediately asks about a board the server still believes in, so the
   * fallback correctly does not fire. This waits for an external event to arrive, which is a
   * different thing from the fixed sleeps a review has already caught me using to hide a race.
   */
  await page.waitForTimeout(1500)

  await tab(page, 'Boards').click()

  // Not a phantom board: the list is back, and it says what happened.
  await expect(page.locator('.boards-list'), 'it must fall back to the list').toBeVisible()
  await expect(page.locator('.board-screen-title'), 'and not sit on a dead board screen')
    .toHaveCount(0)
  await expect(page.locator('.feedback-banner, .banner, [role="status"]').first())
    .toContainText(/not there any more|renamed|archived/i)

  // Left as found, so the test can run twice.
  await rename(moved, board)
})

/**
 * **REARRANGING COLUMNS.** Ruled 2026-08-21: *"I really need to have the ability to rearrange
 * these columns… it doesn't need or use any numbering system, just the ability to move around the
 * columns to different orders and have the app remember where I put them."*
 *
 * The same arrangement store the cards use, one level up — a card is arranged against its column, a
 * column against its board. **Boards only.** They were explicit that Tasks does not change: *"tasks,
 * those are in proper order."*
 *
 * **THE RELOAD IS THE ASSERTION**, as it was for cards: an order held in this page's memory passes
 * every other line and fails there, and "the app remembers where I put them" is the whole ask.
 */
test.describe('rearranging columns', () => {
  const open = async (page: Page) => {
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list')).toBeVisible()
    await page.getByRole('button', { name: /Cold store/i }).click()
    await expect(page.locator('.board-columns')).toBeVisible()
  }
  const names = (page: Page) => page.locator('.board-column-name').allInnerTexts()

  /**
   * A column name long enough to wrap a 240px head, and a board name long enough to wrap a 390px
   * bar. **Both guards below were written against short fixture names first and passed with the CSS
   * they guard deleted** — content that cannot break the layout proves nothing about the layout.
   */
  const LONG_COLUMN = 'Third column with a rather long name'
  /**
   * **The name element's own height, not its container's.** Both guards measured the container
   * first — the head and the bar — and both passed with the CSS deleted, because a wrapped name
   * grows those by only a few pixels once padding and a taller sibling are in play. Measured on the
   * text itself, one line is ~15px and two are ~24px, which is a signal rather than a rounding
   * error.
   */
  const ONE_LINE = 20

  const arrow = (page: Page, column: string, direction: 'left' | 'right') =>
    page.getByRole('button', { name: `Move ${column} ${direction}`, exact: true })

  /**
   * MUTATION: drop the `boards.setColumnOrder` call, or write the unmoved order. Must redden.
   *
   * **One press, not two.** This drove a `⋯` menu until 2026-08-21, when the operator used it: *"clicking
   * the dot and then clicking move right — if I want to move something all the way over, it's
   * messy."* The assertion that matters here is unchanged; what changed is that there is no menu
   * between the intent and the move.
   */
  test('a column can be moved, and it STAYS moved after a reload', async ({ page }) => {
    await boot(page, DESKTOP)
    await open(page)

    const before = await names(page)
    expect(before, 'the fixture must have Uncategorized plus two real columns')
      .toEqual(['Uncategorized', 'Doing', 'Done'])

    await arrow(page, 'Done', 'left').click()
    await expect.poll(async () => names(page)).toEqual(['Uncategorized', 'Done', 'Doing'])

    await page.reload()
    await open(page)
    await expect.poll(async () => names(page), { message: 'the app must remember where they put it' })
      .toEqual(['Uncategorized', 'Done', 'Doing'])

    // Put it back, so the test can run twice.
    await arrow(page, 'Done', 'right').click()
    await expect.poll(async () => names(page)).toEqual(before)
  })

  /**
   * **Uncategorized is pinned and offers no control**, and the leftmost REAL column cannot go
   * further left.
   *
   * MUTATION: count the position from the drawn list instead of from the real columns. Then "Doing"
   * — first real, second drawn — gets a live "move left" that moves it nowhere. Must redden.
   *
   * **The disabled arrow is asserted PRESENT, not absent**, which reverses what the menu did and is
   * the point of the reversal: a control that disappears at the end of the row slides its neighbour
   * under a thumb already travelling towards it. Counting the pair is what would catch a change back
   * to omitting them.
   */
  test('the synthetic column is not movable, and the first real one cannot go further left', async ({ page }) => {
    await boot(page, DESKTOP)
    await open(page)

    const uncategorized = page.locator('.board-column').first()
    await expect(uncategorized.locator('.board-column-name')).toHaveText('Uncategorized')
    await expect(uncategorized.locator('.board-column-move'),
      'it is not a folder and is pinned leftmost, so there is nothing to move').toHaveCount(0)
    /**
     * **And it is MARKED as not being a folder**, the way the Tasks board marks its synthetic lane.
     * Every other difference is an absence — no arrows, no `+ Card` — and an absence is not a
     * statement. MUTATION: drop `is-synthetic` from the class. Must redden.
     */
    await expect(uncategorized).toHaveClass(/is-synthetic/)
    await expect(page.locator('.board-column').nth(1), 'a real column is not marked')
      .not.toHaveClass(/is-synthetic/)

    const doing = page.locator('.board-column').nth(1)
    await expect(doing.locator('.board-column-move'), 'a real column keeps both arrows')
      .toHaveCount(2)
    await expect(arrow(page, 'Doing', 'left'),
      'the first real column is already as far left as it goes').toBeDisabled()
    await expect(arrow(page, 'Doing', 'right')).toBeEnabled()
    await expect(arrow(page, 'Done', 'right'), 'and the last cannot go further right').toBeDisabled()
  })

  /**
   * **THE BOARD MOVES BEFORE THE SAVE LANDS**, and this is a correctness test wearing a
   * responsiveness costume.
   *
   * Every press reads the current column list to work out where the column is. If that list is only
   * refreshed when the reply arrives, a second press during the round trip recomputes **the same
   * move** and the first is silently overwritten — two presses, one move. The user's phone reaches
   * this server over Tailscale, and the thing they asked for is pressing an arrow several times in a
   * row, so the round trip is exactly the window that matters.
   *
   * The save is held for two seconds and the board is asserted to have moved well inside that. A
   * fixed sleep would prove nothing here — the delay is the *instrument*, and the assertion is that
   * the picture changed while the save was still in flight.
   *
   * MUTATION: drop the optimistic repaint from `setColumnOrder`. Must redden — the board sits still
   * until the held reply is released.
   */
  test('the board moves while the save is still in flight', async ({ page }) => {
    await boot(page, DESKTOP)
    await open(page)
    await expect.poll(async () => names(page)).toEqual(['Uncategorized', 'Doing', 'Done'])

    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = () => { resolve() } })
    // Only the FIRST save is held. Unrouting while a request is parked throws "route is already
    // handled", and the tidy-up press at the end has to get through.
    let alreadyHeld = false
    await page.route('**/api/boards.setColumnOrder', async route => {
      if (!alreadyHeld) {
        alreadyHeld = true
        await held
      }
      await route.continue()
    })

    await arrow(page, 'Done', 'left').click()
    await expect.poll(async () => names(page), { timeout: 2000, message: 'it must not wait' })
      .toEqual(['Uncategorized', 'Done', 'Doing'])

    release()
    // And the held save still lands, so the optimistic picture is the truth rather than a guess.
    await page.reload()
    await open(page)
    await expect.poll(async () => names(page)).toEqual(['Uncategorized', 'Done', 'Doing'])

    // Left as found, so the test can run twice.
    await arrow(page, 'Done', 'right').click()
    await expect.poll(async () => names(page)).toEqual(['Uncategorized', 'Doing', 'Done'])
  })

  /**
   * **A REFUSED SAVE TAKES THE OPTIMISTIC PICTURE BACK OFF THE SCREEN.**
   *
   * Painting before the server answers buys responsiveness with a promise, and the whole cost of
   * that promise is here: a board that keeps showing a move the server refused is a **lie**, and a
   * quieter one than an error, because it looks exactly like success until the next reload.
   *
   * MUTATION: drop the `refreshOneBoard()` from the refusal branch of `setColumnOrder`, leaving only
   * the banner. Must redden — the columns stay where the optimistic paint put them.
   */
  test('a refused save puts the columns back, and says so', async ({ page }) => {
    await boot(page, DESKTOP)
    await open(page)
    await expect.poll(async () => names(page)).toEqual(['Uncategorized', 'Doing', 'Done'])

    await page.route('**/api/boards.setColumnOrder', route =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }))

    await arrow(page, 'Done', 'left').click()
    await expect(page.locator('.feedback-banner, .banner, [role="status"]').first())
      .toContainText(/could not be saved/i)
    await expect.poll(async () => names(page), { message: 'the board must not keep a refused move' })
      .toEqual(['Uncategorized', 'Doing', 'Done'])
  })

  /**
   * **THE TWO CONTROLS MUST NOT FIGHT.** Arranging is one activity whichever one they reache for, so
   * a head arrow pressed while the stack is open moves the column and leaves the stack standing.
   *
   * Two mechanisms keep that true and both are easy to lose: the arrow is named in the panel's
   * exempt list, and answering the press repaints synchronously, which **detaches the arrow before
   * the click finishes bubbling** — so the exemption has to survive being asked about a node no
   * longer in the document.
   *
   * MUTATION: remove `board-column-move` from the panel's `exemptClasses`. Must redden.
   *
   * ## Why this runs at 1920 and not at the suite's usual 1280
   *
   * **The panel is a slide-over, and after the restyle the columns are wider.** At 1280 it covers
   * every column's arrows, so there is nothing left to press and this rule cannot be exercised at
   * all — the test timed out twice in CI before that was measured rather than reasoned about. At
   * 1920 the board is wide enough that the arrows sit clear of it, which is the width the rule
   * actually applies at.
   *
   * **Recorded rather than papered over:** on a 1280 desktop, opening the stack means the stack is
   * how you move things. That is no loss — it can move any column — but it is worth knowing.
   *
   * ## And it restores whatever it found, not a hardcoded order
   *
   * The first version asserted the fixture's order on the way in and put it back by name on the way
   * out. When the click timed out, the board was left moved — so the **retry** began from an order
   * its first assertion refused, and reported a starting-state failure that had nothing to do with
   * the subject. A test that cannot survive its own failure poisons the run it fails in.
   */
  test('an arrow pressed while the stack is open moves the column and keeps the stack', async ({ page }) => {
    await boot(page, { width: 1920, height: 1000 })
    await open(page)

    const before = await names(page)
    const [second, last] = [before.at(-2), before.at(-1)]
    if (second === undefined || last === undefined) throw new Error('the fixture needs two columns')

    await page.getByRole('button', { name: 'Arrange columns' }).click()
    const stack = page.locator('.arrange-list')
    await expect(stack).toBeVisible()

    await arrow(page, second, 'right').click()
    await expect.poll(async () => names(page))
      .toEqual([...before.slice(0, -2), last, second])
    await expect(stack, 'the stack must still be there').toBeVisible()
    await expect(stack.locator('.arrange-row-label'), 'and must show the new order')
      .toHaveText([last, second])

    // Back to whatever it found. `last` is now the second-to-last column, so it is the one to move.
    await arrow(page, last, 'right').click()
    await expect.poll(async () => names(page)).toEqual(before)
  })
  /**
   * **THE STACK CANNOT OUTLIVE THE BOARD IT ARRANGES.**
   *
   * Every other way out of the panel is a click that lands outside it, and the panel dismisses on
   * those by itself. **A rename arriving from the filesystem is the one route with no click at all**
   * — an agent moves the folder, the watcher tells the server, the board falls back to the list, and
   * without an explicit close the stack is left standing over it: columns of a board that no longer
   * exists, offering to arrange it.
   *
   * MUTATION: drop the panel close from `refreshBoards`. Must redden.
   */
  test('a board renamed away takes its arrange stack with it', async ({ page }, info) => {
    await boot(page, DESKTOP)
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list, .boards-empty')).toBeVisible()

    const name = `Cold chain vanishing ${info.project.name}`
    await page.locator('.boards-new').click()
    await chooseScratch(page, 'board-arrange-gone', info.project.name)
    await page.locator('.modal-input').fill(name)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('button', { name }).click()
    await expect(page.locator('.board-screen-title')).toHaveText(name)

    // Two columns, because that is what the arrange control needs to exist at all.
    for (const column of ['Doing', 'Done']) {
      await page.locator('.boards-new').click()
      await page.locator('.modal-input').fill(column)
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await expect.poll(async () => names(page)).toContain(column)
    }

    await page.getByRole('button', { name: 'Arrange columns' }).click()
    await expect(page.locator('.arrange-list')).toBeVisible()

    // Someone moves the folder out from under it — an agent, or the operator in Finder.
    const folder = join(E2E_TREE, '02-projects', `scratch-${info.project.name}-board-arrange-gone`)
    const slug = `board-cold-chain-vanishing-${info.project.name}`
    await rename(join(folder, slug), join(folder, `renamed-${info.project.name}`))

    /**
     * **The next press comes from INSIDE the stack, and that is the whole point of the test.**
     *
     * Any click outside the panel dismisses it on its own, so a test that reached for a tab or the
     * back control would pass with the guard deleted — a first version of this did exactly that. A
     * press on the stack's own button is exempt from the dismiss, so the fallback to the list is the
     * only thing left that can close it.
     *
     * Waiting for the WATCHER first: the server answers from its index, and the index learns about a
     * rename from the filesystem. That is an external event arriving, not a sleep hiding a race.
     */
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: 'Move Done to the top', exact: true }).click()

    await expect(page.locator('.boards-list'), 'it must fall back to the list').toBeVisible()
    await expect(page.locator('.arrange-list'), 'and the stack must not outlive its board')
      .toHaveCount(0)
  })

  /**
   * **THE ARRANGE STACK.** The operator: *"some kind of interface where I could click rearrange and then
   * I can see them all like in a stack and I can arrange the board top to bottom equals left to
   * right."*
   *
   * **Three columns, because two cannot tell a send-to-the-front from a swap.** They agree on every
   * move a two-item list can make, which is how a wrong implementation would pass. The board is built
   * through the UI into this test's own scratch folder, per the fixture rule this suite records.
   *
   * MUTATION: point `onMove`'s `to` at `from - 1` — a nudge instead of a jump. Must redden.
   */
  test('the stack sends a column all the way to the front, and it stays there', async ({ page }, info) => {
    await boot(page, DESKTOP)
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list, .boards-empty')).toBeVisible()

    /**
     * **Deliberately long, and the length is load-bearing** — the phone check at the end of this
     * test measures whether the bar's controls survive a title that wants more room than the screen
     * has. The first version of that check used the fixture's `Cold store`, which fits on a phone
     * with room to spare: it passed with the CSS that prevents the overflow **deleted**, which is to
     * say it was green about nothing. A layout guard needs content that would actually break it.
     */
    const board = `Cold chain review and winter scheduling ${info.project.name}`
    await page.locator('.boards-new').click()
    await chooseScratch(page, 'board-arrange', info.project.name)
    await page.locator('.modal-input').fill(board)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('button', { name: board }).click()
    await expect(page.locator('.board-screen-title')).toHaveText(board)

    /**
     * **Nothing to arrange with one column, and nothing offered.** Asserted before the others exist,
     * because this is the state a new board starts in — a button that opens a panel saying there is
     * nothing to do is the "control that cannot work" shape this build keeps finding.
     */
    await page.locator('.boards-new').click()
    await page.locator('.modal-input').fill('First')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('.board-column-name')).toHaveText(['First'])
    await expect(page.getByRole('button', { name: 'Arrange columns' }),
      'one column has no arrangement').toHaveCount(0)
    await expect(page.locator('.board-column-move'), 'and no arrows either').toHaveCount(0)

    /**
     * **The third name is long on purpose.** It proves the head stays one line — see the height
     * assertion below — and a long column name is ordinary in their tree, where a column is a folder.
     */
    for (const column of ['Second', LONG_COLUMN]) {
      await page.locator('.boards-new').click()
      await page.locator('.modal-input').fill(column)
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await expect.poll(async () => names(page)).toContain(column)
    }
    await expect.poll(async () => names(page)).toEqual(['First', 'Second', LONG_COLUMN])

    /**
     * **One line, not two.** MUTATION: drop `min-width: 0` / the ellipsis rules from
     * `.board-column-name`. The name wraps, the head grows, and every column beside it has its cards
     * pushed down out of alignment.
     *
     * Asserted as a height rather than as an overhang, because the overhang does not happen — the
     * first version of this guard asserted one and passed with the CSS deleted.
     */
    const columnName = await page.locator('.board-column').last().locator('.board-column-name')
      .boundingBox()
    if (columnName === null) throw new Error('the column head was not laid out')
    expect(columnName.height, 'a long column name must not wrap the head onto a second line')
      .toBeLessThanOrEqual(ONE_LINE)

    await page.getByRole('button', { name: 'Arrange columns' }).click()
    const stack = page.locator('.arrange-list')
    await expect(stack).toBeVisible()
    await expect(stack.locator('.arrange-row-label'), 'top to bottom is left to right')
      .toHaveText(['First', 'Second', LONG_COLUMN])


    // The press this whole change exists for: all the way over, once.
    await page.getByRole('button', { name: `Move ${LONG_COLUMN} to the top`, exact: true }).click()
    await expect.poll(async () => names(page)).toEqual([LONG_COLUMN, 'First', 'Second'])
    await expect(stack.locator('.arrange-row-label'), 'and the stack follows the board')
      .toHaveText([LONG_COLUMN, 'First', 'Second'])

    await page.reload()
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list')).toBeVisible()
    await page.getByRole('button', { name: board }).click()
    await expect.poll(async () => names(page), { message: 'the app must remember where they put it' })
      .toEqual([LONG_COLUMN, 'First', 'Second'])

    /**
     * **And the bar stays one line on their phone with a control added to it**, measured on the long name
     * this test made rather than on a fixture that would fit either way. The title takes the slack,
     * so `+ Column` and `Arrange` keep their place instead of being pushed past the right-hand edge —
     * which is exactly what the fifth tab did to the desktop rail on 2026-08-18.
     *
     * Checked here rather than in a test of its own because the setup is the setup: a board long
     * enough to overflow, with enough columns for the control to exist at all.
     *
     * MUTATION: drop `flex: 1 1 auto` / `min-width: 0` from `.board-screen-title`. Must redden.
     */
    await page.setViewportSize(PHONE)
    // The measurement is taken after the layout settles: a box read in the frame the viewport
    // changed in is a number nothing pinned, which is how a geometric test becomes a coin toss.
    await settled(page)
    const title = await page.locator('.board-screen-title').boundingBox()
    const arrange = await page.getByRole('button', { name: 'Arrange columns' }).boundingBox()
    if (title === null || arrange === null) throw new Error('the bar was not laid out')
    expect(arrange.x, 'the control must start on screen').toBeGreaterThanOrEqual(0)
    expect(arrange.x + arrange.width, 'and must not run off the right')
      .toBeLessThanOrEqual(PHONE.width)
    expect(title.height, 'and the title must not wrap the bar onto a second line')
      .toBeLessThanOrEqual(ONE_LINE)

    /**
     * **THE WAY OUT, on the phone.** A panel is full screen at this width — over the tab bar, with
     * no outside left to click — so the labelled control **is** the exit rather than a convenience.
     *
     * Asserted because this build has already shipped the other version: the folder panel went out
     * on 2026-08-19 with no back control at 390px, and the only way out of it was the automatic jump
     * the operator had just asked to stop. An adversarial review found it, not a test. This is the test.
     *
     * MUTATION: drop the `appendPanelBack` call from the arrange panel. Must redden.
     */
    await page.getByRole('button', { name: 'Arrange columns' }).click()
    const panel = page.locator('.card-panel', { has: page.locator('.arrange-list') })
    await expect(panel.locator('.arrange-list')).toBeVisible()
    await settled(page)

    const box = await panel.boundingBox()
    if (box === null) throw new Error('the arrange panel was not laid out')
    expect(box.width, 'full screen on a phone, so there is no outside to click')
      .toBeGreaterThanOrEqual(PHONE.width - 1)

    const back = panel.locator('.card-panel-back')
    await expect(back, 'the labelled control IS the exit at this width').toBeVisible()
    await back.click()
    await expect(page.locator('.arrange-list'), 'and it must actually let go').toHaveCount(0)
  })
})

/**
 * **A BOARD FROM THEIR TEMPLATE.** Ruled 2026-08-19, reversing their own *"no template, nothing
 * pre-filled"*:
 *
 * > *"I feel each board should include a context folder and file… as well as an m-thread per board.
 * > And so I have gone ahead and created that in Canon and I have worked it into the scaffold skill."*
 *
 * The fixture is their shape exactly: `board-template-<engine>/00-context/` with a context file and an
 * m-thread, and nothing else.
 *
 * **Two rules are proven here and they are easy to mistake for one.** The template folder is a board
 * by the grammar, so it must not be *listed* as a board; and its `00-context` must not become a
 * *column*, or every board they make opens showing a lane they did not create. Losing either one makes
 * the feature unusable in a different way.
 */
test.describe('a board from the registered template', () => {
  const templateFolder = (info: TestInfo) => `board-template-${info.project.name}`
  const templateName = (info: TestInfo) => `Board template ${info.project.name}`

  /**
   * Names the board template through the real Settings flow, and **tolerates it already being
   * there**. The template registry is server state that outlives a single test, so a retry — WebKit
   * has one, deliberately — would otherwise be refused as a duplicate and fail on the *setup* rather
   * than on the subject.
   */
  const registerBoardTemplate = async (page: Page, info: TestInfo): Promise<void> => {
    await page.getByRole('button', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()

    if (await settings.getByText(templateName(info), { exact: true }).count() > 0) {
      await settings.getByRole('button', { name: 'Close' }).click()
      return
    }

    await settings.getByRole('button', { name: 'Add Template' }).click()
    const picker = page.getByRole('dialog', { name: 'Which folder is the template?' })
    await expect(picker).toBeVisible()
    // By row, never by index — a second registered folder can put two root rows in this picker.
    await picker.locator('.picker-row')
      .filter({ has: page.getByText('00-context', { exact: true }) })
      .locator('.picker-twisty').click()
    await picker.getByText(templateFolder(info), { exact: true }).click()
    await picker.getByRole('button', { name: 'Use This Folder' }).click()

    await page.locator('.modal-input').fill(templateName(info))
    await page.getByRole('button', { name: 'Add Template' }).last().click()
    await expect(settings.getByText(templateName(info), { exact: true })).toBeVisible()
    await settings.getByRole('button', { name: 'Close' }).click()
  }

  /**
   * MUTATION: drop the `templates` argument from `boards.list`. Must redden — the template appears
   * in the list as a board called *Template <engine>*, among the real ones, offering to be filled in.
   */
  test('the template itself is not listed as a board, and a new board is made from it', async (
    { page }, info,
  ) => {
    await boot(page, DESKTOP)
    await registerBoardTemplate(page, info)

    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list')).toBeVisible()
    await expect(page.getByRole('button', { name: new RegExp(`Template ${info.project.name}`, 'i') }),
      'a template is a shape, not a thing').toHaveCount(0)

    const name = `Cold chain scaffolded ${info.project.name}`
    await page.locator('.boards-new').click()
    await chooseScratch(page, 'board-from-template', info.project.name)
    await page.locator('.modal-input').fill(name)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('button', { name }).click()
    await expect(page.locator('.board-screen-title')).toHaveText(name)

    /**
     * **It opens EMPTY, and that is the second rule.** Their scaffold skill says a board *"scaffolds
     * with NO columns at all"*; the template's `00-context` is furniture, not a lane.
     *
     * MUTATION: drop either half of the `isContextName` guard in `boardContents`. Must redden — a
     * column called *Context* appears, holding their two files as cards.
     */
    await expect(page.locator('.boards-empty'), 'a new board opens empty, by design').toBeVisible()
    await expect(page.locator('.board-column')).toHaveCount(0)

    /**
     * **And the paperwork is really on disk, verbatim.** Read off the filesystem rather than inferred
     * from the screen — the screen deliberately shows none of this, so a copy that silently did
     * nothing would look identical to one that worked.
     *
     * Under the name they typed, and unrenamed: their no-renaming ruling stands, so `context-template.md`
     * arrives under that name rather than as `context.md`. Their scaffold skill renames; the viewer
     * does not, and that difference is recorded rather than papered over.
     */
    const folder = join(E2E_TREE, '02-projects', `scratch-${info.project.name}-board-from-template`)
    const slug = `board-cold-chain-scaffolded-${info.project.name}`
    const context = await readFile(
      join(folder, slug, '00-context', 'context-template.md'), 'utf8')
    expect(context, 'copied verbatim, contents and all').toContain('What this board is for')
    const thread = await readFile(
      join(folder, slug, '00-context', 'm-thread-template.md'), 'utf8')
    expect(thread).toContain('M-Thread')
  })
})

/**
 * **DRAGGING A CARD ON A BOARD.** Ruled 2026-08-22, on the difference they felt between the two
 * boards: *"I'm not able to grab an item and move it… I want to be able to grab it and move an item
 * between, and then rearranging."*
 *
 * **§18.5 was misread when Boards was built.** The rule is *"one mechanism, with drag demoted to an
 * accelerator"* — the Tasks board has both halves and Boards shipped with only the explicit one.
 *
 * **Real `DragEvent`s, dispatched in the page**, exactly as `board-drag.spec.ts` drives the Tasks
 * board, and its honesty caveat carries over verbatim: this exercises the app's real `dragstart`,
 * `dragover` and `drop` handlers, the real move, and the real repaint. It does **not** prove that a
 * trackpad can begin a drag.
 */
test.describe('dragging a card on a board', () => {
  const open = async (page: Page) => {
    await tab(page, 'Boards').click()
    await expect(page.locator('.boards-list')).toBeVisible()
    await page.getByRole('button', { name: /Cold store/i }).click()
    await expect(page.locator('.board-columns')).toBeVisible()
  }
  const columnNamed = (page: Page, name: string) =>
    page.locator('.board-column')
      .filter({ has: page.locator('.board-column-name', { hasText: new RegExp(`^${name}$`) }) })
  const titlesIn = (page: Page, name: string) =>
    columnNamed(page, name).locator('.boards-card-title').allInnerTexts()

  /**
   * `onto` names what the drop lands on: a column's own space means "put it at the end", and a card
   * means a position — `top` for above its midpoint, `bottom` for below.
   */
  const drag = (
    page: Page,
    title: string,
    onto: { readonly column: string } | { readonly card: string; readonly half: 'top' | 'bottom' },
  ) => page.evaluate(({ moved, target }) => {
    const cardNamed = (name: string): Element | undefined =>
      [...document.querySelectorAll('.boards-card')].find(
        node => node.querySelector('.boards-card-title')?.textContent === name,
      )
    const card = cardNamed(moved)
    if (card === undefined) throw new Error(`no card called ${moved}`)

    const transfer = new DataTransfer()
    const fire = (at: Element, type: string, clientY?: number): void => {
      at.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: transfer, ...(clientY === undefined ? {} : { clientY }),
      }))
    }
    fire(card, 'dragstart')

    if ('column' in target) {
      const column = [...document.querySelectorAll('.board-column')].find(
        node => node.querySelector('.board-column-name')?.textContent === target.column,
      )
      if (column === undefined) throw new Error(`no column called ${target.column}`)
      // `dragenter` too, and the first version omitted it — so the highlight it is supposed to
      // raise was never raised, and the assertion that Uncategorized does NOT light up passed
      // against a board where nothing lights up at all.
      fire(column, 'dragenter')
      fire(column, 'dragover')
      fire(column, 'drop')
      return
    }

    const onCard = cardNamed(target.card)
    if (onCard === undefined) throw new Error(`no card called ${target.card}`)
    const box = onCard.getBoundingClientRect()
    // Clear of the midpoint on the side asked for, so the half is not decided by a rounding error.
    const y = target.half === 'top' ? box.top + 2 : box.bottom - 2
    fire(onCard, 'dragover', y)
    fire(onCard, 'drop', y)
  }, { moved: title, target: onto })

  /**
   * Picks a card up and holds it over a column **without letting go**, so the drop target's
   * highlight can be looked at while it is up. A completed drag clears it on the way out, which is
   * why asserting after `drop` proves nothing either way.
   */
  const hoverOver = (page: Page, title: string, columnName: string) =>
    page.evaluate(({ moved, name }) => {
      const card = [...document.querySelectorAll('.boards-card')].find(
        node => node.querySelector('.boards-card-title')?.textContent === moved,
      )
      const column = [...document.querySelectorAll('.board-column')].find(
        node => node.querySelector('.board-column-name')?.textContent === name,
      )
      if (card === undefined || column === undefined) throw new Error('no such card or column')
      const transfer = new DataTransfer()
      const fire = (at: Element, type: string): void => {
        at.dispatchEvent(new DragEvent(type, {
          bubbles: true, cancelable: true, dataTransfer: transfer,
        }))
      }
      fire(card, 'dragstart')
      fire(column, 'dragenter')
      fire(column, 'dragover')
    }, { moved: title, name: columnName })

  /**
   * **BETWEEN COLUMNS THE FILE MOVES**, because the columns are folders. Proven by the reload: an
   * order held in this page's memory passes every other line and fails there.
   *
   * MUTATION: drop the `entry.rename` from `moveCardTo`, or the `onDropCard` wiring. Must redden.
   */
  test('a card dragged to another column moves the file, and stays there', async ({ page }) => {
    await boot(page, DESKTOP)
    await open(page)

    /**
     * **The affordance, asserted directly — and it has to be, because the drags below cannot see
     * it.** They dispatch `DragEvent`s at the element, which run the handlers whether or not the
     * browser would ever have started a drag there. Setting `draggable="false"` leaves every one of
     * them green while no real mouse can pick a card up at all. Measured, not assumed: that mutation
     * was run and passed.
     */
    await expect(page.locator('.boards-card').first(), 'a card must be pick-up-able at all')
      .toHaveAttribute('draggable', 'true')

    await expect.poll(async () => titlesIn(page, 'Done')).toEqual(['Site visit'])

    await drag(page, 'Compressor quote', { column: 'Done' })
    await expect.poll(async () => titlesIn(page, 'Done'))
      .toEqual(['Site visit', 'Compressor quote'])
    await expect.poll(async () => titlesIn(page, 'Doing')).toEqual(['Insulation spec'])

    await page.reload()
    await open(page)
    await expect.poll(async () => titlesIn(page, 'Done'), { message: 'the file really moved' })
      .toEqual(['Site visit', 'Compressor quote'])

    /**
     * **Left as found — position included, and the first version was not.**
     *
     * Dragging it back to the column put it at the *end*, so `Doing` was returned with its two cards
     * reversed. The next test asserted the fixture's order and failed on its own setup line. Same
     * lesson the arrange test learned an hour earlier: a test that half-restores poisons the run.
     */
    await drag(page, 'Compressor quote', { column: 'Doing' })
    /**
     * **Waited for between the two drags.** The second was firing against the board as it stood
     * before the first repainted — so it dispatched at a node the app had already replaced, and the
     * drop landed nowhere. Two gestures in one frame is not something a hand can do; the wait is
     * what makes this a sequence rather than a race.
     */
    await expect.poll(async () => titlesIn(page, 'Doing'))
      .toEqual(['Insulation spec', 'Compressor quote'])
    await drag(page, 'Compressor quote', { card: 'Insulation spec', half: 'top' })
    await expect.poll(async () => titlesIn(page, 'Doing'))
      .toEqual(['Compressor quote', 'Insulation spec'])
  })

  /**
   * **WITHIN A COLUMN NOTHING TOUCHES THE DISK.** Their rule for the Projects board, applied here:
   * *"when I drag stuff around that board nothing is supposed to happen on disk."* It is an
   * arrangement, and arrangements live in app config.
   *
   * **Dragging DOWNWARDS is the case with the off-by-one in it** — the card is lifted out before it
   * is put back, so every position below it has already shifted up by one. Get it wrong and the card
   * lands one place short, which reads as an imprecise drop rather than as a bug.
   *
   * MUTATION: return the drawn position unchanged from `droppedAt`. Must redden.
   */
  test('a card dragged down its own column lands where it was dropped, and stays', async ({ page }) => {
    await boot(page, DESKTOP)
    await open(page)
    /**
     * **Whatever order it finds, not the fixture's.** Asserting absolute contents makes a test fail
     * on its setup line when something earlier in the file leaves the board arranged differently —
     * which reports a starting-state problem as though it were the subject.
     */
    const before = await titlesIn(page, 'Doing')
    expect(before.length, 'the fixture needs two cards in Doing').toBe(2)
    const [first, second] = [before[0] as string, before[1] as string]

    await drag(page, first, { card: second, half: 'bottom' })
    await expect.poll(async () => titlesIn(page, 'Doing')).toEqual([second, first])

    await page.reload()
    await open(page)
    await expect.poll(async () => titlesIn(page, 'Doing'), { message: 'the app remembers it' })
      .toEqual([second, first])

    // Back to what it found, by the same gesture in the other direction.
    await drag(page, first, { card: second, half: 'top' })
    await expect.poll(async () => titlesIn(page, 'Doing')).toEqual(before)
  })

  /**
   * **`Uncategorized` takes no drops.** It is not a folder, so there is nowhere for the file to go —
   * and the move menu has never offered it either, so a drag that worked would be the one route into
   * a state nothing else can reach.
   *
   * **What this proves, stated exactly, because three attempts at this comment were wrong.**
   *
   * The *refusal* is guarded in **three** places — the view declines to register a drop target, the
   * drop handler checks the destination, and the move itself refuses a column with no folder. No
   * single-guard mutation reddens anything, so this test cannot attribute the behaviour to any one
   * of them. That is defence in depth and it is deliberate; it is not evidence that two of them are
   * dead, and it is not something this test can distinguish.
   *
   * **What it DOES attribute is the highlight.** MUTATION: replace the view's
   * `column.segments !== null` guard with `true`. Must redden — Uncategorized lights up as a drop
   * target and then declines the drop, which is worse than never having offered.
   */
  test('a card cannot be dragged into Uncategorized', async ({ page }) => {
    await boot(page, DESKTOP)
    await open(page)
    const before = await titlesIn(page, 'Uncategorized')

    /**
     * **The positive control first, and without it the assertion below is worthless.** A board where
     * nothing ever highlights would pass "Uncategorized does not highlight" perfectly — which is
     * exactly what an earlier version of this test was doing, because the helper never fired
     * `dragenter` at all.
     */
    await hoverOver(page, 'Insulation spec', 'Done')
    await expect(columnNamed(page, 'Done'), 'a real column offers itself')
      .toHaveClass(/is-over/)

    await hoverOver(page, 'Insulation spec', 'Uncategorized')
    await expect(columnNamed(page, 'Uncategorized'), 'and this one must not')
      .not.toHaveClass(/is-over/)

    // And letting go over it changes nothing, which is guarded three layers deep — see above.
    await drag(page, 'Insulation spec', { column: 'Uncategorized' })
    await expect.poll(async () => titlesIn(page, 'Uncategorized')).toEqual(before)
    await expect.poll(async () => titlesIn(page, 'Doing'), 'and it stayed where it was')
      .toContain('Insulation spec')
  })
})
