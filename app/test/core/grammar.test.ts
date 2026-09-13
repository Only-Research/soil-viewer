import { describe, expect, it } from 'vitest'
import {
  CONFLICT_SUFFIX_ALPHABET,
  CONFLICT_SUFFIX_LENGTH,
  UNCATEGORIZED_LANE_ID,
  UNCATEGORIZED_LANE_LABEL,
  compareLanes,
  enclosingProject,
  extensionOf,
  isArchived,
  isConflictArtifact,
  isIgnoredPath,
  isIgnoredSegment,
  isInboxItem,
  isInboxName,
  isLane,
  isMarkdown,
  isProject,
  isProjectRoot,
  laneDisplayName,
  lanePlacementOf,
} from '../../src/core/grammar'

/** Paths taken from the real soil, so the grammar is tested against shapes that exist. */
const REAL = {
  project: ['02-projects', 'field-review'],
  nestedProject: ['02-projects', 'field-review', '02-work', 'projects', 'op-meeting-prep'],
  laneCard: ['02-projects', 'field-review', '02-work', 'tasks', '02-next', 'card.md'],
  uncategorizedCard: ['02-projects', 'field-review', '02-work', 'tasks', 'loose.md'],
  mainInboxItem: ['99-inbox-main', 'report.md'],
}

describe('lists and the one matching rule', () => {
  it('matches a lane in every spelling', () => {
    expect(isLane('02-next')).toBe(true)
    expect(isLane('next')).toBe(true)
    expect(isLane('NEXT')).toBe(true)
    expect(isLane('2-Next')).toBe(true)
  })

  it('does not match a near miss', () => {
    expect(isLane('next-week')).toBe(false)
    expect(isLane('nextt')).toBe(false)
  })

  it('matches every inbox name the soil actually uses', () => {
    for (const name of ['01-inbox', 'inbox', '99-inbox-main', '01-department-inbox', '00-inbox']) {
      expect(isInboxName(name), name).toBe(true)
    }
  })

  it('does not treat a project folder as an inbox', () => {
    expect(isInboxName('01-internal')).toBe(false)
  })
})

describe('ignore rules — spec §3', () => {
  it('ignores every dot-prefixed name, file or directory', () => {
    // 527 .DS_Store and 823 .gitkeep in the real tree were walked and watched under v1.
    expect(isIgnoredSegment('.DS_Store')).toBe(true)
    expect(isIgnoredSegment('.gitkeep')).toBe(true)
    expect(isIgnoredSegment('.git')).toBe(true)
    expect(isIgnoredSegment('.next')).toBe(true)
  })

  it('ignores the named build directories', () => {
    for (const name of ['node_modules', 'release', 'out', 'dist']) {
      expect(isIgnoredSegment(name), name).toBe(true)
    }
  })

  it('ignores .app bundles', () => {
    expect(isIgnoredSegment('Tailscale.app')).toBe(true)
    expect(isIgnoredSegment('Some.App')).toBe(true)
  })

  it('does NOT ignore a file whose name merely contains an ignored word', () => {
    // Whole segments only. `x-node_modules.md` is an ordinary document.
    expect(isIgnoredSegment('x-node_modules.md')).toBe(false)
    expect(isIgnoredSegment('distribution')).toBe(false)
    expect(isIgnoredSegment('about.md')).toBe(false)
    expect(isIgnoredSegment('app')).toBe(false)
  })

  it('ignores a path when any segment is ignored', () => {
    expect(isIgnoredPath(['a', 'node_modules', 'b.md'])).toBe(true)
    expect(isIgnoredPath(['a', 'b.md'])).toBe(false)
  })

  it('evaluates relative to the registered root, so a root under a dot-dir is still watched', () => {
    // Spec §3. The caller passes folder-relative segments; the dot-directory the root itself
    // lives under is not part of them and therefore cannot exclude the whole tree.
    expect(isIgnoredPath(['notes', 'a.md'])).toBe(false)
  })
})

describe('archive — a match at any ancestor level', () => {
  it('excludes a subtree from the derived sets', () => {
    expect(isArchived(['02-projects', 'x', 'archive', 'old.md'])).toBe(true)
    expect(isArchived(['archive', 'old.md'])).toBe(true)
    expect(isArchived(['a', '_archive', 'old.md'])).toBe(true)
    expect(isArchived(['a', '02-archive', 'old.md'])).toBe(true)
  })

  it('does not match a name that merely contains "archive"', () => {
    expect(isArchived(['archived-notes', 'a.md'])).toBe(false)
    expect(isArchived(['a', 'archive-plan.md'])).toBe(false)
  })
})

describe('projects — resolved at walk time', () => {
  it('recognises the top-level project root', () => {
    expect(isProjectRoot(['02-projects'])).toBe(true)
    expect(isProject(REAL.project)).toBe(true)
  })

  it('recognises a project nested under 02-work/projects', () => {
    expect(isProject(REAL.nestedProject)).toBe(true)
  })

  it('recognises a project nested three levels deep', () => {
    const deep = [...REAL.nestedProject, '02-work', 'projects', 'sub-op']
    expect(isProject(deep)).toBe(true)
  })

  /**
   * **REVERSED 2026-08-28 on the ruling. The old assertion is quoted, not deleted.**
   *
   * This read *"does not treat an arbitrary folder named 'projects' as a root"*, with the comment:
   * *"Only `02-projects` at the top, or `<project>/02-work/projects`. A stray `projects` folder
   * somewhere else must not turn its children into projects."*
   *
   * That rule encoded the soil's own layout into an app whose claim is that the folder tree is the
   * state. Their words, the same day: *"the tree is not the product, the product is what holds any
   * tree of any shape"* — and *"if anyone wants to do it their way, they can do it their way."*
   *
   * So a folder called `projects` is a project root wherever it sits, and the arrangement below is
   * the case that used to be refused.
   *
   * MUTATION: restore the depth-1 / `02-work` gate. Must redden.
   */
  it('treats ANY folder named "projects" as a root, wherever it sits', () => {
    expect(isProjectRoot(['random', 'projects'])).toBe(true)
    expect(isProject(['random', 'projects', 'thing'])).toBe(true)
    // Arrangements that have nothing to do with the soil's template.
    expect(isProject(['clients', 'projects', 'acme'])).toBe(true)
    expect(isProject(['work', 'active', 'projects', 'a-thing'])).toBe(true)
  })

  /**
   * The two conventional shapes still match, because in both the folder is called `projects`. The
   * widening subsumes the old rule rather than trading one arrangement for another — worth pinning
   * separately, since "it works for everyone else now" would be a poor trade for breaking their.
   */
  it('still recognises both conventional shapes the template ships', () => {
    expect(isProjectRoot(['02-projects'])).toBe(true)
    expect(isProjectRoot(['02-projects', 'a-project', '02-work', 'projects'])).toBe(true)
  })

  /** A folder that merely CONTAINS the word is not a project root — `grammarKey`, not a substring. */
  it('does not match a folder whose name merely contains "projects"', () => {
    expect(isProjectRoot(['old-projects'])).toBe(false)
    expect(isProjectRoot(['projects-archive'])).toBe(false)
  })

  it('does not treat 02-work itself as a project', () => {
    expect(isProject(['02-projects', 'field-review', '02-work'])).toBe(false)
  })

  it('finds the enclosing project from a path inside it', () => {
    expect(enclosingProject(REAL.laneCard)).toEqual(REAL.project)
  })

  it('returns null outside any project', () => {
    expect(enclosingProject(['99-inbox-main', 'report.md'])).toBeNull()
  })

  it('finds the nearest project, not the outermost', () => {
    const inside = [...REAL.nestedProject, '00-context', 'context.md']
    expect(enclosingProject(inside)).toEqual(REAL.nestedProject)
  })
})

describe('lanes and the Uncategorized lane — spec §3', () => {
  it('places a card in its lane', () => {
    expect(lanePlacementOf(REAL.laneCard)).toEqual({ project: REAL.project, lane: '02-next' })
  })

  it('places a lane-less card in the synthetic Uncategorized lane', () => {
    // The absence of a lane folder is itself a state. No folder is ever created for this.
    expect(lanePlacementOf(REAL.uncategorizedCard)).toEqual({ project: REAL.project, lane: null })
  })

  it('the synthetic lane is labelled "Uncategorized"', () => {
    // ruled 2026-08-06, restating a decision previously settled with Ada. The working
    // label "No Status" was never the agreed name. Pinned here because the label is the part
    // they actually sees, and a rename that misses one place shows the wrong word on the board.
    expect(UNCATEGORIZED_LANE_LABEL).toBe('Uncategorized')
    expect(UNCATEGORIZED_LANE_ID).toBe('__uncategorized__')
  })

  it('does NOT treat anything deeper than an immediate lane subfolder as a card', () => {
    const tooDeep = ['02-projects', 'field-review', '02-work', 'tasks', '02-next', 'sub', 'c.md']
    expect(lanePlacementOf(tooDeep)).toBeNull()
  })

  it('does not make a card of a non-markdown file', () => {
    const image = ['02-projects', 'field-review', '02-work', 'tasks', '02-next', 'shot.png']
    expect(lanePlacementOf(image)).toBeNull()
  })

  it('does not make a card of anything inside an archive', () => {
    const archived = ['02-projects', 'field-review', 'archive', '02-work', 'tasks', '02-next', 'c.md']
    expect(lanePlacementOf(archived)).toBeNull()
  })

  it('does not make a card of a conflict artifact', () => {
    // C5: a conflict on a task in 02-next became a second card that could never be removed.
    const conflict = [
      '02-projects', 'field-review', '02-work', 'tasks', '02-next',
      'card.conflict-20260806-134700-a3f7.md',
    ]
    expect(lanePlacementOf(conflict)).toBeNull()
  })

  it('does not make a card of a tasks folder outside any project', () => {
    expect(lanePlacementOf(['tasks', '02-next', 'c.md'])).toBeNull()
  })

  it('names lanes for display without the prefix', () => {
    expect(laneDisplayName('02-next')).toBe('Next')
    expect(laneDisplayName('01-urgent')).toBe('Urgent')
    expect(laneDisplayName('03-back-burner')).toBe('Back Burner')
  })

  it('orders lanes by numeric prefix, then alphabetically', () => {
    const lanes = ['04-done', 'someday', '01-urgent', '03-back-burner', '02-next', 'later']
    expect([...lanes].sort(compareLanes)).toEqual([
      '01-urgent', '02-next', '03-back-burner', '04-done', 'later', 'someday',
    ])
  })
})

describe('isMarkdown — the one extension predicate, spec §6', () => {
  it('accepts .md in any case', () => {
    expect(isMarkdown('notes.md')).toBe(true)
    expect(isMarkdown('notes.MD')).toBe(true)
    expect(isMarkdown('notes.Md')).toBe(true)
  })

  it('rejects the near neighbours by name', () => {
    // FT-12: named and excluded so a helpful builder does not quietly widen the set.
    expect(isMarkdown('notes.markdown')).toBe(false)
    expect(isMarkdown('notes.mdx')).toBe(false)
    expect(isMarkdown('notes.mdown')).toBe(false)
    expect(isMarkdown('notes.txt')).toBe(false)
  })

  it('rejects a file with no extension', () => {
    expect(isMarkdown('README')).toBe(false)
    expect(isMarkdown('notes.')).toBe(false)
  })

  it('rejects a dotfile literally named .md', () => {
    // §13.6's slugification failure produced exactly this: a file named `.md`, hidden by the
    // dot rule and lost on creation. A leading dot is a hidden marker, not an extension.
    expect(isMarkdown('.md')).toBe(false)
  })

  it('uses the final extension only', () => {
    expect(isMarkdown('archive.md.txt')).toBe(false)
    expect(isMarkdown('notes.backup.md')).toBe(true)
  })

  it('cannot be reached by a Unicode character that lowercases toward "md"', () => {
    // ASCII-lowercasing rather than case folding is what prevents this.
    expect(isMarkdown('notes.ᴍᴅ')).toBe(false)
    expect(isMarkdown('notes.ＭＤ')).toBe(false) // fullwidth
  })

  it('extracts extensions predictably', () => {
    expect(extensionOf('a.md')).toBe('md')
    expect(extensionOf('a.tar.gz')).toBe('gz')
    expect(extensionOf('a')).toBe('')
    expect(extensionOf('.hidden')).toBe('')
  })
})

describe('conflict artifacts — spec §13.5', () => {
  it('detects the generated format', () => {
    expect(isConflictArtifact('card.conflict-20260806-134700-a3f7.md')).toBe(true)
    expect(isConflictArtifact('notes.conflict-20260101-000000-zzzz.md')).toBe(true)
  })

  it('does not match an ordinary file that mentions conflict', () => {
    expect(isConflictArtifact('conflict-resolution.md')).toBe(false)
    expect(isConflictArtifact('my.conflict.md')).toBe(false)
    expect(isConflictArtifact('card.conflict-2026-08-06.md')).toBe(false)
  })

  it('rejects a suffix outside the base32 alphabet', () => {
    // 0, 1, 8 and 9 are not in RFC 4648 base32. If P4 ever generates them, THIS test is the
    // thing that catches it — an undetected conflict artifact becomes an unremovable card (C5).
    expect(isConflictArtifact('card.conflict-20260806-134700-a3f9.md')).toBe(false)
    expect(isConflictArtifact('card.conflict-20260806-134700-0180.md')).toBe(false)
  })

  it('every character of the generator alphabet is accepted by the detector', () => {
    // Proves generation and detection agree, character by character, rather than trusting
    // that they were written from the same idea.
    for (const char of CONFLICT_SUFFIX_ALPHABET) {
      const name = `card.conflict-20260806-134700-${char.repeat(CONFLICT_SUFFIX_LENGTH)}.md`
      expect(isConflictArtifact(name), char).toBe(true)
    }
  })

  it('the alphabet is exactly RFC 4648 base32', () => {
    expect(CONFLICT_SUFFIX_ALPHABET).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')
    expect(CONFLICT_SUFFIX_ALPHABET).toHaveLength(32)
    expect(new Set(CONFLICT_SUFFIX_ALPHABET).size).toBe(32)
  })
})

describe('inbox — flat catch-all, no phase structure', () => {
  it('recognises an item directly in an inbox', () => {
    expect(isInboxItem(REAL.mainInboxItem)).toBe(true)
    expect(isInboxItem(['02-projects', 'x', '01-inbox', 'thing.md'])).toBe(true)
  })

  it('does not treat a nested item as an inbox item', () => {
    // Inboxes are flat. The pipeline/phase model was retired; agents kept assuming otherwise.
    expect(isInboxItem(['99-inbox-main', 'sub', 'thing.md'])).toBe(false)
  })

  it('does NOT treat a conflict artifact as an inbox item — spec §13.5', () => {
    // §13.5: "never a card, inbox item, project or chatroom". The card path excluded them from
    // the start; this one did not, so a conflict on an inbox note appeared as a second inbox
    // item — the C5 shape in a different tab.
    expect(isInboxItem(['99-inbox-main', 'note.conflict-20260806-134700-A3F7.md'])).toBe(false)
    expect(isInboxItem(['99-inbox-main', 'note.md'])).toBe(true)
  })

  it('excludes archived and ignored items', () => {
    expect(isInboxItem(['99-inbox-main', 'archive', 'thing.md'])).toBe(false)
    expect(isInboxItem(['.git', '01-inbox', 'thing.md'])).toBe(false)
  })
})
