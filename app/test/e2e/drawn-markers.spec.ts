import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page, type TestInfo } from '@playwright/test'

import { openRoot } from './tree-nav'

import { E2E_TREE } from '../../playwright.config'

/**
 * **THE DRAWN-MARKER PASS, IN A BROWSER.** Ruled 2026-08-22 and 08-26.
 *
 * `plan-decorations.test.ts` proves the *decision* — which ranges are concealed, which are swapped,
 * and that a number is never touched — without a DOM. It cannot prove the half that matters here:
 * that a glyph which is not in the file actually reaches the screen, and that the character behind
 * it is still in the file afterwards.
 *
 * **This is the first decoration in the build that draws something the document does not contain**,
 * which makes the second assertion in each test the load-bearing one. A bullet on screen is only
 * correct if `- ` is still on disk.
 */

/**
 * **Its own scratch folder, per engine, because one test here types.**
 *
 * The first version read and wrote the shared `notes.md`, which three other suites also read. A
 * mutating test on a shared fixture is the exact failure the scratch pattern exists to prevent, and
 * the pattern was already sitting here when I reached past it.
 */
const folder = (testInfo: TestInfo): string => `scratch-${testInfo.project.name}-markers`
const subject = (testInfo: TestInfo): string =>
  join(E2E_TREE, '02-projects', folder(testInfo), 'subject.md')

async function openNotes(page: Page, testInfo: TestInfo) {
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.locator('.tree-row')
    .filter({ has: page.getByText(folder(testInfo), { exact: true }) }).click()
  await tree.getByText('subject', { exact: true }).click()
  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('the scratch document')
  return editor
}

/**
 * MUTATION: remove `QuoteMark` from the concealed set. Must redden.
 */
test('a blockquote shows its bar, not its angle bracket', async ({ page }, testInfo) => {
  await openNotes(page, testInfo)

  const quoteLine = page.locator('.cm-soil-quote').first()
  await expect(quoteLine).toBeVisible()
  await expect(quoteLine).toContainText('a quoted line')
  // The character is concealed, so it is not in the rendered text of that line.
  expect(await quoteLine.innerText()).not.toContain('>')

  // And it is still in the file. This is the assertion that makes the one above safe.
  expect(await readFile(subject(testInfo), 'utf8')).toContain('> a quoted line')
})

/**
 * MUTATION: plan the dash as `hide` rather than `swap`. Must redden — the bullet disappears
 * entirely and the list renders with no marker at all.
 */
test('a dash draws as a bullet, and stays a dash in the file', async ({ page }, testInfo) => {
  const editor = await openNotes(page, testInfo)

  const bullets = page.locator('.cm-soil-bullet')
  await expect(bullets).toHaveCount(2)
  await expect(bullets.first()).toHaveText('●')
  expect(await editor.innerText()).not.toContain('- a bullet')

  // Nothing was written. The glyph is painted over the character, never substituted for it.
  const onDisk = await readFile(subject(testInfo), 'utf8')
  expect(onDisk).toContain('- a bullet, which should draw as a circle')
  expect(onDisk).not.toContain('●')
})

/**
 * **The half most easily lost while building the other half.**
 *
 * MUTATION: swap every `ListMark` regardless of its text. Must redden.
 */
test('a numbered list keeps its numbers on screen', async ({ page }, testInfo) => {
  const editor = await openNotes(page, testInfo)
  const rendered = await editor.innerText()

  expect(rendered).toContain('1.')
  expect(rendered).toContain('2.')
})

/**
 * **Clicking a list line reveals that line and leaves its neighbours drawn.**
 *
 * A heading's spacing was once set with `margin` on `.cm-line`, which typechecked, looked right, and
 * broke CodeMirror's click-to-caret mapping — the caret landed on a different line than the clicked
 * one. A replaced range is a plausible member of the same family, so it is checked rather than
 * assumed.
 *
 * **What this does NOT prove is the glyph's width**, and the first version of this comment claimed
 * it did. Measured 2026-08-26: widening `.cm-soil-bullet` to `4ch` left all four tests green.
 * CodeMirror maps coordinates through a replaced range's real screen extent, so the width is a
 * *typographic* property, not a correctness control. What it actually holds is in the next test.
 */
test('clicking a bullet line reveals that line, not another', async ({ page }, testInfo) => {
  await openNotes(page, testInfo)

  const target = page.locator('.cm-line', { hasText: 'a second one' }).first()
  await expect(target).toBeVisible()
  const box = await target.boundingBox()
  if (box === null) throw new Error('the list line has no box to click')
  // Inside the line's own text, past the drawn glyph.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

  /**
   * Read the caret's position through the rendered DOM rather than CodeMirror's internals: §12
   * reveals raw markdown on the line the cursor occupies, so the dash reappearing on **this** line
   * is an observable consequence of the caret landing here. No private API, and it fails the same
   * way a person would notice it.
   */
  await expect(target).toContainText('- a second one')

  // And the neighbour stayed drawn, which is what makes the assertion above about THIS line.
  const neighbour = page.locator('.cm-line', { hasText: 'a bullet, which should draw' }).first()
  await expect(neighbour.locator('.cm-soil-bullet')).toHaveCount(1)
})

/**
 * **THE GLYPH IS DRAWN, AND THE FILE IS NOT TOUCHED — asserted together.**
 *
 * A test measuring the drawn bullet's *width* was written here and then deleted, and the reason is
 * worth keeping. It asserted that a drawn line and a revealed line put their text at the same x, on
 * the theory that `width: 1ch` matched the dash. **It failed by 4.6px**, because `1ch` is the width
 * of a zero and a hyphen is narrower — the constraint was causing the shift it was meant to prevent.
 * The width came out of the stylesheet rather than the test being softened to fit it.
 *
 * What is left is the property that actually matters and that a person would notice if it broke:
 * the glyph reaches the screen, and the document still says `-`.
 */
test('the drawn bullet never becomes part of the document', async ({ page }, testInfo) => {
  const editor = await openNotes(page, testInfo)

  await expect(page.locator('.cm-soil-bullet').first()).toHaveText('\u25cf')

  /**
   * Type on an unrelated line and let it save, so the round trip runs with bullets on screen. If a
   * drawn glyph could ever leak into the buffer, a save is when it would happen.
   */
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited')
  await expect(page.locator('.save-status')).toHaveText('Saved', { timeout: 10_000 })

  const onDisk = await readFile(subject(testInfo), 'utf8')
  /**
   * **The glyph the app actually draws**, which is not the same as the one it used to. This line
   * read `\u2022` for one commit after the bullet became `\u25cf` \u2014 an assertion that the file does
   * not contain a character nothing ever writes, which cannot fail and would have sat here passing
   * forever. Caught by the same rename that created it.
   */
  expect(onDisk).not.toContain('\u25cf')
  expect(onDisk).toContain('- a bullet, which should draw as a circle')
  expect(onDisk).toContain('1. a numbered item')
})

/**
 * **CHECKBOXES.** Ruled 2026-08-26: *"checkboxes still x's."*
 *
 * Drawn, not clickable — ticking one means editing the line, as with every other construct in this
 * editor. Making them clickable would mean the display layer writing to the document, which
 * `decorations.ts` forbids by rule; that is a change worth its own care rather than one smuggled in
 * beside a glyph.
 *
 * **The second assertion is the one that came from looking at a screenshot.** The first version drew
 * a bullet AND a box on every task line, because a task item is an ordinary list item that happens
 * to contain a task marker, so both rules fired. Nothing failed; it just looked wrong.
 */
test('a task list draws boxes, and only boxes', async ({ page }, testInfo) => {
  await openNotes(page, testInfo)

  const boxes = page.locator('.cm-soil-task')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.first()).toHaveText('☐')
  await expect(boxes.last()).toHaveText('☑')
  await expect(page.locator('.cm-soil-task-done')).toHaveCount(1)

  /**
   * No bullet on a task line. Counted against the plain list above rather than asserted as zero —
   * the document has both kinds, so a rule that killed every bullet would pass a bare zero check.
   *
   * MUTATION: draw the bullet on task items too. Must redden.
   */
  await expect(page.locator('.cm-soil-bullet')).toHaveCount(2)

  // And the brackets are still the characters in the file.
  const onDisk = await readFile(subject(testInfo), 'utf8')
  expect(onDisk).toContain('- [ ] an unticked box')
  expect(onDisk).toContain('- [x] a ticked one')
  expect(onDisk).not.toContain('☐')
  expect(onDisk).not.toContain('☑')
})
