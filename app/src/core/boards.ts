/**
 * **FINDING THE BOARDS.** P14 B1, spec §3's grammar read a fifth way.
 *
 * A board is a folder named `board-<something>`, anywhere inside a registered folder. The operator's
 * call, and their reasoning: *"they would know because the name would be board-dash-anything… that's
 * probably the safest bet."* Boards are expected to be made in the app; the prefix is what makes one
 * recognisable if it was not.
 *
 * ## Why this reads the index rather than walking
 *
 * `search.quickOpen` states the rule this follows: *"the index is already the answer to 'every path
 * this app knows', and re-deriving it here would be a second enumeration."* A walk would also be a
 * second place for the archive and ignore rules to be applied, which is exactly how §3's three name
 * lists came to have three different semantics.
 *
 * ## Pure, and that is the point
 *
 * Nothing here touches a filesystem. It takes entries and returns boards, so every rule below —
 * archive exclusion, the no-nesting rule, ordering — is provable without a fixture tree.
 */

import type { EntryKind } from './fs/containment'
import { comparisonKey } from './paths'
import {
  UNCATEGORIZED_LANE_ID,
  UNCATEGORIZED_LANE_LABEL,
  boardDisplayName,
  compareLanes,
  isArchived,
  isBoardFolder,
  isContextName,
  isIgnoredPath,
  isMarkdown,
  typedName,
} from './grammar'

/**
 * The shape this module needs from an index row. Narrowed so tests need not build whole entries.
 *
 * **`kind` is the index's own `EntryKind`, not a two-value narrowing of it.** The first draft of
 * this file wrote `'file' | 'directory'` and the compiler refused it: the index holds a **third**
 * kind, `symlink`. Widening rather than casting is the point — a board test that only knows about
 * two kinds is one that has never considered the third, and §4 refuses symlinks everywhere
 * precisely because they are the thing that looks like a directory and is not.
 */
export interface BoardSource {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly kind: EntryKind
}

export interface BoardSummary {
  readonly rootId: string
  /** Folder-relative path to the board folder itself, last segment included. */
  readonly segments: readonly string[]
  /** `board-tuesday-drops` → "Tuesday drops". */
  readonly name: string
  /**
   * Where it lives, for the list — the path above it, joined.
   *
   * **Shown because two boards may share a name.** They create these by typing a subject, and
   * `board-notes` under two different projects is not a far-fetched collision; a list of identical
   * rows is the Inbox complaint they raised on 2026-08-18 arriving somewhere new.
   */
  readonly where: string
}

/**
 * A registered template folder. **Passed in rather than looked up**, because this module reaches no
 * registry and no filesystem — and `caseInsensitive` comes with each one because it is a property of
 * the volume that folder sits on, which only the caller knows.
 */
export interface TemplateFolder {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly caseInsensitive: boolean
}

/**
 * **A REGISTERED TEMPLATE IS NOT A BOARD.** The operator's board template is a folder called
 * `board-template`, so without this it would answer the grammar's question — correctly — and appear
 * in the Boards list as a board called *Template*, sitting among the real ones and offering to be
 * opened and filled in.
 *
 * A template is a **shape**, not a thing. That is true of the op and project templates too; boards
 * is simply the first tab whose grammar a template folder happens to match.
 *
 * Compared through `comparisonKey`, not `===`, for the reason §5 gives about paths: the same folder
 * spelled two ways is one folder, and deciding that with a raw string compare is how a rule ends up
 * holding on one machine and not another.
 */
function isRegisteredTemplate(
  entry: BoardSource, templates: readonly TemplateFolder[],
): boolean {
  return templates.some(template =>
    template.rootId === entry.rootId
    && comparisonKey(template.segments, template.caseInsensitive)
      === comparisonKey(entry.segments, template.caseInsensitive))
}

/**
 * Every board among these entries, in a stable display order.
 *
 * **Boards do not nest.** A `board-` folder inside another board is a *column* named `board-…`, not a
 * second board — stated here so the reader does not have to guess, and because the alternative is a
 * column that is secretly a board, which is the ambiguity §3 exists to kill.
 *
 * `templates` defaults to empty so every existing caller and test keeps its meaning; the exclusion is
 * an addition to the rules rather than a change to them.
 */
export function boardsIn(
  entries: Iterable<BoardSource>,
  templates: readonly TemplateFolder[] = [],
): BoardSummary[] {
  const found: BoardSummary[] = []

  for (const entry of entries) {
    if (entry.kind !== 'directory') continue

    const last = entry.segments[entry.segments.length - 1]
    if (last === undefined || !isBoardFolder(last)) continue

    if (isRegisteredTemplate(entry, templates)) continue

    /**
     * **§3's exclusions, applied here and not restated.** A board under `archive/` does not appear,
     * exactly as a project under `archive/` does not — *"a match at ANY ancestor level"*. The
     * ignore rule is asked separately because it covers dot-directories and `node_modules`, which
     * the archive rule says nothing about.
     */
    if (isArchived(entry.segments) || isIgnoredPath(entry.segments)) continue

    // The no-nesting rule: any board-named ancestor makes this a column, not a board.
    const ancestors = entry.segments.slice(0, -1)
    if (ancestors.some(isBoardFolder)) continue

    found.push({
      rootId: entry.rootId,
      segments: [...entry.segments],
      name: boardDisplayName(last),
      where: ancestors.join('/'),
    })
  }

  /**
   * **By name, then by where.** Not by root or by walk order: the walk's order is an artefact of how
   * the index happened to fill, and a list that reshuffles itself between visits is one you have to
   * re-read every time. `compareLanes` is reused rather than a bare string compare so a board that
   * *does* carry a numeric prefix sorts by it, consistently with every other ordered name here.
   */
  return found.sort((a, b) => {
    const byName = compareLanes(a.name, b.name)
    return byName !== 0 ? byName : (a.where < b.where ? -1 : a.where > b.where ? 1 : 0)
  })
}

// ---------------------------------------------------------------------------
// OPENING A BOARD — columns and cards. P14 B2.
// ---------------------------------------------------------------------------

/**
 * What this module needs from an index row to build a board's contents.
 *
 * Wider than `BoardSource` because a card is drawn, not just counted: it needs the file's name and
 * whatever title the indexer found. Kept as its own interface rather than pulling in `IndexEntry`
 * so the tests can state a row in one line and so `core` keeps owing nothing to the index's shape.
 */
export interface BoardContentSource extends BoardSource {
  readonly name: string
  /** First heading, or the filename. Display only — the indexer already resolved it. */
  readonly title: string
}

export interface BoardCard {
  readonly rootId: string
  /** Folder-relative path to the file itself. */
  readonly segments: readonly string[]
  readonly name: string
  readonly title: string
}

export interface BoardColumn {
  /**
   * The folder segment as it is on disk, or `UNCATEGORIZED_LANE_ID` for the synthetic one.
   *
   * **The raw segment, never the display name.** A move names a column by id, and a display name has
   * already had its `NN-` prefix stripped and its hyphens turned to spaces — naming a destination
   * with it would be handing the server a folder that does not exist.
   */
  readonly id: string
  readonly name: string
  /** Path to the column's folder. `null` for the synthetic column, which is not a folder. */
  readonly segments: readonly string[] | null
  readonly cards: readonly BoardCard[]
}

/**
 * **A board's columns and their cards.**
 *
 * - **A column is an immediate subfolder** of the board. Nothing deeper is a column.
 * - **A card is a markdown file directly in a column.** §3 already says *"only markdown becomes a
 *   task card"*; this is that rule, not a second one.
 * - **A subfolder inside a column is neither.** It is not drawn at all — which is what the operator's
 *   *"no nested cards"* means once it reaches disk. It is still in Files, where everything is.
 * - **Non-markdown in a column is not drawn either.** Inbox is the tab that shows other file types,
 *   deliberately.
 *
 * ## The synthetic column
 *
 * Markdown sitting in the board's **own** folder rather than in a column appears in a leftmost
 * `Uncategorized`, hidden when empty. The operator ruled this shape for Tasks on 2026-07-29 and named it
 * on 2026-08-06; boards reuses it, including the constants, so there is one label for one concept.
 *
 * **They did not rule it for boards** — recorded as owed in the P14 brief. The alternative is a file
 * an agent deliberately wrote that the board silently does not show, which is the same
 * complete-but-unreachable defect this build has found four separate times.
 */
export function boardContents(
  entries: Iterable<BoardContentSource>,
  board: { readonly rootId: string; readonly segments: readonly string[] },
): BoardColumn[] {
  const depth = board.segments.length
  const columns = new Map<string, { name: string; segments: string[]; cards: BoardCard[] }>()
  const loose: BoardCard[] = []

  for (const entry of entries) {
    if (entry.rootId !== board.rootId) continue
    if (entry.segments.length <= depth) continue

    // Under this board, and compared segment by segment — §5 forbids comparing paths by prefix.
    let under = true
    for (let at = 0; at < depth; at += 1) {
      if (entry.segments[at] !== board.segments[at]) { under = false; break }
    }
    if (!under) continue

    const rest = entry.segments.slice(depth)

    /**
     * **A card, loose in the board's own folder.** One segment below the board, a file, markdown.
     */
    if (rest.length === 1) {
      const only = rest[0] ?? ''
      /**
       * **`00-context` is not a column.** The operator's board template is a context folder and nothing
       * else, so without this every board scaffolded from it opens showing a column called *Context*
       * holding their context file and their m-thread — a column they did not make and cannot use.
       *
       * **Their own scaffold skill already says so:** a board *"scaffolds with NO columns at all"* and
       * *"a new board is empty by design."* Drawing one would put the viewer in contradiction with
       * the thing that creates these folders.
       *
       * It is the same call they made for the Inbox on 2026-08-21 — *"I don't want to see
       * 00-context"* — and the same reasoning: context is furniture that every unit of work in the
       * soil carries, not something someone put on this board.
       *
       * **The files inside it simply do not appear.** They are two segments below the board, so
       * without a column to belong to they are nothing here — which is right: they are the board's
       * paperwork, reachable in Files, not cards to be moved between lanes.
       */
      if (entry.kind === 'directory' && !isIgnoredPath([only]) && !isContextName(only)) {
        // A column. Registered even when empty — a column you made and have not filled is a column.
        columns.set(only, {
          name: typedName(only),
          segments: [...entry.segments],
          cards: columns.get(only)?.cards ?? [],
        })
        continue
      }
      if (entry.kind === 'file' && isMarkdown(entry.name)) {
        loose.push({
          rootId: entry.rootId, segments: [...entry.segments], name: entry.name, title: entry.title,
        })
      }
      continue
    }

    /**
     * **A card in a column.** Exactly two segments below the board — no deeper.
     *
     * `rest.length !== 2` is what enforces *"no nested cards"*: a markdown file three levels down
     * sits in a subfolder of a column, and drawing it as a card would put a card on the board whose
     * position cannot be expressed by moving it between columns.
     */
    if (rest.length !== 2) continue
    if (entry.kind !== 'file' || !isMarkdown(entry.name)) continue

    const columnId = rest[0] ?? ''
    /**
     * **The context rule is asked here too, and the first version was not.**
     *
     * The branch above skips the context *folder*, and this branch creates a column from a **card's**
     * path when the folder's own row has not been seen yet — an index is a bag, not an ordered walk.
     * So guarding only the folder left the column appearing anyway, conjured out of the two files
     * inside it, on whichever runs happened to see a file first. Caught by the test, not by reading.
     */
    if (isIgnoredPath([columnId]) || isContextName(columnId)) continue

    const existing = columns.get(columnId)
    const card: BoardCard = {
      rootId: entry.rootId, segments: [...entry.segments], name: entry.name, title: entry.title,
    }
    if (existing === undefined) {
      /**
       * **The column's own row may not have been seen yet**, because an index is a bag and not a
       * tree walk in order. Created from the card's path rather than skipping the card — dropping it
       * would make a card's visibility depend on iteration order, which is the least debuggable
       * defect shape there is.
       */
      columns.set(columnId, {
        name: typedName(columnId),
        segments: [...board.segments, columnId],
        cards: [card],
      })
    } else {
      existing.cards.push(card)
    }
  }

  const byName = (a: { name: string }, b: { name: string }): number => compareLanes(a.name, b.name)

  const ordered: BoardColumn[] = [...columns.entries()]
    .sort(([a], [b]) => compareLanes(a, b))
    .map(([id, column]) => ({
      id,
      name: column.name,
      segments: column.segments,
      /**
       * **By name, deterministically, and B3 replaces this with the remembered arrangement.**
       * Walk order is an artefact of how the index filled and changes on a restart; a board that
       * reshuffles itself between visits is one nobody can rely on.
       */
      cards: [...column.cards].sort(byName),
    }))

  // Leftmost, and absent entirely when empty — §3's rule for the Tasks lane, unchanged.
  if (loose.length > 0) {
    ordered.unshift({
      id: UNCATEGORIZED_LANE_ID,
      name: UNCATEGORIZED_LANE_LABEL,
      segments: null,
      cards: [...loose].sort(byName),
    })
  }

  return ordered
}
