/**
 * The folder grammar. Spec §3.
 *
 * The app knows what is a project, a task, an inbox or an archive purely from where a file
 * sits. The call was to compile a working set of shapes in rather than make this configurable —
 * v1's configurable version created a settings surface that did not exist and a dozen unanswered
 * questions about matching. A fork with different conventions edits this file and nothing else.
 *
 * **Every name comparison in this file goes through `grammarKey`.** Spec §3 requires the
 * matching rule be "stated once"; v1 had three name lists with three different semantics, which
 * is contradiction #12. Nothing here re-implements normalization, and nothing outside this file
 * decides what a lane or an archive is.
 *
 * Core layer: no HTTP, no browser, no third-party code. Spec §2.
 */

import { grammarKey, numericPrefixOf, stripNumericPrefix, toASCIILowerCase, toNFC } from './text'

// ---------------------------------------------------------------------------
// The lists. Spec §3 states these verbatim.
// ---------------------------------------------------------------------------

/**
 * The conventional spelling of the top-level project root — what the shipped template uses and
 * what the documentation describes. **Not the gate**: since 2026-08-28 any folder named `projects`
 * is a project root, wherever it sits. See `isProjectRoot`.
 */
export const PROJECT_ROOTS = ['02-projects'] as const

/** The conventional path under a project at which further projects nest. Also not the gate. */
export const NESTED_PROJECTS_PATH = ['02-work', 'projects'] as const

/**
 * The one name that decides. Derived from the conventional spelling rather than written a second
 * time, so the two can never drift into disagreeing about what `projects` means.
 */
const PROJECTS_KEY = grammarKey(NESTED_PROJECTS_PATH[1])

/**
 * The conventional lane names — the four the template ships with.
 *
 * **Not the gate either, and it never was.** `lanesOf` takes the immediate subfolders of a
 * project's `tasks` directory from the index, so a folder the convention does not name is still a
 * lane and a card can still be in it. Ruled 2026-08-28: the convention must not be strict enough
 * to stop someone arranging their tasks under statuses of their own. They already can.
 */
export const LANES = ['01-urgent', '02-next', '03-back-burner', '04-done'] as const

export const INBOX_NAMES = [
  '01-inbox',
  'inbox',
  '99-inbox-main',
  '01-department-inbox',
  '00-inbox',
] as const

/**
 * **The soil's context folder.** Every unit of work carries one — *"context is the North Star"* —
 * so it turns up inside inboxes as well as beside them, and it is furniture rather than something
 * that arrived.
 *
 * Named here rather than compared as a literal at the one call site, so it goes through §3's single
 * normalization rule like every other name in this file. `grammarKey` strips the numeric prefix, so
 * this covers `00-context`, a bare `context`, and any other prefix someone has used.
 */
export const CONTEXT_NAMES = ['00-context'] as const

/** Spec §3 notes the numeric prefix is "matched separately" — `grammarKey` strips it. */
export const ARCHIVE_NAMES = ['archive', '_archive'] as const

export const TASKS_DIR = 'tasks'

/**
 * **Where a project's tasks live, per the templates.** Ruled 2026-08-12: the templates are the
 * authority — work, and then tasks inside it — and the app follows whatever they say.
 *
 * Named because the app had been resolving this by *depth* — shallowest wins — and the template's
 * folder is **deeper** than a stray `tasks/` in a project root. So on a project owning both, depth
 * chose the non-compliant one. A project with tasks anywhere else is a folder to be fixed, not a
 * shape to accommodate; the decision was to surface a list of them rather than have the app guess.
 */
export const TEMPLATE_TASKS_PATH = ['02-work', 'tasks'] as const

/**
 * Never indexed, never watched, never walked. Spec §3.
 *
 * `.next` and every other dot-prefixed name is covered by the dot rule below rather than
 * listed here; the spec names it explicitly and the dot rule subsumes it.
 */
export const IGNORED_NAMES = ['node_modules', 'release', 'out', 'dist'] as const

/** The synthetic lane for markdown sitting directly in a `tasks` folder. Spec §3. */
export const UNCATEGORIZED_LANE_ID = '__uncategorized__'
export const UNCATEGORIZED_LANE_LABEL = 'Uncategorized'

/**
 * **What makes a folder a board.** P14, and the call on how one is recognised: the name carries a
 * `board-` prefix, which was judged the safest bet a reader could learn in one sentence.
 *
 * A prefix rather than a list, because unlike lanes and inboxes the set is open — boards are named
 * by whoever keeps the tree, one per subject, and there is no roster to maintain.
 */
export const BOARD_PREFIX = 'board-'

/**
 * The same prefix as an **anchored pattern**, which is how this file is allowed to ask the question.
 *
 * §5 bans raw `startsWith` outright — *"Paths compare on whole segments, never by prefix"* — and the
 * lint rule that enforces it says in as many words that a genuine non-path use is **an escalation,
 * not a local disable**. This is a genuine non-path use: it tests one already-normalized *segment*,
 * never a path. `url-safety.ts` hit the identical wall and settled it the identical way, so this
 * follows the precedent already argued rather than opening a second one.
 *
 * Written as a literal rather than built from `BOARD_PREFIX` so no string reaches a `RegExp`
 * constructor. `boardPrefixesAgree` below is what keeps the two from drifting.
 */
const BOARD_SEGMENT = /^board-/

/**
 * True when the anchored pattern and the constant still say the same thing.
 *
 * **Exported only so a test can assert it.** Two spellings of one rule is exactly the drift §3 was
 * written to end; this is the cheapest possible way to make the drift loud instead of silent.
 */
export function boardPrefixesAgree(): boolean {
  return BOARD_SEGMENT.test(BOARD_PREFIX) && BOARD_SEGMENT.source === `^${BOARD_PREFIX}`
}

// ---------------------------------------------------------------------------
// The one matching rule
// ---------------------------------------------------------------------------

/** True when `segment` matches any entry, under spec §3's single normalization rule. */
export function matchesAny(segment: string, entries: readonly string[]): boolean {
  const key = grammarKey(segment)
  return entries.some(entry => grammarKey(entry) === key)
}

export function isLane(segment: string): boolean {
  return matchesAny(segment, LANES)
}

export function isInboxName(segment: string): boolean {
  return matchesAny(segment, INBOX_NAMES)
}

export function isArchiveName(segment: string): boolean {
  return matchesAny(segment, ARCHIVE_NAMES)
}

export function isContextName(segment: string): boolean {
  return matchesAny(segment, CONTEXT_NAMES)
}

export function isTasksDir(segment: string): boolean {
  return matchesAny(segment, [TASKS_DIR])
}

/**
 * True when this segment names a board. P14.
 *
 * **Goes through `grammarKey` like every other name test in this file**, and that is the whole
 * reason it lives here rather than being a prefix check at a call site. §3's single normalization —
 * NFC, strip an optional leading `NN-`, case-fold — means `Board-Tuesday-Drops` and
 * `01-board-tuesday-drops` are boards too. v1 had three name lists with three different semantics;
 * this does not become the fourth.
 *
 * **`boardroom` is not a board.** The trailing hyphen in the pattern is doing that work, and it is
 * the case the test mutates for, because `/^board/` reads identically to a person skimming and
 * swallows every folder whose name happens to begin that way.
 */
export function isBoardFolder(segment: string): boolean {
  return BOARD_SEGMENT.test(grammarKey(segment))
}

/**
 * **A name someone typed, handed back the way they typed it.** `tuesday-drops` → "Tuesday drops".
 *
 * **Only the first letter is capitalised**, which is what separates this from `laneDisplayName`
 * above — that one title-cases every word, because a lane is drawn from a fixed roster of one- and
 * two-word labels the app itself owns. Everything in Boards is named by **them**: they type
 * `Tuesday drops`, the app kebab-cases it to make the folder, and this is the step that closes the
 * loop. Title-casing would show them "Tuesday Drops" for a board they named `Tuesday drops`.
 *
 * **Board names and column names both come through here**, and a test is what established that they
 * must. The first version of `boardContents` reused `laneDisplayName` for columns, on the reasoning
 * that a column resembles a lane. It does not: a lane comes from a fixed roster, a column is
 * whatever they typed — *"I can name and create these things on the fly."* So a column named
 * `in-progress` read back as "In Progress", and the round trip visibly did not close.
 */
export function typedName(segment: string): string {
  const stripped = stripNumericPrefix(toNFC(segment))
  const words = stripped.split('-').filter(word => word.length > 0).join(' ')
  return words.length === 0 ? '' : (words[0] ?? '').toUpperCase() + words.slice(1)
}

/**
 * A board's name as shown. `board-tuesday-drops` → **"Tuesday drops"**.
 *
 * The board prefix off, then `typedName` for the rest — one rule for every name in Boards.
 */
export function boardDisplayName(segment: string): string {
  const stripped = stripNumericPrefix(toNFC(segment))
  /**
   * **Guarded rather than assuming the caller checked.** Slicing a fixed six characters off a name
   * that is not a board silently eats the first six letters of a real folder name and shows the
   * result as a title — a corruption that looks like a naming mistake by whoever made the folder.
   * A non-board gets its own name back.
   */
  const withoutPrefix = isBoardFolder(stripped) ? stripped.slice(BOARD_PREFIX.length) : stripped
  return typedName(withoutPrefix)
}

// ---------------------------------------------------------------------------
// Ignore rules. Spec §3: evaluated against the folder-relative path, whole segments.
// ---------------------------------------------------------------------------

/**
 * True when this single segment is ignored.
 *
 * The dot rule covers **directories and files** — the real tree carries 527 `.DS_Store` and
 * 823 `.gitkeep`, all of which v1 walked and watched (FT-6 / contradiction #14).
 */
export function isIgnoredSegment(segment: string): boolean {
  if (segment.length === 0) return false
  if (segment[0] === '.') return true

  const key = grammarKey(segment)
  if (IGNORED_NAMES.some(name => grammarKey(name) === key)) return true

  // `*.app` bundles. Compared on the raw segment's ASCII-lowercased tail so that a numeric
  // prefix strip cannot change the answer.
  const lowered = toASCIILowerCase(toNFC(segment))
  return lowered.length > 4 && lowered.slice(-4) === '.app'
}

/**
 * True when any segment of this folder-relative path is ignored.
 *
 * Spec §3: "a registered folder living under a dot-directory is still watched" — which is why
 * this takes the path **relative to the registered root** and never an absolute one. A file
 * named `x-node_modules.md` is not skipped, because whole segments are compared.
 */
export function isIgnoredPath(relativeSegments: readonly string[]): boolean {
  return relativeSegments.some(isIgnoredSegment)
}

// ---------------------------------------------------------------------------
// Archive. Spec §3: a match at ANY ancestor level.
// ---------------------------------------------------------------------------

/**
 * True when this path sits inside an archive at any depth.
 *
 * Spec §3: an archive match excludes the subtree from Tasks, Projects, Inbox and every derived
 * live set — **but not from Files**, where archives render collapsed and remain valid Move
 * destinations. v1's rule excluded them everywhere, which made the only sanctioned retire path
 * impossible (M6 / contradiction #2). Callers in Files must not consult this.
 */
export function isArchived(relativeSegments: readonly string[]): boolean {
  return relativeSegments.some(isArchiveName)
}

// ---------------------------------------------------------------------------
// Projects. Spec §3: resolved at walk time, never by a stored glob.
// ---------------------------------------------------------------------------

/**
 * True when the path is a directory that projects nest directly inside — **that is, any folder
 * called `projects`, anywhere.**
 *
 * ## Widened 2026-08-28, and the old rule is described here rather than deleted
 *
 * The ruling: the projects view renders any folder that sits inside a folder called `projects` —
 * because anyone who wants to arrange their tree their own way should be able to.
 *
 * The old rule accepted exactly two shapes: `projects` sitting at depth 1 in the registered folder,
 * or `<project>/02-work/projects` — and the second required the parent chain to be projects all the
 * way up, which is what the recursion into `isProject` was doing. So a folder called `projects`
 * three levels into somebody else's arrangement was not a project root, and nothing inside it
 * rendered.
 *
 * That encoded **one particular layout** into software whose whole claim is that the folder tree is
 * the state. Ruled the same day, on what this app is: the tree is not the product — the product is
 * what holds a tree of any shape. The old rule made the product hold one tree.
 *
 * **The new rule subsumes both old shapes** rather than replacing them: `02-projects` at the top
 * still matches, and so does `<project>/02-work/projects`, because in both the folder is called
 * `projects`. What is new is everything else. `PROJECT_ROOTS` and `NESTED_PROJECTS_PATH` are kept
 * as the *conventional* spellings — they are what the shipped template uses and what the docs
 * describe — but they are no longer the gate.
 *
 * The numeric prefix and case were never part of the gate: `grammarKey` strips `NN-` and folds
 * case, so `projects`, `02-projects`, `5-Projects` and `PROJECTS` have always been one name.
 */
export function isProjectRoot(relativeSegments: readonly string[]): boolean {
  const last = relativeSegments[relativeSegments.length - 1]
  return last !== undefined && grammarKey(last) === PROJECTS_KEY
}

/** True when this directory is itself a project: its parent is a project root. Spec §3. */
export function isProject(relativeSegments: readonly string[]): boolean {
  if (relativeSegments.length === 0) return false
  return isProjectRoot(relativeSegments.slice(0, -1))
}

/**
 * The nearest ancestor (or self) that is a project, or null.
 * Lanes are only lanes when they sit under a `tasks` directory that sits under a project.
 */
export function enclosingProject(relativeSegments: readonly string[]): string[] | null {
  for (let end = relativeSegments.length; end > 0; end--) {
    const candidate = relativeSegments.slice(0, end)
    if (isProject(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// Lanes and the Uncategorized lane. Spec §3.
// ---------------------------------------------------------------------------

export interface LanePlacement {
  /** The project this card belongs to. */
  readonly project: string[]
  /** The lane's folder segment, or null when the card is in the synthetic Uncategorized lane. */
  readonly lane: string | null
}

/**
 * Where a markdown file sits on a board, or null when it is not a card at all.
 *
 * Spec §3, two rules in one function so they cannot drift:
 * - **A lane** is an immediate subfolder of a `tasks` directory located under a project.
 *   Nothing deeper is a card in that lane.
 * - **Uncategorized** is markdown sitting directly in the `tasks` folder, in no lane subfolder.
 *   It is a synthetic lane; it is never a folder and is never created on disk. The absence of
 *   a lane folder is itself a state — folder-as-state followed to its end, not an exception.
 */
export function lanePlacementOf(relativeSegments: readonly string[]): LanePlacement | null {
  const depth = relativeSegments.length
  const fileName = relativeSegments[depth - 1]
  if (fileName === undefined || !isMarkdown(fileName)) return null
  if (isArchived(relativeSegments) || isIgnoredPath(relativeSegments)) return null
  if (isConflictArtifact(fileName)) return null

  // Card directly in `tasks/` — the Uncategorized lane.
  const parent = relativeSegments[depth - 2]
  if (parent !== undefined && isTasksDir(parent)) {
    const project = enclosingProject(relativeSegments.slice(0, depth - 2))
    if (project === null) return null
    return { project, lane: null }
  }

  // Card in `tasks/<lane>/` — an immediate subfolder only.
  const grandparent = relativeSegments[depth - 3]
  if (parent !== undefined && grandparent !== undefined && isTasksDir(grandparent)) {
    const project = enclosingProject(relativeSegments.slice(0, depth - 3))
    if (project === null) return null
    return { project, lane: parent }
  }

  return null
}

/** `02-next` → "Next". Spec §3: display strips the prefix. */
export function laneDisplayName(segment: string): string {
  const stripped = stripNumericPrefix(toNFC(segment))
  return stripped
    .split('-')
    .filter(word => word.length > 0)
    .map(word => (word[0] ?? '').toUpperCase() + word.slice(1))
    .join(' ')
}

/** Spec §3: order follows the numeric prefix, then alphabetical. */
export function compareLanes(a: string, b: string): number {
  const orderA = numericPrefixOf(a)
  const orderB = numericPrefixOf(b)
  if (orderA !== null && orderB !== null && orderA !== orderB) return orderA - orderB
  if (orderA !== null && orderB === null) return -1
  if (orderA === null && orderB !== null) return 1
  return grammarKey(a) < grammarKey(b) ? -1 : grammarKey(a) > grammarKey(b) ? 1 : 0
}

// ---------------------------------------------------------------------------
// The one extension predicate. Spec §6.
// ---------------------------------------------------------------------------

/**
 * The **only** extension test in the codebase. Spec §6.
 *
 * "The final extension, NFC-normalized and ASCII-lowercased, equals `md`." ASCII-lowercased
 * rather than case-folded on purpose: a Unicode character must not be able to lowercase its
 * way into looking like `md`.
 *
 * `.markdown`, `.mdx` and case variants are named and excluded (FT-12) so that a helpful
 * builder does not quietly widen the set. This predicate drives the tree glyph, the editor
 * gate, the indexer, title extraction, the chatroom match, and the write/append gate at the
 * chokepoint. Divergence is a build failure.
 */
export function isMarkdown(fileName: string): boolean {
  return extensionOf(fileName) === 'md'
}

/**
 * The final extension, NFC-normalized and ASCII-lowercased, without the dot. Empty when there
 * is none.
 *
 * A leading dot is a hidden-file marker, not an extension: `.md` has no extension and is
 * therefore not markdown. That also stops the §13.6 slugification failure — a name that
 * slugifies to nothing and produces a file literally called `.md` — from being treated as a
 * document.
 */
export function extensionOf(fileName: string): string {
  const normalized = toNFC(fileName)
  const dot = normalized.lastIndexOf('.')
  if (dot <= 0 || dot === normalized.length - 1) return ''
  return toASCIILowerCase(normalized.slice(dot + 1))
}

// ---------------------------------------------------------------------------
// Conflict artifacts. Spec §13.5.
// ---------------------------------------------------------------------------

/**
 * The alphabet of the random suffix in a conflict-artifact name. RFC 4648 base32: `A–Z2–7`,
 * with no `0`, `1`, `8` or `9`.
 *
 * **P4 MUST draw its random suffix from this constant.** It is exported rather than inlined
 * because generation and detection drifting apart is not a cosmetic bug: an undetected
 * conflict artifact becomes a task card that can never be removed, which is C5 — the exact
 * failure §13.5 was rewritten to eliminate. Picking a different base32 variant (Crockford's,
 * say, which includes digits this one excludes) would reintroduce it silently.
 */
export const CONFLICT_SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const CONFLICT_SUFFIX_LENGTH = 4

/**
 * The conflict-artifact name format, defined once. Spec §13.5:
 * `<base>.conflict-YYYYMMDD-HHMMSS-<4 random base32><ext>`
 *
 * Built from the alphabet above so the pattern cannot disagree with the generator.
 */
export const CONFLICT_INFIX = new RegExp(
  `\\.conflict-\\d{8}-\\d{6}-[${CONFLICT_SUFFIX_ALPHABET}]{${CONFLICT_SUFFIX_LENGTH}}$`,
  'i',
)

/**
 * True when this filename is a conflict artifact. Spec §13.5: grammar-excluded everywhere
 * except Files, where it is shown marked. A conflict file never spawns a conflict child.
 */
export function isConflictArtifact(fileName: string): boolean {
  const normalized = toNFC(fileName)
  const dot = normalized.lastIndexOf('.')
  const base = dot > 0 ? normalized.slice(0, dot) : normalized
  return CONFLICT_INFIX.test(base)
}

// ---------------------------------------------------------------------------
// Chatroom
// ---------------------------------------------------------------------------

/**
 * The one filename that renders as a conversation. Spec §14, and it is stated as an **exact match
 * rather than a glob** for a reason the spec names outright:
 *
 * > *"the final path segment equals `chatroom.md` exactly (NFC, case-folded). **Not a glob** —
 * > `chatroom-protocol.md` and `chatroom-template.md` are ordinary documents and MUST render as
 * > such."*
 *
 * Those two files are not hypothetical. The soil's own chatroom protocol lives in one of them, and
 * a glob would render the document that *explains* the format as an unreadable conversation whose
 * every heading is a message. §11-of-v1 left this open; §14 closes it, and the closing is this
 * equality.
 *
 * **A conflict artifact of a chatroom is never itself a chatroom** (§13.5, §14) — and here that
 * clause needs no code, because the equality above already is it. An artifact is named
 * `chatroom (conflict …).md`, which is not `chatroom.md`; a name that *did* compare equal would be
 * the original file rather than an artifact of it.
 *
 * An explicit `isConflictArtifact` check was written here first and **removed after a sweep showed
 * it could not fail** — deleting it left every case green, because the equality had already
 * answered. The clause is satisfied by construction, which is the strongest way to satisfy it; a
 * second guard that cannot fire is one a later reader trusts, and the inbox path already carries a
 * real one because *its* match is a folder rule rather than an equality.
 */
export function isChatroomName(fileName: string): boolean {
  return toASCIILowerCase(toNFC(fileName)) === 'chatroom.md'
}

/**
 * True when this folder-relative path is a chatroom the app should render as a conversation.
 *
 * Archived and ignored paths are excluded on the same rule every other grammar predicate uses:
 * `archive/` content is out of every view, and a chatroom in there is history rather than a
 * conversation anyone is having.
 */
export function isChatroom(relativeSegments: readonly string[]): boolean {
  const name = relativeSegments[relativeSegments.length - 1]
  if (name === undefined || !isChatroomName(name)) return false
  return !isArchived(relativeSegments) && !isIgnoredPath(relativeSegments)
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/**
 * True when the path sits directly inside an inbox folder.
 *
 * Spec §3: inboxes are flat catch-alls — the phased/pipeline model was retired, and agents
 * have since been confused into thinking it was still in force. There is no phase structure
 * here, deliberately.
 */
export function isInboxItem(relativeSegments: readonly string[]): boolean {
  const parent = relativeSegments[relativeSegments.length - 2]
  if (parent === undefined || !isInboxName(parent)) return false
  const name = relativeSegments[relativeSegments.length - 1]
  // Spec §13.5: a conflict artifact is "never a card, inbox item, project or chatroom". The
  // card path excluded them from the start; this one did not, so a conflict on an inbox note
  // appeared as a second inbox item — the C5 shape, in a different tab.
  if (name !== undefined && isConflictArtifact(name)) return false
  return !isArchived(relativeSegments) && !isIgnoredPath(relativeSegments)
}
