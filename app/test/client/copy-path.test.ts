import { describe, expect, it } from 'vitest'

import { copyPath, pathTextFor } from '../../src/client/files/copy-path'
import type { WireEntry } from '../../src/contract/wire'

const entry = (rootId: string, segments: string[]): WireEntry => ({
  rootId,
  segments,
  name: segments[segments.length - 1] ?? '',
  kind: 'file',
  title: '',
  size: 1,
  modifiedMs: 0,
  isMarkdown: true,
  contentUnavailable: false,
  token: 'tok',
})

const FOLDERS = [{ id: 'soil', name: 'notes' }, { id: 'other', name: 'notes' }]

/**
 * the ruling: the short path is fine, *"but it needs to show high enough that we know where
 * it is."* The registered folder's name is that height.
 */
describe('what gets copied', () => {
  it('is the folder name plus the path inside it', () => {
    expect(pathTextFor(entry('soil', ['02-projects', 'orchard', 'notes.md']), FOLDERS))
      .toBe('notes/02-projects/orchard/notes.md')
  })

  it('DISAMBIGUATES two registered folders holding the same relative path', () => {
    // The case a bare relative path cannot express: `01-inbox/note.md` in two registered folders
    // would copy identically from both, and name neither.
    const inbox = ['01-inbox', 'note.md']
    expect(pathTextFor(entry('soil', inbox), FOLDERS)).toBe('notes/01-inbox/note.md')
    expect(pathTextFor(entry('other', inbox), FOLDERS)).toBe('notes/01-inbox/note.md')
  })

  it('carries NO absolute path — §6 never told the browser one', () => {
    const text = pathTextFor(entry('soil', ['notes.md']), FOLDERS)
    expect(text).not.toContain('/Users')
    expect(text.startsWith('/')).toBe(false)
  })

  it('falls back to the folder id rather than dropping the first segment', () => {
    // A path whose first segment is silently missing is worse than an ugly one: it looks correct.
    expect(pathTextFor(entry('unknown-root', ['a.md']), FOLDERS)).toBe('unknown-root/a.md')
  })

  it('handles a file at the top of a registered folder', () => {
    expect(pathTextFor(entry('soil', ['readme.md']), FOLDERS)).toBe('notes/readme.md')
  })

  it('does not escape or alter a name — an agent has to be able to find it verbatim', () => {
    expect(pathTextFor(entry('soil', ['02-projects', 'café notes.md']), FOLDERS))
      .toBe('notes/02-projects/café notes.md')
  })
})

/**
 * §15's two accepted platform limits, both ruled on in 2026-07-29 and neither a bug.
 * What matters is that neither becomes a **silent** failure: the affordance is trusted in one
 * gesture, and a path that was not copied is a paste of whatever was there before.
 */
describe('when the copy cannot happen', () => {
  it('says so when the window is not focused, rather than failing silently', async () => {
    const refusing = { writeText: async () => { throw new Error('not focused') } }
    const outcome = await copyPath('notes/a.md', refusing)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reason).toContain('Click the window first')
  })

  it('names the real cause when there is no Clipboard API — an insecure context', async () => {
    const outcome = await copyPath('notes/a.md', undefined)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reason).toContain('https')
  })

  it('reports success only when the write actually resolved', async () => {
    const written: string[] = []
    const outcome = await copyPath('notes/a.md', {
      writeText: async text => { written.push(text) },
    })
    expect(outcome).toEqual({ ok: true, text: 'notes/a.md' })
    expect(written).toEqual(['notes/a.md'])
  })

  /**
   * **The case WebKit found, and it is not a rejection.**
   *
   * `navigator.clipboard.writeText` can neither resolve nor reject when the document lacks the
   * gesture permission — so a `try/catch` runs no branch, and the confirmation never appears. A
   * silent nothing is worse than a refusal: the person pastes whatever was there before.
   */
  it('refuses when the clipboard never settles at all', async () => {
    const hanging = { writeText: () => new Promise<void>(() => { /* never settles */ }) }
    const outcome = await copyPath('notes/a.md', hanging, 10)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reason).toContain('Click the window first')
  })

  /**
   * The third failure shape, and the one that escaped the first fix: a clipboard that throws
   * SYNCHRONOUSLY, before any promise exists. `.then(…, …)` on an expression that already threw
   * never runs.
   */
  it('refuses when the clipboard throws synchronously', async () => {
    const throwing = {
      writeText: (): Promise<void> => { throw new Error('SecurityError') },
    }
    const outcome = await copyPath('notes/a.md', throwing)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reason).toContain('Click the window first')
  })

  it('still succeeds when the write lands before the deadline', async () => {
    const slow = { writeText: async () => { await new Promise(r => setTimeout(r, 1)) } }
    expect((await copyPath('notes/a.md', slow, 200)).ok).toBe(true)
  })

  it('never resolves ok when writeText rejected', async () => {
    // The one thing this must not do. A false success is a paste of the previous clipboard.
    const outcome = await copyPath('x', { writeText: async () => { throw new Error('nope') } })
    expect(outcome.ok).toBe(false)
  })
})
