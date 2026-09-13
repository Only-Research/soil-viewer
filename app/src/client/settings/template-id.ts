/**
 * The id a newly named template gets. Phase 8, Settings → Templates.
 *
 * The same job `folder-id.ts` does for a registered folder, and deliberately the same shape rather
 * than a second answer to one question. That file's reasoning applies unchanged: **an id is not a
 * display name and not a path** — it is the stable handle every wire message uses, it has to be
 * derived without asking the person for one more thing, it has to be readable in a config file, and
 * it has to be unique against what is already stored, because `templates.register` refuses a
 * duplicate id and a person shown that refusal would have no idea what they were being told.
 *
 * Derived from the **name the person typed**, not from the folder path. A template's name is the
 * thing they chose and the thing they will read in a menu — `Round Table` becomes `round-table`,
 * which is recognisable in the registry file next to the folder it points at. The folder's own name
 * is often `rt-template`, which names the template's *storage* rather than the template.
 *
 * Pure, and in its own module for the reason recorded on `folder-id.ts`: derived inline at the one
 * call site is how a rule ends up with no test that can see it.
 */

import { slugStem } from '../../core/slug'

/**
 * An id for `name` that is not already in `taken`.
 *
 * Collisions get a numeric suffix, matching annex A2's duplicate-filename rule and `folderIdFor` —
 * two different answers to "how do we number a repeat" is two things to remember. The server also
 * refuses a duplicate *name* outright, so a collision here is the narrow case of two different
 * names slugifying to the same stem (`Round Table` and `round-table`).
 *
 * Falls back to `template` when the name slugifies to nothing. §13.6's M16 guard exists because the
 * empty answer used to ship as a filename; here it would be an id of `''`, which every route would
 * then fail to resolve.
 */
export function templateIdFor(name: string, taken: Iterable<string>): string {
  const existing = new Set(taken)
  const base = slugStem(name) || 'template'
  if (!existing.has(base)) return base

  let suffix = 2
  while (existing.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}
