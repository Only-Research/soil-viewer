/**
 * "You have unsaved work in this file from before." Spec §13.8's explicit resolution.
 *
 * **A RETAINED BUFFER IS NEVER AUTO-REPLAYED.** That is the single most important line in §13.8 and
 * it is the entire reason this screen exists rather than a one-line `setText`. Replaying silently
 * is how a stale buffer overwrites work an agent did in the meantime — the exact class of loss this
 * build exists to prevent, arriving through the feature built to prevent it.
 *
 * So both versions are shown, side by side, with the first differing line named, and the person
 * chooses. The same shape as §13.5's conflict surface, for the same reason.
 *
 * ## Two choices, not three, and the third one falls out of machinery that already works
 *
 * §13.8 names the resolution as *view diff / save as conflict sibling / discard*. The diff is here
 * and discard is here. **The sibling is not re-implemented**, because restoring produces it for
 * free: the retained text goes into the editor as an unsaved edit, and the moment it is saved,
 * §13.5's contract runs — if the file changed underneath, the save is refused on the content hash,
 * the edit is rescued to a sibling file, and the two-pane conflict surface opens. That path is
 * built, mutation-swept, and proven end to end.
 *
 * Re-implementing "write a sibling" here would mean a second writer with its own naming, its own
 * collision handling and its own failure modes, sitting beside a proven one. The build already has
 * a rule about that, learned from the byte endpoint: the danger is rarely a second divergent
 * implementation — it is a caller that quietly does the job itself instead of going through the
 * chokepoint.
 *
 * ## Dismissing is a real answer and it keeps the buffer
 *
 * Escape or "Decide later" leaves the retained buffer exactly where it is and asks again next time.
 * §13.5 puts unresolved conflicts on a persistent list for precisely this reason: sometimes the
 * answer is "not now", and a question that disappears on its own is the failure, not the feature.
 * **Nothing here discards a buffer except the button that says so.**
 */

import { append, el, onDocument } from '../dom'
import { firstDifferingLine } from './conflict-view'

export type RestoreChoice = 'restore' | 'discard'

export interface RetainedSummary {
  readonly fileName: string
  /** The unsaved text that was kept. */
  readonly retained: string
  /** What the file holds right now. */
  readonly onDisk: string
  /**
   * The identity token no longer matches: the file changed on disk while the edit sat unsaved.
   * This is the case auto-replay would destroy, and the wording changes to say so.
   */
  readonly stale: boolean
}

/**
 * Whether there is anything worth asking about.
 *
 * **Identical text is not a rescue, it is a nag.** A buffer retained a keystroke before a successful
 * save holds exactly what is on disk, and asking "which of these two identical documents do you
 * want?" every time a file is opened teaches a person to dismiss the question without reading it —
 * which is precisely how the one that mattered would get dismissed too. §13.4 makes the same point
 * about conflicts over byte-identical content.
 */
export function worthOffering(retained: string, onDisk: string): boolean {
  return retained !== onDisk
}

/** The sentence at the top. Pure, so the wording is checked rather than eyeballed. */
export function restoreHeadline(summary: RetainedSummary): string {
  return summary.stale
    ? `${summary.fileName} changed on disk while your edit was unsaved.`
    : `You have unsaved changes to ${summary.fileName} from earlier.`
}

/** The line under it: what differs, and — when stale — the warning that matters. */
export function restoreDetail(summary: RetainedSummary): string {
  const differing = firstDifferingLine(summary.retained, summary.onDisk)
  const where = differing === null
    ? 'The two versions are identical.'
    : `They first differ at line ${differing}.`
  return summary.stale
    ? `${where} Keeping yours will replace what is on disk now, so read both before choosing.`
    : `${where} Nothing has been changed yet.`
}

/**
 * **RETIRED 2026-08-26 ON THE RULING. NOTHING CALLS THIS, AND NOTHING SHOULD.**
 *
 * *"I don't want these dialogs when agents are editing my files inbetween loading them in the
 * viewer, this is unacceptable UI."*
 *
 * The screen below was not badly built; it answered a question that should never have been asked on
 * this tree. It assumed the reader is the only editor, so a difference between the browser's copy
 * and the disk meant two versions and a choice. Here agents are the primary editors, the file
 * changes between nearly every visit, and the difference means only that an agent did its job —
 * so the screen fired constantly, and every firing was noise in front of a file they wanted to read.
 *
 * `main.tsx` now decides from the copy's own state instead of from a comparison: a copy whose file
 * changed underneath is dropped unseen, and a copy whose file is untouched is simply put back. The
 * full reasoning is at that call site.
 *
 * **Kept rather than deleted**, per the build plan's standing order 3 — nothing in this repository
 * is deleted without the operator's explicit direction. `worthOffering` above is still live and still
 * imported, so this module remains reachable and the reachability gate is satisfied honestly rather
 * than through an allowlist entry. If they rule that the screen goes for good, this function, its
 * `RestoreChoice`/`RetainedSummary` types, `restoreHeadline`, `restoreDetail`, their tests and the
 * `.restore-modal` styles all go together.
 *
 * Built as a modal rather than mounted into the pane, so the editor underneath was left standing —
 * choosing "Keep mine" put the text straight into the surface that was already open, instead of
 * tearing the pane down and rebuilding it around a decision.
 */
export function askAboutRetainedBuffer(
  parent: HTMLElement, summary: RetainedSummary,
): Promise<RestoreChoice | null> {
  return new Promise<RestoreChoice | null>(resolve => {
    const backdrop = el('div', { className: 'modal-backdrop' })
    const dialog = el('div', {
      className: 'modal restore-modal',
      attributes: {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Unsaved work from earlier',
      },
    })

    append(dialog, el('div', { className: 'modal-title', text: restoreHeadline(summary) }))
    append(dialog, el('div', {
      className: summary.stale ? 'modal-preview is-refused' : 'modal-preview',
      text: restoreDetail(summary),
    }))

    const panes = el('div', { className: 'conflict-panes' })
    for (const side of [
      { label: 'Yours (unsaved, kept on this device)', text: summary.retained, className: 'is-mine' },
      { label: 'On disk now', text: summary.onDisk, className: 'is-theirs' },
    ]) {
      const pane = el('div', { className: `conflict-pane ${side.className}` })
      append(pane, el('div', { className: 'conflict-pane-label', text: side.label }))
      // `textContent`, never markup. This is file content, and on this tree agents wrote it.
      append(pane, el('pre', { className: 'conflict-text', text: side.text }))
      append(panes, pane)
    }
    append(dialog, panes)

    const restore = el('button', {
      className: 'modal-confirm restore-keep-mine', text: 'Use your unsaved version',
    })
    const discard = el('button', {
      className: 'modal-cancel restore-discard', text: 'Discard your unsaved version',
    })
    const later = el('button', { className: 'conflict-later', text: 'Decide later' })

    const buttons = el('div', { className: 'modal-buttons' })
    append(buttons, later, discard, restore)
    append(dialog, buttons)
    append(backdrop, dialog)
    append(parent, backdrop)

    let settled = false
    let stopListening = (): void => {}
    const finish = (choice: RestoreChoice | null): void => {
      if (settled) return
      settled = true
      backdrop.remove()
      stopListening()
      resolve(choice)
    }

    restore.addEventListener('click', () => { finish('restore') })
    discard.addEventListener('click', () => { finish('discard') })
    later.addEventListener('click', () => { finish(null) })
    /**
     * A click on the backdrop is "decide later", never "discard".
     *
     * The default answer to a question about unsaved work has to be the one that keeps it. A
     * mis-aimed click is not consent to throw away the only copy of something.
     */
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) finish(null)
    })

    /**
     * Escape on the document, so it works wherever focus is — A35. A listener on the dialog alone
     * leaves a modal that cannot be dismissed by keyboard once focus lands on the backdrop.
     */
    function onKey(raw: Event): void {
      if ((raw as KeyboardEvent).key === 'Escape') finish(null)
    }
    stopListening = onDocument('keydown', onKey)
  })
}
