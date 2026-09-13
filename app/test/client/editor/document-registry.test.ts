import { describe, expect, it } from 'vitest'

import { createDocumentRegistry } from '../../../src/client/editor/document-registry'

/**
 * The single-document invariant, driven.
 *
 * These are the two questions `main.tsx` was answering wrongly (security review, P9-3), pulled into a module
 * so they can be asked at all — the entry file cannot be unit-tested, so every ordering rule that
 * lived inside it was a rule nobody could drive.
 *
 * Strings stand in for sessions and hosts throughout. Nothing here needs to know what a document or
 * an element is; the entire subject is **identity**, and using real ones would only add a DOM this
 * environment does not have.
 */

/** A registry of strings, which is all the type parameters ever have to be for these questions. */
const registry = () => createDocumentRegistry<string, string>()

describe('whose document is it', () => {
  it('is nobody\'s before anything is adopted', () => {
    const documents = registry()
    expect(documents.current()).toBeNull()
    expect(documents.ownedBy('panel')).toBeNull()
  })

  it('belongs to the surface it was drawn in', () => {
    const documents = registry()
    documents.adopt('doc', 'panel')
    expect(documents.ownedBy('panel')).toBe('doc')
  })

  /**
   * **The C3 question.** "Is a document open" and "is the open document mine" are different, and the
   * teardown that asked the first one closed the Files pane's editor and orphaned the panel's.
   */
  it('does NOT belong to a surface that merely happens to be asking', () => {
    const documents = registry()
    documents.adopt('doc', 'files')
    expect(documents.ownedBy('panel')).toBeNull()
    // ...while the document is still very much open. The distinction is the whole point.
    expect(documents.current()).toBe('doc')
  })

  it('moves host and session together, so there is no half-applied state to read', () => {
    const documents = registry()
    documents.adopt('first', 'files')
    documents.adopt('second', 'panel')
    expect(documents.current()).toBe('second')
    expect(documents.ownedBy('files')).toBeNull()
    expect(documents.ownedBy('panel')).toBe('second')
  })
})

describe('releasing a document', () => {
  it('clears it when it is still the live one', () => {
    const documents = registry()
    documents.adopt('doc', 'panel')
    documents.release('doc')
    expect(documents.current()).toBeNull()
    expect(documents.ownedBy('panel')).toBeNull()
  })

  /**
   * **THE ONE THAT NEEDS NO RACE, ONLY A SLOW SAVE.**
   *
   * A teardown takes the session it owns and then awaits `flush()` — a network round trip, on a
   * phone, on a bad connection. While it is away, a click on another surface adopts a new session.
   * The teardown resumes and forgets… what, exactly?
   *
   * Unconditionally, it forgot the **new** one. After that nothing closed that session on the next
   * open, and `openFileVerdict` — which reads the live document to decide whether the buffer is
   * dirty — saw nothing at all, called the file clean, and reopened it over unsaved text. A lost
   * edit produced by the code whose job is to prevent lost edits.
   */
  it('does not forget a session that was adopted while the old one was still flushing', () => {
    const documents = registry()
    documents.adopt('panel-doc', 'panel')

    // The teardown takes what it owns, and then goes away over the network.
    const mine = documents.ownedBy('panel')
    expect(mine).toBe('panel-doc')

    // Meanwhile, somewhere else entirely, a file is opened.
    documents.adopt('files-doc', 'files')

    // The flush finishes and the teardown resumes, holding a session that is no longer the live one.
    if (mine !== null) documents.release(mine)

    expect(documents.current(), 'the newer session was wiped by a stale teardown').toBe('files-doc')
    expect(documents.ownedBy('files')).toBe('files-doc')
  })

  it('ignores a session it has never heard of', () => {
    const documents = registry()
    documents.adopt('doc', 'panel')
    documents.release('some-other-doc')
    expect(documents.current()).toBe('doc')
  })

  it('is idempotent, so a teardown that runs twice is not a way to clear a later document', () => {
    const documents = registry()
    documents.adopt('first', 'panel')
    documents.release('first')
    documents.adopt('second', 'files')
    documents.release('first')
    expect(documents.current()).toBe('second')
  })
})
