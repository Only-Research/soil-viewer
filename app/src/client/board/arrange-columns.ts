/**
 * **ARRANGING THE COLUMNS AS A STACK.** Ruled 2026-08-21.
 *
 * > *"Clicking the dot and then clicking move right — if I want to move something all the way over,
 * > it's messy… some kind of interface where I could click rearrange and then I can see them all
 * > like in a stack and I can arrange the board top to bottom equals left to right."*
 *
 * Two controls came out of that and they are not alternatives. The **arrows on the column head**
 * handle a nudge; **this** handles the long move, because the thing that was messy was distance.
 * `Top` and `Bottom` are the reason this exists at all — one press for the move that took five.
 *
 * **No drag, and that is §18.5 rather than an omission.** The operator ruled it for the Tasks board and
 * boards inherited it: a thumb sliding a few pixels while reading is a move nobody asked for. A
 * vertical stack is where drag would have been most tempting, which is exactly why it says so here.
 *
 * **Every press saves.** There is no working copy and no Save button — the same rule the head arrows
 * follow, so the two controls cannot disagree about what the order is, and there is no arrangement
 * to lose by closing the panel. It also means a column that appears while this is open is simply
 * there next time it redraws, rather than being clobbered by a stale list on save.
 */

import { append, clear, el } from '../dom'

export interface ArrangeRow {
  readonly id: string
  readonly name: string
}

export interface ArrangeOptions {
  /**
   * Both indices are positions among the **real** columns, which is the same list this renders.
   * The caller owns the save; this owns nothing but the picture.
   */
  readonly onMove: (from: number, to: number) => void
  /**
   * True when the board has an `Uncategorized` pile. It is not a folder and cannot be arranged, so
   * it is absent from the stack — and a stack that silently disagrees with the board beside it is
   * worth one line of explanation rather than leaving them to work out why it is missing.
   */
  readonly hasPinnedFirst: boolean
}

const HINT = 'Top to bottom is left to right.'
const PINNED_HINT = 'Uncategorized always stays first.'

/**
 * One row's four presses. Written as data so the disabled rule is stated **once** — the version
 * with four hand-written buttons had the edge condition spelled out four times, which is four
 * places for the off-by-one to live.
 */
const moves = (at: number, last: number): ReadonlyArray<{
  readonly label: string
  readonly to: number
  readonly enabled: boolean
  readonly describe: string
}> => [
  { label: 'Top', to: 0, enabled: at > 0, describe: 'to the top' },
  { label: 'Up', to: at - 1, enabled: at > 0, describe: 'up' },
  { label: 'Down', to: at + 1, enabled: at < last, describe: 'down' },
  { label: 'Bottom', to: last, enabled: at < last, describe: 'to the bottom' },
]

export function renderArrangeColumns(
  host: HTMLElement,
  rows: readonly ArrangeRow[],
  options: ArrangeOptions,
): void {
  clear(host)

  append(host, el('div', { className: 'arrange-hint', text: HINT }))
  if (options.hasPinnedFirst) {
    append(host, el('div', { className: 'arrange-hint arrange-hint-dim', text: PINNED_HINT }))
  }

  /**
   * **Fewer than two columns and there is nothing to arrange.** The caller does not draw the button
   * in that case, so this is the belt to that braces — and it explains rather than rendering an
   * empty box, which §17 calls the difference between "nothing here yet" and "this is broken".
   */
  if (rows.length < 2) {
    append(host, el('div', {
      className: 'arrange-empty',
      text: 'There is only one column to arrange. Add another and they can be reordered.',
    }))
    return
  }

  const list = el('div', { className: 'arrange-list' })
  const last = rows.length - 1

  rows.forEach((row, at) => {
    const line = el('div', { className: 'arrange-row' })

    const name = el('div', { className: 'arrange-row-name' })
    // The position, because "top to bottom is left to right" is a claim the stack should be able to
    // back up at a glance — and after a `Top` press it is the fastest way to see it landed.
    append(name, el('span', { className: 'arrange-row-index', text: String(at + 1) }))
    append(name, el('span', { className: 'arrange-row-label', text: row.name }))
    append(line, name)

    const actions = el('div', { className: 'arrange-row-actions' })
    for (const move of moves(at, last)) {
      const button = el('button', {
        className: 'arrange-move',
        text: move.label,
        attributes: {
          type: 'button',
          /**
           * **Named with the column, not just the direction.** Four buttons reading `Top` down a
           * stack is ambiguous to a screen reader and to `getByRole` alike — the ambiguous-locator
           * mistake this build records making three times, avoided deliberately rather than found.
           */
          'aria-label': `Move ${row.name} ${move.describe}`,
        },
      })
      /**
       * **Disabled at the ends, not omitted** — and this is the one place the boards' own rule is
       * deliberately reversed. A missing *menu entry* is invisible; a missing *button* leaves a hole
       * that shifts the other three under the finger that is about to press one. The strip stays
       * put, which on a phone is the difference between pressing `Down` and pressing `Bottom`.
       */
      if (!move.enabled) button.setAttribute('disabled', 'true')
      else {
        button.addEventListener('click', event => {
          /**
           * **`stopPropagation`, and the panel closes without it.** This is subtle enough to be
           * worth the whole comment.
           *
           * The panel dismisses on a document-level click that asks *"did this land inside me?"* by
           * calling `panel.contains(target)`. Answering the press **repaints the stack
           * synchronously**, which destroys this very button — so by the time the click finishes
           * bubbling, `target` is a **detached** node, `contains` says no, and the panel reads its
           * own control as a click on the outside world and shuts.
           *
           * It only appeared when the repaint stopped waiting for the round trip: with the redraw a
           * task later, bubbling had already finished and the node was still attached. **The bug was
           * bought with the responsiveness fix**, which is why a test written for one caught the
           * other.
           */
          event.stopPropagation()
          options.onMove(at, move.to)
        })
      }
      append(actions, button)
    }

    append(line, actions)
    append(list, line)
  })

  append(host, list)
}
