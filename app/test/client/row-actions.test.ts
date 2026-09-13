import { describe, expect, it } from 'vitest'

import { actionsFor, createMutationGuard, templateIdOf } from '../../src/client/files/row-actions'
import type { WireEntry } from '../../src/contract/wire'

const entry = (name: string, overrides: Partial<WireEntry> = {}): WireEntry => ({
  rootId: 'soil',
  segments: [name],
  name,
  kind: 'file',
  title: name,
  size: 1,
  modifiedMs: 0,
  isMarkdown: name.endsWith('.md'),
  contentUnavailable: false,
  token: 'tok',
  ...overrides,
})
const folder = (name: string): WireEntry => entry(name, { kind: 'directory', isMarkdown: false })

/**
 * **Stated in every call, because the parameter stopped defaulting on 2026-08-16.**
 *
 * It used to default to `{ desktop: true }` — the permissive value — while `RowContext`'s own
 * comment said *"Required, never defaulted… a default would let a call site forget, which is how a
 * dead control ships."* the operator ruled that the phone must not reach Reveal in Finder, and §7 forbids
 * enforcing that with a listener check in the server, so the type is the enforcement.
 *
 * The cases below that care about the width pass their own context inline; these are the ones that
 * do not, and they say so rather than inheriting an answer.
 */
const DESKTOP = { desktop: true } as const

const idsFor = (target: WireEntry): string[] => actionsFor(target, [], DESKTOP).map(action => action.id)

describe('what the menu offers', () => {
  it('offers creation on a FOLDER — a new thing is born where you are standing', () => {
    expect(idsFor(folder('02-projects'))).toEqual([
      'new-file', 'new-folder', 'rename', 'duplicate', 'move', 'copy-path', 'reveal',
    ])
  })

  it('does not offer creation on a file', () => {
    // Offering it would mean inventing a rule about whether "here" means the file or its folder.
    expect(idsFor(entry('notes.md')))
      .toEqual(['rename', 'duplicate', 'move', 'copy-path', 'reveal'])
  })

  it('offers rename, duplicate and move on a folder as well as a file', () => {
    for (const id of ['rename', 'duplicate', 'move']) {
      expect(idsFor(folder('a')), id).toContain(id)
      expect(idsFor(entry('a.md')), id).toContain(id)
    }
  })

  /**
   * **§10 has exactly ONE action, and Open in Default App is not coming back.**
   *
   * This used to read *"offers NO shell actions yet — Open in Default App is cut, Reveal is P12"*,
   * and it was right on both counts until 2026-08-14, when Reveal landed. What has not changed is
   * the half that matters: Open in Default App was **CUT, not deferred** (§10, §21), and it is the
   * verb that hands a file to another application to act on. Reveal only shows you where something
   * is.
   *
   * **The two are two characters apart in the implementation** — `open -R` reveals, `open` opens —
   * so the cut one comes back through a missing flag rather than through a decision. `reveal.ts`
   * pins the flag; this pins the menu.
   */
  it('offers exactly one shell action — Reveal — and never Open in Default App', () => {
    const ids = [...idsFor(folder('a')), ...idsFor(entry('a.md'))]
    expect(ids.filter(id => id === 'reveal')).toHaveLength(2)
    expect(ids).not.toContain('open-in-default-app')
  })

  it('offers NO delete, on any row, ever', () => {
    // the operator: "There needs to be zero remove features anywhere in this app."
    const labels = [...actionsFor(folder('a'), [], DESKTOP), ...actionsFor(entry('a.md'), [], DESKTOP)]
      .map(action => `${action.id} ${action.label}`.toLowerCase())
    for (const word of ['delete', 'remove', 'trash', 'destroy']) {
      expect(labels.join(' '), word).not.toContain(word)
    }
  })

  it('marks the two read-only actions non-mutating and everything else as mutating', () => {
    // Copy path and Reveal both change nothing on disk, so neither may be hidden while a rename is
    // in flight — §13.8 disables a row for *mutations*, and hiding the way out of a stuck row would
    // be the opposite of what that rule is for.
    const actions = actionsFor(folder('a'), [], DESKTOP)
    expect(actions.filter(a => !a.mutating).map(a => a.id)).toEqual(['copy-path', 'reveal'])
  })
})

/**
 * §13.8: *"Mutations are serialized per target path server-side. The client disables the row or
 * card while one is in flight."* The server's lock is the control; this stops the person generating
 * the race, so a reasonable double-tap does not surface as an error.
 */
describe('one mutation per row at a time', () => {
  it('runs the work and reports the row busy while it does', async () => {
    const guard = createMutationGuard()
    let sawBusy = false
    const outcome = await guard.run('row-a', async () => {
      sawBusy = guard.isBusy('row-a')
      return 'done'
    })
    expect(outcome).toBe('done')
    expect(sawBusy).toBe(true)
    expect(guard.isBusy('row-a'), 'released afterwards').toBe(false)
  })

  it('REFUSES a second mutation on the same row, and does not run it', async () => {
    const guard = createMutationGuard()
    let ran = 0
    let release = (): void => {}
    const first = guard.run('row-a', async () => {
      await new Promise<void>(resolve => { release = resolve })
      ran += 1
    })
    const second = await guard.run('row-a', async () => { ran += 1 })

    expect(second, 'the second call does nothing at all').toBeNull()
    release()
    await first
    expect(ran, 'only the first ever ran').toBe(1)
  })

  it('allows two mutations on DIFFERENT rows at once', async () => {
    // Renaming one file while another copies must stay possible: a single global flag would make
    // the whole tree modal during a long copy of a large project.
    const guard = createMutationGuard()
    let release = (): void => {}
    const slow = guard.run('row-a', () => new Promise<void>(resolve => { release = resolve }))

    expect(await guard.run('row-b', async () => 'fine')).toBe('fine')

    /**
     * **And the OTHER row must not read as busy**, which is the half a sweep caught missing.
     *
     * `run` was already per-key, so a mutation that made only `isBusy` global still let both
     * mutations through and every assertion above passed. But `isBusy` is what the view uses to
     * disable rows — so the whole tree would have greyed out during a long copy while continuing
     * to work, which is a worse bug than refusing: it looks broken and is not.
     */
    expect(guard.isBusy('row-a'), 'the busy row').toBe(true)
    expect(guard.isBusy('row-b'), 'every other row stays usable').toBe(false)
    expect(guard.isBusy('row-c')).toBe(false)

    release()
    await slow
  })

  /**
   * Without the `finally`, a failed rename leaves the row disabled until a reload — the shape of
   * bug that makes a person distrust every other refusal the app gives.
   */
  it('RELEASES the row when the work throws', async () => {
    const guard = createMutationGuard()
    await expect(guard.run('row-a', async () => { throw new Error('nope') })).rejects.toThrow()
    expect(guard.isBusy('row-a')).toBe(false)
  })

  it('announces on the way in and on the way out, so the row can redraw', async () => {
    const guard = createMutationGuard()
    const seen: boolean[] = []
    guard.subscribe(() => { seen.push(guard.isBusy('row-a')) })
    await guard.run('row-a', async () => undefined)
    expect(seen).toEqual([true, false])
  })

  it('does not announce for a refused second call', async () => {
    const guard = createMutationGuard()
    let release = (): void => {}
    const first = guard.run('row-a', () => new Promise<void>(resolve => { release = resolve }))
    const seen: number[] = []
    guard.subscribe(() => { seen.push(1) })
    await guard.run('row-a', async () => undefined)
    expect(seen, 'nothing changed, so nothing is announced').toEqual([])
    release()
    await first
  })

  it('stops announcing once unsubscribed', async () => {
    const guard = createMutationGuard()
    let count = 0
    const stop = guard.subscribe(() => { count += 1 })
    await guard.run('a', async () => undefined)
    const before = count
    stop()
    await guard.run('a', async () => undefined)
    expect(count).toBe(before)
  })
})

/**
 * **TEMPLATE ACTIONS ON A ROW.** Phase 8.
 *
 * the operator's flow is one click: *"when I say I want to create a new op somewhere… and then when I
 * click it, it knows."* So the menu carries an item per template rather than a "New from template…"
 * that opens a chooser — the chooser would be a dialog in front of the thing they described as a
 * click.
 *
 * These are here rather than in the e2e suite because the e2e suite **cannot** reach the third one:
 * making a template unavailable means deregistering the folder it lives in, which is the folder the
 * whole browser test is running inside. The mutation sweep found that gap by flipping the filter to
 * always-true and watching all six browser tests stay green.
 */
describe('templates in the row menu', () => {
  const folder = { kind: 'directory', rootId: 'soil' } as WireEntry
  const file = { kind: 'file', rootId: 'soil' } as WireEntry
  const op = { id: 'op', name: 'Op', rootId: 'soil', available: true }

  it('offers one item per template, named for it', () => {
    const rt = { id: 'rt', name: 'Round Table', rootId: 'soil', available: true }
    const ids = actionsFor(folder, [op, rt], DESKTOP)
    expect(ids.map(action => action.label)).toEqual(
      expect.arrayContaining(['New Op', 'New Round Table']),
    )
  })

  /** A template is scaffolded INTO somewhere, and a file is not a place. */
  it('offers none on a file', () => {
    expect(actionsFor(file, [op], DESKTOP).some(action => action.id.startsWith('template:'))).toBe(false)
  })

  /**
   * **THE ONE THE BROWSER CANNOT TEST.** Its folder has been removed from the list, so choosing it
   * could only ever refuse. Settings still shows it, labelled, because there a person can act on
   * it; in a menu it would be a trap — the same reasoning that stops the move picker offering a
   * folder's own subtree.
   */
  it('does not offer a template whose folder is no longer registered', () => {
    const gone = { id: 'gone', name: 'Gone', rootId: 'soil', available: false }
    const actions = actionsFor(folder, [op, gone], DESKTOP)
    expect(actions.map(action => action.label)).toContain('New Op')
    expect(actions.map(action => action.label)).not.toContain('New Gone')
  })

  /**
   * **THE SECURITY REVIEW'S C1, PHASE 8.** A template belonging to another registered folder must not be offered.
   *
   * `entry.copy` takes ONE `rootId`, and the scaffold passed the **template's** while composing the
   * destination path from the **row's** — so with two folders registered, using a template from one
   * while standing in the other wrote the whole tree into the wrong folder and reported success.
   * Nothing was overwritten and nothing deleted (the pre-flight and the exclusive rename both
   * held), but the person was left looking at a folder that appeared not to have changed.
   *
   * No test could see it: every template fixture in the build registered exactly **one** root. That
   * is the same structural blindness this file caught one test above with the availability filter,
   * repeating inside the same phase.
   */
  it('does not offer a template belonging to a different registered folder', () => {
    const elsewhere = { id: 'other-op', name: 'Other Op', rootId: 'archive', available: true }
    const actions = actionsFor(folder, [op, elsewhere], DESKTOP)
    expect(actions.map(action => action.label)).toContain('New Op')
    expect(actions.map(action => action.label)).not.toContain('New Other Op')
  })

  it('is a scaffold action the caller can recognise, and nothing else is', () => {
    expect(templateIdOf('template:op')).toBe('op')
    expect(templateIdOf('rename')).toBeNull()
    expect(templateIdOf('duplicate')).toBeNull()
  })

  /** The ordinary verbs are untouched by any of this. */
  it('leaves the six verbs in place', () => {
    const ids = actionsFor(folder, [op], DESKTOP).map(action => action.id)
    expect(ids).toEqual(expect.arrayContaining(
      ['new-file', 'new-folder', 'rename', 'duplicate', 'move', 'copy-path'],
    ))
  })
})

describe('Reveal in Finder is offered on the desktop and absent on a phone', () => {
  /**
   * **§18.8: it "must not render as a dead control".** Absent, never disabled.
   *
   * This is the *only* thing keeping Reveal off the phone. The route is carried on both listeners —
   * the ruling of 2026-08-14, after `local-only` turned out to be unreachable by any
   * interface — so if this gate goes, the phone gets a menu item that opens a Finder window on a
   * Mac nobody is looking at. The server cannot catch that: §7 decides privilege by which listener
   * carries a route and forbids a runtime check.
   */
  const ids = (target: WireEntry, desktop: boolean): string[] =>
    actionsFor(target, [], { desktop }).map(a => a.id)

  it('is offered on a file on the desktop', () => {
    expect(ids(entry('note.md'), true)).toContain('reveal')
  })

  it('is offered on a folder too — the same question about a different kind of thing', () => {
    expect(ids(folder('notes'), true)).toContain('reveal')
  })

  it('is ABSENT on a phone, not merely disabled', () => {
    expect(ids(entry('note.md'), false)).not.toContain('reveal')
    expect(ids(folder('notes'), false)).not.toContain('reveal')
  })

  it('takes nothing else with it when it goes', () => {
    // The failure this guards: a gate that removes the whole tail of the list rather than one item.
    const phone = ids(entry('note.md'), false)
    for (const kept of ['rename', 'duplicate', 'move', 'copy-path']) {
      expect(phone, `${kept} disappeared along with reveal`).toContain(kept)
    }
  })

  it('does not change the disk, so a rename in flight must not hide it', () => {
    const reveal = actionsFor(entry('note.md'), [], { desktop: true }).find(a => a.id === 'reveal')
    expect(reveal?.mutating, 'reveal is marked mutating; it reads nothing and writes nothing')
      .toBe(false)
  })
})
