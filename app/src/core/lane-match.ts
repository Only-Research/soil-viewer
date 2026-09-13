/**
 * **WHICH LANE A DROPPED CARD MAY USE.** Split out of `board.ts`, and the split is not tidiness.
 *
 * `board.ts` mints lane ids with `createHash` from `node:crypto`. That is correct there — the digest
 * is the whole of §13.7's defence — but it makes the module **server-only**, and the client needs
 * this one rule. Importing it anyway pulled `node:crypto` into the browser bundle, where Vite
 * externalises it to a stub: **the app stopped mounting entirely**, and every browser test timed out
 * at thirty seconds with no error that named the cause.
 *
 * The types are unaffected — a type-only import is erased — so `Lane` and `Column` still live with
 * the code that produces them. Only this function had to move, because only this function is a
 * *value* the client calls.
 */

import type { Column, Lane } from './board'

/**
 * The lane in `column` a card of `cardSegments` may actually be dropped into, or `null`.
 *
 * **Here rather than in the view, because it is a rule and not a rendering.** The view will call it
 * on a drop; a test can call it directly. The alternative — a `find` inside a drag handler — is the
 * shape this build has repeatedly found unobservable, and getting it wrong does not look like a bug:
 * it looks like a drag that silently does nothing, or worse, one that lands in another project.
 *
 * **Longest match wins**, and that is not decoration. An op nested inside a project means a card can
 * sit under *both* `alpha` and `alpha/…/op-one`, and the lane it belongs to is the innermost one. A
 * first-match rule would put every op's card into its parent project's lane.
 */
export function laneForCard(
  column: Pick<Column, 'lanes'>, cardSegments: readonly string[],
): Lane | null {
  let best: Lane | null = null
  for (const lane of column.lanes) {
    const project = lane.origin.project
    /**
     * **Segment-wise, never a string prefix.** `02-projects/alpha-two` begins with
     * `02-projects/alpha` as text and is not inside it — spec §5's rule, which `IndexStore.subtree`
     * states in its own header after the same mistake bit the lab code.
     *
     * A length guard was written above this and **removed after a sweep showed it could not
     * change the outcome**: `every` on an index past the end compares against `undefined` and is
     * already false. A check that cannot fail is not protection, it is something that reads as
     * protection.
     */
    if (!project.every((segment, at) => cardSegments[at] === segment)) continue
    if (best === null || project.length > best.origin.project.length) best = lane
  }
  return best
}
