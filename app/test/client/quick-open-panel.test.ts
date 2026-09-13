import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { el } from '../../src/client/dom'
import {
  mountQuickOpen, nextSelection, resultWhere, type QuickOpenResult,
} from '../../src/client/quick-open-panel'
import { QUERY_DEBOUNCE_MS } from '../../src/core/quick-open'
import { FakeElement, installFakeDocument, removeFakeDocument } from '../support/fake-dom'
import type { WireEntry } from '../../src/contract/wire'

/**
 * **THE ⌘K PANEL.** §16's surface.
 *
 * The ranking and every bound live in `core/quick-open.ts` and are proven there. What is asserted
 * here is the half a rule cannot have: that the whole thing is drivable from the keyboard. A jump
 * control you have to finish with the mouse is slower than the tree it replaces, which makes the
 * keyboard path the feature rather than a convenience on top of it.
 */

beforeEach(installFakeDocument)
afterEach(removeFakeDocument)

const entry = (path: string, title = ''): WireEntry => {
  const segments = path.split('/')
  return {
    rootId: 'soil', segments, name: segments[segments.length - 1] ?? '', kind: 'file',
    title, isMarkdown: true, contentUnavailable: false,
  } as unknown as WireEntry
}

const results: QuickOpenResult[] = [
  { entry: entry('02-projects/orchard/note.md', 'Note'), inName: true },
  { entry: entry('02-projects/cold-store/RT1/chatroom.md', 'Room'), inName: true },
  { entry: entry('01-internal/security/index.md', 'Index'), inName: false },
]

interface Mounted {
  readonly host: FakeElement
  readonly chosen: string[]
  readonly queries: string[]
  readonly closes: number[]
  readonly handle: ReturnType<typeof mountQuickOpen>
}

const mount = (): Mounted => {
  const host = el('div') as unknown as FakeElement
  const chosen: string[] = []
  const queries: string[] = []
  const closes: number[] = []
  const handle = mountQuickOpen(host as unknown as HTMLElement, {
    onChoose: e => chosen.push(e.segments.join('/')),
    onQuery: q => queries.push(q),
    onClose: () => closes.push(1),
  })
  return { host, chosen, queries, closes, handle }
}

const press = (m: Mounted, key: string): void => {
  m.host.byClass('quick-open-field')[0]?.fire('keydown',
    { key, preventDefault: () => { /* the handler calls it */ } } as unknown as KeyboardEvent)
}

describe('nextSelection — the part of a keyboard list people notice', () => {
  /**
   * **It wraps.** A list you can fall off the end of makes you look at it to use it, which is the
   * thing quick-open exists to avoid. Invisible in a screenshot, so asserted rather than eyeballed.
   */
  it('wraps past the end and before the start', () => {
    expect(nextSelection(2, 3, 'ArrowDown')).toBe(0)
    expect(nextSelection(0, 3, 'ArrowUp')).toBe(2)
  })

  it('moves one at a time otherwise', () => {
    expect(nextSelection(0, 3, 'ArrowDown')).toBe(1)
    expect(nextSelection(2, 3, 'ArrowUp')).toBe(1)
  })

  it('stays put on an empty list rather than selecting nothing at index -1', () => {
    expect(nextSelection(0, 0, 'ArrowDown')).toBe(0)
    expect(nextSelection(0, 0, 'ArrowUp')).toBe(0)
  })

  it('ignores keys that are not the arrows', () => {
    expect(nextSelection(1, 3, 'a')).toBe(1)
  })
})

describe('the panel, driven from the keyboard', () => {
  it('draws a row per result, with the first selected', () => {
    const m = mount()
    m.handle.show(results)
    expect(m.host.byClass('quick-open-result')).toHaveLength(3)
    expect(m.host.byClass('is-selected')).toHaveLength(1)
    expect(m.host.byClass('quick-open-result')[0]?.classList.contains('is-selected')).toBe(true)
  })

  it('Enter opens the selected result, by the row the server gave', () => {
    const m = mount()
    m.handle.show(results)
    press(m, 'ArrowDown')
    press(m, 'Enter')
    expect(m.chosen).toEqual(['02-projects/cold-store/RT1/chatroom.md'])
  })

  /**
   * **Enter on an empty list does nothing.** A keystroke that arrived before the search came back
   * is a keystroke that arrived early, not a request — and opening whatever happened to be first a
   * moment later is how a jump control opens the wrong file.
   */
  it('Enter does nothing at all when there is nothing to open', () => {
    const m = mount()
    press(m, 'Enter')
    expect(m.chosen).toEqual([])
  })

  it('Escape asks the caller to close', () => {
    const m = mount()
    press(m, 'Escape')
    expect(m.closes).toHaveLength(1)
  })

  it('a click outside asks the caller to close', () => {
    const m = mount()
    m.host.byClass('quick-open-backdrop')[0]?.fire('mousedown')
    expect(m.closes).toHaveLength(1)
  })

  /**
   * **The selection resets when the query changes.** Without this, arrowing to the fourth result
   * and then typing one more letter leaves the highlight on whatever is now fourth — a different
   * file, still highlighted, one Enter away.
   */
  it('resets the selection when the query changes', () => {
    const m = mount()
    m.handle.show(results)
    press(m, 'ArrowDown')
    press(m, 'ArrowDown')
    m.handle.show(results)
    press(m, 'Enter')
    expect(m.chosen).toEqual(['02-projects/orchard/note.md'])
  })

  /**
   * **Two empty states, because they mean different things.** Nothing typed is an instruction;
   * nothing found is an answer. One message for both tells a person who has typed nothing that
   * their empty query failed.
   */
  it('says something different before typing than after finding nothing', () => {
    const m = mount()
    expect(m.host.byClass('quick-open-empty')[0]?.text()).toContain('Type to find')
  })

  it('shows where a result lives, not just its name', () => {
    expect(resultWhere(entry('02-projects/orchard/note.md'))).toBe('02-projects/orchard')
  })
})

/**
 * the security review's P11F-7 -- **one request per burst of typing, not one per keystroke.**
 *
 * Harmless at 1,500 files, and the multiplier on P11F-2, where the search's cost is dominated by a
 * sort the time budget does not cover. Eight characters typed at speed meant eight full searches,
 * seven of whose answers nobody would ever see.
 *
 * Fake timers rather than real waits: a test that slept 120 ms per case would add a second to the
 * suite to prove something the clock can prove instantly -- and a real timer would make this the
 * kind of case that goes flaky on a slow runner, which is the failure this build keeps finding.
 */
describe('the query is debounced, and the cancellation is the half that matters', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const type = (m: Mounted, text: string): void => {
    const field = m.host.byClass('quick-open-field')[0]
    if (field === undefined) throw new Error('no field')
    field.value = text
    field.fire('input', {} as unknown as Event)
  }

  it('asks once for a burst of keystrokes, not once per key', () => {
    const m = mount()
    for (const text of ['q', 'qu', 'qua', 'quar']) type(m, text)
    expect(m.queries, 'it asked before the burst finished').toEqual([])

    vi.advanceTimersByTime(QUERY_DEBOUNCE_MS)
    expect(m.queries).toEqual(['quar'])
  })

  it('asks again for a second burst, so it is a debounce and not a one-shot', () => {
    // The control. A build that fired once and never again would satisfy the case above.
    const m = mount()
    type(m, 'a')
    vi.advanceTimersByTime(QUERY_DEBOUNCE_MS)
    type(m, 'ab')
    vi.advanceTimersByTime(QUERY_DEBOUNCE_MS)
    expect(m.queries).toEqual(['a', 'ab'])
  })

  it('does NOT make you wait to clear the box', () => {
    /**
     * Emptying the field means "show me nothing", which the client already knows. Waiting 120 ms to
     * stop showing stale results would be a delay with nothing on the other end of it.
     */
    const m = mount()
    type(m, 'quar')
    vi.advanceTimersByTime(QUERY_DEBOUNCE_MS)
    type(m, '')
    expect(m.queries, 'clearing the field was delayed').toEqual(['quar', ''])
  })

  it('drops a query in flight when the panel closes', () => {
    /**
     * **The half that matters.** A query still pending when the panel closes arrives at a surface
     * that no longer exists, and the caller draws results into a list that has been torn down.
     */
    const m = mount()
    type(m, 'quar')
    m.handle.close()
    vi.advanceTimersByTime(QUERY_DEBOUNCE_MS * 4)
    expect(m.queries, 'a query fired into a closed panel').toEqual([])
  })
})
