/**
 * The Inbox tab. PRD: *"every inbox across the tree in one view"*, and *"v1 shows and receives."*
 *
 * **Quick dump is the point**, in the PRD's own words: *"the fastest path in the app from 'I have a
 * thought' to 'it's captured' — name-and-go into a chosen inbox (default: main)."* So the capture
 * field is the first thing on the screen, focused, and it takes one line and the Enter key. Nothing
 * is chosen unless you want to choose it.
 *
 * The order of the screen follows from that sentence: **receive first, show second.** A tab that
 * opened on a list you had to scroll past to reach the field would be a slower path than opening a
 * terminal, and then it would not get used.
 *
 * **Items are files and folders, flat, grouped by whose inbox they are in** — the grammar decides
 * both, and this draws its answer. There is no processing here: v1 shows and receives, and the
 * workflows come later, deliberately.
 */

import { append, clear, el } from '../dom'
import { monogramFor } from '../../core/monogram'
import type { WireEntry } from '../../contract/wire'

export interface InboxGroupView {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly label: string
  readonly items: readonly WireEntry[]
}

export interface InboxOptions {
  /** Capture a thought into the chosen inbox. The view has already cleared the field. */
  readonly onCapture: (group: InboxGroupView, name: string) => void
  readonly onOpen: (item: WireEntry) => void
}

/**
 * Which inbox a capture goes to by default. PRD: *"default: main."*
 *
 * The workspace inbox — a `99-inbox-main`, or whatever sits at the top of a registered folder
 * rather than inside a project. Falls back to the first group, because a person with no top-level
 * inbox still has somewhere to put a thought and refusing to guess would mean refusing to capture.
 */
export function defaultInbox(groups: readonly InboxGroupView[]): InboxGroupView | null {
  const main = groups.find(group => group.segments.length === 1)
  return main ?? groups[0] ?? null
}

export function mountInbox(
  host: HTMLElement, groups: readonly InboxGroupView[], options: InboxOptions,
): void {
  clear(host)

  if (groups.length === 0) {
    // §15: every view has a written empty state. This one names the grammar, because "no inboxes"
    // is nearly always "the app does not know what you call one".
    append(host, el('div', {
      className: 'board-empty',
      text: 'No inboxes found. Soil Viewer treats a folder called 01-inbox, inbox or 99-inbox-main '
        + 'as one — make any of those inside a folder you have added.',
    }))
    return
  }

  /* ---- Receive. First on the screen, because it is what the tab is for. ---- */

  const capture = el('div', { className: 'inbox-capture' })
  const field = el('input', {
    className: 'inbox-field',
    attributes: { type: 'text', placeholder: 'Capture a thought…', 'aria-label': 'Capture a thought' },
  }) as HTMLInputElement

  /**
   * **It says "into", because without that word it reads as a filter that does nothing.**
   *
   * the operator, on their first pass: *"the drop down to the right doesn't do anything."* It does — it
   * chooses which inbox the **next captured thought** lands in — but it changes nothing on screen
   * when you use it, and a control sitting above a list that it does not change is indistinguishable
   * from a broken one.
   *
   * The fix is a word, not a mechanism. The control was already beside the capture field; what was
   * missing was anything saying the two belong together. The option text carries the same count it
   * always did, so the choice is still informed.
   */
  const into = el('span', { className: 'inbox-target-label', text: 'into' })

  const target = el('select', {
    className: 'inbox-target',
    attributes: { 'aria-label': 'Which inbox to capture into' },
  }) as HTMLSelectElement
  for (const group of groups) {
    target.appendChild(el('option', {
      text: `${group.label}${group.items.length > 0 ? ` (${group.items.length})` : ''}`,
    }))
  }
  const initial = defaultInbox(groups)
  if (initial !== null) target.selectedIndex = groups.indexOf(initial)

  const send = (): void => {
    const typed = field.value.trim()
    const group = groups[target.selectedIndex]
    if (typed === '' || group === undefined) return
    // Cleared before the round trip. "Name and go" means the field is ready for the next thought
    // immediately; a failure comes back as a banner rather than by holding the text hostage.
    field.value = ''
    options.onCapture(group, typed)
  }

  field.addEventListener('keydown', event => {
    // Enter alone. No modifier, no button to find — this is the whole gesture.
    if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); send() }
  })

  const button = el('button', {
    className: 'inbox-send', text: 'Capture', attributes: { type: 'button' },
  })
  button.addEventListener('click', send)

  append(capture, field, into, target, button)
  append(host, capture)

  /* ---- Show. ---- */

  /**
   * §4.7: **an empty group is not drawn at all.**
   *
   * It used to draw a header and the word "Empty." under it. On this tree that is a screen of
   * headings announcing nothing — the soil has an inbox per project and most of them are empty most
   * of the time, so the list you came to read was several scrolls down past its own table of
   * contents.
   *
   * **The capture control still offers every group**, including these. An inbox you cannot see is
   * still an inbox you can put something in, and that is the whole shape of the tab: receive first,
   * show second.
   */
  const filled = groups.filter(group => group.items.length > 0)

  if (filled.length === 0) {
    const clear = el('div', { className: 'inbox-clear' })
    append(clear, el('div', { className: 'inbox-clear-title', text: 'Inbox clear' }))
    append(clear, el('div', {
      className: 'inbox-clear-line',
      // Names where a capture lands, because that is the one question an empty inbox raises.
      text: initial === null
        ? 'Anything you capture will land in your first inbox.'
        : `Anything you capture lands in ${initial.label}.`,
    }))
    append(host, clear)
  }

  for (const group of filled) {
    const section = el('div', { className: 'inbox-group' })
    const header = el('div', { className: 'inbox-group-header' })

    /**
     * §4.7's monogram — **on the group, not on every row.**
     *
     * The packet draws one at the start of each list row. Within a group every row would carry the
     * same two letters in the same colour, which is the objection that deleted the `FILE` column
     * three lines below: *"a label identical on every row is not a label; it is a margin with text
     * in it."* On the header it marks the one thing that actually varies down the screen.
     *
     * Recorded as a deviation in `build/design-pass-not-in-v1.md`, with the alternative — a flat
     * list, no groups, where a per-row mark would earn its place — written down rather than assumed
     * away.
     */
    const mark = monogramFor(group.label)
    append(header, el('span', {
      className: `inbox-monogram mono-${mark.slot}`,
      text: mark.initials,
      // The label beside it says the same thing in full; announcing the initials repeats it.
      attributes: { 'aria-hidden': 'true' },
    }))

    append(header, el('span', { className: 'inbox-group-label', text: group.label }))
    append(header, el('span', {
      className: 'inbox-group-count', text: String(group.items.length),
    }))
    append(section, header)

    for (const item of group.items) {
      const row = el('div', {
        className: `inbox-item${item.kind === 'directory' ? ' is-folder' : ''}`,
        attributes: { tabindex: '0' },
      })
      /**
       * **Marked only when it is a folder.** A folder in an inbox is an item in its own right — the
       * soil's inboxes take *"a file, or a folder of reference material"* — so it earns a word.
       *
       * "file" did not. It appeared on every row of a forty-four item list, said the same thing
       * every time, and cost a column of width to do it. A label identical on every row is not a
       * label; it is a margin with text in it.
       */
      if (item.kind === 'directory') {
        append(row, el('span', { className: 'inbox-item-kind', text: 'folder' }))
      }
      append(row, el('span', {
        className: 'inbox-item-name', text: item.title.trim() === '' ? item.name : item.title,
      }))
      row.addEventListener('click', () => { options.onOpen(item) })
      append(section, row)
    }

    append(host, section)
  }

  // Focused last, after everything is in the document — focusing a node that is not yet attached
  // does nothing, silently, and the tab would open with the caret nowhere.
  field.focus()
}
