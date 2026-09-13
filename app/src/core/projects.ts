/**
 * Every project in a registered folder. Spec §3, and the PRD's Projects tab.
 *
 * *"Every project in the tree at a glance — a project is a folder recognized by the path grammar
 * (folders under a `projects/` folder; soil default). Nesting shown as a breadcrumb tag read off
 * the path; no curation required."*
 *
 * **Read off the index, never from a stored list.** The grammar decides what a project is, live —
 * §3's rule is that projects are *"resolved at walk time, never by a stored glob"*, so a project
 * made this morning is on the board this morning and one archived at lunch is gone by the
 * afternoon. A curated list would be a second copy of the folder tree, and this build's whole
 * premise is that there is no second copy.
 *
 * **Archived projects are excluded**, which is `isArchived`'s stated job: *"excludes the subtree
 * from Tasks, Projects, Inbox and every derived live set — but not from Files."* That function sat
 * uncalled by any product module until Phase 9, and the first thing it caught was an Archive column
 * on the Tasks board.
 */

import { isArchived, isProject } from './grammar'
import type { IndexStore } from './index-store'
import { comparisonKey } from './paths'

export interface ProjectSummary {
  readonly rootId: string
  readonly segments: readonly string[]
  /** The folder's own name. */
  readonly name: string
  /**
   * The path above it, for the PRD's breadcrumb tag — *"nesting shown as a breadcrumb tag read off
   * the path"*. Folder-relative and for display only; every route takes `(rootId, segments)`.
   */
  readonly parentPath: readonly string[]
}

/**
 * Every project under one registered folder, shallowest first then alphabetical.
 *
 * **Nested projects are included as projects in their own right.** The soil nests them —
 * `02-projects/field-review/02-work/projects/op-meeting-prep` is a project inside a project — and
 * the PRD asks for *every* project at a glance with the nesting shown rather than flattened away.
 * Returning only top-level ones would hide most of the real tree.
 */
export function projectsOf(
  index: IndexStore, rootId: string, caseInsensitive: boolean,
): ProjectSummary[] {
  const found: ProjectSummary[] = []

  for (const entry of index.subtree(rootId, [])) {
    if (entry.kind !== 'directory') continue
    if (!isProject(entry.segments)) continue
    if (isArchived(entry.segments)) continue
    found.push({
      rootId,
      segments: [...entry.segments],
      name: entry.name,
      parentPath: entry.segments.slice(0, -1),
    })
  }

  /**
   * Shallowest first, then by name. Sorted rather than left in index order, because the index is a
   * map and its iteration order is an implementation detail — a board whose columns reshuffle
   * between two identical requests is a board nobody trusts.
   *
   * `comparisonKey` rather than `localeCompare`, for the reason the rest of this build uses it: it
   * is the folding that decides when two names are the same name on this volume.
   */
  return found.sort((a, b) => {
    if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length
    const left = comparisonKey(a.segments, caseInsensitive)
    const right = comparisonKey(b.segments, caseInsensitive)
    return left < right ? -1 : left > right ? 1 : 0
  })
}
