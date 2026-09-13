import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { IndexStore } from '../../src/core/index-store'
import { indexRoot, reconcileSubtree } from '../../src/core/indexer'
import { detectCloudProvider, registerRoot } from '../../src/core/fs/registration'
import { collectWalk } from '../../src/core/fs/walk'
import type { RegisteredRoot } from '../../src/core/fs/containment'

let sandbox: string
let root: RegisteredRoot

async function write(relative: string, body: string): Promise<void> {
  const full = join(root.absolutePath, relative)
  await fsp.mkdir(join(full, '..'), { recursive: true })
  await fsp.writeFile(full, body)
}

beforeAll(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-idx-'))
  const rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })

  const registered = await registerRoot('soil', rootPath)
  if (!registered.ok) throw new Error(`registration failed: ${registered.code}`)
  root = registered.value

  await write('notes.md', '# Notes\n\nbody\n')
  await write('02-projects/field-review/00-context/context.md', '---\ntitle: ctx\n---\n\n# Context\n')
  await write('02-projects/field-review/02-work/tasks/02-next/card.md', '# A Card\n')
  await write('02-projects/field-review/02-work/tasks/loose.md', '# Loose\n')
  await write('99-inbox-main/report.md', '# Report\n')
  await write('image.png', 'not markdown')
  await write('no-heading.md', 'just a paragraph\n')

  // Must never be walked (spec §3 ignore list).
  await write('node_modules/pkg/readme.md', '# Should not appear\n')
  await write('.hidden/secret.md', '# Should not appear\n')
  await fsp.mkdir(join(rootPath, 'Some.app'), { recursive: true })
  await write('Some.app/inside.md', '# Should not appear\n')

  // A symlink must be recorded but never followed.
  await fsp.mkdir(join(sandbox, 'outside'), { recursive: true })
  await fsp.writeFile(join(sandbox, 'outside', 'secret.md'), '# Outside\n')
  await fsp.symlink(join(sandbox, 'outside'), join(rootPath, 'link-dir'))
})

afterAll(async () => {
  const tempBase = process.env['TMPDIR'] ?? tmpdir()
  const ours =
    typeof sandbox === 'string' &&
    sandbox.length > tempBase.length &&
    sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-idx-')
  if (!ours) throw new Error(`refusing to recursively delete: ${String(sandbox)}`)
  await fsp.rm(sandbox, { recursive: true, force: true })
})

describe('the walk — spec §3 ignore rules and §4 symlink refusal', () => {
  it('never walks an ignored directory', async () => {
    const walked = await collectWalk(root)
    expect(walked.ok).toBe(true)
    if (!walked.ok) return
    const names = walked.value.entries.map(e => e.segments.join('/'))
    expect(names.some(n => n.includes('node_modules'))).toBe(false)
    expect(names.some(n => n.includes('.hidden'))).toBe(false)
    expect(names.some(n => n.includes('Some.app'))).toBe(false)
  })

  it('records a symlink but does not descend into it', async () => {
    const walked = await collectWalk(root)
    expect(walked.ok).toBe(true)
    if (!walked.ok) return
    const link = walked.value.entries.find(e => e.name === 'link-dir')
    expect(link?.kind).toBe('symlink')
    // The file behind the link must not appear under the root.
    expect(walked.value.entries.some(e => e.name === 'secret.md')).toBe(false)
  })

  it('reports a failure to start rather than an empty tree', async () => {
    const walked = await collectWalk(root, ['does-not-exist'])
    expect(walked.ok).toBe(false)
  })
})

describe('cold index', () => {
  it('indexes the tree and extracts titles', async () => {
    const store = new IndexStore()
    const progress = await indexRoot(root, store)

    expect(progress.indexed).toBeGreaterThan(0)
    expect(store.get('soil', ['notes.md'])?.title).toBe('Notes')
    expect(store.get('soil', ['02-projects', 'field-review', '00-context', 'context.md'])?.title)
      .toBe('Context') // frontmatter skipped, not used as the title
    expect(store.get('soil', ['no-heading.md'])?.title).toBe('no-heading')
  })

  it('marks markdown and non-markdown correctly', async () => {
    const store = new IndexStore()
    await indexRoot(root, store)
    expect(store.get('soil', ['notes.md'])?.isMarkdown).toBe(true)
    expect(store.get('soil', ['image.png'])?.isMarkdown).toBe(false)
  })

  it('does not read the body of a non-markdown file', async () => {
    const store = new IndexStore()
    await indexRoot(root, store)
    // The title is the filename, and no content was consulted to decide that.
    expect(store.get('soil', ['image.png'])?.title).toBe('image')
  })

  it('holds no file contents — spec §5 budget', async () => {
    const store = new IndexStore()
    await indexRoot(root, store)
    const allowed = new Set([
      'contentUnavailable', 'dev', 'ino', 'isMarkdown', 'kind', 'mtimeNs',
      'name', 'rootId', 'segments', 'size', 'title',
    ])
    for (const entry of store.all()) {
      // Whitelist rather than blacklist: a field named `content` is the obvious mistake, but
      // `raw`, `head` or `preview` would be the same mistake wearing a different name.
      for (const key of Object.keys(entry)) expect(allowed).toContain(key)
    }
  })

  it('an entry carries BigInt fields, which JSON.stringify cannot serialise', () => {
    // Recorded as a test rather than a comment because P2 has to solve it: `dev`, `ino` and
    // `mtimeNs` are BigInt (inode numbers exceed 2^53, and nanosecond mtimes are the basis of
    // watcher echo dedup), and the typed contract must convert them at the boundary. A
    // response handler that stringifies an index row directly throws at runtime.
    const store = new IndexStore()
    store.registerRootCasing('soil', true)
    store.upsert({
      rootId: 'soil', segments: ['a.md'], name: 'a.md', kind: 'file', title: 'A',
      size: 1, mtimeNs: 1n, dev: 1n, ino: 1n, isMarkdown: true, contentUnavailable: false,
    })
    const entry = store.get('soil', ['a.md'])
    expect(() => JSON.stringify(entry)).toThrow(TypeError)
  })

  it('reports progress while it streams', async () => {
    const store = new IndexStore()
    const seen: number[] = []
    await indexRoot(root, store, {}, p => seen.push(p.indexed))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBe(store.size)
  })

  it('records the per-root casing so lookups fold correctly', async () => {
    const store = new IndexStore()
    await indexRoot(root, store)
    // The sandbox is on the default volume; whichever way it probed, a lookup with the exact
    // on-disk spelling must succeed.
    expect(store.get('soil', ['notes.md'])).toBeDefined()
  })
})

describe('cloud-sync roots — spec §5, never force-materialize', () => {
  it('detects known provider paths', () => {
    expect(detectCloudProvider('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/soil'))
      .toBe('iCloud Drive')
    expect(detectCloudProvider('/Users/x/Dropbox/soil')).toBe('Dropbox')
    expect(detectCloudProvider('/Users/x/Google Drive/soil')).toBe('Google Drive')
    expect(detectCloudProvider('/Users/x/notes')).toBeNull()
  })

  it('reads no bodies at all when the root is a sync folder', async () => {
    const store = new IndexStore()
    await indexRoot(root, store, { skipBodyReads: true })

    const notes = store.get('soil', ['notes.md'])
    // The heading exists on disk, but was deliberately not read.
    expect(notes?.title).toBe('notes')
    expect(notes?.contentUnavailable).toBe(true)
  })

  it('marks unavailable content rather than presenting an empty document', async () => {
    const store = new IndexStore()
    await indexRoot(root, store, { skipBodyReads: true })
    for (const entry of store.all()) {
      if (entry.isMarkdown) expect(entry.contentUnavailable).toBe(true)
    }
  })
})

describe('reconciliation — bounded, and never deletes on a failed read', () => {
  it('adds a file that appeared', async () => {
    const store = new IndexStore()
    await indexRoot(root, store)
    await write('02-projects/field-review/02-work/tasks/02-next/added.md', '# Added\n')

    const result = await reconcileSubtree(root, store, ['02-projects', 'field-review'])
    expect(result.added).toBe(1)
    expect(store.get('soil', ['02-projects', 'field-review', '02-work', 'tasks', '02-next', 'added.md'])?.title)
      .toBe('Added')
  })

  it('removes a file that disappeared', async () => {
    const store = new IndexStore()
    await indexRoot(root, store)
    await fsp.unlink(join(root.absolutePath, '02-projects/field-review/02-work/tasks/02-next/added.md'))

    const result = await reconcileSubtree(root, store, ['02-projects', 'field-review'])
    expect(result.removed).toBe(1)
    expect(store.get('soil', ['02-projects', 'field-review', '02-work', 'tasks', '02-next', 'added.md']))
      .toBeUndefined()
  })

  it('removes the rows of a subtree that has EMPTIED — B4', async () => {
    // The converse of the rule below, and previously wrong: gating removal on "at least one
    // entry was seen" made an emptied subtree indistinguishable from an unreadable one, so its
    // rows survived forever and every later reconcile of that path also did nothing. A `git
    // checkout` or an agent clearing a folder — both routine — left permanent ghost rows.
    const store = new IndexStore()
    await write('emptied/a.md', '# A\n')
    await write('emptied/b.md', '# B\n')
    await indexRoot(root, store)
    expect(store.subtree('soil', ['emptied']).length).toBe(3) // dir + 2 files

    await fsp.unlink(join(root.absolutePath, 'emptied/a.md'))
    await fsp.unlink(join(root.absolutePath, 'emptied/b.md'))

    const result = await reconcileSubtree(root, store, ['emptied'])
    expect(result.removed, 'an emptied subtree must have its rows removed').toBe(2)
    expect(result.problems).toBe(0)
    expect(store.get('soil', ['emptied', 'a.md'])).toBeUndefined()
    expect(store.get('soil', ['emptied', 'b.md'])).toBeUndefined()
  })

  it('touches nothing outside the subtree it was given', async () => {
    const store = new IndexStore()
    await indexRoot(root, store)
    const before = store.get('soil', ['notes.md'])

    await reconcileSubtree(root, store, ['99-inbox-main'])

    expect(store.get('soil', ['notes.md'])).toEqual(before)
  })

  it('does NOT delete rows under a NESTED unreadable directory — B4 second pass', async () => {
    // The first B4 fix set one tree-wide flag, and only when the START path failed. A
    // permission-denied directory nested below the start left it false and every row beneath
    // that directory was removed while the files sat untouched on disk. Found by the re-gate,
    // not by this suite — the original pair of tests only ever exercised the start path.
    const store = new IndexStore()
    await write('nested/deep/a.md', '# A\n')
    await write('nested/deep/b.md', '# B\n')
    await write('nested/sibling.md', '# Sibling\n')
    await indexRoot(root, store)

    const locked = join(root.absolutePath, 'nested/deep')
    await fsp.chmod(locked, 0o000)
    try {
      const result = await reconcileSubtree(root, store, ['nested'])
      expect(result.problems, 'the unreadable directory must be reported').toBeGreaterThan(0)
      expect(result.removed, 'rows under an unreadable directory must survive').toBe(0)
      expect(store.get('soil', ['nested', 'deep', 'a.md'])).toBeDefined()
      expect(store.get('soil', ['nested', 'deep', 'b.md'])).toBeDefined()
      // The readable sibling is still verified — the guard withholds removal from the
      // unreadable subtree only, it does not disable reconciliation wholesale.
      expect(store.get('soil', ['nested', 'sibling.md'])).toBeDefined()
    } finally {
      await fsp.chmod(locked, 0o755)
    }
  })

  it('does NOT delete rows under an unreadable directory on a WHOLE-ROOT reconcile — B4 second pass', async () => {
    // The worst case, and the one the watcher actually triggers: with `segments: []` no directory
    // is ever the start path, so the original start-path-only guard was inert for the entire
    // tree. EACCES on a folder is a routine macOS state, and a watcher error requests exactly
    // this call.
    const store = new IndexStore()
    await write('rootlock/r1.md', '# R1\n')
    await write('rootlock/r2.md', '# R2\n')
    await indexRoot(root, store)

    const locked = join(root.absolutePath, 'rootlock')
    await fsp.chmod(locked, 0o000)
    try {
      const result = await reconcileSubtree(root, store, [])
      expect(result.problems).toBeGreaterThan(0)
      expect(store.get('soil', ['rootlock', 'r1.md']), 'r1 exists on disk and must stay indexed')
        .toBeDefined()
      expect(store.get('soil', ['rootlock', 'r2.md']), 'r2 exists on disk and must stay indexed')
        .toBeDefined()
    } finally {
      await fsp.chmod(locked, 0o755)
    }
  })

  it('still removes rows elsewhere when one unrelated directory is unreadable', async () => {
    // The converse guard: withholding removal under the unreadable path must not turn every
    // other removal off, or the emptied-subtree defect returns whenever any folder is locked.
    const store = new IndexStore()
    await write('locked-zone/x.md', '# X\n')
    await write('open-zone/gone.md', '# Gone\n')
    await indexRoot(root, store)
    await fsp.unlink(join(root.absolutePath, 'open-zone/gone.md'))

    const locked = join(root.absolutePath, 'locked-zone')
    await fsp.chmod(locked, 0o000)
    try {
      const result = await reconcileSubtree(root, store, [])
      expect(store.get('soil', ['open-zone', 'gone.md']), 'a genuinely deleted file must still go')
        .toBeUndefined()
      expect(store.get('soil', ['locked-zone', 'x.md']), 'the unreadable zone must be untouched')
        .toBeDefined()
      expect(result.problems).toBeGreaterThan(0)
    } finally {
      await fsp.chmod(locked, 0o755)
    }
  })

  it('does NOT delete rows when the subtree could not be read', async () => {
    // The dangerous case: an unreadable directory must never be mistaken for an empty one,
    // or reconciliation becomes a deletion of everything under it.
    const store = new IndexStore()
    await indexRoot(root, store)
    const countBefore = store.subtree('soil', ['99-inbox-main']).length
    expect(countBefore).toBeGreaterThan(0)

    const locked = join(root.absolutePath, '99-inbox-main')
    await fsp.chmod(locked, 0o000)
    try {
      const result = await reconcileSubtree(root, store, ['99-inbox-main'])
      expect(result.problems).toBeGreaterThan(0)
      expect(result.removed).toBe(0)
      expect(store.subtree('soil', ['99-inbox-main']).length).toBe(countBefore)
    } finally {
      await fsp.chmod(locked, 0o755)
    }
  })
})
