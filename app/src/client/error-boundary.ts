/**
 * Per-tab error boundaries. Build-plan §3's second acceptance condition for this phase:
 * **"error boundary proven with a deliberately broken tab."**
 *
 * Framework-free, because there is no framework — spec §2 keeps the client dependency-light and the
 * renderer builds DOM directly. A boundary is therefore not a component; it is a rule about who
 * catches what.
 *
 * THE PROPERTY: **one tab throwing must not take the app with it.** A crash is contained to the tab
 * that caused it, the other tabs keep working, and the broken one shows a named error rather than a
 * blank panel. Blank is the failure mode that matters — this build's entire history is failures
 * that presented as *empty* rather than as *wrong*, and a tab that renders nothing after a throw is
 * indistinguishable from a folder with nothing in it.
 *
 * WHAT IT DOES NOT DO: it does not retry automatically, and it does not swallow. A boundary that
 * silently re-renders on a loop turns one bug into a spinning CPU; a boundary that hides the error
 * is how a broken tab reaches the operator looking merely empty. It reports, it isolates, and it offers
 * an explicit retry.
 */

export interface BoundaryError {
  readonly tabId: string
  /** A fixed, human-readable line. Never an exception message — see `describe` below. */
  readonly message: string
  /** The full detail, for the local report channel only. */
  readonly detail: string
}

export type TabRender = () => void

export interface TabState {
  readonly id: string
  readonly status: 'ok' | 'failed'
  readonly error: BoundaryError | null
}

export interface ErrorBoundaryOptions {
  /**
   * Where the detail goes. Spec §6's discipline applied to the client: the surface says a fixed
   * line, the report carries everything.
   */
  readonly onError?: (error: BoundaryError) => void
}

export interface ErrorBoundary {
  readonly register: (tabId: string, render: TabRender) => void
  /** Renders one tab inside the boundary. Never throws. */
  readonly render: (tabId: string) => TabState
  /** Renders every registered tab. One failure does not stop the others. */
  readonly renderAll: () => TabState[]
  readonly state: (tabId: string) => TabState | undefined
  readonly states: () => TabState[]
  /** Clears a tab's failure and renders it again. Explicit — never automatic. */
  readonly retry: (tabId: string) => TabState
}

/**
 * What the user sees. One sentence, no exception text, no stack.
 *
 * The client renders errors **as text, never as markdown** (spec §6) — and this is a plain string
 * that goes through `textContent`, so there is nothing to render either way.
 */
const USER_MESSAGE = 'This tab could not be displayed.'

/** Everything a thrown value can contribute, without assuming it is an Error. */
function describe(thrown: unknown): string {
  // EVERYTHING is inside the try, including the `instanceof Error` branch. The first version put
  // only `JSON.stringify` inside it, on the reasoning that reading `.name` and `.message` off an
  // Error cannot fail. It can: an Error with a throwing `message` getter, or a Proxy wrapping one,
  // throws on property access — and the throw escaped the boundary entirely, aborting `renderAll`
  // mid-loop so every tab after the broken one never rendered. Exactly the failure the boundary
  // exists to prevent, produced by the boundary. Found by the P3 review.
  try {
    if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`
    if (typeof thrown === 'string') return `non-Error thrown: ${thrown}`
    if (thrown === undefined) return 'non-Error thrown: undefined'
    if (thrown === null) return 'non-Error thrown: null'
    return `non-Error thrown: ${JSON.stringify(thrown)}`
  } catch {
    // A circular object, a BigInt, a hostile toJSON, a throwing getter, a Proxy. Failing to
    // describe an error must not itself throw — that takes out the thing catching the throwing.
    return 'thrown value could not be described'
  }
}

export function createErrorBoundary(options: ErrorBoundaryOptions = {}): ErrorBoundary {
  const renders = new Map<string, TabRender>()
  const states = new Map<string, TabState>()

  // Tabs currently mid-render. A renderer that renders its own tab recurses until the stack
  // overflows, and the innermost frame's catch reported `ok` all the way back out — so an infinite
  // render looked like a success and `onError` never fired. Re-entry is a failure, and naming it
  // one is cheaper and clearer than catching a RangeError.
  const rendering = new Set<string>()
  // Tabs that re-entered during the current render. The inner call detecting re-entry is not
  // enough: the OUTER call then finishes normally and overwrites the failure with `ok`, which is
  // exactly what happened on the first attempt at this fix. The outer render has to inherit it.
  const reentered = new Set<string>()

  const runOne = (tabId: string): TabState => {
    if (rendering.has(tabId)) {
      reentered.add(tabId)
      const error: BoundaryError = {
        tabId, message: USER_MESSAGE, detail: 're-entrant render: this tab rendered itself',
      }
      const state: TabState = { id: tabId, status: 'failed', error }
      states.set(tabId, state)
      return state
    }

    const render = renders.get(tabId)
    if (render === undefined) {
      const state: TabState = {
        id: tabId,
        status: 'failed',
        error: { tabId, message: USER_MESSAGE, detail: 'no renderer registered for this tab' },
      }
      states.set(tabId, state)
      return state
    }

    rendering.add(tabId)
    reentered.delete(tabId)
    try {
      render()
      if (reentered.has(tabId)) {
        const error: BoundaryError = {
          tabId, message: USER_MESSAGE, detail: 're-entrant render: this tab rendered itself',
        }
        const state: TabState = { id: tabId, status: 'failed', error }
        states.set(tabId, state)
        try { options.onError?.(error) } catch { /* the reporter is broken too */ }
        return state
      }
      const state: TabState = { id: tabId, status: 'ok', error: null }
      states.set(tabId, state)
      return state
    } catch (thrown) {
      const error: BoundaryError = { tabId, message: USER_MESSAGE, detail: describe(thrown) }
      const state: TabState = { id: tabId, status: 'failed', error }
      states.set(tabId, state)
      // Reporting must not be able to re-throw into the boundary. A reporter that fails takes the
      // detail with it, which is bad; taking the boundary with it is worse.
      try {
        options.onError?.(error)
      } catch {
        /* the reporter is broken too; the tab is still isolated */
      }
      return state
    } finally {
      rendering.delete(tabId)
      reentered.delete(tabId)
    }
  }

  return {
    register: (tabId, render) => { renders.set(tabId, render) },
    render: runOne,
    renderAll: () => [...renders.keys()].map(runOne),
    state: tabId => states.get(tabId),
    states: () => [...states.values()],
    retry: tabId => runOne(tabId),
  }
}
