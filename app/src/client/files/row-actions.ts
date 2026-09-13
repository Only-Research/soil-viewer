/**
 * What the "⋯" menu offers on a row, and the rule that keeps two of them from racing.
 *
 * Pure. No DOM, no requests — `actionsFor` answers what a row may do, and `createMutationGuard`
 * enforces §13.8's *"the client disables the row or card while one is in flight."*
 *
 * PRD, the Files tab: *"Row actions ('⋯' — always visible on touch): Add File, Add Folder, Rename,
 * Duplicate, Copy Path, **Move** — and Move is an *intentional* flow only: menu action → pick the
 * destination folder → confirm. **There is no drag-and-drop anywhere on the Files tab** (the operator:
 * accidental drags are a nightmare; moving a file must be deliberate)."*
 *
 * **Reveal in Finder and Open in Default App are absent, and neither is an oversight.** Open in
 * Default App was **cut from v1** on the ruling (spec §10, §21). Reveal in Finder survives and
 * is scheduled for P12 with the rest of the shell actions.
 *
 * **P12 arrived: Reveal is in `actionsFor` below, desktop only.** This paragraph described it as
 * still to come for weeks while the function underneath already returned it — a file's own header
 * contradicting its own code, which is the defect class this codebase names as its worst.
 */

import type { WireEntry } from '../../contract/wire'

/**
 * Every action the menu can offer. A closed set — the menu cannot invent one.
 *
 * **Still closed after Phase 8, and the template member is why the shape is a template literal
 * rather than `string`.** A scaffold action carries which template it is, and the id is where that
 * has to live: the menu hands one string back. Typed as `` `template:${string}` `` the set stays
 * closed in the way that matters — every id is either one of the six verbs or a scaffold, and a
 * bare string is still a compile error, so no caller can slip an unrecognised action through the
 * menu. The dynamic half comes from the registry the server persists, not from the menu.
 */
export type ActionId =
  | 'new-file'
  | 'new-folder'
  | 'rename'
  | 'duplicate'
  | 'copy-path'
  | 'move'
  | 'reveal'
  | `template:${string}`

export interface RowAction {
  readonly id: ActionId
  /** What the menu item says. Sentence case, no ellipsis except where a dialog follows. */
  readonly label: string
  /** True when this action changes the disk, so the row must be disabled while it runs. */
  readonly mutating: boolean
}

/**
 * The actions for one row.
 *
 * **Add File and Add Folder appear on a FOLDER only**, and that is the PRD's creation-is-placement
 * idea rather than a limitation: a new thing is born where you were standing. Offering them on a
 * file would mean inventing a rule about whether "here" means the file's folder or the file itself.
 *
 * Everything else applies to both. A folder can be renamed, duplicated, moved and have its path
 * copied exactly as a file can, and §13.7's recursive-copy engine is what makes Duplicate work on
 * one.
 */
/** The prefix that makes a menu id a scaffold. `template:op` scaffolds the template with id `op`. */
export const TEMPLATE_ACTION_PREFIX = 'template:'

/** The template id inside a menu action id, or `null` when it is an ordinary action. */
export function templateIdOf(actionId: string): string | null {
  return actionId.startsWith(TEMPLATE_ACTION_PREFIX)
    ? actionId.slice(TEMPLATE_ACTION_PREFIX.length)
    : null
}

/** What a template looks like to this module: enough to draw a menu item and refuse a dead one. */
export interface TemplateChoice {
  readonly id: string
  readonly name: string
  /** The registered folder it lives in. A row in a different one is not offered it — see below. */
  readonly rootId: string
  /** False when its folder is no longer registered. Not offered — see below. */
  readonly available: boolean
}

/**
 * Where the menu is being drawn. **Required, never defaulted** — §18.8.
 *
 * **This is a UI decision, not the enforcement of a boundary, and the wording matters.**
 * Ruled 2026-08-16, correcting the paragraph that used to sit here: it called this *"the only thing
 * keeping it off the phone"*, which describes a security control. It is not one, and there is none
 * to describe. `file.reveal` is `carriedBy: 'both'` with `auth: 'token'`, so anything holding a
 * session token can call it directly — which P12 accepted, because Reveal grants strictly less than
 * a tailnet caller already has: it cannot read, write or move a file, only make a Finder window
 * appear.
 *
 * Calling a menu omission "the whole control" is precisely the vocabulary that gets a runtime
 * listener check restored later — the §21 hazard, arriving through the sentence written to prevent
 * it. §21:802 is explicit: *"Desktop-only is now a UI decision (§18.8), not a router one."*
 *
 * What §18.8 actually asks is that Reveal *"must not render as a dead control"* — an interface rule
 * about not offering an action that cannot work. Required rather than defaulted because a default
 * lets a call site forget, which is how a dead control ships.
 *
 * **`desktop` is a WIDTH, and the operator ruled that acceptable on 2026-08-16.** It resolves to
 * `(min-width: 768px)`, so a phone in landscape counts as desktop and the item returns. The security review raised
 * it as a ruling of the operator's that was not being delivered. The operator's answer: *"if it turns sideways
 * and that makes a desktop mode and the button needs to be there, it's fine. Just, obviously, you're
 * not on the computer, so that's not gonna do anything for you."* Ruled and closed — the residual is
 * a control that does nothing when tapped from a phone, which they have accepted knowingly.
 */
export interface RowContext {
  readonly desktop: boolean
}

export function actionsFor(
  entry: WireEntry,
  templates: readonly TemplateChoice[],
  /**
   * **Genuinely required as of 2026-08-16 — it used to default to `{ desktop: true }`.**
   *
   * The comment on `RowContext` above has always said *"Required, never defaulted… a default would
   * let a call site forget, which is how a dead control ships."* The signature defaulted it, and to
   * the permissive value: a forgetful call site did not get a compile error, it got Reveal in
   * Finder on the phone.
   *
   * ruled 2026-08-16: *"phone shouldn't be able to reach view in finder."*
   *
   * The fix is the type, not a runtime check. §7 forbids a listener test in the server and §21
   * records why — so the compiler is the enforcement, and `templates` loses its default with it
   * because an optional parameter cannot sit in front of a required one.
   */
  context: RowContext,
): readonly RowAction[] {
  const isFolder = entry.kind === 'directory'

  /**
   * **One item per template, named for the template.** Phase 8, and it is the operator's own
   * description of the flow: *"when I say I want to create a new op somewhere… and then when I
   * click it, it knows to make a copy of that folder path and everything underneath it."* A single
   * "New from template…" that then asks which one puts a dialog in front of the thing they described
   * as one click.
   *
   * **Folders only**, because a template is scaffolded *into* somewhere and a file is not a place.
   *
   * **An unavailable template is not offered at all** — its folder has been removed from the list,
   * so choosing it could only ever refuse. It is still shown in Settings, labelled, because there
   * a person can act on it; here it would be a trap, which is the same reasoning that keeps the
   * move picker from offering a folder's own subtree.
   *
   * **And neither is a template from a DIFFERENT registered folder** — the security review's C1 on Phase 8.
   * `entry.copy` takes one `rootId`; the scaffold was passing the template's while composing the
   * destination from the row's, so with two folders registered a template from one, used while
   * standing in the other, wrote the tree into the wrong folder and reported success. Nothing was
   * overwritten — the pre-flight and the exclusive rename both held — but the person was left
   * looking at a folder that appeared not to have changed.
   *
   * Refused here rather than made to work: a cross-root copy means changing an engine that has
   * been mutation-swept since P4, for a case the operator does not have. The decision was recorded
   * before the phase was built and this is where it is enforced.
   */
  const scaffolds: readonly RowAction[] = isFolder
    ? templates
      .filter(template => template.available && template.rootId === entry.rootId)
      .map(template => ({
        id: `${TEMPLATE_ACTION_PREFIX}${template.id}`,
        label: `New ${template.name}`,
        mutating: true,
      }))
    : []

  const creation: readonly RowAction[] = isFolder
    ? [
        { id: 'new-file', label: 'New file', mutating: true },
        { id: 'new-folder', label: 'New folder', mutating: true },
      ]
    : []

  return [
    ...scaffolds,
    ...creation,
    { id: 'rename', label: 'Rename…', mutating: true },
    { id: 'duplicate', label: 'Duplicate', mutating: true },
    { id: 'move', label: 'Move…', mutating: true },
    // Not mutating: it reads nothing from disk and writes nothing. It must stay available while a
    // rename is in flight, because it is how a person hands the path to an agent.
    { id: 'copy-path', label: 'Copy path', mutating: false },
    /**
     * **Reveal in Finder — desktop only, and absent rather than disabled.** §10, §18.8.
     *
     * the ruling of 2026-08-09 is what makes it load-bearing rather than a convenience: the
     * non-editing pane offers no download and simply says it cannot display the file, *"for non
     * compliant file types, wherever the reveal and finder option lives is the users path."* Without
     * it a PDF or a video is a dead end.
     *
     * **Offered on folders too.** Revealing a folder shows it in its parent, which is the same
     * question — *where is this?* — asked about a different kind of thing.
     *
     * **Not mutating.** It changes nothing on disk, so it stays available while a rename is in
     * flight, for the same reason Copy path does.
     */
    ...(context.desktop
      ? [{ id: 'reveal' as const, label: 'Reveal in Finder', mutating: false }]
      : []),
  ]
}

/**
 * §13.8: *"Mutations are serialized per target path server-side. The client disables the row or
 * card while one is in flight."*
 *
 * The server's serialization is the control; this is the half that stops the *user* generating the
 * race in the first place. §13.8 names what it prevents: *"double-tap Duplicate creates two files
 * that each found the name free."* The exclusive create refuses the second one — so without this
 * the person sees an error for doing something reasonable twice, which reads as the app being
 * broken rather than as being protected.
 *
 * **Keyed on the row, not on a global flag.** Renaming one file while another copies is fine and
 * must stay fine; a single in-flight boolean would make the whole tree modal during a long copy of
 * a large project.
 */
export interface MutationGuard {
  /** True while a mutation aimed at this row is running. */
  readonly isBusy: (key: string) => boolean
  /**
   * Runs `work` with the row marked busy, and releases it however that ends.
   *
   * Returns `null` **without running anything** when the row is already busy — the caller renders
   * a disabled row, so reaching this is a race between the render and the click rather than an
   * ordinary path, and the honest answer is to do nothing rather than to queue a second mutation.
   */
  readonly run: <T>(key: string, work: () => Promise<T>) => Promise<T | null>
  /** Told whenever the busy set changes, so the view can redraw. */
  readonly subscribe: (listener: () => void) => () => void
}

export function createMutationGuard(): MutationGuard {
  const busy = new Set<string>()
  const listeners = new Set<() => void>()
  const announce = (): void => { for (const listener of listeners) listener() }

  return {
    isBusy: key => busy.has(key),

    run: async (key, work) => {
      if (busy.has(key)) return null
      busy.add(key)
      announce()
      try {
        return await work()
      } finally {
        /**
         * `finally`, so a throw releases the row.
         *
         * Without it a failed rename leaves the row disabled forever, and the only way out is a
         * reload — which is the shape of bug that makes a person distrust every other refusal the
         * app gives them.
         */
        busy.delete(key)
        announce()
      }
    },

    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
