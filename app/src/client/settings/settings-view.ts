/**
 * Settings. Spec §11 and §21's amended PRD row; the ruling of 2026-08-09.
 *
 * *"I want this just to be a normal settings menu within the main interface just like it is in the
 * app as it exists today where I can click around in settings and add a folder to the file tree."*
 *
 * **Two sections: Folders and Templates.** This said "one section today: Folders" while the file
 * below rendered both — a header describing an earlier state of its own code. The PRD says *"Settings: Folders and Templates. Nothing else."*
 * and §21 amends that to also carry viewer identity, unresolved config keys and chatroom author
 * colors. Templates are P8 and the rest belong to the phases that produce them, so the shape here
 * is a **list of sections** with one entry in it rather than a folders dialog that later has to be
 * turned inside out. The operator, on the templates half they are modelling this after in the reference app
 * app: *"I don't wanna make it crazy or even get to that at this point."*
 *
 * ## Remove, and the one thing it must never be mistaken for
 *
 * the operator asked for it explicitly — *"it should act as the original app, you can add and remove a
 * folder tree"* — after being asked, because their standing rule is *"there needs to be zero remove
 * features anywhere in this app… nothing gets deleted, no files get deleted, I move them, they get
 * archived."* Both are true at once, and the reason is that **this removes nothing**:
 * `folders.deregister` moves the registry entry to a `deregistered` list (§13.8's M7 — the entry is
 * never dropped either), clears the index rows and stops the watcher. **Not one byte on disk is
 * touched.** The folder and everything in it stays exactly where it is.
 *
 * That is a distinction a button cannot carry on its own, so the confirmation says it in words
 * before anything happens. A control whose name suggests deletion, in an app built on the promise
 * that nothing is ever deleted, has to be explicit about which one it is.
 */

import { append, clear, el, onDocument } from '../dom'
import { MODAL_AUTOFOCUS_MS } from '../overlays'
import { askForFolder, type BrowseReply } from './folder-browser'
import { folderIdFor } from './folder-id'

export interface RegisteredFolderRow {
  readonly id: string
  readonly name: string
  /** The short path `folders.list` carries — enough to tell two folders called `notes` apart. */
  readonly displayPath: string
}

export interface TemplateRow {
  readonly id: string
  readonly name: string
  /** Where it points, for the row's second line. Folder-relative, joined for display only. */
  readonly where: string
  /** False when the folder it points into is no longer registered. */
  readonly available: boolean
}

export interface SettingsOptions {
  readonly folders: () => readonly RegisteredFolderRow[]
  readonly browse: (absolutePath: string) => Promise<BrowseReply | null>
  /** Resolves with a plain-language failure, or `null` on success. */
  readonly register: (input: { id: string; absolutePath: string }) => Promise<string | null>
  /** Deregisters a folder. Resolves with a plain-language failure, or `null` on success. */
  readonly remove: (id: string) => Promise<string | null>
  /** Called after the registry changes either way, so the tree picks the new set of roots up. */
  readonly onRegistered: () => Promise<void> | void

  /**
   * Templates. Phase 8, and the second section — which is the shape this dialog was built for:
   * *"a list of sections with one entry in it rather than a folders dialog that later has to be
   * turned inside out."* It adds a section; nothing above it changes.
   */
  readonly templates: () => readonly TemplateRow[]
  /** Runs the folder picker and the name prompt. Resolves with a failure sentence, or `null`. */
  readonly addTemplate: () => Promise<string | null>
  readonly removeTemplate: (id: string) => Promise<string | null>
}

/**
 * The confirmation before a folder leaves the list.
 *
 * **No typed override, unlike the backup warning, and the asymmetry is the point.** That one guards
 * a change the app cannot undo; this one is undone by adding the folder back, and the files were
 * never at risk. Making them feel equally grave would teach a person to type through both.
 *
 * What it does carry is the sentence. In an app whose promise is that nothing is ever deleted, a
 * button named Remove has to say which kind of removal it is before it is pressed.
 */
function confirmRemoval(
  parent: HTMLElement,
  folder: RegisteredFolderRow,
): Promise<boolean> {
  return new Promise(resolve => {
    const backdrop = el('div', { className: 'modal-backdrop' })
    const dialog = el('div', {
      className: 'modal',
      attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Remove a folder' },
    })

    append(dialog, el('div', { className: 'modal-title', text: `Remove ${folder.name}?` }))
    append(dialog, el('div', {
      className: 'modal-warning',
      text: 'Nothing is deleted. The folder and every file in it stay exactly where they are — '
        + 'Soil Viewer just stops showing them. You can add it back at any time.',
    }))
    append(dialog, el('div', { className: 'modal-note', text: folder.displayPath }))

    const confirm = el('button', { className: 'modal-confirm', text: 'Remove From List' })
    const cancel = el('button', { className: 'modal-cancel', text: 'Cancel' })
    const buttons = el('div', { className: 'modal-buttons' })
    append(buttons, cancel, confirm)
    append(dialog, buttons)
    append(backdrop, dialog)
    append(parent, backdrop)

    let settled = false
    let stopListening = (): void => {}
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      backdrop.remove()
      stopListening()
      resolve(value)
    }

    confirm.addEventListener('click', () => { finish(true) })
    cancel.addEventListener('click', () => { finish(false) })
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) finish(false)
    })
    stopListening = onDocument('keydown', raw => {
      const event = raw as KeyboardEvent
      if (event.key !== 'Escape') return
      event.preventDefault()
      finish(false)
    }, { capture: true })

    setTimeout(() => { cancel.focus() }, MODAL_AUTOFOCUS_MS)
  })
}

/** Opens Settings. Resolves when it closes. */
export function openSettings(parent: HTMLElement, options: SettingsOptions): Promise<void> {
  return new Promise(resolve => {
    const backdrop = el('div', { className: 'modal-backdrop' })
    const dialog = el('div', {
      className: 'modal modal-wide',
      attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
    })

    append(dialog, el('div', { className: 'modal-title', text: 'Settings' }))

    const section = el('div', { className: 'settings-section' })
    append(section, el('div', { className: 'settings-section-title', text: 'Folders' }))
    append(section, el('div', {
      className: 'settings-section-note',
      text: 'The folders Soil Viewer can see. Everything in the Files tab lives inside one of these.',
    }))

    const rows = el('div', { className: 'settings-rows' })
    const status = el('div', { className: 'modal-note' })
    const add = el('button', { className: 'settings-add', text: 'Add Folder' })
    const close = el('button', { className: 'modal-cancel', text: 'Close' })

    append(section, rows, status, add)
    append(dialog, section)

    /**
     * **Templates.** The operator's model, in their words: name a folder-system and point it at a folder,
     * then scaffold from it wherever you like. *"That template might change… these things take
     * shape"* — so a template is a **pointer**, and what gets copied is whatever the folder holds
     * on the day you use it. There is no snapshot to keep in sync and no update step.
     */
    const templateSection = el('div', { className: 'settings-section' })
    append(templateSection, el('div', { className: 'settings-section-title', text: 'Templates' }))
    append(templateSection, el('div', {
      className: 'settings-section-note',
      text: 'Folder shapes you can scaffold from. Point one at a folder and it copies whatever '
        + 'that folder holds at the time — so improving the template improves what you make next.',
    }))
    const templateRows = el('div', { className: 'settings-rows' })
    const templateStatus = el('div', { className: 'modal-note' })
    const addTemplate = el('button', { className: 'settings-add', text: 'Add Template' })
    append(templateSection, templateRows, templateStatus, addTemplate)
    append(dialog, templateSection)

    const buttons = el('div', { className: 'modal-buttons' })
    append(buttons, close)
    append(dialog, buttons)
    append(backdrop, dialog)
    append(parent, backdrop)

    let settled = false
    let stopListening = (): void => {}
    const finish = (): void => {
      if (settled) return
      settled = true
      backdrop.remove()
      stopListening()
      resolve()
    }

    const say = (message: string, refused: boolean): void => {
      status.textContent = message
      status.setAttribute('class', refused ? 'modal-note is-refused' : 'modal-note')
    }

    const renderRows = (): void => {
      clear(rows)
      const current = options.folders()
      if (current.length === 0) {
        // §17's first-run case, reached from Settings rather than from the centered card. The card
        // is P8's; this is the same sentence in the place a person would look for it second.
        append(rows, el('div', {
          className: 'settings-empty',
          text: 'No folders yet. Add one to start.',
        }))
        return
      }
      for (const folder of current) {
        const row = el('div', { className: 'settings-row' })
        append(row, el('div', { className: 'settings-row-name', text: folder.name }))
        append(row, el('div', { className: 'settings-row-path', text: folder.displayPath }))

        const remove = el('button', {
          className: 'settings-remove',
          text: 'Remove',
          attributes: { type: 'button', 'aria-label': `Remove ${folder.name} from the list` },
        })
        remove.addEventListener('click', () => {
          void (async () => {
            if (!await confirmRemoval(parent, folder)) return
            const failure = await options.remove(folder.id)
            if (failure !== null) { say(failure, true); return }
            await options.onRegistered()
            renderRows()
            say(`${folder.name} is no longer in the list. Nothing was deleted.`, false)
          })()
        })
        append(row, remove)
        append(rows, row)
      }
    }

    const sayTemplates = (message: string, refused: boolean): void => {
      templateStatus.textContent = message
      templateStatus.setAttribute('class', refused ? 'modal-note is-refused' : 'modal-note')
    }

    const renderTemplates = (): void => {
      clear(templateRows)
      const current = options.templates()
      if (current.length === 0) {
        append(templateRows, el('div', {
          className: 'settings-empty',
          text: 'No templates yet. Point one at a folder to scaffold copies of it.',
        }))
        return
      }
      for (const template of current) {
        const row = el('div', {
          className: `settings-row${template.available ? '' : ' is-unavailable'}`,
        })
        append(row, el('div', { className: 'settings-row-name', text: template.name }))
        /**
         * **An unavailable template is shown and labelled, not hidden.** Its folder has been
         * removed from the list, so it cannot be scaffolded from — but one that silently vanishes
         * looks like data loss, and one that is offered and then fails looks like a bug. Add the
         * folder back and it works again; the id comes from the folder's own name.
         */
        append(row, el('div', {
          className: 'settings-row-path',
          text: template.available ? template.where : `${template.where} — folder not in the list`,
        }))

        const remove = el('button', {
          className: 'settings-remove',
          text: 'Remove',
          attributes: { type: 'button', 'aria-label': `Remove the ${template.name} template` },
        })
        remove.addEventListener('click', () => {
          void (async () => {
            const failure = await options.removeTemplate(template.id)
            if (failure !== null) { sayTemplates(failure, true); return }
            renderTemplates()
            // The same sentence Remove-a-folder ends on, for the same reason: in an app whose
            // promise is that nothing is deleted, a button named Remove says which kind it was.
            sayTemplates(`${template.name} is no longer a template. The folder is untouched.`, false)
          })()
        })
        append(row, remove)
        append(templateRows, row)
      }
    }

    addTemplate.addEventListener('click', () => {
      void (async () => {
        const failure = await options.addTemplate()
        // `null` covers both success and a dismissed picker — neither is worth a sentence, and the
        // list redraw is the feedback for the first.
        if (failure !== null) { sayTemplates(failure, true); return }
        renderTemplates()
      })()
    })

    add.addEventListener('click', () => {
      void (async () => {
        const chosen = await askForFolder(parent, { browse: options.browse })
        if (chosen === null) return

        /**
         * **No backup warning here any more.** §11 put one in front of this — a folder outside a
         * git repository could be registered only after a typed override — and the operator cut it on
         * 2026-08-09. It asked whether a `.git` existed above the folder and never whether anything
         * had been committed, so it gave false comfort on the tree it was meant to protect and
         * charged friction on every folder outside a repo, which they use routinely.
         *
         * Picking a folder now adds it. What protects the files is what always did: the app never
         * deletes, writes atomically, and rescues an edit into a conflict artifact rather than
         * discarding it.
         */
        // Derived against the ids in play right now, re-read rather than reused from above: the
        // picker is awaited, and the list can have changed under it.
        const id = folderIdFor(chosen, options.folders().map(folder => folder.id))
        const failure = await options.register({ id, absolutePath: chosen })
        if (failure !== null) { say(failure, true); return }

        await options.onRegistered()
        renderRows()
        say(`Added ${chosen}.`, false)
      })()
    })

    close.addEventListener('click', () => { finish() })
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) finish()
    })
    stopListening = onDocument('keydown', raw => {
      // Escape closes Settings — but only when Settings is the top layer. The picker and the
      // override dialog are children of the same parent and listen in capture too; without this
      // guard, one Escape would dismiss both and the person would lose the whole screen while
      // meaning to back out of a sub-dialog.
      if ((raw as KeyboardEvent).key !== 'Escape') return
      if (parent.querySelectorAll('.modal-backdrop').length > 1) return
      finish()
    }, { capture: true })

    renderRows()
    renderTemplates()
  })
}
