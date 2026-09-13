/**
 * Choosing where to move something. Annex A6, PRD's intentional-move rule, §13.7's M6.
 *
 * PRD: *"Move is an **intentional** flow only: menu action → pick the destination folder → confirm.
 * **There is no drag-and-drop anywhere on the Files tab** (the operator: accidental drags are a
 * nightmare; moving a file must be deliberate)."*
 *
 * Annex A6: *"folders-only expandable tree, explicit '/ (workspace root)' first row, teal selection,
 * CTA reads 'Move Here'."*
 *
 * **Folders only, and that is not a filter over the real tree — it is a different question.** The
 * main tree answers "what is here"; this answers "where may this go". Showing files would offer
 * destinations that cannot receive anything, and the one thing a person must not do in this dialog
 * is pick something that then fails.
 */

import { append, clear, el, onDocument } from '../dom'
import type { WireEntry } from '../../contract/wire'
import { ancestorKeys, displayName, rowKey, sortEntries } from './tree-model'
import type { TreeStore } from './tree-store'

export interface MovePickerOptions {
  readonly store: TreeStore
  /**
   * What is being moved. Its own subtree is not a legal destination.
   *
   * **Absent when this is not a move** — Phase 8 asks the same question ("which folder?") to name a
   * template, and Settings has no subject to exclude or count. Generalised rather than copied: a
   * second tree picker would be two implementations of one widget, and this file already carries
   * the twisty state, the lazy fetch, the depth indentation and A6's top-level row. When it is
   * absent there is nothing to exclude and nothing to count, and both of those fall out rather than
   * being special-cased.
   */
  readonly subject?: WireEntry
  /** Registered folders, for the root rows. */
  readonly folders: readonly { readonly id: string; readonly name: string }[]
  /** How many indexed files move with it — M6's count. `null` while it is being fetched. */
  readonly fileCount?: number | null
  /** Overrides the heading. Defaults to `Move <subject>`. */
  readonly title?: string
  /** Overrides the confirm button. Defaults to `Move Here`. */
  readonly confirmLabel?: string
}

/** The chosen destination, or `null` if the dialog was dismissed. */
export type MoveChoice = { readonly rootId: string; readonly segments: readonly string[] } | null

/**
 * True when `candidate` is the subject itself or inside it.
 *
 * §13.7 refuses a move into a folder's own descendant server-side — this stops the dialog offering
 * it at all, because an option that is always refused is a trap rather than a choice.
 */
function isInsideSubject(
  subject: WireEntry | undefined, rootId: string, segments: readonly string[],
): boolean {
  // No subject means nothing to exclude — see `MovePickerOptions.subject`.
  if (subject === undefined) return false
  if (subject.rootId !== rootId) return false
  if (segments.length < subject.segments.length) return false
  return subject.segments.every((part, index) => segments[index] === part)
}

export function askWhereToMove(
  parent: HTMLElement,
  options: MovePickerOptions,
): Promise<MoveChoice> {
  return new Promise(resolve => {
    const backdrop = el('div', { className: 'modal-backdrop' })
    const dialog = el('div', {
      className: 'modal modal-wide',
      attributes: {
        role: 'dialog', 'aria-modal': 'true',
        'aria-label': options.title ?? 'Move',
      },
    })

    append(dialog, el('div', {
      className: 'modal-title',
      text: options.title
        ?? (options.subject === undefined ? 'Choose a folder' : `Move ${displayName(options.subject)}`),
    }))

    /**
     * M6's count, stated rather than implied.
     *
     * *"a directory rename moves zero bytes, so v1's byte threshold would let a project move
     * silently remove 200 files from every view."* A move is cheap to perform and expensive to
     * notice, which is exactly when a confirmation has to say how much it is about.
     */
    const cost = options.subject?.kind === 'directory'
      ? ((options.fileCount ?? null) === null
          ? 'Counting what is inside…'
          : `${options.fileCount} file${options.fileCount === 1 ? '' : 's'} will move with it.`)
      : ''
    if (cost !== '') append(dialog, el('div', { className: 'modal-note', text: cost }))

    const list = el('div', {
      className: 'picker',
      attributes: { role: 'tree', 'aria-label': 'Destination folders' },
    })
    append(dialog, list)

    const confirm = el('button', {
      className: 'modal-confirm', text: options.confirmLabel ?? 'Move Here',
    })
    const cancel = el('button', { className: 'modal-cancel', text: 'Cancel' })
    const buttons = el('div', { className: 'modal-buttons' })
    append(buttons, cancel, confirm)
    append(dialog, buttons)
    append(backdrop, dialog)
    append(parent, backdrop)

    let chosen: MoveChoice = null
    const expanded = new Set<string>()

    let settled = false
    let stopListening = (): void => {}
    const finish = (value: MoveChoice): void => {
      if (settled) return
      settled = true
      backdrop.remove()
      stopListening()
      resolve(value)
    }

    const rowFor = (
      rootId: string, segments: readonly string[], label: string, depth: number,
    ): HTMLElement => {
      const key = rowKey(rootId, segments)
      const isChosen = chosen !== null
        && rowKey(chosen.rootId, chosen.segments) === key
      const isOpen = expanded.has(key)
      const children = options.store.childrenOf(rootId, segments)

      const row = el('div', {
        className: `picker-row${isChosen ? ' is-chosen' : ''}`,
        attributes: {
          role: 'treeitem',
          'aria-selected': String(isChosen),
          style: `padding-inline-start: ${(depth * 0.85).toFixed(2)}rem`,
        },
      })

      const twisty = el('button', {
        className: 'picker-twisty',
        text: isOpen ? '▾' : '▸',
        attributes: { type: 'button', 'aria-label': isOpen ? 'Collapse' : 'Expand' },
      })
      twisty.addEventListener('click', event => {
        event.stopPropagation()
        if (isOpen) expanded.delete(key)
        else expanded.add(key)
        void (children === undefined
          ? options.store.restoreExpanded([key]).then(render)
          : Promise.resolve(render()))
      })

      append(row, twisty, el('span', { className: 'picker-label', text: label }))
      row.addEventListener('click', () => {
        chosen = { rootId, segments }
        render()
      })
      return row
    }

    const renderInto = (rootId: string, segments: readonly string[], depth: number): void => {
      const children = options.store.childrenOf(rootId, segments)
      if (children === undefined) return
      for (const child of sortEntries(children)) {
        // Folders only, and never the subject's own subtree.
        if (child.kind !== 'directory') continue
        if (isInsideSubject(options.subject, child.rootId, child.segments)) continue

        append(list, rowFor(child.rootId, child.segments, displayName(child), depth))
        if (expanded.has(rowKey(child.rootId, child.segments))) {
          renderInto(child.rootId, child.segments, depth + 1)
        }
      }
    }

    function render(): void {
      clear(list)
      for (const folder of options.folders) {
        /**
         * A6's *"explicit '/ (workspace root)' first row"*, one per registered folder.
         *
         * Without it the top level of a folder is unreachable: every other row is something
         * *inside* a folder, so "move it back to the top" would have no target.
         */
        append(list, rowFor(folder.id, [], `${folder.name} (top level)`, 0))
        if (expanded.has(rowKey(folder.id, []))) renderInto(folder.id, [], 1)
      }
      confirm.toggleAttribute('disabled', chosen === null)
    }

    confirm.addEventListener('click', () => { if (chosen !== null) finish(chosen) })
    cancel.addEventListener('click', () => { finish(null) })
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) finish(null)
    })
    stopListening = onDocument('keydown', raw => {
      if ((raw as KeyboardEvent).key === 'Escape') finish(null)
    }, { capture: true })

    /**
     * Opens **where the subject already lives**, not at the top.
     *
     * A dialog that starts collapsed makes the commonest move — into a sibling folder — cost three
     * clicks of navigating back to where the person already was. Every registered folder is opened
     * too, so the other roots are visible without hunting for a twisty.
     */
    for (const folder of options.folders) expanded.add(rowKey(folder.id, []))
    if (options.subject !== undefined) {
      for (const key of ancestorKeys(options.subject.rootId, options.subject.segments)) {
        expanded.add(key)
      }
    }
    render()
  })
}
