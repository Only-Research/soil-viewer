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
 * **QUICK-OPEN THROUGH THE SERVICE, AGAINST A REAL INDEXED TREE.**
 *
 * `test/core/quick-open.test.ts` proves the ranking and every bound in §16. What only this layer
 * answers is what the search is pointed *at* — and that is where a search route goes wrong: too
 * much (folders, non-markdown, files outside a registered folder) or too little.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree per test.
 */

let sandbox: string
let rootPath: string
let services: Services

beforeEach(async () => {
  sandbox = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'soil-quickopen-')))
  rootPath = join(sandbox, 'root')

  const write = async (path: string, body: string): Promise<void> => {
    const full = join(rootPath, path)
    await fsp.mkdir(join(full, '..'), { recursive: true })
    await fsp.writeFile(full, body)
  }
  await write('02-projects/cold-store/03-discovery/RT1/chatroom.md', '# Room\n')
  await write('02-projects/chatroom-protocol/notes.md', '# Notes\n')
  await write('02-projects/orchard/context.md', '# Context\n')
  await write('02-projects/orchard/photo.png', 'not markdown')
  await fsp.mkdir(join(rootPath, '02-projects', 'chatroom-shaped-folder'), { recursive: true })

  const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)
  const index = new IndexStore()
  await indexRegisteredRoot(registered.value, index)

  const config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })
  services = createServices(registry, index, {
    stagingRoot: join(sandbox, 'scratch'),
    archiveRoot: join(sandbox, 'archive'),
    browseScope: { home: sandbox, volumes: join(sandbox, 'volumes') },
  }, config)
})

afterEach(async () => { await fsp.rm(sandbox, { recursive: true, force: true }) })

const found = (query: string) => services['search.quickOpen']({ query })

describe('what quick-open is pointed at', () => {
  it('finds a file by its name, ahead of one that only shares a folder name', () => {
    const names = found('chatroom').map(hit => hit.entry.name)
    expect(names[0]).toBe('chatroom.md')
    expect(names).toContain('notes.md')
    expect(found('chatroom')[0]?.inName).toBe(true)
  })

  /**
   * **Files only, and markdown only.** §16 is *"jump to any file"*, and a folder in a jump list is
   * an entry that cannot do what the list promises — the Files tab opens folders by expanding them.
   * A non-markdown file cannot be opened into the editor either; it gets the pane that says what it
   * is, which is not a destination worth ranking.
   */
  it('offers no folders, even one whose name matches perfectly', () => {
    expect(found('chatroom').map(hit => hit.entry.name)).not.toContain('chatroom-shaped-folder')
  })

  /**
   * **Asserted as the absence of the png, not as an empty list.** The first version expected
   * nothing at all and `photo` legitimately matches `chatroom-protocol/notes.md` as a subsequence
   * of its *path* — a real hit, correctly ranked below any name match. Expecting emptiness was
   * asserting something the search does not claim.
   */
  it('offers no file that is not markdown', () => {
    expect(found('photo').map(hit => hit.entry.name)).not.toContain('photo.png')
    // And the png really is in the tree, so this is not passing on a missing fixture.
    expect(services['tree.children']({ rootId: 'soil', segments: ['02-projects', 'orchard'] })
      .map(entry => entry.name)).toContain('photo.png')
  })

  /**
   * **Wire rows, not index rows.** The same hazard `board.cardsFor` records in its own type: an
   * index row carries `dev`, `ino` and `mtimeNs` as BigInt, and `JSON.stringify` throws on them —
   * so a route returning one 500s at runtime while typechecking perfectly. Phase 2's gate names
   * this by hand and a route walked into it anyway three units ago.
   */
  it('returns rows that can actually be serialised', () => {
    expect(() => JSON.stringify(found('chatroom'))).not.toThrow()
  })

  it('returns nothing for an empty query rather than the whole tree', () => {
    expect(found('')).toEqual([])
    expect(found('   ')).toEqual([])
  })

  it('returns nothing for a query that matches nothing, rather than everything', () => {
    expect(found('zzzzqqqq')).toEqual([])
  })
})
