/**
 * **THE ⌘K PANEL.** Spec §16's surface — *"Type a few letters, jump to any file."*
 *
 * The ranking, the query cap and the time budget are `core/quick-open.ts`, proven before this
 * existed. What lives here is the part a rule cannot have: an overlay you can drive entirely from
 * the keyboard, because a jump control you have to reach for the mouse to finish is slower than the
 * tree it replaces.
 *
 * ## The one rule that is not about looks
 *
 * **A result is opened by the id the server gave it, never by a path this file assembles.** The
 * panel hands the caller the wire row it was given and nothing else — §6's chokepoint, and the same
 * reason a board's drop names a lane id rather than a folder.
 */

import { QUERY_DEBOUNCE_MS } from '../core/quick-open'
import type { WireEntry } from '../contract/wire'
import { append, clear, el, setText } from './dom'

/** How the caller is told a result was chosen. */
export interface QuickOpenOptions {
  readonly onChoose: (entry: WireEntry) => void
  readonly onQuery: (query: string) => void
  readonly onClose: () => void
}

export interface QuickOpenHandle {
  /** Replaces the list. Called by the caller when a search comes back. */
  readonly show: (results: readonly QuickOpenResult[]) => void
  readonly close: () => void
  /** The query as typed. Read by tests and by the caller's debounce. */
  readonly query: () => string
}

export interface QuickOpenResult {
  readonly entry: WireEntry
  readonly inName: boolean
}

/**
 * Where the selection lands after a keypress.
 *
 * Pure, and exported for that reason: wrapping is the part of a keyboard list people notice and it
 * is invisible in a screenshot. **Down from the last row goes to the first**, because a list you
 * can fall off the end of makes you look at it to use it, which is the thing being avoided.
 */
export function nextSelection(current: number, count: number, key: string): number {
  if (count === 0) return 0
  if (key === 'ArrowDown') return (current + 1) % count
  if (key === 'ArrowUp') return (current - 1 + count) % count
  return current
}

/** What a row says beneath its title: where the file is, folder-relative. */
export function resultWhere(entry: WireEntry): string {
  return entry.segments.slice(0, -1).join('/')
}

export function mountQuickOpen(host: HTMLElement, options: QuickOpenOptions): QuickOpenHandle {
  clear(host)

  const backdrop = el('div', { className: 'quick-open-backdrop' })
  const panel = el('div', {
    className: 'quick-open',
    attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick open' },
  })

  const field = el('input', {
    className: 'quick-open-field',
    attributes: {
      type: 'text', placeholder: 'Jump to a file…', 'aria-label': 'Jump to a file',
      // §16 caps the query; the browser refusing the 65th character means the cap is also
      // something a person can see, rather than only something the server applies.
      maxlength: '64', spellcheck: 'false', autocomplete: 'off',
    },
  }) as HTMLInputElement

  const list = el('div', { className: 'quick-open-results', attributes: { role: 'listbox' } })
  const empty = el('div', { className: 'quick-open-empty' })

  let results: readonly QuickOpenResult[] = []
  let selected = 0

  const draw = (): void => {
    clear(list)
    if (results.length === 0) {
      /**
       * **Two different empty states, because they mean different things.** Nothing typed yet is an
       * instruction; nothing found is an answer. A single "no results" for both tells someone who
       * has typed nothing that their empty query failed.
       */
      setText(empty, field.value.trim() === ''
        ? 'Type to find any document in your folders.'
        : 'Nothing matches that.')
      append(list, empty)
      return
    }
    results.forEach((result, at) => {
      const row = el('div', {
        className: `quick-open-result${at === selected ? ' is-selected' : ''}`,
        attributes: { role: 'option', 'aria-selected': at === selected ? 'true' : 'false' },
      })
      append(row, el('div', {
        className: 'quick-open-result-name',
        text: result.entry.title.trim() === '' ? result.entry.name : result.entry.title,
      }))
      append(row, el('div', { className: 'quick-open-result-where', text: resultWhere(result.entry) }))
      // `mousedown`, not `click`: the field is focused, and a click's blur can close the panel
      // before the click lands — a row that visibly does nothing every second attempt.
      row.addEventListener('mousedown', () => { options.onChoose(result.entry) })
      append(list, row)
    })
  }

  /**
   * §16 / the security review's P11F-7 — **one request per burst of typing, not one per keystroke.**
   *
   * The timer is held here so it can be cancelled, which is the half that matters: a query left in
   * flight when the panel closes would arrive at a surface that no longer exists, and the caller
   * would draw results into a torn-down list.
   */
  let pendingQuery: ReturnType<typeof setTimeout> | null = null

  const cancelPendingQuery = (): void => {
    if (pendingQuery !== null) clearTimeout(pendingQuery)
    pendingQuery = null
  }

  field.addEventListener('input', () => {
    selected = 0
    cancelPendingQuery()

    /**
     * **Emptying the field is not debounced.** Clearing the box means "show me nothing", and that is
     * an answer the client already has — waiting 120 ms to stop showing stale results would be a
     * delay with nothing on the other end of it. Every other query pays the wait.
     */
    if (field.value === '') { options.onQuery(''); return }

    pendingQuery = setTimeout(() => {
      pendingQuery = null
      options.onQuery(field.value)
    }, QUERY_DEBOUNCE_MS)
  })

  field.addEventListener('keydown', event => {
    const key = event as KeyboardEvent
    if (key.key === 'Escape') { event.preventDefault(); options.onClose(); return }
    if (key.key === 'Enter') {
      event.preventDefault()
      const chosen = results[selected]
      // Silent on an empty list. Enter on nothing is a keystroke that arrived early, not a request.
      if (chosen !== undefined) options.onChoose(chosen.entry)
      return
    }
    if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {
      event.preventDefault()
      selected = nextSelection(selected, results.length, key.key)
      draw()
    }
  })

  // A click outside closes it. The backdrop is the whole screen behind the panel, so this is the
  // ordinary dismissal and needs no separate control.
  backdrop.addEventListener('mousedown', () => { options.onClose() })

  append(panel, field, list)
  append(host, backdrop, panel)
  draw()
  field.focus()

  return {
    show: next => { results = next; selected = 0; draw() },
    close: () => { cancelPendingQuery(); clear(host) },
    query: () => field.value,
  }
}
