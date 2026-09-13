/**
 * App config: reading it safely, writing it atomically, and retargeting keys when paths move.
 * Spec §13.8.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * §6 names this as one of exactly two places the app writes non-markdown bytes — *"recursive-copy
 * output and **app config outside every root**"* — so the atomic writer here is a sanctioned
 * exception rather than a second write path that drifted into existence.
 *
 * Three rules from §13.8 shape the whole file, and each exists because breaking it loses something
 * that cannot be recovered:
 *
 *   - **A config that fails to parse is preserved and surfaced, never silently replaced with
 *     defaults.** Replacing it deregisters every folder — the app comes up looking empty and
 *     "helpfully" writes that emptiness back over the only record of what was registered.
 *   - **Removal appends to a `deregistered` list rather than dropping the entry** (M7). Nothing in
 *     this app deletes, and that applies to its own memory of what you told it.
 *   - **A config key whose path no longer resolves is retained, not dropped**, and surfaced as
 *     unresolved. An external volume that is merely unplugged must not erase the arrangement of
 *     everything on it.
 *
 * **TWO FILES, NOT ONE — §13.8's M7, and this module got it wrong until 2026-08-08.** The rule is
 * stated in the spec and again in this phase's own brief: *"The folder registry and UI state are
 * separate files (M7 — sharing one file means a UI-state write from a stale copy deregisters
 * folders)."* A single `AppConfig` carrying `roots`, `deregistered` **and** `pathKeys` was built
 * anyway, and nothing noticed for a phase and a half **because nothing ever wrote a file** — the
 * whole module was reachable from its tests and from no production code.
 *
 * The asymmetry is the point. UI state is rewritten every time a card moves; the registry changes
 * only when the operator adds or removes a folder. Sharing a file puts the rare, precious record behind
 * the frequent, careless writer — so one bug in board rearrangement takes the folder list with it.
 * Hence `RegistryFile` and `UiStateFile`, a validator each, and a generic reader that cannot mix
 * them up.
 */

import { randomBytes } from 'node:crypto'
import { constants, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isWithin } from '../paths'
import { errnoOf } from './containment'

/** A folder the user registered, as it survives a restart. */
export interface StoredRoot {
  readonly id: string
  readonly absolutePath: string
}

/**
 * Config addressed by path — the Projects board's column arrangement is the PRD's example.
 *
 * Keyed by `rootId` plus folder-relative segments rather than by an absolute path, for the same
 * reason the API is: an absolute path in a config file is a second source of truth about where a
 * root lives, and the two drift.
 */
export interface PathKey {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly value: unknown
  /**
   * True when the path this key describes could not be found at load.
   *
   * **Retained, never dropped** (§13.8). A volume that is unplugged this morning is plugged in
   * this afternoon, and erasing the user's arrangement in between is a silent, permanent loss of
   * work they did by hand.
   */
  readonly unresolved?: boolean
}

/** The folder registry. Written only by explicit register/deregister — §13.8. */
/**
 * A named folder shape the user can scaffold from. Spec §19, Phase 8.
 *
 * **A pointer, never a snapshot**, and that is the operator's requirement rather than an implementation
 * shortcut: *"that template might change… these things take shape."* Storing a copy of the shape
 * would mean an "update the template" step, and a template that silently drifts from the folder it
 * was taken from. Pointing at the folder means the template is whatever that folder is today.
 *
 * **Addressed as `rootId` + `segments`, never as an absolute path.** A template therefore lives
 * inside a folder the user has registered, and every containment rule in §4 covers it for free —
 * the walk, the per-segment symlink refusal, the scope bound from the security review's C2. An absolute path
 * would be a second way into the filesystem, sitting beside the one that is proven.
 */
export interface StoredTemplate {
  readonly id: string
  /** What the user typed. Shown in Settings and in the row menu. */
  readonly name: string
  readonly rootId: string
  readonly segments: readonly string[]
}

export interface RegistryFile {
  /**
   * **Keys this parser did not recognise, held so the writer can put them back.** P9-6.
   *
   * Never interpreted, never merged into anything, and absent entirely for an ordinary file — so a
   * file with no unknown keys round-trips byte-identically rather than gaining an empty object.
   *
   * It exists because reading defaults an absent key and writing emits only the parsed shape, so a
   * misspelled or newer-than-this-build key is erased by **the next save** rather than by the
   * misspelling. §13.8 already settles the principle one level down: retained, not dropped.
   */
  readonly carried?: Record<string, unknown>
  readonly roots: readonly StoredRoot[]
  /** Appended to on removal. Never emptied by this module. */
  readonly deregistered: readonly StoredRoot[]
  /**
   * Kept in this file rather than a third one, because a template names a `rootId` that lives here
   * — two files would let a folder be deregistered in one and still referenced by the other, with
   * no single read that could see both.
   */
  readonly templates: readonly StoredTemplate[]
}

/** UI state. Rewritten often, and therefore kept away from the registry. */
/**
 * A column on the Projects board. Phase 9.
 *
 * **App config, and it never touches the file tree.** The PRD is explicit — *"arranged in a kanban
 * (e.g. working-on / active / queue) whose arrangement lives in **app config only — it never
 * touches the file tree**"* — and that is the one place in this app where a lane is not a folder.
 * Tasks lanes ARE folders; project columns are a view onto folders that exist elsewhere.
 *
 * ruled 2026-08-10: *"think of that as a Trello… the three statuses should be active, next, back
 * burner… and I can add a new column, I can edit the names of the column."* So the set is their to
 * change, which is why it is stored rather than derived.
 */
export interface ProjectColumn {
  readonly id: string
  readonly name: string
}

/**
 * A card on the Projects board that is **not a folder on disk**. The operator's idea, 2026-08-10.
 *
 * > *"Let's say I have something in mind… it would be really nice for me to be able to just add a
 * > card that doesn't affect the file system… I know I'm gonna need to do this project, so let me
 * > do this in the queue. It doesn't mean I wanna scaffold the folder just yet."*
 *
 * A name, a body, and a column. Nothing else, and **nothing is created anywhere** — which is the
 * whole point of it and the reason it lives here rather than as a file. The board draws it
 * differently so there is never a question about which cards are real.
 *
 * **The one rule that matters: a staged card is not a project.** It is not returned by
 * `projects.list`, it has no path, and no verb that takes `(rootId, segments)` will ever accept
 * one. Scaffolding it into a real project later is a separate, explicit act — and that act is not
 * built yet, deliberately, because the operator asked for the staging half and did not ask for the
 * promotion half.
 */
export interface StagedCard {
  readonly id: string
  readonly name: string
  /** Free text. The reason they want this at all: somewhere to put the thought. */
  readonly body: string
  readonly columnId: string
}

/**
 * One project ticked in the Tasks board's filter. **Display state, never a permission.**
 *
 * Stored so the selection survives a restart — ruled 2026-08-12: *"if I go to files or I go to
 * projects or I navigate away, I shouldn't have to re-filter everything back to the view that I was
 * in."* Within a session that is already free (the tabs are separate panes that stay mounted); this
 * is the across-restarts half.
 *
 * **A stale entry is harmless by construction.** It names a project that may since have been
 * renamed or moved; the board resolves the selection against the index at read time, so an entry
 * matching nothing simply contributes nothing. It can never make the board show something that is
 * not there, only fail to narrow — and the failure direction is *more* tasks, not fewer, which is
 * the safe way round for a filter.
 */
export interface SelectedProject {
  readonly rootId: string
  readonly segments: readonly string[]
}

export interface UiStateFile {
  /**
   * **Keys this parser did not recognise, held so the writer can put them back.** P9-6.
   *
   * Never interpreted, never merged into anything, and absent entirely for an ordinary file — so a
   * file with no unknown keys round-trips byte-identically rather than gaining an empty object.
   *
   * It exists because reading defaults an absent key and writing emits only the parsed shape, so a
   * misspelled or newer-than-this-build key is erased by **the next save** rather than by the
   * misspelling. §13.8 already settles the principle one level down: retained, not dropped.
   */
  readonly carried?: Record<string, unknown>
  readonly pathKeys: readonly PathKey[]
  /**
   * The Projects board's columns, in order. Empty means "not arranged yet" — the server supplies
   * the defaults rather than this file being pre-seeded, so a person who never touches the board
   * has no stored arrangement to drift from the defaults.
   */
  readonly projectColumns: readonly ProjectColumn[]
  readonly stagedCards: readonly StagedCard[]
  /**
   * The Tasks board's filter. **Empty means every project** — the default — so an absent key and a
   * cleared filter are the same state, which is what stops "never chosen" and "chosen then
   * cleared" from needing to be told apart.
   */
  readonly boardSelection: readonly SelectedProject[]
}

export const EMPTY_REGISTRY: RegistryFile = { roots: [], deregistered: [], templates: [] }
export const EMPTY_UI_STATE: UiStateFile =
  { pathKeys: [], projectColumns: [], stagedCards: [], boardSelection: [] }

/**
 * What a read produced.
 *
 * `missing` and `unreadable` are deliberately different outcomes. A missing file is first run and
 * the right response is defaults; an unparseable one is a *damaged* record and the right response
 * is to stop and say so. Collapsing them is exactly how a corrupt config becomes an empty one.
 */
export type ConfigLoad<T> =
  | { readonly kind: 'loaded'; readonly config: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly detail: string }

/** A validator for one config file's shape. The reader is generic over these; see `M7` above. */
export type ConfigValidator<T> = (value: unknown) => Result<T>

/**
 * Reads a config file. **Never writes, never repairs, never falls back to defaults on damage.**
 *
 * The `unreadable` branch is the one that matters. §13.8 requires the file be preserved and
 * surfaced; this function's contribution to that is simply to refuse to interpret it, so no caller
 * can mistake damage for emptiness. The caller shows the error; nothing overwrites the file.
 *
 * The validator is a parameter rather than a fixed one, so the registry and UI state read through
 * the same proven path without either becoming able to parse as the other.
 */
export async function readConfig<T>(
  absolutePath: string,
  validate: ConfigValidator<T>,
): Promise<ConfigLoad<T>> {
  let raw: Buffer
  try {
    raw = await fsp.readFile(absolutePath)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', detail: `could not read the config file: ${code ?? 'unknown'}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return { kind: 'unreadable', detail: 'the config file is not valid JSON' }
  }

  const validated = validate(parsed)
  if (!validated.ok) return { kind: 'unreadable', detail: validated.detail ?? 'invalid config' }
  return { kind: 'loaded', config: validated.value }
}

/**
 * Restored config is untrusted input — F9.2.
 *
 * The file is on the user's own disk, so this is not defending against an attacker; it is
 * defending against an older build, a half-written file from before atomic writes existed, and a
 * hand edit. Anything unrecognised makes the whole load `unreadable` rather than being dropped,
 * because dropping is the silent-loss behaviour this section exists to forbid.
 *
 * **`roots` is required and `deregistered` is not**, and that asymmetry is deliberate: a file whose
 * `roots` key is missing or misspelled is a damaged registry, and reading it as "no folders" is
 * precisely the total loss §13.8 forbids. An absent `deregistered` is a registry from before
 * anything was removed.
 */
export function validateRegistry(value: unknown): Result<RegistryFile> {
  const record = asRecord(value, 'the registry')
  if (!record.ok) return record

  const roots = validateRoots(record.value['roots'])
  if (!roots.ok) return roots
  const deregistered = validateRoots(record.value['deregistered'] ?? [])
  if (!deregistered.ok) return deregistered
  /**
   * **Optional for the same reason `deregistered` is**, and this asymmetry has now earned its
   * keep twice: a registry written before templates existed is not damaged, it is old. Requiring
   * the key would make every registry on disk today `unreadable` on the first launch after this
   * ships — the app would open, refuse to write over the file, and report no folders. Which is
   * exactly the total loss §13.8 forbids, delivered by the validator meant to prevent it.
   */
  const templates = validateTemplates(record.value['templates'] ?? [])
  if (!templates.ok) return templates

  return ok({
    roots: roots.value,
    deregistered: deregistered.value,
    templates: templates.value,
    ...carriedInto(record.value, REGISTRY_KEYS),
  })
}

/** Same rules, the other file. `pathKeys` is required for the same reason `roots` is. */
export function validateUiState(value: unknown): Result<UiStateFile> {
  const record = asRecord(value, 'the UI state')
  if (!record.ok) return record

  const pathKeys = validatePathKeys(record.value['pathKeys'])
  if (!pathKeys.ok) return pathKeys
  /**
   * **Both optional, for the reason `templates` is.** Every UI-state file on disk predates Phase 9,
   * and requiring either key would make the first launch after this ships read them all as damaged
   * — which does not merely lose an arrangement, it makes the app refuse to write the file at all.
   * Third time this asymmetry has earned its keep.
   */
  const projectColumns = validateProjectColumns(record.value['projectColumns'] ?? [])
  if (!projectColumns.ok) return projectColumns
  const stagedCards = validateStagedCards(record.value['stagedCards'] ?? [])
  if (!stagedCards.ok) return stagedCards
  // Optional for the same reason as the two above: every file written before this shipped lacks
  // the key, and treating that as damage would make the app refuse to write the file at all.
  const boardSelection = validateBoardSelection(record.value['boardSelection'] ?? [])
  if (!boardSelection.ok) return boardSelection

  return ok({
    pathKeys: pathKeys.value,
    projectColumns: projectColumns.value,
    stagedCards: stagedCards.value,
    boardSelection: boardSelection.value,
    // Spread rather than assigned: `exactOptionalPropertyTypes` distinguishes "absent" from
    // "present and undefined", and absent is what an ordinary file has to round-trip to.
    ...carriedInto(record.value, UI_STATE_KEYS),
  })
}

/**
 * **P9-6 — EVERY KEY THIS PARSER DOES NOT KNOW IS CARRIED, NOT DROPPED.**
 *
 * security review, P9 review: *"A misspelled optional config key silently defaults, and the next write
 * persists the emptiness."*
 *
 * The mechanism is two lines far apart. Reading is `record.value['projectColumns'] ?? []`, so a key
 * spelled `projectColums` is simply absent and the default stands. Writing is
 * `JSON.stringify(config)`, which emits the parsed shape and nothing else. **So the misspelling is
 * not what loses the data — the next save is**, and it happens on the first thing the person does
 * afterwards, with no error and nothing to notice.
 *
 * It is not only about typos. A file written by a *newer* build of this app, opened by an older one,
 * has exactly this shape: keys the parser has never heard of, silently erased by the first save.
 *
 * **§13.8 already settles the principle for the case it anticipated** — an unresolved path key is
 * *"retained, not dropped"*, because during the copy-first week every key points into the copy and a
 * build that discarded them would throw away a week of arrangement. An unrecognised key is the same
 * argument one level up.
 *
 * Carried keys are **never interpreted** — they are opaque values this parser has no opinion about,
 * held so the writer can put them back exactly as they arrived.
 */
const UI_STATE_KEYS = ['pathKeys', 'projectColumns', 'stagedCards', 'boardSelection'] as const
const REGISTRY_KEYS = ['roots', 'deregistered', 'templates'] as const

function carriedInto(
  record: Record<string, unknown>,
  known: readonly string[],
): { carried?: Record<string, unknown> } {
  const carried: Record<string, unknown> = {}
  let found = false
  for (const [key, value] of Object.entries(record)) {
    if (known.includes(key)) continue
    carried[key] = value
    found = true
  }
  // An ABSENT field rather than an empty object, so an ordinary file gains no new key when it is
  // rewritten — the common case must round-trip byte-identically.
  return found ? { carried } : {}
}

/** Restored config is untrusted input — F9.2. A column with no name is a column nobody can pick. */
function validateProjectColumns(value: unknown): Result<ProjectColumn[]> {
  if (!Array.isArray(value)) return fail(ErrorCode.IO_FAILED, 'projectColumns is not a list')
  const out: ProjectColumn[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return fail(ErrorCode.IO_FAILED, 'a project column is not an object')
    }
    const record = entry as Record<string, unknown>
    const id = record['id']
    const name = record['name']
    if (typeof id !== 'string' || typeof name !== 'string') {
      return fail(ErrorCode.IO_FAILED, 'a project column is missing id or name')
    }
    if (id === '') return fail(ErrorCode.IO_FAILED, 'a project column has an empty id')
    out.push({ id, name })
  }
  return ok(out)
}

/**
 * A staged card is the only thing in this build whose **content** lives in config rather than in a
 * file, so its body is validated as text and nothing else. It is never a path, never a name on
 * disk, and never reaches a filesystem verb.
 */
/**
 * The board filter's stored selection.
 *
 * **Capped**, at the same number the wire caps a selection at. P9-5 is on the ledger for the
 * opposite — staged cards were uncapped, and 120 of them at 100 KB each was 12 MB of config that
 * is read on every start. This file is rewritten whenever the filter changes, so an unbounded list
 * is an unbounded write on a keystroke.
 */
function validateBoardSelection(value: unknown): Result<SelectedProject[]> {
  if (!Array.isArray(value)) return fail(ErrorCode.IO_FAILED, 'boardSelection is not a list')
  if (value.length > MAX_BOARD_SELECTION) {
    return fail(ErrorCode.IO_FAILED, 'boardSelection names too many projects')
  }
  const out: SelectedProject[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return fail(ErrorCode.IO_FAILED, 'a selected project is not an object')
    }
    const record = entry as Record<string, unknown>
    const rootId = record['rootId']
    const segments = record['segments']
    if (typeof rootId !== 'string' || rootId === '') {
      return fail(ErrorCode.IO_FAILED, 'a selected project has no rootId')
    }
    if (!Array.isArray(segments) || segments.some(part => typeof part !== 'string')) {
      return fail(ErrorCode.IO_FAILED, 'a selected project has no path')
    }
    /**
     * **Segments are shape-checked and nothing more.** No containment check, no existence check —
     * this is a *filter*, and a stored path that names nothing simply matches nothing when the board
     * resolves it against the index. Validating it against the tree here would make a renamed
     * project turn the whole state file into damage, which is the failure mode that empties a
     * config rather than the one that narrows a board.
     */
    out.push({ rootId, segments: segments as string[] })
  }
  return ok(out)
}

/** The cap named above. Matches the wire's `MAX_SELECTED_PROJECTS`; both are deliberate. */
const MAX_BOARD_SELECTION = 512

function validateStagedCards(value: unknown): Result<StagedCard[]> {
  if (!Array.isArray(value)) return fail(ErrorCode.IO_FAILED, 'stagedCards is not a list')
  const out: StagedCard[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return fail(ErrorCode.IO_FAILED, 'a staged card is not an object')
    }
    const record = entry as Record<string, unknown>
    const id = record['id']
    const name = record['name']
    const body = record['body'] ?? ''
    const columnId = record['columnId']
    if (typeof id !== 'string' || typeof name !== 'string' || typeof columnId !== 'string') {
      return fail(ErrorCode.IO_FAILED, 'a staged card is missing id, name or columnId')
    }
    if (typeof body !== 'string') {
      return fail(ErrorCode.IO_FAILED, 'a staged card body is not text')
    }
    if (id === '') return fail(ErrorCode.IO_FAILED, 'a staged card has an empty id')
    out.push({ id, name, body, columnId })
  }
  return ok(out)
}

function asRecord(value: unknown, what: string): Result<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(ErrorCode.IO_FAILED, `${what} is not an object`)
  }
  return ok(value as Record<string, unknown>)
}

function validateRoots(value: unknown): Result<StoredRoot[]> {
  if (!Array.isArray(value)) return fail(ErrorCode.IO_FAILED, 'roots is not a list')
  const out: StoredRoot[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return fail(ErrorCode.IO_FAILED, 'a root entry is not an object')
    }
    const record = entry as Record<string, unknown>
    const id = record['id']
    const absolutePath = record['absolutePath']
    if (typeof id !== 'string' || typeof absolutePath !== 'string') {
      return fail(ErrorCode.IO_FAILED, 'a root entry is missing id or absolutePath')
    }
    out.push({ id, absolutePath })
  }
  return ok(out)
}

/**
 * Restored templates are untrusted input (F9.2), and the segments matter most.
 *
 * They are handed to `walkAndVerify` on every scaffold, which validates them at the chokepoint —
 * but a hand-edited file holding a number inside `segments` would reach it as `undefined` after a
 * `join`, and the refusal would name a path nobody wrote. Refusing the whole load here says the
 * file is damaged, which is the truth.
 */
function validateTemplates(value: unknown): Result<StoredTemplate[]> {
  if (!Array.isArray(value)) return fail(ErrorCode.IO_FAILED, 'templates is not a list')
  const out: StoredTemplate[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return fail(ErrorCode.IO_FAILED, 'a template entry is not an object')
    }
    const record = entry as Record<string, unknown>
    const id = record['id']
    const name = record['name']
    const rootId = record['rootId']
    const segments = record['segments']
    if (typeof id !== 'string' || typeof name !== 'string' || typeof rootId !== 'string') {
      return fail(ErrorCode.IO_FAILED, 'a template entry is missing id, name or rootId')
    }
    if (!Array.isArray(segments) || segments.some(part => typeof part !== 'string')) {
      return fail(ErrorCode.IO_FAILED, 'a template entry has segments that are not strings')
    }
    /**
     * **An empty `segments` names the registered folder itself**, which would make the whole
     * folder a template of itself — a scaffold that copies a root into its own subtree. Refused
     * here rather than at use, because a stored template that can never be instantiated is a
     * damaged record however it got written.
     */
    if (segments.length === 0) {
      return fail(ErrorCode.IO_FAILED, 'a template entry points at a whole registered folder')
    }
    out.push({ id, name, rootId, segments: segments as string[] })
  }
  return ok(out)
}

function validatePathKeys(value: unknown): Result<PathKey[]> {
  if (!Array.isArray(value)) return fail(ErrorCode.IO_FAILED, 'pathKeys is not a list')
  const out: PathKey[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return fail(ErrorCode.IO_FAILED, 'a path key is not an object')
    }
    const record = entry as Record<string, unknown>
    const rootId = record['rootId']
    const segments = record['segments']
    if (typeof rootId !== 'string' || !Array.isArray(segments)) {
      return fail(ErrorCode.IO_FAILED, 'a path key is missing rootId or segments')
    }
    if (!segments.every(segment => typeof segment === 'string')) {
      return fail(ErrorCode.IO_FAILED, 'a path key segment is not a string')
    }
    out.push({
      rootId,
      segments: segments as string[],
      value: record['value'],
      ...(record['unresolved'] === true ? { unresolved: true } : {}),
    })
  }
  return ok(out)
}

/**
 * Writes the config atomically — temp, fsync, rename, fsync the directory.
 *
 * §13.8: *"Config writes are as safe as user writes."* The same sequence as `write.ts`, for the
 * same reason: a crash mid-write must leave the previous config intact, because the alternative is
 * an app that comes up with no registered folders and no record of what they were.
 *
 * Deliberately **not** routed through `saveDocument`. That verb gates on `isMarkdown` and takes
 * root-relative segments; config is neither markdown nor inside a root. Sharing the code would
 * have meant weakening that gate, which is the one predicate §6 says must not widen.
 */
export async function writeConfig(
  absolutePath: string,
  config: RegistryFile | UiStateFile,
): Promise<Result<null>> {
  /**
   * **The carried keys go back in, and the parsed shape wins over them.** P9-6.
   *
   * `carried` is this app's record of what it did not understand when it read the file. It is
   * written first so that anything the parser *does* know overwrites it — a key that is both carried
   * and known would mean the parser changed between the read and the write, and the parsed value is
   * the one that has been validated.
   *
   * `carried` itself is removed rather than serialised: it is bookkeeping about the file, not a part
   * of it, and writing it would put a key in the file that the next read would then carry, forever.
   */
  const { carried, ...parsed } = config as typeof config & { carried?: Record<string, unknown> }
  const onDisk = { ...(carried ?? {}), ...parsed }
  const bytes = Buffer.from(`${JSON.stringify(onDisk, null, 2)}\n`, 'utf8')
  const directory = dirname(absolutePath)
  // Random, not a timestamp — the same reasoning as §13.3's temp names: a predictable path is one
  // something else can pre-create as a symlink. `O_EXCL|O_NOFOLLOW` refuses that anyway; this
  // removes the need to rely on it, and keeps one convention rather than two.
  const temp = join(directory, `.config.tmp-${randomBytes(8).toString('hex')}`)

  let handle
  try {
    await fsp.mkdir(directory, { recursive: true })
    handle = await fsp.open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    )
  } catch (error) {
    return fail(ErrorCode.IO_FAILED, `could not create the config temp: ${errnoOf(error) ?? '?'}`)
  }

  try {
    let written = 0
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written)
      if (bytesWritten === 0) break
      written += bytesWritten
    }
    await handle.sync()
    const stat = await handle.stat({ bigint: true })
    // UNPROVEN, same status as the equivalent assertion in `conflict.ts`: it can only fire on a
    // short write, which in practice means ENOSPC, and the operator ruled the disk-full rig out of
    // scope. Kept because it also catches a volume that accepts bytes without storing them.
    if (Number(stat.size) !== bytes.length) {
      return fail(ErrorCode.WRITE_SIZE_MISMATCH, 'the config temp is the wrong size')
    }
    await handle.close()

    // Replace-rename, and legitimate here for the same reason as in `write.ts`: the thing being
    // replaced is a file this app owns entirely, and the new content is complete on disk.
    await fsp.rename(temp, absolutePath)

    const dirHandle = await fsp.open(directory, constants.O_RDONLY)
    try {
      await dirHandle.sync()
    } finally {
      await dirHandle.close()
    }
    return ok(null)
  } catch (error) {
    const code = errnoOf(error)
    return fail(
      code === 'ENOSPC' || code === 'EDQUOT' ? ErrorCode.DISK_FULL : ErrorCode.IO_FAILED,
      `config write failed: ${code ?? 'unknown'}`,
    )
  } finally {
    await handle.close().catch(() => { /* already closed on the success path */ })
    // UNPROVEN by the sweep, and correctly so: on the success path the rename has already moved
    // the temp away, so this is a no-op. It only does anything when the write or the rename failed
    // — a path no test here reaches.
    await fsp.unlink(temp).catch(() => { /* renamed away, or left for the sweep */ })
  }
}

/**
 * Removes a root from the active list by **moving it to `deregistered`**, never by dropping it.
 *
 * §13.8's M7: the registry and UI state are separate files because sharing one means a UI-state
 * write from a stale copy deregisters folders. The append-don't-delete rule is the other half —
 * with it, a mistaken removal is visible and reversible; without it, the only record that a folder
 * was ever registered is gone.
 */
export function deregisterRoot(registry: RegistryFile, id: string): RegistryFile {
  const removed = registry.roots.find(root => root.id === id)
  if (removed === undefined) return registry
  return {
    roots: registry.roots.filter(root => root.id !== id),
    // Re-registering and removing again must not stack duplicates in the record.
    deregistered: [...registry.deregistered.filter(root => root.id !== id), removed],
    /**
     * **Templates pointing into the removed folder are KEPT, not dropped.**
     *
     * They go inert — nothing can scaffold from a folder the app is no longer allowed to read, and
     * the routes refuse them — but the naming work is the user's and removing a folder is not a
     * statement about it. `folderIdFor` derives an id from the folder's own last segment, so
     * re-adding the same folder mints the same id and the templates simply work again.
     *
     * The same reasoning as `deregistered` itself, one level up: this file's rule is
     * append-don't-delete, so that a mistaken removal is visible and reversible.
     */
    templates: registry.templates,
  }
}

/**
 * Rewrites every path key affected by a rename or move. Spec §13.8.
 *
 * *"Any operation that renames or moves a path updates every config key referencing it, **in the
 * same transaction**."* The failure it closes is quiet and infuriating: the Projects board's
 * column arrangement is keyed by project path, so renaming a project silently reverts its
 * placement to the default — the app undoing the user's own arrangement, with no error and nothing
 * to point at.
 *
 * **Descendants move too.** A key for `project/inner` must follow when `project` is renamed;
 * updating only the exact match leaves every child key orphaned, which is the same bug one level
 * down.
 *
 * Whole-segment comparison, never a raw prefix — §5's rule. `notes-archive` is not inside `notes`,
 * and here getting that wrong silently rewrites the arrangement of an unrelated project.
 */
export function retargetPathKeys(
  state: UiStateFile,
  rootId: string,
  from: readonly string[],
  to: readonly string[],
): UiStateFile {
  const pathKeys = state.pathKeys.map(key => {
    if (key.rootId !== rootId) return key
    // `isWithin` counts an equal path as contained, which is exactly right here: the renamed thing
    // itself and everything under it both move.
    if (!isWithin(from, key.segments, false)) return key
    return { ...key, segments: [...to, ...key.segments.slice(from.length)] }
  })
  // Spread, never a fresh literal. A rebuilt object silently drops every field added later —
  // `projectColumns` and `stagedCards` would have been erased by the next rename.
  return { ...state, pathKeys }
}

/**
 * Marks keys whose path could not be found, **without removing any of them**.
 *
 * §13.8: retained, not dropped, and surfaced in Settings as unresolved. The build plan spells out
 * why it matters in practice: during the copy-first trial week the operator's config keys point into the
 * copy, and when they switche to the real tree they all become unresolved. That is expected
 * behaviour, and a build that dropped them would silently discard a week of arrangement.
 */
export function markUnresolvedKeys(
  state: UiStateFile,
  resolves: (rootId: string, segments: readonly string[]) => boolean,
): UiStateFile {
  return {
    ...state,
    pathKeys: state.pathKeys.map(key => {
      const found = resolves(key.rootId, key.segments)
      if (found) {
        if (key.unresolved !== true) return key
        // Rebuilt without the flag rather than destructured away — the lint rule that bans unused
        // bindings does not make an exception for the discard half of a rest pattern, and a
        // disable comment for a one-line rewrite is worse than the rewrite.
        return { rootId: key.rootId, segments: key.segments, value: key.value }
      }
      return { ...key, unresolved: true }
    }),
  }
}
