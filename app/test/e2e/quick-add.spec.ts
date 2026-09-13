import { showOnly } from './board-nav'
import { expect, test, type Page } from '@playwright/test'

/**
 * **A TASK BORN IN THE LANE YOU ARE STANDING IN.** PRD, Tasks tab:
 *
 * > *"every lane carries a quick-add at its bottom. Creation-is-placement embodied: standing in a
 * > project's tasks on the board, a task added at the bottom of a lane is born in that lane's actual
 * > folder — project and status already known from where you're standing, nothing to choose but the
 * > name."*
 *
 * The server side is proven in `test/server/card-move.test.ts`, against the real filesystem, and
 * that is where the M2 refusals live — a lane id is never a path, and a create into a lane that has
 * been renamed away is refused rather than obeyed.
 *
 * What is left for a browser is the half a service test cannot see: that the field is **on every
 * lane**, that Enter is enough, and above all that the card lands in **the lane it was typed into**.
 * A quick-add that always wrote to the first lane would pass every service test in the build, since
 * each of those hands the lane id in directly.
 */

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

test.describe('the per-lane quick-add', () => {
  test('puts the task in the lane it was typed into, and nowhere else', async ({ page }, testInfo) => {
    const project = `scratch-${testInfo.project.name}-quick-add`
    await openTheBoard(page, project)

    const urgent = laneNamed(page, 'Urgent')
    const next = laneNamed(page, 'Next')
    await expect(urgent.locator('.board-card')).toHaveCount(0)

    /**
     * **Typed into the SECOND lane, deliberately.** A sweep caught the first version standing in
     * the wrong place: it added to `Urgent`, which is `lanes[0]`, so a quick-add that ignored the
     * lane entirely and always wrote to the first one passed it. The test agreed with the bug.
     */
    const field = next.locator('.board-lane-add-field')
    await field.fill('Feed the goats')
    await field.press('Enter')

    /**
     * The card carries **what was typed**, not the slug. The file on disk is `feed-the-goats.md`;
     * the heading the server seeds is the person's own words, and the board draws the heading. A
     * card reading `feed-the-goats` would be the app showing them its filename.
     */
    await expect(next.locator('.board-card-title')).toHaveText(['Existing task', 'Feed the goats'])
    // The other lane is untouched. This is the assertion the service tests cannot make, because
    // they are handed the lane rather than choosing it.
    await expect(urgent.locator('.board-card')).toHaveCount(0)

    // Emptied, because the next thing a person does is type the next task. Left full, the second
    // one is named `feed the goatscall the vet`.
    await expect(field).toHaveValue('')
    /**
     * **And the caret is still in it.** The board repaints when the card lands, which replaces
     * every field on it — so without the focus being carried across that redraw, "type the next
     * task" means "find the box again with the mouse", and the quick part of quick-add is gone
     * after exactly one use.
     */
    await expect(field).toBeFocused()
  })

  /**
   * Half-typed names survive a repaint, because they are held outside the view.
   *
   * Driven through the project picker, which is the repaint anyone can reach deliberately: switch
   * away, switch back. The same mechanism is what stops a drag in one lane from wiping a name being
   * typed in another — that path needs an HTML5 drag, which nothing in this suite drives yet.
   */
  test('keeps a half-typed name when the board is redrawn underneath it', async ({ page }, testInfo) => {
    const project = `scratch-${testInfo.project.name}-quick-add`
    await openTheBoard(page, project)

    await laneNamed(page, 'Urgent').locator('.board-lane-add-field').fill('Half typed')

    // Away and back — the repaint anyone can reach deliberately. Both hops go through the shared
    // helper, so when the control becomes a checkbox filter this case changes nothing.
    await showOnly(page, `scratch-${testInfo.project.name}-panel-live`)
    await expect(laneNamed(page, 'Urgent')).toBeVisible()
    await showOnly(page, project)

    await expect(laneNamed(page, 'Urgent').locator('.board-lane-add-field'))
      .toHaveValue('Half typed')
  })

  test('is on every lane, not only the first', async ({ page }, testInfo) => {
    await openTheBoard(page, `scratch-${testInfo.project.name}-quick-add`)
    // The PRD says *every* lane carries one. A board that drew a single add row under the columns
    // would satisfy a screenshot and none of the sentence.
    await expect(laneNamed(page, 'Urgent').locator('.board-lane-add-field')).toBeVisible()
    await expect(laneNamed(page, 'Next').locator('.board-lane-add-field')).toBeVisible()
  })

  test('does nothing at all on an empty Enter', async ({ page }, testInfo) => {
    const project = `scratch-${testInfo.project.name}-quick-add`
    await openTheBoard(page, project)

    const next = laneNamed(page, 'Next')
    /**
     * Counted before, not asserted as a literal. The case above adds a card to this same lane and
     * `workers: 1` means it has already run — a hard `1` here would be a test that depends on the
     * order of the file it sits in.
     */
    const before = await next.locator('.board-card').count()
    const field = next.locator('.board-lane-add-field')
    await field.press('Enter')

    /**
     * **An absence needs an anchor, or it is a race the test always wins.**
     *
     * The first version asserted "no message" immediately after the press, and a sweep that removed
     * the empty-name guard passed it — because the assertion was checked in the same millisecond,
     * long before a refusal could return from the server. It was measuring latency, not behaviour.
     *
     * So a real task is added afterwards, and its card is what proves a **complete round trip** has
     * happened. Banners are persistent and dismiss-required (§13.5), so a refusal raised by the
     * empty press would still be on screen at that point.
     */
    await field.fill('A real one')
    await field.press('Enter')
    await expect(next.locator('.board-card')).toHaveCount(before + 1)

    // A file named from nothing would be `.md`, which §13.6 refuses — but the refusal would arrive
    // as a warning banner for a keystroke that was a slip. Silence is the right answer here.
    await expect(page.locator('.feedback-message')).toHaveCount(0)
  })
})
