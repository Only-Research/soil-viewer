/**
 * **THE PROJECT FILTER.** P11 U2, and the control the operator asked for by name:
 *
 * > *"it could even just be a drop down with a check box next to it so I can pick which ones I want
 * > showing… I pick Holdings Group and then under it are the three projects within it and I can
 * > quickly see in the picker that those are nested."*
 *
 * Two things live here and the split is deliberate. **`nestProjects` is a pure rule** — what order
 * the rows come in and how deep each one sits — and it is exported so a test can ask it directly.
 * Everything below it is DOM.
 *
 * The rule matters more than it looks. A flat alphabetical list of forty projects is the thing
 * the operator already cannot use: *"everything is buried in 12 different folders… I have to sift through
 * each project and each sub-project."* The nesting is what turns "tick these three" from a hunt
 * into three clicks, so getting the order wrong is not cosmetic — it is the feature failing.
 */

import { comparisonKey } from '../../core/paths'
import { append, el, onDocument } from '../dom'

/** A project as the picker draws it: the summary, plus where it sits. */
export interface ProjectRow {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly name: string
  /** How many selectable ancestors it has. 0 for a top-level project. */
  readonly depth: number
}

interface Listed {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly name: string
}

/**
 * Every project, ordered so each one is followed by the projects inside it, with a depth.
 *
 * **Ordered by path, not by name.** Sorting on the displayed name interleaves an op with the
 * projects of a different parent — `alpha`, `op-of-beta`, `beta` — and the indent then describes a
 * nesting the order contradicts, which is worse than no indent at all. Path order puts a parent
 * immediately before its children by construction.
 *
 * **Depth counts selectable ancestors, not path segments.** A project at
 * `02-projects/alpha/02-work/projects/op-one` is five segments deep and one *project* deep, and it
 * is the second number a reader is looking at. Deriving it from the path length would indent ops
 * four levels for reasons nobody can see.
 */
export function nestProjects(projects: readonly Listed[]): ProjectRow[] {
  const ordered = [...projects].sort((a, b) => {
    if (a.rootId !== b.rootId) return a.rootId < b.rootId ? -1 : 1
    // Case folding is not knowable per-root here, and this is display order rather than identity —
    // `comparisonKey` is used for its segment-wise joining, and the folding is the safe one.
    const left = comparisonKey(a.segments, true)
    const right = comparisonKey(b.segments, true)
    return left < right ? -1 : left > right ? 1 : 0
  })

  return ordered.map(project => ({
    rootId: project.rootId,
    segments: project.segments,
    name: project.name,
    depth: ordered.filter(other =>
      other !== project
      && other.rootId === project.rootId
      && other.segments.length < project.segments.length
      // Segment-wise, never a string prefix: `alpha-two` is not inside `alpha`. Spec §5, and the
      // same rule `laneForCard` had to learn after a sweep.
      && other.segments.every((segment, at) => project.segments[at] === segment),
    ).length,
  }))
}

/**
 * A project's key in a selection. One spelling, so a tick and an untick cannot disagree.
 *
 * **Encoded rather than joined with a separator**, and the NUL gate is why. The first version used
 * a delimiter and the byte that actually reached the file was a literal NUL — caught by the
 * reachability suite's rule against control characters in source, which exists because record item
 * 46 recorded that class costing a review twenty minutes.
 *
 * The wider lesson is the one worth keeping: **every separator is a collision waiting for the right
 * input.** A space appears in folder names, a slash is already the segment joiner, and a control
 * character is both invisible and lint-banned here. Encoding the pair removes the question instead
 * of answering it, and the result is greppable, which a control character is not.
 */
export function selectionKey(rootId: string, segments: readonly string[]): string {
  return JSON.stringify([rootId, [...segments]])
}

export interface ProjectFilterOptions {
  readonly projects: readonly Listed[]
  /** The keys currently ticked. **Empty means every project**, which is the board's default. */
  readonly selected: ReadonlySet<string>
  readonly onChange: (selected: ReadonlySet<string>) => void
}

/**
 * The summary shown on the closed control.
 *
 * **"All projects" when nothing is ticked**, because that is what the board is showing — not
 * "none". The empty selection is the default and it means everything; a control reading "0
 * selected" over a full board would be the screen disagreeing with itself, which is the condition
 * this whole build is organised against.
 */
export function filterSummary(selected: ReadonlySet<string>, total: number): string {
  if (selected.size === 0) return 'All projects'
  if (selected.size === total) return 'All projects'
  return selected.size === 1 ? '1 project' : `${selected.size} projects`
}

/**
 * **Dismissal, held across redraws.** One listener at a time, because this module is remounted on
 * every tick and a listener per mount would accumulate sixty-six deep in a session of filtering.
 *
 * Module scope rather than per-call state: the control is a singleton on the board, and the remover
 * has to outlive the `mountProjectFilter` call that created it.
 */
let stopDismissal: (() => void) | null = null

/**
 * Mounts the picker into `host`, replacing whatever was there.
 *
 * A `details`/`summary` disclosure rather than a hand-built popover: it opens and closes with no
 * script and no state of its own, and it survives the CSP that forbids both. The same reasoning the
 * markdown renderer's properties block is built on.
 *
 * ## Why it now closes on an outside click, which a bare `details` does not
 *
 * **A `details` stays open until its own summary is clicked again**, and that was survivable while
 * the list was in flow: opening it *pushed* the board down, so the board was still reachable. Once
 * the list became a real popover (2026-08-15, so that sixty-six projects could be scrolled) it
 * **covers** the board instead — and a control that covers the thing it filters, and can only be
 * dismissed by hitting one small summary again, is worse than the clump it replaced.
 *
 * **The e2e suite found this, not a person.** Twenty-two tests across `back-control`,
 * `card-panel`, `change-status` and `files-tab` went red together, every one of them a 30-second
 * timeout on `.board-card` resolving but never becoming *"visible, enabled and stable"* — which is
 * Playwright's way of saying the element is underneath something. They were right, and the fix
 * belonged here rather than in them.
 *
 * **Escape is deliberately NOT bound.** Four layers in this app already listen for Escape in the
 * capture phase and hand off between themselves (`card-panel.ts` documents the chain and refuses
 * the key while a modal is above it). Adding a fifth without working through that handoff is how
 * one press closes two things, and this control does not need it to be dismissible.
 */
export function mountProjectFilter(host: HTMLElement, options: ProjectFilterOptions): void {
  /**
   * **Whether it was open, read BEFORE the teardown.** Every tick redraws this control, and a
   * disclosure that closes on each tick makes multi-select unusable — you would reopen the list to
   * choose each project, which is the opposite of the thing the operator asked for: *"a drop down with a
   * check box next to it so I can pick which ones I want showing."*
   *
   * Found by a browser test timing out on an invisible checkbox, not by reading this function. The
   * same shape as the board's own focus restoration, which reads the caret's lane before `clear`
   * for the identical reason: after the teardown the element is gone and the answer is always no.
   */
  const wasOpen = host.querySelector('.project-filter')?.hasAttribute('open') === true

  host.replaceChildren()

  const rows = nestProjects(options.projects)
  /**
   * Cast because `el` returns `HTMLElement` and the dismissal below sets `open` — the same
   * narrowing `wasOpen` already does when it reads the attribute off the outgoing control.
   */
  const box = el('details', {
    className: 'project-filter',
    ...(wasOpen ? { attributes: { open: '' } } : {}),
  }) as HTMLDetailsElement
  const label = el('summary', {
    className: 'project-filter-summary',
    text: filterSummary(options.selected, rows.length),
  })
  append(box, label)

  const list = el('div', { className: 'project-filter-list' })

  for (const row of rows) {
    const key = selectionKey(row.rootId, row.segments)
    const item = el('label', {
      className: 'project-filter-row',
      // Indent by project depth, not path depth. Inline because the value is per-row data rather
      // than a style: a class per depth would cap the nesting at however many classes exist.
      attributes: { style: `padding-inline-start: ${(row.depth * 0.9 + 0.6).toFixed(2)}rem` },
    })
    const tick = el('input', {
      className: 'project-filter-tick',
      attributes: { type: 'checkbox', 'data-project': key },
    }) as HTMLInputElement
    tick.checked = options.selected.has(key)
    tick.addEventListener('change', () => {
      const next = new Set(options.selected)
      if (tick.checked) next.add(key)
      else next.delete(key)
      options.onChange(next)
    })
    append(item, tick, el('span', { className: 'project-filter-name', text: row.name }))
    append(list, item)
  }

  /**
   * **Clear filters, shown only when there is something to clear.** A permanently visible Clear on
   * a board already showing everything is a control that does nothing, and this build has a ledger
   * of those.
   */
  if (options.selected.size > 0) {
    const clear = el('button', {
      className: 'project-filter-clear',
      text: 'Clear filters',
      attributes: { type: 'button' },
    })
    clear.addEventListener('click', () => { options.onChange(new Set()) })
    append(list, clear)
  }

  append(box, list)
  append(host, box)

  /**
   * **Replaced, never added to.** The previous mount's listener is removed first, so filtering
   * twenty times leaves one listener rather than twenty — the leak `P9F-6` already has a browser
   * test for on the board itself.
   */
  stopDismissal?.()
  stopDismissal = onDocument('click', event => {
    if (!box.open) return
    const target = event.target
    const element = target instanceof Element
      ? target
      : target instanceof Node ? target.parentElement : null

    /**
     * **`closest`, NOT `box.contains` — and the difference is the whole bug.**
     *
     * Anything inside the control is exempt, including the summary: the click that *opens* this
     * bubbles to the document too, so without an exemption the popover would close itself in the
     * same gesture that opened it.
     *
     * The obvious spelling is `box.contains(target)`, and it was the first one here. **It closes the
     * popover when you press Clear filters.** Clear calls `onChange`, which remounts this control
     * *while that click is still propagating* — so by the time the document sees it, `box` is the
     * NEW details element and the target is a button belonging to the old, detached one.
     * `contains` says false, correctly, and the popover shuts on a control that lives inside it.
     *
     * `closest` asks a different question — *did this click originate inside a project filter* —
     * and a detached subtree still answers it, because the old button is still a child of the old
     * `details`. The question that survives the remount is the right question.
     *
     * Found by a test written specifically because this ordering is subtle: a checkbox's `change`
     * fires during the click's activation behaviour, which is not something to settle by reading.
     */
    if (element?.closest('.project-filter') !== null && element !== null) return
    box.open = false
  })
}
