import { expect, test, type Page } from '@playwright/test'

/**
 * **THE INBOX LIST — packet §4.7.** The operator: *"inbox should be cleaner… almost like an email like
 * Gmail mobile app."*
 *
 * What this suite guards, and what it deliberately does not:
 *
 * - **Empty groups are not drawn.** The soil has an inbox per project and most are empty most of the
 *   time; the list you came to read was several scrolls past its own table of contents.
 * - **The monogram is on the group header**, where the thing it marks actually varies. Recorded as a
 *   deviation from the packet, which puts one on every row.
 * - **Capture still reaches every inbox**, including the ones the list no longer shows. This is the
 *   one that could quietly break: hiding a group from the list must not hide it from the control
 *   that files into it, or an empty inbox becomes unreachable the moment it empties.
 *
 * Not here: read/unread marks and relative times, both deferred with reasons in
 * `build/design-pass-not-in-v1.md`, and the preview line, which needs the first line of each file
 * and the index does not carry it.
 */

const openInbox = async (page: Page): Promise<void> => {
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await page.getByRole('tab', { name: 'Inbox', exact: true }).click()
  /**
   * **Waited for, because `count()` does not wait.**
   *
   * The board is drawn from a round trip on arrival. `expect(...).toBeVisible()` polls; `count()`
   * answers immediately and truthfully about a screen that has not been drawn yet — so the two
   * tests below reported zero groups against a fixture that has two, and read as a broken filter
   * rather than as a measurement taken too early. The same mistake as reading a panel's box
   * mid-animation, in a different costume.
   */
  await expect(page.locator('.tasks-pane:not([hidden]) .inbox-group').first()).toBeVisible()
}

const pane = (page: Page) => page.locator('.tasks-pane:not([hidden])')

test('every group that is drawn has something in it', async ({ page }) => {
  await openInbox(page)

  const groups = pane(page).locator('.inbox-group')
  const count = await groups.count()
  expect(count, 'the fixture seeds at least one inbox with an item in it').toBeGreaterThan(0)

  for (let index = 0; index < count; index += 1) {
    const group = groups.nth(index)
    const items = await group.locator('.inbox-item').count()
    expect(items, 'a drawn group with no rows is the heading-only screen this removed')
      .toBeGreaterThan(0)
    // And the header's count agrees with what is under it, rather than being decorative.
    await expect(group.locator('.inbox-group-count')).toHaveText(String(items))
  }
})

/**
 * **THE ONE THAT COULD QUIETLY BREAK.** The list filters empty groups; the capture control must not.
 *
 * Asserted by counting: the destination list has to offer at least as many inboxes as the list
 * shows, and on this fixture strictly more — there are project inboxes with nothing in them.
 */
test('capture still offers the inboxes the list no longer shows', async ({ page }) => {
  await openInbox(page)

  const drawn = await pane(page).locator('.inbox-group').count()
  const offered = await pane(page).locator('.inbox-target option').count()

  expect(offered, 'an inbox you cannot see is still one you can file into')
    .toBeGreaterThan(drawn)
})

test('the group header carries a tinted monogram, and it says something', async ({ page }) => {
  await openInbox(page)

  const mark = pane(page).locator('.inbox-group').first().locator('.inbox-monogram')
  await expect(mark).toBeVisible()

  /**
   * **Not the numeric grammar prefix.** Initials taken from the raw folder name would be `01` or
   * `99` on nearly every inbox in the soil — the ordering, which is the one part of the name that
   * says nothing about the contents, and identical across most of them.
   */
  await expect(mark).not.toHaveText(/^\d/)
  await expect(mark).toHaveText(/^\S{1,2}$/)

  // One of the four defined slots, so the ground is a real token rather than an unstyled circle.
  await expect(mark).toHaveClass(/(^|\s)mono-[1-4](\s|$)/)
  const ground = await mark.evaluate(node => getComputedStyle(node).backgroundColor)
  expect(ground, 'an unmatched slot class leaves the circle transparent').not.toBe('rgba(0, 0, 0, 0)')

  // Hidden from the reader: the group label beside it says the same thing in full.
  await expect(mark).toHaveAttribute('aria-hidden', 'true')
})

/**
 * **CAPTURE OPENS WHAT IT MADE.** Ruled 2026-08-16:
 *
 * > *"I have to like name something, and then it like escapes to way down. I have to find it, then
 * > I have to open it, then I have to edit… I'd rather just, like, name it, and it opens it right
 * > away."*
 *
 * The list is sorted, so a new item lands wherever its name puts it — on a full inbox that is off
 * the bottom of the screen. A capture that files a title and leaves you looking at a list is a note
 * you have to go and find before you can write it.
 *
 * **Asserted through the panel's own contents**, not by the panel merely being open: the editor has
 * to be holding the file that was just made. An open panel showing the previously-selected item
 * would satisfy a visibility check and be exactly the bug.
 */
test('capturing a thought opens it, rather than filing it out of sight', async ({ page }) => {
  await openInbox(page)

  /**
   * **Captured into this engine's scratch inbox, which is wiped before every run.**
   *
   * The first version aimed at the hand-seeded `99-inbox-main` and **passed in isolation and failed
   * in the full suite**: the file it creates survives the run, so the next one captures the same
   * name into the same folder and the server correctly refuses the collision. The scratch-folder
   * convention exists for precisely this and was there to be used.
   */
  const engine = test.info().project.name
  const inbox = `scratch-${engine}-capture`
  const typed = 'Roof survey'
  const slug = 'roof-survey'

  await pane(page).locator('.inbox-target').selectOption({ label: inbox })
  await pane(page).locator('.inbox-field').fill(typed)
  await pane(page).locator('.inbox-send').click()

  const panel = page.getByRole('complementary', { name: 'Card' })
  await expect(panel, 'the thing you just named is open, not somewhere in a list').toBeVisible()

  /**
   * **The SLUG, not what was typed.** §13.6 slugifies server-side, so a client that opened the
   * typed name would open nothing at all — the failure this assertion exists to catch, and the
   * reason the segments come from the create reply.
   */
  await expect(panel.locator('.pane-name')).toHaveText(`${slug}.md`)
  // And it is the editor, ready to write in — which is what "name it and it opens" is for.
  await expect(panel.locator('.cm-content')).toBeVisible()
})

/**
 * **A desktop inbox item opens as a SIDE PANEL — and this reverses a ruling of the operator's.**
 *
 * On 2026-08-16 they were asked directly whether a desktop inbox item should open full screen or keep
 * the side panel, and chose full screen: filing is the job of that screen, and a 45% sliver is not
 * where you read something to decide what to do with it.
 *
 * On 2026-08-19, having used it, they reversed it while asking for inbox folders to behave like
 * project cards: *"yes, they should be side panels for desktop… full screen on the phone, side
 * panel on the desktop."*
 *
 * **What the original reasoning did not account for** is that this list now opens two different
 * kinds of thing — a document to read, and a **folder**, whose panel is a list of what is inside it.
 * Two behaviours in one list is the thing that feels broken even when it is deliberate: you cannot
 * tell what a click will do until you have done it.
 *
 * The old test is replaced rather than deleted-and-forgotten, and it asserted the opposite of this.
 *
 * MUTATION: set the inbox panel back to `fullScreen: 'both'`. Must redden.
 */
test('a desktop inbox item opens beside the list, not over it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openInbox(page)

  await pane(page).locator('.inbox-item:not(.is-folder)').first().click()
  const panel = page.getByRole('complementary', { name: 'Card' }).and(page.locator('.is-open'))
  await expect(panel).toBeVisible()

  const paneBox = await pane(page).boundingBox()
  expect(paneBox, 'the pane must have a box').not.toBeNull()
  if (paneBox === null) return

  /**
   * **Polled until it comes to REST, and polled on the right edge.**
   *
   * The previous version of this test recorded why the obvious poll does not work: a closed panel is
   * already at its full width, parked one width to the right, and `is-open` is set before the slide
   * begins — so neither the width nor the class settles it. My first rewrite polled the *width*,
   * which for a side panel is already correct while it is still off screen, and then read `x: 1280`
   * on the next line. Same mid-slide mistake, one measurement over.
   *
   * The right edge coming to rest flush with the pane is the thing that is only true at the end.
   */
  await expect.poll(async () => {
    const box = await panel.boundingBox()
    return box === null ? -1 : Math.round(box.x + box.width)
  }, { message: 'the panel comes to rest against the right edge of the pane' })
    .toBe(Math.round(paneBox.x + paneBox.width))

  const box = await panel.boundingBox()
  expect(box, 'the panel must have a box').not.toBeNull()
  if (box === null) return

  // A side panel: a slice of the pane, with the list still beside it.
  expect(box.width, 'the panel must not fill the pane').toBeLessThan(paneBox.width - 40)
  expect(Math.round(box.x), 'so it starts inside the pane, not at its edge')
    .toBeGreaterThan(Math.round(paneBox.x))

  await expect(pane(page).locator('.inbox-item').first(), 'the list stays readable beside it')
    .toBeVisible()
})

test('a row is big enough to hit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openInbox(page)

  const row = pane(page).locator('.inbox-item').first()
  await expect(row).toBeVisible()
  const box = await row.boundingBox()
  expect(box, 'the row must have a box').not.toBeNull()
  if (box === null) return
  // `--touch-row-min`, the floor this build asserts everywhere a thumb lands.
  expect(box.height).toBeGreaterThanOrEqual(40)
})
