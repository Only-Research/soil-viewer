import { describe, expect, it } from 'vitest'

import { MAX_EDITABLE_BYTES } from '../../src/core/fs/document'
import { markdownRefusal, paneStateFor } from '../../src/client/files/pane-state'
import type { WireEntry } from '../../src/contract/wire'

const entry = (name: string, overrides: Partial<WireEntry> = {}): WireEntry => ({
  rootId: 'soil',
  segments: [name],
  name,
  kind: 'file',
  title: name,
  size: 1024,
  modifiedMs: 0,
  isMarkdown: name.toLowerCase().endsWith('.md'),
  contentUnavailable: false,
  token: 'tok',
  ...overrides,
})

const kindOf = (name: string, overrides: Partial<WireEntry> = {}): string =>
  paneStateFor(entry(name, overrides)).kind

/**
 * **ruled 2026-08-09:** *"videos don't need to display inline nor do they need to offer
 * a download, they can just show, cannot display this file or something."*
 *
 * Three states, and download is not one of them.
 */
describe('there is no download state', () => {
  it.each(['clip.mp4', 'clip.mov', 'archive.zip', 'deck.key', 'binary.bin', 'page.html',
    'drawing.svg', 'script.js'])('%s says it cannot be shown', name => {
    const state = paneStateFor(entry(name))
    expect(state.kind).toBe('unsupported')
    if (state.kind !== 'unsupported') throw new Error('unreachable')
    expect(state.reason).toBe('This kind of file cannot be shown here.')
  })

  it('never produces a state named download, whatever it is given', () => {
    // The whole vocabulary, asserted, so adding one back is a visible change rather than a quiet one.
    const kinds = new Set(['a.png', 'a.pdf', 'a.txt', 'a.zip', 'a.svg', 'a.mp4', 'LICENSE']
      .map(name => kindOf(name)))
    expect([...kinds].sort()).toEqual(['image', 'pdf', 'text', 'unsupported'])
  })

  /**
   * The reason a video and a `.svg` read the same. Naming the format would be a second copy of §9's
   * allowlist living in a string, and the person's next move is identical in both cases.
   */
  it('does not name the format back', () => {
    for (const name of ['clip.mp4', 'drawing.svg', 'archive.zip']) {
      const state = paneStateFor(entry(name))
      if (state.kind !== 'unsupported') throw new Error('unreachable')
      expect(state.reason).not.toMatch(/mp4|svg|zip|video/i)
    }
  })
})

describe('what CAN be shown', () => {
  it.each(['photo.png', 'photo.jpg', 'photo.jpeg', 'photo.gif', 'photo.webp', 'photo.heic'])(
    '%s is an image', name => { expect(kindOf(name)).toBe('image') })

  it('a pdf gets its own state, because it needs a sandboxed frame rather than an img', () => {
    expect(kindOf('report.pdf')).toBe('pdf')
  })

  it.each(['notes.txt', 'data.json', 'config.yml', 'rows.csv', 'LICENSE'])(
    '%s reads as text', name => { expect(kindOf(name)).toBe('text') })

  it('a large text file falls out of the text pane rather than being truncated', () => {
    expect(kindOf('big.json', { size: 512 * 1024 })).toBe('unsupported')
  })
})

/**
 * §5's cloud placeholder: a file that exists and whose bytes are not on this machine. It is never
 * an empty document — that substitution is C2, the cheapest total-loss path in the whole spec.
 */
describe('a file that is not downloaded', () => {
  it('says so, and does not try to show it', () => {
    const state = paneStateFor(entry('photo.png', { contentUnavailable: true }))
    expect(state.kind).toBe('unsupported')
    if (state.kind !== 'unsupported') throw new Error('unreachable')
    expect(state.reason).toContain('not been downloaded')
  })

  it('beats the type — an undownloaded PNG is not an image the pane can show', () => {
    expect(kindOf('photo.png', { contentUnavailable: true })).toBe('unsupported')
    expect(kindOf('photo.png')).toBe('image')
  })
})

/**
 * FT-11: an unopenable `.md` reaches this pane too, always with a reason. §12 makes it a **state**,
 * not a failure — a perfectly good file the editor is not allowed to touch.
 */
describe('why the editor will not open a markdown file', () => {
  it('says nothing when it will', () => {
    expect(markdownRefusal(entry('notes.md'))).toBeNull()
  })

  it('names the size when the file is over the editable cap', () => {
    const refusal = markdownRefusal(entry('huge.md', { size: MAX_EDITABLE_BYTES + 1 }))
    expect(refusal).toContain('too large')
    // The number is in the message: §13.2's rule that a refusal NAMES the thing, not "are you sure".
    expect(refusal).toMatch(/\d/)
  })

  it('accepts a file exactly at the cap', () => {
    expect(markdownRefusal(entry('edge.md', { size: MAX_EDITABLE_BYTES }))).toBeNull()
  })

  it('reports a cloud placeholder before anything is fetched', () => {
    expect(markdownRefusal(entry('notes.md', { contentUnavailable: true })))
      .toContain('not been downloaded')
  })

  /**
   * The client cannot answer §12's other two conditions — invalid UTF-8 and a NUL byte — from a row,
   * because a row carries no bytes. The server's `NOT_EDITABLE` is authoritative and arrives with
   * the load. This function is only what the tree can say on its own, and it must not pretend
   * otherwise by returning `null` as though it had checked.
   */
  it('does not claim a file is editable — only that IT found no reason', () => {
    // A file whose bytes are not valid UTF-8 looks fine from a row. `null` here means "nothing I can
    // see", and the caller must still handle the server's refusal.
    expect(markdownRefusal(entry('invalid-utf8.md'))).toBeNull()
  })
})
