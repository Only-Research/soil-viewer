import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { IndexStore } from '../../src/core/index-store'
import { indexRoot } from '../../src/core/indexer'
import { registerRoot } from '../../src/core/fs/registration'
import { lanePlacementOf } from '../../src/core/grammar'
import type { RegisteredRoot } from '../../src/core/fs/containment'
import { DEFAULT_SHAPE, makeScaleTree } from '../support/make-scale-tree'

/**
 * The scale gate. Build plan's P1 row: "**Scale measured, not asserted:** cold index of the
 * 10k tree streams without blocking; no operation re-reads the tree."
 *
 * The tree is generated here rather than committed — 10,000 files in git would bloat every
 * clone for data the generator fully describes.
 */

let sandbox: string
let root: RegisteredRoot
let writtenFiles = 0

const TIMEOUT = 180_000

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-scale-'))
  const rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })

  writtenFiles = await makeScaleTree(rootPath, DEFAULT_SHAPE)

  const registered = await registerRoot('scale', rootPath)
  if (!registered.ok) throw new Error(`registration failed: ${registered.code}`)
  root = registered.value
}, TIMEOUT)

afterAll(async () => {
  const tempBase = process.env['TMPDIR'] ?? tmpdir()
  const ours =
    typeof sandbox === 'string' &&
    sandbox.length > tempBase.length &&
    sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-scale-')
  if (!ours) throw new Error(`refusing to recursively delete: ${String(sandbox)}`)
  await fsp.rm(sandbox, { recursive: true, force: true })
}, TIMEOUT)

describe('scale — measured, not asserted', () => {
  it('the generated tree actually reaches the 10,000-file target', () => {
    expect(writtenFiles).toBeGreaterThanOrEqual(10_000)
  })

  it('cold-indexes the tree, and yields to the event loop while doing it', async () => {
    const store = new IndexStore()

    // The real test of "never blocks first paint": a timer scheduled before the index starts
    // must still fire while it runs. If the walk monopolised the event loop, this stays at 0
    // until the whole index finished.
    let ticks = 0
    const interval = setInterval(() => { ticks++ }, 10)

    const started = process.hrtime.bigint()
    const progress = await indexRoot(root, store)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    clearInterval(interval)

    expect(progress.indexed).toBeGreaterThanOrEqual(10_000)
    expect(store.size).toBe(progress.indexed)
    expect(progress.problems).toBe(0)

    // The assertion that matters. Anything above zero proves the loop was released; the walk
    // is not a blocking loop wearing async syntax.
    expect(ticks).toBeGreaterThan(0)

    console.log(
      `[scale] indexed ${progress.indexed} entries in ${elapsedMs.toFixed(0)}ms ` +
      `(${(progress.indexed / (elapsedMs / 1000)).toFixed(0)}/s), event loop ticked ${ticks}x`,
    )
  }, TIMEOUT)

  it('streams progress rather than reporting once at the end', async () => {
    const store = new IndexStore()
    const reports: number[] = []
    await indexRoot(root, store, {}, p => reports.push(p.indexed))

    // Many intermediate reports, not just the final one — this is what lets a caller paint
    // before the walk finishes.
    expect(reports.length).toBeGreaterThan(10)
    expect(reports[0]).toBeLessThan(store.size)
  }, TIMEOUT)

  it('never walks ignored directories at scale', async () => {
    const store = new IndexStore()
    await indexRoot(root, store)
    for (const entry of store.all()) {
      expect(entry.segments).not.toContain('node_modules')
      expect(entry.name).not.toBe('.DS_Store')
    }
  }, TIMEOUT)

  it('derives the task board from the index without re-reading the tree', async () => {
    const store = new IndexStore()
    await indexRoot(root, store)

    // No filesystem call here at all: the board is a pure function of what is already in
    // memory. Build plan's P1 gate: "no operation re-reads the tree."
    const started = process.hrtime.bigint()
    let cards = 0
    let uncategorized = 0
    for (const entry of store.all()) {
      if (!entry.isMarkdown) continue
      const placement = lanePlacementOf(entry.segments)
      if (placement === null) continue
      cards++
      if (placement.lane === null) uncategorized++
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    expect(cards).toBeGreaterThan(1_000)
    expect(uncategorized).toBeGreaterThan(0) // the lane-less cards land in the synthetic lane
    expect(elapsedMs).toBeLessThan(2_000)

    console.log(`[scale] derived ${cards} cards (${uncategorized} Uncategorized) in ${elapsedMs.toFixed(1)}ms`)
  }, TIMEOUT)
})
