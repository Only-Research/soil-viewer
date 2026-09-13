/**
 * The handlers behind the route table. Spec §6.
 *
 * These are the first real implementations — P2's tests used stubs, which was correct then (the
 * phase's subject was the chokepoint, not what sits behind it) and is not correct now.
 *
 * TWO RULES CARRIED FROM P1 AND P2, both of which are easiest to break here:
 *
 *   - **An empty-but-successful result never stands in for a failure** (§6). An empty child list
 *     means the directory was empty, never that reading it failed. Every path below either returns
 *     data or returns a typed error; no catch turns a failure into `[]`.
 *   - **Path parameters are always `(rootId, segments)`** and the API never accepts or emits an
 *     absolute path. The wire types have no shape that could carry one, and these handlers never
 *     reach for `root.absolutePath` on the way out.
 */

import { createTokenMinter } from '../core/entity-token'
import { ErrorCode, RefusalError } from '../core/errors'
import { indexRegisteredRoot, reconcileEntry } from '../core/indexer'
import type { IndexEntry, IndexStore } from '../core/index-store'
import {
  cardsOf, cardsFor, columnsFor, lanesOf, resolveLaneDestination, resolveLaneFolder,
  type Column, type Lane,
} from '../core/board'
import { appendBlockFor, nextNumberIn } from '../core/chatroom'
import { isChatroom, isIgnoredPath } from '../core/grammar'
import {
  applyCardOrder, cardOrderOf, columnOrderOf, withCardOrder, withColumnOrder,
} from '../core/board-order'
import { boardContents, boardsIn, type BoardColumn, type BoardSummary } from '../core/boards'
import { projectsOf, type ProjectSummary } from '../core/projects'
import { search } from '../core/quick-open'
import { inboxesOf } from '../core/inbox'
import {
  columnsOf, projectBoardOf, withPlacement, type ProjectBoard,
} from '../core/project-board'
import { deregisterRoot, retargetPathKeys, type UiStateFile } from '../core/fs/config-store'
import { detectCloudProvider } from '../core/fs/registration'
import type { ConfigService } from './config-service'
import type { LiveUpdates } from './live-updates'
import { loadDocument } from '../core/fs/document'
import { appendToDocument } from '../core/fs/append'
import { createMutationLocks, lockKeyFor } from '../core/fs/mutation-lock'
import { writeConflictArtifact } from '../core/fs/conflict'
import { planRecursiveCopy, recursiveCopy } from '../core/fs/copy'
import { browseDirectories, browseRoots, type BrowseScope } from '../core/fs/browse'
import { createEntry } from '../core/fs/create'
import { exclusiveRename } from '../core/fs/rename'
import { resolveConflict } from '../core/fs/resolve-conflict'
import { saveDocument } from '../core/fs/write'
import { resolveVerifiedPath, walkAndVerify, type RegisteredRoot } from '../core/fs/containment'
import { revealInFinder } from './reveal'
import { fileNameFrom } from '../core/slug'
import { foldCase, toNFC } from '../core/text'
import { comparisonKey } from '../core/paths'

/**
 * Spec states no number for this one — recorded rather than presented as if it did.
 *
 * Sixty-four is chosen against the surface it actually costs: every template is a row in the `⋯`
 * menu of every folder, and a menu longer than a screen is not a menu. It is four times the
 * sixteen-root cap §11 does state, on the reasoning that one folder can reasonably hold several
 * shapes.
 */
const MAX_STORED_TEMPLATES = 64

/**
 * Staged cards, and the body of one. Neither number is in the spec — recorded rather than presented
 * as if it were.
 *
 * Two hundred is well past what a board a person reads can hold, and far below where rewriting the
 * config on every keystroke-ish save becomes noticeable. 64 KB is a long description and a short
 * document: a card is *"a plan with no folder"*, and past this length the honest answer is that it
 * wants to be a folder.
 */
const MAX_STAGED_CARDS = 200
const MAX_STAGED_BODY_CHARS = 64 * 1024
import { toWireEntry } from '../contract/encode'
import type { WireEntry } from '../contract/wire'
import type { RootRegistry } from './root-registry'

/**
 * Thrown so `dispatch` turns it into a typed error and the local log gets the detail.
 *
 * That sentence was here before `dispatch` did any such thing — it caught every throw alike and
 * answered `INTERNAL`, so every refusal below reached the client as "The operation could not be
 * completed." The branded base class is what makes the sentence true; see `RefusalError`.
 */
export class ServiceError extends RefusalError {
  constructor(code: ErrorCode, message: string) {
    super(code, message)
    this.name = 'ServiceError'
  }
}

/**
 * §13.5's rescue, as the single thing both conflict detections call.
 *
 * `writeConflictArtifact` never throws by construction — *"a rescue path that can throw is a rescue
 * path that can lose the thing it was rescuing"* — so its failure arrives as a value here and turns
 * into the outcome the client is required to block on. That property is why this function has no
 * try/catch: adding one would suggest the guarantee is doubted, and swallowing anything here is the
 * precise shape of the bug §13.5 exists to prevent.
 */
async function rescueTheEdit(
  root: RegisteredRoot,
  segments: readonly string[],
  bytes: Buffer,
): Promise<SaveOutcome> {
  const rescued = await writeConflictArtifact(root, segments, bytes)
  return rescued.ok
    ? { outcome: 'conflict', rescue: [...rescued.value.segments] }
    : { outcome: 'conflict-unrescued', reason: rescued.code }
}

/**
 * A template, as the client sees it. Phase 8.
 *
 * **`available` is the field that earns its keep.** Deregistering a folder keeps its templates —
 * the naming work is the user's and removing a folder is not a statement about it — so the list can
 * hold entries pointing into a folder the app may no longer read. They are reported rather than
 * filtered out, because a template that silently vanishes from Settings looks like data loss, and
 * one that is offered and then fails looks like a bug. Named, it is neither.
 */
export interface TemplateSummary {
  readonly id: string
  readonly name: string
  readonly rootId: string
  readonly segments: readonly string[]
  /** False when the folder it points into is not currently registered. */
  readonly available: boolean
}

export interface RegisteredFolder {
  readonly id: string
  readonly name: string
  /**
   * Enough of the path to tell two folders apart, and **not an absolute path** — §6 holds.
   *
   * Settings has to answer "which `notes` is this one", and the folder's own name cannot. The operator,
   * on how much path is enough: *"it needs to show where it lives, doesn't need an absolute file
   * path, but it needs to show high enough that we know where it is."*
   *
   * The last two segments, so `/Users/hallberg/work/notes` reads `work/notes`. That names the
   * folder's neighbourhood without naming the home directory, and — the part that matters for §6 —
   * **it is not a path that can be sent back**: every route that takes a location takes
   * `(rootId, segments)`, and this is neither.
   */
  readonly displayPath: string
  readonly caseInsensitive: boolean
  readonly cloudProvider: string | null
}

/**
 * WHAT A SAVE DID. Spec §13.2, §13.4, §13.5.
 *
 * **A conflict is an outcome, not an error, and it took a defect to make that structural.** For
 * three phases `file.save` threw `CONFLICT_DETECTED` and the comment above the throw read *"§13.5's
 * rescue and resolution take over from here"* — while `writeConflictArtifact`, complete and
 * mutation-swept, was imported by no production module at all. A conflicting edit survived only in
 * the browser's memory. §13.5 is the requirement it failed: *"An edit is never discarded because
 * its rescue file failed."*
 *
 * **Why a union rather than an error with a bigger payload.** The client cannot open the two-pane
 * resolution without knowing *where the rescue landed*, and §6 keeps detail off the error envelope
 * on purpose — the wire carries a code and a constant sentence, nothing derived from the request.
 * A path is exactly the kind of thing that rule exists to exclude. So the artifact's location has
 * to arrive on the success side, which means the success side has to be able to say "not saved".
 * `CONFLICT_DETECTED`'s own doc comment already settled the direction: *"A conflict, not an error."*
 *
 * **The failure mode this shape is chosen against** is a client that ignores the discriminant and
 * treats every 200 as a save — marking its buffer clean and dropping the edit. Two properties push
 * back on that structurally rather than by convention:
 *
 *   - `hash` exists on the `saved` arm alone, so a client that wants to advance its baseline must
 *     narrow first. Reading `.hash` off the union is a compile error.
 *   - **an unrescued conflict gets its own discriminant, never an absent optional field on
 *     `conflict`.** A client that handles `'conflict'` and forgets a `rescue?: string[]` would
 *     silently mishandle the one case where the edit exists nowhere but in the browser. With a
 *     separate tag, forgetting it means falling through to the default branch, and the safe
 *     behaviour — block, retain the buffer — is what a default branch should already do.
 *
 * All arms are HTTP 200 with `ok: true`. The request was understood and answered; the answer is
 * what the save did. Statuses stay for requests that could not be processed at all.
 */
export type SaveOutcome =
  /** The bytes are on disk. `hash` is the new baseline, taken from the temp before the rename. */
  | { readonly outcome: 'saved'; readonly hash: string; readonly bytes: number }
  /**
   * §13.4 says the file changed underneath the editor, and §13.5's rescue succeeded.
   *
   * `rescue` is folder-relative, like every other path on the wire. The canonical file is
   * **untouched** — the save never ran — so the two-pane resolution opens `segments` against
   * `rescue`, and `conflict.resolve` ends it.
   */
  | { readonly outcome: 'conflict'; readonly rescue: readonly string[] }
  /**
   * The file changed underneath the editor **and the rescue file could not be written**.
   *
   * §13.5, verbatim: *"the buffer is retained client-side and the editor enters a blocking unsaved
   * state."* Nothing on disk holds this edit. `reason` is an `ErrorCode` and therefore already
   * wire-safe — the same enumerated vocabulary the error envelope uses, never a detail string.
   */
  | { readonly outcome: 'conflict-unrescued'; readonly reason: ErrorCode }
  /**
   * §13.2's truncation guard fired and the caller has not confirmed. **A question, not a failure.**
   *
   * The byte counts are here because the spec requires the confirmation to *name the loss* — "this
   * will remove 380 lines", not "are you sure?". As a refusal this arrived as a constant sentence
   * with the numbers stripped by §6, so the client could not have named anything. The caller
   * re-issues the identical save with `confirmTruncation`, which waives this one check and no other.
   */
  | {
      readonly outcome: 'truncation-blocked'
      readonly wasBytes: number
      readonly willBeBytes: number
    }

export interface Services {
  readonly 'folders.list': () => RegisteredFolder[]

  /**
   * Whether the app's own records could be read. P11 C4.
   *
   * **A boolean, never the detail.** The reason is already in the local log; putting a parse error's
   * text on the wire would put file contents in front of a client for a class of failure where the
   * file is exactly what nobody has managed to read.
   */
  readonly 'config.health': () => { readonly registryDamaged: boolean; readonly uiStateDamaged: boolean }

  /** The Tasks board's remembered filter. Empty means every project — the default. */
  readonly 'board.selection': () => Array<{ readonly rootId: string; readonly segments: string[] }>
  readonly 'board.setSelection': (
    input: { projects: Array<{ rootId: string; segments: string[] }> },
  ) => Promise<null>
  readonly 'tree.children': (input: { rootId: string; segments: string[] }) => WireEntry[]
  readonly 'tree.entry': (input: { rootId: string; segments: string[] }) => WireEntry
  /** How many indexed FILES sit under a path, inclusive. §13.7's M6. */
  readonly 'tree.count': (input: { rootId: string; segments: string[] }) => { readonly files: number }
  readonly 'folders.register': (
    input: { id: string; absolutePath: string },
  ) => Promise<RegisteredFolder>
  readonly 'folders.deregister': (input: { id: string }) => Promise<{ id: string }>

  /**
   * Templates — named folder shapes to scaffold from. Phase 8.
   *
   * There is no `instantiate` verb, and its absence is the design: a template is a pointer to a
   * folder, so scaffolding from one is an ordinary `entry.copy`. See `routes.ts`.
   */
  readonly 'templates.list': () => TemplateSummary[]
  readonly 'templates.register': (
    input: { id: string; name: string; rootId: string; segments: string[] },
  ) => Promise<TemplateSummary>
  readonly 'templates.deregister': (input: { id: string }) => Promise<{ id: string }>

  /**
   * List the folders inside one directory, for Settings → Folders. §11, F6.3.
   *
   * An empty `absolutePath` asks for the allowed roots rather than a listing, so the client never
   * has to know or construct the home path — and never has to be told it when the answer is a
   * refusal.
   */
  readonly 'folders.browse': (input: { absolutePath: string }) => Promise<{
    readonly path: string
    readonly parent: string | null
    readonly directories: ReadonlyArray<{ readonly name: string; readonly path: string }>
    readonly roots: readonly string[]
  }>

  /**
   * Load a document for editing. Spec §13.2.
   *
   * Returns the content plus the hash the client must hand back to save. The hash is the whole
   * point: it is how "no save without a load" survives the trip through a stateless request.
   */
  /**
   * **Show a file in Finder.** §10 — the only service that invokes the operating system.
   *
   * **This docstring said `local-only` by its route, so the phone cannot reach it at all`. That was
   * false, and it is the exact falsehood spec §21 warns about.** The route is `carriedBy: 'both'`
   * (the operator's amendment, 2026-08-14), and `test/server/listener.test.ts` asserts it answers 200
   * through the tailnet proxy. §21 records why the wrong version is dangerous: *"a future reader of
   * §10 would believe Reveal is loopback-only and might 'restore' a runtime listener check, which §7
   * forbids by name."* This comment was that reader's source.
   *
   * **What keeps it out of the phone's MENU** is the client: `actionsFor` takes a required
   * `RowContext` and omits Reveal when `desktop` is false. That parameter used to default to
   * `{ desktop: true }`; it no longer defaults at all, so a call site that forgets is a compile
   * error rather than a dead control on a phone. Ruled 2026-08-16: *"phone shouldn't be able to
   * reach view in finder."*
   *
   * **That is a UI decision and NOT a security boundary** — the security review's correction of 2026-08-16, and
   * the wording is the point. This route is `auth: 'token'` on both listeners, so anything holding a
   * session token can call it whatever the menu shows. P12 accepted that: Reveal grants strictly
   * less than a tailnet caller already has, since it cannot read, write or move a file. Describing
   * the menu as the control is what would tempt a later reader into restoring the runtime listener
   * check §7 forbids — the §21 hazard arriving through the sentence meant to prevent it.
   *
   * `desktop` is a **width** (`min-width: 768px`), so a phone in landscape counts as desktop.
   * the operator ruled that acceptable on 2026-08-16: *"if it turns sideways and that makes a desktop
   * mode and the button needs to be there, it's fine."*
   *
   * The server still serves it on both listeners, deliberately — §7 forbids the runtime check that
   * would change that, and narrowing the route itself is a spec amendment, not a code change.
   */
  readonly 'file.reveal': (input: { rootId: string; segments: string[] }) => Promise<{
    readonly revealed: true
  }>

  readonly 'file.load': (input: { rootId: string; segments: string[] }) => Promise<{
    readonly content: string
    readonly hash: string
    readonly bytes: number
  }>

  /**
   * Save a document. Spec §13.2, §13.4, §13.5.
   *
   * Returns a `SaveOutcome` rather than throwing on conflict or truncation — see that type for why.
   */
  readonly 'file.save': (input: {
    rootId: string
    segments: string[]
    content: string
    expectedHash: string
    confirmTruncation: boolean
  }) => Promise<SaveOutcome>

  /** The lanes of one project, with the ids a card move must name. §3, §13.7. */
  readonly 'board.lanes': (input: { rootId: string; project: string[] }) => Lane[]

  /** The columns of a folder-scoped board, same-named lanes merged. P11's Scope facet. */
  /**
   * §16's quick-open. **Wire rows**, for the reason `board.cardsFor` records in its own type: an
   * index row carries BigInts and `JSON.stringify` throws on them.
   */
  readonly 'search.quickOpen': (
    input: { query: string },
  ) => Array<{ readonly entry: WireEntry; readonly inName: boolean }>

  readonly 'board.columns': (input: { rootId: string; projects: string[][] }) => Column[]

  /**
   * The cards under a scope, keyed by lane id. Grouped into columns by the client.
   *
   * **`WireEntry`, not `IndexEntry`**, and the type is the control. The first version returned the
   * index rows straight out of core and it compiled perfectly — but an index row carries `dev`,
   * `ino` and `mtimeNs` as **BigInt**, and `JSON.stringify` throws on those. So every request 500'd,
   * the board reported "could not be read", and the tab drew nothing.
   *
   * That is the hazard Phase 2's gate names by hand: *"index rows carry dev, ino and mtimeNs as
   * BigInt and JSON.stringify throws on them, so a handler that serialises a row fails at runtime."*
   * Written down, pinned by a test, and walked into anyway by a new route that skipped `wire`.
   */
  readonly 'board.cardsFor': (
    input: { rootId: string; projects: string[][] },
  ) => Array<{ readonly laneId: string; readonly cards: WireEntry[] }>

  /**
   * Move a card to a lane, by lane id. §13.7's M2.
   *
   * Returns where it landed **and which lane that was**, because the id the client sent is the one
   * thing it already knows; what it needs back is confirmation that the lane it *meant* is the lane
   * the server resolved.
   */
  /**
   * The Projects board. **Every verb here edits app config and nothing else** — the operator: *"when I
   * drag stuff around that board nothing is supposed to happen on disk."*
   */
  readonly 'projects.board': () => ProjectBoard
  readonly 'projects.setColumns': (
    input: { columns: Array<{ id: string; name: string }> },
  ) => Promise<ProjectBoard>
  readonly 'projects.place': (
    input: { rootId: string; segments: string[]; columnId: string },
  ) => Promise<ProjectBoard>
  readonly 'projects.stage': (
    input: { id: string; name: string; body: string; columnId: string },
  ) => Promise<ProjectBoard>
  readonly 'projects.unstage': (input: { id: string }) => Promise<ProjectBoard>

  /** Every inbox across every registered folder. Items are wire rows — files and folders alike. */
  readonly 'inbox.list': () => Array<{
    readonly rootId: string
    readonly segments: readonly string[]
    readonly label: string
    readonly items: WireEntry[]
  }>

  /**
   * Every board across every registered folder. P14 B1.
   *
   * **Read-only, and the whole of B1 is.** Nothing in this phase writes, so the tab that ships on it
   * cannot lose anything — which is why the writing half of Boards is built last, against a surface
   * already proven to show the tree correctly.
   */
  readonly 'boards.list': () => BoardSummary[]

  /**
   * One board's columns and cards, with the remembered arrangement applied. P14 B2 + B3.
   *
   * Still read-only. The order it applies was written by `boards.setOrder`, which is B4 — until then
   * every column reports its deterministic default and nothing has been arranged.
   */
  readonly 'boards.open': (
    input: { rootId: string; segments: string[] },
  ) => BoardColumn[]

  /**
   * Remembers a column's card order. P14 B4, and **the only write in Boards that is not an ordinary
   * file operation.**
   *
   * Creating a board, a column or a card is `entry.create`; moving a card between columns is
   * `entry.rename`. Both are §13.6's verbs, already gated, already tested — Boards adds no new way
   * to touch the tree, which is what keeps *"nothing deletes"* true here for free.
   *
   * This one writes app config and **never the file tree**, exactly as the Projects board's edits
   * do. The rule for that board applies verbatim: *"when I drag stuff around that board
   * nothing is supposed to happen on disk."*
   */
  readonly 'boards.setOrder': (
    input: { rootId: string; segments: string[]; order: string[] },
  ) => Promise<BoardColumn[]>

  /**
   * Remembers a board's column order. `segments` names the **board**, not a column.
   *
   * Boards only — the operator was explicit that Tasks does not change: *"tasks, those are in proper
   * order."*
   */
  readonly 'boards.setColumnOrder': (
    input: { rootId: string; segments: string[]; order: string[] },
  ) => Promise<BoardColumn[]>

  /** Every project across every registered folder, for the Projects tab and the board's picker. */
  readonly 'projects.list': () => ProjectSummary[]
  /** The cards on a board, grouped by lane. Wire rows, so nothing carries an absolute path. */
  readonly 'board.cards': (
    input: { rootId: string; project: string[] },
  ) => Array<{ readonly laneId: string; readonly cards: WireEntry[] }>
  readonly 'card.move': (input: {
    rootId: string
    card: string[]
    laneId: string
    /** §13.8, on the card. */
    token: string
  }) => Promise<{ readonly to: string[]; readonly lane: Lane }>

  /**
   * Quick-add. A task born in a lane, named by id rather than by path — see the route's own note
   * on why this is not `entry.create` with a composed parent.
   */
  readonly 'card.create': (input: {
    rootId: string
    project: string[]
    laneId: string
    name: string
  }) => Promise<{ readonly segments: string[]; readonly lane: Lane }>

  /**
   * Post a message to a chatroom. §14 — no expected hash, no client-supplied number.
   */
  readonly 'chatroom.append': (input: {
    rootId: string
    segments: string[]
    author: string
    body: string
  }) => Promise<{ readonly number: number; readonly size: number }>

  /**
   * New File or New Folder. §13.3, §13.6.
   *
   * Returns the name the server actually made, not the one that was typed — the two differ
   * whenever slugification does anything, and a client that assumes otherwise navigates to a file
   * that is not there.
   */
  readonly 'entry.create': (input: {
    rootId: string
    parent: string[]
    name: string
    kind: 'file' | 'directory'
  }) => Promise<{ readonly segments: string[]; readonly kind: 'file' | 'directory' }>

  /** Rename or move, with §13.6's exclusive semantics. */
  readonly 'entry.rename': (input: {
    rootId: string
    from: string[]
    to: string[]
    /** §13.8, on the source. */
    token: string
  }) => Promise<{ readonly to: string[]; readonly kind: 'file' | 'directory' }>

  /** Copy a folder, or report what a copy would do when `plan` is set. §13.7. */
  readonly 'entry.copy': (input: {
    rootId: string
    from: string[]
    to: string[]
    plan: boolean
    /** §13.8, on the source. */
    token: string
  }) => Promise<{
    readonly files: number
    readonly bytes: number
    readonly skipped: string[]
    /** Absent on a plan. Present when the copy actually landed. */
    readonly to?: string[]
  }>

  /** End a conflict. §13.5. */
  readonly 'conflict.resolve': (input: {
    rootId: string
    canonical: string[]
    artifact: string[]
    choice: 'mine' | 'theirs' | 'both'
    /** §13.8, on the canonical file. */
    token: string
  }) => Promise<{
    readonly canonical: string[]
    readonly keptAlongside?: string[]
  }>
}

/**
 * Where the app keeps its own working files.
 *
 * Required rather than defaulted. A default here would be a location chosen by whichever module
 * happened to need one first, and both of these are validated against the registered roots on
 * every use — an implicit value is one nobody reviews.
 */
export interface ServiceStorage {
  /** Scratch for in-progress copies. Outside every root; per-volume resolution in `staging.ts`. */
  readonly stagingRoot: string
  /** Where the losing side of a resolved conflict goes. Outside every root. */
  readonly archiveRoot: string
  /**
   * Where Settings → Folders is allowed to look. §11, F6.3.
   *
   * Supplied by the server rather than read inside Core, because the home directory is an
   * environment fact — and because a test that plants a symlink escaping the scope must be able to
   * point the scope somewhere disposable. Required, not optional: an optional scope with a
   * `homedir()` fallback would mean a caller that forgets it silently browses the real home
   * directory, which is the one outcome this field exists to make deliberate.
   */
  readonly browseScope: BrowseScope
}

/**
 * Told when a config write failed on a path that could not be rolled back. Spec §13.8.
 *
 * Only `entry.rename` reaches it: the rename has already happened on disk, so there is nothing to
 * undo and the operation must still report success. **The failure has to go somewhere anyway** —
 * the security review's S5, from the event channel: a drop that leaves no trace is R3's lesson (a 500 that was
 * recorded nowhere) in a new place. Bootstrap points this at the local log.
 */
export type ConfigFailureSink = (at: string, detail: string) => void

export function createServices(
  registry: RootRegistry,
  index: IndexStore,
  storage: ServiceStorage,
  config: ConfigService,
  onConfigFailure?: ConfigFailureSink,
  /**
   * Optional because the write-path tests do not need a watcher to prove a write, and requiring one
   * would mean every such test standing up a filesystem watcher to assert something unrelated to
   * it. Bootstrap always passes one; its absence means "no live updates", never "silently skipped".
   */
  live?: LiveUpdates,
): Services {
  /**
   * The folder's display name is its last path segment — never the full path.
   *
   * Spec §6 keeps absolute paths off the wire in both directions. The response half matters as much
   * as the request half: hand the client a path and it learns the shape of the user's disk, and the
   * next builder has an absolute path to send back.
   */
  const describe = (root: RegisteredRoot): RegisteredFolder => {
    const segments = root.absolutePath.split('/').filter(s => s.length > 0)
    return {
      id: root.id,
      name: segments[segments.length - 1] ?? root.id,
      displayPath: segments.slice(-2).join('/'),
      caseInsensitive: root.caseInsensitive,
      // Surfaced because spec §5 makes a cloud-sync root behave differently — titles come from
      // filenames and no body is read — and the client has to be able to say so rather than
      // silently showing every file as untitled.
      cloudProvider: detectCloudProvider(root.absolutePath),
    }
  }

  /** The board, composed from the index and config. Read-only; every write goes through `saveUi`. */
  const board = (): ProjectBoard => projectBoardOf(
    index,
    config.uiState(),
    registry.list().map(root => ({ id: root.id, caseInsensitive: root.caseInsensitive })),
  )

  /**
   * Writes UI state and **throws when the write fails**, rather than reporting a board the disk
   * does not agree with. The folder registry learned this the hard way: memory follows disk.
   */
  const saveUi = async (change: (current: UiStateFile) => UiStateFile): Promise<void> => {
    const written = await config.updateUiState(change)
    if (!written.ok) throw new ServiceError(written.code, written.detail ?? written.code)
  }

  /** The next staged-card id. Sequential and stable — a card's id is what the client edits by. */
  const nextStagedId = (state: UiStateFile): string => {
    let next = 1
    const taken = new Set(state.stagedCards.map(card => card.id))
    while (taken.has(`staged-${next}`)) next += 1
    return `staged-${next}`
  }

  const requireRoot = (rootId: string): void => {
    if (registry.get(rootId) === undefined) {
      throw new ServiceError(ErrorCode.INVALID_ROOT, 'no such registered folder')
    }
  }

  /** The same check, returning the root, for the verbs that need it rather than just its existence. */
  const requireRootValue = (rootId: string) => {
    const root = registry.get(rootId)
    if (root === undefined) {
      throw new ServiceError(ErrorCode.INVALID_ROOT, 'no such registered folder')
    }
    return root
  }

  /**
   * §13.8's per-target serialization, one instance for the process.
   *
   * Created here rather than passed in: the lock is only meaningful if every mutation goes through
   * the *same* one, and a parameter is something a second call site can forget to share.
   */
  const locks = createMutationLocks()

  /**
   * §13.8's identity token, minted and verified here.
   *
   * Created here rather than passed in, for the same reason as `locks` directly above: a token is
   * only meaningful if the thing that mints it and the thing that checks it share a salt. A
   * parameter is something a second call site can forget to share — and the failure that produces
   * is not a crash but a server that refuses every mutation as stale.
   */
  const tokens = createTokenMinter()

  /** The one place a row becomes a wire row, with its token attached. */
  const wire = (entry: IndexEntry): WireEntry => toWireEntry(entry, tokens.mint)

  /**
   * §13.8's check, as one function so that every mutation asks the question the same way.
   *
   * **Reads the identity from disk, not from the index** — the same rule §13.4 states for the
   * conflict hash (F4.6: *"read fresh from disk via `fstat`/read on the descriptor being written —
   * never from the index"*). An index consulted here would be answering "has the row changed since
   * we last indexed it", which is a different and weaker question: an agent's replacement that the
   * watcher has not yet delivered is exactly the case this control exists for, and the index still
   * holds the old identity at that moment.
   *
   * A missing entity is `STALE_TARGET` rather than a not-found error. It is the truthful answer to
   * the question actually being asked — *is this still what you were shown* — and it keeps the
   * client on one recovery path (reload the view) instead of two.
   */
  const requireUnchanged = async (
    root: RegisteredRoot, segments: readonly string[], claimed: string,
  ): Promise<void> => {
    // Returns the error rather than throwing it, so each site reads `throw stale(...)`. A
    // `never`-returning helper would be tidier to call and TypeScript would not narrow past it —
    // control-flow analysis only follows `never` through an explicitly annotated declaration, and
    // silently not narrowing is how an unchecked `identity.value` gets read two lines later.
    const stale = (why: string): ServiceError =>
      new ServiceError(ErrorCode.STALE_TARGET, `${why}: ${segments.join('/')}`)

    // `walkAndVerify` rather than a fresh `lstat`: it is the §4 checker, so the containment and
    // symlink rules apply to this read exactly as they do to every other. A second path reader here
    // would be the fifth copy of the containment check — the trap `lab-foundation-audit.md` names.
    const identity = await walkAndVerify(root, segments)
    if (!identity.ok) throw stale('target could not be read')
    // `null` is "gone". Distinct from a read failure above, and both answer the same way — see the
    // note on the function.
    if (identity.value === null) throw stale('target no longer exists')
    if (!tokens.matches(claimed, identity.value)) {
      throw stale('target changed since the client\'s view')
    }
  }

  /**
   * Brings the index into line with what a mutation just did, before the mutation answers.
   *
   * **Found at Phase 4's gate, by the one lens no per-verb suite can apply: what does the *next
   * request* see.** `file.save` reconciled its own row; `entry.rename`, `entry.copy`, `card.move`
   * and `conflict.resolve` did not, so the index was stale the instant they returned — and §5 makes
   * the index authoritative for display. A client's refetch straight after its own successful
   * action was answered with the state from *before* the action.
   *
   * The watcher would have corrected it inside 250 ms **when live updates are running**, which made
   * it a race the client loses often rather than a bug it hits always — the worst kind to leave in,
   * because it is intermittent and presents as a UI problem. It is also the build's signature
   * failure in its second form: reachable, and never given what it needs.
   *
   * Bounded to the paths the mutation actually touched — §5's rule — and `reconcileEntry` routes
   * each one: absent removes, a directory reconciles its subtree, a file reconciles its row. The
   * watcher's own event arrives afterwards, finds nothing changed, and stays quiet.
   */
  const refreshIndex = async (
    root: RegisteredRoot, ...paths: readonly (readonly string[])[]
  ): Promise<void> => {
    for (const segments of paths) {
      if (segments.length === 0) continue
      await reconcileEntry(root, index, segments)
    }
  }

  /**
   * **One place a board is assembled, called by the read and by the write.** P14.
   *
   * `boards.setOrder` repaints from the board the server now holds rather than letting the client
   * apply its own guess — the shape `projects.setColumns` uses, and for the same reason. Sharing a
   * *function* rather than having one route call another is what keeps that honest: two assemblies
   * would be two answers to "what is on this board", and the write's answer is the one the operator sees.
   *
   * A plain local, deliberately **not** a member of the services object: everything in that object
   * is a route, and a helper living there would be a route with no contract entry — which is exactly
   * the "unchecked route cannot exist" guarantee `routes.ts` is built to make structural.
   */
  const openBoardAt = (rootId: string, segments: readonly string[]): BoardColumn[] => {
    const root = requireRootValue(rootId)

    /**
     * **A BOARD THAT IS NO LONGER THERE IS REFUSED, not reported as an empty board.**
     *
     * `boardContents` reads the index, and a path the index no longer holds simply matches nothing —
     * so a board renamed or archived while the client held on to it came back as `ok` with zero
     * columns. The Boards tab drew that as *"Nothing in this board yet"*, under the board's cached
     * name, with a `+ Column` button that would create into a path that is gone.
     *
     * Found by an adversarial review, reproduced end to end: rename the folder away, return to the
     * tab, and a board that does not exist looks like a real empty one. §6 bans exactly this shape —
     * *"an empty-but-successful result never stands in for a failure"* — and this was it, in a new
     * route, six hours after the rule was quoted at me somewhere else.
     *
     * **An empty board and a missing board are told apart by the FOLDER, not by the count**: the
     * board's own directory is either in the index or it is not.
     */
    const here = comparisonKey(segments, root.caseInsensitive)
    const present = [...index.subtree(rootId, [])].some(entry =>
      entry.kind === 'directory' && comparisonKey(entry.segments, root.caseInsensitive) === here)
    if (!present) {
      throw new ServiceError(ErrorCode.STALE_TARGET, 'that board is no longer there')
    }

    const state = config.uiState()

    const columns = boardContents(index.all(), { rootId, segments }).map(column => ({
      ...column,
      /**
       * **The synthetic column is never arranged.** It has no folder, so it has no path to key an
       * order against — and a card only sits there until it is put in a column, which is the one
       * move that gives it a home. Its deterministic default stands.
       */
      cards: column.segments === null
        ? column.cards
        : applyCardOrder(
          column.cards,
          card => card.name,
          cardOrderOf(state, rootId, column.segments, root.caseInsensitive),
        ),
    }))

    /**
     * **The columns in the order the operator left them.** Asked for on 2026-08-21 — *"just the ability
     * to move around the columns to different orders and have the app remember where I put them"* —
     * and they ruled out numbering them, exactly as they ruled it out for cards.
     *
     * **Boards only.** They were explicit that Tasks does not change: *"tasks, those are in proper
     * order."* A Tasks lane comes from a fixed roster the app owns and still sorts by its prefix.
     *
     * **`Uncategorized` stays leftmost and is never arranged.** It is not a folder, so it has no id
     * that could appear in a stored order, and it is where a loose file waits rather than a column
     * they placed. Held out and put back here rather than filtered inside `applyCardOrder`, which has
     * no business knowing that one column is synthetic.
     *
     * A column they have not moved sorts where it always did: `boardContents` orders them, and anything
     * the stored list does not name lands after the ones it does.
     */
    const synthetic = columns.filter(column => column.segments === null)
    const real = columns.filter(column => column.segments !== null)
    return [
      ...synthetic,
      ...applyCardOrder(
        real,
        column => column.id,
        columnOrderOf(state, rootId, segments, root.caseInsensitive),
      ),
    ]
  }

  return {
    'folders.list': () => registry.list().map(describe),

    /**
     * **Returned as stored, without validating against the tree.** A selection naming a project
     * since renamed simply matches nothing when the board resolves it — the client filters against
     * the live project list before sending. Checking here would make a rename turn a remembered
     * filter into an error, which is a worse trade than a filter that narrows slightly wrong.
     */
    'board.selection': () => config.uiState().boardSelection.map(entry => ({
      rootId: entry.rootId, segments: [...entry.segments],
    })),

    'board.setSelection': async ({ projects }) => {
      await saveUi(current => ({
        ...current,
        boardSelection: projects.map(entry => ({ rootId: entry.rootId, segments: [...entry.segments] })),
      }))
      return null
    },

    'config.health': () => ({
      registryDamaged: config.registryDamage !== null,
      uiStateDamaged: config.uiStateDamage !== null,
    }),

    'tree.children': ({ rootId, segments }) => {
      // The root must exist before the index is consulted. Otherwise an unregistered id returns an
      // empty list, which the client cannot distinguish from an empty folder — precisely the
      // empty-for-failure substitution §6 forbids.
      requireRoot(rootId)
      return index.childrenOf(rootId, segments).map(wire)
    },

    'tree.entry': ({ rootId, segments }) => {
      requireRoot(rootId)
      const entry = index.get(rootId, segments)
      if (entry === undefined) {
        // Absent from the index is a real answer, and it is NOT an empty entry. The client must be
        // able to tell "this file is gone" from "this file is blank".
        throw new ServiceError(ErrorCode.IO_FAILED, 'no such entry')
      }
      return wire(entry)
    },

    'tree.count': ({ rootId, segments }) => {
      requireRoot(rootId)
      /**
       * Files only — directories are not what a person is worried about losing sight of, and M6's
       * wording is "indexed **files** affected". The path itself is included when it is a file, so
       * moving one file reports one.
       */
      let files = 0
      for (const entry of index.subtree(rootId, segments)) {
        if (entry.kind === 'file') files += 1
      }
      return { files }
    },

    /**
     * Every stored template, including ones whose folder is no longer registered.
     *
     * **Reported, not filtered.** A template that silently vanishes from Settings looks like data
     * loss; one that is offered and then fails looks like a bug. `available: false` is neither, and
     * it is recoverable — `folderIdFor` derives a root id from the folder's own last segment, so
     * re-adding the same folder makes its templates work again.
     */
    'templates.list': () => config.registry().templates.map(stored => ({
      id: stored.id,
      name: stored.name,
      rootId: stored.rootId,
      segments: [...stored.segments],
      available: registry.get(stored.rootId) !== undefined,
    })),

    'templates.register': async ({ id, name, rootId, segments }) => {
      /**
       * **The folder is verified to exist and to BE a folder, before anything is stored.**
       *
       * `walkAndVerify` is the chokepoint every read and write in this app passes through — §4's
       * per-segment `lstat`, the symlink refusal, the volume-identity re-check, and since the P7
       * review the segment rule that closed the byte endpoint's escape. A template that skipped it
       * would be the only path into the filesystem that had not been through it.
       *
       * Checked at registration *and* implied again at every scaffold, because the copy runs the
       * same walk. Checking here is not the security control — the copy's walk is — it is so the
       * refusal arrives while the person is choosing the folder rather than weeks later when they
       * try to use it.
       */
      const root = requireRootValue(rootId)
      if (segments.length === 0) {
        throw new ServiceError(
          ErrorCode.PATH_EMPTY,
          'a template has to point at a folder inside the registered folder, not at the whole of it',
        )
      }
      const target = await walkAndVerify(root, segments)
      if (!target.ok) throw new ServiceError(target.code, target.detail ?? target.code)
      /**
       * `INVALID_ROOT` rather than a new code, and the **message** is what the person reads.
       *
       * There is no "not a directory" code in §6's table, and minting one would mean a new row in
       * the message table for a refusal the picker already makes almost unreachable — it offers
       * folders. The P7 review's lesson was that a *generic* refusal leaves someone re-picking and
       * learning nothing; the client shows `reply.error.message`, so these say exactly what is
       * wrong. The code names the class, the sentence names the case.
       */
      if (target.value === null || target.value.kind !== 'directory') {
        throw new ServiceError(ErrorCode.INVALID_ROOT, 'a template has to be a folder, not a file')
      }

      /**
       * **P8-8 — a folder §3 ignores cannot be a template.** The security review, P8 review: *"`templates.register`
       * accepts a §3-ignored folder: registers, shows `available: true`, can never be scaffolded."*
       *
       * **The harm is entirely in what the person is told.** The template registers, sits in the
       * menu marked available, and fails on use with `IO_FAILED: no such entry` — about a folder
       * they can see in Finder. §3 keeps `node_modules` and its kind out of the index, and the copy
       * resolves through the index, so the refusal is honest at the layer it comes from and
       * meaningless at the layer it is read.
       *
       * Refused here instead, where the sentence can name the actual reason. `isIgnoredPath` tests
       * every segment, so a folder *inside* an ignored tree is refused too — which matters because
       * that is the reachable case: nobody points a picker at `node_modules`, they point it at
       * something three levels inside one.
       */
      if (isIgnoredPath(segments)) {
        throw new ServiceError(
          ErrorCode.INVALID_ROOT,
          `this app does not look inside ${segments.join('/')}, so it cannot be used as a template`,
        )
      }

      const trimmed = name.trim()
      if (trimmed === '') throw new ServiceError(ErrorCode.NAME_EMPTY, 'a template needs a name')

      const current = config.registry().templates
      /**
       * **Both a duplicate id and a duplicate name are refused, and they are different problems.**
       *
       * The id is the handle every later message uses; two of them and the wrong template gets
       * scaffolded. The *name* is what the person reads in a menu, and two identically-named
       * entries is a menu where the right choice cannot be identified — the same reasoning that
       * split `ROOT_ALREADY_REGISTERED` out of `INVALID_ROOT` in the P7 review, so a refusal tells
       * you something you can act on instead of leaving you to re-pick forever.
       */
      /**
       * **P8-11 — a ceiling on stored templates.** The security review, P8 review: *"No cap on stored templates;
       * 400 registered without complaint."* They marked it Trivial and put it in the same class as
       * G5, which is the useful part: **it is cost, not containment.**
       *
       * The cost lands in two places a count does not suggest. Every template is an entry in the
       * config file that is read and rewritten on every registry change, and every template is a
       * **row in the `⋯` menu of every folder in the tree** — `actionsFor` builds one item per
       * available template. Four hundred of them is a menu nobody can use, arrived at without a
       * single refusal.
       *
       * Checked before the id and name refusals below because it is a fact about the registry rather
       * than about this template — there is nothing to say about a name when there is no room for it.
       */
      if (current.length >= MAX_STORED_TEMPLATES) {
        throw new ServiceError(
          ErrorCode.TOO_LARGE,
          `this app holds at most ${MAX_STORED_TEMPLATES} templates; remove one before adding another`,
        )
      }
      if (current.some(template => template.id === id)) {
        throw new ServiceError(ErrorCode.INVALID_ROOT, 'that template id is already in use')
      }
      /**
       * **P8-9 — the name comparison is NFC-folded, not byte equality.**
       *
       * security review, P8 review: *"Duplicate-name refusal is byte equality on the trimmed string; two NFC
       * spellings of `Café` both register."* `é` is one code point in NFC and two in NFD, macOS
       * hands back both depending on where a name came from, and they render **identically**. Byte
       * equality therefore admits a second template that a person cannot tell from the first —
       * which is precisely the harm the paragraph above says this refusal exists to prevent.
       *
       * **Deliberately NOT `grammarKey`, and that is a departure from the finding's own note.**
       * the security review observed that every other name comparison goes through it, and here that would be
       * wrong: `grammarKey` strips a leading `NN-` prefix, so `01-Report` and `Report` would
       * collide and the second would be refused. Those two are not confusable in a menu — they are
       * different names — and a false refusal is not an improvement on a false acceptance. §3's
       * prefix rule is about *folder grammar*, and a template's name is a label a person typed.
       *
       * So: NFC, then simple case fold, and no prefix stripping. Case folding stays because
       * `Report` and `report` sitting side by side in a menu is the same unreadable choice with a
       * thinner disguise.
       */
      const nameKey = foldCase(toNFC(trimmed))
      if (current.some(template => foldCase(toNFC(template.name.trim())) === nameKey)) {
        throw new ServiceError(ErrorCode.INVALID_ROOT, `there is already a template called ${trimmed}`)
      }

      const stored = { id, name: trimmed, rootId, segments: [...segments] }
      // Disk first. A template the app claims to have and will not remember is the silent
      // forgetting the folder registry was fixed for in August; no reason to reintroduce it here.
      const persisted = await config.updateRegistry(currentFile => ({
        ...currentFile,
        templates: [...currentFile.templates, stored],
      }))
      if (!persisted.ok) throw new ServiceError(persisted.code, persisted.detail ?? persisted.code)

      return { ...stored, available: true }
    },

    /** Forgets the entry. **The folder it pointed at is untouched** — this app deletes nothing. */
    'templates.deregister': async ({ id }) => {
      const current = config.registry().templates
      if (!current.some(template => template.id === id)) {
        throw new ServiceError(ErrorCode.INVALID_ROOT, 'no such template')
      }
      const persisted = await config.updateRegistry(currentFile => ({
        ...currentFile,
        templates: currentFile.templates.filter(template => template.id !== id),
      }))
      if (!persisted.ok) throw new ServiceError(persisted.code, persisted.detail ?? persisted.code)
      return { id }
    },

    'folders.register': async ({ id, absolutePath }) => {
      const registered = await registry.register(id, absolutePath)
      if (!registered.ok) throw new ServiceError(registered.code, registered.detail ?? registered.code)

      /**
       * INDEX IT. Nothing did, until 2026-08-08.
       *
       * `indexRoot` was written in P1, tested thoroughly, and **imported by no production module
       * at all** — five test files and nothing else. So a folder could be registered successfully
       * and every read route would then answer for it out of an empty index: `tree.children`
       * returned `[]` for a project with two hundred files in it, and returned it as a *success*.
       *
       * That is §6's banned shape — an empty-but-successful result standing in for something that
       * never happened — arrived at by a route that was individually correct. It is also the
       * build's signature failure written out in full: a control correct in isolation and never
       * reached. Every read route in the app was dead in production and every unit test passed,
       * because each test wires the indexer itself.
       *
       * Found the first time the real server was driven through a real tree
       * (`test/tools/drive-the-mock-soil.test.ts`), and by nothing before that.
       *
       * **Known limit, stated rather than hidden:** this blocks the response until the walk
       * finishes. §5 requires the cold-start index to stream and never block first paint, and
       * `indexRoot` already takes the progress callback that would deliver it — but there is no
       * client and no progress surface to stream to yet. Blocking is the honest interim: the
       * folder is either indexed when `register` returns or the registration failed. Wiring the
       * progressive form belongs with the surface that shows it (P9).
       */
      await indexRegisteredRoot(registered.value, index)

      /**
       * PERSIST IT, and **undo the registration if that fails.**
       *
       * The folder list was an in-memory `Map` until 2026-08-08 — add a folder, stop the app, it is
       * forgotten. That is the second half of the same defect as the index above: `config-store.ts`
       * was complete and imported by nothing.
       *
       * The rollback is what makes the answer honest. A registration that succeeded in memory and
       * failed to reach disk is a folder the app claims to have and will not remember, which is
       * exactly the silent forgetting this wiring exists to end. `deregister` is a map delete and
       * cannot itself fail here, so there is no half-state to reason about.
       */
      const persisted = await config.updateRegistry(current => ({
        ...current,
        roots: [
          ...current.roots.filter(root => root.id !== registered.value.id),
          { id: registered.value.id, absolutePath: registered.value.absolutePath },
        ],
      }))
      if (!persisted.ok) {
        registry.deregister(registered.value.id)
        index.clearRoot(registered.value.id)
        throw new ServiceError(persisted.code, persisted.detail ?? persisted.code)
      }

      // Watched only once the folder is real, indexed and recorded. Starting the watcher earlier
      // would leave a live watcher on a root the rollback above just removed.
      live?.watch(registered.value)

      return describe(registered.value)
    },

    /**
     * §13.2's read half, on the wire. The bytes and the hash the client must return to save.
     *
     * Decoded to a string here and only here. Everything below this line in Core is bytes — the
     * decode is the transport's business, because JSON cannot carry a Buffer, and doing it at the
     * edge keeps the engine's byte-exactness intact.
     *
     * **The decode is safe because `loadDocument` has already run §12's gate** — the bytes are
     * known to survive a round trip through a string, which is precisely the property this line
     * depends on and precisely what `editabilityRefusal` tests.
     *
     * **A round-trip check stood here and has been REMOVED, 2026-08-08.** It was correct and it was
     * in the wrong layer: it implemented half of §12 (the UTF-8 clause, never the NUL clause) at the
     * transport edge, where Core's write path could not reach it — so bad content could be *written*
     * even though a bad file could not be *opened*. The rule now lives in Core and is called on both
     * paths. Restoring a copy here would make Core's refusal unreachable from this route's tests,
     * which is how the P4 gate came to find a branch dead twenty minutes after it was written.
     */
    /**
     * **Reveal in Finder. The one place this application asks macOS to do something.** §10.
     *
     * **Three lines, and the order of the first two is the entire security argument.**
     * `resolveVerifiedPath` walks before it composes — it `lstat`s every segment from the registered
     * root down, refuses a symlinked one, refuses a path that escapes the root, and only then hands
     * back the absolute path. So what reaches `revealInFinder` is a path this process has just
     * verified on disk, not a string a client sent. §10: *"check the realpath, never the client
     * string."*
     *
     * There is deliberately **no extension allowlist**, and its absence is a decision rather than an
     * omission (§10, and §21 lists what was voided with Open in Default App). Revealing a `.app`
     * shows you a bundle in Finder; it does not run it. A closed type list here would be a control
     * with nothing behind it, and this build deletes those.
     *
     * The reveal itself cannot inject: `reveal.ts` calls `execFile` with an argument array, so the
     * filename is never parsed as a command no matter what an agent named it.
     */
    'file.reveal': async ({ rootId, segments }) => {
      const root = requireRootValue(rootId)
      const resolved = await resolveVerifiedPath(root, segments)
      if (!resolved.ok) throw new ServiceError(resolved.code, resolved.detail ?? resolved.code)

      const shown = await revealInFinder(resolved.value)
      if (!shown.ok) throw new ServiceError(shown.code, shown.detail ?? shown.code)
      return { revealed: true as const }
    },

    'file.load': async ({ rootId, segments }) => {
      const root = requireRootValue(rootId)
      const loaded = await loadDocument(root, segments)
      if (!loaded.ok) throw new ServiceError(loaded.code, loaded.detail ?? loaded.code)

      const content = loaded.value.bytes.toString('utf8')
      return {
        content,
        hash: loaded.value.baseline.sha256,
        bytes: loaded.value.bytes.length,
      }
    },

    /**
     * §13.2's write half. **This is where the per-target mutation lock is finally held** (§13.8).
     *
     * The lock is taken here rather than inside the Core verbs because this is where one mutation
     * begins and ends. Taking it inside `saveDocument` would serialize that call and leave the
     * load-then-compare above it unprotected — the halves of one operation locked separately, which
     * is the same gap in a different shape.
     *
     * **The server re-loads the document rather than trusting the client's hash.** The client's
     * `expectedHash` is a claim about what it was shown; `loadDocument` produces the only baseline
     * that can reach the write path, and the save proceeds solely when the two agree. A client
     * cannot manufacture a baseline by sending a well-formed digest.
     */
    'file.save': async ({ rootId, segments, content, expectedHash, confirmTruncation }) => {
      const root = requireRootValue(rootId)
      const bytes = Buffer.from(content, 'utf8')

      /**
       * Keyed on the path. **The sweep shows this key undefended and it is worth being precise
       * about why:** replacing it with a constant leaves every test green, because one lock for
       * everything still serializes correctly — it just serializes *too much*. That is a throughput
       * defect, not a safety one, and no assertion here can see it without timing, which would be
       * flaky.
       *
       * The key's own correctness — case folding on case-insensitive volumes, NFC, whole-segment
       * separation, root ids kept apart — is proven in `mutation-lock.test.ts`. What is unproven is
       * only that this call site passes the path rather than a constant.
       */
      return locks.withLock([lockKeyFor(root, segments)], async () => {
        const loaded = await loadDocument(root, segments)
        if (!loaded.ok) throw new ServiceError(loaded.code, loaded.detail ?? loaded.code)

        if (loaded.value.baseline.sha256 !== expectedHash) {
          /**
           * **A STALE BASELINE OVER IDENTICAL BYTES IS NOT A CONFLICT.** Added 2026-08-16; the
           * sweep found the unbounded harm this stops.
           *
           * A conflict is *two different versions of a document*. When the bytes being saved are
           * exactly the bytes on disk, there is no second version and nothing to choose between —
           * the end state the caller is asking for is already true. Rescuing here writes a sibling
           * file **byte-identical to the file it sits beside**, which §13.4 names as a harm in its
           * own right: a question with no answer teaches a person to dismiss the dialog without
           * reading it, and the one that mattered gets dismissed with it.
           *
           * **What made it unbounded rather than untidy.** `saveDocument` reports `IO_FAILED` when
           * the directory `fsync` fails *after* the rename has already landed — `write.ts` puts that
           * call inside the outer try, deliberately, so a save that succeeded is announced as
           * failed. The client then keeps `dirty` and does not advance its hash, so every later
           * flush re-sends the same content against the same stale `expectedHash`, and every one of
           * them arrived here. **One identical conflict artifact per retry, forever, in an app with
           * no delete.** The volume that does it is the one the code already anticipates: an
           * external or SMB disk that refuses `fsync` on a directory descriptor.
           *
           * This closes the loop from the far end, so the harm is capped no matter what produced the
           * stale baseline — a second client, an agent writing the same content, or that
           * false failure. **The reporting half is a separate judgment call and is the operator's**: it
           * means choosing between a false failure and a weaker durability promise, and `write.ts`
           * carries a written argument for the current behaviour that deserves an answer rather than
           * an overwrite.
           *
           * Compared as BYTES, not hashes. The hashes are equal here by construction if the bytes
           * are, and comparing the thing itself needs no argument about collisions.
           */
          if (bytes.equals(loaded.value.bytes)) {
            return { outcome: 'saved', hash: loaded.value.baseline.sha256, bytes: bytes.length }
          }

          /**
           * §13.4: the hash decides. The client is holding an edit against a version that is no
           * longer on disk, so **§13.5's rescue runs right here** — under the same lock, before
           * anything else can touch the directory, and before this call returns.
           *
           * The canonical file is deliberately left alone: `saveDocument` is never reached, so the
           * other writer's content survives untouched and the user chooses between the two.
           */
          return rescueTheEdit(root, segments, bytes)
        }

        const saved = await saveDocument(
          root, segments, loaded.value.baseline, bytes,
          confirmTruncation ? { confirmedTruncation: true } : {},
        )
        if (!saved.ok) {
          if (saved.code === ErrorCode.CONFLICT_DETECTED) {
            /**
             * **THE SECOND PLACE A CONFLICT IS DETECTED, and it needs the rescue as much as the
             * first.** `saveDocument` re-reads the file from the descriptor it is about to write
             * and hashes it again (§13.4 F4.6) — the check above compared a baseline this handler
             * loaded a moment earlier, and "a moment earlier" is a window.
             *
             * The lock keeps *this app* out of that window. It cannot keep an agent out, and an
             * agent writing to a file while the operator has it open is not an edge case here — it is
             * the tree's normal traffic and the reason §13.4 exists.
             *
             * Found by reading for the remaining `CONFLICT_DETECTED` producers after wiring the
             * first one, rather than by a test. Wiring the branch that was written down and
             * stopping there is how the original gap lasted three phases; both branches now reach
             * the same rescue, which is also why it is a function and not two copies.
             */
            return rescueTheEdit(root, segments, bytes)
          }
          if (saved.code === ErrorCode.TRUNCATION_BLOCKED) {
            /**
             * The numbers come from the baseline this call already loaded and the bytes it was
             * handed — **not from re-running the guard, and not from parsing `saved.detail`.**
             *
             * `saveDocument` remains the only thing that *decides*; this branch only reports the
             * two figures that decision was made from. A second `truncationCheck` here would be a
             * duplicated guard free to drift, and reading the numbers back out of a detail string
             * would make a human-readable message into a parsed format.
             */
            return {
              outcome: 'truncation-blocked',
              wasBytes: loaded.value.baseline.size,
              willBeBytes: bytes.length,
            }
          }
          throw new ServiceError(saved.code, saved.detail ?? saved.code)
        }

        /**
         * §5's echo dedup, keyed on **the exact `(path, size, mtimeNs)` this app just wrote** and
         * never on a time window. A window would swallow a real agent change that happened to land
         * inside it, which on this tree is not hypothetical.
         *
         * The baseline is the right source: it was taken by `fstat` on the temp descriptor after
         * `fsync` and before the rename (§13.4), so it describes the bytes that are now at the
         * path — not a second `stat` that could pick up somebody else's interleaved write.
         *
         * **Moves and copies are NOT echo-suppressed, and that is the mechanism's shape rather than
         * an omission.** The dedup confirms an echo by stat-ing the path it recorded; a move leaves
         * nothing at the source to stat, so the delete side can never be confirmed. Those announce
         * as real changes — noisy, correct, and harmless, since the client's answer is to refetch
         * what it is showing.
         */
        live?.noteOwnWrite(root.id, segments, saved.value.size, saved.value.mtimeNs)

        // The index would otherwise learn about this save only when the watcher noticed it, which
        // is up to 250 ms of coalescing away — long enough for the client's own refetch to arrive
        // first and be answered from a stale row.
        await reconcileEntry(root, index, segments)

        return { outcome: 'saved', hash: saved.value.sha256, bytes: bytes.length }
      })
    },

    'board.lanes': ({ rootId, project }) => {
      const root = requireRootValue(rootId)
      return lanesOf(index, rootId, project, root.caseInsensitive)
    },

    /**
     * **The scope is resolved against the index here, not trusted.** `requireRootValue` is the same
     * gate every other read passes, and `columnsUnder` reads only what the index currently holds —
     * so a scope naming a folder that has been moved away gathers nothing rather than gathering
     * something plausible. Same shape as a stale lane id resolving to nothing.
     */
    /**
     * **Markdown only, and files only.** §16 is *"jump to any file"* in a tree where a folder is not
     * a thing you open — the Files tab opens folders by expanding them, and a folder in a jump list
     * would be an entry that cannot do what the list promises.
     *
     * Reads `index.all()` rather than walking roots: the index is already the answer to "every path
     * this app knows", and re-deriving it here would be a second enumeration of the thing §16 says
     * explicitly not to build a second copy of.
     */
    'search.quickOpen': ({ query }) => {
      const candidates: Array<{ rootId: string; segments: readonly string[]; name: string; entry: IndexEntry }> = []
      for (const entry of index.all()) {
        if (entry.kind !== 'file' || !entry.isMarkdown) continue
        candidates.push({ rootId: entry.rootId, segments: entry.segments, name: entry.name, entry })
      }
      return search(query, candidates).hits
        .map(hit => ({ entry: wire(hit.candidate.entry), inName: hit.inName }))
    },

    'board.columns': ({ rootId, projects }) => {
      const root = requireRootValue(rootId)
      return columnsFor(index, rootId, projects, root.caseInsensitive)
    },

    'board.cardsFor': ({ rootId, projects }) => {
      const root = requireRootValue(rootId)
      // `wire` on every row — see the type above for what returning the index row itself costs.
      return cardsFor(index, rootId, projects, root.caseInsensitive)
        .map(lane => ({ laneId: lane.laneId, cards: lane.cards.map(wire) }))
    },

    'projects.board': () => board(),

    'projects.setColumns': async ({ columns }) => {
      const trimmed = columns.map(column => ({ id: column.id, name: column.name.trim() }))
      if (trimmed.some(column => column.id === '' || column.name === '')) {
        throw new ServiceError(ErrorCode.NAME_EMPTY, 'a column needs an id and a name')
      }
      if (new Set(trimmed.map(column => column.id)).size !== trimmed.length) {
        throw new ServiceError(ErrorCode.INVALID_ROOT, 'two columns cannot share an id')
      }
      if (trimmed.length === 0) {
        // A board with no columns has nowhere to put anything, and every card would fall back to a
        // column that does not exist. Refused rather than silently restored to the defaults, which
        // would look like the edit was ignored.
        throw new ServiceError(ErrorCode.NAME_EMPTY, 'a board needs at least one column')
      }
      await saveUi(current => ({ ...current, projectColumns: trimmed }))
      return board()
    },

    'projects.place': async ({ rootId, segments, columnId }) => {
      const root = requireRootValue(rootId)
      /**
       * **The project must exist and the column must exist.** Neither check protects the disk —
       * nothing here writes to it — they protect the config from accumulating placements for
       * things that are not there, which is how a config file becomes a second, wrong copy of the
       * tree.
       */
      /**
       * **P9-8 — folded, like the line below it.** The security review, P9 review: *"`projects.place` compares
       * byte-exactly while placement folds through `comparisonKey`."*
       *
       * Two lines of one function disagreeing about when two paths are the same path, and **the
       * guard was the stricter one**, so the bug was a false refusal: a request naming a real
       * project in a spelling `withPlacement` treats as identical was answered *"no such project"*.
       * On macOS's default case-insensitive volume that is an ordinary thing for a client to send.
       *
       * `comparisonKey` is the same function the storage uses, given the same `caseInsensitive` flag
       * measured at registration — so the check and the write can no longer disagree.
       */
      const wanted = comparisonKey(segments, root.caseInsensitive)
      const exists = projectsOf(index, rootId, root.caseInsensitive)
        .some(project => comparisonKey(project.segments, root.caseInsensitive) === wanted)
      if (!exists) throw new ServiceError(ErrorCode.INVALID_ROOT, 'no such project')
      if (!columnsOf(config.uiState()).some(column => column.id === columnId)) {
        throw new ServiceError(ErrorCode.INVALID_ROOT, 'no such column')
      }

      await saveUi(current => withPlacement(current, rootId, segments, columnId, root.caseInsensitive))
      return board()
    },

    'projects.stage': async ({ id, name, body, columnId }) => {
      const trimmed = name.trim()
      if (trimmed === '') throw new ServiceError(ErrorCode.NAME_EMPTY, 'a card needs a name')
      if (!columnsOf(config.uiState()).some(column => column.id === columnId)) {
        throw new ServiceError(ErrorCode.INVALID_ROOT, 'no such column')
      }

      /**
       * **P9-5, and the id half is fixed by removing the choice rather than by checking it.**
       *
       * security review, P9 review: *"client-chosen ids including `../../etc/passwd` and a literal NUL written
       * into config."* The NUL half went with P9F-5, which refuses control characters in a **name**;
       * an **id** never went through that door and was stored exactly as sent.
       *
       * An id is now one of two things: **empty**, meaning *make me one*, or **one this server
       * already minted**, meaning *edit that one*. There is no third case — so no string a client
       * invents reaches the config at all, and there is no allowlist of dangerous shapes that has to
       * stay complete as the world invents new ones. `staged-99` is refused for the same reason
       * `../../etc/passwd` is: the rule is "one I issued", not "one that looks like mine".
       */
      const state = config.uiState()
      const known = state.stagedCards.some(card => card.id === id)
      if (id !== '' && !known) {
        throw new ServiceError(ErrorCode.INVALID_ROOT, 'no such card')
      }

      /**
       * **The ceiling, and it applies to creating rather than to editing.** Every write rewrites the
       * whole config file, which is where the security review's *"quadratic"* comes from: the cost of adding the
       * nth card is proportional to the n-1 already there.
       *
       * An update is never refused by it. A person sitting at the ceiling must still be able to fix
       * a typo; a cap that also blocked edits would trap them there with no way out but deletion,
       * and there is no delete in this app.
       */
      if (id === '' && state.stagedCards.length >= MAX_STAGED_CARDS) {
        throw new ServiceError(
          ErrorCode.TOO_LARGE,
          `this board holds at most ${MAX_STAGED_CARDS} staged cards`,
        )
      }

      // And the third: a body large enough to matter. `MAX_BODY_BYTES` bounds one request at a
      // megabyte, which bounds a single card and not a hundred of them accumulating in one file.
      if (body.length > MAX_STAGED_BODY_CHARS) {
        throw new ServiceError(
          ErrorCode.TOO_LARGE,
          `a card's description is limited to ${MAX_STAGED_BODY_CHARS} characters`,
        )
      }

      await saveUi(current => {
        const existing = current.stagedCards.find(card => card.id === id)
        const card = { id: id === '' ? nextStagedId(current) : id, name: trimmed, body, columnId }
        return {
          ...current,
          stagedCards: existing === undefined
            ? [...current.stagedCards, card]
            : current.stagedCards.map(each => (each.id === id ? card : each)),
        }
      })
      return board()
    },

    'projects.unstage': async ({ id }) => {
      if (!config.uiState().stagedCards.some(card => card.id === id)) {
        throw new ServiceError(ErrorCode.INVALID_ROOT, 'no such card')
      }
      await saveUi(current => ({
        ...current,
        stagedCards: current.stagedCards.filter(card => card.id !== id),
      }))
      return board()
    },

    'inbox.list': () => registry.list().flatMap(root =>
      inboxesOf(index, root.id, root.caseInsensitive).map(group => ({
        rootId: group.rootId,
        segments: group.segments,
        label: group.label,
        items: group.items.map(wire),
      }))),

    /**
     * **Reads `index.all()`, exactly as `search.quickOpen` does and for the reason stated there:**
     * *"the index is already the answer to 'every path this app knows', and re-deriving it here
     * would be a second enumeration."* A walk would also be a second place for §3's archive and
     * ignore rules to be applied, which is precisely how three name lists came to have three
     * different semantics in v1.
     *
     * Every rule about what counts is in `core/boards.ts` and proven without a filesystem. This is
     * the adapter and nothing more.
     */
    /**
     * **The registered templates go in with the entries, so a template folder is not listed as a
     * board.** The operator's board template is a folder called `board-template` — it answers the
     * grammar's question correctly, and without this it sits in the list as a board called
     * *Template*, offering to be opened and filled in.
     *
     * `caseInsensitive` is read off each template's own registered folder rather than assumed: it is
     * a property of the volume that folder lives on, and this is the only layer that knows it. A
     * template whose folder is no longer registered contributes nothing, which is the same answer
     * `templates.list` gives it.
     */
    'boards.list': () => boardsIn(index.all(), config.registry().templates.flatMap(template => {
      const root = registry.get(template.rootId)
      return root === undefined
        ? []
        : [{
          rootId: template.rootId,
          segments: template.segments,
          caseInsensitive: root.caseInsensitive,
        }]
    })),

    /**
     * **The scope is resolved against the index, not trusted** — `requireRootValue` is the gate every
     * other read passes, and `boardContents` reads only what the index currently holds. A board that
     * has been moved away gathers nothing rather than gathering something plausible.
     *
     * The arrangement is applied **here rather than in `boardContents`**, so the pure function stays
     * provable without a config file and the two rules — what is a card, and what order — can each
     * be broken on their own.
     */
    'boards.open': ({ rootId, segments }) => openBoardAt(rootId, segments),

    /**
     * **Config only. Nothing on disk moves.**
     *
     * `segments` names the **column's folder**, which is what the order is keyed against — and it is
     * resolved through `requireRootValue` like every other path, so an order cannot be written
     * against a root the caller does not have.
     *
     * **The board it belongs to is derived, not passed.** A caller supplying both could name a
     * column under one board and a board under another, and the order would be written somewhere
     * neither of them is looking. One path in, one place it can land.
     */
    /**
     * **Columns, arranged against the board.** P14 follow-up, 2026-08-21.
     *
     * A sibling of `boards.setOrder` rather than a mode of it: that one keys against a **column**
     * and this against a **board**, and one route taking "a path that means different things
     * depending on a flag" is how a caller ends up writing a card order onto a board. Config only —
     * nothing on disk moves, per the rule for the Projects board.
     */
    'boards.setColumnOrder': async ({ rootId, segments, order }) => {
      const root = requireRootValue(rootId)
      if (segments.length === 0) {
        throw new ServiceError(ErrorCode.PATH_EMPTY, 'a column order belongs to a board')
      }
      await saveUi(current =>
        withColumnOrder(current, rootId, segments, order, root.caseInsensitive))
      return openBoardAt(rootId, segments)
    },

    'boards.setOrder': async ({ rootId, segments, order }) => {
      const root = requireRootValue(rootId)
      if (segments.length < 2) {
        // A column always sits inside a board, so its path is at least `board-x/column`. A shorter
        // one would key an order against the board itself, where no cards are arranged.
        throw new ServiceError(ErrorCode.PATH_EMPTY, 'a card order belongs to a column')
      }

      await saveUi(current => withCardOrder(current, rootId, segments, order, root.caseInsensitive))

      // Repainted from the board the server now holds, rather than the client applying its own
      // guess — the same shape `projects.setColumns` returns, and for the same reason.
      return openBoardAt(rootId, segments.slice(0, -1))
    },

    'projects.list': () => registry.list()
      .flatMap(root => projectsOf(index, root.id, root.caseInsensitive)),

    'board.cards': ({ rootId, project }) => {
      const root = requireRootValue(rootId)
      return cardsOf(index, rootId, project, root.caseInsensitive)
        .map(lane => ({ laneId: lane.laneId, cards: lane.cards.map(wire) }))
    },

    'card.move': async ({ rootId, card, laneId, token }) => {
      const root = requireRootValue(rootId)

      /**
       * **Resolved before the lock and re-resolved inside it.** The first resolve refuses a stale
       * board cheaply; the second is the one that counts, because between them a rename could have
       * taken the lane away and a move into a lane that no longer exists is precisely M2.
       *
       * The pattern is `file.save`'s: the check outside the lock is courtesy, the check inside is
       * the control.
       */
      const preview = resolveLaneDestination(index, rootId, card, laneId, root.caseInsensitive)
      if (!preview.ok) throw new ServiceError(preview.code, preview.detail ?? preview.code)

      const keys = [
        lockKeyFor(root, card.slice(0, -1)),
        lockKeyFor(root, preview.value.segments.slice(0, -1)),
      ]
      return locks.withLock(keys, async () => {
        // §13.8 on the card itself. The lane is re-resolved below and that covers the *destination*
        // going stale; this covers the *card* — an agent replacing the file between the board's
        // paint and the drop, which would move something the user never saw into the lane.
        await requireUnchanged(root, card, token)

        const destination = resolveLaneDestination(index, rootId, card, laneId, root.caseInsensitive)
        if (!destination.ok) {
          throw new ServiceError(destination.code, destination.detail ?? destination.code)
        }

        /**
         * §13.6's exclusive rename, the same verb the Files view uses. **Nothing here creates a
         * directory**: the destination folder came out of the index, and `exclusiveRename` refuses
         * rather than replacing whatever is at the name.
         */
        const moved = await exclusiveRename(root, card, destination.value.segments)
        if (!moved.ok) throw new ServiceError(moved.code, moved.detail ?? moved.code)
        await refreshIndex(root, moved.value.from, moved.value.to)

        // The same retarget `entry.rename` does, for the same reason and with the same ordering.
        const retargeted = await config.updateUiState(
          current => retargetPathKeys(current, root.id, moved.value.from, moved.value.to),
        )
        if (!retargeted.ok) {
          void onConfigFailure?.('card.move', retargeted.detail ?? retargeted.code)
        }

        return { to: [...moved.value.to], lane: destination.value.lane }
      })
    },

    /**
     * **Quick-add.** The lane is an id; the folder is the server's answer.
     *
     * Resolved twice, exactly as `card.move` resolves twice and for the same reason: the resolve
     * outside the lock refuses a stale board cheaply, and the resolve *inside* it is the control —
     * between them a rename can take the lane away, and creating into a lane that no longer exists
     * is M2 in its purest form, because here there really would be a new file at the end of it.
     *
     * **Nothing here creates a directory.** `createEntry` writes one file with `O_CREAT|O_EXCL`
     * into a folder that came out of the index. A lane that has been renamed produces a refusal and
     * a board reload, never a resurrected folder.
     */
    'card.create': async ({ rootId, project, laneId, name }) => {
      const root = requireRootValue(rootId)

      const preview = resolveLaneFolder(index, rootId, project, laneId, root.caseInsensitive)
      if (!preview.ok) throw new ServiceError(preview.code, preview.detail ?? preview.code)

      // Slugified on the server and only on the server — `entry.create` records why at length.
      const named = fileNameFrom(name, 'md')
      if (!named.ok) throw new ServiceError(named.code, named.detail ?? named.code)
      // A5's seed, carrying what the person typed rather than the slug, so the card's title is
      // theirs: `title.ts` reads the first heading, and that is what the board draws.
      const seed = `# ${toNFC(name).trim()}\n`

      return locks.withLock([lockKeyFor(root, preview.value.segments)], async () => {
        const folder = resolveLaneFolder(index, rootId, project, laneId, root.caseInsensitive)
        if (!folder.ok) throw new ServiceError(folder.code, folder.detail ?? folder.code)

        const created = await createEntry(
          root, [...folder.value.segments, named.value.name], 'file', seed,
        )
        if (!created.ok) throw new ServiceError(created.code, created.detail ?? created.code)
        await refreshIndex(root, created.value.segments)
        return { segments: [...created.value.segments], lane: folder.value.lane }
      })
    },

    /**
     * **A message is appended, and the number is decided here.** Spec §14.
     *
     * The whole operation runs under **the same lock key a full-file save takes**, and that is what
     * makes §14's promise true: *"the same key governs full-file saves, so an append can never race
     * a save of the same file."* The spec phrases the key as `(st_dev, st_ino)`; this build keys
     * every mutation by folded path through `lockKeyFor`, and using a second, inode-based namespace
     * for this one route would be worse than the difference it closes — an append and a save would
     * then take *different* locks and not serialize at all, which is the exact failure the clause
     * exists to prevent.
     *
     * **Read, number, write — all inside the lock.** The read is what the number comes from, so a
     * number computed outside it would be stale before it was used.
     *
     * The path must be a chatroom by §14's equality. A composer only exists on a conversation
     * somebody is reading, so a request naming anything else is a client that composed a path
     * rather than one that was handed it.
     */
    'chatroom.append': async ({ rootId, segments, author, body }) => {
      const root = requireRootValue(rootId)
      if (!isChatroom(segments)) {
        throw new ServiceError(ErrorCode.NOT_MARKDOWN, 'that file is not a chatroom')
      }
      const named = author.trim()
      const said = body.trim()
      if (named === '') throw new ServiceError(ErrorCode.NAME_EMPTY, 'a message needs an author')
      if (said === '') throw new ServiceError(ErrorCode.NAME_EMPTY, 'a message needs a body')

      return locks.withLock([lockKeyFor(root, segments)], async () => {
        /**
         * Read and numbered from the bytes on disk **at this moment**, not from anything the client
         * sent. `appendToDocument` hands back what it read for exactly this reason: computing the
         * number from a second, separate read would open a window between them.
         */
        const peeked = await appendToDocument(root, segments, '')
        if (!peeked.ok) throw new ServiceError(peeked.code, peeked.detail ?? peeked.code)

        const number = nextNumberIn(peeked.value.existing)
        const block = appendBlockFor(peeked.value.existing, number, named, said)

        const written = await appendToDocument(root, segments, block)
        if (!written.ok) throw new ServiceError(written.code, written.detail ?? written.code)
        await refreshIndex(root, segments)
        return { number, size: written.value.size }
      })
    },

    'folders.browse': async ({ absolutePath }) => {
      const scope = storage.browseScope
      const roots = browseRoots(scope)

      // The opening request. Answering with the roots rather than defaulting to home keeps the
      // client from having to name a path it was never given, and makes "where can I even look"
      // a question with an explicit answer instead of a convention.
      const at = absolutePath === '' ? scope.home : absolutePath

      const listed = await browseDirectories(at, scope)
      if (!listed.ok) throw new ServiceError(listed.code, listed.detail ?? listed.code)
      return { ...listed.value, roots }
    },

    'entry.create': async ({ rootId, parent, name, kind }) => {
      const root = requireRootValue(rootId)

      /**
       * Slugified here, on the server, and this is the only place it happens.
       *
       * §13.6's rule has an M16-shaped hole in it if the client does this: two implementations of
       * "what filename does this text become" drift, and the one that drifts wrong produces a file
       * named `.md`. The client's job is to *show* the answer — `fileNameFrom` returns `changed` so
       * it can — not to compute it.
       */
      const named = fileNameFrom(name, kind === 'file' ? 'md' : undefined)
      if (!named.ok) throw new ServiceError(named.code, named.detail ?? named.code)

      const segments = [...parent, named.value.name]

      // The destination parent's lock, so a create and a rename aiming at the same name in the same
      // folder cannot both find it free. The exclusive syscall would still refuse the loser; the
      // lock is what keeps the refusal from being a race the user sees intermittently.
      /**
       * Annex A5's seed: the body starts as a heading carrying **what the person typed**, not the
       * slug. `title.ts` reads the first heading as the document's title, so this is where their
       * capitalisation and spacing survive — `My Meeting Notes` rather than `my-meeting-notes`.
       *
       * NFC-normalised and trimmed, and otherwise used verbatim. No escaping: it is their own text
       * in their own document, and a heading has no syntax to break out of.
       */
      const seed = kind === 'file' ? `# ${toNFC(name).trim()}\n` : ''

      return locks.withLock([lockKeyFor(root, parent)], async () => {
        const created = await createEntry(root, segments, kind, seed)
        if (!created.ok) throw new ServiceError(created.code, created.detail ?? created.code)
        await refreshIndex(root, created.value.segments)
        return { segments: [...created.value.segments], kind: created.value.kind }
      })
    },

    'entry.rename': async ({ rootId, from, to, token }) => {
      const root = requireRootValue(rootId)
      // Both parents are locked, in one acquisition. A move touches two folders, and holding only
      // the source's would leave the destination free for a concurrent create to win the name
      // between the check and the link.
      const keys = [
        lockKeyFor(root, from.slice(0, -1)),
        lockKeyFor(root, to.slice(0, -1)),
      ]
      return locks.withLock(keys, async () => {
        // §13.8, inside the lock. Outside it, our own concurrent mutation could land between the
        // check and the rename — which is the window the check exists to close, reopened by
        // putting the check on the wrong side of the thing that closes it.
        await requireUnchanged(root, from, token)
        const moved = await exclusiveRename(root, from, to)
        if (!moved.ok) throw new ServiceError(moved.code, moved.detail ?? moved.code)
        await refreshIndex(root, moved.value.from, moved.value.to)

        /**
         * §13.8: *"any operation that renames or moves a path updates every config key referencing
         * it, in the same transaction."* Without it the Projects board's column arrangement — keyed
         * by project path — reverts to the default the moment a project is renamed. The app quietly
         * undoing the user's own arrangement, with no error and nothing to point at.
         *
         * **After the rename, not before, and the choice matters.** Retargeting first would move
         * every key for a rename that then fails — and a rename failing is *ordinary*, it is what a
         * name collision produces. That would scramble the arrangement on the common path to
         * protect against a crash on the rare one.
         *
         * **A failed write does not fail the rename**, because the rename already happened and
         * cannot be safely undone. The keys are then stale, which the next startup resolves the way
         * §13.8 requires: marked unresolved and retained, never dropped.
         */
        const retargeted = await config.updateUiState(
          current => retargetPathKeys(current, root.id, moved.value.from, moved.value.to),
        )
        if (!retargeted.ok) {
          void onConfigFailure?.('entry.rename', retargeted.detail ?? retargeted.code)
        }

        return { to: [...moved.value.to], kind: moved.value.kind }
      })
    },

    'entry.copy': async ({ rootId, from, to, plan, token }) => {
      const root = requireRootValue(rootId)

      if (plan) {
        // A plan writes nothing, so this is not a data-safety check — it is an honesty one. A plan
        // reports a file count the client puts in a confirmation ("this will copy 214 files"); if
        // the source was replaced, that number describes something the user never saw.
        await requireUnchanged(root, from, token)
        // A plan writes nothing, so it takes no lock — and must not, or a slow walk over a large
        // project would block saves in the destination folder for its duration.
        const planned = await planRecursiveCopy(root, from, to)
        if (!planned.ok) throw new ServiceError(planned.code, planned.detail ?? planned.code)
        return {
          files: planned.value.files,
          bytes: planned.value.bytes,
          skipped: [
            ...planned.value.skippedSymlinks,
            ...planned.value.skippedOther,
            ...planned.value.skippedIgnored,
          ],
        }
      }

      return locks.withLock([lockKeyFor(root, to.slice(0, -1))], async () => {
        await requireUnchanged(root, from, token)
        const copied = await recursiveCopy(
          root, from, to, storage.stagingRoot, registry.list(),
        )
        if (!copied.ok) throw new ServiceError(copied.code, copied.detail ?? copied.code)
        // The destination only — the source is untouched by a copy, and reconciling it would walk
        // a whole project to learn nothing.
        await refreshIndex(root, copied.value.to)
        return {
          files: copied.value.files,
          bytes: copied.value.bytes,
          skipped: [
            ...copied.value.skippedSymlinks,
            ...copied.value.skippedOther,
            ...copied.value.skippedIgnored,
          ],
          to: [...copied.value.to],
        }
      })
    },

    'conflict.resolve': async ({ rootId, canonical, artifact, choice, token }) => {
      const root = requireRootValue(rootId)
      // The canonical path is the lock target: both files are siblings, and every outcome either
      // rewrites the canonical document or moves a file beside it.
      return locks.withLock([lockKeyFor(root, canonical)], async () => {
        /**
         * §13.8 on the **canonical** file, not the artifact.
         *
         * The artifact is a write-once rescue: nothing in this app appends to one, so it does not
         * drift. The canonical file is the one an agent can rewrite while the two-pane view sits
         * open — and every choice here is a decision *about* its current contents. Keep Theirs in
         * particular discards the artifact in favour of a canonical the user may never have seen.
         */
        await requireUnchanged(root, canonical, token)

        const resolved = await resolveConflict(
          root, canonical, artifact, choice, storage.archiveRoot, registry.list(),
        )
        if (!resolved.ok) throw new ServiceError(resolved.code, resolved.detail ?? resolved.code)
        // Both sides. The artifact has moved to the app-private archive, so its row must go —
        // otherwise a resolved conflict stays on the "Needs attention" list forever.
        await refreshIndex(root, canonical, artifact, resolved.value.keptAlongside ?? [])
        return {
          canonical: [...resolved.value.canonical],
          ...(resolved.value.keptAlongside
            ? { keptAlongside: [...resolved.value.keptAlongside] }
            : {}),
        }
      })
    },

    'folders.deregister': async ({ id }) => {
      // The root must exist before anything is written, so a bad id is refused without touching the
      // file at all.
      if (registry.get(id) === undefined) {
        throw new ServiceError(ErrorCode.INVALID_ROOT, 'no folder with this id is registered')
      }

      /**
       * **DISK FIRST HERE, memory second — the opposite order to `register`, and deliberately so.**
       *
       * Rolling a removal back would mean re-registering, which is an async probe of a path that
       * may have changed in the meantime — a rollback that can itself fail. Writing first means a
       * failed write leaves everything exactly as it was, with nothing to undo.
       *
       * §13.8's M7: the entry moves to `deregistered`, it is never dropped. Nothing in this app
       * deletes, and that applies to its own memory of what the operator told it.
       */
      const persisted = await config.updateRegistry(current => deregisterRoot(current, id))
      if (!persisted.ok) throw new ServiceError(persisted.code, persisted.detail ?? persisted.code)

      const result = registry.deregister(id)
      if (!result.ok) throw new ServiceError(result.code, result.detail ?? result.code)
      // The index rows are dropped with the root. Leaving them would let a deregistered folder keep
      // answering `tree.children` from cache — a folder the operator believes they have disconnected.
      index.clearRoot(id)
      // And the watcher goes with them. A watcher on a deregistered folder holds a descriptor and
      // announces changes for a folder the app is no longer supposed to be looking at.
      live?.unwatch(id)
      return { id }
    },
  }
}
