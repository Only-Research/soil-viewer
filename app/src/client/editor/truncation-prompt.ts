/**
 * §13.2's truncation confirmation — the question that was specified, built server-side, and never
 * asked.
 *
 * §13.2 requires a blocked truncation be *"surfaced as an explicit confirmation naming the loss."*
 * Every part of that existed except the confirmation. The server decides and answers
 * `truncation-blocked` with both byte counts; `document-session.ts` exposes `confirmTruncation()`,
 * which re-issues the identical save with the waiver attached; the wire carries the flag. **Nothing
 * called it.** Two tests did, and no product code — the sweep of 2026-08-16 found it, and the
 * comment at the one place that handled `blocked` described the banner it rendered as *"a question,
 * not a failure"* while rendering a sentence with no way to answer.
 *
 * **The harm is not a missing dialog, it is a file that cannot be saved.** `clearsDirty` is true
 * only for `saved`, so a blocked save leaves the buffer dirty forever. Delete a long section on
 * purpose — which is an ordinary thing to do to a document — and every autosave from then on is
 * refused, the banner reappears on each one, and there is no sequence of actions that writes the
 * file. The waiver is the only way out and it had no door.
 *
 * **Numbers are formatted here rather than with `toLocaleString`.** That reads the ambient locale,
 * so the same code produces `3,412` on one machine and `3.412` on another — which turns a wording
 * test into something that passes where it was written and fails elsewhere.
 */

import { append, el, onDocument } from '../dom'

/** What the surface knows when the server refuses to shrink a file this much. */
export interface TruncationSummary {
  /** The file's name alone — the dialog names the thing, not the path. */
  readonly fileName: string
  /** What is on disk now. */
  readonly wasBytes: number
  /** What the save would leave. Always the smaller of the two, or this dialog is a lie. */
  readonly willBeBytes: number
}

/** Thousands separators, without asking the environment what a thousands separator is. */
export function groupDigits(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)))
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    // Counted from the RIGHT, so the leading group is the short one: 1,234 and never 123,4.
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return value < 0 ? `-${out}` : out
}

/** How many bytes the save would remove. Never negative — see `askAboutTruncation`. */
export function bytesRemoved(summary: TruncationSummary): number {
  return Math.max(0, summary.wasBytes - summary.willBeBytes)
}

/**
 * The sentence at the top. **Names the loss in bytes, because bytes are what was measured.**
 *
 * Not "characters": the counts are `baseline.size` and `bytes.length`, and one emoji is four bytes
 * and one character. Reporting a measured byte count as a character count would be a number that is
 * simply wrong for any file with an accent in it.
 */
export function truncationHeadline(summary: TruncationSummary): string {
  const removed = bytesRemoved(summary)
  const unit = removed === 1 ? 'byte' : 'bytes'
  return `Saving would delete ${groupDigits(removed)} ${unit} from ${summary.fileName}.`
}

/**
 * The plain-language line under it, and **the half that matters is the second sentence.**
 *
 * A person reading "this would delete most of your file" needs to know, immediately, whether it
 * already happened. It has not: the server refused the write, so the file on disk is untouched.
 * Saying so is what turns the dialog from an alarm into a question.
 */
export function truncationWarning(summary: TruncationSummary): string {
  const removed = bytesRemoved(summary)
  const proportion = summary.wasBytes > 0
    ? `That is ${sharePercent(removed, summary.wasBytes)}% of the file. `
    : ''
  return `${proportion}Nothing has been written — the copy on disk is still complete.`
}

/**
 * The share, rounded so that **the two endpoints cannot be reached by rounding**.
 *
 * Found by looking at the rendered dialog rather than by a test: deleting 1,648 of 1,652 bytes read
 * *"That is 100% of the file"* while four bytes survived. `Math.round` was the whole cause. On a
 * dialog whose only job is telling somebody the truth about a deletion, a number that says
 * everything when something remains is the one error that matters most — a person who checks and
 * finds four bytes left learns the dialog rounds, and stops believing the next one.
 *
 * So 100 is reserved for a file that really would be emptied, and 0 for one that loses nothing.
 * Everything in between is clamped to 1..99, which costs at most a percentage point of precision on
 * a figure nobody is doing arithmetic with.
 */
function sharePercent(removed: number, total: number): number {
  if (removed >= total) return 100
  if (removed <= 0) return 0
  return Math.min(99, Math.max(1, Math.round((removed / total) * 100)))
}

/** The exact figures, for someone who wants to check the claim rather than take it. */
export function truncationDetail(summary: TruncationSummary): string {
  return `${groupDigits(summary.wasBytes)} bytes on disk → `
    + `${groupDigits(summary.willBeBytes)} bytes after saving.`
}

/**
 * Asks. Resolves `true` only for a deliberate click on the confirming button.
 *
 * **Every other way out is `false`**, and that asymmetry is the whole design: Escape, the backdrop,
 * and the cancel button all mean *do not write*. The file on disk is currently complete and the
 * edit is still in the buffer, so declining costs nothing and can be re-decided; confirming deletes
 * content. `restore-prompt.ts` resolves its own default the same way and for the same reason — a
 * mis-aimed click is not consent to throw work away.
 *
 * The confirming button is worded as the destructive act rather than as agreement. "OK" next to a
 * sentence about deletion is a button people click to make a dialog go away.
 */
export function askAboutTruncation(
  parent: HTMLElement, summary: TruncationSummary,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const backdrop = el('div', { className: 'modal-backdrop' })
    const dialog = el('div', {
      className: 'modal',
      attributes: {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Confirm a large deletion',
      },
    })

    append(dialog, el('div', { className: 'modal-title', text: truncationHeadline(summary) }))
    append(dialog, el('div', { className: 'modal-warning', text: truncationWarning(summary) }))
    append(dialog, el('div', { className: 'modal-note', text: truncationDetail(summary) }))

    const confirm = el('button', {
      className: 'modal-confirm truncation-confirm', text: 'Delete it and save',
    })
    const cancel = el('button', {
      className: 'modal-cancel truncation-cancel', text: "Don't save",
    })

    const buttons = el('div', { className: 'modal-buttons' })
    append(buttons, cancel, confirm)
    append(dialog, buttons)
    append(backdrop, dialog)
    append(parent, backdrop)

    let settled = false
    let stopListening = (): void => {}
    const finish = (answer: boolean): void => {
      if (settled) return
      settled = true
      backdrop.remove()
      stopListening()
      resolve(answer)
    }

    confirm.addEventListener('click', () => { finish(true) })
    cancel.addEventListener('click', () => { finish(false) })
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) finish(false)
    })

    // On the document, so it works wherever focus is — A35, and the same reasoning as the restore
    // prompt: a listener on the dialog alone leaves a modal the keyboard cannot dismiss once focus
    // lands on the backdrop.
    function onKey(raw: Event): void {
      if ((raw as KeyboardEvent).key === 'Escape') finish(false)
    }
    stopListening = onDocument('keydown', onKey)
  })
}
