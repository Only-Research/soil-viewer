/**
 * The grammar fixture tree. Build plan §9: P1 owns "the grammar fixture tree drawn from real
 * soil shapes".
 *
 * **Drawn from, not invented.** Every shape below was observed in the user's actual soil by a
 * read-only survey on 2026-08-06 (2,054 markdown files, 50 `tasks/` directories, 177 inbox
 * directories, 128 archive directories). Where the survey found a spelling the spec's lists
 * did not obviously predict — `05-archive` alongside `archive` and `_archive`,
 * `01-department-inbox` alongside `01-inbox` — it is included here so the numeric-prefix and
 * alias rules are exercised against reality rather than against an imagined tree.
 *
 * Generated rather than committed, for the same reason as the scale tree: the generator is the
 * fixture, and a directory of empty marker files is harder to read than the code that makes it.
 */

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'

/** Every path the tree contains, with what the grammar must decide about it. */
export interface Expectation {
  /** Folder-relative path. */
  readonly path: string
  readonly isProject?: boolean
  readonly isProjectRoot?: boolean
  /** Lane folder name, `null` for the synthetic Uncategorized lane, `false` for "not a card". */
  readonly lane?: string | null | false
  readonly isInboxItem?: boolean
  readonly isArchived?: boolean
  readonly isIgnored?: boolean
  readonly isMarkdown?: boolean
}

const FILES: Array<[string, string]> = [
  // --- a top-level project, with the full 02-work shape -------------------------------
  ['02-projects/field-review/00-context/context.md', '# Field Review Context\n'],
  ['02-projects/field-review/01-inbox/dropped-note.md', '# Dropped Note\n'],
  ['02-projects/field-review/02-work/tasks/unsorted.md', '# Unsorted Card\n'],
  ['02-projects/field-review/02-work/tasks/01-urgent/urgent-card.md', '# Urgent\n'],
  ['02-projects/field-review/02-work/tasks/02-next/next-card.md', '# Next\n'],
  ['02-projects/field-review/02-work/tasks/03-back-burner/later.md', '# Later\n'],
  ['02-projects/field-review/02-work/tasks/04-done/done.md', '# Done\n'],
  // Nothing deeper than an immediate lane subfolder is a card.
  ['02-projects/field-review/02-work/tasks/02-next/deeper/not-a-card.md', '# Too Deep\n'],
  // A lane folder's own archive — observed in the real tree on 28 of 50 tasks directories.
  ['02-projects/field-review/02-work/tasks/archive/retired-card.md', '# Retired\n'],
  ['02-projects/field-review/02-work/objectives/objective.md', '# An Objective\n'],

  // --- a nested project, the <project>/02-work/projects/<name> shape -------------------
  ['02-projects/field-review/02-work/projects/op-meeting/00-context/context.md', '# Op Context\n'],
  ['02-projects/field-review/02-work/projects/op-meeting/02-work/tasks/02-next/op-card.md', '# Op Card\n'],
  // Three levels deep, which the real tree does reach.
  ['02-projects/holdings-group/02-work/projects/riverside/02-work/projects/deep/00-context/c.md', '# Deep\n'],

  // --- inboxes, in every spelling the survey actually found ---------------------------
  ['99-inbox-main/report.md', '# Main Inbox Report\n'],
  ['02-projects/field-review/01-inbox/thing.md', '# Inbox Thing\n'],
  ['01-internal/01-department-inbox/dept.md', '# Department Inbox\n'],
  ['01-internal/inbox/plain.md', '# Plain Inbox\n'],
  // Inboxes are FLAT — the phase/pipeline model was retired and agents keep assuming it.
  ['99-inbox-main/subfolder/nested.md', '# Nested, not an inbox item\n'],

  // --- archives, including the numeric-prefixed spelling the survey found --------------
  ['02-projects/field-review/archive/old-plan.md', '# Old Plan\n'],
  ['02-projects/field-review/05-archive/numbered-archive.md', '# Numbered Archive\n'],
  ['02-projects/field-review/_archive/underscore-archive.md', '# Underscore Archive\n'],
  // A name that merely contains "archive" is not one.
  ['02-projects/field-review/archived-notes/still-live.md', '# Still Live\n'],

  // --- a tasks directory NOT under a project ------------------------------------------
  // Every task file in the real soil is in one of these. Its cards are deliberately not on
  // any board, because the board is per-project.
  ['01-internal/00-bridge/agent-workspace/tasks/orphan-card.md', '# Orphan\n'],

  // --- ignored content -----------------------------------------------------------------
  ['02-projects/field-review/node_modules/pkg/readme.md', '# Never indexed\n'],
  ['02-projects/field-review/dist/build.md', '# Never indexed\n'],
  ['.hidden/secret.md', '# Never indexed\n'],
  ['02-projects/field-review/.gitkeep', ''],
  ['02-projects/field-review/.DS_Store', 'x'],
  ['Some.app/inside.md', '# Never indexed\n'],
  // A name containing an ignored word is NOT ignored.
  ['02-projects/field-review/x-node_modules.md', '# Ordinary Document\n'],

  // --- conflict artifacts and non-markdown ---------------------------------------------
  [
    '02-projects/field-review/02-work/tasks/02-next/card.conflict-20260806-134700-a3f7.md',
    '# A Conflict Artifact\n',
  ],
  ['02-projects/field-review/00-context/diagram.png', 'not markdown'],
  ['02-projects/field-review/00-context/notes.markdown', '# Not our extension\n'],
]

/** What the grammar must conclude. Asserted by test/core/grammar-tree.test.ts. */
export const EXPECTATIONS: Expectation[] = [
  { path: '02-projects', isProjectRoot: true },
  { path: '02-projects/field-review', isProject: true },
  { path: '02-projects/field-review/02-work/projects', isProjectRoot: true },
  { path: '02-projects/field-review/02-work/projects/op-meeting', isProject: true },
  { path: '02-projects/holdings-group/02-work/projects/riverside/02-work/projects/deep', isProject: true },
  { path: '02-projects/field-review/02-work', isProject: false },
  { path: '01-internal/00-bridge/agent-workspace', isProject: false },

  { path: '02-projects/field-review/02-work/tasks/01-urgent/urgent-card.md', lane: '01-urgent' },
  { path: '02-projects/field-review/02-work/tasks/02-next/next-card.md', lane: '02-next' },
  { path: '02-projects/field-review/02-work/tasks/03-back-burner/later.md', lane: '03-back-burner' },
  { path: '02-projects/field-review/02-work/tasks/04-done/done.md', lane: '04-done' },
  { path: '02-projects/field-review/02-work/tasks/unsorted.md', lane: null },
  { path: '02-projects/field-review/02-work/projects/op-meeting/02-work/tasks/02-next/op-card.md', lane: '02-next' },
  { path: '02-projects/field-review/02-work/tasks/02-next/deeper/not-a-card.md', lane: false },
  { path: '02-projects/field-review/02-work/tasks/archive/retired-card.md', lane: false, isArchived: true },
  { path: '02-projects/field-review/02-work/tasks/02-next/card.conflict-20260806-134700-a3f7.md', lane: false },
  { path: '01-internal/00-bridge/agent-workspace/tasks/orphan-card.md', lane: false },
  { path: '02-projects/field-review/00-context/diagram.png', lane: false, isMarkdown: false },

  { path: '99-inbox-main/report.md', isInboxItem: true },
  { path: '02-projects/field-review/01-inbox/thing.md', isInboxItem: true },
  { path: '01-internal/01-department-inbox/dept.md', isInboxItem: true },
  { path: '01-internal/inbox/plain.md', isInboxItem: true },
  { path: '99-inbox-main/subfolder/nested.md', isInboxItem: false },

  { path: '02-projects/field-review/archive/old-plan.md', isArchived: true },
  { path: '02-projects/field-review/05-archive/numbered-archive.md', isArchived: true },
  { path: '02-projects/field-review/_archive/underscore-archive.md', isArchived: true },
  { path: '02-projects/field-review/archived-notes/still-live.md', isArchived: false },

  { path: '02-projects/field-review/node_modules/pkg/readme.md', isIgnored: true },
  { path: '02-projects/field-review/dist/build.md', isIgnored: true },
  { path: '.hidden/secret.md', isIgnored: true },
  { path: '02-projects/field-review/.gitkeep', isIgnored: true },
  { path: 'Some.app/inside.md', isIgnored: true },
  { path: '02-projects/field-review/x-node_modules.md', isIgnored: false, isMarkdown: true },

  { path: '02-projects/field-review/00-context/notes.markdown', isMarkdown: false },
  { path: '02-projects/field-review/00-context/context.md', isMarkdown: true },
]

/** Creates the tree under `root`. Returns the number of files written. */
export async function makeGrammarTree(root: string): Promise<number> {
  for (const [relative, body] of FILES) {
    const full = join(root, relative)
    await fsp.mkdir(dirname(full), { recursive: true })
    await fsp.writeFile(full, body)
  }
  // An empty lane folder, so "hidden when empty" has something to be true about.
  await fsp.mkdir(join(root, '02-projects/field-review/02-work/tasks/04-done/empty-dir'), { recursive: true })
  return FILES.length
}
