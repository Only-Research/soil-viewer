import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  isArchived,
  isIgnoredPath,
  isInboxItem,
  isMarkdown,
  isProject,
  isProjectRoot,
  lanePlacementOf,
} from '../../src/core/grammar'
import { IndexStore } from '../../src/core/index-store'
import { indexRoot } from '../../src/core/indexer'
import { registerRoot } from '../../src/core/fs/registration'
import { splitSegments } from '../../src/core/paths'
import type { RegisteredRoot } from '../../src/core/fs/containment'
import { EXPECTATIONS, makeGrammarTree } from '../support/make-grammar-tree'

/**
 * The grammar fixture tree. Build plan §9.
 *
 * Two halves. The first drives every expectation through the grammar functions directly. The
 * second builds the tree on disk and indexes it, so the same rules are checked through the
 * real walker — a rule can be correct in isolation and never reached in practice, which is
 * how the `node:fs` ban managed to be "configured" and disabled at the same time.
 */

let sandbox: string
let root: RegisteredRoot
let store: IndexStore

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-gram-'))
  const rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })
  await makeGrammarTree(rootPath)

  const registered = await registerRoot('soil', rootPath)
  if (!registered.ok) throw new Error(`registration failed: ${registered.code}`)
  root = registered.value

  store = new IndexStore()
  await indexRoot(root, store)
})

afterAll(async () => {
  const tempBase = process.env['TMPDIR'] ?? tmpdir()
  const ours =
    typeof sandbox === 'string' &&
    sandbox.length > tempBase.length &&
    sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-gram-')
  if (!ours) throw new Error(`refusing to recursively delete: ${String(sandbox)}`)
  await fsp.rm(sandbox, { recursive: true, force: true })
})

describe('every expectation the fixture declares', () => {
  for (const expectation of EXPECTATIONS) {
    it(expectation.path, () => {
      const segments = splitSegments(expectation.path)
      const name = segments[segments.length - 1] ?? ''

      if (expectation.isProject !== undefined) {
        expect(isProject(segments), 'isProject').toBe(expectation.isProject)
      }
      if (expectation.isProjectRoot !== undefined) {
        expect(isProjectRoot(segments), 'isProjectRoot').toBe(expectation.isProjectRoot)
      }
      if (expectation.lane !== undefined) {
        const placement = lanePlacementOf(segments)
        if (expectation.lane === false) {
          expect(placement, 'must not be a card').toBeNull()
        } else {
          expect(placement, 'must be a card').not.toBeNull()
          expect(placement?.lane, 'lane').toBe(expectation.lane)
        }
      }
      if (expectation.isInboxItem !== undefined) {
        expect(isInboxItem(segments), 'isInboxItem').toBe(expectation.isInboxItem)
      }
      if (expectation.isArchived !== undefined) {
        expect(isArchived(segments), 'isArchived').toBe(expectation.isArchived)
      }
      if (expectation.isIgnored !== undefined) {
        expect(isIgnoredPath(segments), 'isIgnoredPath').toBe(expectation.isIgnored)
      }
      if (expectation.isMarkdown !== undefined) {
        expect(isMarkdown(name), 'isMarkdown').toBe(expectation.isMarkdown)
      }
    })
  }
})

describe('the same rules, reached through the real walker and index', () => {
  it('indexed the tree', () => {
    expect(store.size).toBeGreaterThan(20)
  })

  it('never indexed anything the grammar ignores', () => {
    for (const entry of store.all()) {
      expect(isIgnoredPath(entry.segments), entry.segments.join('/')).toBe(false)
    }
    // Named explicitly, because "nothing ignored was indexed" is also true of an empty index.
    const paths = [...store.all()].map(e => e.segments.join('/'))
    expect(paths).not.toContain('02-projects/field-review/node_modules/pkg/readme.md')
    expect(paths).not.toContain('02-projects/field-review/dist/build.md')
    expect(paths).not.toContain('Some.app/inside.md')
    expect(paths).not.toContain('.hidden/secret.md')
    // ...and the lookalike IS present.
    expect(paths).toContain('02-projects/field-review/x-node_modules.md')
  })

  it('produces the expected board from the index alone', () => {
    const byLane = new Map<string, string[]>()
    for (const entry of store.all()) {
      if (!entry.isMarkdown) continue
      const placement = lanePlacementOf(entry.segments)
      if (placement === null) continue
      const lane = placement.lane ?? '(Uncategorized)'
      byLane.set(lane, [...(byLane.get(lane) ?? []), entry.name])
    }

    expect([...byLane.keys()].sort()).toEqual([
      '(Uncategorized)', '01-urgent', '02-next', '03-back-burner', '04-done',
    ])
    expect(byLane.get('(Uncategorized)')).toEqual(['unsorted.md'])
    // Two projects contribute to 02-next; the conflict artifact and the too-deep file do not.
    expect(byLane.get('02-next')?.sort()).toEqual(['next-card.md', 'op-card.md'])
  })

  it('keeps archived documents out of the board but IN the index', () => {
    const paths = [...store.all()].map(e => e.segments.join('/'))
    // Spec §3: archives are excluded from Tasks/Projects/Inbox but NOT from Files, because
    // v1's rule made the only sanctioned retire path impossible (M6).
    expect(paths).toContain('02-projects/field-review/archive/old-plan.md')
    expect(paths).toContain('02-projects/field-review/02-work/tasks/archive/retired-card.md')
    expect(lanePlacementOf(splitSegments('02-projects/field-review/02-work/tasks/archive/retired-card.md')))
      .toBeNull()
  })

  it('extracted titles through the real read path', () => {
    expect(store.get('soil', splitSegments('02-projects/field-review/00-context/context.md'))?.title)
      .toBe('Field Review Context')
    expect(store.get('soil', splitSegments('02-projects/field-review/00-context/diagram.png'))?.title)
      .toBe('diagram')
  })

  it('finds every inbox spelling the real soil uses', () => {
    const inboxItems = [...store.all()]
      .filter(e => e.isMarkdown && isInboxItem(e.segments))
      .map(e => e.segments.join('/'))
      .sort()
    expect(inboxItems).toEqual([
      '01-internal/01-department-inbox/dept.md',
      '01-internal/inbox/plain.md',
      '02-projects/field-review/01-inbox/dropped-note.md',
      '02-projects/field-review/01-inbox/thing.md',
      '99-inbox-main/report.md',
    ])
  })
})
