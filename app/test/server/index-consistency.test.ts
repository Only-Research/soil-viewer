import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IndexStore } from '../../src/core/index-store'
import { indexRegisteredRoot } from '../../src/core/indexer'
import { loadConfigService } from '../../src/server/config-service'
import { createRootRegistry } from '../../src/server/root-registry'
import { createServices, type Services } from '../../src/server/services'

/**
 * **THE CROSS-FILE LENS FOR PHASE 4'S GATE.** After a write verb returns, does the index agree with
 * disk?
 *
 * Every verb is individually correct and every verb has its own suite. This asks the question none
 * of those suites can: what does the *next request* see. Spec §5 makes the index authoritative for
 * display, so an index that is stale the instant a mutation returns means the client's own refetch —
 * the very next thing a UI does after a successful action — is answered with the state from before
 * the action it just performed.
 *
 * It is the build's signature failure in its second form: *reachable, and never given what it
 * needs.* The watcher will correct this within its 250 ms coalescing window **when live updates are
 * running**, which makes it a race the client loses often rather than a bug it hits always — and
 * the worst kind of defect to leave in, because it is intermittent and looks like a UI problem.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree per test.
 */
let sandbox: string
let rootPath: string
let services: Services
let index: IndexStore

const PROJECT = ['02-projects', 'cider']
const TASKS = [...PROJECT, 'tasks']
const LONG = '# Notes\n\nlong enough that a rewrite does not trip the truncation guard\n'
const ARTIFACT = ['notes.conflict-20260808-120000-ABCD.md']

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-consist-'))
  rootPath = join(sandbox, 'root')
  await fsp.mkdir(join(rootPath, ...TASKS, '02-next'), { recursive: true })
  await fsp.mkdir(join(rootPath, ...TASKS, '04-done'), { recursive: true })
  await fsp.mkdir(join(rootPath, 'src-folder'), { recursive: true })
  await fsp.writeFile(join(rootPath, ...TASKS, '02-next', 'card.md'), '# Card\n')
  await fsp.writeFile(join(rootPath, 'notes.md'), LONG)
  await fsp.writeFile(join(rootPath, 'src-folder', 'a.md'), '# A\n')
  await fsp.writeFile(join(rootPath, ...ARTIFACT), '# Mine\n\nthe rescued edit, long enough\n')

  const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)

  index = new IndexStore()
  await indexRegisteredRoot(registered.value, index)

  const config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })
  services = createServices(registry, index, {
    stagingRoot: join(sandbox, 'app-scratch'),
    archiveRoot: join(sandbox, 'app-archive'),
      // §11's browsable area, pointed INSIDE this test's sandbox. Never the real home directory:
      // these suites are not about browsing, and a scope that reached `$HOME` would make an
      // unrelated test capable of listing the user's disk.
      browseScope: { home: join(sandbox, 'browse-home'), volumes: join(sandbox, 'browse-volumes') },
  }, config)
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

describe('after a write verb returns, the index agrees with disk — §5', () => {
  it('file.save', async () => {
    const loaded = await services['file.load']({ rootId: 'soil', segments: ['notes.md'] })
    await services['file.save']({
      rootId: 'soil', segments: ['notes.md'],
      content: '# Rewritten\n\nstill comfortably longer than half the original file\n',
      expectedHash: loaded.hash, confirmTruncation: false,
    })
    expect(index.get('soil', ['notes.md'])?.title).toBe('Rewritten')
  })

  it('entry.rename — the new path is there and the old one is gone', async () => {
    await services['entry.rename']({
      rootId: 'soil', from: ['notes.md'], to: ['renamed.md'],
      token: services['tree.entry']({ rootId: 'soil', segments: ['notes.md'] }).token,
    })
    expect(index.get('soil', ['renamed.md']), 'the new path').toBeDefined()
    expect(index.get('soil', ['notes.md']), 'the old path').toBeUndefined()
  })

  it('card.move — the card is in the new lane and not the old one', async () => {
    const done = services['board.lanes']({ rootId: 'soil', project: PROJECT })
      .find(lane => lane.name === 'Done')
    if (done === undefined) throw new Error('no Done lane')

    await services['card.move']({
      rootId: 'soil', card: [...TASKS, '02-next', 'card.md'], laneId: done.id,
      token: services['tree.entry']({ rootId: 'soil', segments: [...TASKS, '02-next', 'card.md'] }).token,
    })
    expect(index.get('soil', [...TASKS, '04-done', 'card.md']), 'the new lane').toBeDefined()
    expect(index.get('soil', [...TASKS, '02-next', 'card.md']), 'the old lane').toBeUndefined()
  })

  it('entry.copy — the copied tree is there', async () => {
    await services['entry.copy']({
      rootId: 'soil', from: ['src-folder'], to: ['copied'], plan: false,
      token: services['tree.entry']({ rootId: 'soil', segments: ['src-folder'] }).token,
    })
    expect(index.get('soil', ['copied']), 'the copied folder').toBeDefined()
    expect(index.get('soil', ['copied', 'a.md']), 'and what is inside it').toBeDefined()
  })

  it('conflict.resolve — the artifact is gone from the index once it is archived', async () => {
    /**
     * The one with a consequence a person would see: §13.5 puts conflict artifacts on a persistent
     * "Needs attention" list. A resolved conflict whose row survives in the index sits on that list
     * forever, pointing at a file that is now in the app's archive — which is C5's un-removable card
     * arriving through the index instead of through the grammar.
     */
    const artifact = ARTIFACT
    await services['conflict.resolve']({
      rootId: 'soil', canonical: ['notes.md'], artifact, choice: 'mine',
      token: services['tree.entry']({ rootId: 'soil', segments: ['notes.md'] }).token,
    })
    expect(index.get('soil', artifact), 'the artifact was moved to the archive').toBeUndefined()
    expect(index.get('soil', ['notes.md']), 'and the canonical file is still indexed').toBeDefined()
  })
})
