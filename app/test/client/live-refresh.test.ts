import { describe, expect, it } from 'vitest'

import type { WireEntry } from '../../src/contract/wire'
import { rowKey } from '../../src/client/files/tree-model'
import { createTreeStore } from '../../src/client/files/tree-store'
import { CHANGED_EVENT } from '../../src/server/live-updates'
import {
  applyChanged, changedEventOf, eventNamesPath, openFileVerdict, openFoldersUnder,
  refetchOpenFolders, staleListings, type ChangedEvent, type RefreshableTree,
} from '../../src/client/live-refresh'

/**
 * WHAT A LIVE UPDATE DOES TO THE SCREEN.
 *
 * The channel was proven at P3 and the screens at P7, and for the whole of P7 the two were not
 * connected: `onEvent` and `onRefetch` were `() => {}`. So the question these tests ask is not "does
 * the client receive the event" — it always did — but **"does receiving it make the tree true?"**
 *
 * Most of them run against the **real `createTreeStore`** rather than a recording fake. A fake would
 * prove that `invalidate` was called with the arguments this module chose, which is the same
 * tautology as asserting the code says what it says. The store is what decides whether an
 * invalidation produces a refetch, drops a cache, or does nothing at all, and those three outcomes
 * are the entire subject.
 */

const entry = (segments: string[], kind: 'file' | 'directory' = 'file'): WireEntry => {
  const name = segments[segments.length - 1] ?? ''
  return {
    rootId: 'soil',
    segments,
    name,
    kind,
    title: name,
    size: 1,
    modifiedMs: 0,
    isMarkdown: name.endsWith('.md'),
    contentUnavailable: false,
    token: 'tok',
    ...{},
  }
}

/** A gateway that counts what it was asked for, so a refetch can be distinguished from silence. */
function storeOver(listings: Record<string, WireEntry[]>) {
  const asked: string[] = []
  const store = createTreeStore({
    gateway: {
      children: async (rootId, segments) => {
        const key = [rootId, ...segments].join('/')
        asked.push(key)
        return listings[key] ?? []
      },
    },
  })
  return { store, asked, since: (mark: number) => asked.slice(mark) }
}

/** Waits for the store's own in-flight fetches to settle. */
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

describe('the event name', () => {
  /**
   * **The one place in this build where a Node module and a browser module are compared.**
   *
   * `live-refresh.ts` cannot import `live-updates.ts` — it is a server module and reaches `node:fs`
   * two imports down — so the string `'changed'` is written twice, once at each end of the wire. A
   * name agreed by coincidence is a name that drifts, and the drift would be silent: `live-stream`
   * ignores an unknown event type rather than guessing, so renaming it on the server would simply
   * stop all live updates with nothing red anywhere.
   */
  it('is the same string the server broadcasts', async () => {
    const { CHANGED } = await import('../../src/client/live-refresh')
    expect(CHANGED).toBe(CHANGED_EVENT)
  })
})

describe('changedEventOf', () => {
  it('accepts the payload the server actually sends', () => {
    expect(changedEventOf({ rootId: 'soil', segments: [['a', 'b.md']], reason: 'watched' }))
      .toEqual({ rootId: 'soil', segments: [['a', 'b.md']] })
  })

  it('accepts the whole-root shape', () => {
    expect(changedEventOf({ rootId: 'soil', segments: [[]], reason: 'wake' }))
      .toEqual({ rootId: 'soil', segments: [[]] })
  })

  /**
   * The frame arrives through `safeParse`, which returns `unknown` — including `null` for anything
   * that would not parse. Each of these is a shape that would otherwise reach `rowKey`.
   */
  it.each([
    ['null', null],
    ['a parse failure', undefined],
    ['a string', 'changed'],
    ['no rootId', { segments: [[]] }],
    ['an empty rootId', { rootId: '', segments: [[]] }],
    ['a numeric rootId', { rootId: 7, segments: [[]] }],
    ['segments that are not a list', { rootId: 'soil', segments: 'a/b' }],
    ['a path that is not a list', { rootId: 'soil', segments: ['a/b'] }],
    ['a path holding a number', { rootId: 'soil', segments: [[3]] }],
    ['a path holding an object', { rootId: 'soil', segments: [[{ name: 'a' }]] }],
  ])('refuses %s', (_label, payload) => {
    expect(changedEventOf(payload)).toBeNull()
  })

  /** A refusal, not a crash. One malformed frame must not cost the connection. */
  it('never throws on hostile input', () => {
    expect(() => changedEventOf({ rootId: 'soil', get segments() { return [[1]] } })).not.toThrow()
  })
})

/**
 * **P8-10 — bounded by size, not only by type.**
 *
 * the security review marked it Low and said why: *"not attacker-reachable — the sender is the app's own gated
 * stream."* True, and it is why these are bounds rather than refusals with messages. The argument
 * for having them is not about an attacker: this function decides whether a frame is one this
 * client understands, and every field here has a stated limit at the other end (§6), so accepting
 * more than the server can legitimately send means accepting something no correct sender produced.
 */
describe('changedEventOf bounds sizes, not only types', () => {
  const path = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}`)

  it('refuses a rootId longer than a path segment may be', () => {
    expect(changedEventOf({ rootId: 'x'.repeat(256), segments: [] })).toBeNull()
  })

  it('accepts a rootId at the limit', () => {
    // The other half of every bound: the limit itself must be legal, or the bound is off by one in
    // the direction that silently drops real events.
    expect(changedEventOf({ rootId: 'x'.repeat(255), segments: [] })).not.toBeNull()
  })

  it('refuses a path deeper than §6 allows', () => {
    expect(changedEventOf({ rootId: 'soil', segments: [path(65)] })).toBeNull()
  })

  it('accepts a path at the depth limit', () => {
    expect(changedEventOf({ rootId: 'soil', segments: [path(64)] })).not.toBeNull()
  })

  it('refuses a segment longer than §6 allows', () => {
    expect(changedEventOf({ rootId: 'soil', segments: [['a'.repeat(256)]] })).toBeNull()
  })

  it('refuses a frame naming more paths than a burst could hold', () => {
    const many = Array.from({ length: 4_097 }, () => ['a'])
    expect(changedEventOf({ rootId: 'soil', segments: many })).toBeNull()
  })

  it('accepts a large but legitimate burst', () => {
    // The server coalesces a watcher burst into one event, so this is a bound on a burst. Refusing a
    // real one would drop a redraw and leave the tree stale — the failure this module exists for.
    const many = Array.from({ length: 4_096 }, () => ['a'])
    expect(changedEventOf({ rootId: 'soil', segments: many })).not.toBeNull()
  })
})

describe('openFoldersUnder', () => {
  /**
   * **Bound to `rowKey` by behaviour, not by a second spelling of the separator.**
   *
   * The key separator is NUL, built with `String.fromCharCode(0)` because typing the character has
   * gone wrong five times in this codebase — including twice while writing the module under test.
   * Asserting it against a hand-written escape here would just be the sixth chance to get it wrong,
   * so this round-trips a real `rowKey` instead.
   */
  it('splits keys exactly as rowKey joined them', () => {
    const key = rowKey('soil', ['02-projects', 'orchard'])
    expect(openFoldersUnder('soil', new Set([key])))
      .toEqual([[], ['02-projects', 'orchard']])
  })

  it('always includes the root listing, even with nothing expanded', () => {
    expect(openFoldersUnder('soil', new Set())).toEqual([[]])
  })

  /** `soil` must not match `soil-archive`. Whole-key, never a bare string prefix. */
  it('ignores folders belonging to another root', () => {
    const mine = rowKey('soil', ['notes'])
    const theirs = rowKey('soil-archive', ['notes'])
    expect(openFoldersUnder('soil', new Set([mine, theirs]))).toEqual([[], ['notes']])
  })

  /** A folder whose name contains the separator cannot exist, which is why the split is safe. */
  it('handles names with spaces and dots', () => {
    const key = rowKey('soil', ['00-context', 'a folder.with dots'])
    expect(openFoldersUnder('soil', new Set([key])))
      .toEqual([[], ['00-context', 'a folder.with dots']])
  })
})

describe('staleListings', () => {
  const tree = (expanded: string[], cached: string[]): RefreshableTree => ({
    rootIds: () => ['soil'],
    expanded: () => new Set(expanded),
    childrenOf: (rootId, segments) =>
      cached.includes(rowKey(rootId, segments)) ? [] : undefined,
    invalidate: async () => {},
  })

  /**
   * RULE 1, and the one that would be got wrong by reflex. A changed FILE has no listing of its
   * own; the folder that holds it is what shows its name, size and modified time.
   */
  it('refreshes the folder a changed file lives in', () => {
    const event: ChangedEvent = { rootId: 'soil', segments: [['notes', 'a.md']] }
    expect(staleListings(event, tree([], []))).toEqual([['notes']])
  })

  it('refreshes the root listing for a file at the top level', () => {
    const event: ChangedEvent = { rootId: 'soil', segments: [['readme.md']] }
    expect(staleListings(event, tree([], []))).toEqual([[]])
  })

  /** RULE 2. A directory the tree is holding a listing for is refreshed at both ends. */
  it('refreshes a changed directory and its parent', () => {
    const event: ChangedEvent = { rootId: 'soil', segments: [['notes', 'sub']] }
    const held = tree([], [rowKey('soil', ['notes', 'sub'])])
    expect(staleListings(event, held)).toEqual([['notes'], ['notes', 'sub']])
  })

  /**
   * The economy that keeps a `git checkout` from becoming one request per file. The server already
   * coalesces its side into a 250 ms batch; this is the same on the receiving side.
   */
  it('collapses many files in one folder into a single listing', () => {
    const event: ChangedEvent = {
      rootId: 'soil',
      segments: [['notes', 'a.md'], ['notes', 'b.md'], ['notes', 'c.md']],
    }
    expect(staleListings(event, tree([], []))).toEqual([['notes']])
  })

  /**
   * RULE 3. `[[]]` is what a defensive whole-root reconcile emits — watcher restart, wake from
   * sleep, index contradiction. Refreshing only the top level would leave every open subfolder
   * stale at precisely the moment the server has said it cannot account for them.
   */
  it('refreshes everything open under the root on a whole-root event', () => {
    const expanded = [
      rowKey('soil', ['notes']),
      rowKey('soil', ['notes', 'sub']),
      rowKey('soil-archive', ['elsewhere']),
    ]
    const event: ChangedEvent = { rootId: 'soil', segments: [[]] }
    expect(staleListings(event, tree(expanded, []))).toEqual([[], ['notes'], ['notes', 'sub']])
  })
})

describe('eventNamesPath', () => {
  const open = ['02-projects', 'orchard', 'notes.md']

  it('matches the exact path', () => {
    expect(eventNamesPath({ rootId: 'soil', segments: [open] }, 'soil', open)).toBe(true)
  })

  it('does not match a sibling', () => {
    const sibling = ['02-projects', 'orchard', 'other.md']
    expect(eventNamesPath({ rootId: 'soil', segments: [sibling] }, 'soil', open)).toBe(false)
  })

  it('does not match the same path under another root', () => {
    expect(eventNamesPath({ rootId: 'other', segments: [open] }, 'soil', open)).toBe(false)
  })

  /** Not mentioned because nothing was mentioned — everything under the root is suspect. */
  it('matches a whole-root event', () => {
    expect(eventNamesPath({ rootId: 'soil', segments: [[]] }, 'soil', open)).toBe(true)
  })

  /**
   * `['a/b']` and `['a','b']` are different paths on disk — one file with a slash in the name is
   * not two folders — and a slash-join would call them equal. `rowKey` cannot, which is the whole
   * reason it exists.
   */
  it('does not confuse a separator inside a name with a path boundary', () => {
    expect(eventNamesPath({ rootId: 'soil', segments: [['a/b']] }, 'soil', ['a', 'b'])).toBe(false)
  })
})

describe('openFileVerdict', () => {

  /**
   * **THE COLLAPSED BATCH — a directory event standing in for the file inside it.**
   *
   * `withoutCoveredPaths` drops a file path when a directory covering it is in the same batch, and
   * the reconciler then announces only the directory. `eventNamesPath` matches exactly, so the open
   * file was never named and every such change was ignored: an agent editing `docs/notes/todo.md`
   * while anything else in `docs/notes` moved, inside the 250ms window, left the editor showing
   * bytes that were no longer on disk. Silently, which is the part that matters.
   *
   * Asymmetric on purpose. A clean buffer reloads — being wrong costs a re-read that returns the
   * same bytes. A dirty buffer stays quiet rather than announcing, because an ancestor event fires
   * for *any* creation, deletion or rename in the folder, and a banner would be about someone
   * else's write. The save-time conflict contract is what protects the text either way.
   */
  it('a directory event reloads the open file beneath it when nothing is unsaved', () => {
    const event = { rootId: 'soil', segments: [['docs', 'notes']] }
    const open = { rootId: 'soil', segments: ['docs', 'notes', 'todo.md'] }

    expect(openFileVerdict(event, open, { dirty: false, inFlight: false })).toBe('reload')
  })

  it('and stays silent when there is unsaved work, rather than announcing someone else\'s write', () => {
    const event = { rootId: 'soil', segments: [['docs', 'notes']] }
    const open = { rootId: 'soil', segments: ['docs', 'notes', 'todo.md'] }

    expect(openFileVerdict(event, open, { dirty: true, inFlight: false })).toBe('ignore')
  })

  it('a SIBLING file event still does not concern the open file', () => {
    // The guard against over-matching: `docs/notes/other.md` is neither the file nor an ancestor.
    const event = { rootId: 'soil', segments: [['docs', 'notes', 'other.md']] }
    const open = { rootId: 'soil', segments: ['docs', 'notes', 'todo.md'] }

    expect(openFileVerdict(event, open, { dirty: false, inFlight: false })).toBe('ignore')
  })
  const open = { rootId: 'soil', segments: ['notes', 'a.md'] }
  const clean = { dirty: false, inFlight: false }
  const names: ChangedEvent = { rootId: 'soil', segments: [['notes', 'a.md']] }

  it('ignores an event about a different file', () => {
    const other: ChangedEvent = { rootId: 'soil', segments: [['notes', 'b.md']] }
    expect(openFileVerdict(other, open, clean)).toBe('ignore')
  })

  it('ignores everything when no file is open', () => {
    expect(openFileVerdict(names, null, null)).toBe('ignore')
  })

  it('reloads a clean document', () => {
    expect(openFileVerdict(names, open, clean)).toBe('reload')
  })

  /** Nothing is open in the editor — a PNG, say — so there is no buffer to protect. */
  it('reloads when there is no document session at all', () => {
    expect(openFileVerdict(names, open, null)).toBe('reload')
  })

  /**
   * **THE RULE THIS FUNCTION EXISTS FOR.** Unsaved text is the one thing on screen that exists
   * nowhere else, and a watcher event may not be the second writer to it.
   */
  it('never reloads over unsaved edits', () => {
    expect(openFileVerdict(names, open, { dirty: true, inFlight: false }))
      .toBe('keep-and-announce')
  })

  /**
   * A save that has left the client and not been answered has a buffer whose fate is undecided.
   * Reloading underneath it discards text the server is about to accept.
   */
  it('never reloads over a save in flight', () => {
    expect(openFileVerdict(names, open, { dirty: false, inFlight: true }))
      .toBe('keep-and-announce')
  })

  /** A whole-root reconcile does not exempt the open file, and does not override the dirty rule. */
  it('protects a dirty buffer on a whole-root event too', () => {
    const wholeRoot: ChangedEvent = { rootId: 'soil', segments: [[]] }
    expect(openFileVerdict(wholeRoot, open, { dirty: true, inFlight: false }))
      .toBe('keep-and-announce')
    expect(openFileVerdict(wholeRoot, open, clean)).toBe('reload')
  })
})

describe('applyChanged, against the real store', () => {
  /** The whole feature in one assertion: someone else writes a file, the folder is re-read. */
  it('refetches an expanded folder when a file inside it changes', async () => {
    const { store, asked } = storeOver({
      'soil': [entry(['notes'], 'directory')],
      'soil/notes': [entry(['notes', 'a.md'])],
    })
    store.setRoots(['soil'])
    await settle()
    await store.toggle(entry(['notes'], 'directory'))
    const mark = asked.length

    await applyChanged(store, { rootId: 'soil', segments: [['notes', 'a.md']] })

    expect(asked.slice(mark)).toEqual(['soil/notes'])
  })

  /**
   * **A collapsed folder is dropped rather than re-read**, and that is the store's rule rather than
   * this module's — which is exactly why the test runs against the real one. Fetching listings
   * nobody is looking at is how a 10,000-file tree becomes unusable on a busy repository.
   */
  it('drops the cache of a collapsed folder without refetching it', async () => {
    const { store, asked } = storeOver({
      'soil': [entry(['notes'], 'directory')],
      'soil/notes': [entry(['notes', 'a.md'])],
    })
    store.setRoots(['soil'])
    await settle()
    await store.toggle(entry(['notes'], 'directory'))
    await store.toggle(entry(['notes'], 'directory'))
    const mark = asked.length

    await applyChanged(store, { rootId: 'soil', segments: [['notes', 'a.md']] })

    expect(asked.slice(mark)).toEqual([])
    expect(store.childrenOf('soil', ['notes'])).toBeUndefined()
  })

  /** The new row is actually visible afterwards — not merely that a request was made. */
  it('makes a file created by someone else appear', async () => {
    const listings: Record<string, WireEntry[]> = { 'soil': [entry(['readme.md'])] }
    const { store } = storeOver(listings)
    store.setRoots(['soil'])
    await settle()
    expect(store.childrenOf('soil', [])).toHaveLength(1)

    // An agent writes a second file.
    listings['soil'] = [entry(['readme.md']), entry(['agent-wrote-this.md'])]
    await applyChanged(store, { rootId: 'soil', segments: [['agent-wrote-this.md']] })

    expect(store.childrenOf('soil', [])?.map(row => row.name))
      .toEqual(['readme.md', 'agent-wrote-this.md'])
  })

  it('refreshes every open folder under the root on a whole-root event', async () => {
    const { store, asked } = storeOver({
      'soil': [entry(['notes'], 'directory')],
      'soil/notes': [entry(['notes', 'sub'], 'directory')],
      'soil/notes/sub': [],
    })
    store.setRoots(['soil'])
    await settle()
    await store.toggle(entry(['notes'], 'directory'))
    await store.toggle(entry(['notes', 'sub'], 'directory'))
    const mark = asked.length

    await applyChanged(store, { rootId: 'soil', segments: [[]] })

    expect(asked.slice(mark).sort()).toEqual(['soil', 'soil/notes', 'soil/notes/sub'])
  })

  /** An event for a root this client does not have registered must not invent one. */
  it('ignores an event for an unknown root', async () => {
    const { store, asked } = storeOver({ 'soil': [] })
    store.setRoots(['soil'])
    await settle()
    const mark = asked.length

    await applyChanged(store, { rootId: 'somewhere-else', segments: [['a.md']] })

    // `invalidate` on an unknown root asks for its listing exactly once and gets nothing; what
    // matters is that the registered root was left alone.
    expect(asked.slice(mark).filter(key => key.startsWith('soil'))).toEqual([])
  })
})

describe('refetchOpenFolders', () => {
  /**
   * §15's reconnect refetch. The iOS case: a phone resumes, the stream was silently dead, and
   * nothing that changed during the suspension was ever delivered or will ever be replayed.
   */
  it('re-reads every open folder across every root', async () => {
    const { store, asked } = storeOver({
      'a': [entry(['one'], 'directory')],
      'a/one': [],
      'b': [],
    })
    store.setRoots(['a', 'b'])
    await settle()
    await store.toggle({ ...entry(['one'], 'directory'), rootId: 'a' })
    const mark = asked.length

    await refetchOpenFolders(store)

    expect(asked.slice(mark).sort()).toEqual(['a', 'a/one', 'b'])
  })

  it('re-reads the root listings even when nothing is expanded', async () => {
    const { store, asked } = storeOver({ 'a': [], 'b': [] })
    store.setRoots(['a', 'b'])
    await settle()
    const mark = asked.length

    await refetchOpenFolders(store)

    expect(asked.slice(mark).sort()).toEqual(['a', 'b'])
  })
})
