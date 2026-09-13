/**
 * Every inbox across the tree, in one view. PRD's Inbox tab, spec §3.
 *
 * *"Every inbox across the tree in one view — soil defaults: any `01-inbox` folder, plus the root
 * `99-inbox-main`. Items are files **and** folders, shown flat, grouped by which project's inbox
 * they sit in."*
 *
 * **Grouped by the project the inbox belongs to, which is read off the path.** The soil's shape
 * makes that the useful axis: an item in `02-projects/cider-line/01-inbox` is *cider-line's* inbox,
 * and `99-inbox-main` at the root belongs to the workspace itself. No curation, no config — the
 * grammar already decides both, and this reads its answer.
 *
 * **Folders are items too**, which is not an oversight to be tidied later. The operator's inboxes take
 * *"a file, or a folder of reference material"* — the soil's own rule — so an inbox that showed
 * only files would hide half of what arrives in it.
 *
 * `isInboxItem` has existed in the grammar since P1 and, until this file, was called by **no
 * product module at all** — the twelfth control in this build to be complete, tested and reachable
 * by nothing. It already knew two things worth having: an archived inbox is not live, and a
 * conflict artifact is *"never a card, inbox item, project or chatroom"* (§13.5), which is a
 * mistake this tab would otherwise have repeated — a conflict on an inbox note appearing as a
 * second inbox item.
 */

import { isArchived, isContextName, isIgnoredPath, isInboxItem, isInboxName } from './grammar'
import type { IndexEntry, IndexStore } from './index-store'
import { comparisonKey } from './paths'

export interface InboxGroup {
  readonly rootId: string
  /** The inbox folder itself, folder-relative. What a quick capture is written into. */
  readonly segments: readonly string[]
  /**
   * Whose inbox this is: the enclosing project's folder name, or the registered folder's own id
   * when the inbox sits at the top. Display only — every route takes `(rootId, segments)`.
   */
  readonly label: string
  /** Files **and** folders, flat, in name order. */
  readonly items: readonly IndexEntry[]
}

/**
 * Every live inbox under one registered folder.
 *
 * **An empty inbox is still an inbox and is still listed.** It is the target a quick capture
 * chooses, and a folder that vanished from the list the moment it was emptied would be one you
 * could not put anything into — the state where you most want to.
 */

/**
 * **WHOSE INBOX THIS IS — the name of the folder it sits in.**
 *
 * ruled 2026-08-19, looking at their own tree: *"there's a bunch of inboxes called **the soil**…
 * it's reading, from where I'm sitting, too high up. The inbox main should be the name, and then
 * projects — I have an inbox in projects, it should be showing projects."*
 *
 * **The old rule asked the wrong question.** It asked *"is this inbox inside a formally-recognised
 * project?"* and, when the answer was no, fell back to **`rootId`** — the registered folder's own id.
 * So every inbox not inside a *project* got the same label, and their twenty-plus identical rows were
 * one fallback firing over and over. Not duplication, and not the tree being read wrong: the label
 * was simply coming from the top of the tree instead of from the thing the inbox belongs to.
 *
 * It was also the **id**, not a name anyone chose.
 *
 * **Asking for the parent instead fixes the whole class at once.** A round table, an op, a
 * department, a folder with no grammar at all — each now reads as itself, without this function
 * needing to know what any of them are. That is why it is not "also check for round tables": the
 * question was wrong, not incomplete.
 *
 * **The top-level inbox names itself**, which is their stated exception — *"main inbox is the only
 * exception"*. Its parent is the registered folder, which is the label they were complaining about, and
 * there is only ever one of these per folder so it cannot collide with anything.
 */
function inboxLabel(segments: readonly string[], name: string): string {
  const parent = segments[segments.length - 2]
  return parent ?? name
}

export function inboxesOf(
  index: IndexStore, rootId: string, caseInsensitive: boolean,
): InboxGroup[] {
  const groups: InboxGroup[] = []

  for (const entry of index.subtree(rootId, [])) {
    if (entry.kind !== 'directory' || !isInboxName(entry.name)) continue
    // §3: an archive match excludes the subtree from Tasks, Projects and Inbox alike. An inbox
    // inside an archived project is a record, not a place things arrive.
    if (isArchived(entry.segments) || isIgnoredPath(entry.segments)) continue

    groups.push({
      rootId,
      segments: [...entry.segments],
      label: inboxLabel(entry.segments, entry.name),
      items: index.childrenOf(rootId, entry.segments)
        // The grammar's rule, not a re-derivation of it: it already excludes conflict artifacts,
        // which §13.5 says are never inbox items.
        .filter(item => isInboxItem(item.segments))
        /**
         * **The context folder is furniture, not an arrival.** Ruled 2026-08-21: *"I don't want
         * to see 00-context — there's a ton of inboxes that have nothing in them except that and
         * they're clogging up."*
         *
         * **Nothing else changes, and that is the whole design.** An inbox holding only this now
         * counts as empty, and the sort below already puts empty inboxes last — so the clog falls to
         * the bottom of the list on its own rather than needing a second rule to hide it. That
         * matters because the list is also the capture target: an inbox that vanished when it
         * emptied would be the one you could not put anything into.
         *
         * **A view rule, kept out of `isInboxItem` on purpose.** That predicate states what can
         * never be an item anywhere — §13.5's conflict artifacts, archived paths — and this is a
         * preference the operator can reverse. One line in one place, not a change to the grammar.
         */
        .filter(item => !isContextName(item.name))
        /**
         * **Numerically**, the way the file tree already sorts — `sortEntries` uses `localeCompare`
         * with `numeric` *"so `10-x` sorts after `9-x` rather than before it — this tree is full of
         * numeric prefixes and a plain string sort gets them backwards."* This list did not, so it
         * put `Dropped item 10` before `Dropped item 2`. The user's soil is full of numeric prefixes;
         * this shows up on real content, not only on a mock.
         *
         * `comparisonKey` first, so the NFC and case folding is the same one the rest of the build
         * decides name-sameness with, and `localeCompare` on the result for the digits.
         */
        .sort((a, b) => comparisonKey([a.name], caseInsensitive)
          .localeCompare(comparisonKey([b.name], caseInsensitive), undefined, { numeric: true })),
    })
  }

  /**
   * **Fullest first, then by label.** The PRD calls this tab's purpose *"quick dump"* and *"v1
   * shows and receives"* — so what a person opens it for is the pile that needs dealing with, and
   * an alphabetical list would bury nine items under eight empty project inboxes.
   *
   * Sorted rather than left in index order, because the index is a map: a view that reshuffled
   * between two identical reads would be unusable.
   */
  return groups.sort((a, b) => {
    if (a.items.length !== b.items.length) return b.items.length - a.items.length
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
  })
}
