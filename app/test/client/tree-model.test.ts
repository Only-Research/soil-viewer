import { describe, expect, it } from 'vitest'

import type { WireEntry } from '../../src/contract/wire'
import {
  MAX_TYPE_CHARS,
  MAX_VISIBLE_ROWS,
  ancestorKeys,
  displayName,
  rowKey,
  sortEntries,
  typeLabelFor,
  visibleRows,
} from '../../src/client/files/tree-model'

const entry = (
  segments: string[],
  overrides: Partial<WireEntry> = {},
): WireEntry => {
  const name = segments[segments.length - 1] ?? ''
  return {
    rootId: 'soil',
    segments,
    name,
    kind: 'file',
    title: name,
    size: 10,
    modifiedMs: 0,
    isMarkdown: name.endsWith('.md'),
    contentUnavailable: false,
    token: 'tok',
    ...overrides,
  }
}

const folder = (segments: string[]): WireEntry => entry(segments, { kind: 'directory', isMarkdown: false })

describe('the name a person reads', () => {
  it('strips .md and turns hyphens into spaces', () => {
    expect(displayName(entry(['my-meeting-notes.md']))).toBe('my meeting notes')
  })

  it('turns underscores into spaces too, and collapses runs', () => {
    expect(displayName(entry(['a__b--c.md']))).toBe('a b c')
  })

  it('leaves a non-markdown extension alone — it is part of what the file IS', () => {
    expect(displayName(entry(['orchard-photo.png']))).toBe('orchard photo.png')
  })

  /**
   * **ruled 2026-08-09: *"keeping 00-context is paramount."*** Folder names are the
   * grammar of this tree — the app matches paths on them and they navigate by them — so they are
   * shown exactly as they are on disk. The PRD's prettifying applies to files, which are prose
   * that was hyphenated only because a filename cannot hold a space.
   */
  it('shows a FOLDER exactly as it is on disk, hyphens and all', () => {
    expect(displayName(folder(['00-context']))).toBe('00-context')
    expect(displayName(folder(['02-work']))).toBe('02-work')
    expect(displayName(folder(['99-inbox-main']))).toBe('99-inbox-main')
    expect(displayName(folder(['notes-internal-projects']))).toBe('notes-internal-projects')
  })

  it('still prettifies FILES, which is where the rule belongs', () => {
    expect(displayName(entry(['m-thread-soil-viewer-build.md'])))
      .toBe('m thread soil viewer build')
  })

  it('keeps a numeric prefix on a file too, unlike a lane', () => {
    // `grammar.ts` strips these for lanes, where the prefix is ordering and the name is a status.
    expect(displayName(entry(['01-first-draft.md']))).toBe('01 first draft')
  })

  it('is case-insensitive about the extension', () => {
    expect(displayName(entry(['NOTES.MD'], { isMarkdown: true }))).toBe('NOTES')
  })
})

/**
 * **THE TYPE LABEL, which replaced the leading glyph.** Packet §4.2.
 *
 * The glyph drew `▸` on a folder beside the twisty's own `▸` — the double arrow the operator reported —
 * and `·` or `□` on every file. The tests it had asserted that the four glyphs were distinct
 * monospace characters, which was true of the version that put two triangles on every folder row:
 * **they were tests of the encoding, not of what the row communicated.**
 */
describe('the type label', () => {
  it('says nothing for the two cases that need no explanation', () => {
    // A folder is marked by its twisty; a markdown file is what nearly everything here is.
    expect(typeLabelFor(folder(['x']))).toBe('')
    expect(typeLabelFor(entry(['a.md'], { isMarkdown: true }))).toBe('')
  })

  it('names the type of anything else, in caps', () => {
    expect(typeLabelFor(entry(['a.png']))).toBe('PNG')
    expect(typeLabelFor(entry(['rows.csv']))).toBe('CSV')
    // Case-folded, so `PHOTO.PNG` and `photo.png` do not read as two different types.
    expect(typeLabelFor(entry(['PHOTO.PNG']))).toBe('PNG')
  })

  it('labels a symlink, which §11 refuses to follow', () => {
    // The one row where an open behaves differently. A row that gave no sign would be the only
    // place a person could not tell why.
    expect(typeLabelFor(entry(['l'], { kind: 'symlink' }))).toBe('LINK')
  })

  it('treats a leading dot as a name, not an extension', () => {
    // `.gitkeep` has no extension. `GITKEEP` at the end of the row would be the whole filename
    // repeated in caps.
    expect(typeLabelFor(entry(['.gitkeep']))).toBe('')
  })

  it('says nothing when the "extension" is really the rest of the filename', () => {
    // Twenty-two characters of dim caps would push the name out of a 272px sidebar.
    expect(typeLabelFor(entry(['notes.thisisnotanextension']))).toBe('')
    // The boundary itself, so the cap is a decision rather than an accident.
    expect(typeLabelFor(entry([`a.${'x'.repeat(MAX_TYPE_CHARS)}`]))).toBe('X'.repeat(MAX_TYPE_CHARS))
    expect(typeLabelFor(entry([`a.${'x'.repeat(MAX_TYPE_CHARS + 1)}`]))).toBe('')
  })

  it('says nothing for a file with no dot at all', () => {
    expect(typeLabelFor(entry(['Makefile']))).toBe('')
  })
})

describe('the order', () => {
  it('puts folders before files whatever their names', () => {
    const sorted = sortEntries([entry(['a.md']), folder(['z-folder']), entry(['b.md'])])
    expect(sorted.map(e => e.name)).toEqual(['z-folder', 'a.md', 'b.md'])
  })

  it('sorts numerically, so 10 comes after 9', () => {
    const sorted = sortEntries([folder(['10-ten']), folder(['9-nine']), folder(['02-two'])])
    expect(sorted.map(e => e.name)).toEqual(['02-two', '9-nine', '10-ten'])
  })

  /**
   * **The first version of this test did not catch the thing it was written for.**
   *
   * It used `ab.md` against `a-b.md`, reasoning that "a b" and "ab" must order differently. Under
   * `localeCompare` at base sensitivity they do not — punctuation and spaces are largely ignored,
   * so the two comparisons agree and the mutation that sorts on `displayName` sailed through.
   *
   * The pair below was found by generating filenames and diffing the two orderings rather than by
   * reasoning a second time: 48 divergent pairs out of 702. `a_b.md` versus `a-1.md` is a genuine
   * swap — by stored name the underscore sorts first, by display name `a b` sorts after `a 1`.
   */
  it('sorts on the STORED name, not the prettified one', () => {
    const sorted = sortEntries([entry(['a-1.md']), entry(['a_b.md'])])
    expect(sorted.map(e => e.name)).toEqual(['a_b.md', 'a-1.md'])
  })

  it('keeps two files that PRETTIFY IDENTICALLY in a deterministic order', () => {
    // `a-b.md` and `a_b.md` both display as "a b". Sorting on the display name makes them
    // equal, so their order becomes whatever the sort happens to do — and the tree reshuffles
    // between renders for no visible reason.
    // The underscore sorts first here, which is not obvious and is not the point — the point is
    // that there IS an order and it does not depend on the input order.
    expect(sortEntries([entry(['a_b.md']), entry(['a-b.md'])]).map(e => e.name))
      .toEqual(['a_b.md', 'a-b.md'])
    expect(sortEntries([entry(['a-b.md']), entry(['a_b.md'])]).map(e => e.name))
      .toEqual(['a_b.md', 'a-b.md'])
  })

  it('does not mutate what it was given', () => {
    const input = [entry(['b.md']), entry(['a.md'])]
    sortEntries(input)
    expect(input.map(e => e.name)).toEqual(['b.md', 'a.md'])
  })
})

describe('row keys', () => {
  it('cannot be forged by naming a file after the separator', () => {
    /**
     * The reason the separator is NUL. With `/`, a root called `soil` holding `a/b` would key
     * identically to a root called `soil/a` holding `b` — and expansion state, which is stored
     * under this key, would leak between them. NUL is the one byte a macOS filename cannot hold.
     */
    expect(rowKey('soil', ['a', 'b'])).not.toBe(rowKey('soil/a', ['b']))
    expect(rowKey('soil', ['a/b'])).not.toBe(rowKey('soil', ['a', 'b']))
  })

  it('is stable for the same path', () => {
    expect(rowKey('soil', ['a', 'b'])).toBe(rowKey('soil', ['a', 'b']))
  })
})

describe('auto-expanding to an open file', () => {
  it('names every folder containing it, outermost first, and not the file', () => {
    expect(ancestorKeys('soil', ['02-projects', 'orchard', 'notes.md'])).toEqual([
      rowKey('soil', []),
      rowKey('soil', ['02-projects']),
      rowKey('soil', ['02-projects', 'orchard']),
    ])
  })

  it('a file at the top of a folder needs only the root expanded', () => {
    expect(ancestorKeys('soil', ['notes.md'])).toEqual([rowKey('soil', [])])
  })
})

describe('the visible rows', () => {
  const tree = new Map<string, WireEntry[]>([
    [rowKey('soil', []), [folder(['projects']), entry(['readme.md'])]],
    [rowKey('soil', ['projects']), [folder(['projects', 'orchard']), entry(['projects', 'a.md'])]],
    [rowKey('soil', ['projects', 'orchard']), [entry(['projects', 'orchard', 'deep.md'])]],
  ])
  const childrenOf = (rootId: string, segments: readonly string[]) =>
    tree.get(rowKey(rootId, segments))

  it('shows only the top level when nothing is expanded', () => {
    const { rows } = visibleRows({ rootIds: ['soil'], expanded: new Set(), childrenOf })
    expect(rows.map(r => r.entry.name)).toEqual(['projects', 'readme.md'])
    expect(rows.every(r => r.depth === 0)).toBe(true)
  })

  it('descends into expanded folders, depth-first, with the right indent', () => {
    const expanded = new Set([rowKey('soil', ['projects'])])
    const { rows } = visibleRows({ rootIds: ['soil'], expanded, childrenOf })
    expect(rows.map(r => [r.entry.name, r.depth])).toEqual([
      ['projects', 0], ['orchard', 1], ['a.md', 1], ['readme.md', 0],
    ])
  })

  it('expands the whole chain when every ancestor is expanded', () => {
    const expanded = new Set(ancestorKeys('soil', ['projects', 'orchard', 'deep.md']))
    const { rows } = visibleRows({ rootIds: ['soil'], expanded, childrenOf })
    expect(rows.map(r => r.entry.name)).toContain('deep.md')
  })

  /**
   * §6's rule applied to a screen: an empty result never stands in for "not known".
   */
  it('an unloaded folder contributes no rows and is still marked expandable', () => {
    const expanded = new Set([rowKey('soil', ['projects'])])
    const { rows } = visibleRows({
      rootIds: ['soil'],
      expanded,
      // Nothing is loaded below the top level.
      childrenOf: (rootId, segments) =>
        segments.length === 0 ? tree.get(rowKey(rootId, [])) : undefined,
    })
    expect(rows.map(r => r.entry.name)).toEqual(['projects', 'readme.md'])
    expect(rows[0]?.expandable).toBe(true)
    expect(rows[0]?.expanded).toBe(true)
    // The distinction the view needs: expanded, but nothing has arrived. Rendering this as an
    // empty folder is §6's banned substitution on a screen.
    expect(rows[0]?.childrenLoaded).toBe(false)
  })

  it('marks an expanded folder whose children HAVE arrived, empty or not', () => {
    const withEmpty = new Map(tree)
    withEmpty.set(rowKey('soil', ['projects']), [])
    const { rows } = visibleRows({
      rootIds: ['soil'],
      expanded: new Set([rowKey('soil', ['projects'])]),
      childrenOf: (rootId, segments) => withEmpty.get(rowKey(rootId, segments)),
    })
    // A genuinely empty folder and an unfetched one produce the same zero rows, and must not
    // produce the same row STATE — one says "nothing here", the other says "not known yet".
    expect(rows[0]?.childrenLoaded).toBe(true)
  })

  it('does not claim loaded children for a folder nobody expanded', () => {
    const { rows } = visibleRows({ rootIds: ['soil'], expanded: new Set(), childrenOf })
    expect(rows[0]?.expanded).toBe(false)
    expect(rows[0]?.childrenLoaded).toBe(false)
  })

  it('marks a file as neither expandable nor expanded, even if its key is in the set', () => {
    // A stale expansion set restored from a previous session can name a path that is now a file.
    const expanded = new Set([rowKey('soil', ['readme.md'])])
    const { rows } = visibleRows({ rootIds: ['soil'], expanded, childrenOf })
    const file = rows.find(r => r.entry.name === 'readme.md')
    expect(file?.expandable).toBe(false)
    expect(file?.expanded).toBe(false)
  })

  it('walks several registered folders in the order given', () => {
    const two = new Map(tree)
    two.set(rowKey('other', []), [entry(['x.md'], { rootId: 'other' })])
    const { rows } = visibleRows({
      rootIds: ['soil', 'other'],
      expanded: new Set(),
      childrenOf: (rootId, segments) => two.get(rowKey(rootId, segments)),
    })
    expect(rows.map(r => r.entry.rootId)).toEqual(['soil', 'soil', 'other'])
  })

  describe('the ceiling', () => {
    const wide = new Map<string, WireEntry[]>([
      [rowKey('soil', []), Array.from({ length: 500 }, (_, i) => entry([`f${i}.md`]))],
    ])
    const wideChildren = (rootId: string, segments: readonly string[]) =>
      wide.get(rowKey(rootId, segments))

    it('stops at the limit and SAYS SO', () => {
      const { rows, truncated } = visibleRows({
        rootIds: ['soil'], expanded: new Set(), childrenOf: wideChildren, limit: 100,
      })
      expect(rows).toHaveLength(100)
      // A tree that quietly stops is a file that appears not to exist.
      expect(truncated).toBe(true)
    })

    it('does not claim truncation when everything fits', () => {
      const { truncated } = visibleRows({
        rootIds: ['soil'], expanded: new Set(), childrenOf: wideChildren, limit: 1000,
      })
      expect(truncated).toBe(false)
    })

    it('defaults to a ceiling well above any real screenful', () => {
      expect(MAX_VISIBLE_ROWS).toBeGreaterThan(10_000)
    })
  })

  /**
   * The PRD's floor is 10,000 markdown files. This is the model's half of that number: building
   * the row list for a large expanded tree must not be the thing that hangs the browser.
   */
  it('builds 10,000 rows quickly', () => {
    const big = new Map<string, WireEntry[]>([
      [rowKey('soil', []), Array.from({ length: 100 }, (_, i) => folder([`d${i}`]))],
    ])
    for (let i = 0; i < 100; i += 1) {
      big.set(rowKey('soil', [`d${i}`]),
        Array.from({ length: 100 }, (_, j) => entry([`d${i}`, `f${j}.md`])))
    }
    const expanded = new Set(Array.from({ length: 100 }, (_, i) => rowKey('soil', [`d${i}`])))

    const started = performance.now()
    const { rows, truncated } = visibleRows({
      rootIds: ['soil'],
      expanded,
      childrenOf: (rootId, segments) => big.get(rowKey(rootId, segments)),
    })
    const elapsed = performance.now() - started

    expect(rows).toHaveLength(10_100)
    expect(truncated).toBe(false)
    // Generous, because a shared CI box is not a benchmark rig. It is a smoke alarm for an
    // accidental quadratic, not a performance assertion.
    expect(elapsed, `took ${elapsed.toFixed(0)}ms`).toBeLessThan(1_000)
  })
})

/**
 * A REGISTERED FOLDER'S OWN ROW. Added 2026-08-09 alongside Settings → Folders.
 *
 * Until Settings shipped, a registered folder had no row: the tree drew a root's **contents** at
 * depth 0 and never the root itself. Exactly right for one folder, and unusable for two — the two
 * folders' children interleave at the same depth, sorted together, with nothing saying which folder
 * a row belongs to and no way to collapse either. A newly added **empty** folder contributed no
 * rows at all, so "add a folder to the file tree" produced a folder that was not in the tree.
 *
 * **These tests exist because a mutation sweep found none.** Forcing `showRoots` to `false` left
 * every unit test green; only the end-to-end drive noticed. That is this phase's signature failure
 * shape one more time — a control whose absence nothing local can see.
 */
describe('a registered folder\'s own row', () => {
  const tree = new Map<string, WireEntry[]>([
    [rowKey('soil', []), [entry(['readme.md'])]],
    [rowKey('notes', []), [entry(['jot.md'], { rootId: 'notes' })]],
  ])
  const childrenOf = (rootId: string, segments: readonly string[]) =>
    tree.get(rowKey(rootId, segments))
  const names = new Map([['soil', 'notes'], ['notes', 'notes']])

  it('is absent when no names are supplied — the walk-only shape', () => {
    const { rows } = visibleRows({ rootIds: ['soil'], expanded: new Set(), childrenOf })
    expect(rows.map(r => r.entry.name)).toEqual(['readme.md'])
  })

  it('is drawn for a single folder too, not only when there are several', () => {
    /**
     * The asymmetry this replaces was worse than the disruption it avoided: making root rows
     * conditional on a second folder puts a **shape change** on the far side of a registration, so
     * the tree reorganises itself the moment something is added. It also made the end-to-end suite
     * nondeterministic, since two engines share one server.
     */
    const { rows } = visibleRows({
      rootIds: ['soil'], expanded: new Set(), childrenOf, rootNames: names,
    })
    expect(rows.map(r => [r.entry.name, r.depth])).toEqual([['notes', 0]])
    expect(rows[0]?.isRoot).toBe(true)
    expect(rows[0]?.expandable).toBe(true)
  })

  it('indents the folder\'s contents beneath it once expanded', () => {
    const { rows } = visibleRows({
      rootIds: ['soil'],
      expanded: new Set([rowKey('soil', [])]),
      childrenOf,
      rootNames: names,
    })
    expect(rows.map(r => [r.entry.name, r.depth])).toEqual([['notes', 0], ['readme.md', 1]])
  })

  /**
   * The case the row exists for. Without it these two files sit side by side at depth 0, sorted
   * together, and nothing on screen says they live in different folders.
   */
  it('keeps two folders\' contents apart, each under its own row', () => {
    const { rows } = visibleRows({
      rootIds: ['soil', 'notes'],
      expanded: new Set([rowKey('soil', []), rowKey('notes', [])]),
      childrenOf,
      rootNames: names,
    })
    expect(rows.map(r => [r.entry.name, r.depth])).toEqual([
      ['notes', 0], ['readme.md', 1], ['notes', 0], ['jot.md', 1],
    ])
  })

  /**
   * An empty registered folder still appears. This is the literal complaint the row was added for:
   * a folder added from Settings has nothing in it yet, and contributed no rows at all.
   */
  it('appears even when the folder is empty', () => {
    const { rows } = visibleRows({
      rootIds: ['fresh'],
      expanded: new Set([rowKey('fresh', [])]),
      childrenOf: () => [],
      rootNames: new Map([['fresh', 'fresh']]),
    })
    expect(rows.map(r => r.entry.name)).toEqual(['fresh'])
  })

  /**
   * §13.8's token, empty and required to stay empty. A root is not an entity the server ever
   * described, so there is no token; a plausible-looking one would let a mutation aimed at this row
   * carry something the server would then compare against a real entity. Empty is not a valid
   * token, so such a request is refused rather than mis-matched.
   */
  it('carries no identity token and no fabricated timestamp', () => {
    const { rows } = visibleRows({
      rootIds: ['soil'], expanded: new Set(), childrenOf, rootNames: names,
    })
    expect(rows[0]?.entry.token).toBe('')
    expect(rows[0]?.entry.modifiedMs).toBe(0)
    expect(rows[0]?.entry.segments).toEqual([])
  })

  it('falls back to the folder id when no name was supplied for it', () => {
    const { rows } = visibleRows({
      rootIds: ['soil'], expanded: new Set(), childrenOf, rootNames: new Map(),
    })
    // Never blank: a nameless row is one a person cannot click on purpose.
    expect(rows.map(r => r.entry.name)).toEqual(['soil'])
  })
})
