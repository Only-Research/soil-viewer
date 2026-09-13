import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../../src/core/errors'
import { fileNameFrom, slugStem } from '../../src/core/slug'

const nameOf = (typed: string, ext?: string): string => {
  const outcome = fileNameFrom(typed, ext)
  if (!outcome.ok) throw new Error(`expected a name, got ${outcome.code}`)
  return outcome.value.name
}

const codeOf = (typed: string, ext?: string): ErrorCode | 'ok' => {
  const outcome = fileNameFrom(typed, ext)
  return outcome.ok ? 'ok' : outcome.code
}

/**
 * M16 FIRST, because it is the reason this module exists.
 *
 * The old implementation stripped everything outside `[a-z0-9]`. On a tree whose owner writes in
 * English that looks harmless right up until it isn't: any name made entirely of non-ASCII letters,
 * emoji, punctuation or CJK collapses to nothing, `.md` gets appended, and the result is a file
 * named `.md` — hidden by the dot rule, invisible in every view, gone the instant it was made.
 */
describe('M16 — a name can never slugify into an invisible file', () => {
  it('PRESERVES CJK rather than deleting it — the exact input that produced `.md`', () => {
    expect(nameOf('日本語', 'md')).toBe('日本語.md')
  })

  it('preserves accented Latin, Cyrillic and Greek', () => {
    expect(nameOf('Café Notes', 'md')).toBe('café-notes.md')
    expect(nameOf('Заметки', 'md')).toBe('заметки.md')
    expect(nameOf('Σημειώσεις', 'md')).toBe('σημειώσεις.md')
  })

  it('REFUSES a name with no letters or digits, rather than inventing one', () => {
    // Substituting `untitled` here would be worse than the error: the user gets a file they did
    // not name, in a tree where the filename IS the title.
    expect(codeOf('...', 'md')).toBe(ErrorCode.NAME_EMPTY)
    expect(codeOf('', 'md')).toBe(ErrorCode.NAME_EMPTY)
    expect(codeOf('   ', 'md')).toBe(ErrorCode.NAME_EMPTY)
    expect(codeOf('---', 'md')).toBe(ErrorCode.NAME_EMPTY)
    expect(codeOf('!!! ???', 'md')).toBe(ErrorCode.NAME_EMPTY)
  })

  it('refuses a lone dot and a lone leading dot — §13.6 names all three cases', () => {
    expect(codeOf('.', 'md')).toBe(ErrorCode.NAME_EMPTY)
    expect(codeOf('.md', 'md')).toBe(ErrorCode.NAME_EMPTY)
    expect(codeOf('.hidden', 'md')).toBe('ok') // has letters; becomes `hidden.md`, not `.hidden.md`
    expect(nameOf('.hidden', 'md')).toBe('hidden.md')
  })

  it('never produces a name beginning with a dot, whatever is typed', () => {
    // `\u200b` written as an escape, not pasted: a zero-width space in source is invisible to
    // the next reader, and this line is specifically about characters you cannot see.
    for (const typed of ['.notes', '..notes', ' .notes', '.-.notes', '\u200b.notes']) {
      const outcome = fileNameFrom(typed, 'md')
      if (!outcome.ok) continue
      expect(outcome.value.name.startsWith('.'), `"${typed}" produced ${outcome.value.name}`)
        .toBe(false)
    }
  })
})

describe('the ordinary shape of a slug', () => {
  it('lowercases and hyphenates', () => {
    expect(nameOf('My Meeting Notes', 'md')).toBe('my-meeting-notes.md')
  })

  it('collapses runs of separators to one', () => {
    expect(nameOf('a   b', 'md')).toBe('a-b.md')
    expect(nameOf('a - b', 'md')).toBe('a-b.md')
    expect(nameOf('a___b', 'md')).toBe('a-b.md')
    expect(nameOf('a/\\:b', 'md')).toBe('a-b.md')
  })

  it('trims separators off both ends', () => {
    expect(nameOf('  spaced  ', 'md')).toBe('spaced.md')
    expect(nameOf('--dashes--', 'md')).toBe('dashes.md')
  })

  it('keeps digits, including a leading one', () => {
    expect(nameOf('2026 harvest', 'md')).toBe('2026-harvest.md')
    expect(nameOf('01-urgent', 'md')).toBe('01-urgent.md')
  })

  it('turns dots inside a name into separators', () => {
    expect(nameOf('2026.08.09 notes', 'md')).toBe('2026-08-09-notes.md')
  })

  it('makes a folder name with no extension at all', () => {
    expect(nameOf('New Project')).toBe('new-project')
  })

  it('normalises to NFC, so two spellings of one name are one file', () => {
    // Decomposed e + combining acute, versus the composed character.
    expect(slugStem('café')).toBe(slugStem('café'))
  })
})

describe('the extension the user typed', () => {
  it('does not double it — `notes.md` becomes `notes.md`, not `notes-md.md`', () => {
    expect(nameOf('notes.md', 'md')).toBe('notes.md')
  })

  it('matches the typed extension case-insensitively', () => {
    expect(nameOf('Notes.MD', 'md')).toBe('notes.md')
  })

  it('treats a DIFFERENT extension as part of the name, because this app writes .md', () => {
    // §6: the write API accepts `.md` only. Someone typing `report.pdf` is naming a document, not
    // choosing a format, and silently creating `report.pdf` would be a file the editor cannot open.
    expect(nameOf('report.pdf', 'md')).toBe('report-pdf.md')
  })

  it('does not strip an extension when making a folder', () => {
    expect(nameOf('notes.md')).toBe('notes-md')
  })
})

describe('length, counted the way the filesystem counts it', () => {
  it('accepts a name at the limit', () => {
    expect(codeOf(`${'a'.repeat(252)}`, 'md')).toBe('ok') // 252 + '.md' = 255
  })

  it('refuses one byte over', () => {
    expect(codeOf(`${'a'.repeat(253)}`, 'md')).toBe(ErrorCode.NAME_TOO_LONG)
  })

  it('counts BYTES not characters, so CJK hits the limit three times sooner', () => {
    // 84 CJK characters is 252 bytes, which fits. 85 is 255, plus `.md` is 258, which does not.
    expect(codeOf('日'.repeat(84), 'md')).toBe('ok')
    expect(codeOf('日'.repeat(85), 'md')).toBe(ErrorCode.NAME_TOO_LONG)
  })

  it('refuses rather than truncating — a shortened name is a file the user did not name', () => {
    const outcome = fileNameFrom('あ'.repeat(200), 'md')
    expect(outcome.ok).toBe(false)
  })
})

describe('the preview the confirm dialog shows', () => {
  it('reports that the name changed, so the UI can say so', () => {
    const outcome = fileNameFrom('My Notes', 'md')
    if (!outcome.ok) throw new Error('expected a name')
    expect(outcome.value).toEqual({ name: 'my-notes.md', changed: true })
  })

  it('reports no change when the typed name was already a slug', () => {
    const outcome = fileNameFrom('my-notes.md', 'md')
    if (!outcome.ok) throw new Error('expected a name')
    expect(outcome.value.changed).toBe(false)
  })
})
