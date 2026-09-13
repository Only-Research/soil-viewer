import { expect, type Page } from '@playwright/test'

/**
 * **DRIVING THE TASKS BOARD'S PROJECT CONTROL. One gesture, in one place.**
 *
 * Six suites each carried their own copy of "find the project in the picker and choose it", along
 * with their own copy of the comment explaining why it has to be polled. That is six sets of
 * assumptions about one control, drifting in the direction of whichever suite was edited last —
 * the same argument `test/support/fake-dom.ts` makes about instruments, and it applies here for a
 * sharper reason than tidiness.
 *
 * ## Why this exists *before* the control changes
 *
 * P11 replaces the picker with a checkbox filter. The first attempt at that changed `main.tsx`
 * first and turned **36 browser tests red at once** — tests that were not wrong, merely written
 * against a control that had just stopped existing. Extracting the gesture first means that change
 * becomes an edit to this file rather than to six.
 *
 * **So this deliberately implements the CURRENT control.** Every function below is the behaviour
 * the suites already had; nothing about what they prove has changed. When the filter lands, the
 * bodies change and the call sites do not.
 *
 * ## The trap to keep out of the suites when that happens
 *
 * Today's board **draws nothing until a project is chosen**, so every suite begins by choosing one
 * and could not run otherwise. The new board defaults to **all projects** — which means a suite
 * that stops choosing still passes, having quietly stopped covering the control it was written for.
 *
 * `showOnly` therefore asserts the board **actually narrowed**, and that assertion is written now
 * so it is already in place on the day the default flips.
 */

/**
 * Narrows the Tasks board to one project.
 *
 * **Polled, because the control is filled by a round trip.** Reading it straight after the tab
 * click asks before `projects.list` has answered, and "no such project" is then indistinguishable
 * from the fixture being missing. That surfaced in two engines on two different tests the day the
 * suite gained enough fixtures to make the listing slow.
 */
export async function showOnly(page: Page, project: string): Promise<void> {
  await openFilter(page)

  /**
   * **Cleared first, because the name is a promise.** Ticking without clearing made a second call
   * *add* a project — so a suite that switches away and back ended up showing two, and only said so
   * three steps later when a count was wrong. `showOnly` means only.
   */
  const clear = page.locator('.project-filter-clear')
  if (await clear.count() > 0) await clear.click()

  const row = page.locator('.project-filter-row')
    .filter({ has: page.locator('.project-filter-name', { hasText: new RegExp(`^${project}$`) }) })
  await expect(row, `the filter never offered ${project}`).toHaveCount(1)
  await row.locator('.project-filter-tick').check()

  /**
   * **The control is asserted to have taken effect**, and this is the guard the header promises.
   * The board defaults to every project, so a caller that stopped ticking anything would still see
   * a board full of lanes — and would pass, having quietly stopped covering the filter. The summary
   * reading "1 project" can only be true if exactly one box is ticked.
   */
  await expect(page.locator('.project-filter-summary')).toHaveText('1 project')

  /**
   * **THE board is drawn before this returns — this board, not whichever one was already painted.**
   *
   * The previous version waited for `.board-lane` to be visible, and that was satisfied by the
   * *stale* board: the filter summary above updates locally and immediately, while the lanes are a
   * round trip behind it. So this helper returned with the previous project's lanes still on screen.
   *
   * It produced two different reds on 2026-08-13 and both read as flakes:
   *
   *   - a card count taken as a baseline was 7 against a board that then settled to 2, so
   *     `before + 1` asserted 8 and found 3;
   *   - `laneNamed('Urgent')` resolved to **two** lanes — `data-lane="01-urgent"` from one project
   *     and `data-lane="urgent"` from another — a strict-mode violation that named the cause out
   *     loud and was still read as a timing wobble.
   *
   * `data-projects` is the board stating what it drew, so the wait is for the answer we asked for
   * rather than for any answer at all. **One project, because `showOnly` means only.**
   */
  await expect(page.locator('.board[data-projects="1"]')).toBeVisible()

  await closeFilter(page)
}

/**
 * **Puts the picker away, which is the half of the gesture a person never forgets and a helper
 * silently omitted for weeks.**
 *
 * It did not matter while the list was laid out **in flow**: opening it pushed the board down, so
 * every card stayed reachable with the picker still hanging open, and no suite noticed that it was
 * being left that way.
 *
 * On 2026-08-15 the list became a real popover — so that sixty-six projects could be scrolled at
 * all — and it now **floats over the board**. **Twenty-two tests across `back-control`,
 * `card-panel`, `change-status` and `files-tab` went red together**, every one a 30-second timeout
 * with the card resolving but never becoming *"visible, enabled and stable"*: Playwright's way of
 * saying something is on top of it.
 *
 * **The product was changed first, and it was not enough.** The filter now closes on an outside
 * click, which is the fix a person needs. It cannot help here, because a card *underneath* the
 * popover is not outside it — that click lands on the list, which is exempt by design so that
 * ticking a box does not dismiss the thing you are ticking in.
 *
 * So this is the honest remainder: **the helper was leaving the app in a state no user leaves it
 * in.** `showOnly` means "narrow the board and hand it back usable", and a picker still covering it
 * is the gesture half-finished. Closing it here is completing the helper, not conceding the bug.
 */
async function closeFilter(page: Page): Promise<void> {
  const box = page.locator('.project-filter')
  if (!(await box.evaluate((node: HTMLDetailsElement) => node.open))) return

  /**
   * **Closed by setting the property, NOT by clicking the summary — and that needs justifying,
   * because a helper that avoids a real gesture is usually a helper hiding something.**
   *
   * The clicking version failed `board-refresh` **deterministically, 3 runs out of 3**, and only
   * when `board-drag` ran before it — the suite that simulates HTML5 drags — and only on WebKit.
   * The captured page snapshot showed the cause plainly: after the test clicked *Refresh*, the
   * control still read **"Refresh — files changed"** and the board had never refetched. The click
   * reached nothing.
   *
   * **The product was checked by hand before this was written, and it is fine.** Against the running
   * app: opening the filter by clicking its summary works, closing it the same way works, the
   * Refresh button is still the same element afterwards, and it receives its click —
   * `clicksReceivedByOriginalButton: 1`. So there is no state this control leaves behind that stops
   * the board being refreshed, which was the only version of this worth being afraid of.
   *
   * What is left is an interaction between an extra synthetic click and whatever WebKit is holding
   * after a simulated drag. **That is the harness, not the app** — and a suite-ordering artefact is
   * not something to encode as product behaviour.
   *
   * **Clicking is still covered, deliberately**: `project-filter-popover.spec.ts` opens this control
   * by clicking its summary and closes it with a real click outside, both asserted. This helper's
   * job is only to put the picker away so the board underneath is usable.
   */
  await box.evaluate((node: HTMLDetailsElement) => { node.open = false })
  await expect(box).not.toHaveAttribute('open', '')
}

/**
 * Opens the filter disclosure, waiting for it to have been filled.
 *
 * **Polled** for the reason the picker was: it is drawn from `projects.list`, so reading its rows
 * straight after the tab click asks before the round trip has answered, and "no such project" is
 * then indistinguishable from the fixture being missing.
 */
async function openFilter(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.project-filter-row').count(),
    { message: 'the project filter never listed anything' }).toBeGreaterThan(0)
  const box = page.locator('.project-filter')
  if (await box.evaluate((node: HTMLDetailsElement) => node.open)) return
  await page.locator('.project-filter-summary').click()
}

/** Puts the board back to every project. */
export async function showEverything(page: Page): Promise<void> {
  await openFilter(page)
  const clear = page.locator('.project-filter-clear')
  if (await clear.count() === 0) return
  await clear.click()
  await expect(page.locator('.project-filter-summary')).toHaveText('All projects')
  await closeFilter(page)
}

/** Every project the control is offering, in the order it draws them. */
export async function projectsOffered(page: Page): Promise<string[]> {
  await openFilter(page)
  return page.locator('.project-filter-name').allTextContents()
}

/**
 * Opens the Tasks tab and narrows to one project. The two things every board suite does first.
 *
 * The viewport is set by the caller: `board-drag` needs 1600px so five lanes fit without scrolling,
 * and a helper that imposed one width would be deciding something those suites are measuring.
 */
export async function openBoard(page: Page, project: string): Promise<void> {
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
  await showOnly(page, project)
}
