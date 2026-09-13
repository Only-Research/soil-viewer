/**
 * The formatting bar, driven by real browser input against the real product.
 *
 * **Why this is an e2e test and not a unit test.** The *decisions* — which characters change, which
 * buttons light — are pure functions with 25 tests of their own, including that the bar's lit-state
 * predicate is the same one its buttons apply. What none of those can cover is the single browser
 * behaviour the bar depends on:
 *
 *   **A `click` handler would collapse the selection before the action ran.** The browser moves
 *   focus to the button first, so a user who selects a word and presses Bold would get `****` around
 *   an empty caret instead of around their word. The bar listens on `mousedown` and calls
 *   `preventDefault`, which stops the focus change before it happens.
 *
 * That is a property of focus, selection and event ordering in a real engine. A synthetic event in
 * a unit test cannot show it, and a synthetic event in a *browser* cannot either — an earlier
 * attempt to verify this by dispatching events by hand reported an empty selection and proved
 * nothing about the app. Real clicks, both engines.
 */

import { expect, test } from '@playwright/test'

import { openRoot } from './tree-nav'

/**
 * Opens **a copy of the sample belonging to this test alone**, per engine.
 *
 * `playwright.config.ts` seeds these before the server boots; the path clicked here matches what it
 * writes. Navigating to a file at all is new as of 2026-08-09: P7 replaced P6's auto-mounting
 * development surface with the Files tab, and opening a file was blocked by the write routes'
 * listener carriage until the ruling. The assertions below are unchanged.
 *
 * Every test in this file mutates what it opens — the first one bolds a word and the editor saves
 * it — so a shared document makes each test's starting state depend on which others have already
 * run. That is two separate races, and both were live: across engines, because both run against one
 * server and one tree; and *within* an engine, because a worker runs this file's tests in sequence
 * against the same file.
 *
 * It surfaced as "the bar lights up for the format the caret is inside" failing intermittently on
 * WebKit — a caret placed in what should be plain prose landing inside `**` markers left by an
 * earlier test. Naming a folder per test is what `files-tab` already does, and for the same reason.
 */
async function openTheDocument(
  page: import('@playwright/test').Page, purpose: string,
): Promise<void> {
  await page.goto('/')
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText(`scratch-${test.info().project.name}-format-${purpose}`, { exact: true }).click()
  await tree.getByText('sample', { exact: true }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
}

test.describe('the formatting bar', () => {
  test('a selection survives the button press and gets the markers around it', async ({ page }) => {
    await openTheDocument(page, 'selection')
    const content = page.locator('.cm-content')
    await expect(content).toBeVisible()

    /**
     * **The selection is NOT read through `window.getSelection()`, and the first version of this
     * test was wrong to try.** The editor loads `drawSelection()`, which hides the native selection
     * and paints its own — so `getSelection().toString()` is empty however well the selection
     * works. That reported "the double-click selected nothing" and said nothing about the app.
     *
     * What is asserted instead is the outcome: the markers land around the word.
     */
    /**
     * Selected with the keyboard rather than a double-click, and that is a lesson from this test's
     * own first run: `getByText('quotes')` matched a *container* rather than the word, so the click
     * landed on a blank line and the assertion failed against a caret that had never been where the
     * test believed. Home/Shift+End selects a known line and cannot drift.
     */
    await page.locator('.cm-line', { hasText: 'A blockquote' }).first().click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.locator('.format-bar-button[title="Bold"]').click()

    const text = await content.innerText()
    /**
     * The assertion that matters. On `click` the browser moves focus to the button first and the
     * selection collapses, so the document would gain an empty `****` at a caret. On `mousedown`
     * with `preventDefault` the selection survives and the word is wrapped — and because the caret
     * is then inside a bold span, the Bold button lights.
     */
    expect(text, 'an empty pair means the selection was lost before the action ran').not.toContain('****')
    await expect(page.locator('.format-bar-button[title="Bold"]')).toHaveClass(/is-active/)
  })

  test('the bar lights up for the format the caret is inside', async ({ page }) => {
    await openTheDocument(page, 'lit')
    await expect(page.locator('.cm-content')).toBeVisible()
    const boldButton = page.locator('.format-bar-button[title="Bold"]')

    // The sample has a genuinely bold word. Clicking into it must light the button.
    await page.getByText('bold', { exact: true }).first().click()
    await expect(boldButton).toHaveClass(/is-active/)

    // And moving to plain prose must put it out again — a bar that only ever lights is not tracking.
    await page.getByText('A blockquote', { exact: false }).first().click()
    await expect(boldButton).not.toHaveClass(/is-active/)
  })

  test('pressing a lit button turns the format off', async ({ page }) => {
    // The round trip. A bar whose lit state disagrees with its action would turn the format ON here.
    await openTheDocument(page, 'toggle')
    const content = page.locator('.cm-content')
    await expect(content).toBeVisible()

    /**
     * **With a selection, not a caret**, and the distinction is real rather than incidental. Toggling
     * off from a bare caret unwraps the span and leaves the caret in plain text — pressing Bold again
     * then correctly inserts an empty pair to type into, because there is nothing selected to make
     * bold. That is standard editor behaviour and not a round trip.
     *
     * The first version of this test asserted a round trip from a caret and failed. **The assumption
     * was wrong, not the code** — recorded because it would have been easy to "fix" the editor to
     * satisfy it and end up with a Bold key that cannot start a bold word.
     */
    /**
     * A line with **no existing formatting**, and that is required rather than tidy. `Home` and
     * `End` move by *visual* position, and concealed ranges are skipped — so on a line that already
     * contains hidden markers the selection stops short of the logical line end and the round trip
     * is not exact. The previous version used the line with italic and bold on it and failed for
     * that reason, which is a fact about cursor motion over decorations rather than about the bar.
     */
    await page.locator('.cm-line', { hasText: 'it only parses as one' }).first().click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')

    /**
     * The baseline is taken **after** the caret has moved, and the first version's was not.
     *
     * On load the caret sits at position 0, which reveals the frontmatter delimiters — §12's
     * cursor-line rule working exactly as specified. Comparing against that snapshot made the test
     * fail on two `---` lines that had nothing to do with the button being pressed.
     */
    const before = await content.innerText()

    const boldButton = page.locator('.format-bar-button[title="Bold"]')
    await boldButton.click()
    await boldButton.click()

    expect(await content.innerText(), 'off then on returns the document to where it started')
      .toBe(before)
  })

  test('the bar runs under the real Content-Security-Policy', async ({ page }) => {
    // Every button is built with createElement/textContent — §8, lint-enforced — and the policy
    // carries `require-trusted-types-for 'script'`, which turns any innerHTML assignment into a
    // thrown error. This is where that is actually executed rather than asserted about the source.
    const errors: string[] = []
    page.on('pageerror', error => { errors.push(error.message) })
    await openTheDocument(page, 'csp')
    await expect(page.locator('.format-bar-button')).toHaveCount(12)
    await page.locator('.format-bar-button[title="Heading 2"]').click()
    expect(errors, errors.join('\n')).toEqual([])
  })
})
