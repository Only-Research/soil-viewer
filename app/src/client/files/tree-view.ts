/**
 * The Files tree, drawn. The only file in the tree stack that knows a browser exists.
 *
 * `tree-model.ts` decides what the rows are, `tree-store.ts` holds and fetches them, and this puts
 * them on screen. Nothing here decides anything: it reads `visibleRows(...)`, builds elements, and
 * reports clicks back.
 *
 * **DOM construction only** — §8, and it is enforced rather than intended. `el()` has no parameter
 * that accepts markup, `setText` writes `textContent`, and the lint bans `innerHTML`,
 * `outerHTML`, `insertAdjacentHTML`, `srcdoc` and `document.write` across client source. Every
 * filename in this tree was written by an agent, so a row label is untrusted text in the strict
 * sense: `<img src=x onerror=…>.md` is a legal macOS filename.
 */

import { append, clear, el } from '../dom'
import type { WireEntry } from '../../contract/wire'
import { displayName, rowKey, typeLabelFor, visibleRows, type TreeRow } from './tree-model'
import { menuButton } from './row-menu'
import type { TreeStore } from './tree-store'

export interface TreeViewOptions {
  readonly store: TreeStore
  /** A row was activated: a folder toggles, a file opens. */
  readonly onOpen: (entry: WireEntry) => void
  /** Which row is shown as current. `null` before anything is open. */
  readonly selected?: () => { readonly rootId: string; readonly segments: readonly string[] } | null
  /** The "⋯" was pressed on a row. The caller opens the menu; the tree only reports it. */
  readonly onMenu?: (
    entry: WireEntry,
    at: { readonly x: number; readonly y: number },
    /** The row's element, so the menu can mark it `has-menu` while it is open. */
    row: HTMLElement,
  ) => void
  /** True while a mutation aimed at this row is in flight — §13.8. The row is disabled. */
  readonly isBusy?: (key: string) => boolean
  /**
   * The registered folders' names, read fresh on each render so a folder added in Settings appears
   * without a reload. Absent means the tree never draws root rows.
   */
  readonly rootNames?: () => ReadonlyMap<string, string>
}

export interface TreeView {
  readonly element: HTMLElement
  /** Redraws from the store. Called on every announcement; safe to call at any time. */
  readonly render: () => void
  /**
   * Ask for the selected row to be scrolled into view on the next render that can do it.
   *
   * **An ask, not a command**, and it is the caller's because only the caller knows a *jump*
   * happened. A view that decided for itself either stole the scroll on every redraw or refused to
   * repeat a jump to the same row — both were shipped, both were found by review.
   */
  readonly scrollToSelection: () => void
  /** Stops listening. */
  readonly destroy: () => void
}

/** Indent per level. A number here rather than nested elements — see `buildRow`. */
const INDENT_REM = 0.85

export function createTreeView(options: TreeViewOptions): TreeView {
  const list = el('div', {
    className: 'tree',
    // A tree role rather than a list: it tells a screen reader that rows nest and expand, which is
    // the one thing about this control that is not obvious from its text.
    attributes: { role: 'tree', 'aria-label': 'Files' },
  })

  /**
   * Maps a rendered element back to the row it came from, so one delegated click handler can
   * resolve what was clicked without re-deriving it from the DOM.
   *
   * Filled by `buildRow` itself rather than by a second pass. A second pass is a second place to
   * forget, and the failure it produces — a row that draws and does nothing when clicked — looks
   * like a dead control rather than a missing line.
   */
  const rowIndex = new Map<HTMLElement, TreeRow>()

  const buildRow = (row: TreeRow): HTMLElement => {
    const selected = options.selected?.() ?? null
    const isSelected = selected !== null
      && rowKey(selected.rootId, selected.segments) === row.key

    /**
     * **One flat element per row, indented by padding rather than by nesting.**
     *
     * Nested containers would mean a row's depth is expressed by its position in the DOM, and
     * redrawing after an expand would rebuild a subtree rather than a list. Flat rows also make
     * windowing possible later without restructuring: a window over a flat list is a slice.
     */
    const busy = options.isBusy?.(row.key) ?? false

    const node = el('div', {
      className: [
        'tree-row',
        row.entry.kind === 'directory' ? 'tree-row-folder' : 'tree-row-file',
        /**
         * The the reference app's `editable`, mirrored: what its editor can open gets `text.muted` and
         * everything else stays at `text.dim`. Here that is `isMarkdown` — a `.png` reads as
         * quieter than a note without needing a word to say so.
         */
        row.entry.isMarkdown ? 'is-document' : '',
        isSelected ? 'is-selected' : '',
        row.entry.contentUnavailable ? 'is-unavailable' : '',
        // §13.8: the row is disabled while a mutation aimed at it is running.
        busy ? 'is-busy' : '',
      ].filter(Boolean).join(' '),
      attributes: {
        role: 'treeitem',
        tabindex: isSelected ? '0' : '-1',
        'aria-level': String(row.depth + 1),
        ...(row.expandable ? { 'aria-expanded': String(row.expanded) } : {}),
        ...(isSelected ? { 'aria-selected': 'true' } : {}),
        style: `padding-inline-start: ${(row.depth * INDENT_REM).toFixed(2)}rem`,
      },
    })

    const twisty = el('span', {
      className: 'tree-twisty',
      // A folder's twisty points; a file gets a blank of the same width so labels line up.
      text: row.expandable ? (row.expanded ? '\u25be' : '\u25b8') : ' ',
      attributes: { 'aria-hidden': 'true' },
    })

    // `text:` is `textContent`. A filename is agent-written and is never markup here.
    const label = el('span', { className: 'tree-label', text: displayName(row.entry) })

    append(node, twisty, label)

    /**
     * §4.2 — **the type, in dim caps after the name, and only when there is something to say.**
     *
     * Not `aria-hidden`: unlike the glyph it replaces, this carries information a screen reader
     * cannot get from anywhere else on the row. The name is shown without its extension, so a
     * reader with no `XLSX` here is told a spreadsheet is a document.
     */
    const type = typeLabelFor(row.entry)
    if (type !== '') append(node, el('span', { className: 'tree-type', text: type }))

    /**
     * The states a row can be in beyond its name, each said in words rather than by colour alone.
     *
     * `contentUnavailable` is §5's cloud placeholder — a file that exists and whose bytes are not
     * on this machine. It is never an empty document, and the tree says so before the editor has
     * to.
     */
    if (row.entry.contentUnavailable) {
      append(node, el('span', { className: 'tree-note', text: 'not downloaded' }))
    }

    /**
     * The "⋯", **always present rather than revealed on hover** — the PRD says "always visible on
     * touch", and a hover affordance on a phone is one that does not exist.
     *
     * Placed before the notes so it keeps a fixed position at the row's end whatever else appears.
     */
    /**
     * **No `⋯` on a registered folder's own row.**
     *
     * Every action on that menu — Rename, Duplicate, Move, New file, New folder, Copy Path — is
     * expressed as `(rootId, segments)` with a §13.8 token, and a root row has empty segments and
     * no token because the server never described it. Rename would be asking the server to rename
     * a registered root *through* the tree, which §11 does not offer and §13.8 could not verify.
     *
     * The folder-level operations that do make sense — adding one, and one day removing one — live
     * in Settings, which is where a person went to create this row in the first place.
     */
    if (options.onMenu !== undefined && !busy && row.isRoot !== true) {
      const button = menuButton(displayName(row.entry))
      button.addEventListener('click', event => {
        // The row's own click opens or expands; the menu button must not do both.
        event.stopPropagation()
        // `node` is this row's element, handed over so the menu can mark what it acts on —
        // packet §4.6's *acted on* state. Passed rather than found by the menu, which has no way
        // to know which of the tree's rows asked.
        options.onMenu?.(row.entry, { x: event.clientX, y: event.clientY }, node)
      })
      append(node, button)
    }

    if (options.store.errorAt(row.key) !== undefined) {
      append(node, el('span', { className: 'tree-note tree-note-error', text: 'could not read' }))
    } else if (row.expanded && !row.childrenLoaded) {
      // §6 on a screen: "not known yet" must not render as "nothing here".
      append(node, el('span', { className: 'tree-note', text: '\u2026' }))
    }

    rowIndex.set(node, row)
    return node
  }

  const render = (): void => {
    const { rows, truncated } = visibleRows({
      rootIds: options.store.rootIds(),
      expanded: options.store.expanded(),
      childrenOf: options.store.childrenOf,
      ...(options.rootNames === undefined ? {} : { rootNames: options.rootNames() }),
    })

    rowIndex.clear()
    clear(list)
    for (const row of rows) append(list, buildRow(row))

    /**
     * Truncation is stated. A tree that silently stops is a file that appears not to exist, and
     * the person looking for it has no way to know the list ended early.
     */
    if (truncated) {
      append(list, el('div', {
        className: 'tree-note tree-note-error',
        text: 'This folder has more items than the tree can show at once.',
      }))
    }

    if (rows.length === 0) {
      append(list, el('div', { className: 'tree-empty', text: 'No folders registered yet.' }))
    }

    bringSelectedIntoView()
  }

  /**
   * **Scrolls the selected row into view — ONCE, and only when someone ASKED.**
   *
   * Nothing in this app scrolled a tree row, ever, and that is half of the defect the operator reported
   * on 2026-08-19: *"it just jumps you to files, but it doesn't select or show on screen the
   * selected folder."* Expanding a path makes the row **exist**; on a deep tree it can exist eight
   * hundred pixels below the fold, which is indistinguishable from nothing having happened.
   *
   * ## Two wrong answers came before this one, each found by an adversarial review
   *
   * **First: scroll on every render.** `render` is the store's subscriber, so it runs on every fetch
   * that lands, every expand and every watcher event — and scrolling on all of them steals the view
   * from whoever is using it. Reproduced twice: an agent writing a file jumped the tree from
   * `scrollTop` 1364 to 570, and expanding a folder near the bottom scrolled it off screen.
   * (`block: 'nearest'` does not prevent this. It only declines to move a row that is *already
   * visible*, and someone who has scrolled away is exactly the case where it is not.)
   *
   * **Second: scroll only when the selected key changed.** That fixed the theft and **brought the
   * original bug back**: jumping to the same folder a second time did nothing, because the key had
   * not changed — so a row that had drifted off screen stayed there, which is the operator's complaint
   * word for word. Reproduced on both jump sites; the pre-rework code had this right.
   *
   * ## So the caller asks, and the answer is consumed
   *
   * A render never scrolls on its own — that kills the theft. A jump calls `scrollToSelection()`
   * every time — that kills the repeat-jump case, because a second ask is a second scroll.
   *
   * **The flag is cleared only once the scroll actually happens.** An ask that arrives while the
   * pane is hidden behind another tab finds no laid-out row, so it stays pending and fires on the
   * render that follows. Clearing it on the attempt instead would swallow exactly those, which is
   * the second manifestation the review flagged by reading.
   */
  let scrollWanted = false

  function bringSelectedIntoView(): void {
    if (!scrollWanted) return

    const node = list.querySelector('.tree-row.is-selected')
    // Nothing to scroll to yet. The ask stands until there is.
    if (node === null || typeof node.scrollIntoView !== 'function') return

    scrollWanted = false
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  /**
   * **One listener on the container, not one per row.**
   *
   * At the PRD's 10,000-file floor, a listener per row is 10,000 registrations rebuilt on every
   * redraw. Delegation also survives the redraw: `render` replaces every child, and a per-row
   * handler would have to be re-attached each time — which is the kind of thing that works until
   * one path forgets.
   */
  const onClick = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const node = target.closest('.tree-row')
    if (!(node instanceof HTMLElement)) return
    const row = rowIndex.get(node)
    if (row === undefined) return

    if (row.expandable) void options.store.toggle(row.entry)
    else options.onOpen(row.entry)
  }

  list.addEventListener('click', onClick)
  const unsubscribe = options.store.subscribe(render)
  render()

  return {
    element: list,
    render,
    scrollToSelection: () => {
      scrollWanted = true
      bringSelectedIntoView()
    },
    destroy: () => {
      list.removeEventListener('click', onClick)
      unsubscribe()
    },
  }
}
