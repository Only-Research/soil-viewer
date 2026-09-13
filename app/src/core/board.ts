/**
 * Lanes, lane identity, and where a dragged card is allowed to land. Spec §3 and §13.7's M2.
 *
 * **The bug this module exists to make unrepresentable.** §13.7: *"The move-mkdir exception
 * resurrects folders an agent deliberately removed (M2). A lane drag is a move, and the destination
 * lane was a client-supplied string — so a stale board plus a renamed lane materializes a ghost
 * lane. Since folders **are** the database, that is structural corruption."*
 *
 * The fix has three parts and all three are here:
 *
 *   1. **The client never names a path.** It names a `laneId`, which is a digest — see `laneIdFor`.
 *      There is no string a client can send that means "make a folder called this".
 *   2. **The destination is resolved server-side from the current index.** A lane that is not in
 *      the index right now cannot be resolved, whatever the client is holding.
 *   3. **A lane that is gone is refused, and the caller is told to reload**, rather than the move
 *      being helpfully reinterpreted.
 *
 * Nothing here creates a directory. §13.3: *"writes never create directories"* — and the move-mkdir
 * exception is exactly the hole that rule was written with and then given.
 */

import { createHash } from 'node:crypto'

import { ErrorCode, fail, ok, type Result } from './errors'
import {
  UNCATEGORIZED_LANE_ID,
  UNCATEGORIZED_LANE_LABEL,
  compareLanes,
  isTasksDir,
  TEMPLATE_TASKS_PATH,
  laneDisplayName,
  lanePlacementOf,
  isArchived,
  enclosingProject,
} from './grammar'
import type { IndexEntry, IndexStore } from './index-store'
import { comparisonKey } from './paths'

/** A lane as the client sees it: an opaque id, a name, and nothing it could turn into a path. */
export interface Lane {
  readonly id: string
  readonly name: string
  /** True for the synthetic Uncategorized lane, which is never a folder on disk. Spec §3. */
  readonly synthetic: boolean
  /**
   * **Which project this lane belongs to.** Added in P11 for the gathered board, and it serves two
   * needs at once rather than being carried for one.
   *
   * 1. **A drop has to pick.** A merged column holds several lanes; `card.move` resolves against the
   *    *card's own* project and refuses anything else — correctly, since dragging changes a task's
   *    status and not which project it is in. Without this the client cannot tell which of a
   *    column's ids to send, and every cross-project drag is refused.
   * 2. **The card tag the operator asked for**, verbatim: *"it'd be nice if a card said, hey, this is
   *    part of this op."*
   *
   * **This is a project path, never a destination.** §6's rule is that a client may not compose a
   * path a mutation acts on, and that is untouched: the only thing `card.move` accepts is still the
   * opaque `id` above. These segments are for matching and for display, and the server re-derives
   * everything regardless of what the client believes.
   */
  readonly origin: LaneOrigin
}

export interface LaneOrigin {
  /** The project or op folder, folder-relative. The same segments the index holds. */
  readonly project: readonly string[]
  /** Its folder name, unprettified — the client decides how to draw it. */
  readonly name: string
}


/**
 * The opaque id for one lane. **Deliberately not a path, and deliberately not stored.**
 *
 * A digest over `(rootId, project, lane)` rather than an allocated token, because a token needs a
 * server-side table that has to be invalidated, and a table that is not invalidated is a second
 * stale copy of the thing whose staleness caused M2 in the first place. A digest is stateless: it
 * matches iff the lane it names is enumerated from the index *now*.
 *
 * **What it buys over sending the path:** there is no id a client can construct that resolves to a
 * directory which is not currently a lane of that project. A stale id resolves to nothing and is
 * refused — it can never resolve to "somewhere plausible".
 *
 * The root's own case-sensitivity decides the folding, via `comparisonKey`. Hashing the raw segments
 * would give one lane two different ids on a case-insensitive volume depending on how it was typed,
 * and the client would then hold an id that stops matching for no visible reason.
 */
export function laneIdFor(
  rootId: string,
  project: readonly string[],
  tasks: readonly string[],
  lane: string | null,
  caseInsensitive: boolean,
): string {
  const key = [
    rootId,
    comparisonKey(project, caseInsensitive),
    /**
     * **THE TASKS FOLDER IS PART OF THE IDENTITY, and leaving it out moved files.** (security review, P9-1.)
     *
     * The digest used to be `(rootId, project, lane)`. But `tasksDirOf` searches the project's whole
     * subtree and takes the shallowest match, so a project holding **two** folders named `tasks`
     * with a lane of the same name in each produced **one id for two directories**. The board would
     * be drawn from one and a drag resolved into the other — demonstrated end to end: a card moved
     * out of `02-work/tasks/01-urgent/` into `tasks/01-urgent/` on a drop onto the lane it was
     * already sitting in. Silent, and it relocates a real file.
     *
     * **CORRECTED 2026-08-12 by a read-only scan of the whole soil.** This claimed *"two projects in
     * the user's soil own more than one tasks folder today, one of them with the same four lane names
     * in both."* Grouped by owning project across all 38 `tasks/` folders, **no project owns two.**
     * The exposure is not "zero by luck" — the shape does not exist in that tree.
     *
     * The identity change is still right, and the reason is unchanged: it makes the id name a
     * *place* rather than a label, so a shape that does not exist today cannot become a silent
     * wrong-write tomorrow. What was wrong was the claim that it was already reachable — an
     * environment assertion carried in a comment without anyone running the command that settles
     * it, which the build record now notes as having cost this build three times.
     *
     * Including the resolved directory makes the id name a *place* rather than a label. A client
     * holding an id from a board drawn against the other folder simply fails to match, and §13.7's
     * `STALE_TARGET` refusal fires — the behaviour that already exists for a renamed lane.
     */
    comparisonKey(tasks, caseInsensitive),
    lane === null ? UNCATEGORIZED_LANE_ID : comparisonKey([lane], caseInsensitive),
  ].join('\u0000')
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Every lane of one project, as the board would show them. Spec §3.
 *
 * **Uncategorized is included only when it has cards**, because §3 says so — *"Uncategorized is
 * hidden when empty"* — and because a synthetic lane offered as a drop target when nothing is in it
 * invites a move whose only effect is to make a lane appear.
 *
 * Real lanes are the immediate subfolders of the project's `tasks` directory that the index knows
 * about. Not `LANES` from the grammar: that constant is the *conventional* set, and a project with
 * a folder the convention does not name still has that folder, and a card can still be in it.
 */
export function lanesOf(
  index: IndexStore,
  rootId: string,
  project: readonly string[],
  caseInsensitive: boolean,
): Lane[] {
  return placedLanesOf(index, rootId, project, caseInsensitive).map(placed => placed.lane)
}

/**
 * **THE GATHERED BOARD.** P11's Scope facet, ruled 2026-08-12:
 *
 * > *"they would all collapse into one next column. Sometimes it's just good to see all your tasks
 * > across different projects, especially with nesting. If I'm looking at Holdings Group, and I'm
 * > in my consulting company folder, I want to see all of my tasks across all my projects."*
 *
 * A board is pointed at a **folder**, not at a project, and shows everything beneath it. One
 * project is the degenerate case rather than a separate mode.
 */
export interface Column {
  /** What lanes were merged on. Opaque; the client never needs to read it. */
  readonly key: string
  readonly name: string
  readonly synthetic: boolean
  /**
   * Every real lane feeding this column, each keeping **its own id**.
   *
   * The column is a display grouping and is deliberately *not* addressable: there is no such folder
   * as "every Next under this company", so a column id would be a name for a place that does not
   * exist — which is the whole class of bug `laneIdFor` was built to make unrepresentable. A drop
   * still targets one lane, and the lane ids here are the same digests a single-project board mints.
   */
  readonly lanes: readonly Lane[]
}

/**
 * Every tasks directory at or beneath `scope` that a project actually owns.
 *
 * **All of them, unlike `tasksDirOf`, and that is the point rather than an oversight.** That
 * function answers "which folder does *this project* mean" and must return one, because a lane id
 * has to name one place. This answers "what is under here", and a project owning two tasks folders
 * contributes both — each lane keeping a distinct id, so nothing becomes ambiguous by being shown
 * together.
 *
 * **Ownership is still required.** A stray `tasks/` folder that no project encloses is not a board:
 * the same rule `tasksDirOf` applies, applied here, so the two cannot disagree about what counts.
 */
export function tasksDirsUnder(
  index: IndexStore,
  rootId: string,
  scope: readonly string[],
  caseInsensitive: boolean,
): string[][] {
  const found: string[][] = []
  for (const entry of index.subtree(rootId, scope)) {
    if (entry.kind !== 'directory' || !isTasksDir(entry.name)) continue
    if (isArchived(entry.segments)) continue
    if (enclosingProject(entry.segments.slice(0, -1)) === null) continue
    found.push([...entry.segments])
  }
  /**
   * Sorted, because `subtree` walks a Map and its order is an implementation detail. P9-7 is the
   * precedent: a tie left to Map order made a board draw from a different folder between two
   * identical requests. Sorting on the comparison key rather than the raw path uses the same
   * folding the rest of this file compares by.
   */
  return sortedDirs(found, caseInsensitive)
}

/** One ordering for every list of tasks folders, so two callers cannot disagree about it. */
function sortedDirs(dirs: string[][], caseInsensitive: boolean): string[][] {
  return dirs.sort((a, b) =>
    comparisonKey(a, caseInsensitive) < comparisonKey(b, caseInsensitive) ? -1 : 1)
}

/**
 * Which projects a board is showing. **Empty means every project**, which is the default.
 *
 * ruled 2026-08-12: *"defaults to all. And then I can pick other projects that I want to show in
 * the board. That's really all I need to filter."* Empty-means-all rather than a separate "show
 * everything" flag: a flag would be a second state that can disagree with the list, and the first
 * thing anyone does is tick a box and forget to clear the flag.
 *
 * A selected project contributes **its own** tasks folders, not its descendants'. A parent and its
 * children are separate rows in the picker, so "everything in Holdings Group" is ticking four
 * boxes rather than a mode.
 */
export type Selection = readonly (readonly string[])[]

/** The tasks folders a selection resolves to. Empty selection means every project's. */
function selectedTasksDirs(
  index: IndexStore,
  rootId: string,
  selection: Selection,
  caseInsensitive: boolean,
): string[][] {
  if (selection.length === 0) return tasksDirsUnder(index, rootId, [], caseInsensitive)

  /**
   * **ONE index pass, whatever the selection holds.** (security review, P11 C1.)
   *
   * The first version called a per-project helper once per selected project, and each call walked
   * the **entire** index. Measured on an 800-project tree: the empty selection cost 35ms and
   * ticking every project cost **13.4 seconds** — a factor of 384 for the identical board. The
   * pathology was the inversion itself, because the picker exists so the operator can widen: *"I pick
   * Holdings Group and then under it are the three projects within it."* The control that makes
   * wide selections easy was the control that made them expensive.
   *
   * The selection becomes a **prepared key set** and the index is read once, so cost is governed by
   * the size of the tree rather than by how much of it you asked for.
   */
  const wanted = new Set(selection.map(project => comparisonKey(project, caseInsensitive)))

  /**
   * **Deduplicated, and now the dedup actually saves the work.** Two selected projects can name the
   * same folder — a parent and a child both ticked. Before, `seen` was consulted *after* each
   * project's index walk, so 512 copies of one project still cost 4.1 seconds; there is only one
   * walk to consult it in now.
   */
  const seen = new Set<string>()
  const found: string[][] = []
  for (const entry of index.subtree(rootId, [])) {
    if (entry.kind !== 'directory' || !isTasksDir(entry.name)) continue
    if (isArchived(entry.segments)) continue
    const owner = enclosingProject(entry.segments.slice(0, -1))
    if (owner === null || !wanted.has(comparisonKey(owner, caseInsensitive))) continue
    const key = comparisonKey(entry.segments, caseInsensitive)
    if (seen.has(key)) continue
    seen.add(key)
    found.push([...entry.segments])
  }
  return sortedDirs(found, caseInsensitive)
}

/**
 * The columns of a board for a selection of projects, with same-named lanes merged.
 *
 * **Merged on the folder segment through `comparisonKey`, never on the display name.** Two reasons,
 * and both are bugs this build has already paid for once. `laneDisplayName` strips the numeric
 * prefix, so `01-urgent` and `03-urgent` would merge into one column and lose the ordering the
 * prefixes exist to carry. And byte equality would split `02-café` from its NFD twin into two
 * columns that render identically — §4's normalisation exists precisely so that cannot happen.
 *
 * **Uncategorized merges with Uncategorized and with nothing else.** It is the *absence* of a lane,
 * so its key is the grammar's sentinel rather than a folder name. A project that happens to own a
 * folder literally called `uncategorized` keeps its own column: they are different places, and
 * showing them as one would mean a drop landing somewhere the reader did not point at.
 */
export function columnsFor(
  index: IndexStore,
  rootId: string,
  selection: Selection,
  caseInsensitive: boolean,
): Column[] {
  interface Building { readonly segment: string; readonly column: Lane[]; readonly first: Lane }
  const byKey = new Map<string, Building>()

  for (const tasks of selectedTasksDirs(index, rootId, selection, caseInsensitive)) {
    const project = enclosingProject(tasks.slice(0, -1))
    if (project === null) continue
    for (const placed of placedLanesIn(index, rootId, project, tasks, caseInsensitive)) {
      // The synthetic lane has no folder; the sentinel is its key and its sort segment.
      const segment = placed.lane.synthetic ? UNCATEGORIZED_LANE_ID : lastOf(placed.segments)
      const key = placed.lane.synthetic
        ? UNCATEGORIZED_LANE_ID
        : comparisonKey([segment], caseInsensitive)

      const existing = byKey.get(key)
      if (existing === undefined) byKey.set(key, { segment, column: [placed.lane], first: placed.lane })
      else existing.column.push(placed.lane)
    }
  }

  const columns = [...byKey.values()]
    .filter(entry => entry.segment !== UNCATEGORIZED_LANE_ID)
    // §3's ordering, on the folder segment, through the grammar's own comparator.
    .sort((a, b) => compareLanes(a.segment, b.segment))
    .map(entry => ({
      key: comparisonKey([entry.segment], caseInsensitive),
      /**
       * **The first contributor's display name wins**, and it is deterministic because
       * `tasksDirsUnder` sorted. Two folders that fold to one key can still differ in the bytes a
       * person typed — `02-Next` and `02-next` — and one of them has to be shown.
       */
      name: entry.first.name,
      synthetic: false,
      lanes: entry.column,
    }))

  const loose = byKey.get(UNCATEGORIZED_LANE_ID)
  if (loose !== undefined) {
    // Leftmost. Spec §3, and the same position it holds on a single-project board.
    columns.unshift({
      key: UNCATEGORIZED_LANE_ID,
      name: UNCATEGORIZED_LANE_LABEL,
      synthetic: true,
      lanes: loose.column,
    })
  }
  return columns
}

/** A lane's project, as the wire carries it. One construction, so the two lanes cannot differ. */
function originOf(project: readonly string[]): LaneOrigin {
  return { project: [...project], name: project[project.length - 1] ?? '' }
}

/** The last segment. Never `at(-1)` without a guard — an empty path would silently become one. */
function lastOf(segments: readonly string[]): string {
  const last = segments[segments.length - 1]
  if (last === undefined) throw new Error('a lane folder with no segments')
  return last
}

/**
 * A lane and where it actually is. **Internal — `segments` never reaches the wire.**
 *
 * The public `Lane` deliberately carries no path, and for a while `resolveLaneDestination` paid for
 * that by looking the folder up a *second* time after matching the id. A mutation sweep showed the
 * consequence: the first lookup's refusal branch was **unreachable**, because any id the first
 * lookup matched the second one matched too. Two checks, one of them dead, and a mutation that
 * removed the live one came back green because the dead one caught it.
 *
 * One lookup now. The wire shape is a projection of this, rather than this being a re-derivation of
 * the wire shape.
 */
interface PlacedLane {
  readonly lane: Lane
  /** The lane folder, folder-relative. Empty for Uncategorized, which is not a folder. */
  readonly segments: readonly string[]
}

function placedLanesOf(
  index: IndexStore,
  rootId: string,
  project: readonly string[],
  caseInsensitive: boolean,
): PlacedLane[] {
  const tasks = tasksDirOf(index, rootId, project, caseInsensitive)
  if (tasks === null) return []
  return placedLanesIn(index, rootId, project, tasks, caseInsensitive)
}

/**
 * The lanes of **one named tasks directory**, with no searching for it.
 *
 * Split out of `placedLanesOf` for P11's gathered board, which knows the folder because it just
 * enumerated it and must not re-derive it. `tasksDirOf` answers *"which tasks folder does this
 * project mean"* and deliberately returns **one** — shallowest, ties broken by comparison key. A
 * board gathering a whole subtree is asking a different question and wants every one of them, so it
 * would have had to defeat that rule to use it.
 *
 * **The alternative was a second enumeration**, and this file already records what that costs: the
 * `PlacedLane` header above describes two lookups where one of them went dead and a mutation
 * removing the live one came back green. One implementation, two callers.
 */
function placedLanesIn(
  index: IndexStore,
  rootId: string,
  project: readonly string[],
  tasks: readonly string[],
  caseInsensitive: boolean,
): PlacedLane[] {
  const folders: { segment: string; placed: PlacedLane }[] = []
  let uncategorized = 0

  for (const child of index.childrenOf(rootId, tasks)) {
    /**
     * **AN ARCHIVE IS NOT A LANE.** PRD: *"`archive/` content excluded everywhere"*, and the
     * grammar's own `isArchived` says the same in more detail — *"excludes the subtree from Tasks,
     * Projects, Inbox and every derived live set — but not from Files."*
     *
     * This file never called it. `isArchived` had existed since P1 and was imported by **tests
     * only**, which made it the eleventh control in this build with no product caller — and this
     * one was a live wrong answer, not a missing feature: `project-template` ships a
     * `02-work/tasks/archive`, so every project made from it grew an **Archive column**, and every
     * task ever retired came back as a card that could be dragged out of it.
     *
     * Retiring a task is the one sanctioned way to get it off the board. A board that shows the
     * archive has no retire path at all.
     */
    if (isArchived(child.segments)) continue
    if (child.kind === 'directory') {
      folders.push({
        segment: child.name,
        placed: {
          lane: {
            id: laneIdFor(rootId, project, tasks, child.name, caseInsensitive),
            name: laneDisplayName(child.name),
            synthetic: false,
            origin: originOf(project),
          },
          segments: [...child.segments],
        },
      })
    } else if (lanePlacementOf(child.segments)?.lane === null) {
      uncategorized++
    }
  }

  // §3's ordering, through the grammar's own comparator rather than a second one written here.
  // Sorted on the FOLDER SEGMENT, never on the display name — display strips the numeric prefix,
  // so sorting by it would drop the ordering the prefixes exist to carry.
  folders.sort((a, b) => compareLanes(a.segment, b.segment))
  const lanes: PlacedLane[] = folders.map(entry => entry.placed)

  if (uncategorized > 0) {
    // Leftmost. Spec §3. Its `segments` is the tasks folder itself: dragging into Uncategorized
    // moves the file UP, because the absence of a lane folder is the state.
    lanes.unshift({
      lane: {
        id: laneIdFor(rootId, project, tasks, null, caseInsensitive),
        name: 'Uncategorized',
        synthetic: true,
        origin: originOf(project),
      },
      segments: tasks,
    })
  }
  return lanes
}

/**
 * The project's `tasks` directory, as the index knows it, or null when it has none.
 *
 * **NOT an immediate child, and that was a real bug.** This searched the project's direct children
 * only, and every project in the real soil keeps its tasks at `02-work/tasks` —
 * `project-template` ships `02-work/{objectives, projects, tasks}`. So `lanesOf` returned nothing
 * and the Tasks tab reported *"this project has no tasks folder yet"* for a project with six lanes
 * and fourteen cards in it.
 *
 * It survived because **every fixture in the build put `tasks` directly under the project** — a
 * shape that does not occur — so the board was proven against a tree the app will never meet. Found
 * the first time the real UI was pointed at the mock soil.
 *
 * The grammar was right throughout: `lanePlacementOf` resolves a card's project with
 * `enclosingProject`, which walks up past `02-work`. Only this lookup was shallow.
 *
 * **Ownership is what makes the search safe.** An op lives at `<project>/02-work/projects/<op>` and
 * has its own `02-work/tasks`; a search for any folder named `tasks` in the subtree would hand the
 * outer project the inner one's board. So a candidate counts only when the project *enclosing it*
 * is this project — the same function the card placement uses, rather than a second rule about
 * depth that would have to be kept in step with it.
 *
 * **Shallowest wins**, deterministically. The index is a map and its iteration order is an
 * implementation detail; a board that picked a different `tasks` folder between two identical
 * requests would be a board nobody could trust.
 */
function tasksDirOf(
  index: IndexStore,
  rootId: string,
  project: readonly string[],
  caseInsensitive: boolean,
): string[] | null {
  const wanted = comparisonKey(project, caseInsensitive)
  let best: string[] | null = null

  for (const entry of index.subtree(rootId, project)) {
    if (entry.kind !== 'directory' || !isTasksDir(entry.name)) continue
    if (isArchived(entry.segments)) continue
    const owner = enclosingProject(entry.segments.slice(0, -1))
    if (owner === null || comparisonKey(owner, caseInsensitive) !== wanted) continue
    if (best === null || isNearer(entry.segments, best, caseInsensitive)) best = [...entry.segments]
  }
  return best
}

/**
 * Shallower wins; **at equal depth, the lower comparison key wins.** (security review, P9-7.)
 *
 * The comment above this function has always claimed determinism, and for unequal depths it had it.
 * At *equal* depth the old test — `entry.segments.length < best.length` — was false either way, so
 * the winner was whichever the index happened to yield first, and the index is a Map whose iteration
 * order is an implementation detail. A project with `02-work/tasks` and `01-notes/tasks` could
 * therefore be drawn from a different folder between two identical requests.
 *
 * That is not hypothetical: one project in the user's soil owns two tasks folders at equal depth
 * today. `comparisonKey` is the folding the rest of this build sorts by, so the tie is broken with
 * the same rule rather than a second one.
 */
function isNearer(
  candidate: readonly string[], best: readonly string[], caseInsensitive: boolean,
): boolean {
  /**
   * **THE TEMPLATE'S FOLDER WINS FIRST.** Ruled 2026-08-12, and it inverts what depth
   * alone would say.
   *
   * `02-work/tasks` is **deeper** than a stray `tasks/` sitting in a project root, so shallowest-
   * wins resolved to the non-compliant folder and ignored the compliant one. The security review's C3 found the
   * consequence from the other end: the board drew lanes from both, every drop was refused, and the
   * obvious repair moved the file into the other folder.
   *
   * Ranking the template first makes the two sides agree by construction — the board keeps exactly
   * what the mutation resolves — and it makes the app agree with the convention rather than with an
   * accident of folder depth.
   */
  const template = (dir: readonly string[]): boolean => {
    const owner = enclosingProject(dir.slice(0, -1))
    if (owner === null) return false
    return comparisonKey(dir, caseInsensitive)
      === comparisonKey([...owner, ...TEMPLATE_TASKS_PATH], caseInsensitive)
  }
  const candidateIsTemplate = template(candidate)
  if (candidateIsTemplate !== template(best)) return candidateIsTemplate

  // Neither is the template shape, or both are: depth, then the comparison key. P9-7's rule.
  if (candidate.length !== best.length) return candidate.length < best.length
  return comparisonKey(candidate, caseInsensitive) < comparisonKey(best, caseInsensitive)
}

/** Where a card would land. `segments` is the destination FILE path, folder-relative. */
export interface Destination {
  readonly segments: string[]
  /** The lane it resolved to, for the caller to report back. */
  readonly lane: Lane
}

/**
 * Resolves a lane id to the path a card would move to. **The only way a move gets a destination.**
 *
 * Every refusal here is `STALE_TARGET`, and that is the point rather than laziness: §13.7 says a
 * move to a lane absent from the current index *"is refused and the board reloads"*, and one code
 * means the client has one behaviour to implement. A move refused because the lane was renamed and
 * a move refused because the whole project was archived are the same event to a person looking at a
 * board that no longer matches the disk.
 *
 * **The destination directory must already exist in the index.** Nothing in this path creates one.
 */
/** A lane's actual folder. `segments` is the DIRECTORY, folder-relative. */
export interface LaneFolder {
  readonly segments: string[]
  readonly lane: Lane
}

/**
 * A lane id to the directory it names. **The only way anything reaches a lane's folder.**
 *
 * Both writers on this board go through here — the drop that moves a card into a lane, and the
 * quick-add that creates one in it — because the M2 rule they have to obey is the same rule, and
 * two implementations of it is how one of them ends up creating a folder:
 *
 * > *"the move-mkdir exception resurrects folders an agent deliberately removed… a stale board plus
 * > a renamed lane materializes a ghost lane. Since folders are the database, that is structural
 * > corruption."*
 *
 * The folder comes out of the index through the enumeration the board was drawn from. **Never
 * composed from the lane's display name** — `laneDisplayName` strips the numeric prefix, so
 * rebuilding a path from it is how a board ends up creating `Next` beside `02-next`, which is M2
 * wearing a different hat.
 */
export function resolveLaneFolder(
  index: IndexStore,
  rootId: string,
  project: readonly string[],
  laneId: string,
  caseInsensitive: boolean,
): Result<LaneFolder> {
  const found = placedLanesOf(index, rootId, project, caseInsensitive)
    .find(candidate => candidate.lane.id === laneId)
  if (found === undefined) {
    /**
     * The M2 refusal. A stale board naming a lane that has been renamed or removed lands here, and
     * the answer is "reload", never "create it".
     *
     * It also catches a lane the client *invented*: an id it did not get from a payload matches
     * nothing enumerated, so there is no way to reach a directory that is not currently a lane.
     */
    return fail(ErrorCode.STALE_TARGET, 'that lane is no longer on this board')
  }
  return ok({ segments: [...found.segments], lane: found.lane })
}

export function resolveLaneDestination(
  index: IndexStore,
  rootId: string,
  card: readonly string[],
  laneId: string,
  caseInsensitive: boolean,
): Result<Destination> {
  const placement = lanePlacementOf(card)
  if (placement === null) {
    return fail(ErrorCode.STALE_TARGET, 'that file is not a card on a board')
  }

  const folder = resolveLaneFolder(index, rootId, placement.project, laneId, caseInsensitive)
  if (!folder.ok) return folder

  const fileName = card[card.length - 1]
  if (fileName === undefined) return fail(ErrorCode.PATH_EMPTY, 'no card was named')

  /**
   * Uncategorized's `segments` is the tasks folder, so the same line handles it: the file moves up,
   * and there is nothing to create because the absence of a lane folder is itself the state.
   */
  return ok({ segments: [...folder.value.segments, fileName], lane: folder.value.lane })
}


/**
 * The cards of one project's board, grouped by lane. Spec §3, PRD's Tasks tab.
 *
 * **Derived from `placedLanesOf`, not from a second enumeration**, and that is the whole design of
 * this function. The lane ids a client holds came from there; if cards came from anywhere else the
 * two could disagree about what a lane is, and the disagreement would show up as cards that cannot
 * be dropped anywhere because their lane id resolves to nothing. One enumeration, two projections.
 *
 * **Files only, and immediate children only.** A task is one markdown file in a lane folder; a
 * directory inside a lane is not a card and its contents are not tasks. Non-markdown files ARE
 * included — the PRD's card takes its title from the first heading *"falling back to filename"*,
 * which is exactly what a stray attachment needs, and hiding a file that is really there is the
 * silently-smaller-tree shape this build refuses everywhere else.
 *
 * **Uncategorized holds the files sitting directly in `tasks/`.** Its `segments` is the tasks
 * folder itself, so its cards are that folder's own files — the absence of a lane folder is the
 * state, per §3.
 *
 * **No archive filter here, and that is deliberate rather than an omission.** One was written and
 * the mutation sweep would not turn it red: replacing it with `true` changed nothing, because
 * `placedLanesOf` already refuses an archived lane, so no archived folder is ever enumerated for
 * its cards — and a project that is itself under an archive has every one of its lanes excluded by
 * the same rule. The filter could not fire.
 *
 * That is the second cannot-fire guard written in this build in one day, both by the same reflex:
 * defending at the leaf when the enumeration one level up has already excluded the case. Kept out,
 * because a dead guard that *looks* like a safety control invites the next reader to weaken the
 * live one on the grounds that this covers them.
 */
export interface LaneCards {
  readonly laneId: string
  readonly cards: readonly IndexEntry[]
}

export function cardsOf(
  index: IndexStore,
  rootId: string,
  project: readonly string[],
  caseInsensitive: boolean,
): LaneCards[] {
  return placedLanesOf(index, rootId, project, caseInsensitive)
    .map(placed => ({ laneId: placed.lane.id, cards: filesIn(index, rootId, placed.segments, caseInsensitive) }))
}

/**
 * The cards of every lane under a scope, keyed by lane id. P11's gathered board.
 *
 * **Keyed by lane id and not grouped into columns, deliberately.** The client already holds the
 * columns from `board.columns` and every lane id in them, so it can group these itself — and the
 * split is the one `board.cards` already makes: *"lanes are the folders that exist, cards are what
 * is in them… a board redrawn after a drag needs the second and not the first."* Returning columns
 * here too would mean walking the index twice per redraw and, worse, two enumerations that could
 * disagree about which lanes exist.
 *
 * **The card tag the operator asked for needs nothing extra on the wire.** A card's lane id finds its
 * lane, and the lane already carries `origin.name` — so *"this is part of this op"* is a lookup the
 * client can already do. A per-card project field would be the same fact stored twice, and this file
 * has a paragraph about what two copies of one fact cost.
 */
export function cardsFor(
  index: IndexStore,
  rootId: string,
  selection: Selection,
  caseInsensitive: boolean,
): LaneCards[] {
  const out: LaneCards[] = []
  for (const tasks of selectedTasksDirs(index, rootId, selection, caseInsensitive)) {
    const project = enclosingProject(tasks.slice(0, -1))
    if (project === null) continue
    for (const placed of placedLanesIn(index, rootId, project, tasks, caseInsensitive)) {
      out.push({ laneId: placed.lane.id, cards: filesIn(index, rootId, placed.segments, caseInsensitive) })
    }
  }
  return out
}

/**
 * The markdown files directly in a lane folder, in a stable order.
 *
 * Extracted so `cardsOf` and `cardsUnder` cannot sort differently. **The order is derived, not
 * stored** — the folder tree is the entire truth and a file carries no position — so it has to be
 * stable across a redraw or cards jump under the cursor mid-drag. `comparisonKey` rather than
 * `localeCompare`: the same folding the rest of this file uses to decide when two names are the
 * same name.
 */
function filesIn(
  index: IndexStore,
  rootId: string,
  segments: readonly string[],
  caseInsensitive: boolean,
): IndexEntry[] {
  return index.childrenOf(rootId, segments)
    .filter(entry => entry.kind === 'file')
    .sort((a, b) => {
      const left = comparisonKey([a.name], caseInsensitive)
      const right = comparisonKey([b.name], caseInsensitive)
      return left < right ? -1 : left > right ? 1 : 0
    })
}
