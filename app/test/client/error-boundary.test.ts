import { describe, expect, it } from 'vitest'

import { createErrorBoundary, type BoundaryError } from '../../src/client/error-boundary'
import { MAX_MESSAGES, TOAST_MS, createFeedback } from '../../src/client/feedback'

/**
 * **Build-plan §3's second acceptance condition: "error boundary proven with a deliberately broken
 * tab."** Broken on purpose, not asserted — the same standard the asset map was held to.
 */

describe('THE ACCEPTANCE CONDITION — a deliberately broken tab', () => {
  it('contains the crash: the broken tab fails, every other tab renders', () => {
    const rendered: string[] = []
    const boundary = createErrorBoundary()

    boundary.register('files', () => { rendered.push('files') })
    boundary.register('broken', () => { throw new Error('deliberately broken tab') })
    boundary.register('tasks', () => { rendered.push('tasks') })

    const states = boundary.renderAll()

    expect(rendered, 'the healthy tabs must still have rendered').toEqual(['files', 'tasks'])
    expect(states.find(s => s.id === 'broken')?.status).toBe('failed')
    expect(states.filter(s => s.status === 'ok').map(s => s.id)).toEqual(['files', 'tasks'])
  })

  it('renderAll does not stop at the first failure', () => {
    // Order matters: the broken tab is FIRST, so a boundary that let the throw escape would never
    // reach the other two.
    const rendered: string[] = []
    const boundary = createErrorBoundary()
    boundary.register('broken', () => { throw new Error('boom') })
    boundary.register('a', () => { rendered.push('a') })
    boundary.register('b', () => { rendered.push('b') })

    boundary.renderAll()
    expect(rendered).toEqual(['a', 'b'])
  })

  it('shows a NAMED error rather than nothing', () => {
    // Blank is the failure mode that matters. This build's history is failures that presented as
    // empty rather than as wrong, and a tab rendering nothing after a throw is indistinguishable
    // from a folder with nothing in it.
    const boundary = createErrorBoundary()
    boundary.register('broken', () => { throw new Error('boom') })
    const state = boundary.render('broken')
    expect(state.error?.message).toBe('This tab could not be displayed.')
    expect(state.error?.message.length).toBeGreaterThan(0)
  })

  it('keeps the exception detail off the surface and in the report', () => {
    const reported: BoundaryError[] = []
    const boundary = createErrorBoundary({ onError: e => reported.push(e) })
    boundary.register('broken', () => { throw new Error('ENOENT: /Users/hallberg/private.md') })
    const state = boundary.render('broken')

    expect(state.error?.message, 'the surface says one fixed line').not.toContain('ENOENT')
    expect(state.error?.message).not.toContain('hallberg')
    expect(reported[0]?.detail, 'the report gets everything').toContain('ENOENT')
  })

  it('never retries on its own', () => {
    // A boundary that silently re-renders on a loop turns one bug into a spinning CPU.
    let calls = 0
    const boundary = createErrorBoundary()
    boundary.register('broken', () => { calls++; throw new Error('boom') })
    boundary.render('broken')
    expect(calls).toBe(1)
  })

  it('retries only when asked, and recovers when the cause is gone', () => {
    let healthy = false
    const boundary = createErrorBoundary()
    boundary.register('tab', () => { if (!healthy) throw new Error('boom') })

    expect(boundary.render('tab').status).toBe('failed')
    healthy = true
    const retried = boundary.retry('tab')
    expect(retried.status).toBe('ok')
    expect(retried.error).toBeNull()
  })

  it('survives every shape a throw can take', () => {
    const boundary = createErrorBoundary()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    const thrown: unknown[] = ['a string', undefined, null, 42, circular, { a: 1n }]
    for (const [i, value] of thrown.entries()) {
      boundary.register(`t${i}`, () => { throw value })
      const state = boundary.render(`t${i}`)
      expect(state.status, `throwing ${String(value)}`).toBe('failed')
      expect(state.error?.detail, 'and still describes it without throwing').toBeTruthy()
    }
  })

  it('SURVIVES AN ERROR WHOSE OWN GETTERS THROW — it escaped the boundary before', () => {
    // Found by the P3 review. `describe()` read `.name` and `.message` OUTSIDE the try, on the
    // reasoning that reading them off an Error cannot fail. It can, and the throw escaped the
    // boundary entirely — aborting `renderAll` mid-loop so every tab after the broken one never
    // rendered. Exactly the failure the boundary exists to prevent, produced by the boundary.
    const boundary = createErrorBoundary()

    const throwingMessage = new Error('x')
    Object.defineProperty(throwingMessage, 'message', { get() { throw new Error('nope') } })
    const throwingName = new Error('x')
    Object.defineProperty(throwingName, 'name', { get() { throw new Error('nope') } })
    const proxied = new Proxy(new Error('x'), { get() { throw new Error('nope') } })

    for (const [i, hostile] of [throwingMessage, throwingName, proxied].entries()) {
      boundary.register(`h${i}`, () => { throw hostile })
      expect(() => boundary.render(`h${i}`), `hostile ${i} must not escape`).not.toThrow()
      expect(boundary.state(`h${i}`)?.status).toBe('failed')
    }
  })

  it('one hostile tab does not stop renderAll reaching the rest', () => {
    // The consequence of the escape, asserted directly: the hostile tab is FIRST.
    const rendered: string[] = []
    const boundary = createErrorBoundary()
    const proxied = new Proxy(new Error('x'), { get() { throw new Error('nope') } })
    boundary.register('hostile', () => { throw proxied })
    boundary.register('a', () => { rendered.push('a') })
    boundary.register('b', () => { rendered.push('b') })

    expect(() => boundary.renderAll()).not.toThrow()
    expect(rendered).toEqual(['a', 'b'])
  })

  it('reports a RE-ENTRANT render as failed rather than as success', () => {
    // A renderer that renders its own tab recurses until the stack overflows, and the innermost
    // catch reported `ok` all the way back out — so an infinite render looked like a success and
    // onError never fired. Re-entry is named as a failure rather than caught as a RangeError.
    const reported: BoundaryError[] = []
    const boundary = createErrorBoundary({ onError: e => reported.push(e) })
    boundary.register('loop', () => { boundary.render('loop') })

    const state = boundary.render('loop')
    expect(state.status, 'an infinite render is not a success').toBe('failed')
    expect(reported.length, 'and it is reported').toBeGreaterThan(0)
  })

  it('a tab can still render normally after a re-entrant attempt', () => {
    // The guard must not latch. Otherwise one bad render poisons the tab forever.
    let recurse = true
    const boundary = createErrorBoundary()
    boundary.register('t', () => { if (recurse) { recurse = false; boundary.render('t') } })
    boundary.render('t')
    expect(boundary.retry('t').status).toBe('ok')
  })

  it('is not taken down by a reporter that itself throws', () => {
    // A reporter that fails takes the detail with it, which is bad. Taking the boundary with it is
    // worse — the tab would escape containment on the way out of the catch.
    const boundary = createErrorBoundary({ onError: () => { throw new Error('reporter broken') } })
    boundary.register('broken', () => { throw new Error('boom') })
    expect(() => boundary.render('broken')).not.toThrow()
    expect(boundary.state('broken')?.status).toBe('failed')
  })

  it('treats an unregistered tab as a failure, not a silent no-op', () => {
    const boundary = createErrorBoundary()
    expect(boundary.render('never-registered').status).toBe('failed')
  })
})

describe('the feedback channel — A27', () => {
  function timers() {
    const pending = new Map<number, { fn: () => void; ms: number }>()
    let next = 1
    return {
      setTimer: (fn: () => void, ms: number): unknown => { pending.set(next, { fn, ms }); return next++ },
      clearTimer: (handle: unknown): void => { pending.delete(handle as number) },
      fire: (ms: number): number => {
        let fired = 0
        for (const [id, e] of [...pending]) { if (e.ms === ms) { pending.delete(id); e.fn(); fired++ } }
        return fired
      },
      count: () => pending.size,
    }
  }

  it('auto-dismisses at the annex value, 2500ms — not a number someone chose', () => {
    // §C is headed "verbatim values (preserve exactly)". This was 4000, which is exactly the drift
    // that section exists to prevent.
    expect(TOAST_MS).toBe(2_500)
  })

  it('a toast fades on its own', () => {
    const t = timers()
    const feedback = createFeedback({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    feedback.toast('info', 'Copied')
    expect(feedback.messages()).toHaveLength(1)
    t.fire(TOAST_MS)
    expect(feedback.messages()).toHaveLength(0)
  })

  it('A BANNER NEVER FADES — the rule the whole channel exists for', () => {
    // A27's persistent variant. If a "conflict artifact written" message fades after four seconds
    // while the operator is looking at their phone, the event is gone and the only record is a log they have
    // no reason to open. Auto-dismiss is a property of unimportant messages.
    const t = timers()
    const feedback = createFeedback({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    feedback.banner('warning', 'A conflict copy was written.')

    expect(t.count(), 'no timer may be scheduled for a banner at all').toBe(0)
    t.fire(TOAST_MS)
    t.fire(60_000)
    expect(feedback.messages(), 'still there').toHaveLength(1)
  })

  it('a banner cannot be given a timeout even by mistake — the signature has no duration', () => {
    const feedback = createFeedback()
    const id = feedback.banner('danger', 'A save failed.')
    const message = feedback.messages().find(m => m.id === id)
    expect(message?.timeoutMs).toBeUndefined()
  })

  it('is dismissed only by hand', () => {
    const feedback = createFeedback()
    const id = feedback.banner('danger', 'A save failed.')
    expect(feedback.messages()).toHaveLength(1)
    feedback.dismiss(id)
    expect(feedback.messages()).toHaveLength(0)
  })

  it('a flood of toasts CANNOT push a banner off the screen', () => {
    // Otherwise a noisy operation is a denial of service against the one message class that cannot
    // be re-derived.
    const feedback = createFeedback()
    feedback.banner('danger', 'A save failed.')
    for (let i = 0; i < MAX_MESSAGES * 3; i++) feedback.toast('info', `noise ${i}`)

    const banners = feedback.messages().filter(m => m.kind === 'banner')
    expect(banners, 'the banner survives').toHaveLength(1)
    expect(banners[0]?.text).toBe('A save failed.')
  })

  it('drops the OLDEST toast when capped, not the newest', () => {
    const feedback = createFeedback()
    for (let i = 0; i < MAX_MESSAGES + 2; i++) feedback.toast('info', `t${i}`)
    const texts = feedback.messages().map(m => m.text)
    expect(texts).not.toContain('t0')
    expect(texts, 'the most recent is what the user is looking at').toContain(`t${MAX_MESSAGES + 1}`)
  })

  it('keeps every banner even past the cap, rather than losing one', () => {
    // A screen with seven banners is a problem. A screen missing the one saying a save failed is
    // a lost file.
    const feedback = createFeedback()
    for (let i = 0; i < MAX_MESSAGES + 3; i++) feedback.banner('danger', `b${i}`)
    expect(feedback.messages()).toHaveLength(MAX_MESSAGES + 3)
  })

  it('cancels a toast timer when it is dismissed early', () => {
    const t = timers()
    const feedback = createFeedback({ setTimer: t.setTimer, clearTimer: t.clearTimer })
    const id = feedback.toast('info', 'Copied')
    feedback.dismiss(id)
    expect(t.count(), 'a timer for a removed message is a leak').toBe(0)
  })

  it('announces every change so a view can re-render', () => {
    const seen: number[] = []
    const feedback = createFeedback({ onChange: m => seen.push(m.length) })
    const id = feedback.toast('info', 'a')
    feedback.banner('danger', 'b')
    feedback.dismiss(id)
    expect(seen).toEqual([1, 2, 1])
  })
})
