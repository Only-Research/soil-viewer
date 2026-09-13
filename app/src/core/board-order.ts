/**
 * **THE ARRANGEMENT, HELD OUTSIDE THE TREE.** P14 B3.
 *
 * The one genuinely new idea in Boards, and it is the operator's against my proposal. I offered numeric
 * filename prefixes — the soil's own convention, which the app already hides when displaying a name.
 * They declined:
 *
 * > *"They don't need to be numbered. They don't need to reflect the order in the actual folders. As
 * > long as they will hold state in the order that they're in on the boards, that's fine enough for
 * > me."*
 *
 * **They were right, and the reason is not obvious.** Numbering makes order a property of the
 * *filenames*, so anything writing into a column has to know the convention or it scrambles the
 * board. Their agents write into these folders constantly. The app would also be renaming their files
 * behind them to keep a sequence tidy — the app touching the tree for its own convenience.
 *
 * With the order held here instead, **an agent cannot scramble a board.** A file that arrives is a
 * card at the bottom, and nothing is renamed.
 *
 * ## Where it lives
 *
 * `UiStateFile.pathKeys` — the app's own state file on the Mac, which the operator confirmed explicitly
 * (*"Yes, I mean the second"*), so one arrangement covers their phone and their desktop and survives a
 * cleared browser. Namespaced under `cardOrder` on the **column's** key, because `pathKeys` is a
 * shared store and the Projects board already keeps `board` on the same kind of key.
 */

import { comparisonKey } from './paths'
import type { PathKey, UiStateFile } from './fs/config-store'
import { isPlainObject } from './project-board'

/**
 * The namespace. `board:`-style prefixing is what stops a second feature keying the same path from
 * colliding with this one silently — the reasoning `project-board.ts` states for its own key.
 */
const CARD_ORDER = 'cardOrder'

/**
 * **The same mechanism, one level up.** Ruled 2026-08-21, on board columns: *"it doesn't need or
 * use any numbering system, just the ability to move around the columns to different orders and have
 * the app remember where I put them."*
 *
 * Cards are arranged against their **column**; columns are arranged against their **board**. Same
 * store, same merge rule, same "anything unrecognised goes to the bottom" — which is why this is a
 * second namespace rather than a second implementation.
 *
 * **Boards only. Tasks does not change** — they were explicit: *"tasks, those are in proper order."*
 * A Tasks lane comes from a fixed roster the app owns and keeps sorting by its `NN-` prefix.
 */
const COLUMN_ORDER = 'columnOrder'

/**
 * The remembered order for one column, or an empty list when there is none.
 *
 * **Empty means "not arranged yet", not "arranged into nothing"** — the same distinction
 * `UiStateFile.projectColumns` documents. A column never touched has no stored arrangement to drift
 * from what the disk says.
 */
function orderOf(
  state: UiStateFile,
  rootId: string,
  segments: readonly string[],
  caseInsensitive: boolean,
  key2: string,
): readonly string[] {
  const wanted = comparisonKey(segments, caseInsensitive)
  for (const key of state.pathKeys) {
    if (key.rootId !== rootId) continue
    if (comparisonKey(key.segments, caseInsensitive) !== wanted) continue
    const stored = key.value as Record<string, unknown> | null
    if (isPlainObject(stored) && Array.isArray(stored[key2])) {
      // Every entry must be a string: a hand-edited or older state file can hold anything, and a
      // number here would silently never match a filename rather than failing where it was written.
      return (stored[key2] as unknown[])
        .filter((name): name is string => typeof name === 'string')
    }
  }
  return []
}

/**
 * **Apply a remembered order to what is actually on disk.** The three rules, all the operator's.
 *
 * 1. **Remembered names keep their positions.**
 * 2. **Anything on disk and not in the list goes to the BOTTOM.** They reversed my suggestion of the
 *    top: *"that's what Trello does, that's what's intuitive, sorted from oldest to newest."*
 * 3. **A remembered name with no file behind it contributes nothing.** No ghost rows. A card renamed
 *    or moved outside the app simply lands wherever it lands.
 *
 * `present` arrives already in a deterministic order (by name, from `boardContents`), so the
 * arrivals at the bottom are themselves stable rather than in whatever order the index filled.
 */
export function applyCardOrder<T>(
  present: readonly T[],
  nameOf: (item: T) => string,
  stored: readonly string[],
): T[] {
  const byName = new Map<string, T[]>()
  for (const item of present) {
    const name = nameOf(item)
    const bucket = byName.get(name)
    if (bucket === undefined) byName.set(name, [item])
    else bucket.push(item)
  }

  const ordered: T[] = []
  const taken = new Set<T>()

  for (const name of stored) {
    const bucket = byName.get(name)
    // Rule 3 — a name with nothing behind it is skipped, never rendered as an empty row.
    if (bucket === undefined || bucket.length === 0) continue
    const item = bucket.shift() as T
    ordered.push(item)
    taken.add(item)
  }

  // Rule 2 — arrivals at the bottom, in the deterministic order they came in.
  for (const item of present) {
    if (!taken.has(item)) ordered.push(item)
  }

  return ordered
}

/**
 * **ONE MOVEMENT RULE, shared by every control that moves anything on a board.**
 *
 * ruled 2026-08-21, on the menu the columns shipped with: *"clicking the dot and then clicking
 * move right — if I want to move something all the way over, it's messy."* The answer is arrows on
 * the column head for a nudge and an arrange panel for the long haul, and **both are this function**
 * — a swap and a send-to-the-end are the same operation with different arguments.
 *
 * Written once rather than three times because the two-line version is where an off-by-one turns
 * into a **duplicated id**, and a duplicated id draws a column twice. The inline swap this replaces
 * carried a comment saying exactly that, which is the argument for it being a tested function
 * instead of a careful comment.
 *
 * An out-of-range or unchanged move returns a copy and nothing else — the caller's guard rail, so a
 * control at the end of the row cannot scramble anything by being pressed.
 */
export function moveWithin<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  if (from < 0 || from >= next.length) return next
  if (to < 0 || to >= next.length || to === from) return next
  const moved = next.splice(from, 1)[0] as T
  next.splice(to, 0, moved)
  return next
}

/**
 * **WHERE A DROPPED CARD ACTUALLY LANDS.** Ruled 2026-08-22, on the difference they felt between
 * the two boards: *"I'm not able to grab an item and move it. I want to be able to grab it and move
 * an item between, and then rearranging."*
 *
 * A drop knows two things: the destination column as it is **drawn**, and which drawn card the
 * pointer was above. Turning that into an index is one line and one off-by-one, and the off-by-one
 * only appears when a card is dragged **downwards within its own column** — the commonest drag there
 * is, and the one a hand test is least likely to notice, because it lands one place short.
 *
 * `before` is the drawn position the card was dropped in front of: `0` for the top, `count` for past
 * the last card. `from` is where the dragged card already sits **in this same column**, or `null`
 * when it is arriving from another one.
 *
 * **Removing happens before inserting.** So when a card moves down its own column, every drawn
 * position after it has already shifted up by one by the time it is put back — which is why `before`
 * is decremented and why an upward move is not.
 */
export function droppedAt(before: number, from: number | null, count: number): number {
  const target = Math.max(0, Math.min(before, count))
  if (from === null) return target
  return from < target ? target - 1 : target
}

/**
 * Writes a column's card order into the path-keyed store.
 *
 * **Merged into the key's existing value, never replacing it**, and `isPlainObject` is imported from
 * `project-board.ts` rather than copied so P14 does not grow a second version of a rule the security review
 * reviewed under P9-9. The sharp case that rule exists for: `typeof [] === 'object'`, so a naive
 * merge spreads `[1, 2]` into `{ 0: 1, 1: 2, … }` — worse than clobbering, because it looks like it
 * worked.
 *
 * **Every other key is carried through untouched, including unresolved ones.** §13.8: a path missing
 * at load is **retained, not dropped** — an unplugged volume this morning is plugged in this
 * afternoon, and erasing an arrangement someone made by hand is a silent permanent loss.
 */
function withOrder(
  state: UiStateFile,
  rootId: string,
  segments: readonly string[],
  order: readonly string[],
  caseInsensitive: boolean,
  key2: string,
): UiStateFile {
  const wanted = comparisonKey(segments, caseInsensitive)
  let replaced = false

  const pathKeys: PathKey[] = state.pathKeys.map(key => {
    if (key.rootId !== rootId) return key
    if (comparisonKey(key.segments, caseInsensitive) !== wanted) return key
    replaced = true
    return { ...key, value: orderedInto(key.value, order, key2) }
  })

  if (!replaced) {
    pathKeys.push({ rootId, segments: [...segments], value: { [key2]: [...order] } })
  }

  return { ...state, pathKeys }
}

function orderedInto(value: unknown, order: readonly string[], key: string): Record<string, unknown> {
  if (isPlainObject(value)) return { ...value, [key]: [...order] }
  // `undefined` is the ordinary "nothing here yet" case and is not something to rescue.
  return value === undefined
    ? { [key]: [...order] }
    : { previousValue: value, [key]: [...order] }
}

/** A column's cards, in the order the operator left them. */
export const cardOrderOf = (
  state: UiStateFile, rootId: string, segments: readonly string[], caseInsensitive: boolean,
): readonly string[] => orderOf(state, rootId, segments, caseInsensitive, CARD_ORDER)

export const withCardOrder = (
  state: UiStateFile, rootId: string, segments: readonly string[],
  order: readonly string[], caseInsensitive: boolean,
): UiStateFile => withOrder(state, rootId, segments, order, caseInsensitive, CARD_ORDER)

/**
 * A **board's columns**, in the order they left them. Keyed against the board's own folder.
 *
 * Column ids are folder segments, exactly as card names are filenames — so `applyCardOrder` above
 * arranges either without knowing which it has. That is the whole reason this is a namespace and
 * not a second implementation.
 */
export const columnOrderOf = (
  state: UiStateFile, rootId: string, segments: readonly string[], caseInsensitive: boolean,
): readonly string[] => orderOf(state, rootId, segments, caseInsensitive, COLUMN_ORDER)

export const withColumnOrder = (
  state: UiStateFile, rootId: string, segments: readonly string[],
  order: readonly string[], caseInsensitive: boolean,
): UiStateFile => withOrder(state, rootId, segments, order, caseInsensitive, COLUMN_ORDER)
