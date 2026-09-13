/**
 * The Files tree, as data. No DOM, no fetching, no state of its own beyond what is handed in.
 *
 * PRD, the Files tab: *"Live tree of all registered folders: folders before files, dotfiles and
 * `node_modules` hidden, prettified names (`.md` stripped, hyphens as spaces), type glyphs,
 * auto-expand to the open file, updates live when disk changes (any source)."*
 *
 * **Separated from the view because of the number, not for tidiness.** The PRD's performance floor
 * is 10,000 markdown files and 50,000 total, and the only way a tree stays responsive at that size
 * is to render the rows that are visible rather than the tree that exists. That requires the
 * visible rows to be a *computed list* — which is what `visibleRows` returns — and a list is
 * something a test can hold, count and assert against without a browser.
 *
 * **Dotfiles and `node_modules` are already gone before this module sees anything.** `walk.ts`
 * applies §3's ignore predicate during the walk, so they are absent from the index and therefore
 * from `tree.children`. Filtering again here would be a second copy of that rule, and the copy
 * that drifts is the one nobody is testing.
 */

import type { WireEntry } from '../../contract/wire'

/** One row as the view will draw it. */
export interface TreeRow {
  readonly entry: WireEntry
  /** 0 for a registered folder's immediate children. Drives the indent and nothing else. */
  readonly depth: number
  readonly expandable: boolean
  readonly expanded: boolean
  /**
   * For an **expanded** folder: whether its children have arrived yet. `false` on a collapsed
   * folder or a file, where the question is not being asked.
   *
   * **This field exists because a mutation sweep proved its absence.** The module's header claimed
   * the view could show an unfetched folder as loading rather than empty — §6's rule that an empty
   * result never stands in for "not known", applied to a screen — and nothing in the row said
   * which it was. Both cases produced the same zero rows, so deleting the distinction changed
   * nothing and no test could see it. The comment described a behaviour the type made impossible.
   */
  readonly childrenLoaded: boolean
  /** Stable across reorders — the view keys on it, and expansion state is stored under it. */
  readonly key: string
  /**
   * This row *is* a registered folder, not something inside one.
   *
   * Drawn only when more than one folder is registered — see `rootNames`. The flag rather than a
   * `segments.length === 0` test at each use site: a root row carries a synthesized entry with no
   * §13.8 token, and every consumer that offers a mutation has to know that. Absent on every
   * ordinary row.
   */
  readonly isRoot?: boolean
}

/** How the caller supplies children. Whatever it has cached; absent means "not loaded yet". */
export type ChildrenLookup = (rootId: string, segments: readonly string[]) => readonly WireEntry[] | undefined

/**
 * The identity a row is remembered by.
 *
 * `rootId` and the path, joined with `\u0000`. NUL is the one byte a macOS filename genuinely
 * cannot contain, so it is the only separator that cannot be forged by naming a file after it. A
 * `/` would be wrong for the same reason the wire carries segments rather than a joined string.
 *
 * **Written as an escape, and the first draft of this file did not.** A literal NUL was pasted into
 * both the comment and the `join`, which is the identical mistake `url-safety.ts` records two hours
 * earlier in this same phase — a control character in source is invisible to the next reader and,
 * there, silently terminated a regular expression. Knowing the lesson did not prevent repeating it;
 * writing it down twice is the cheapest thing that might.
 */
export function rowKey(rootId: string, segments: readonly string[]): string {
  return [rootId, ...segments].join('\u0000')
}

/**
 * The name shown in the tree.
 *
 * PRD: *"prettified names (`.md` stripped, hyphens as spaces)"*.
 *
 * **FOLDERS ARE SHOWN VERBATIM. Ruled 2026-08-09: *"keeping 00-context is
 * paramount."*** The PRD's rule is applied to files only.
 *
 * The reason it is not a compromise: **folder names in this tree are the grammar, not prose.**
 * `00-context`, `01-inbox`, `02-work`, `99-inbox-main` are structural — the app's own path grammar
 * matches on them, the numeric prefix carries the ordering, and the operator navigates by them daily.
 * `00 context` is a different word to the eye and a worse one to scan a column of. Filenames are
 * the opposite: `m-thread-soil-viewer-build.md` is prose that was hyphenated because filenames
 * cannot hold spaces, and turning it back into "m thread soil viewer build" is restoring what was
 * meant rather than altering it.
 *
 * Numeric prefixes are kept on both, which was the earlier half of this decision and survives it.
 * `grammar.ts` strips them for *lanes*, because `02-next` is a status whose display name is "Next";
 * a folder is not a lane, and stripping would leave several folders called "context".
 */
export function displayName(entry: WireEntry): string {
  if (entry.kind === 'directory') return entry.name
  const withoutExtension = entry.isMarkdown ? entry.name.replace(/\.md$/i, '') : entry.name
  return withoutExtension.replace(/[-_]+/g, ' ')
}

/**
 * **THE TYPE, IN DIM CAPS AFTER THE NAME — and the leading glyph is gone.** Packet §4.2.
 *
 * This replaces `glyphFor`, which returned a leading character for every row and put **two
 * triangles on every folder**: the disclosure twisty is `▸`, and the glyph was `▸` as well. That is
 * the double-arrow the operator reported, and the fix removes an icon rather than adding a control —
 * *"the disclosure triangle is the folder's mark."*
 *
 * The other three glyphs go for a related reason. `·` on every markdown file said "this is a
 * document" on a screen where nearly everything is one, and `□` said "this is not one" without
 * saying what it was instead. **Indentation already carries the hierarchy**, and a word says more
 * than a box: `XLSX` at the end of a row tells you what will happen when you click it.
 *
 * Returns `''` for a folder and for a markdown file — the two cases that need no explanation. An
 * empty string rather than a space, so the stylesheet can skip the element entirely.
 */
export function typeLabelFor(entry: WireEntry): string {
  if (entry.kind === 'directory') return ''
  /**
   * **A symlink is labelled, not left to look like a file.** §11 treats one as a containment
   * question and the tree refuses to follow it; a row that gave no sign would be the one place a
   * person could not tell why an open behaved differently.
   */
  if (entry.kind === 'symlink') return 'LINK'
  if (entry.isMarkdown) return ''

  const dot = entry.name.lastIndexOf('.')
  // A dot at position 0 is a leading-dot name — `.gitkeep` has no extension, it has a name.
  if (dot <= 0) return ''
  /**
   * Bounded, because an extension is not a promise. A file called `notes.thisisnotanextension`
   * would otherwise put twenty-two characters of dim caps at the end of a row and push the name
   * out of a 272px sidebar.
   */
  const extension = entry.name.slice(dot + 1)
  return extension.length > MAX_TYPE_CHARS ? '' : extension.toUpperCase()
}

/** Longer than this and it is not an extension, it is the rest of the filename. */
export const MAX_TYPE_CHARS = 5

/**
 * Folders before files, then by name.
 *
 * **Compared on the raw `name`, not the prettified one.** Sorting on the display name would put
 * `a-b.md` ("a b") before `ab.md` ("ab") on one machine and after it on another, because the
 * hyphen has been replaced by a space *before* the comparison sees it. The stored name is the
 * stable thing, and it is what the user sees in Finder.
 *
 * `localeCompare` with `numeric` so `10-x` sorts after `9-x` rather than before it — this tree is
 * full of numeric prefixes and a plain string sort gets them backwards.
 */
export function sortEntries(entries: readonly WireEntry[]): WireEntry[] {
  return [...entries].sort((a, b) => {
    const aFolder = a.kind === 'directory'
    const bFolder = b.kind === 'directory'
    if (aFolder !== bFolder) return aFolder ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/**
 * Every ancestor key of a path, outermost first — what must be expanded for a row to be visible.
 *
 * The path itself is **not** included: opening a file expands the folders containing it, not the
 * file. Auto-expand (PRD) is this function plus a union into the expanded set.
 */
export function ancestorKeys(rootId: string, segments: readonly string[]): string[] {
  const keys: string[] = [rowKey(rootId, [])]
  for (let i = 1; i < segments.length; i += 1) {
    keys.push(rowKey(rootId, segments.slice(0, i)))
  }
  return keys
}

export interface VisibleRowsInput {
  readonly rootIds: readonly string[]
  /**
   * The registered folders' names, for their own rows. Absent means "do not draw root rows" — used
   * by tests that are about the walk rather than about the roots.
   *
   * **Until Settings shipped, a registered folder had no row.** The tree drew a root's *contents*
   * at depth 0 and never the root itself, which is exactly right for one folder and unusable for
   * two: the two folders' children interleave at the same depth, sorted together, with nothing on
   * screen saying which folder a row belongs to and no way to collapse either. A newly added
   * **empty** folder contributed no rows at all and simply did not appear — so "add a folder to
   * the file tree" produced a folder that was not in the tree.
   *
   * **Drawn whenever names are supplied, not only when there are two or more.** The first version
   * made it conditional on `rootIds.length > 1`, to leave the single-folder view untouched. That
   * puts a *shape change* on the far side of a registration: the tree the operator is looking at
   * reorganises itself the moment they add something. It also made the end-to-end suite
   * nondeterministic — two browser engines share one server, so a folder registered by one changed
   * the tree's shape underneath an unrelated test in the other, mid-run.
   *
   * One rule, always: a registered folder is a row. `move-picker.ts` reached the same conclusion
   * for its own list, where it draws an explicit "(top level)" row per folder.
   */
  readonly rootNames?: ReadonlyMap<string, string>
  readonly expanded: ReadonlySet<string>
  readonly childrenOf: ChildrenLookup
  /**
   * A hard ceiling on rows produced, so a pathological tree cannot make this function the thing
   * that hangs the browser.
   *
   * §5's scale rule is about the *index* streaming; this is the view's half. 50,000 total files is
   * the stated ceiling and the walk below is depth-first over expanded folders only — but "only
   * expanded folders" is a property of the user's clicks, and a restored session could name a
   * thousand of them. **Truncation is reported, never silent** (`truncated`), because a tree that
   * quietly stops is a file that appears not to exist.
   */
  readonly limit?: number
}

export interface VisibleRows {
  readonly rows: readonly TreeRow[]
  readonly truncated: boolean
}

/**
 * The stand-in entry for a registered folder's own row.
 *
 * A root is not a filesystem entry the server ever describes — `tree.children` answers about what
 * is *inside* one — so there is no `WireEntry` to use and one is constructed. Everything that is
 * not knowable is set to the value that means "nothing here", never to a plausible-looking guess:
 * a `modifiedMs` of `Date.now()` would put a fabricated timestamp on screen next to real ones.
 *
 * `isRoot` on the row, rather than inferring "root" from `segments.length === 0` at each use site,
 * because that test is true of a synthesized root row *and* of nothing else the tree draws — which
 * makes it exactly the kind of implicit invariant that survives until someone changes it.
 */
function rootEntryFor(rootId: string, name: string): WireEntry {
  return {
    rootId,
    segments: [],
    name,
    kind: 'directory',
    title: name,
    size: 0,
    modifiedMs: 0,
    isMarkdown: false,
    contentUnavailable: false,
    /**
     * **The empty string, and it must stay empty.** §13.8's token is what a mutation echoes back so
     * the server can refuse `STALE_TARGET` if the entity was replaced. A root has none — the server
     * never described it — and inventing a plausible one would let a mutation aimed at a root row
     * carry a token the server would then compare against something real. Empty is not a valid
     * token, so any such request is refused rather than mis-matched. Root rows also carry no `⋯`
     * menu, so nothing should ever be aiming a mutation here in the first place.
     */
    token: '',
  }
}

/** The default ceiling. Far above any real screenful; low enough to bound the work. */
export const MAX_VISIBLE_ROWS = 20_000

/**
 * The flat list of rows a fully-drawn tree would show, in order.
 *
 * Depth-first, expanded folders only. A folder whose children have not been fetched yet is
 * `expandable` and contributes no rows — the view shows it as expanded-and-loading rather than as
 * empty, which is §6's rule applied to a screen: an empty result never stands in for "not known".
 */
export function visibleRows(input: VisibleRowsInput): VisibleRows {
  const limit = input.limit ?? MAX_VISIBLE_ROWS
  const rows: TreeRow[] = []
  let truncated = false

  const walk = (rootId: string, segments: readonly string[], depth: number): void => {
    if (truncated) return
    const children = input.childrenOf(rootId, segments)
    if (children === undefined) return

    for (const entry of sortEntries(children)) {
      if (rows.length >= limit) { truncated = true; return }

      const key = rowKey(entry.rootId, entry.segments)
      const expandable = entry.kind === 'directory'
      const expanded = expandable && input.expanded.has(key)
      const childrenLoaded = expanded
        && input.childrenOf(entry.rootId, entry.segments) !== undefined
      rows.push({ entry, depth, expandable, expanded, childrenLoaded, key })

      if (expanded) walk(entry.rootId, entry.segments, depth + 1)
    }
  }

  const showRoots = input.rootNames !== undefined

  for (const rootId of input.rootIds) {
    if (!showRoots) {
      walk(rootId, [], 0)
      continue
    }

    const key = rowKey(rootId, [])
    const expanded = input.expanded.has(key)
    rows.push({
      entry: rootEntryFor(rootId, input.rootNames?.get(rootId) ?? rootId),
      depth: 0,
      expandable: true,
      expanded,
      childrenLoaded: expanded && input.childrenOf(rootId, []) !== undefined,
      key,
      isRoot: true,
    })
    if (expanded) walk(rootId, [], 1)
  }

  return { rows, truncated }
}
