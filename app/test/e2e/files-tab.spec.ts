import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { showOnly } from './board-nav'
import { expect, test } from '@playwright/test'

import { openRoot } from './tree-nav'

import { E2E_TREE } from '../../playwright.config'

/**
 * THE FILES TAB, IN A REAL BROWSER, AGAINST A REAL SERVER AND REAL FILES.
 *
 * **This file exists because of P6.** The live preview was entirely absent in the browser for a
 * day — a `ViewPlugin` threw on the first real document, and a crashing plugin is *disabled* rather
 * than fatal, so the editor mounted, the text was all there, the console was clean, and every unit
 * test passed. A screenshot found it; no test could have.
 *
 * So the assertions below are deliberately about **what is on screen**, not about what a module
 * returns. The tree's logic is unit-tested three files over; what cannot be unit-tested is whether
 * any of it reaches a person.
 *
 * The registered folder is seeded into the server's state directory by `playwright.config.ts`
 * before boot — which also exercises §11's restore path, where roots from config are re-validated
 * identically to a fresh registration.
 */

test.beforeEach(async ({ page }) => {
  const problems: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', error => { problems.push(error.message) })
  await page.goto('/')
  // Attached to the test so a failure names the console output rather than only the assertion.
  await expect(page.locator('#app')).toBeAttached()
  ;(test.info() as { problems?: string[] }).problems = problems
})


/**
 * This test's own working folder — pre-created by `playwright.config.ts`, one per engine.
 *
 * **The mutating tests were sharing one tree and destroying it for the read-only ones.** The rename
 * test renamed `readme.md`, and every test in the *other* project then failed looking for it, since
 * both run against one server and one tree. It read as flakiness that depended on worker order.
 *
 * Created before the server boots rather than inside the test: a folder made mid-run is visible
 * only once the **watcher** has reconciled it, which puts a filesystem-event race in front of an
 * assertion about a menu — and a test that fails for a timing reason teaches nothing about the
 * feature it names.
 */
function scratchFolder(testInfo: import('@playwright/test').TestInfo, purpose: string): string {
  return `scratch-${testInfo.project.name}-${purpose}`
}

/**
 * A row matched on its **exact** label.
 *
 * `hasText` is a substring match, and the scratch names are prefixes of one another —
 * `scratch-chromium-conflict` matches `scratch-chromium-conflict-keep` too. That is the third time
 * in this file a substring locator has picked the wrong row (the others: `readme` matching the
 * top-level file, and `subject` matching a leftover rescue file). Exact matching removes the class
 * rather than the instance.
 */
function rowNamed(page: import('@playwright/test').Page, label: string) {
  return page.getByRole('tree', { name: 'Files' })
    .locator('.tree-row')
    .filter({ has: page.getByText(label, { exact: true }) })
}

test('the tree lists the registered folder\'s contents', async ({ page }) => {
  /**
   * **The registered folder has its own row, and it starts collapsed.**
   *
   * Both halves are new as of 2026-08-09. There was no root row at all — the tree drew a folder's
   * contents at depth 0 — which was fine with one folder and unusable with two, and meant a newly
   * added empty folder appeared nowhere. The operator then ruled the row starts closed: *"it is
   * collapsed by default"*, matching the app this replaces.
   */
  const raw = page.getByRole('tree', { name: 'Files' })
  const root = raw.locator('.tree-row', { hasText: 'soil-viewer-e2e-tree' }).first()
  await expect(root).toBeVisible()
  await expect(root.locator('.tree-twisty')).toHaveText('▸')
  // Closed means closed: the contents are not merely hidden by CSS, they are not in the document.
  await expect(raw.getByText('02-projects', { exact: true })).toHaveCount(0)

  const tree = await openRoot(page)
  await expect(tree).toBeVisible()

  // Folders before files, and the folder name VERBATIM — the ruling: "keeping 00-context is
  // paramount." `02-projects` must not render as "02 projects".
  await expect(tree.getByText('02-projects', { exact: true })).toBeVisible()
  // And a file, prettified: `readme.md` reads as `readme`.
  await expect(tree.getByText('readme', { exact: true })).toBeVisible()
})

test('a folder expands and shows what is inside it', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await expect(tree.getByText('orchard', { exact: true })).toBeVisible()

  await tree.getByText('orchard', { exact: true }).click()
  await expect(tree.getByText('notes', { exact: true })).toBeVisible()
  // A non-markdown file keeps its extension — it is part of what the file IS.
  await expect(tree.getByText('photo.png', { exact: true })).toBeVisible()
})

/**
 * **THE MILESTONE.** Every phase before this built machinery no person could reach. This is the
 * first assertion in the build that a real file, chosen by clicking, appears in the editor.
 *
 * It was `test.fixme` for about an hour: `file.load` was `local-only` while the client is served
 * only by the tailnet listener, so the editor could not open a file from the one listener that
 * serves it. The operator ruled — *"Yes, the phone can edit"* — and the route table now matches what §7
 * always said. The assertions below are unchanged from when they could not run.
 */
test('clicking a markdown file opens it in the editor with its real content', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('notes', { exact: true }).click()

  const editor = page.locator('.cm-content')
  await expect(editor).toBeVisible()
  await expect(editor).toContainText('Orchard notes')
  await expect(editor).toContainText('what the editor should open')

  // The formatting bar is welded to the surface (A16) and must arrive with it.
  await expect(page.locator('.editor-surface button').first()).toBeVisible()
})

test('the live preview is actually PAINTING, not just holding text', async ({ page }) => {
  /**
   * P6's exact failure, asserted directly. The decorations plugin can throw and be silently
   * disabled — leaving an editor that mounts, holds every character, and styles nothing. The text
   * being present is therefore not evidence the preview works.
   */
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('notes', { exact: true }).click()

  await expect(page.locator('.cm-content')).toContainText('Orchard notes')

  /**
   * Asserted on the DECORATION CLASS, not on line numbers.
   *
   * The first version compared the font size of line 0 against line 2, which broke the moment the
   * fixture gained frontmatter — line 0 became `---`. Worse than brittle: it would have kept
   * passing on any document whose first line happened to be larger, for reasons unrelated to the
   * preview. `.cm-soil-h1` exists only because the plugin built and applied a decoration, which is
   * the thing being tested.
   */
  await expect(page.locator('.cm-soil-h1').first()).toBeVisible()
  const styled = await page.locator('.cm-soil-h1').first()
    .evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))
  const plain = await page.locator('.cm-content .cm-line').last()
    .evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))
  expect(styled, 'a heading must render larger than body text').toBeGreaterThan(plain)
})

test('a non-markdown file does not open the editor', async ({ page }) => {
  // §12: the editor opens `.md` and nothing else, ever.
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('photo.png', { exact: true }).click()

  await expect(page.locator('.cm-content')).toHaveCount(0)
  await expect(page.locator('.pane-name')).toHaveText('photo.png')
})

/**
 * **ruled 2026-08-09:** *"they can just show, cannot display this file or something."*
 *
 * The fixture is an `.mp4` that is not a real video — the assertion is about what the pane SAYS,
 * and real video bytes would prove nothing extra while adding a megabyte to every test run.
 */
test('a file the app cannot show says so, and offers no download', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('clip.mp4', { exact: true }).click()

  await expect(page.locator('.pane-note')).toContainText('cannot be shown here')

  /**
   * No DOWNLOAD affordance — which is not the same as no buttons, and the first version of this
   * test asserted the latter. Copy Path is a button and belongs here; it was the only reason this
   * went red when the pane gained its header, which is a test being wrong rather than a rule.
   */
  await expect(page.locator('.pane a')).toHaveCount(0)
  await expect(page.locator('.pane [download]')).toHaveCount(0)
  await expect(page.locator('.pane')).not.toContainText(/download/i)
})

test('an image is shown inline, from the byte endpoint', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('photo.png', { exact: true }).click()

  const image = page.locator('.pane-image')
  await expect(image).toBeVisible()
  // Relative, ticketed, one `p` per segment — §7/F9.3 forbids an absolute URL in the bundle.
  const source = await image.getAttribute('src')
  expect(source).toMatch(/^\/file\?ticket=/)
  // One `p` per segment, never a joined path.
  expect(source).toContain('&p=02-projects&p=orchard&p=photo.png')
})

test('a small text file reads in a monospace pane', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('rows.csv', { exact: true }).click()

  await expect(page.locator('.pane-text')).toContainText('Hollis')
})

test('the selected row is marked, and only one is', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('notes', { exact: true }).click()

  await expect(page.locator('.tree-row.is-selected')).toHaveCount(1)
  await expect(page.locator('.tree-row.is-selected')).toContainText('notes')
})

test('nothing errored in the console while doing all of that', async ({ page }, testInfo) => {
  /**
   * **`beforeEach`'s collector, and no reload.**
   *
   * This used to attach its own listeners and then `page.reload()`, because listeners attached
   * inside a test miss the console output of the load that `beforeEach` already performed — the
   * reload was how it got to watch a page from the very first byte.
   *
   * It does not need to. `beforeEach` attaches its listeners **before** it navigates, so the array
   * it hands over already covers the whole lifecycle, from first paint onward. The reload was
   * buying a second copy of what was already there, and charging for it:
   *
   * A reload cancels every request still in flight, and **WebKit reports a cancelled fetch with the
   * same wording as a blocked one** — *"…due to access control checks."* Indistinguishable, in the
   * one test whose entire job is to notice a CSP violation, so it cannot be filtered out either.
   * It went red when Phase 8 added one more boot request (`templates.list`) to the set that could
   * still be open when the reload landed — and it depended on how many folders and templates
   * earlier tests had registered, so it passed alone and failed in a full run.
   *
   * Removing the reload removes the race and loses no coverage.
   */
  const problems = (testInfo as { problems?: string[] }).problems
  /**
   * **Asserted, not defaulted.** `?? []` here would make the whole test pass the moment the
   * handover from `beforeEach` broke — a green result proving nothing, which is the one failure
   * shape this suite has found nine times.
   */
  if (problems === undefined) throw new Error('beforeEach did not hand over its console collector')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('notes', { exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('Orchard notes')

  /**
   * A clean console is NOT sufficient — P6's crash produced one — but a dirty console is always a
   * finding, and a CSP violation reports here and nowhere else.
   */
  expect(problems, `console errors: ${problems.join(' | ')}`).toEqual([])
})

/**
 * COPY PATH. §15, annex A26, and the user's daily workflow rather than a nicety.
 *
 * The clipboard itself is not asserted — `navigator.clipboard` needs permissions Playwright grants
 * per-engine and a focused document, and §15 records both as accepted platform limits rather than
 * things to work around. What is asserted is the part that would be wrong silently: **the text the
 * button is about to copy**, on both surfaces.
 */
test('Copy Path is on the editor AND on the non-editing pane', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()

  await tree.getByText('notes', { exact: true }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy path' })).toBeVisible()

  await tree.getByText('clip.mp4', { exact: true }).click()
  await expect(page.locator('.pane-note')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy path' })).toBeVisible()
})

/**
 * **Copy Path ALWAYS says something**, and the two engines take different routes to saying it.
 *
 * §15: Copy Path *"always confirms"*, and records two accepted platform limits — the phone copies
 * to the phone's clipboard, and the window must be focused. In a headless run those limits show up
 * as an **engine split**, which is worth stating because it looked like a bug for three rounds:
 *
 *   - **WebKit permits the write.** A toast appears naming the copied path.
 *   - **Chromium refuses it** without a gesture permission. A banner appears naming the reason.
 *
 * Both are correct. The property that must hold in either engine — and the one that would fail
 * silently — is that **something visible happens and it never names a disk location.** A Copy Path
 * that quietly does nothing is worse than one that refuses: the next paste is whatever was on the
 * clipboard before.
 *
 * *An earlier version asserted the folder id (`e2e/...`). The copied text carries the folder's
 * NAME, which is its directory basename — the assertion was guessing at a value it could read.*
 */
test('pressing Copy Path always produces a visible confirmation or a reason', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('notes', { exact: true }).click()

  await expect(page.locator('.feedback-message')).toHaveCount(0)
  await page.getByRole('button', { name: 'Copy path' }).click()

  const message = page.locator('.feedback-message').first()
  await expect(message).toBeVisible()
  await expect(message).not.toContainText('/Users')

  const copied = await page.locator('.feedback-toast').count() > 0
  if (copied) {
    // The path, relative to the registered folder and ending where the file does.
    await expect(message).toContainText('/02-projects/orchard/notes.md')
    expect(await message.textContent()).not.toMatch(/^Copied \//)
  } else {
    await expect(message).toContainText('Click the window first')
  }
})

/**
 * A27 and §13.5, asserted on whichever message this engine produced:
 *
 *   - a **toast** fades on its own after 2500ms;
 *   - a **banner** does not, and carries its own control, because §13.5 forbids a data-safety event
 *     being announced by something that disappears — *"a 2.5-second auto-dismissing toast, which on
 *     a phone in a pocket is invisible"* is one of the six ways v1's conflict handling lost an edit.
 */
test('a toast fades and a banner does not', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('notes', { exact: true }).click()
  await page.getByRole('button', { name: 'Copy path' }).click()
  await expect(page.locator('.feedback-message').first()).toBeVisible()

  const isToast = await page.locator('.feedback-toast').count() > 0
  // Well past the 2500ms A27 specifies.
  await page.waitForTimeout(3_200)

  if (isToast) {
    await expect(page.locator('.feedback-toast'), 'a toast must fade on its own').toHaveCount(0)
  } else {
    const banner = page.locator('.feedback-banner').first()
    await expect(banner, 'a banner must not fade').toBeVisible()
    await banner.getByRole('button', { name: 'Dismiss' }).click()
    await expect(page.locator('.feedback-banner')).toHaveCount(0)
  }
})

/**
 * SESSION MEMORY. PRD: *"Remembers between sessions: last open file, active tab, sidebar
 * collapsed/expanded, and the expanded-folder set."*
 *
 * Per-client (§15), so this asserts it through a real reload of a real browser rather than through
 * the storage module — whose own validation has nineteen unit tests. What cannot be unit-tested is
 * whether the app puts the state back on the screen.
 */
test('reopens the file and the folders you left open', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText('orchard', { exact: true }).click()
  await tree.getByText('notes', { exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('Orchard notes')

  await page.reload()

  // The folders are expanded again without touching anything...
  await expect(tree.getByText('orchard', { exact: true })).toBeVisible()
  await expect(tree.getByText('notes', { exact: true })).toBeVisible()
  // ...the file is open...
  await expect(page.locator('.cm-content')).toContainText('Orchard notes')
  // ...and the row is marked as the current one.
  await expect(page.locator('.tree-row.is-selected')).toContainText('notes')
})

test('a remembered file that has since vanished does not break the restore', async ({ page }) => {
  /**
   * The case that would otherwise throw on startup: storage naming a path the server no longer
   * has. F9.2 calls restored view state untrusted, and "untrusted" includes "stale".
   */
  await page.evaluate(() => {
    localStorage.setItem('soil-viewer.view-state.v1', JSON.stringify({
      openFile: { rootId: 'e2e', segments: ['02-projects', 'deleted-last-week.md'] },
      expanded: [],
    }))
  })
  await page.reload()

  // The tree still works, nothing is selected, and no error reached the console.
  await expect(page.getByRole('tree', { name: 'Files' })).toBeVisible()
  await expect(page.locator('.tree-row.is-selected')).toHaveCount(0)
  await expect(page.locator('.files-placeholder')).toBeVisible()
})

/**
 * THE ROW MENU AND THE FLOWS BEHIND IT.
 *
 * This is where §13.8's identity token finally gets a user, and where §13.6's slugification meets a
 * person. Driven through real clicks because the failure modes are about focus, ordering and what
 * appears on screen — none of which a unit test reaches.
 */
test('every row carries a ⋯, and it does not open the file', async ({ page }) => {
  const tree = await openRoot(page)
  const row = tree.locator('.tree-row', { hasText: 'readme' })
  // Always present, not hover-revealed: a hover affordance on a phone does not exist.
  await expect(row.locator('.row-menu-button')).toBeVisible()

  await row.locator('.row-menu-button').click()
  await expect(page.getByRole('menu')).toBeVisible()
  // The row's own click opens the file; the menu button must not also do that.
  await expect(page.locator('.cm-content')).toHaveCount(0)
})

test('a folder offers creation and a file does not', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: '02-projects' }).locator('.row-menu-button').click()
  await expect(page.getByRole('menuitem', { name: 'New file' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'New folder' })).toBeVisible()
  await page.keyboard.press('Escape')

  await tree.locator('.tree-row', { hasText: 'readme' }).locator('.row-menu-button').click()
  await expect(page.getByRole('menuitem', { name: 'Rename…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'New file' })).toHaveCount(0)
})

test('the menu offers NO delete, ever', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: '02-projects' }).locator('.row-menu-button').click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu).not.toContainText(/delete|remove|trash/i)
})

test('Escape closes the menu, and so does a click elsewhere', async ({ page }) => {
  const tree = await openRoot(page)
  const button = tree.locator('.tree-row', { hasText: 'readme' }).locator('.row-menu-button')

  await button.click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  await button.click()
  await page.locator('.files-main').click()
  await expect(page.getByRole('menu')).toHaveCount(0)
})

/**
 * §13.6's preview: *"preview the final name before confirm."* M16's failure was a name silently
 * becoming `.md` at creation; a refusal shown here is one a person can fix before pressing
 * anything.
 */
test('the name dialog previews what will actually be created, and refuses M16', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.locator('.tree-row', { hasText: '02-projects' }).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'New file' }).click()

  const field = page.locator('.modal-input')
  await expect(field).toBeFocused()

  await field.fill('My Meeting Notes')
  await expect(page.locator('.modal-preview')).toContainText('my-meeting-notes.md')

  // A35: confirm is disabled while empty, and Enter does nothing rather than confirming empty.
  await field.fill('')
  await expect(page.locator('.modal-confirm')).toBeDisabled()

  // M16: a name with no letters or digits is refused, out loud, before anything is created.
  await field.fill('...')
  await expect(page.locator('.modal-preview')).toContainText('no letters or digits')
  await expect(page.locator('.modal-confirm')).toBeDisabled()

  await page.keyboard.press('Escape')
  await expect(page.locator('.modal-backdrop')).toHaveCount(0)
})

test('creating a file makes it, names it as previewed, and shows it in the tree', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'create')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'New file' }).click()

  await page.locator('.modal-input').fill('Hollis Follow Up')
  await page.locator('.modal-confirm').click()

  // Shown, prettified, inside the folder whose menu was used — and that folder is now open, because
  // creating into a collapsed one looks like nothing happened.
  await expect(tree.getByText('hollis follow up', { exact: true })).toBeVisible()
})

test('renaming a file changes it in place', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'rename')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()

  // `subject`, not `readme`: the tree is flat, so "readme" also matches the top-level row — which
  // is exactly how this test kept renaming the shared fixture for every other test.
  await tree.locator('.tree-row', { hasText: 'subject' }).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()

  await page.locator('.modal-input').fill('Read Me First')
  await page.locator('.modal-confirm').click()

  await expect(tree.getByText('read me first', { exact: true })).toBeVisible()
})

test('duplicating a file makes a copy beside it, named per annex A2', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'duplicate')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()

  await tree.locator('.tree-row', { hasText: 'subject' }).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()

  // `subject.md` -> `subject copy.md`, which the tree prettifies to "subject copy".
  await expect(tree.getByText('subject copy', { exact: true })).toBeVisible()
  await expect(tree.getByText('subject', { exact: true })).toBeVisible()
})

/**
 * MOVE. PRD: *"an **intentional** flow only: menu action → pick the destination folder → confirm.
 * There is no drag-and-drop anywhere on the Files tab."*
 */
test('moving a file needs a destination picked and confirmed', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'move')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()
  await tree.locator('.tree-row', { hasText: 'subject' }).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Move…' }).click()

  const picker = page.getByRole('tree', { name: 'Destination folders' })
  await expect(picker).toBeVisible()
  /**
   * A6: an explicit top-level row, without which the top of a folder is an unreachable destination.
   *
   * Named, not matched by `/top level/`. **Both browser engines share one server**, and since
   * Settings shipped, the settings suite registers a folder — so a second "(top level)" row appears
   * here the moment the other engine gets that far, and a pattern match becomes a strict-mode
   * violation that depends on worker interleaving. Naming the folder this test is about makes the
   * assertion true however many others exist.
   */
  await expect(picker.getByText('soil-viewer-e2e-tree (top level)')).toBeVisible()
  // Folders only — a file is not somewhere anything can go.
  await expect(picker.getByText('subject', { exact: true })).toHaveCount(0)

  // Nothing is chosen yet, so the CTA cannot be pressed.
  await expect(page.getByRole('button', { name: 'Move Here' })).toBeDisabled()

  await picker.locator('.picker-row', { hasText: 'destination' }).click()
  await page.getByRole('button', { name: 'Move Here' }).click()

  // It left the folder it was in and arrived in the one that was picked.
  await tree.locator('.tree-row', { hasText: 'destination' }).click()
  await expect(tree.getByText('subject', { exact: true })).toBeVisible()
})

test('the move dialog names how many files a FOLDER move takes with it — M6', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'move')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Move…' }).click()

  /**
   * §13.7's M6: *"a directory rename moves zero bytes, so v1's byte threshold would let a project
   * move silently remove 200 files from every view. Confirmation names the count."*
   */
  await expect(page.locator('.modal-note')).toContainText(/\d+ files? will move with it/)
  await page.keyboard.press('Escape')
})

test('a folder cannot be moved into itself — the option is not offered', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'move')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Move…' }).click()

  // §13.7 refuses it server-side; offering it would be a trap rather than a choice.
  const picker = page.getByRole('tree', { name: 'Destination folders' })
  await expect(picker.getByText(scratch, { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('there is no drag-and-drop anywhere on the tree', async ({ page }) => {
  // the operator: "accidental drags are a nightmare; moving a file must be deliberate."
  const draggable = await page.locator('.tree-row[draggable="true"]').count()
  expect(draggable).toBe(0)
  expect(await page.locator('[draggable="true"]').count()).toBe(0)
})

/**
 * THE EDITOR SAVES. `createDocumentSession` was built at P6 and imported by nothing in the product
 * until stage C — so the editor loaded files and discarded every keystroke.
 */
test('typing in the editor writes to disk', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'save')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()
  await tree.locator('.tree-row', { hasText: 'subject' }).click()

  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('the scratch document')

  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' EDITED')

  // The text is in the editor before anything is claimed about disk.
  await expect(editor).toContainText('EDITED')
  // A13's visible state: saving, then saved. Autosave is debounced, so this waits for the pill.
  await expect(page.locator('.save-status')).toHaveText('Saved', { timeout: 10_000 })

  // And it is on DISK, which is the only assertion that matters here.
  const onDisk = await readFile(
    join(E2E_TREE, '02-projects', scratch, 'subject.md'), 'utf8')
  expect(onDisk).toContain('EDITED')
})

/**
 * ITEM E — the two-pane conflict surface, carried since P4.
 *
 * Everything behind it has been proven for three phases; what did not exist was a screen, so a
 * conflict could be created and never resolved.
 */
test('a file changed underneath the editor opens the two-pane surface', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'conflict')
  const onDisk = join(E2E_TREE, '02-projects', scratch, 'subject.md')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()
  await tree.locator('.tree-row', { hasText: 'subject' }).click()
  await expect(page.locator('.cm-content')).toContainText('the scratch document')

  // An agent rewrites the file while it is open — §13.4's case, and the reason conflict detection
  // is on the content hash rather than on mtime.
  await writeFile(onDisk, '# Subject\n\nrewritten by something else\n')

  await page.locator('.cm-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' MY EDIT')

  /**
   * §13.5 wants a data-safety event to persist rather than fade. It does — as the **surface**.
   *
   * The banner announces and the two-pane view replaces it: a banner still on screen once the view
   * is up is not an announcement, it is an obstacle fixed over the buttons that resolve the thing
   * it warns about. This test asserted the banner was still visible until a real click on "Keep
   * yours" was intercepted by it.
   */
  await expect(page.getByRole('dialog', { name: 'Resolve a conflict' }))
    .toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.feedback-banner'),
    'the surface replaces the banner rather than sitting under it').toHaveCount(0)
  await expect(page.locator('.conflict-pane.is-mine')).toContainText('MY EDIT')
  await expect(page.locator('.conflict-pane.is-theirs')).toContainText('rewritten by something else')

  // Three choices, and a fourth that is not a dismissal.
  await expect(page.getByRole('button', { name: 'Keep yours' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep what is on disk' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep both' })).toBeVisible()
})

test('choosing Keep yours leaves one file, holding the edit', async ({ page }, testInfo) => {
  // Its own folder: the test above leaves a rescue file behind, and two rows matching "subject"
  // is an ambiguity rather than a failure of the thing being tested.
  const scratch = scratchFolder(testInfo, 'conflict-keep')
  const onDisk = join(E2E_TREE, '02-projects', scratch, 'subject.md')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()
  await tree.locator('.tree-row', { hasText: 'subject' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  await writeFile(onDisk, '# Subject\n\nrewritten again\n')
  await page.locator('.cm-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' KEEP THIS')

  await expect(page.getByRole('dialog', { name: 'Resolve a conflict' }))
    .toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Keep yours' }).click()

  // §13.5: "ending with one file at the canonical path and the loser moved to app-private archive."
  await expect(page.locator('.cm-content')).toContainText('KEEP THIS', { timeout: 10_000 })
  expect(await readFile(onDisk, 'utf8')).toContain('KEEP THIS')
})

test('"Decide later" closes the surface and leaves the reminder up', async ({ page }, testInfo) => {
  /**
   * §13.5's "Needs attention" case. Not now is a real answer; the question disappearing on its own
   * is not.
   */
  const scratch = scratchFolder(testInfo, 'conflict-later')
  const onDisk = join(E2E_TREE, '02-projects', scratch, 'subject.md')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()
  await tree.locator('.tree-row', { hasText: 'subject' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  await writeFile(onDisk, '# Subject\n\nrewritten once more\n')
  await page.locator('.cm-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' LATER')

  await expect(page.getByRole('dialog', { name: 'Resolve a conflict' }))
    .toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Decide later' }).click()

  // The editor is back, and the reminder is not gone.
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.locator('.feedback-banner')).toContainText('changed on disk')
})

/**
 * **A3 — THE EDITOR MUST NEVER LOSE ITS FILE.** Annex, and P6's own deliverable in the build plan:
 * *"editor keyed on identity; retarget on rename/move of the file or any ancestor."*
 *
 * Found by the P9 annex audit as an unverified claim rather than a known bug. The rename path calls
 * the route and never touches `openFile`, so the client goes on holding the old path — and the
 * watcher event that follows looks the old path up, does not find it, and takes the branch that says
 * *"is no longer in that folder"*.
 *
 * Whether that is what actually happens is what this test is for. It asserts the annex's promise
 * rather than the current behaviour, so it fails if the promise is not kept.
 */
test('the open file follows its own rename', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'rename-open')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()

  // Opened, and the editor is really up before anything is renamed underneath it.
  await tree.locator('.tree-row', { hasText: 'subject' }).click()
  await expect(page.locator('.files-main .cm-content')).toContainText('the scratch document')

  await tree.locator('.tree-row', { hasText: 'subject' }).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.locator('.modal-input').fill('Subject Renamed')
  await page.locator('.modal-confirm').click()

  // The tree shows a prettified name — no extension, hyphens back to spaces (`displayName`).
  await expect(tree.getByText('subject renamed', { exact: true })).toBeVisible()

  /**
   * The three things that must all still be true. The header is checked as well as the content
   * because an editor showing the right text under the wrong name is the stale-screen failure this
   * build refuses everywhere else — and the *path* is what the next save is aimed at.
   */
  await expect(page.locator('.files-main .cm-content')).toContainText('the scratch document')
  await expect(page.locator('.files-main .pane-name')).toHaveText('subject-renamed.md')
  /**
   * **The path names the FOLDER, not the file — changed 2026-08-15 with the design pass.**
   *
   * This line used to assert the new filename appeared in the path too. It did, because the path was
   * the whole segment list including the file, which is also why it wrapped to ten lines in a task
   * card on a phone. `headerPath` drops the filename: the line above already carries it.
   *
   * **What this test is for is unchanged** — the header must not be stale after a rename — so the
   * filename half is asserted on `.pane-name` above, which is now the only place it appears.
   */
  await expect(page.locator('.files-main .pane-path')).toContainText(scratch)
})

/**
 * **What happens if you keep typing after the rename** — the question that sizes A3.
 *
 * The editor holding a stale path is one thing; what the *next save* does with it is another. Three
 * outcomes are possible and they are not close in severity: the edit is refused and said so (bad),
 * the edit is silently lost (worse), or the save recreates the old filename and the person ends up
 * with two files where they renamed one (worst — it undoes their rename with their own keystrokes).
 *
 * This test does not assert which. It types, waits for the save to settle, and reads the folder off
 * disk, so the record can name the real behaviour instead of the plausible one.
 */
test('typing after a rename does not resurrect the old filename', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'rename-typing')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()
  await tree.locator('.tree-row', { hasText: 'subject' }).click()
  await expect(page.locator('.files-main .cm-content')).toContainText('the scratch document')

  await tree.locator('.tree-row', { hasText: 'subject' }).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.locator('.modal-input').fill('After Rename')
  await page.locator('.modal-confirm').click()
  await expect(tree.getByText('after rename', { exact: true })).toBeVisible()

  // Type into whatever the editor is still holding.
  await page.locator('.files-main .cm-content').click()
  await page.keyboard.type('typed after the rename')
  // Long enough for the 1000ms autosave quiet period plus the round trip.
  await page.waitForTimeout(3_000)

  const { readdir } = await import('node:fs/promises')
  const folder = join(E2E_TREE, '02-projects', scratch)
  const onDisk = (await readdir(folder)).sort()

  // The renamed file must be the only document there. `subject.md` coming back means the editor
  // wrote to a path the person had deliberately moved away from. It does not — verified.
  expect(onDisk, `the folder holds: ${onDisk.join(', ')}`).not.toContain('subject.md')
  expect(onDisk).toContain('after-rename.md')

  /**
   * **And the typing reached it.** This is A3's actual promise — *"the editor never loses its
   * file"* — and it is the assertion that sizes the bug: with the editor still pointed at the old
   * path, the save is aimed at a file that no longer exists, so everything typed after the rename
   * has nowhere to go.
   */
  expect(await readFile(join(folder, 'after-rename.md'), 'utf8'))
    .toContain('typed after the rename')
})

/**
 * **A3's other half: an ANCESTOR is renamed.** The annex is explicit — *"including when an ancestor
 * folder is renamed/moved; the editor never loses its file"* — and this is the case that carries
 * whole trees, because renaming a folder is how a project moves.
 *
 * The comparison that makes it work is on path *segments*, never on a joined string: `inner` and
 * `inner-notes` share a prefix as text and are unrelated as paths, so a string test would drag an
 * unrelated file along behind the rename.
 */
test('the open file follows a rename of the folder above it', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'ancestor')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()
  await tree.getByText('inner', { exact: true }).click()
  await tree.getByText('note', { exact: true }).click()
  await expect(page.locator('.files-main .cm-content')).toContainText('living under a folder')

  await rowNamed(page, 'inner').locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.locator('.modal-input').fill('inner-renamed')
  await page.locator('.modal-confirm').click()
  await expect(tree.getByText('inner-renamed', { exact: true })).toBeVisible()

  // The file never moved and never changed name — only the folder above it did — so the editor
  // must simply carry on, now aimed one folder over.
  await expect(page.locator('.files-main .cm-content')).toContainText('living under a folder')
  await expect(page.locator('.files-main .pane-name')).toHaveText('note.md')
  /**
   * **The ancestor rename is what this test is really about**, and the path is where it shows.
   * `headerPath` no longer carries the filename (see the sibling test above), so the assertion is
   * the renamed folder alone — which is the half that proves the header followed the rename.
   */
  await expect(page.locator('.files-main .pane-path')).toContainText('inner-renamed')
})

/**
 * **THE FLUSH, AND THE ONLY WINDOW IN WHICH IT MATTERS.**
 *
 * A sweep caught the first version of this proving nothing: it typed, waited three seconds, then
 * renamed — and autosave fires after one, so the text was already on disk and removing the flush
 * changed nothing. The test was measuring the autosave.
 *
 * The flush only earns its place **inside** the quiet period: text typed and then renamed away from
 * within the same second has never been written, and the old path is the last real address it has.
 * Without the flush that text is aimed at a file which stops existing a moment later, and it is
 * gone.
 *
 * So this renames immediately, with no wait at all.
 */
test('text typed in the second before a rename still lands', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'rename-flush')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()
  await tree.locator('.tree-row', { hasText: 'subject' }).click()
  await expect(page.locator('.files-main .cm-content')).toContainText('the scratch document')

  await page.locator('.files-main .cm-content').click()
  await page.keyboard.type('unsaved when the rename happened')

  // No wait. The autosave quiet period is 1000ms and the point is to beat it.
  await tree.locator('.tree-row', { hasText: 'subject' }).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.locator('.modal-input').fill('Flushed First')
  await page.locator('.modal-confirm').click()
  await expect(tree.getByText('flushed first', { exact: true })).toBeVisible()

  // Given a moment for the reopened session to settle, the renamed file holds what was typed.
  await expect.poll(async () =>
    readFile(join(E2E_TREE, '02-projects', scratch, 'flushed-first.md'), 'utf8')
      .catch(() => ''), { message: 'the rename carried the unsaved text with it' })
    .toContain('unsaved when the rename happened')
})

/**
 * **THE ROW MENU SURVIVES THE SCROLL THAT OPENED IT.**
 *
 * Pressing "⋯" focuses the button, and a browser brings a newly focused element fully into view — so
 * on a tree tall enough to scroll, **opening a menu fires a scroll a moment later.** The menu closes
 * on scroll, for a good reason (it is `position: fixed`, so a scroll slides the row out from under
 * it), and it was closing on that one.
 *
 * It arrived as a **flaky test**, not as a bug report: `templates.spec.ts` failing in Chromium only,
 * and only once the fixture tree had grown tall enough for the focus-scroll to happen. Instrumenting
 * the page during the failing run gave the sequence outright — `click on BUTTON.row-menu-button` →
 * `MENU ADDED` → `scroll on DIV.tree` → `MENU REMOVED`.
 *
 * That other test now passes, but it is not the guard: it only exercised this by accident of tree
 * height, in one engine. This states the rule directly, in both directions, so neither half can be
 * removed quietly.
 */
test('the row menu ignores the scroll that opening it caused, and closes on the next one',
  async ({ page }) => {
    const tree = await openRoot(page)
    await tree.getByText('02-projects', { exact: true }).click()
    // Waited for: expanding a folder is a round trip, and the evaluate below looks the row up
    // synchronously — so without this it runs before the listing has arrived.
    await expect(tree.getByText('orchard', { exact: true })).toBeVisible()

    /**
     * **Opened and scrolled in the SAME TICK**, because that is the sequence and because anything
     * else fails to catch it. A first version clicked with Playwright, awaited the menu becoming
     * visible, and only then dispatched the scroll — by which point the arming timer had long since
     * run, so a build armed from the very first instant passed it happily. The await was the bug in
     * the test.
     */
    const survived = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.tree-row')]
        .find(node => node.textContent?.includes('orchard') === true)
      const button = row?.querySelector('.row-menu-button')
      const scroller = document.querySelector('.tree')
      if (!(button instanceof HTMLElement) || scroller === null) throw new Error('no row to open')
      button.click()
      // Exactly what the browser does a moment after focusing the button, with nothing in between.
      scroller.dispatchEvent(new Event('scroll'))
      return document.querySelector('.row-menu') !== null
    })
    expect(survived, 'the menu closed on the scroll its own opening caused').toBe(true)
    await expect(page.locator('.row-menu')).toBeVisible()

    /**
     * ...and a scroll after that still closes it. Without this half, deleting the whole scroll
     * listener would leave the case above green — the menu would simply never close, which is the
     * failure the listener exists to prevent.
     */
    await page.waitForTimeout(50)
    await page.locator('.tree').first().dispatchEvent('scroll')
    await expect(page.locator('.row-menu')).toHaveCount(0)
  })

/**
 * **AND THE SECOND MENU IS PROTECTED TOO** — which needs its own case, because the first one cannot
 * see it.
 *
 * A sweep is what showed this. Removing the line that disarms on close left the case above green:
 * everything there happens inside one synchronous evaluate, so the arming timer never runs at all
 * and the flag is `false` either way. The failure it misses is a *second* menu inheriting the first
 * one's armed state — which is the ordinary way anyone uses a menu: open one, dismiss it, open the
 * next.
 *
 * So this one deliberately lets the timer fire between the two.
 */
test('a second row menu is not armed by the first one\'s timer', async ({ page }) => {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await expect(tree.getByText('orchard', { exact: true })).toBeVisible()
  const button = tree.locator('.tree-row', { hasText: 'orchard' }).first().locator('.row-menu-button')

  // The first menu, opened and left alone long enough for its scroll-close to arm...
  await button.click()
  await expect(page.locator('.row-menu')).toBeVisible()
  await page.waitForTimeout(50)
  await page.keyboard.press('Escape')
  await expect(page.locator('.row-menu')).toHaveCount(0)

  // ...and now the same opening sequence as before, which must be just as protected.
  const survived = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.tree-row')]
      .find(node => node.textContent?.includes('orchard') === true)
    const control = row?.querySelector('.row-menu-button')
    const scroller = document.querySelector('.tree')
    if (!(control instanceof HTMLElement) || scroller === null) throw new Error('no row to open')
    control.click()
    scroller.dispatchEvent(new Event('scroll'))
    return document.querySelector('.row-menu') !== null
  })
  expect(survived, 'the second menu inherited the first one\'s armed state').toBe(true)
})

/**
 * **A5 — a new file opens.** *"New File: appends `.md`, seeds body `# <name>`, opens immediately."*
 *
 * The first two were true; the third was not. Creating a file expanded its folder and left you
 * looking at a tree row — and making a file is never the goal, writing in it is, so a create that
 * stops there asks you to do the same work twice.
 *
 * The assertion is on the **seeded heading with the typed capitalisation**, which is the part that
 * proves the whole chain: the name went to the server as typed, came back slugified as
 * `my-first-note.md`, and the file it opened is the one the server actually made rather than the one
 * the client asked for.
 */
test('a new file opens in the editor, with its heading already in it', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'create')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'New file', exact: true }).click()
  await page.locator('.modal-input').fill('My First Note')
  await page.locator('.modal-confirm').click()

  await expect(page.locator('.files-main .pane-name')).toHaveText('my-first-note.md')
  await expect(page.locator('.files-main .cm-content')).toContainText('My First Note')
})

/**
 * **A10 — arriving from a board shows you where you landed.**
 *
 * *"Sections default collapsed; selection auto-expands its section and every ancestor folder."* A
 * board card is not a tree row, so taking "View in Files" out of a slide-over used to leave the file
 * open in the editor and **nowhere in the tree** — marked as selected, inside folders nobody had
 * expanded. The jump named itself "View in Files" and then did not show it in Files.
 */
test('the jump into Files opens the tree to the file', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()

  await showOnly(page, 'orchard')
  await page.locator('.board-card').filter({ hasText: 'Press repair' }).first().click()
  await page.getByRole('button', { name: 'View in Files' }).click()

  // The row itself, in the tree, with every folder above it opened to reach it.
  await expect(page.getByRole('tree', { name: 'Files' }).getByText('press repair', { exact: true }))
    .toBeVisible()
})

/**
 * **A RENAME DOES NOT WALK AWAY FROM A SAVE THAT FAILED.** The security review, P9F-2 — the one finding in this
 * phase that could put a person's text beyond reach of everything.
 *
 * Two measured facts make it possible. `write()` catches its own transport error and *returns*, so
 * `flush()` resolves whether or not anything was written and the buffer stays dirty. And §13.8's
 * rescue copy is keyed by **path** — so renaming files it under a name that is not on disk, where
 * `inspect` answers `none` forever and nothing in the app ever re-keys it.
 *
 * The save is failed here by intercepting the route, which is the only honest way to reach it: a
 * save that fails is a dropped connection or a blocked truncation, and neither can be arranged by
 * clicking.
 */
test('a rename is refused while the file has changes that could not be saved',
  async ({ page }, testInfo) => {
    const scratch = scratchFolder(testInfo, 'rename-blocked')

    // Every save fails from here on, exactly as an unreachable server does.
    await page.route('**/api/file.save', route => route.abort('failed'))

    const tree = await openRoot(page)
    await tree.getByText('02-projects', { exact: true }).click()
    await rowNamed(page, scratch).click()
    await tree.locator('.tree-row', { hasText: 'subject' }).click()
    await expect(page.locator('.files-main .cm-content')).toContainText('the scratch document')

    await page.locator('.files-main .cm-content').click()
    await page.keyboard.type('this could not be saved')

    await tree.locator('.tree-row', { hasText: 'subject' }).locator('.row-menu-button').click()
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    await page.locator('.modal-input').fill('Renamed Anyway')
    await page.locator('.modal-confirm').click()

    /**
     * Refused, and it says why rather than failing quietly.
     *
     * Filtered to *this* banner: the failed save has already raised one of its own ("the save did
     * not reach the server"), so a bare `.feedback-message` is two elements. Both being on screen
     * is right — one says the save failed, the other says what that means for the rename, and the
     * second is the one that was missing.
     */
    const refusal = page.locator('.feedback-message').filter({ hasText: 'not renamed' })
    await expect(refusal).toContainText('could not be saved')
    await expect(refusal).toContainText('still on screen')

    /**
     * The three things that must all still be true: the file kept its name, the text is still on
     * screen, and the editor is still pointed at it. The text being *on screen* is what makes this
     * recoverable at all.
     */
    await expect(tree.getByText('subject', { exact: true })).toBeVisible()
    await expect(tree.getByText('renamed anyway', { exact: true })).toHaveCount(0)
    await expect(page.locator('.files-main .cm-content')).toContainText('this could not be saved')
    await expect(page.locator('.files-main .pane-name')).toHaveText('subject.md')
  })

/**
 * **A CLEAN FILE'S RENAME DOES NOT RE-ARM ITS IDENTITY TOKEN.** The security review, P9F-3.
 *
 * The re-read after the flush exists for a real reason — an atomic write replaces the inode, so a
 * flush that wrote invalidates §13.8's token and the rename must carry a fresh one. But the first
 * version re-read on **every** carried rename, including the ones where the flush wrote nothing:
 * it discarded a token that was still valid and adopted whatever the server currently reported. A
 * file an agent had replaced between the paint and the rename would then be renamed *without* the
 * refusal — §13.8 exists to say "someone else changed this since you looked", and on this path it
 * could no longer say it.
 *
 * **Asserted on the request, because the screen cannot tell.** Both versions rename the file
 * successfully; the difference is whether an extra `tree.children` goes out to re-read a row that
 * did not need re-reading. Driving the finding itself would mean holding the watcher still so the
 * row stays stale, which is not something a browser can be asked to do — so this pins the mechanism
 * rather than the symptom, and says so.
 */
test('renaming an unmodified open file does not re-read its row', async ({ page }, testInfo) => {
  const scratch = scratchFolder(testInfo, 'rename-clean')

  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await rowNamed(page, scratch).click()
  await tree.locator('.tree-row', { hasText: 'subject' }).click()
  await expect(page.locator('.files-main .cm-content')).toContainText('the scratch document')
  // Opened and NOT typed into. Nothing to flush, so nothing invalidates the token.

  const listings: string[] = []
  page.on('request', request => {
    if (request.url().includes('/api/tree.children')) listings.push(request.url())
  })

  await tree.locator('.tree-row', { hasText: 'subject' }).locator('.row-menu-button').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.locator('.modal-input').fill('Clean Rename')
  await page.locator('.modal-confirm').click()
  await expect(tree.getByText('clean rename', { exact: true })).toBeVisible()

  /**
   * The rename's own refresh of the folder is expected and is one listing. The re-read would be a
   * *second* one issued before the rename went out — so the count is what distinguishes them, and a
   * successful rename above proves the request happened at all.
   */
  expect(listings.length, `tree.children calls: ${listings.length}`).toBeLessThan(2)
  await expect(page.locator('.files-main .pane-name')).toHaveText('clean-rename.md')
})
