import { describe, expect, it } from 'vitest'

import { HEADER_PATH_SEGMENTS, headerPath, PATH_ELISION } from '../../src/core/paths'

/**
 * **THE HEADER PATH IS ONE LINE, AND IT IS THE TAIL.**
 *
 * The rule exists because of what the operator saw on their phone: the full path in a task card wrapped to
 * **ten lines**, and two in the Files editor. The design pass answered it by keeping the end of the
 * path and eliding the front.
 *
 * These are string assertions rather than layout ones on purpose. The reason the header cannot wrap
 * is that the string is **short before it is laid out** — not that a CSS rule usually contains it —
 * so the property worth pinning is what the string is.
 */
describe('the document header path', () => {
  it('drops the filename, because the header shows it directly above', () => {
    // The line used to end with the same name the title carried: a duplicate, paid for in width.
    expect(headerPath(['02-projects', 'cider-line', 'note.md'])).not.toContain('note.md')
  })

  it('keeps the tail and elides the front, which is what identifies the file', () => {
    expect(headerPath(['02-projects', 'cider-line', '02-work', 'tasks', '01-urgent', 'a.md']))
      .toBe('…/tasks/01-urgent')
  })

  it('does not elide when the whole path already fits the budget', () => {
    // No mark, because nothing was cut. A permanent leading "…/" would be a lie on a short path.
    expect(headerPath(['02-work', 'tasks', 'a.md'])).toBe('02-work/tasks')
    expect(headerPath(['02-work', 'tasks', 'a.md'])).not.toContain(PATH_ELISION)
  })

  it('says nothing for a file at the root, so no line is drawn', () => {
    expect(headerPath(['readme.md'])).toBe('')
  })

  it('never returns more than the budgeted number of folders', () => {
    const deep = [...Array.from({ length: 40 }, (_, at) => `folder-${at}`), 'a.md']
    const shown = headerPath(deep).replace(PATH_ELISION, '')
    expect(shown.split('/')).toHaveLength(HEADER_PATH_SEGMENTS)
  })

  it('is stable under a name containing a slash-like character, rather than splitting on it', () => {
    /**
     * Segments are an array precisely so a name is never re-parsed. A folder legitimately named
     * `a-b` must not become two, and the join here is display-only — nothing downstream parses it
     * back, which is why this is safe to render at all.
     */
    expect(headerPath(['02-work', 'notes-and-drafts', 'a.md'])).toBe('02-work/notes-and-drafts')
  })
})
