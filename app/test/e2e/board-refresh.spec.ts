import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { showOnly } from './board-nav'
import { expect, test, type Page } from '@playwright/test'

import { E2E_TREE } from '../../playwright.config'

/**
 * **THE BOARDS DO NOT REDRAW THEMSELVES, SO THEY SAY WHEN THEY ARE BEHIND.**
 *
 * The Files tree is live — §15's channel invalidates the folders it is showing — and the three
 * boards are not. They are drawn from the index when you arrive on the tab and never again, so a
 * card an agent adds to the project on your screen does not appear. The board looks complete and is
 * wrong, which is the silent-staleness shape this build refuses everywhere else.
 *
 * **A button, not an automatic redraw.** The call, and the app already leans on the same
 * distinction: when a file changes underneath an editor you are typing in, §13.5 does not replace
 * your text — it tells you, and you decide. A board that repainted itself on every watcher event
 * would do the opposite, and would do it while a card was mid-drag or a task name half-typed.
 *
 * What is asserted here is the pair, because either alone is worth little: the control has to
 * **notice** (otherwise you never learn to press it) and it has to **work** (otherwise noticing is
 * a taunt).
 *
 * The 15s bound matches `live-updates.spec.ts` — a change crosses a filesystem event, a 250ms
 * coalescing window, a subtree reconcile and a network hop before it can reach a pixel.
 */

/**
 * Scoped to the pane that is actually showing.
 *
 * All four tabs are rendered at boot and the hidden ones stay in the document, so a bare
 * `.board-refresh` matches every board's control at once — three of them belonging to tabs nobody
 * is looking at. The first version of this file did exactly that and failed on strict mode, which
 * was the locator being right about the page rather than the page being wrong.
 */
const refresh = (page: Page) => page.locator('.tasks-pane:not([hidden]) .board-refresh')

const laneNamed = (page: Page, name: string) =>
  page.locator('.board-lane').filter({ has: page.locator('.board-lane-name', { hasText: new RegExp(`^${name}$`) }) })

async function openTheBoard(page: Page, project: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()

  await showOnly(page, project)
  await expect(laneNamed(page, 'Next')).toBeVisible()
}

test.describe('the board refresh control', () => {
  test('notices a file written outside the app, and brings it in when pressed',
    async ({ page }, testInfo) => {
      const project = `scratch-${testInfo.project.name}-board-refresh`
      await openTheBoard(page, project)

      const next = laneNamed(page, 'Next')
      await expect(next.locator('.board-card')).toHaveCount(1)
      // Plain to begin with: nothing has happened yet, and a control that always says "changed"
      // says nothing.
      await expect(refresh(page)).toHaveText('Refresh')

      await writeFile(
        join(E2E_TREE, '02-projects', project, '02-work', 'tasks', '02-next', 'from-an-agent.md'),
        '# Written by somebody else\n',
      )

      /**
       * **The card is deliberately NOT expected to appear on its own.** This assertion is the
       * behaviour the operator chose: the board holds still and the control changes. If a future change
       * makes the board repaint itself, this is the test that should be revisited rather than
       * quietly satisfied.
       */
      await expect(refresh(page)).toHaveText('Refresh — files changed', { timeout: 15_000 })
      await expect(next.locator('.board-card')).toHaveCount(1)

      /**
       * **Pressed until the board has it, and the reason is that the marker is GLOBAL.**
       *
       * `staleBoards` is not per-file and not per-project: any watcher event anywhere marks every
       * board stale. So *"Refresh — files changed"* means **something** changed, never **this**
       * changed — and the two are only the same thing when nothing else is happening.
       *
       * **That was measured, not assumed.** This test failed on WebKit two runs out of two whenever
       * `board-drag` ran immediately before it, and passed three out of three alone. Recording every
       * API response through the failing press showed the server answering **200 OK with only
       * `first.md`** — the index genuinely did not hold the new file yet. Nothing was refused,
       * nothing errored, and no banner appeared; the board drew exactly what it was given.
       *
       * `live-updates.ts` reconciles the index *before* it broadcasts, precisely so a refetch is
       * never answered from a stale index. That contract holds per event. What it cannot do is stop
       * a **late event from a previous suite** lighting the marker a moment before this file's own
       * event is reconciled — at which point the marker is true and this file is still absent.
       *
       * So the press is repeated rather than assumed to be the one that lands. **The assertion is
       * unchanged and nothing is weakened**: the card still has to arrive by pressing Refresh, and
       * the board still must not repaint on its own — that is asserted above, before the press.
       * What is removed is the false precision of treating a global signal as a per-file promise.
       */
      await expect.poll(async () => {
        await refresh(page).click()
        return next.locator('.board-card-title').allTextContents()
      }, {
        message: 'pressing Refresh never brought in a file written outside the app',
        timeout: 15_000,
      }).toEqual(['First task', 'Written by somebody else'])

      // And the marker is spent — there is nothing further to fetch.
      await expect(refresh(page)).toHaveText('Refresh')
    })

  test('is on all three boards', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()

    for (const tab of ['Tasks', 'Projects', 'Inbox']) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await expect(refresh(page), `${tab} has no way to re-read itself`).toBeVisible()
    }
  })
})

test('P9F-6 — redrawing the board does not leak document listeners', async ({ page }, testInfo) => {
  /**
   * **the security review filed the methods as unreached; the reachable consequence is here.**
   *
   * `createRowMenus` registers three **document-level** listeners — click, keydown, and a capturing
   * scroll. It was called inside `refreshBoard`, so every draw added three more, and the comment
   * beside it claimed they were *"destroyed by the redraw that replaces it, which is what `clear` on
   * the host already does to everything else in here."* `clear(host)` removes the host's children.
   * It cannot remove a listener on `document`.
   *
   * **Counted rather than reasoned about.** `document.addEventListener` is wrapped before the board
   * is opened, so this measures the app's own calls against the real API. Without the fix the count
   * climbs by three per refresh; with it, the total is flat because each draw destroys the last.
   */
  await page.addInitScript(() => {
    const w = window as unknown as { __docListeners: number }
    w.__docListeners = 0
    const original = document.addEventListener.bind(document)
    const removeOriginal = document.removeEventListener.bind(document)
    document.addEventListener = ((...args: Parameters<typeof original>) => {
      w.__docListeners += 1
      return original(...args)
    }) as typeof document.addEventListener
    document.removeEventListener = ((...args: Parameters<typeof removeOriginal>) => {
      w.__docListeners -= 1
      return removeOriginal(...args)
    }) as typeof document.removeEventListener
  })

  await openTheBoard(page, `scratch-${testInfo.project.name}-board-refresh`)

  const count = async (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __docListeners: number }).__docListeners)

  const settled = await count()
  expect(settled, 'the counter never saw a registration — the wrapper is not working')
    .toBeGreaterThan(0)

  // Five redraws. Without the fix this is fifteen more listeners that nothing can ever remove.
  for (let i = 0; i < 5; i++) {
    await refresh(page).click()
    await expect(refresh(page)).toHaveText('Refresh')
  }

  expect(await count(), 'the board leaked document listeners on redraw').toBe(settled)
})

test('the empty board says which emptiness it means', async ({ page }, testInfo) => {
  /**
   * **A failure must not arrive describing a DIFFERENT failure.** §6's rule is that a failure never
   * arrives looking like a success; this is its neighbour, and it cost about an hour on 2026-08-14.
   *
   * `rootForBoard()` reads the **projects** list, not the registry. Its empty branch said *"No
   * folders are registered yet. Add one in Settings"* — a different fact, and a false one whenever a
   * folder is registered and the projects request simply did not answer. An intermittent failure
   * showed that screen and the sentence sent the investigation at the root registry and the
   * boot-time restore. The registry was fine every time.
   *
   * This asserts the ordinary case: with a folder registered, the board must never claim otherwise.
   */
  await openTheBoard(page, `scratch-${testInfo.project.name}-board-refresh`)

  /**
   * **This used to `return` when the board had cards — which is every run.** The scratch tree is
   * seeded with projects, so `.board-empty` never appears, so the assertion below it had never once
   * executed. The regression it exists to catch could have been reintroduced with this test green.
   *
   * **And it still cannot catch the 2026-08-14 regression, which is worth saying out loud.**
   * `.board-empty` renders only when the *projects* request comes back empty, and this fixture
   * always has projects — so that branch is unreachable here, and the wrong sentence could be put
   * back in it without this test noticing. Proven by putting it back: still green.
   *
   * What it does now is assert a real invariant on the path every run takes — the sentence must not
   * appear anywhere while a folder is registered — which is worth having and is not what the name
   * promises. **A genuine guard needs a fixture with a folder registered and no projects in it**,
   * which means a second app instance the way `first-run.spec.ts` does it. Recorded rather than
   * left as a test that looks like it covers something it does not.
   */
  await expect(page.locator('.board-card').first(), 'the fixture must have drawn a board at all')
    .toBeVisible()

  // The whole page, not `.tasks-pane` — four of those exist and three are hidden, which is a strict
  // mode violation rather than an answer. The claim is about what a person can read, so read it all.
  await expect(
    page.locator('body'),
    'the board claimed no folders were registered while one is',
  ).not.toContainText('No folders are registered yet')
})

test('A29 — a board that is waiting says so, rather than looking empty', async ({ page }, testInfo) => {
  /**
   * **Annex A29: *"Explicit loading states, never a blank frame."*** Added 2026-08-15, after the
   * carry-forward audit found the boards were the one surface without one — the folder picker and
   * the non-editing pane both say `Loading…`.
   *
   * **The failure it removes: an empty board and a waiting board were the same picture.** For the
   * length of a round trip the app asserted *"you have no tasks"* when the truth was *"I have not
   * asked yet"*. Locally that is ~25 ms; over the tailnet on a phone it is three round trips, which
   * is long enough to read and believe.
   *
   * **The round trip is held open deliberately.** Without that the window is invisible and the test
   * would pass against a board with no loading state at all — which is exactly what happened: the
   * mutation sweep found this case missing after the feature had already shipped green.
   */
  const gate: { release: (() => void) | null } = { release: null }
  await page.route('**/api/board.columns', async route => {
    if (gate.release === null) {
      await new Promise<void>(resolve => { gate.release = resolve })
    }
    await route.continue()
  })

  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()

  // The board is now waiting on a request that will not answer until released.
  await expect(page.locator('.tasks-pane:not([hidden]) .board-empty'), 'a waiting board said nothing')
    .toHaveText('Loading…')

  gate.release?.()

  // And it stops saying it once the answer arrives.
  await expect(page.locator('.tasks-pane:not([hidden]) .board-empty')).toHaveCount(0)
  void testInfo
})

test('A29 — the board waits on the PROJECTS list too, and recovers when it lands',
  async ({ page }) => {
    /**
     * **The same rule, one request earlier — and this exists because A29's own test went flaky.**
     *
     * The test above holds `board.columns` open and expects `Loading…`. On 2026-08-15 it instead
     * found **"No projects found in the folders you have registered"**, and polled it fourteen
     * times without it changing. The board had not been slow; it had finished, on a false sentence.
     *
     * `reloadProjects` is un-awaited at boot by design — the picker is off the critical path — so
     * `showTab('tasks')` can reach the board before `projects.list` answers. `rootForBoard()` reads
     * that list, so it was `null`, and the board asserted a fact about the tree that nothing had
     * told it yet.
     *
     * **Two failures, not one, and the second is the worse:**
     *
     *   1. The message is wrong while the request is in flight.
     *   2. **Nothing repainted the board when the answer arrived.** The placeholder was permanent
     *      until the person pressed Refresh — a boot that lost a race left the app looking empty.
     *
     * The empty-branch comment in `main.tsx` records this same intermittency costing about an hour
     * on 2026-08-14, seen from the other end: a screen that sent the investigation at the root
     * registry, which was fine every time.
     */
    const gate: { release: (() => void) | null } = { release: null }
    await page.route('**/api/projects.list', async route => {
      if (gate.release === null) {
        await new Promise<void>(resolve => { gate.release = resolve })
      }
      await route.continue()
    })

    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click()

    const empty = page.locator('.tasks-pane:not([hidden]) .board-empty')

    /**
     * **Asserted as "not the false sentence" as well as "is Loading".** The two say different
     * things: the second pins today's copy, the first pins the property — that the board never
     * claims the tree is empty on the strength of a request that has not answered. A later reword
     * of the loading text should not be able to quietly restore the bug.
     */
    await expect(empty, 'a board waiting on projects.list said the tree was empty').toHaveText('Loading…')
    await expect(empty).not.toContainText('No projects found')

    gate.release?.()

    /**
     * **The recovery half, which is the part that was permanent.** Nothing else repaints this
     * board, so if `reloadProjects` does not redraw it the placeholder stays through the whole
     * timeout and this fails — which is exactly what it did before the fix.
     */
    await expect(empty).toHaveCount(0)
    await expect(page.locator('.tasks-pane:not([hidden]) .board-lane').first()).toBeVisible()
  })

