/**
 * The planned-project composer. The operator's ask, 2026-08-10.
 *
 * > *"I know I need to do this project, I'm not ready to scaffold it… I want to put it on my back
 * > burner, and so I put in the name of it and then I fill out a description. That's helpful.
 * > That's the only thing that I want to make sure I can do."*
 *
 * **A name and a description, and nothing else.** No folder picker, no template, no location — the
 * whole point of a planned card is that none of those decisions has been made yet, and asking for
 * any of them would turn "write the thought down" back into "start the project".
 *
 * Nothing here writes to the file tree, because there is nothing to write: the result is a line in
 * app config.
 */

import { append, el, onDocument, setText } from '../dom'
import { MODAL_AUTOFOCUS_MS } from '../overlays'

export interface PlanDraft {
  readonly name: string
  readonly body: string
}

export type PlanOutcome =
  | (PlanDraft & { readonly removed: false })
  /** Forget this plan. There is no file, so there is nothing to delete. */
  | { readonly removed: true; readonly name: string; readonly body: string }

/**
 * Asks for a plan. Resolves `null` when dismissed.
 *
 * **Remove is offered only when editing**, never when composing — a Remove button on an empty new
 * card is a control with nothing to act on, and it sits exactly where Cancel would be expected.
 */
export function askForPlan(parent: HTMLElement, draft: PlanDraft): Promise<PlanOutcome | null> {
  return new Promise<PlanOutcome | null>(resolve => {
    const editing = draft.name !== ''
    const backdrop = el('div', { className: 'modal-backdrop' })
    const dialog = el('div', {
      className: 'modal',
      attributes: {
        role: 'dialog', 'aria-modal': 'true',
        'aria-label': editing ? 'Edit a planned project' : 'Plan a project',
      },
    })

    append(dialog, el('div', {
      className: 'modal-title',
      text: editing ? 'Planned project' : 'Plan a project',
    }))
    append(dialog, el('div', {
      className: 'modal-note',
      // Said out loud, because the whole value of the card is that it is *not* a folder and a
      // person should never wonder whether this one made something.
      text: 'This is a note to yourself. No folder is created.',
    }))

    const name = el('input', {
      className: 'modal-input',
      attributes: { type: 'text', value: draft.name, 'aria-label': 'Name' },
    }) as HTMLInputElement
    const body = el('textarea', {
      className: 'modal-textarea',
      attributes: { rows: '5', 'aria-label': 'Description' },
    }) as HTMLTextAreaElement
    // Set as a property rather than an attribute: a textarea's value is its child text, and an
    // `value` attribute on it does nothing at all.
    body.value = draft.body

    const confirm = el('button', {
      className: 'modal-confirm', text: editing ? 'Save' : 'Add',
    })
    const cancel = el('button', { className: 'modal-cancel', text: 'Cancel' })
    const buttons = el('div', { className: 'modal-buttons' })
    if (editing) {
      /**
       * **Remove asks, and it did not.** (security review, P9-4.)
       *
       * There is no file behind a planned card, so nothing on disk is lost — but the *description*
       * is prose the operator wrote, and it exists nowhere else. One click used to destroy it with no
       * confirmation and no undo, while `config-store.ts` one level up keeps everything it removes.
       * The route's own comment claimed this "still says so on screen"; it did not say anything.
       *
       * Two-step in place rather than a second dialog: the composer is already a modal, and stacking
       * one on another is how the retained-buffer prompt ended up arriving on top of a screen the
       * person had just chosen to postpone.
       */
      const remove = el('button', { className: 'modal-remove', text: 'Remove' })
      let armed = false
      remove.addEventListener('click', () => {
        if (!armed) {
          armed = true
          setText(remove, 'Remove — click again')
          remove.classList.add('is-armed')
          return
        }
        finish({ removed: true, name: name.value, body: body.value })
      })
      // Any edit disarms it: a click that lands after the text changed is not the click that armed.
      for (const field of [name, body]) {
        field.addEventListener('input', () => {
          if (!armed) return
          armed = false
          setText(remove, 'Remove')
          remove.classList.remove('is-armed')
        })
      }
      append(buttons, remove)
    }
    append(buttons, cancel, confirm)
    append(dialog, name, body, buttons)
    append(backdrop, dialog)
    append(parent, backdrop)

    let settled = false
    let stopListening = (): void => {}
    function finish(outcome: PlanOutcome | null): void {
      if (settled) return
      settled = true
      backdrop.remove()
      stopListening()
      resolve(outcome)
    }

    const refresh = (): void => {
      // A plan needs a name. The description is optional — sometimes the name IS the thought.
      confirm.toggleAttribute('disabled', name.value.trim() === '')
    }
    name.addEventListener('input', refresh)
    refresh()

    const submit = (): void => {
      if (name.value.trim() === '') return
      finish({ removed: false, name: name.value.trim(), body: body.value })
    }
    confirm.addEventListener('click', submit)
    cancel.addEventListener('click', () => { finish(null) })
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) finish(null)
    })

    stopListening = onDocument('keydown', raw => {
      const event = raw as KeyboardEvent
      if (event.key === 'Escape') { finish(null); return }
      /**
       * Enter submits from the **name** field only. In the description it inserts a newline, which
       * is the entire point of a description — a dialog whose text area cannot hold two lines is
       * not somewhere anyone writes a thought down.
       */
      if (event.key === 'Enter' && event.target === name) {
        event.preventDefault()
        submit()
      }
    }, { capture: true })

    setTimeout(() => { name.focus() }, MODAL_AUTOFOCUS_MS)
  })
}
