/**
 * The two-pane conflict surface. Spec §13.5, and item E — carried since P4.
 *
 * **Everything behind this has existed and been proven for three phases.** `writeConflictArtifact`,
 * `resolveConflict`, the exclusive rename, the app-private archive, the read-back-and-hash before
 * anything is unlinked — all built, all mutation-swept. What did not exist was a screen, so a
 * conflict could be *created* and never *resolved*: the rescue file landed beside the document and
 * sat there.
 *
 * §13.5, on why this is a v1 requirement rather than a later nicety:
 *
 *   *"Resolution is a v1 requirement, not a later nicety: two-pane mine/theirs with Keep Mine /
 *   Keep Theirs / Keep Both, ending with one file at the canonical path and the loser moved to
 *   app-private archive."*
 *
 * ## The three rules this screen exists to honour
 *
 * **A data-safety event never uses a fading toast.** §13.5 names v1's version as one of six ways it
 * lost an edit: *"announced by a 2.5-second auto-dismissing toast, which on a phone in a pocket is
 * invisible."* The banner that opens this is persistent and dismiss-required.
 *
 * **An edit is never discarded because its rescue failed.** If the artifact could not be written,
 * there is nothing for this screen to open — the editor holds the only copy and must stay in a
 * blocking unsaved state. That case is `conflict-unrescued`, and it deliberately does not reach
 * here.
 *
 * **Nothing is deleted.** Keep Mine and Keep Theirs both end with the losing side **in the app's
 * archive**, copied, fsynced, read back and hash-verified before the original is unlinked. The operator:
 * *"nothing gets deleted, no files get deleted, I move them, they get archived."* That is what
 * `resolveConflict` does, and this screen is only the question.
 */

import { append, clear, el } from '../dom'

export type ConflictChoice = 'mine' | 'theirs' | 'both'

export interface ConflictPanes {
  /** The canonical file's current bytes, as text. What is on disk now. */
  readonly theirs: string
  /** The rescued edit — what was being typed when the save was refused. */
  readonly mine: string
  readonly canonicalName: string
  readonly artifactName: string
}

export interface ConflictViewOptions {
  readonly panes: ConflictPanes
  readonly onChoose: (choice: ConflictChoice) => void
  readonly onDismiss: () => void
}

/**
 * The first line at which the two versions differ, or `null` when they are identical.
 *
 * Shown so the person is not asked to diff two documents by eye. Deliberately **not** a full diff:
 * a diff view is a feature with its own scope, and the question here is "which of these two do you
 * want", not "what exactly changed".
 */
export function firstDifferingLine(mine: string, theirs: string): number | null {
  const a = mine.split('\n')
  const b = theirs.split('\n')
  const limit = Math.max(a.length, b.length)
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) return index + 1
  }
  return null
}

/** Builds the surface. The caller mounts it; this owns nothing. */
export function buildConflictView(options: ConflictViewOptions): HTMLElement {
  const surface = el('div', {
    className: 'conflict',
    attributes: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Resolve a conflict' },
  })

  const header = el('div', { className: 'conflict-header' })
  append(header, el('div', {
    className: 'conflict-title',
    text: `${options.panes.canonicalName} changed while you were editing it`,
  }))

  const differing = firstDifferingLine(options.panes.mine, options.panes.theirs)
  append(header, el('div', {
    className: 'conflict-note',
    text: differing === null
      // Worth saying rather than hiding: §13.4 warns that an agent rewriting identical bytes is the
      // COMMON case on this tree, and a person told "they differ" when they do not stops believing
      // the next one.
      ? 'The two versions are identical. Keeping either is safe.'
      : `They first differ at line ${differing}. Your edit was saved beside it as ${options.panes.artifactName}.`,
  }))
  append(surface, header)

  const panes = el('div', { className: 'conflict-panes' })
  for (const side of [
    { label: 'Yours (the edit that was rescued)', text: options.panes.mine, className: 'is-mine' },
    { label: 'On disk now', text: options.panes.theirs, className: 'is-theirs' },
  ]) {
    const pane = el('div', { className: `conflict-pane ${side.className}` })
    append(pane, el('div', { className: 'conflict-pane-label', text: side.label }))
    // `textContent`, never markup: this is file content, and on this tree it was written by agents.
    append(pane, el('pre', { className: 'conflict-text', text: side.text }))
    append(panes, pane)
  }
  append(surface, panes)

  const actions = el('div', { className: 'conflict-actions' })
  for (const choice of [
    { id: 'mine' as const, label: 'Keep yours' },
    { id: 'theirs' as const, label: 'Keep what is on disk' },
    { id: 'both' as const, label: 'Keep both' },
  ]) {
    const button = el('button', { className: 'conflict-choice', text: choice.label })
    button.addEventListener('click', () => { options.onChoose(choice.id) })
    append(actions, button)
  }

  /**
   * **"Decide later" is a real option and it is not the same as dismissing a warning.**
   *
   * §13.5 puts unresolved conflicts on a persistent "Needs attention" list precisely because the
   * answer is sometimes "not now". What must never happen is the question disappearing on its own —
   * so this closes the pane and the banner stays.
   */
  const later = el('button', { className: 'conflict-later', text: 'Decide later' })
  later.addEventListener('click', () => { options.onDismiss() })
  append(actions, later)

  append(surface, actions)
  return surface
}

/** Replaces a container's contents with the surface. Kept here so callers never touch markup. */
export function mountConflictView(host: HTMLElement, options: ConflictViewOptions): void {
  clear(host)
  append(host, buildConflictView(options))
}
