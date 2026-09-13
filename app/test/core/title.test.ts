import { describe, expect, it } from 'vitest'
import {
  MAX_TITLE_CHARS,
  TITLE_SCAN_BYTES,
  decodeScanWindow,
  extractTitle,
  titleFor,
} from '../../src/core/title'

describe('ordinary headings', () => {
  it('takes the first ATX heading', () => {
    expect(extractTitle('# Notes\n\nbody\n')).toBe('Notes')
  })

  it('takes the first heading, not the largest', () => {
    expect(extractTitle('### Small\n\n# Big\n')).toBe('Small')
  })

  it('accepts every ATX level', () => {
    for (let level = 1; level <= 6; level++) {
      expect(extractTitle(`${'#'.repeat(level)} Title`)).toBe('Title')
    }
  })

  it('rejects seven hashes — not a heading in CommonMark', () => {
    expect(extractTitle('####### Nope')).toBeNull()
  })

  it('requires a space after the hashes', () => {
    // CommonMark: `#hashtag` is a paragraph. Treating it as a heading would turn every
    // inline tag at line start into a card title.
    expect(extractTitle('#hashtag\n')).toBeNull()
    expect(extractTitle('#soil-notes\n')).toBeNull()
  })

  it('allows up to three leading spaces, but not four', () => {
    expect(extractTitle('   # Indented')).toBe('Indented')
    expect(extractTitle('    # Four spaces is code')).toBeNull()
  })

  it('strips an ATX closing sequence', () => {
    expect(extractTitle('## Title ##')).toBe('Title')
    expect(extractTitle('## Title')).toBe('Title')
  })

  it('keeps a trailing hash that is part of the text', () => {
    expect(extractTitle('# C#')).toBe('C#')
  })

  it('returns null for an empty heading rather than an empty title', () => {
    expect(extractTitle('#\n')).toBeNull()
    expect(extractTitle('#   \n')).toBeNull()
  })

  it('handles CRLF line endings', () => {
    expect(extractTitle('# Windows\r\n\r\nbody\r\n')).toBe('Windows')
  })
})

// FT-8. 602 real files in the soil open with `---`, and a YAML comment is a `#` at line start.
describe('frontmatter — the FT-8 bug', () => {
  it('does NOT take a YAML comment as the title', () => {
    const doc = '---\n# this is a yaml comment\nname: thing\n---\n\n# Real Title\n'
    expect(extractTitle(doc)).toBe('Real Title')
  })

  it('skips an ordinary frontmatter block', () => {
    expect(extractTitle('---\ntitle: x\ntags: [a]\n---\n\n# Heading\n')).toBe('Heading')
  })

  it('accepts the ... terminator', () => {
    expect(extractTitle('---\ntitle: x\n...\n\n# Heading\n')).toBe('Heading')
  })

  it('returns null for an unterminated block rather than guessing from YAML', () => {
    expect(extractTitle('---\n# comment\nname: x\n')).toBeNull()
  })

  it('treats --- as a thematic break when it is NOT the first line', () => {
    // Only line 1 opens frontmatter. A `---` after a BLANK line is a thematic break: it
    // underlines nothing, so the real heading below it is still the title.
    expect(extractTitle('intro text\n\n---\n\n# Heading\n')).toBe('Heading')
  })

  it('a leading blank line means the block is NOT frontmatter', () => {
    // Sharper than it looks: with no blank line this is frontmatter and the title is
    // "Heading". With one, `title: x` is an ordinary paragraph underlined by `---`, which
    // makes it a setext heading. CommonMark agrees. Frontmatter is line 1 or nothing.
    expect(extractTitle('---\ntitle: x\n---\n# Heading\n')).toBe('Heading')
    expect(extractTitle('\n---\ntitle: x\n---\n# Heading\n')).toBe('title: x')
  })

  it('treats --- directly under a paragraph as a setext underline, not frontmatter', () => {
    // The distinguishing case for the rule above: no blank line, so this IS a heading.
    expect(extractTitle('intro text\n---\n')).toBe('intro text')
  })

  it('finds no heading in a file that is only frontmatter', () => {
    expect(extractTitle('---\ntitle: x\n---\n')).toBeNull()
  })

  it('never sweeps a thematic break into a heading', () => {
    // A divider is a block element, not text. Without this it gets glued onto the front of
    // the next setext heading.
    expect(extractTitle('\n---\ntitle: x\n---\n')).toBe('title: x')
    expect(extractTitle('***\n\nSetext\n=====\n')).toBe('Setext')
    expect(extractTitle('___\n\n# ATX\n')).toBe('ATX')
  })
})

// The code-fence heading bug from the old codebase.
describe('fenced code — the code-fence heading bug', () => {
  it('does NOT take a heading from inside a backtick fence', () => {
    expect(extractTitle('```\n# not a title\n```\n\n# Real\n')).toBe('Real')
  })

  it('does NOT take a heading from inside a tilde fence', () => {
    expect(extractTitle('~~~\n# not a title\n~~~\n\n# Real\n')).toBe('Real')
  })

  it('handles a fence with an info string', () => {
    expect(extractTitle('```bash\n# a shell comment\n```\n\n# Real\n')).toBe('Real')
  })

  it('does not close a backtick fence with a tilde fence', () => {
    expect(extractTitle('```\n# inside\n~~~\n# still inside\n```\n\n# Real\n')).toBe('Real')
  })

  it('requires the closing fence to be at least as long as the opener', () => {
    expect(extractTitle('````\n# inside\n```\n# still inside\n````\n\n# Real\n')).toBe('Real')
  })

  it('returns null when every heading is fenced', () => {
    expect(extractTitle('```\n# only inside\n```\n')).toBeNull()
  })

  it('finds a heading after an unterminated fence only if there is none inside', () => {
    // An unclosed fence swallows the rest of the document — which is what CommonMark does.
    expect(extractTitle('```\n# swallowed\n\n# also swallowed\n')).toBeNull()
  })
})

describe('indented code', () => {
  it('does not take a heading from an indented code block', () => {
    expect(extractTitle('    # indented code\n\n# Real\n')).toBe('Real')
  })

  it('skips an indented block and still finds the real heading after it', () => {
    expect(extractTitle('    # indented code\n    more code\n\n# Real\n')).toBe('Real')
  })

  it('does not let an indented line end a paragraph early', () => {
    // The indented line continues the paragraph rather than starting a code block, so the
    // `---` beneath it still underlines that paragraph.
    expect(extractTitle('some text\n    continued\n---\n')).toBe('some text continued')
  })
})

describe('setext headings', () => {
  it('takes a setext heading underlined with =', () => {
    expect(extractTitle('My Title\n========\n\nbody\n')).toBe('My Title')
  })

  it('takes a setext heading underlined with -', () => {
    expect(extractTitle('My Title\n--------\n')).toBe('My Title')
  })

  it('does not treat a leading --- as a setext underline for a missing line', () => {
    expect(extractTitle('---\nname: x\n---\n# Real\n')).toBe('Real')
  })

  it('uses the WHOLE preceding paragraph, not just the line above the underline', () => {
    // CommonMark's setext content is the full paragraph. Keeping only the last line would
    // silently truncate a two-line title.
    expect(extractTitle('First line\nsecond line\n======\n')).toBe('First line second line')
  })

  it('prefers whichever heading comes first', () => {
    expect(extractTitle('Setext\n======\n\n# ATX\n')).toBe('Setext')
    expect(extractTitle('# ATX\n\nSetext\n======\n')).toBe('ATX')
  })
})

describe('budgets — spec §5', () => {
  /**
   * **The literal is asserted, not the constant.** Both of these read `expect(...).toBe(CONSTANT)`,
   * which is the shape of a test that cannot fail: set `MAX_TITLE_CHARS = 500` and the truncation
   * becomes a no-op while the assertion still holds; set `TITLE_SCAN_BYTES = 0` and the window
   * collapses to nothing, which is still `TITLE_SCAN_BYTES`. Each test name quoted a number its
   * body never checked.
   *
   * The constant is asserted separately, so a deliberate change to the budget fails here and is
   * made on purpose rather than absorbed silently.
   */
  it('truncates a long title to 200 characters', () => {
    expect(MAX_TITLE_CHARS, 'the budget itself — change this on purpose, not by accident').toBe(200)

    const title = extractTitle(`# ${'x'.repeat(500)}`)
    expect(title).toHaveLength(200)
  })

  it('only decodes the first 64 KiB', () => {
    expect(TITLE_SCAN_BYTES, 'the budget itself').toBe(64 * 1024)

    const filler = Buffer.from('x'.repeat(TITLE_SCAN_BYTES + 1000))
    expect(decodeScanWindow(filler).length).toBe(64 * 1024)
  })

  it('does not find a heading that sits beyond the scan window', () => {
    // The budget is a real limit, not a suggestion: a heading past 64 KiB is not found, and
    // the caller falls back to the filename rather than reading the whole file.
    const padding = 'padding line\n'.repeat(8000) // comfortably over 64 KiB
    const bytes = Buffer.from(`${padding}# Too Far\n`)
    expect(bytes.length).toBeGreaterThan(TITLE_SCAN_BYTES)
    expect(extractTitle(decodeScanWindow(bytes))).toBeNull()
    expect(titleFor('big.md', decodeScanWindow(bytes))).toBe('big')
  })

  it('DOES find a heading that sits just inside the window', () => {
    // Proves the previous test fails for the stated reason — the budget — and not because
    // the scanner gives up on long documents.
    const padding = 'padding line\n'.repeat(100)
    const bytes = Buffer.from(`${padding}# Close Enough\n`)
    expect(bytes.length).toBeLessThan(TITLE_SCAN_BYTES)
    expect(extractTitle(decodeScanWindow(bytes))).toBe('Close Enough')
  })

  it('strips a UTF-8 BOM so it cannot hide the first heading', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Title\n')])
    expect(extractTitle(decodeScanWindow(withBom))).toBe('Title')
  })

  it('strips a BOM sitting in front of frontmatter', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('---\n# yaml comment\n---\n# Title\n'),
    ])
    expect(extractTitle(decodeScanWindow(withBom))).toBe('Title')
  })
})

describe('titleFor — the filename fallback', () => {
  it('uses the heading when there is one', () => {
    expect(titleFor('notes.md', '# Heading\n')).toBe('Heading')
  })

  it('falls back to the filename without its extension', () => {
    expect(titleFor('my-notes.md', 'no heading here\n')).toBe('my-notes')
  })

  it('falls back when content is unavailable — the cloud placeholder case', () => {
    // Spec §5: never force-materialize a dataless placeholder during indexing. The title
    // falls back to the filename rather than downloading the file to find a heading.
    expect(titleFor('remote.md', null)).toBe('remote')
  })

  it('keeps a dotfile name intact', () => {
    expect(titleFor('.gitkeep', null)).toBe('.gitkeep')
  })
})
