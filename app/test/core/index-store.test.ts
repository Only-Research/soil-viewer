import { beforeEach, describe, expect, it } from 'vitest'
import { IndexStore, inodeKey, type IndexEntry } from '../../src/core/index-store'

let store: IndexStore
let nextIno = 100n

function entry(segments: string[], overrides: Partial<IndexEntry> = {}): IndexEntry {
  const name = segments[segments.length - 1] ?? ''
  return {
    rootId: 'soil',
    segments,
    name,
    kind: name.includes('.') ? 'file' : 'directory',
    title: name,
    size: 10,
    mtimeNs: 1n,
    dev: 1n,
    ino: nextIno++,
    isMarkdown: name.endsWith('.md'),
    contentUnavailable: false,
    ...overrides,
  }
}

beforeEach(() => {
  store = new IndexStore()
  store.registerRootCasing('soil', true)
  nextIno = 100n
})

describe('incremental updates', () => {
  it('stores and retrieves one entry', () => {
    const e = entry(['notes.md'])
    store.upsert(e)
    expect(store.get('soil', ['notes.md'])).toEqual(e)
    expect(store.size).toBe(1)
  })

  it('replaces an entry without touching its neighbours', () => {
    store.upsert(entry(['a.md'], { title: 'A' }))
    store.upsert(entry(['b.md'], { title: 'B' }))
    const before = store.get('soil', ['b.md'])

    store.upsert(entry(['a.md'], { title: 'A revised' }))

    expect(store.get('soil', ['a.md'])?.title).toBe('A revised')
    expect(store.get('soil', ['b.md'])).toEqual(before)
    expect(store.size).toBe(2)
  })

  it('returns the previous entry when replacing', () => {
    store.upsert(entry(['a.md'], { title: 'first' }))
    const previous = store.upsert(entry(['a.md'], { title: 'second' }))
    expect(previous?.title).toBe('first')
  })

  it('removes an entry and reports what it removed', () => {
    store.upsert(entry(['a.md'], { title: 'gone' }))
    expect(store.remove('soil', ['a.md'])?.title).toBe('gone')
    expect(store.get('soil', ['a.md'])).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('removing something absent is not an error and reports nothing', () => {
    expect(store.remove('soil', ['nope.md'])).toBeUndefined()
  })
})

describe('identity is (dev, ino), not a path — spec §4', () => {
  it('finds an entry by its inode', () => {
    store.upsert(entry(['a.md'], { dev: 7n, ino: 42n }))
    expect(store.getByInode(7n, 42n)?.name).toBe('a.md')
  })

  it('follows the inode when a file is renamed', () => {
    store.upsert(entry(['old.md'], { dev: 7n, ino: 42n }))
    store.upsert(entry(['new.md'], { dev: 7n, ino: 42n }))
    store.remove('soil', ['old.md'])

    // Same inode, new name — the identity survived the rename.
    expect(store.getByInode(7n, 42n)?.name).toBe('new.md')
  })

  it('does not confuse the same inode number on different volumes', () => {
    store.upsert(entry(['a.md'], { dev: 1n, ino: 42n }))
    store.upsert(entry(['b.md'], { dev: 2n, ino: 42n }))
    expect(store.getByInode(1n, 42n)?.name).toBe('a.md')
    expect(store.getByInode(2n, 42n)?.name).toBe('b.md')
  })

  it('drops the inode mapping when the entry goes', () => {
    store.upsert(entry(['a.md'], { dev: 7n, ino: 42n }))
    store.remove('soil', ['a.md'])
    expect(store.getByInode(7n, 42n)).toBeUndefined()
  })

  it('builds distinct inode keys', () => {
    expect(inodeKey(1n, 2n)).not.toBe(inodeKey(2n, 1n))
  })
})

describe('children — a lookup, not a scan', () => {
  beforeEach(() => {
    store.upsert(entry(['docs']))
    store.upsert(entry(['docs', 'a.md']))
    store.upsert(entry(['docs', 'b.md']))
    store.upsert(entry(['docs', 'deep']))
    store.upsert(entry(['docs', 'deep', 'c.md']))
    store.upsert(entry(['other.md']))
  })

  it('returns immediate children only', () => {
    const names = store.childrenOf('soil', ['docs']).map(e => e.name).sort()
    expect(names).toEqual(['a.md', 'b.md', 'deep'])
  })

  it('returns top-level entries for the root', () => {
    const names = store.childrenOf('soil', []).map(e => e.name).sort()
    expect(names).toEqual(['docs', 'other.md'])
  })

  it('returns nothing for a leaf', () => {
    expect(store.childrenOf('soil', ['other.md'])).toEqual([])
  })

  it('stops listing a child once it is removed', () => {
    store.remove('soil', ['docs', 'a.md'])
    const names = store.childrenOf('soil', ['docs']).map(e => e.name).sort()
    expect(names).toEqual(['b.md', 'deep'])
  })
})

describe('subtree — segment boundaries, not string prefixes', () => {
  beforeEach(() => {
    store.upsert(entry(['notes']))
    store.upsert(entry(['notes', 'a.md']))
    store.upsert(entry(['notes', 'sub', 'b.md']))
    store.upsert(entry(['notes-old']))
    store.upsert(entry(['notes-old', 'c.md']))
  })

  it('collects everything beneath a path, inclusive', () => {
    const names = store.subtree('soil', ['notes']).map(e => e.name).sort()
    expect(names).toEqual(['a.md', 'b.md', 'notes'])
  })

  it('does NOT sweep up a sibling whose name starts with the same string', () => {
    // The lab bug, as a test: /soil/notes must not match /soil/notes-old. A reconciliation
    // that got this wrong would re-index and possibly evict an unrelated folder's rows.
    const names = store.subtree('soil', ['notes']).map(e => e.name)
    expect(names).not.toContain('c.md')
    expect(names).not.toContain('notes-old')
  })

  it('returns the whole root for an empty path', () => {
    expect(store.subtree('soil', []).length).toBe(5)
  })
})

describe('per-root case sensitivity — spec §4', () => {
  it('treats case variants as one entry on a case-insensitive root', () => {
    store.registerRootCasing('soil', true)
    store.upsert(entry(['Notes.md'], { title: 'first' }))
    store.upsert(entry(['notes.md'], { title: 'second' }))
    expect(store.size).toBe(1)
    expect(store.get('soil', ['NOTES.MD'])?.title).toBe('second')
  })

  it('keeps case variants separate on a case-sensitive root', () => {
    store.registerRootCasing('sensitive', false)
    store.upsert(entry(['Notes.md'], { rootId: 'sensitive', title: 'upper' }))
    store.upsert(entry(['notes.md'], { rootId: 'sensitive', title: 'lower' }))
    expect(store.size).toBe(2)
    expect(store.get('sensitive', ['Notes.md'])?.title).toBe('upper')
    expect(store.get('sensitive', ['notes.md'])?.title).toBe('lower')
  })

  it('matches NFC and NFD spellings of one name', () => {
    store.upsert(entry(['café.md'], { title: 'composed' }))
    expect(store.get('soil', ['café.md'])?.title).toBe('composed')
    expect(store.size).toBe(1)
  })

  it('keeps roots separate even at identical paths', () => {
    store.registerRootCasing('other', true)
    store.upsert(entry(['a.md'], { title: 'in soil' }))
    store.upsert(entry(['a.md'], { rootId: 'other', title: 'in other' }))
    expect(store.size).toBe(2)
    expect(store.get('soil', ['a.md'])?.title).toBe('in soil')
    expect(store.get('other', ['a.md'])?.title).toBe('in other')
  })
})

describe('clearRoot', () => {
  it('drops one root and leaves the others intact', () => {
    store.registerRootCasing('other', true)
    store.upsert(entry(['a.md']))
    store.upsert(entry(['dir']))
    store.upsert(entry(['dir', 'b.md']))
    store.upsert(entry(['a.md'], { rootId: 'other' }))

    expect(store.clearRoot('soil')).toBe(3)
    expect(store.size).toBe(1)
    expect(store.get('other', ['a.md'])).toBeDefined()
    expect(store.childrenOf('soil', ['dir'])).toEqual([])
  })

  it('drops the inode mappings of what it cleared', () => {
    store.upsert(entry(['a.md'], { dev: 9n, ino: 1n }))
    store.clearRoot('soil')
    expect(store.getByInode(9n, 1n)).toBeUndefined()
  })
})

describe('what the index refuses to hold — spec §5 budget', () => {
  it('has no field for file contents', () => {
    const e = entry(['a.md'])
    // Bodies would be hundreds of MB resident at the 10,000-file target, for data that is
    // re-read on open anyway. If a `content` field ever appears here, this fails.
    expect(Object.keys(e).sort()).toEqual([
      'contentUnavailable', 'dev', 'ino', 'isMarkdown', 'kind', 'mtimeNs',
      'name', 'rootId', 'segments', 'size', 'title',
    ])
  })
})
