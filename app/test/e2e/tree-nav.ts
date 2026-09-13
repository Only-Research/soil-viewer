import type { Locator, Page } from '@playwright/test'

/**
 * Opening the registered folder's own row, which every tree navigation now starts with.
 *
 * **Root rows are collapsed on a first visit** — ruled 2026-08-09: *"it is collapsed by
 * default"*, matching the app this replaces. Before Settings shipped there were no root rows at
 * all; the tree drew a folder's contents at depth 0, so a test could click straight into
 * `02-projects`. Now that path runs through the folder that contains it.
 *
 * Kept in one place rather than inlined at twenty-five call sites, because the alternative is
 * twenty-five copies of an assumption about the tree's shape — and the shape has now changed twice.
 *
 * Idempotent by checking the twisty rather than by clicking blind: a second call on an already-open
 * root would close it, and the test that followed would fail somewhere unrelated.
 */
export async function openRoot(page: Page, folder = 'soil-viewer-e2e-tree'): Promise<Locator> {
  const tree = page.getByRole('tree', { name: 'Files' })
  const row = tree.locator('.tree-row', { hasText: folder }).first()
  const twisty = row.locator('.tree-twisty')
  if ((await twisty.textContent())?.trim() === '▸') await row.click()
  return tree
}

/**
 * Expands one folder inside the tree, **idempotently**, by the same twisty check `openRoot` uses.
 *
 * Most specs click the folder's label directly, which is fine when the tree is in a known state.
 * Phase 8's is not: Settings → Templates uses the folder picker, and **the picker shares the Files
 * tree's store** — so expanding a folder to find a template also expands it behind the dialog. A
 * blind click afterwards then *collapses* it, and the test fails hunting for a row that was visible
 * a moment ago.
 *
 * That is the hazard `openRoot` was written for, one level down: *"a second call on an already-open
 * root would close it, and the test that followed would fail somewhere unrelated."* It cost thirty
 * seconds a test, six times over, before the page snapshot showed the folder shut.
 */
export async function openFolder(page: Page, label: string): Promise<Locator> {
  const tree = page.getByRole('tree', { name: 'Files' })
  const row = tree.locator('.tree-row').filter({ has: page.getByText(label, { exact: true }) })
  const twisty = row.locator('.tree-twisty')
  if ((await twisty.textContent())?.trim() === '▸') await row.click()
  return tree
}
