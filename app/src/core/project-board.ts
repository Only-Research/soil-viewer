/**
 * The Projects board. PRD's Projects tab, the operator's Trello framing of 2026-08-10.
 *
 * **Two kinds of card, one board, and the difference is whether a folder exists.**
 *
 * A *project card* is a folder the grammar recognises — it appears by itself, because the operator
 * confirmed the PRD's rule stands: *"newly scaffolded project appears on the board by itself."* Its
 * column is app config; **nothing about dragging it touches disk.** Their words, and the one thing they
 * was conclusive about: *"when I drag stuff around that board nothing is supposed to happen on
 * disk."*
 *
 * A *staged card* is a plan. A name and a description and no folder at all — *"I know I'm gonna
 * need to do this project… it doesn't mean I wanna scaffold the folder just yet."* It is the
 * missing visual they named: *"to be able to see my plans."*
 *
 * ## Why this board is the opposite of the Tasks board, deliberately
 *
 * On Tasks, a lane **is** a folder and a drag **is** a move — §13.7's M2 exists because a lane drag
 * that composed a path could resurrect a deleted folder. Here a column is not a folder and a drag
 * writes one line of config. Two boards, one gesture, opposite consequences, and that asymmetry is
 * a decision rather than an accident: on Tasks the folder is the status, and on Projects the folder
 * is the thing being arranged.
 *
 * The safety consequence is worth stating plainly: **nothing in this file can create, move, rename
 * or delete anything.** It reads the index and it reads config. There is no path composition here
 * at all.
 *
 * ## Placement survives a rename, for free
 *
 * A project's column is stored as a `PathKey` — `(rootId, segments) → value` — and
 * `retargetPathKeys` already rewrites those when a folder is renamed or moved, on the same code
 * path `entry.rename` and `card.move` use. So filing a project under Active and then renaming its
 * folder in Finder keeps it under Active. `PathKey`'s own comment has named this board as its
 * example since Phase 1; this is the first thing to use it.
 */

import type { PathKey, ProjectColumn, StagedCard, UiStateFile } from './fs/config-store'
import type { IndexStore } from './index-store'
import { projectsOf, type ProjectSummary } from './projects'
import { comparisonKey } from './paths'

/**
 * The columns a board has before anybody arranges one. Ruled 2026-08-10: *"the three statuses
 * should be active, next, back burner, you know, whatever we have for the other thing, like,
 * uncategorized or whatever."*
 *
 * **Unfiled is last, and that is a judgement rather than a rule.** The Tasks board puts its
 * synthetic lane leftmost (§3), and consistency argues for the same here — but every project starts
 * unfiled, so leftmost would open the board on a wall of sixty-six cards with the three columns they
 * actually asked for pushed off the right edge. What they said the board is *for* is seeing their
 * plans, and their plans are in the other three.
 */
export const DEFAULT_PROJECT_COLUMNS: readonly ProjectColumn[] = [
  { id: 'active', name: 'Active' },
  { id: 'next', name: 'Next' },
  { id: 'back-burner', name: 'Back Burner' },
  { id: 'unfiled', name: 'Unfiled' },
]

/** Where an unplaced project goes. The last column, so it is the board's inbox rather than its face. */
export const UNFILED_COLUMN_ID = 'unfiled'

/** A card on the Projects board. Either a folder or a plan; never both, never neither. */
export type ProjectCard =
  | {
    readonly kind: 'project'
    readonly columnId: string
    readonly project: ProjectSummary
  }
  | {
    readonly kind: 'staged'
    readonly columnId: string
    readonly card: StagedCard
  }

export interface ProjectBoard {
  readonly columns: readonly ProjectColumn[]
  readonly cards: readonly ProjectCard[]
}

/** The stored column set, or the defaults when nobody has arranged one yet. */
export function columnsOf(state: UiStateFile): readonly ProjectColumn[] {
  return state.projectColumns.length === 0 ? DEFAULT_PROJECT_COLUMNS : state.projectColumns
}

/**
 * The key under which a project's column is stored. `board:` namespaces it, because `pathKeys` is a
 * general path-addressed store and a second feature keying the same path would otherwise collide
 * with this one silently.
 */
interface Placement { readonly board?: string }

function placementOf(keys: readonly PathKey[], rootId: string, segments: readonly string[],
  caseInsensitive: boolean): string | null {
  const wanted = comparisonKey(segments, caseInsensitive)
  for (const key of keys) {
    if (key.rootId !== rootId) continue
    if (comparisonKey(key.segments, caseInsensitive) !== wanted) continue
    const value = key.value as Placement | null
    if (value !== null && typeof value === 'object' && typeof value.board === 'string') {
      return value.board
    }
  }
  return null
}

/**
 * Writes a project's column into the path-keyed store, replacing any existing placement.
 *
 * **Merged into the key's existing value rather than replacing it.** `pathKeys` is shared, and a
 * second feature storing something against the same folder must not be erased by filing a project
 * — which is the same mistake `retargetPathKeys` made by rebuilding its whole state from a literal.
 */
/**
 * **P9-9 — a value this function does not understand is preserved, never replaced.**
 *
 * security review, P9 review: *"`withPlacement` replaces a non-object value instead of merging."*
 *
 * `PathKey.value` is typed `unknown` **on purpose** — it is a bag of per-path config, and this
 * function owns exactly one property in it. Anything else there belongs to something else, present
 * or future, and this code has no standing to delete it. That is the same argument P9-6 settled one
 * level down for unrecognised config keys, and §13.8 settled below that for unresolved path keys:
 * **retained, not dropped.**
 *
 * **The array case is the sharp one, and it is not what the finding describes.** `typeof [] ===
 * 'object'` and an array is not null, so the old test admitted one — and spreading `[1, 2]` into an
 * object produces `{ 0: 1, 1: 2, board: … }`. That is worse than the reported failure, because it
 * looks like it merged.
 *
 * So: a **plain object** is merged into, and anything else is kept under `previousValue` rather than
 * thrown away. The name is deliberately not a word this app uses elsewhere, so it reads as what it
 * is — a thing rescued from a shape nobody planned for.
 */
/**
 * **Exported for `board-order.ts`, so P14 does not grow a second copy of a rule the security review reviewed.**
 * P9-9 is the whole argument above; duplicating it is exactly the drift it was written to end.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function placedInto(value: unknown, columnId: string): Record<string, unknown> {
  if (isPlainObject(value)) return { ...value, board: columnId }
  // `undefined` is the ordinary "nothing here yet" case and is not something to rescue.
  return value === undefined
    ? { board: columnId }
    : { previousValue: value, board: columnId }
}

export function withPlacement(
  state: UiStateFile,
  rootId: string,
  segments: readonly string[],
  columnId: string,
  caseInsensitive: boolean,
): UiStateFile {
  const wanted = comparisonKey(segments, caseInsensitive)
  let replaced = false
  const pathKeys = state.pathKeys.map(key => {
    if (key.rootId !== rootId) return key
    if (comparisonKey(key.segments, caseInsensitive) !== wanted) return key
    replaced = true
    return { ...key, value: placedInto(key.value, columnId) }
  })
  if (!replaced) {
    pathKeys.push({ rootId, segments: [...segments], value: { board: columnId } })
  }
  return { ...state, pathKeys }
}

/**
 * The whole board: the columns, every project as a card, and every staged plan.
 *
 * **A card whose stored column no longer exists falls back to Unfiled rather than vanishing.**
 * Renaming a column is allowed and deleting one is possible, and a card that silently disappeared
 * because its column did would read as lost work. Falling back is visible and recoverable.
 */
export function projectBoardOf(
  index: IndexStore,
  state: UiStateFile,
  roots: ReadonlyArray<{ readonly id: string; readonly caseInsensitive: boolean }>,
): ProjectBoard {
  const columns = columnsOf(state)
  const known = new Set(columns.map(column => column.id))
  const fallback = known.has(UNFILED_COLUMN_ID)
    ? UNFILED_COLUMN_ID
    // A board whose columns were renamed away from `unfiled` still has to put unplaced projects
    // somewhere, and the last column is where this board's inbox lives by construction.
    : columns[columns.length - 1]?.id ?? UNFILED_COLUMN_ID

  const cards: ProjectCard[] = []

  for (const root of roots) {
    for (const project of projectsOf(index, root.id, root.caseInsensitive)) {
      const placed = placementOf(state.pathKeys, root.id, project.segments, root.caseInsensitive)
      cards.push({
        kind: 'project',
        columnId: placed !== null && known.has(placed) ? placed : fallback,
        project,
      })
    }
  }

  for (const staged of state.stagedCards) {
    cards.push({
      kind: 'staged',
      columnId: known.has(staged.columnId) ? staged.columnId : fallback,
      card: staged,
    })
  }

  return { columns, cards }
}
