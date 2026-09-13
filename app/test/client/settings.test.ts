import { describe, expect, it } from 'vitest'

import { folderIdFor } from '../../src/client/settings/folder-id'

/**
 * The registry id a new folder gets. §11.
 *
 * `rootId` is the addressing scheme's other half — every wire message says which folder it means
 * with one — so these are not cosmetic strings.
 */
describe('the id a newly registered folder gets', () => {
  it('is the folder name, slugified, not the whole path', () => {
    // The path is stored beside the id. An id that repeated it would be a second copy of a fact
    // that can then drift from the first.
    expect(folderIdFor('/Users/hallberg/work/notes', [])).toBe('notes')
    expect(folderIdFor('/Users/hallberg/My Notes', [])).toBe('my-notes')
  })

  /**
   * The case that matters, because `register` refuses a duplicate id with a refusal the person
   * cannot act on: they picked a *different folder* and were told the id was taken, which is not a
   * word the UI ever showed them.
   */
  it('avoids an id already registered, numbering from 2', () => {
    expect(folderIdFor('/a/notes', ['notes'])).toBe('notes-2')
    expect(folderIdFor('/a/notes', ['notes', 'notes-2'])).toBe('notes-3')
  })

  it('skips over gaps rather than reusing a number in the middle', () => {
    // `notes-2` free, so it is taken — the loop looks for the first free one, not the highest + 1.
    expect(folderIdFor('/a/notes', ['notes', 'notes-3'])).toBe('notes-2')
  })

  /**
   * §13.6's M16 guard, in its id-shaped form. A folder named `…` is a real thing on this tree, and
   * the empty answer here would be an id of `''` — which every route would then fail to resolve,
   * from a registration that reported success.
   */
  it('falls back to a usable id when the name slugifies to nothing', () => {
    expect(folderIdFor('/Users/hallberg/…', [])).toBe('folder')
    expect(folderIdFor('/Users/hallberg/…', ['folder'])).toBe('folder-2')
  })

  it('handles a trailing separator and the filesystem root without producing an empty id', () => {
    expect(folderIdFor('/a/notes/', [])).toBe('notes')
    expect(folderIdFor('/', [])).toBe('folder')
    expect(folderIdFor('', [])).toBe('folder')
  })

  /**
   * The reason `lastSegment` is hand-written instead of `basename`: this module is imported by the
   * client, and `node:path` is not something a browser has. Recorded as a convention after
   * `slug.ts` shipped `Buffer.byteLength` and froze the New File dialog while all 22 of its unit
   * tests passed — because vitest runs in Node.
   */
  it('uses no Node-only API, so it works in the browser it ships to', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile(
      new URL('../../src/client/settings/folder-id.ts', import.meta.url), 'utf8',
    )

    /**
     * **Comments stripped first, and the first version of this test is why.**
     *
     * It matched the whole file and went red on the word `Buffer` — inside the doc comment that
     * *explains* why `Buffer` is not used. A test that a correct file fails, and that a paraphrase
     * of its own documentation could turn green, is measuring prose.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    expect(code).not.toMatch(/from 'node:/)
    expect(code).not.toMatch(/\bBuffer\b|\bprocess\./)
    // Proof the stripping did not eat the file and leave an empty string to pass vacuously.
    expect(code).toContain('export function folderIdFor')
  })
})

/**
 * **§11's typed override was tested here and is gone**, with the backup check it released. Cut
 * 2026-08-09 on the ruling: the check asked whether a `.git` existed above a folder and never
 * whether anything had been committed, so it reassured them falsely on the soil and charged a typed
 * word on every folder outside a repo — which they use routinely. *"I don't always back it up and I
 * also run non-soil things in the viewer sometimes."*
 */
