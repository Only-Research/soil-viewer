import { describe, expect, it, vi } from 'vitest'

import type { WireEntry } from '../../src/contract/wire'
import { rowKey, visibleRows } from '../../src/client/files/tree-model'
import { createTreeStore, type TreeGateway } from '../../src/client/files/tree-store'

const entry = (segments: string[], overrides: Partial<WireEntry> = {}): WireEntry => {
  const name = segments[segments.length - 1] ?? ''
  return {
    rootId: 'soil',
    segments,
    name,
    kind: 'file',
    title: name,
    size: 1,
    modifiedMs: 0,
    isMarkdown: name.endsWith('.md'),
    contentUnavailable: false,
    token: 'tok',
    ...overrides,
  }
}
const folder = (segments: string[]): WireEntry =>
  entry(segments, { kind: 'directory', isMarkdown: false })

/** A gateway over a fixed tree, counting requests and able to stall or fail on demand. */
function gatewayOver(tree: Map<string, WireEntry[]>) {
  const calls: string[] = []
  let stall: { resolve: () => void; promise: Promise<void> } | null = null
  let failWith: string | null = null

  const gateway: TreeGateway = {
    children: async (rootId, segments) => {
      calls.push(rowKey(rootId, segments))
      if (stall !== null) await stall.promise
      if (failWith !== null) throw new Error(failWith)
      return tree.get(rowKey(rootId, segments)) ?? []
    },
  }

  return {
    gateway,
    calls,
    countFor: (rootId: string, segments: readonly string[]) =>
      calls.filter(c => c === rowKey(rootId, segments)).length,
    stall() {
      let resolve = (): void => {}
      const promise = new Promise<void>(r => { resolve = r })
      stall = { resolve, promise }
      return () => { stall = null; resolve() }
    },
    failNext(reason: string) { failWith = reason },
    stopFailing() { failWith = null },
  }
}

const TREE = () => new Map<string, WireEntry[]>([
  [rowKey('soil', []), [folder(['projects']), entry(['readme.md'])]],
  [rowKey('soil', ['projects']), [folder(['projects', 'orchard'])]],
  [rowKey('soil', ['projects', 'orchard']), [entry(['projects', 'orchard', 'deep.md'])]],
])

describe('filling the tree', () => {
  it('fetches each registered folder\'s top level as soon as it is named', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])
    await vi.waitFor(() => expect(store.childrenOf('soil', [])).toBeDefined())
    expect(store.childrenOf('soil', [])?.map(e => e.name)).toEqual(['projects', 'readme.md'])
  })

  it('does not fetch a folder until it is expanded', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])
    await vi.waitFor(() => expect(store.childrenOf('soil', [])).toBeDefined())

    expect(source.countFor('soil', ['projects'])).toBe(0)
    await store.toggle(folder(['projects']))
    expect(source.countFor('soil', ['projects'])).toBe(1)
  })

  it('ignores a toggle on a file', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    await store.toggle(entry(['readme.md']))
    expect(store.isExpanded(rowKey('soil', ['readme.md']))).toBe(false)
    expect(source.calls).toHaveLength(0)
  })
})

describe('not fetching the same folder twice', () => {
  /**
   * **This test did not test dedup for its first two versions.**
   *
   * It called `toggle` twice concurrently — but the second toggle sees the folder already expanded
   * and *collapses* it, so only one fetch was ever issued whether or not the dedup existed. The
   * mutation that removes `#inFlight` sailed through.
   *
   * Two overlapping REVEALS is the real case, and it is also the real-world one: clicking a search
   * result while a previous reveal is still resolving.
   */
  it('collapses overlapping fetches of one folder into ONE request', async () => {
    const source = gatewayOver(TREE())
    const release = source.stall()
    const store = createTreeStore({ gateway: source.gateway })

    const both = Promise.all([
      store.revealPath('soil', ['projects', 'orchard', 'deep.md']),
      store.revealPath('soil', ['projects', 'orchard', 'deep.md']),
    ])
    release()
    await both

    expect(source.countFor('soil', [])).toBe(1)
    expect(source.countFor('soil', ['projects'])).toBe(1)
    expect(source.countFor('soil', ['projects', 'orchard'])).toBe(1)
  })

  it('keeps the cache across a collapse, so re-expanding costs nothing', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })

    await store.toggle(folder(['projects']))
    await store.toggle(folder(['projects']))
    await store.toggle(folder(['projects']))

    expect(source.countFor('soil', ['projects'])).toBe(1)
    expect(store.isExpanded(rowKey('soil', ['projects']))).toBe(true)
  })
})

/**
 * §6's rule, on the client: **an empty-but-successful result never stands in for a failure.**
 *
 * A folder that will not list must not be cached as `[]`, because the row would then render as an
 * empty folder — indistinguishable from a real one, and quietly wrong.
 */
describe('a folder that will not list', () => {
  it('caches nothing, records the reason, and does not look empty', async () => {
    const source = gatewayOver(TREE())
    const seen: string[] = []
    const store = createTreeStore({
      gateway: source.gateway,
      onError: (_key, reason) => { seen.push(reason) },
    })

    source.failNext('permission denied')
    await store.toggle(folder(['projects']))

    expect(store.childrenOf('soil', ['projects'])).toBeUndefined()
    expect(store.errorAt(rowKey('soil', ['projects']))).toBe('permission denied')
    expect(seen).toEqual(['permission denied'])
  })

  it('reads as expanded-but-not-loaded in the rows, never as an empty folder', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])
    await vi.waitFor(() => expect(store.childrenOf('soil', [])).toBeDefined())

    source.failNext('permission denied')
    await store.toggle(folder(['projects']))

    const { rows } = visibleRows({
      rootIds: store.rootIds(),
      expanded: store.expanded(),
      childrenOf: store.childrenOf,
    })
    const row = rows.find(r => r.entry.name === 'projects')
    expect(row?.expanded).toBe(true)
    expect(row?.childrenLoaded, 'an unreadable folder must not look empty').toBe(false)
  })

  it('clears the error once the folder reads successfully', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })

    source.failNext('permission denied')
    await store.toggle(folder(['projects']))
    expect(store.errorAt(rowKey('soil', ['projects']))).toBeDefined()

    source.stopFailing()
    await store.invalidate('soil', ['projects'])
    expect(store.errorAt(rowKey('soil', ['projects']))).toBeUndefined()
    expect(store.childrenOf('soil', ['projects'])).toBeDefined()
  })

  it('an EMPTY folder is cached as empty, and that is a different thing', async () => {
    const tree = TREE()
    tree.set(rowKey('soil', ['projects']), [])
    const store = createTreeStore({ gateway: gatewayOver(tree).gateway })

    await store.toggle(folder(['projects']))
    expect(store.childrenOf('soil', ['projects'])).toEqual([])
    expect(store.errorAt(rowKey('soil', ['projects']))).toBeUndefined()
  })
})

describe('revealing a path — the PRD\'s auto-expand', () => {
  it('expands every folder containing the file, and fetches each level', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])

    await store.revealPath('soil', ['projects', 'orchard', 'deep.md'])

    expect(store.isExpanded(rowKey('soil', ['projects']))).toBe(true)
    expect(store.isExpanded(rowKey('soil', ['projects', 'orchard']))).toBe(true)
    // And not the file itself.
    expect(store.isExpanded(rowKey('soil', ['projects', 'orchard', 'deep.md']))).toBe(false)

    const { rows } = visibleRows({
      rootIds: store.rootIds(),
      expanded: store.expanded(),
      childrenOf: store.childrenOf,
    })
    expect(rows.map(r => r.entry.name)).toContain('deep.md')
  })

  it('fetches levels in order, because a child is not known until its parent arrives', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    await store.revealPath('soil', ['projects', 'orchard', 'deep.md'])

    expect(source.calls).toEqual([
      rowKey('soil', []),
      rowKey('soil', ['projects']),
      rowKey('soil', ['projects', 'orchard']),
    ])
  })

  /**
   * **The ordering assertion above is not enough on its own**, which a sweep showed: replacing the
   * sequential loop with `Promise.all(segments.map(...))` still pushes the calls in index order, so
   * the array looks identical and the test passes.
   *
   * What the loop actually buys is the `children.has` check in front of each level — levels already
   * held are not re-requested. That is what this asserts, and it is the difference a person feels:
   * revealing a second file in a folder they are already looking at should cost one request, not
   * one per level of depth.
   */
  it('does NOT refetch levels it already holds', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })

    await store.revealPath('soil', ['projects', 'orchard', 'deep.md'])
    const before = source.calls.length

    await store.revealPath('soil', ['projects', 'orchard', 'another.md'])
    expect(source.calls.length, 'everything on that path is already held').toBe(before)
  })
})

/**
 * F9.2: *"Restored view state is untrusted input."*
 */
describe('restoring an expansion set from a previous session', () => {
  it('a key naming a path that no longer exists does nothing at all', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])
    await vi.waitFor(() => expect(store.childrenOf('soil', [])).toBeDefined())

    await store.restoreExpanded([
      rowKey('soil', ['deleted-last-week']),
      rowKey('made-up-root', ['anything']),
      rowKey('soil', ['../../etc']),
    ])

    // The keys are held, and hold nothing: a row only exists if the SERVER listed it.
    const { rows } = visibleRows({
      rootIds: store.rootIds(),
      expanded: store.expanded(),
      childrenOf: store.childrenOf,
    })
    expect(rows.map(r => r.entry.name)).toEqual(['projects', 'readme.md'])
    expect(rows.every(r => !r.expanded)).toBe(true)
  })

  /**
   * **The assertion whose absence let a whole feature ship broken.**
   *
   * These tests checked that the KEYS were held. `restoreExpanded` added them and fetched nothing,
   * so a restored session drew folders marked open with no rows under them — and every test here
   * passed, because none of them asked what was VISIBLE. The interface's own docstring said
   * "fetching what it names" throughout.
   */
  it('FETCHES what it restores, so the rows are actually there', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])
    await vi.waitFor(() => expect(store.childrenOf('soil', [])).toBeDefined())

    await store.restoreExpanded([
      rowKey('soil', ['projects']),
      rowKey('soil', ['projects', 'orchard']),
    ])

    const { rows } = visibleRows({
      rootIds: store.rootIds(),
      expanded: store.expanded(),
      childrenOf: store.childrenOf,
    })
    expect(rows.map(r => r.entry.name)).toEqual(['projects', 'orchard', 'deep.md', 'readme.md'])
  })

  it('fetches shallowest first, because a child is not known until its parent arrives', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])
    await vi.waitFor(() => expect(store.childrenOf('soil', [])).toBeDefined())

    // Deliberately out of order: the stored set is whatever a Set iterated months ago.
    await store.restoreExpanded([
      rowKey('soil', ['projects', 'orchard']),
      rowKey('soil', ['projects']),
    ])

    const after = source.calls.slice(1)
    expect(after).toEqual([rowKey('soil', ['projects']), rowKey('soil', ['projects', 'orchard'])])
  })

  it('ignores a key naming a root the server did not report', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])
    await vi.waitFor(() => expect(store.childrenOf('soil', [])).toBeDefined())

    await store.restoreExpanded([rowKey('made-up-root', ['anything'])])
    expect(source.calls.filter(call => call.includes('made-up-root'))).toEqual([])
  })

  it('a key naming a real folder expands it', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])
    await vi.waitFor(() => expect(store.childrenOf('soil', [])).toBeDefined())

    await store.restoreExpanded([rowKey('soil', ['projects'])])
    expect(store.isExpanded(rowKey('soil', ['projects']))).toBe(true)
  })
})

describe('invalidation, for when the disk changes', () => {
  it('refetches an EXPANDED folder so the change is visible immediately', async () => {
    const tree = TREE()
    const source = gatewayOver(tree)
    const store = createTreeStore({ gateway: source.gateway })
    await store.toggle(folder(['projects']))

    tree.set(rowKey('soil', ['projects']),
      [folder(['projects', 'orchard']), entry(['projects', 'new.md'])])
    await store.invalidate('soil', ['projects'])

    expect(store.childrenOf('soil', ['projects'])?.map(e => e.name))
      .toEqual(['orchard', 'new.md'])
    expect(source.countFor('soil', ['projects'])).toBe(2)
  })

  it('only DROPS the cache for a collapsed folder — no request nobody is waiting on', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    await store.toggle(folder(['projects']))
    await store.toggle(folder(['projects']))

    await store.invalidate('soil', ['projects'])
    expect(store.childrenOf('soil', ['projects'])).toBeUndefined()
    expect(source.countFor('soil', ['projects']), 'no refetch for a folder nobody is looking at')
      .toBe(1)
  })

  it('always refetches a registered folder\'s top level, expanded or not', async () => {
    // There is no row to expand for a root, so "is it expanded" is not a question that applies.
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    store.setRoots(['soil'])
    await vi.waitFor(() => expect(store.childrenOf('soil', [])).toBeDefined())

    await store.invalidate('soil', [])
    expect(source.countFor('soil', [])).toBe(2)
  })
})

describe('telling the view', () => {
  it('announces before the fetch, so the row opens rather than the tree freezing', async () => {
    const source = gatewayOver(TREE())
    const release = source.stall()
    const store = createTreeStore({ gateway: source.gateway })

    let announced = 0
    store.subscribe(() => { announced += 1 })

    const pending = store.toggle(folder(['projects']))
    // Still stalled: the fetch has not landed, and the view has already been told.
    expect(announced).toBeGreaterThan(0)
    expect(store.isExpanded(rowKey('soil', ['projects']))).toBe(true)

    release()
    await pending
  })

  it('stops announcing once unsubscribed', async () => {
    const source = gatewayOver(TREE())
    const store = createTreeStore({ gateway: source.gateway })
    let announced = 0
    const stop = store.subscribe(() => { announced += 1 })
    await store.toggle(folder(['projects']))
    const before = announced
    stop()
    await store.toggle(folder(['projects']))
    expect(announced).toBe(before)
  })
})
