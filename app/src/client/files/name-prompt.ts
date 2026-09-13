/**
 * Asking for a name. Annex A35's modal contract, and §13.6's preview.
 *
 * Used by New File, New Folder and Rename — the three flows whose only input is a name.
 *
 * **The keyboard contract is P3's, not a second copy.** `handleModalKey` decides what Enter and
 * Escape do and when confirm is disabled; this file draws a box around it. That matters because
 * A35's rules are the kind that get re-implemented slightly differently on the second dialog —
 * *Enter confirms, Escape dismisses, confirm is disabled while empty*, and **Enter does nothing
 * while empty rather than confirming an empty value**, because a disabled button the keyboard
 * bypasses is not disabled.
 *
 * **§13.6 requires the final name be previewed before confirm**, and that is the other half of this
 * dialog: what you type is not what lands. `My Meeting Notes` becomes `my-meeting-notes.md`, and a
 * name with no letters or digits is refused outright rather than becoming a file called `.md`
 * (M16). The preview is computed by the **same function the server uses** — `slug.ts` — so the two
 * cannot disagree.
 */

import { append, el, onDocument, setText } from '../dom'
import { handleModalKey, modalState, MODAL_AUTOFOCUS_MS } from '../overlays'
import { fileNameFrom } from '../../core/slug'

export interface NamePromptOptions {
  readonly title: string
  /** `'md'` for a file, absent for a folder — the same argument `entry.create` takes. */
  readonly extension?: string
  /** Pre-filled, for Rename. Empty for a new thing. */
  readonly initial?: string
  readonly confirmLabel: string
}

/**
 * Shows the dialog and resolves with the typed name, or `null` if it was dismissed.
 *
 * Resolves the **typed** text, not the slug: the server slugifies, and a client that sent an
 * already-slugged name would be running §13.6's rule a second time. The preview exists so the
 * person can see what will happen, not so the client can do it.
 */
export function askForName(
  parent: HTMLElement,
  options: NamePromptOptions,
): Promise<string | null> {
  return new Promise(resolve => {
    const backdrop = el('div', { className: 'modal-backdrop' })
    const dialog = el('div', {
      className: 'modal',
      attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
    })

    append(dialog, el('div', { className: 'modal-title', text: options.title }))

    const field = el('input', {
      className: 'modal-input',
      attributes: { type: 'text', value: options.initial ?? '', 'aria-label': options.title },
    }) as HTMLInputElement

    /**
     * §4.8: *"a dialog that renames or moves shows the resulting file name in mono beneath the
     * field."* `is-filename` carries the monospace; `.modal-preview` is shared with the unsaved-work
     * dialog, whose preview is prose and should stay prose.
     *
     * A filename is the one string here where the difference between `l` and `1`, or a hyphen and
     * an en dash, decides whether you typed what you meant.
     */
    const preview = el('div', { className: 'modal-preview is-filename' })
    const confirm = el('button', { className: 'modal-confirm', text: options.confirmLabel })
    const cancel = el('button', { className: 'modal-cancel', text: 'Cancel' })

    const buttons = el('div', { className: 'modal-buttons' })
    append(buttons, cancel, confirm)
    append(dialog, field, preview, buttons)
    append(backdrop, dialog)
    append(parent, backdrop)

    let settled = false
    let stopListening = (): void => {}
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      backdrop.remove()
      stopListening()
      resolve(value)
    }

    /**
     * §13.6's preview, recomputed on every keystroke and **refusing out loud**.
     *
     * A refusal shown here is one the person can fix before pressing anything, which is the whole
     * point: M16's failure was a name that became `.md` silently at creation time.
     */
    const refresh = (): void => {
      const state = modalState(field.value)
      const named = fileNameFrom(field.value, options.extension)

      const allowed = state.canConfirm && named.ok
      confirm.toggleAttribute('disabled', !allowed)

      if (field.value.trim() === '') setText(preview, ' ')
      else if (!named.ok) setText(preview, named.detail ?? 'That name cannot be used.')
      else setText(preview, `Will be saved as ${named.value.name}`)

      preview.setAttribute('class', named.ok ? 'modal-preview' : 'modal-preview is-refused')
    }

    const submit = (): void => {
      const named = fileNameFrom(field.value, options.extension)
      if (!modalState(field.value).canConfirm || !named.ok) return
      finish(field.value)
    }

    /**
     * Captured on the document, so Escape works wherever focus is — including on the backdrop
     * after a click that did not land on the field. A listener on the dialog alone leaves a modal
     * that cannot be dismissed by keyboard once focus escapes it.
     */
    function onKey(raw: Event): void {
      const event = raw as KeyboardEvent
      const outcome = handleModalKey(modalState(field.value), {
        key: event.key,
        withModifier: event.metaKey || event.ctrlKey || event.altKey,
      })
      if (outcome.kind === 'ignored') return
      event.preventDefault()
      if (outcome.kind === 'dismissed') finish(null)
      else submit()
    }

    field.addEventListener('input', refresh)
    confirm.addEventListener('click', submit)
    cancel.addEventListener('click', () => { finish(null) })
    // A35 lists a backdrop click with Escape. `currentTarget` so a click inside the dialog does not
    // dismiss it — the dialog is a child of the backdrop, and clicks bubble.
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) finish(null)
    })
    stopListening = onDocument('keydown', onKey, { capture: true })

    refresh()
    // A35's value, transcribed rather than chosen: focus at 50ms, after the dialog has painted.
    setTimeout(() => { field.focus(); field.select() }, MODAL_AUTOFOCUS_MS)
  })
}
