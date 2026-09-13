/**
 * The folder picker behind Settings → Folders. Spec §11, F6.3, and annex A35's modal contract.
 *
 * **This is not the Move picker, and the difference is not cosmetic.** `move-picker.ts` walks the
 * *indexed tree* inside folders already registered; this walks the *filesystem* outside all of
 * them, through `folders.browse`, which is the one route allowed to speak in absolute paths (§6's
 * standing exception — a folder that is not yet registered has no `(rootId, segments)` to be named
 * by). They look similar and share nothing, deliberately: merging them would mean one component
 * whose scope rules depend on which mode it is in, and the scope rules here are the security
 * boundary.
 *
 * **Descend to choose, rather than select-a-row.** The CTA acts on the folder you are *standing in*,
 * so what gets registered is what the path line says, and there is no second selection state that
 * can disagree with it. A row is a place to go, not a thing to pick.
 *
 * **Overridden 2026-08-09: this is no longer desktop-only.** §17 and §18 said the picker was
 * desktop-only and that the phone could not register roots. The operator voided both — *"I want this
 * just to be a normal settings menu within the main interface"* — and the clause was never doing
 * what it claimed anyway: it was written against `PORT_LOCAL`, which serves no client, so it did
 * not restrict the picker to the desktop, it made it reachable from nowhere.
 */

import { append, clear, el, onDocument } from '../dom'

/** What the browse route answers with. Mirrors `BrowseListing` plus the allowed roots. */
export interface BrowseReply {
  readonly path: string
  readonly parent: string | null
  readonly directories: ReadonlyArray<{ readonly name: string; readonly path: string }>
  readonly roots: readonly string[]
}

export interface FolderBrowserOptions {
  /**
   * Asks the server what is inside a path. `''` means "wherever you start me" — the client never
   * constructs a home path, and never has to be told one when the answer is a refusal.
   */
  readonly browse: (absolutePath: string) => Promise<BrowseReply | null>
}

/**
 * Shows the picker; resolves with an absolute path, or `null` if it was dismissed.
 *
 * Resolves the path only. The backup warning (§11) and the registration itself are the caller's,
 * because they are decisions about what to *do* with the answer and this dialog's job is the
 * answer.
 *
 * **There is deliberately no "already added" marker on these rows.** The obvious version compares
 * each row against the registered folders' absolute paths — and the client does not have them,
 * because §6 keeps absolute paths off the wire in both directions and `folders.list` therefore
 * carries a short display path instead. Marking rows by matching the tail of a path would be a
 * guess dressed as a fact: `work/notes` matches more than one folder on a real disk, and the row it
 * marked wrongly would be the one a person then did not click. So the duplicate is caught where the
 * truth lives — `register` refuses an overlap or a repeat, and Settings shows the server's own
 * sentence. One answer, from the side that can actually see.
 */
export function askForFolder(
  parent: HTMLElement,
  options: FolderBrowserOptions,
): Promise<string | null> {
  return new Promise(resolve => {
    const backdrop = el('div', { className: 'modal-backdrop' })
    const dialog = el('div', {
      className: 'modal modal-wide',
      attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose a folder' },
    })

    append(dialog, el('div', { className: 'modal-title', text: 'Choose a folder' }))

    const where = el('div', { className: 'browser-path' })
    const list = el('div', {
      className: 'picker',
      attributes: { role: 'list', 'aria-label': 'Folders' },
    })
    const note = el('div', { className: 'modal-note' })

    const confirm = el('button', { className: 'modal-confirm', text: 'Add This Folder' })
    const cancel = el('button', { className: 'modal-cancel', text: 'Cancel' })
    const buttons = el('div', { className: 'modal-buttons' })
    append(buttons, cancel, confirm)
    append(dialog, where, list, note, buttons)
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

    /** Where we are. `null` until the first reply lands, which is why the CTA starts disabled. */
    let at: BrowseReply | null = null

    const go = (path: string): void => {
      void (async () => {
        const reply = await options.browse(path)
        if (settled) return
        if (reply === null) {
          // A refusal is shown here rather than thrown to a banner behind the modal, where it would
          // be invisible until the person dismissed the dialog wondering why nothing happened.
          clear(note)
          note.setAttribute('class', 'modal-note is-refused')
          note.textContent = 'That folder could not be opened.'
          return
        }
        at = reply
        render()
      })()
    }

    function render(): void {
      const here = at
      clear(list)
      note.setAttribute('class', 'modal-note')

      if (here === null) {
        where.textContent = 'Loading…'
        confirm.toggleAttribute('disabled', true)
        return
      }

      where.textContent = here.path

      /**
       * The roots, always offered, as the way back to the top.
       *
       * `parent` goes `null` at a root so the "up" control cannot walk out of the browsable area
       * (the server would refuse anyway; this stops the UI offering a button whose only outcome is
       * an error). Without the root rows, a person who descended from Home into a volume would have
       * no way across.
       */
      const rootRow = el('div', { className: 'browser-roots' })
      for (const root of here.roots) {
        const chip = el('button', {
          className: `browser-root${root === here.path ? ' is-current' : ''}`,
          text: root,
          attributes: { type: 'button' },
        })
        chip.addEventListener('click', () => { go(root) })
        append(rootRow, chip)
      }
      append(list, rootRow)

      if (here.parent !== null) {
        const up = el('button', {
          className: 'picker-row is-up',
          text: '↑ Up one folder',
          attributes: { type: 'button' },
        })
        const parentPath = here.parent
        up.addEventListener('click', () => { go(parentPath) })
        append(list, up)
      }

      for (const child of here.directories) {
        const row = el('button', {
          className: 'picker-row',
          attributes: { type: 'button' },
        })
        append(row, el('span', { className: 'picker-label', text: child.name }))
        row.addEventListener('click', () => { go(child.path) })
        append(list, row)
      }

      if (here.directories.length === 0) {
        // An empty list and a failed list look identical otherwise, and this app has already
        // shipped one empty-means-success (§6): `tree.children` answering `[]` for an unindexed
        // root. Saying which one this is costs a line.
        append(list, el('div', { className: 'picker-empty', text: 'No folders inside this one.' }))
      }

      note.textContent = ''
      confirm.toggleAttribute('disabled', false)
    }

    confirm.addEventListener('click', () => { if (at !== null) finish(at.path) })
    cancel.addEventListener('click', () => { finish(null) })
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) finish(null)
    })
    stopListening = onDocument('keydown', raw => {
      if ((raw as KeyboardEvent).key === 'Escape') finish(null)
    }, { capture: true })

    render()
    go('')
  })
}
