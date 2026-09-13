import { expect, test, type Page } from '@playwright/test'

import { openRoot } from './tree-nav'

/**
 * **ONE MARK PER FOLDER, NOT TWO.** Packet §4.2, and the operator's own report of the defect.
 *
 * The tree drew a disclosure twisty (`▸`) *and* a type glyph, and `glyphFor` returned `▸` for a
 * directory — so every folder row carried two identical triangles. The fix removes an icon rather
 * than adding a control.
 *
 * **Asserted by counting what is on the row, not by checking a class is absent.** `.tree-glyph`
 * having no matches would also be true of a tree that failed to render, and it says nothing about
 * whether the row reads correctly. Counting the triangles is the claim.
 */

const TRIANGLES = /[▸▾]/gu

async function openTree(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await openRoot(page)
}

const rowNamed = (page: Page, name: string) =>
  page.locator('.files-sidebar .tree-row').filter({ hasText: name }).first()

/**
 * **THE REFERENCE APP'S OWN VALUES, PINNED.** Ruled 2026-08-16: *"just look at their tokens on the
 * file tree. It's perfect, that's what I want… just mirror that exactly."*
 *
 * Read from the reference app's own file-tree values, and
 * 200–203, and from its `theme.ts`. The palette needed nothing — the four greys are already
 * byte-identical in both apps. **The assignment was inverted**: folders were the brightest thing on
 * the screen and files sat above the greys the reference app uses, which is the "more grayed out"
 * they were asking for.
 *
 * Numbers rather than tokens, deliberately. The claim is *"matches that app"*, and a test written
 * against `var(--text-secondary)` would keep passing if the token were repointed — which is exactly
 * the drift this pins.
 */
test('the tree matches the reference app: folders lighter, files greyer', async ({ page }) => {
  await openTree(page)

  const folder = rowNamed(page, '02-projects')
  await expect(folder).toHaveCSS('font-size', '12px')
  await expect(folder, 'theme.text.secondary').toHaveCSS('color', 'rgb(160, 157, 149)')
  await expect(folder).toHaveCSS('font-weight', '500')

  const file = rowNamed(page, 'readme')
  await expect(file).toHaveCSS('font-size', '12.8px')
  /**
   * **`theme.text.muted`, and the inversion this fixes.** A file used to be `--text-secondary` —
   * the colour a FOLDER now wears — and a folder used to be `--text-primary`, the brightest ink in
   * the app. Structure reads first and names recede; that is the arrangement being mirrored.
   */
  await expect(file, 'theme.text.muted, dimmer than its folder').toHaveCSS('color', 'rgb(138, 135, 127)')
  /**
   * 400, not the shell's 300. The the reference app's own root is `fontWeight: 300` and its file rows
   * override — so inheriting here would be a shade lighter than the thing being copied.
   */
  await expect(file).toHaveCSS('font-weight', '400')

  await file.click()
  await expect(file, 'selected: theme.text.primary').toHaveCSS('color', 'rgb(236, 233, 225)')
  await expect(file).toHaveCSS('font-weight', '500')
})

test('a folder row carries exactly one triangle, open or closed', async ({ page }) => {
  await openTree(page)

  const folder = rowNamed(page, '02-projects')
  await expect(folder).toBeVisible()

  const closed = (await folder.textContent()) ?? ''
  expect(closed.match(TRIANGLES) ?? [], 'closed: the twisty, and nothing repeating it')
    .toHaveLength(1)

  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'true')

  const open = (await folder.textContent()) ?? ''
  expect(open.match(TRIANGLES) ?? [], 'open: still one — the twisty turned, it did not multiply')
    .toHaveLength(1)
})

test('a markdown file carries no leading mark at all', async ({ page }) => {
  await openTree(page)

  const file = rowNamed(page, 'readme')
  await expect(file).toBeVisible()

  const text = (await file.textContent()) ?? ''
  expect(text.match(TRIANGLES) ?? [], 'a file has nothing to disclose').toHaveLength(0)
  /**
   * §4.2: *"a file gets no leading glyph; indentation carries it."* The `·` this replaced said
   * "document" on a screen where nearly everything is one.
   */
  expect(text).not.toContain('·')
  expect(text).not.toContain('□')
  await expect(file.locator('.tree-type'), 'and no type either — it is the ordinary case')
    .toHaveCount(0)
})

/**
 * §4.2: *"a non-document shows its type as dim caps after the name (`XLSX`) instead of an icon."*
 *
 * The fixture seeds `photo.png`, `rows.csv` and `clip.mp4` inside `orchard` precisely so the
 * non-markdown path has something real to render.
 */
test('a non-document says what it is, in words, after the name', async ({ page }) => {
  await openTree(page)

  await rowNamed(page, '02-projects').click()
  const orchard = rowNamed(page, 'orchard')
  await expect(orchard).toBeVisible()
  await orchard.click()

  const photo = rowNamed(page, 'photo')
  await expect(photo).toBeVisible()
  await expect(photo.locator('.tree-type')).toHaveText('PNG')

  /**
   * **Not `aria-hidden`, unlike the glyph it replaced.** The name is shown without its extension, so
   * a reader with nothing here is told a picture is a document. This is the one mark on the row that
   * carries information nothing else does.
   */
  await expect(photo.locator('.tree-type')).not.toHaveAttribute('aria-hidden', 'true')

  await expect(rowNamed(page, 'rows').locator('.tree-type')).toHaveText('CSV')
})
