/**
 * What a live update DOES to the screen. Spec §15.
 *
 * `live-stream.ts` is the channel — it connects, backs off, recovers from an iOS suspension and
 * hands events to two callbacks. Until 2026-08-10 those two callbacks were empty. The server
 * watched, debounced, sequenced and delivered; the client received, parsed and threw the result
 * away. **An agent rewrote a file and the tree on screen did not change** — the ninth control in
 * this build that was complete, tested, and reachable by no product code.
 *
 * This module is the missing half, kept out of `main.tsx` for the same reason everything else is:
 * the decisions here are about *which folders are now stale*, which is a question with right and
 * wrong answers that a test can ask without a browser.
 *
 * ## The three rules it exists to enforce
 *
 * **1. A changed path invalidates the listing it LIVES IN, not itself.** A file that changed does
 * not have a listing; its parent folder does, and the parent is what shows the file's name, size
 * and modified time. Invalidating only the path itself would leave a renamed file's old row on
 * screen forever, because nothing ever asked the folder that holds it what it contains now.
 *
 * **2. A changed DIRECTORY invalidates both.** Its own listing (its contents changed) and its
 * parent's (the folder row itself may have appeared, gone, or been renamed). The client cannot tell
 * a file from a directory here — the payload names paths, not kinds — so it refreshes the path's
 * own listing whenever the tree is currently holding one, and the parent unconditionally.
 *
 * **3. A whole-root event refreshes everything OPEN under that root, not the root row alone.**
 * `applyReconcile` on the server emits `segments: [[]]` for the four defensive triggers §5 names —
 * watcher error, watcher restart, wake from sleep, index contradiction. Each of those means *"the
 * index for this root was rebuilt and anything in it may have moved."* Refreshing only the top level
 * would leave every expanded subfolder stale precisely when the server has just said it cannot
 * account for them.
 *
 * ## What it deliberately does not do
 *
 * It does not touch the open document. A file being edited is `document-session`'s to reason about:
 * it holds the hash the buffer was loaded at, and §13.5's conflict contract already refuses a save
 * onto changed bytes and rescues the edit beside it. Replacing an editor's text from a watcher event
 * would be a second, racing writer against that contract. `main.tsx` reopens a *clean* document and
 * announces a dirty one; both of those are decisions about a screen, so both live there.
 */

import { rowKey } from './files/tree-model'
import { MAX_PATH_SEGMENTS, MAX_SEGMENT_LENGTH } from '../core/paths'

/**
 * The separator `rowKey` joins with: NUL, **constructed rather than typed**.
 *
 * NUL is the one byte a macOS filename cannot contain, which is why `rowKey` chose it and why the
 * split below is unambiguous. Typing the character itself has now gone wrong five times in this
 * codebase — twice in test fixtures, and twice in the first two drafts of this very file, where the
 * invisible bytes sat in the source and made `grep` report the whole module as binary.
 *
 * `String.fromCharCode(0)` cannot be got wrong by an editor, a paste, or an agent, and it cannot be
 * mistaken for a space by a reader. The test asserts it against `rowKey`'s actual output rather than
 * against a second spelling of the same escape, so the two are bound by behaviour.
 */
const KEY_SEPARATOR = String.fromCharCode(0)

/**
 * The event name the server emits, duplicated rather than imported.
 *
 * `live-updates.ts` is a server module and reaches `node:fs` two imports down, so the client cannot
 * import the constant — but a name agreed by coincidence is a name that drifts. The test for this
 * module imports **both** and asserts they are equal, which is the only place in the build where a
 * Node module and a browser module are compared rather than connected.
 */
export const CHANGED = 'changed'

/** The payload of a `changed` frame, after validation. Mirrors the server's `ChangedPayload`. */
export interface ChangedEvent {
  readonly rootId: string
  /** Folder-relative paths whose index rows were corrected. `[[]]` means the whole root. */
  readonly segments: readonly (readonly string[])[]
}

/**
 * The part of `TreeStore` a refresh needs.
 *
 * Narrow on purpose: this module may not expand a folder, select a row, or fetch anything the person
 * is not already looking at. A live update makes what is on screen true; it does not decide what is
 * on screen.
 */
export interface RefreshableTree {
  readonly rootIds: () => readonly string[]
  readonly expanded: () => ReadonlySet<string>
  readonly childrenOf: (rootId: string, segments: readonly string[]) => unknown
  readonly invalidate: (rootId: string, segments: readonly string[]) => Promise<void>
}

/**
 * Validates a wire payload into a `ChangedEvent`, or returns `null`.
 *
 * **Every field is checked, including the innermost strings.** The frame arrives through
 * `safeParse`, which hands back `unknown` — so this is the boundary, and the same rule applies as
 * at every other boundary in this build: a shape that is *nearly* right is refused rather than
 * partially trusted. A `segments` array holding a number would otherwise reach `rowKey`, which joins
 * with NUL and would happily key a folder called `3`.
 *
 * Returning `null` rather than throwing is deliberate even though the caller is guarded: an
 * unrecognised frame is a fact about the sender, not a failure of this client, and the stream must
 * keep delivering the next good one.
 */
/**
 * How many changed paths one frame may name.
 *
 * The server coalesces a watcher burst into one event, so this is a bound on a burst rather than on
 * a single change. Generous on purpose: refusing a legitimate large burst would drop a redraw and
 * leave the tree stale, which is the failure this whole module exists to prevent.
 */
const MAX_CHANGED_PATHS = 4_096

/**
 * **P8-10 — every field is bounded by SIZE as well as by type.**
 *
 * security review, P8 review: *"`changedEventOf` bounds every field's type and no field's size."* They marked it
 * Low and said why: *"not attacker-reachable — the sender is the app's own gated stream."* That is
 * true and it is the reason this is a bound rather than a refusal with a message.
 *
 * **It is worth having anyway, and the argument is not about an attacker.** This function's whole
 * job is deciding whether a frame is one this client understands, and *"a path with forty thousand
 * segments"* is not one — it is a bug somewhere upstream wearing the right types. Every value here
 * already has a stated limit at the other end (§6, `MAX_SEGMENT_LENGTH` and `MAX_PATH_SEGMENTS`), so
 * accepting more than the server can ever legitimately send means accepting something that could not
 * have come from a correct sender.
 *
 * **Null, not a throw** — the same contract the type checks use, for the reason stated above them:
 * an unrecognised frame is a fact about the sender, and the stream must keep delivering the next
 * good one.
 */
export function changedEventOf(data: unknown): ChangedEvent | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { rootId?: unknown; segments?: unknown }
  if (typeof record.rootId !== 'string' || record.rootId === '') return null
  if (record.rootId.length > MAX_SEGMENT_LENGTH) return null
  if (!Array.isArray(record.segments)) return null
  if (record.segments.length > MAX_CHANGED_PATHS) return null

  const segments: string[][] = []
  for (const path of record.segments as unknown[]) {
    if (!Array.isArray(path)) return null
    if (path.length > MAX_PATH_SEGMENTS) return null
    for (const part of path as unknown[]) {
      if (typeof part !== 'string') return null
      if (part.length > MAX_SEGMENT_LENGTH) return null
    }
    segments.push([...(path as string[])])
  }
  return { rootId: record.rootId, segments }
}

/** Every folder currently expanded under one root, as segment arrays. The root's own listing too. */
export function openFoldersUnder(
  rootId: string, expanded: ReadonlySet<string>,
): readonly (readonly string[])[] {
  const found: string[][] = [[]]
  const prefix = rootId + KEY_SEPARATOR
  for (const key of expanded) {
    // `rowKey(rootId, [])` is the bare id, and the root listing is already in the list as `[]`.
    if (key === rootId || !key.startsWith(prefix)) continue
    found.push(key.slice(prefix.length).split(KEY_SEPARATOR))
  }
  return found
}

/**
 * The folder listings one event makes stale.
 *
 * Deduplicated, because a batch naming three files in one folder must produce **one** refetch of
 * that folder rather than three. The server already coalesces its own storm into a batch (§5's
 * 250 ms window); this is the same economy on the receiving side, and without it a `git checkout`
 * would turn one event into a listing request per changed file.
 */
export function staleListings(
  event: ChangedEvent, tree: RefreshableTree,
): readonly (readonly string[])[] {
  const byKey = new Map<string, readonly string[]>()
  const add = (segments: readonly string[]): void => {
    byKey.set(rowKey(event.rootId, segments), segments)
  }

  for (const path of event.segments) {
    if (path.length === 0) {
      // Rule 3: the whole root was reconciled. Everything open under it is suspect.
      for (const open of openFoldersUnder(event.rootId, tree.expanded())) add(open)
      continue
    }
    // Rule 1: the listing that holds it.
    add(path.slice(0, -1))
    /**
     * Rule 2: and its own listing, if the tree is holding one — true exactly when the path is a
     * directory that has been opened at some point. `invalidate` on an uncached path is a no-op
     * plus an announce, so this could be unconditional; it is gated so that a storm of file events
     * does not make the tree redraw twice per file.
     */
    if (tree.childrenOf(event.rootId, path) !== undefined) add(path)
  }
  return [...byKey.values()]
}

/**
 * Does this event name one specific path — the open file, in practice?
 *
 * **A whole-root event counts.** `[[]]` means the index for the root was rebuilt because the server
 * could not account for it — watcher restart, wake from sleep, index contradiction — so "the file
 * you have open was not mentioned" is exactly the wrong reading. It was not mentioned because
 * nothing was: everything under the root is suspect, including this.
 *
 * Compared through `rowKey` rather than by joining with `/`, because a segment may contain any byte
 * a filename may contain, `/` excepted — and `['a/b']` and `['a','b']` are different paths that a
 * slash-join would call equal.
 */
export function eventNamesPath(
  event: ChangedEvent, rootId: string, segments: readonly string[],
): boolean {
  if (event.rootId !== rootId) return false
  const wanted = rowKey(rootId, segments)
  return event.segments.some(path =>
    path.length === 0 || rowKey(rootId, path) === wanted)
}

/**
 * **Whether an announced path is an ANCESTOR of this one — the collapsed-batch case.**
 *
 * `withoutCoveredPaths` on the server drops a file path when a directory path covering it is in the
 * same batch, because a `git checkout` produces a directory event *and* events for the files inside
 * it. The reconciler then walks the whole subtree and corrects the index — but announces only the
 * **collapsed** path, the directory.
 *
 * `eventNamesPath` matches exactly, so the open file was never named and the client ignored the
 * whole thing. An agent that edited `docs/notes/todo.md` while anything else in `docs/notes` changed
 * inside the 250ms window left the editor showing bytes that were no longer on disk, silently.
 *
 * **This is the same silent-staleness failure §15 exists to prevent, arriving from a second
 * direction** — the first was a board card not being a tree row, fixed in `main.tsx` and described
 * there at length. Neither is exotic: both are what happens when an agent writes to the tree.
 */
export function eventCoversPath(
  event: ChangedEvent, rootId: string, segments: readonly string[],
): boolean {
  if (event.rootId !== rootId) return false
  return event.segments.some(path =>
    path.length > 0
    && path.length < segments.length
    && path.every((part, at) => rowKey(rootId, [part]) === rowKey(rootId, [segments[at] ?? ''])))
}

/** What `document-session.peek()` reports, narrowed to the two facts this decision turns on. */
export interface OpenDocumentState {
  readonly dirty: boolean
  readonly inFlight: boolean
}

export type OpenFileVerdict =
  /** The event does not concern the open file, or nothing is open. */
  | 'ignore'
  /** Someone else wrote it while this person was editing. Say so; change nothing. */
  | 'keep-and-announce'
  /** Nothing unsaved to lose. Show what is on disk now. */
  | 'reload'

/**
 * Whether a live event may touch the document on screen.
 *
 * **A dirty buffer is never replaced, and this function exists so that rule is testable.** It lived
 * inside `main.tsx` for one draft, where the only way to exercise it was to drive a browser into
 * the exact race it guards — which is to say it would have been asserted once, in an e2e test that
 * types fast enough, and then quietly stopped being checked.
 *
 * The person's unsaved text is the one thing on screen that exists nowhere else. A watcher event is
 * not permitted to be the second writer to it: §13.5's conflict contract already refuses a save
 * onto changed bytes and rescues the edit beside the file, and that contract only works if the
 * buffer it is protecting is still there when the save happens.
 *
 * `inFlight` counts as dirty. A save that has left the client but not yet been answered has a
 * buffer whose fate is undecided, and reloading underneath it would discard the text the server is
 * about to accept or refuse.
 */
export function openFileVerdict(
  event: ChangedEvent,
  openFile: { readonly rootId: string; readonly segments: readonly string[] } | null,
  document: OpenDocumentState | null,
): OpenFileVerdict {
  if (openFile === null) return 'ignore'

  const dirty = document !== null && (document.dirty || document.inFlight)

  if (eventNamesPath(event, openFile.rootId, openFile.segments)) {
    return dirty ? 'keep-and-announce' : 'reload'
  }

  /**
   * **An ancestor was announced, so the file MAY have changed — reload it if there is nothing to
   * lose, and say nothing if there is.**
   *
   * A collapsed batch names the directory and not the file, so this is the only signal there is. It
   * is deliberately asymmetric:
   *
   * - **Clean buffer → reload.** The cost of being wrong is a re-read that returns identical bytes.
   *   The cost of not doing it is the editor showing a file that changed underneath it, which is the
   *   failure this whole module exists to prevent.
   * - **Dirty buffer → ignore, not announce.** An ancestor event fires when *anything* in the folder
   *   is created, deleted or renamed, so announcing would put "changed on disk" in front of someone
   *   whose own file is untouched — a dialog about someone else's write, which §13.5 spent a
   *   redesign removing. Nothing is at risk by staying quiet: §13.5's conflict contract refuses a
   *   save onto changed bytes and rescues the edit beside the file, and that holds whether or not a
   *   banner appeared first.
   */
  if (eventCoversPath(event, openFile.rootId, openFile.segments)) {
    return dirty ? 'ignore' : 'reload'
  }

  return 'ignore'
}

/**
 * Applies one `changed` event to the tree.
 *
 * Concurrent rather than sequential: `invalidate` deduplicates in-flight fetches per folder and the
 * listings here are already distinct, so awaiting them one at a time would only make a ten-folder
 * batch take ten round trips. Nothing here rejects — the store reports a failed listing through its
 * own `onError` and leaves the cache absent, which is what a person sees as a folder that says it
 * could not be read rather than a folder that appears empty.
 */
export async function applyChanged(tree: RefreshableTree, event: ChangedEvent): Promise<void> {
  await Promise.all(
    staleListings(event, tree).map(segments => tree.invalidate(event.rootId, segments)),
  )
}

/**
 * Refetches every folder the tree is currently showing, across every root. Spec §15's refetch.
 *
 * Called on **every** connection and on every resync, because anything that changed while
 * disconnected was never delivered and no reconnection replays it. That is the iOS case in
 * particular: a phone resumes, the stream is silently dead, and the only thing standing between the
 * person and a screen of hours-old filenames is this function running unconditionally on reopen.
 *
 * The registered-folder list is refreshed by the caller, not here — it is a different request and
 * `main.tsx` owns the copy of it that Copy Path reads.
 */
export async function refetchOpenFolders(tree: RefreshableTree): Promise<void> {
  const expanded = tree.expanded()
  await Promise.all(tree.rootIds().flatMap(rootId =>
    openFoldersUnder(rootId, expanded).map(segments => tree.invalidate(rootId, segments)),
  ))
}
