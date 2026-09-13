import { describe, expect, it } from 'vitest'

import { type RegisteredRoot } from '../../../src/core/fs/containment'
import { createMutationLocks, lockKeyFor } from '../../../src/core/fs/mutation-lock'

/**
 * §13.8's serialization. The failure mode this whole file guards against is **silence**: a lock
 * keyed wrongly does not deadlock or throw, it simply lets two operations run at once while
 * appearing to be held.
 */

const rootWith = (over: Partial<RegisteredRoot> = {}): RegisteredRoot => ({
  id: 'soil',
  absolutePath: '/scratch/soil',
  resolvedPath: '/scratch/soil',
  caseInsensitive: true,
  dev: 1n,
  rootIno: 2n,
  ...over,
})

/** Resolves only when told to, so a test can hold a lock open and observe what else runs. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { opened, open }
}

describe('it actually serializes', () => {
  it('does not let two operations on the same key overlap', async () => {
    const locks = createMutationLocks()
    const order: string[] = []
    const first = gate()

    const a = locks.withLock(['k'], async () => {
      order.push('a:start')
      await first.opened
      order.push('a:end')
    })
    const b = locks.withLock(['k'], async () => {
      order.push('b:start')
      order.push('b:end')
    })

    // Give B every chance to interleave before A is allowed to finish.
    await Promise.resolve()
    await Promise.resolve()
    expect(order, 'B must not have started while A holds the lock').toEqual(['a:start'])

    first.open()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('lets operations on DIFFERENT keys run concurrently', async () => {
    // The other half of the property. A lock that serializes everything is also wrong — it would
    // make the app single-threaded across unrelated files.
    const locks = createMutationLocks()
    const order: string[] = []
    const held = gate()

    const a = locks.withLock(['one'], async () => {
      order.push('a:start')
      await held.opened
      order.push('a:end')
    })
    const b = locks.withLock(['two'], async () => { order.push('b:ran') })

    await b
    expect(order, 'B must not have waited for A').toEqual(['a:start', 'b:ran'])
    held.open()
    await a
  })

  it('serializes a queue of ten in the order they arrived', async () => {
    const locks = createMutationLocks()
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => locks.withLock(['q'], async () => {
        order.push(i)
        await Promise.resolve()
      })),
    )
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('the key decides whether the lock works at all', () => {
  it('folds case on a case-INSENSITIVE root — one file, one lock', () => {
    // notes.md and Notes.md are the same file here. Two keys would mean two locks and no
    // serialization at all, silently.
    const root = rootWith({ caseInsensitive: true })
    expect(lockKeyFor(root, ['notes.md'])).toBe(lockKeyFor(root, ['Notes.md']))
  })

  it('does NOT fold case on a case-sensitive root — two files, two locks', () => {
    const root = rootWith({ caseInsensitive: false })
    expect(lockKeyFor(root, ['notes.md'])).not.toBe(lockKeyFor(root, ['Notes.md']))
  })

  it('folds NFC and NFD together — one file, two strings', () => {
    /**
     * §4: "overlapping roots, case variants and NFC/NFD all produce two strings for one inode."
     *
     * **Written with escapes, because the first version of this test proved nothing.** It used two
     * literal `café.md` strings typed into the file — and they were byte-identical, because the
     * editor normalized both to NFC on the way in. The assertion was that a string equals itself,
     * and dropping `toNFC` from the key left it green. Escapes cannot be normalized by a tool.
     */
    const composed = 'caf\u00e9.md'
    const decomposed = 'cafe\u0301.md'
    expect(composed, 'the fixture must actually be two different strings').not.toBe(decomposed)

    const root = rootWith()
    expect(lockKeyFor(root, [composed])).toBe(lockKeyFor(root, [decomposed]))
  })

  it('does NOT strip numeric prefixes, unlike grammarKey', () => {
    /**
     * `grammarKey` is the obvious helper to reach for and is wrong here: it strips the ordering
     * prefix, so `01-intro.md` and `02-intro.md` would share one key. Two unrelated files taking
     * the same lock is not a data-safety bug, but it is a lie about what the lock means.
     */
    const root = rootWith()
    expect(lockKeyFor(root, ['01-intro.md'])).not.toBe(lockKeyFor(root, ['02-intro.md']))
  })

  it('keeps different roots apart', () => {
    expect(lockKeyFor(rootWith({ id: 'a' }), ['notes.md']))
      .not.toBe(lockKeyFor(rootWith({ id: 'b' }), ['notes.md']))
  })

  it('cannot have one path forge another\'s key', () => {
    /**
     * The separator is NUL, the one byte a path cannot contain. Joined on anything a filename may
     * legally hold — a space, a slash, a dash — two different paths could produce one key, and two
     * unrelated files would share a lock while a third pair that should share one would not.
     */
    const root = rootWith()
    expect(lockKeyFor(root, ['a', 'b'])).not.toBe(lockKeyFor(root, ['a b']))
    expect(lockKeyFor(root, ['a', 'b'])).not.toBe(lockKeyFor(root, ['a-b']))
    expect(lockKeyFor(root, ['a', 'b'])).not.toBe(lockKeyFor(root, ['a/b']))
    expect(lockKeyFor(root, ['x'])).not.toBe(lockKeyFor(root, ['x', '']))
  })
})

describe('holding more than one key', () => {
  it('does not deadlock when two operations want the same pair in opposite orders', async () => {
    /**
     * A move touches two parents. Two concurrent moves, one A→B and one B→A, taking their locks in
     * the order they were given would each hold one and wait forever for the other. Acquiring in a
     * sorted order makes that impossible.
     *
     * If this ever regresses the symptom is not a failure — it is a test run that never finishes.
     */
    const locks = createMutationLocks()
    const done: string[] = []

    await Promise.all([
      locks.withLock(['A', 'B'], async () => { await Promise.resolve(); done.push('first') }),
      locks.withLock(['B', 'A'], async () => { await Promise.resolve(); done.push('second') }),
    ])

    expect(done).toHaveLength(2)
  })

  it('does not deadlock against itself when a key is named twice', async () => {
    // A rename inside one folder names the same parent as both source and destination. Without
    // deduplication the second acquire waits on the first — held by the same caller.
    const locks = createMutationLocks()
    let ran = false
    await locks.withLock(['same', 'same'], async () => { ran = true })
    expect(ran).toBe(true)
  })

  it('WAITS for a key already held by someone else, even when it is not the first', async () => {
    /**
     * The gap the sweep found. Making `withLock` await only its first key left every test green,
     * because enqueueing still blocks *other* callers — so nothing observed the real breakage,
     * which is this: a holder of B is already running, a second operation asks for [A, B], and
     * without waiting on B's turn it starts anyway. Two writers, one file, no error.
     */
    const locks = createMutationLocks()
    const order: string[] = []
    const holder = gate()

    const first = locks.withLock(['B'], async () => {
      order.push('first:start')
      await holder.opened
      order.push('first:end')
    })
    const second = locks.withLock(['A', 'B'], async () => { order.push('second:ran') })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(order, 'the second operation must not run while B is held').toEqual(['first:start'])

    holder.open()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:ran'])
  })

  it('holds every named key, not just the first', async () => {
    const locks = createMutationLocks()
    const held = gate()
    const order: string[] = []

    const holder = locks.withLock(['A', 'B'], async () => {
      order.push('holder:start')
      await held.opened
    })
    const contender = locks.withLock(['B'], async () => { order.push('contender:ran') })

    await Promise.resolve()
    await Promise.resolve()
    expect(order, 'the SECOND key must be held too').toEqual(['holder:start'])

    held.open()
    await Promise.all([holder, contender])
    expect(order).toEqual(['holder:start', 'contender:ran'])
  })
})

describe('it releases, always', () => {
  it('releases when the work throws, and propagates the error', async () => {
    // A lock leaked on the error path makes every later mutation on that file hang forever — and
    // the error path is the one that runs when something has already gone wrong.
    const locks = createMutationLocks()
    await expect(locks.withLock(['k'], async () => { throw new Error('boom') }))
      .rejects.toThrow('boom')

    let ran = false
    await locks.withLock(['k'], async () => { ran = true })
    expect(ran).toBe(true)
  })

  it('is empty at rest, so it cannot grow without bound', async () => {
    // One entry per file ever touched would be a slow leak in a process that runs for weeks.
    const locks = createMutationLocks()
    for (let i = 0; i < 100; i++) {
      await locks.withLock([`file-${i}.md`], async () => { /* nothing */ })
    }
    expect(locks.size).toBe(0)
  })

  it('is empty at rest even after a throw', async () => {
    const locks = createMutationLocks()
    await locks.withLock(['a'], async () => { throw new Error('x') }).catch(() => { /* expected */ })
    expect(locks.size).toBe(0)
  })

  it('reports keys as held while work is in flight', async () => {
    const locks = createMutationLocks()
    const held = gate()
    const running = locks.withLock(['A', 'B'], async () => { await held.opened })
    await Promise.resolve()
    expect(locks.size).toBe(2)
    held.open()
    await running
    expect(locks.size).toBe(0)
  })
})
