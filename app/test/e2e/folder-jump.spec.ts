import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { openRoot } from './tree-nav'
import { E2E_TREE } from '../../playwright.config'

/**
 * **JUMPING TO A FOLDER AND ACTUALLY LANDING ON IT.**
 *
 * the operator found this by using the app, after I told them it already worked:
 *
 * > *"I just tested that under projects and that doesn't work. It just jumps you to files, but it
 * > doesn't select or show on screen the selected folder."*
 *
 * They were right, and **three separate call sites were broken the same way** — Projects' "View in
 * Files", the Boards list, and the Inbox's folder click. Each expanded the ancestors so the row
 * *existed*, and then stopped: nothing was highlighted, and nothing in the app had ever scrolled a
 * tree row into view, so on a deep tree the row could exist hundreds of pixels below the fold.
 *
 * **The tree's only notion of "current" was the open document**, which a folder never is.
 *
 * ## Why this file exists rather than more assertions in the other suites
 *
 * The suites already covered these buttons and were green: they asserted that the Files **tab**
 * became selected. That is true of a jump that lands nowhere. **A test can be green about the wrong
 * half of the behaviour**, which is what happened, so this one asserts the half that was missing —
 * highlighted, expanded, on screen.
 *
 * And it is asserted **from the DOM after a real click**, because reading the code is what led me to
 * tell the operator it worked.
 */

const DESKTOP = { width: 1280, height: 800 }

async function boot(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP)
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

/** The selected row, whatever it is. One highlight in the whole tree, always. */
const selected = (page: Page) => page.locator('.tree-row.is-selected')

/**
 * Opens an inbox folder's panel and presses **View in Files**.
 *
 * **This is the jump's real route since 2026-08-19.** Clicking the folder used to jump; the operator
 * asked for a panel instead — *"I don't love the automatic jump"* — so the jump moved behind this
 * button. The tests that drove the click had to move with it, and they are better for it: they now
 * exercise the path a person actually takes.
 */
const jumpFromInboxFolder = async (page: Page): Promise<void> => {
  await tab(page, 'Inbox').click()
  await page.locator('.inbox-item.is-folder').first().click()
  await expect(page.locator('.card-panel-list')).toBeVisible()
  await page.getByRole('button', { name: 'View in Files' }).click()
}

test.describe('a jump to a folder lands on it', () => {
  /**
   * **THE ONE REPORTED.**
   *
   * MUTATION: revert the jump to `showTab(...)` plus a bare `revealPath`. Must redden on the
   * highlight — which is exactly what shipped, and what a "the Files tab is selected" assertion
   * could never have caught.
   */
  test('Projects → View in Files highlights and expands the project', async ({ page }) => {
    await boot(page)
    await tab(page, 'Projects').click()

    const card = page.locator('.board-card').first()
    await expect(card).toBeVisible()
    const name = (await card.locator('.board-card-title').first().innerText()).trim()
    await card.click()

    await page.getByRole('button', { name: 'View in Files' }).click()

    await expect(tab(page, 'Files')).toHaveAttribute('aria-selected', 'true')

    // The half that was missing: something is highlighted, and it is the project.
    await expect(selected(page)).toHaveCount(1)
    await expect(selected(page)).toContainText(name)

    // And it is OPEN, because you jump to a folder to see inside it.
    await expect(selected(page)).toHaveAttribute('aria-expanded', 'true')
  })

  /**
   * MUTATION: drop the `open` flag, or drop the target's own child fetch inside `revealPath`.
   *
   * The second is the sharper one and it has a precedent in this very file's neighbour: expanding a
   * folder without fetching its children leaves it *marked* open with nothing under it — the exact
   * failure `restoreExpanded` records having shipped once before.
   */
  test('the folder it lands on has its contents under it, not just an open twisty', async ({ page }) => {
    await boot(page)
    await tab(page, 'Projects').click()

    await page.locator('.board-card').first().click()
    await page.getByRole('button', { name: 'View in Files' }).click()

    const row = selected(page)
    await expect(row).toHaveAttribute('aria-expanded', 'true')

    /**
     * A child row must exist BELOW the selected one and be indented further. Asserted on the
     * indent rather than on a name, because which project the fixture puts first is not this
     * test's business — and a child that is not indented is not a child.
     */
    /**
     * **Polled, not read once — the first version was racy and a review caught it before the operator
     * did.** `aria-expanded` is set synchronously when the path is revealed, but the children arrive
     * from a fetch, so a single read can land in the gap between the two. It failed once in a real
     * full-suite run and passed 36 times in isolation, which is the shape of a test that will look
     * like a random CI failure months from now.
     */
    const childrenUnderSelection = async (): Promise<number> => page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.tree-row'))
      const at = rows.findIndex(row => row.classList.contains('is-selected'))
      if (at === -1) return -1
      const indentOf = (el: Element): number =>
        Number.parseFloat((el as HTMLElement).style.paddingInlineStart || '0')
      const mine = indentOf(rows[at] as Element)
      let seen = 0
      for (let i = at + 1; i < rows.length; i += 1) {
        const next = indentOf(rows[i] as Element)
        if (next <= mine) break
        seen += 1
      }
      return seen
    })

    await expect.poll(childrenUnderSelection,
      { message: 'the folder is open but has nothing under it' }).toBeGreaterThan(0)
  })

  /**
   * **THE JUMP MUST NOT DISTURB THE OPEN DOCUMENT — three contracts, and I broke all three.**
   *
   * The first version of this fix nulled `openFile` so the folder would win the tree's highlight.
   * `openFile` is not a highlight: it is the app's record of which document is on screen, and the
   * document stays open across a jump. An adversarial review demonstrated the fallout — live
   * updates stopped reaching the editor, session restore came back with nothing open, and the open
   * file stopped following its own rename.
   *
   * **The test that stood here could not see any of it.** It asserted "one row is lit and it is a
   * file row", which `openFile ?? revealedFolder` made true whether or not the null happened — its
   * stated mutation left it green. It is replaced rather than added to.
   *
   * MUTATION: null `openFile` inside `jumpToFolder`. Must redden here.
   */
  test('a folder jump leaves the open document open, and still tracked', async ({ page }) => {
    await boot(page)
    await openRoot(page)

    const file = page.locator('.tree-row-file').first()
    await expect(file).toBeVisible()
    await file.click()
    await expect(page.locator('.pane-name')).toBeVisible()
    const openName = (await page.locator('.pane-name').innerText()).trim()

    await tab(page, 'Projects').click()
    await page.locator('.board-card').first().click()
    await page.getByRole('button', { name: 'View in Files' }).click()

    // The highlight moved to the folder...
    await expect(selected(page)).toHaveClass(/tree-row-folder/)

    /**
     * ...and the document is STILL the one the app has open. Read from the app's own stored view
     * state, which is what session restore reads and what the null was wiping: an assertion against
     * the visible pane alone would pass while storage said `null`.
     */
    const remembered = await page.evaluate(() => {
      const raw = localStorage.getItem('soil-viewer.view-state.v1')
      if (raw === null) return null
      return (JSON.parse(raw) as { openFile: unknown }).openFile
    })
    expect(remembered, 'the open document must survive a folder jump').not.toBeNull()
    await expect(page.locator('.pane-name'), 'and it is still on screen').toHaveText(openName)
  })

  /**
   * **JUMPING TO A FOLDER WHILE A DOCUMENT IS OPEN — and a mutation is the only reason this exists.**
   *
   * Deleting the line that clears the open document left every test green, because none of them had
   * a document open when they jumped. In real use that is the common case: the operator is reading
   * something, then goes to a project. Without the clear, the tree keeps the old FILE lit and the
   * folder they asked for is not highlighted at all — the original bug, surviving in the one situation
   * the tests never set up.
   *
   * MUTATION: drop `selectedRow = …` from the jump, or point the tree back at `openFile`.
   *
   * (Its first docstring named "drop `openFile = null` from the jump" — a line the rework had
   * already removed, so the stated proof could not be run. A mutation you cannot perform is not
   * evidence, and neither is a comment describing one.)
   */
  test('jumping to a folder while a document is open moves the highlight to the folder', async ({ page }) => {
    await boot(page)
    // The tree starts collapsed, so the root has to be opened before any file row exists — the
    // first draft looked for one straight away and found nothing.
    await openRoot(page)

    // Open a document first — this is the state the other tests never reach.
    const file = page.locator('.tree-row-file').first()
    await expect(file).toBeVisible()
    await file.click()
    await expect(selected(page)).toHaveClass(/tree-row-file/)

    await tab(page, 'Projects').click()
    await page.locator('.board-card').first().click()
    await page.getByRole('button', { name: 'View in Files' }).click()

    await expect(selected(page), 'exactly one row lit').toHaveCount(1)
    await expect(selected(page), 'and it is the FOLDER, not the file left open')
      .toHaveClass(/tree-row-folder/)
    await expect(selected(page)).toHaveAttribute('aria-expanded', 'true')
  })

  /**
   * **THE OTHER HALF OF WHAT WAS REPORTED: *"doesn't SHOW ON SCREEN the selected folder."***
   *
   * Highlighting a row below the fold is indistinguishable from highlighting nothing, and nothing
   * in this app had ever scrolled a tree row into view.
   *
   * **THE FIRST VERSION OF THIS TEST WAS GREEN ABOUT NOTHING**, and only a mutation exposed it.
   * Removing the scroll entirely left it passing. Probing the DOM explained why: with just the root
   * expanded the tree holds 14 rows and `scrollHeight` equals `clientHeight` — **the tree could not
   * scroll at all**, so "the row is in view" was true no matter what the code did.
   *
   * So the list is made genuinely long first. `02-projects` holds ~70 folders in this fixture, and
   * the redraw that follows a jump resets the scroll to the top — so a target that sorts *after*
   * that block lands far below the fold and must be scrolled to. That is the user's real tree in
   * miniature: 1,567 files and 1,822 directories, where every jump is off-screen by default.
   *
   * MUTATION: remove the scroll call. Must redden.
   */
  test('the folder it lands on is actually ON SCREEN, not just highlighted', async ({ page }) => {
    await boot(page)
    const tree = await openRoot(page)

    // Make the tree genuinely taller than its box, or this test cannot fail.
    await tree.locator('.tree-row', { hasText: '02-projects' }).first().click()
    await expect.poll(async () => page.locator('.tree-row').count()).toBeGreaterThan(40)
    const scrolls = await page.locator('.tree')
      .evaluate(el => el.scrollHeight > el.clientHeight)
    expect(scrolls, 'the tree must overflow, or this test proves nothing').toBe(true)

    // Jump to something that sorts below all of that.
    await jumpFromInboxFolder(page)
    await expect(selected(page)).toHaveCount(1)

    const visible = await page.evaluate(() => {
      const row = document.querySelector('.tree-row.is-selected')
      const view = document.querySelector('.tree')
      if (row === null || view === null) return null
      const r = row.getBoundingClientRect(), t = view.getBoundingClientRect()
      return { rowTop: r.top, rowBottom: r.bottom, viewTop: t.top, viewBottom: t.bottom }
    })

    expect(visible, 'the row and the tree must both be laid out').not.toBeNull()
    if (visible === null) return
    expect(visible.rowBottom, 'the selected row is below the visible area')
      .toBeLessThanOrEqual(visible.viewBottom + 1)
    expect(visible.rowTop, 'the selected row is above the visible area')
      .toBeGreaterThanOrEqual(visible.viewTop - 1)
  })

  /**
   * **PHONE: a jump lands on the tree screen, not on a document.** RESTORED 2026-08-19.
   *
   * **I deleted this test and should not have.** It guards `filesShowScreen?.('tree')` in the jump —
   * §18.4 gives the phone two Files screens and `showTab` does not reset them, so a jump made while
   * Files sat on a document landed on a document nobody asked for, with no tree and no tab bar. An
   * earlier adversarial review found that bug; a later one found that I had removed its guard while
   * changing what a folder *click* does.
   *
   * The deletion did not follow from the change. The jump still exists — it moved behind the panel's
   * button — so the test needed the same one-line adaptation two of its neighbours already got.
   *
   * MUTATION: delete `filesShowScreen?.('tree')` from `jumpToFolder`. Must redden.
   */
  test('PHONE: a folder jump lands on the tree screen, not on a document', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'mobile')

    /**
     * Reached by RELOADING: §18.3 removes the tab bar in the document view, so there is no tab to
     * tap from there. Boot reopens the last document — putting Files on its document screen — and
     * then restores the remembered tab, which is the state the user's phone wakes up in.
     */
    await openRoot(page)
    await page.locator('.tree-row-file').first().click()
    await expect(page.locator('html')).toHaveAttribute('data-files-screen', 'document')

    await page.locator('.files-screen-back').click()
    await tab(page, 'Inbox').click()
    await page.reload()
    await expect(page.locator('#app')).toBeAttached()
    await expect(page.locator('html')).toHaveAttribute('data-files-screen', 'document')

    await jumpFromInboxFolder(page)

    await expect(page.locator('html'), 'a folder belongs on the tree screen')
      .toHaveAttribute('data-files-screen', 'tree')
    await expect(page.locator('.files-sidebar'), 'the tree must be on screen').toBeVisible()
    await expect(selected(page)).toHaveCount(1)
    await expect(page.locator('.tabs'), 'and the way sideways is still there').toBeVisible()
  })

  /**
   * **THE SCROLL MUST NOT STEAL THE VIEW.** RESTORED 2026-08-19.
   *
   * **Also deleted by me, and this one had nothing to do with the change at all** — it drives the
   * *Projects* route, which this branch does not touch. It guards the rule that a render never
   * scrolls on its own: `render` runs on every announcement, so scrolling on all of them yanks the
   * tree while it is being used. Reproduced once at `scrollTop` 1364 → 570.
   *
   * MUTATION: make the scroll fire on every render. Must redden.
   */
  test('expanding a folder does not scroll the view back to the selection', async ({ page }) => {
    await boot(page)
    const tree = await openRoot(page)

    await tree.locator('.tree-row', { hasText: '02-projects' }).first().click()
    await expect.poll(async () => page.locator('.tree-row').count()).toBeGreaterThan(40)

    // Selected via a JUMP, so the selection sits near the TOP — a tree sorts folders before files,
    // so "the first file row" is near the bottom, right where the test then scrolls to.
    await tab(page, 'Projects').click()
    await page.locator('.board-card').first().click()
    await page.getByRole('button', { name: 'View in Files' }).click()
    await expect(selected(page)).toHaveCount(1)
    const nearTop = await page.evaluate(() => Array.from(document.querySelectorAll('.tree-row'))
      .findIndex(row => row.classList.contains('is-selected')))
    expect(nearTop, 'the selection must be near the top for this to prove anything').toBeLessThan(20)

    await page.locator('.tree').evaluate(el => { el.scrollTop = el.scrollHeight })
    const before = await page.locator('.tree').evaluate(el => el.scrollTop)
    expect(before, 'the tree must be scrolled away, or this proves nothing').toBeGreaterThan(0)

    const far = page.locator('.tree-row-folder').last()
    await far.click()
    await expect.poll(async () => page.locator('.tree').evaluate(el => el.scrollTop))
      .toBeGreaterThan(before - 40)
  })

  /**
   * **JUMPING TO THE SAME FOLDER TWICE. This is the original bug, and my first fix brought it back.**
   *
   * The scroll was made conditional on the selected row's key having *changed*, to stop it stealing
   * the view on every redraw. That fixed the theft and reintroduced the operator's complaint word for
   * word: the second jump to the same folder had nothing to notice, so a row that had drifted off
   * screen stayed off screen.
   *
   * **No test in this file jumped twice** — every one did a single jump per page — which is the hole
   * the regression walked through. An adversarial review found it.
   *
   * MUTATION: make the scroll conditional on the selection changing (a `lastScrolledTo` guard), or
   * drop the `scrollToSelection()` call from the jump. Must redden.
   */
  test('jumping to the SAME folder twice scrolls to it both times', async ({ page }) => {
    await boot(page)
    const tree = await openRoot(page)
    await tree.locator('.tree-row', { hasText: '02-projects' }).first().click()
    await expect.poll(async () => page.locator('.tree-row').count()).toBeGreaterThan(40)

    const jump = async (): Promise<void> => {
      await jumpFromInboxFolder(page)
      await expect(selected(page)).toHaveCount(1)
    }

    const onScreen = async (): Promise<boolean> => page.evaluate(() => {
      const row = document.querySelector('.tree-row.is-selected')
      const view = document.querySelector('.tree')
      if (row === null || view === null) return false
      const r = row.getBoundingClientRect(), t = view.getBoundingClientRect()
      return r.top >= t.top - 1 && r.bottom <= t.bottom + 1
    })

    await jump()
    expect(await onScreen(), 'the first jump must land on screen').toBe(true)

    /**
     * Push it away without touching the selection. **To the TOP, not the bottom** — this folder
     * lives under `99-inbox-main`, which sorts last, so it sits near the foot of the tree and
     * scrolling down was bringing it *into* view. The first version did that and failed on its own
     * setup assertion, which is the assertion earning its keep.
     */
    await page.locator('.tree').evaluate(el => { el.scrollTop = 0 })
    expect(await onScreen(), 'the row must actually be off screen now').toBe(false)

    // The SAME jump again. A second ask is a second scroll.
    await jump()
    expect(await onScreen(), 'the second jump to the same folder must scroll too').toBe(true)
  })

  /**
   * **AN AGENT WRITING TO THE OPEN DOCUMENT MUST NOT STEAL THE HIGHLIGHT.**
   *
   * A folder jump deliberately leaves the tree pointing at a folder while a document stays open
   * behind it. §15's silent re-read reopens that document when it changes on disk — and reopening
   * sets the selection, so an agent saving a file yanked the tree off the folder and scrolled to it
   * with nobody having touched anything. Demonstrated by review: selection moved to the file, tree
   * scrolled 0 → 306.
   *
   * **The first version of this test dispatched a `focus` event and proved nothing** — the mutation
   * sailed through it. The reopen only runs when the file actually changes on disk, so the file is
   * actually changed on disk, in this test's own scratch folder, the way `live-updates.spec.ts`
   * does it.
   *
   * MUTATION: drop the save/restore of the selection around the silent reopen. Must redden.
   */
  test('a live update to the open document does not move the highlight', async ({ page }, info) => {
    const folder = `scratch-${info.project.name}-jump-live`
    const doc = join(E2E_TREE, '02-projects', folder, 'watched.md')
    await writeFile(doc, '# watched\n\nbefore\n')

    await boot(page)
    const tree = await openRoot(page)
    await tree.getByText('02-projects', { exact: true }).click()
    await tree.locator('.tree-row').filter({ has: page.getByText(folder, { exact: true }) }).click()

    await tree.getByText('watched', { exact: true }).click()
    await expect(page.locator('.pane-name')).toContainText('watched.md')

    await tab(page, 'Projects').click()
    await page.locator('.board-card').first().click()
    await page.getByRole('button', { name: 'View in Files' }).click()
    await expect(selected(page)).toHaveClass(/tree-row-folder/)
    /**
     * **The row's NAME, not the whole row's text — and the first version read the whole row.**
     *
     * A tree row carries transient notes beside its name: `…` while its children are still loading
     * (§6's *"not known yet must not render as nothing here"*), and others besides. So the two reads
     * below straddled the children arriving, and the row that had not moved an inch reported
     * different text at the two moments. It failed on a clean machine and passed everywhere else,
     * which is the signature of comparing something that was never stable.
     */
    const landedOn = await selected(page).locator('.tree-label').innerText()

    // An agent changes the document that is still open behind the folder.
    await writeFile(doc, '# watched\n\nafter, written from outside the app\n')

    /**
     * Waited out rather than polled for a change, because the assertion is that nothing moves —
     * `expect.poll` would pass on its first read before the event had even arrived.
     */
    await page.waitForTimeout(1200)

    await expect(selected(page), 'the highlight must still be on the folder')
      .toHaveClass(/tree-row-folder/)
    await expect(selected(page)).toHaveCount(1)
    expect((await selected(page).locator('.tree-label').innerText()).trim(),
      'and on the SAME folder').toBe(landedOn.trim())
  })

  /**
   * **THE INBOX DEAD END, and its third and final shape.**
   *
   * the operator reported from their phone and their desktop that tapping a folder said *"this kind of file
   * cannot be shown here"* on one and dropped them on an empty pane on the other — the folder was
   * being handed to the **document** opener.
   *
   * The first fix made it jump to Files. That worked and they did not want it: *"I don't love the
   * automatic jump… it should do exactly what a project does — it slides out from the right, it
   * shows the contents of the folder, and it gives you a button to view in files."*
   *
   * So this asserts the panel, and `jumpFromInboxFolder` above covers the button.
   *
   * MUTATION: hand the folder back to `opener.run`, or to `jumpToFolder`. Either must redden.
   */
  test('Inbox → a folder opens a panel showing what is inside it', async ({ page }) => {
    await boot(page)
    await tab(page, 'Inbox').click()

    const folder = page.locator('.inbox-item.is-folder').first()
    await expect(folder, 'the fixture must have a folder in an inbox').toBeVisible()
    await folder.click()

    // It did NOT go anywhere.
    await expect(tab(page, 'Inbox'), 'the tab must not change')
      .toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.pane-unsupported'), 'the dead end must be gone').toHaveCount(0)

    // A panel, listing the folder's contents, with the way out offered rather than taken.
    await expect(page.locator('.card-panel-list')).toBeVisible()
    await expect(page.locator('.card-panel-list')).toContainText('draft-outline.md')
    await expect(page.getByRole('button', { name: 'View in Files' })).toBeVisible()
  })
})

/**
 * **A BOARD CARD OPENS IN A PANEL BESIDE THE BOARD.**
 *
 * the operator, having used the version that jumped: *"when I go into a board and I click a card it just
 * jumps you to the card in files, and then when I go back to boards it takes me to the home screen…
 * I need to be able to interact with a board the same way I interact with tasks, where the thing
 * pops out from the side and I can edit it from there."*
 *
 * So: the **Tasks** panel, not the Projects one — a card is a markdown file, so it gets the editor.
 * And the board stays behind it, which is the part the jump destroyed.
 *
 * MUTATION: revert `onOpenCard` to `jumpToFolder`, to a bare reveal, or to the Projects-style
 * folder panel. Each must redden.
 */
test('a board card opens an editor beside the board, and the board stays', async ({ page }) => {
  await boot(page)
  await tab(page, 'Boards').click()
  await expect(page.locator('.boards-list')).toBeVisible()
  await page.getByRole('button', { name: /Cold store/i }).click()
  await expect(page.locator('.board-columns')).toBeVisible()

  await page.locator('.boards-card').filter({ hasText: 'Compressor quote' }).click()

  // It did not leave the tab, and it did not leave the board.
  await expect(tab(page, 'Boards')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.board-columns'), 'the board stays mounted behind the panel')
    .toBeVisible()

  // The Tasks-style panel: an editor, not a list of folder contents.
  const panel = page.getByRole('complementary', { name: 'Card' }).and(page.locator('.is-open'))
  await expect(panel).toBeVisible()
  await expect(panel.locator('.cm-content'), 'a card is a document, so it is editable here')
    .toBeVisible()
  await expect(panel.locator('.card-panel-list'), 'not the folder-listing panel').toHaveCount(0)
})

/**
 * **FULL SCREEN ON A PHONE — for the Inbox and for Boards, both of which they confirmed explicitly.**
 *
 * the operator: *"full screen on the phone, side panel on the desktop."* A review proved neither was
 * guarded: deleting `fullScreen` from the inbox panel altogether reddened nothing, because the test
 * that used to assert its size now pins only the desktop half. The Boards panel is new and had no
 * phone test at all.
 *
 * This is the surface where the 70% sliver was the original complaint, so it is worth a real
 * measurement rather than a class check.
 *
 * MUTATION: drop `fullScreen` from either panel, or set it to `'both'`. Must redden.
 */
test('PHONE: the inbox and boards panels fill the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'mobile')

  const panel = page.getByRole('complementary', { name: 'Card' }).and(page.locator('.is-open'))
  const fillsTheWidth = async (what: string): Promise<void> => {
    await expect.poll(async () => {
      const box = await panel.boundingBox()
      return box === null ? -1 : Math.round(box.x)
    }, { message: `${what} must come to rest flush with the left edge` }).toBe(0)
    const box = await panel.boundingBox()
    if (box === null) throw new Error(`${what} has no box`)
    expect(Math.round(box.width), `${what} must fill the screen, not take a sliver`).toBe(390)
  }

  // An inbox document.
  await tab(page, 'Inbox').click()
  await page.locator('.inbox-item:not(.is-folder)').first().click()
  await fillsTheWidth('the inbox panel')
  await page.locator('.card-panel-back').click()

  // A board card.
  await tab(page, 'Boards').click()
  await expect(page.locator('.boards-list')).toBeVisible()
  await page.getByRole('button', { name: /Cold store/i }).click()
  await expect(page.locator('.board-columns')).toBeVisible()
  await page.locator('.boards-card').filter({ hasText: 'Compressor quote' }).click()
  await fillsTheWidth('the boards panel')
})

/**
 * **AND A FOLDER PANEL HAS A WAY OUT ON A PHONE.** The worst thing a review found in this change.
 *
 * `openFolderInPanel` shipped without a back control: it had only ever served Projects, which is
 * never full screen. Giving the Inbox that panel made it a 390×844 sheet over the tab bar with no
 * outside to click, no keyboard, and no back — so the only exit was *View in Files*, the automatic
 * jump the operator had just asked to stop being what a tap does. A trap, on their phone, on the exact
 * surface they first reported an exit problem for.
 *
 * MUTATION: remove `appendPanelBack` from `openFolderInPanel`. Must redden.
 */
test('PHONE: an inbox folder panel can be closed without leaving the tab', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()

  await tab(page, 'Inbox').click()
  await page.locator('.inbox-item.is-folder').first().click()
  await expect(page.locator('.card-panel-list')).toBeVisible()

  const back = page.locator('.card-panel-back')
  await expect(back, 'a full-screen panel IS its own exit').toBeVisible()
  await back.click()

  await expect(page.locator('.card-panel-list')).toHaveCount(0)
  await expect(tab(page, 'Inbox'), 'and closing it does not jump anywhere')
    .toHaveAttribute('aria-selected', 'true')
})
