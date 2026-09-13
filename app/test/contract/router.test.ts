import { describe, expect, it } from 'vitest'

import {
  ROUTES, carriedOn, routeNamesFor, routeRequiresToken, type RouteName,
} from '../../src/contract/routes'
import { createRouter, type Handlers } from '../../src/contract/router'
import { TransportErrorCode } from '../../src/contract/wire'

/**
 * Spec §6: "One validation wrapper, and the route table is generated from it so an unchecked route
 * cannot exist." Spec §7: privileged handlers "are **not registered on its router at all**, so
 * forgetting a check is not expressible."
 *
 * Both are structural claims. These tests check the structure rather than the intent — a claim of
 * the form "cannot exist" is worth exactly as much as the test that tries to make it exist.
 */

const spies = () => {
  const calls: Array<{ route: string; input: unknown }> = []
  const handler = (route: string) => (input: unknown) => {
    calls.push({ route, input })
    return { echoed: true }
  }
  const handlers = Object.fromEntries(
    (Object.keys(ROUTES) as RouteName[]).map(name => [name, handler(name)]),
  ) as unknown as Handlers
  return { calls, handlers }
}

describe('the route table', () => {
  it('gives every route a validator — checked at runtime, not only by the type', () => {
    // The type makes `input` required, so this can only fail via an `as any` cast somewhere. That
    // is precisely the escape hatch worth pinning: the whole claim rests on it not being used.
    for (const [name, definition] of Object.entries(ROUTES)) {
      expect(typeof definition.input, `${name} has no validator`).toBe('function')
      expect(definition.method, `${name} must be POST — spec §7 method policy`).toBe('POST')
      expect(['local-only', 'both', 'tailnet-only']).toContain(definition.carriedBy)
      expect(['token', 'none']).toContain(definition.auth)
    }
  })

  /**
   * **THERE ARE NO `local-only` ROUTES, AND ON 2026-08-14 THAT STOPPED BEING A COINCIDENCE.**
   *
   * This assertion has now held three shapes, and the third is the one that explains the other two.
   *
   * It began as *"declares at least one privileged route, so the separation is exercised"* — a guard
   * against the tests below passing vacuously. On **2026-08-09** it fired for real: the operator moved the
   * last three (`folders.register`, `folders.browse`, `folders.deregister`) to `both` after being
   * shown the split could not do what it appeared to. It became *"there are none, and that is a
   * decision rather than drift"*.
   *
   * On **2026-08-14** §10's `file.reveal` was built as `local-only`, exactly as the spec says, and
   * this test went red — correctly. Then the route turned out to be **unreachable**: the client calls
   * same-origin paths, the page exists only on the tailnet listener (`bootstrap.ts` gives the local
   * one no asset map), so every request the interface makes reaches the tailnet router, where a
   * `local-only` route is absent. The operator ruled it to `both`, with §18.8 keeping the phone out in the
   * interface instead.
   *
   * **So the count is back to zero, and now for a structural reason rather than a passing one:
   * `local-only` cannot serve anything a person clicks.** It would need a caller that is not the
   * browser — a CLI, a script — and none exists. That is worth knowing before someone marks a fourth
   * route `local-only` believing it stays available on the Mac. It does not.
   */
  it('has no local-only routes, because nothing a person clicks could reach one', () => {
    const local = Object.entries(ROUTES)
      .filter(([, r]) => (r.carriedBy as string) === 'local-only')
    expect(local.map(([name]) => name), 'see the note above before changing this').toEqual([])
  })

  /**
   * THE SECURITY REVIEW'S B1. The token exemption is a fact about the table, and exactly one route may hold it.
   *
   * This is the test that would catch the failure that matters: a second unauthenticated route
   * added later, by someone who saw `auth: 'none'` already in the table and read it as an available
   * option rather than a ruled exception. It is not a style check — an unauthenticated route is a
   * route that hands out capability to anyone who can reach the listener.
   */
  it('has EXACTLY ONE route that does not require the token, and it is the session route', () => {
    const unauthenticated = Object.entries(ROUTES)
      .filter(([, definition]) => definition.auth === 'none')
      .map(([name]) => name)

    expect(
      unauthenticated,
      'a route was given auth: "none". That is a security ruling (security review, 2026-08-07, B1), not a ' +
      'configuration option. If a second one is genuinely needed it goes to the security review first.',
    ).toEqual(['session.start'])
  })

  it('requires the token for an unknown or missing route name — default-deny', () => {
    // The whole point of B1: an attacker-supplied string must never select the weaker guard chain.
    expect(routeRequiresToken('session.start')).toBe(false)
    expect(routeRequiresToken('folders.list')).toBe(true)
    expect(routeRequiresToken(null)).toBe(true)
    expect(routeRequiresToken('does.not.exist')).toBe(true)
    expect(routeRequiresToken('')).toBe(true)
    // Prototype keys must not resolve to a definition. `Object.hasOwn` rather than `in`.
    expect(routeRequiresToken('constructor')).toBe(true)
    expect(routeRequiresToken('__proto__')).toBe(true)
    expect(routeRequiresToken('toString')).toBe(true)
  })

  it('keeps the session route off the local listener — security review B3', () => {
    // The local listener serves no client, so nothing legitimate would call it there. With
    // per-listener tokens it would be an unauthenticated dispenser of the PRIVILEGED token.
    expect(routeNamesFor('local')).not.toContain('session.start')
    expect(routeNamesFor('tailnet')).toContain('session.start')
  })
})

describe('privilege is structural — the tailnet router does not HAVE the privileged routes', () => {
  /**
   * **Proven against a constructed table, because the real one no longer uses `local-only`.**
   *
   * This asserted that `folders.register`, `folders.browse` and `folders.deregister` were absent
   * from the tailnet router. They are all `both` as of 2026-08-09 — see the note above — so the old
   * assertions would now be false, and simply deleting them would leave the *mechanism* untested
   * on the day someone marks a route privileged again.
   *
   * So the machinery is exercised directly. `routeNamesFor` is a pure function of a carriage value;
   * it does not care whether any shipped route currently holds one.
   */
  it('THE RULE ITSELF: a local-only route reaches only the local listener', () => {
    // `carriedOn` takes a carriage value, so the rule is provable with no route using it.
    expect(carriedOn('local-only', 'local')).toBe(true)
    expect(carriedOn('local-only', 'tailnet')).toBe(false)
    expect(carriedOn('tailnet-only', 'tailnet')).toBe(true)
    expect(carriedOn('tailnet-only', 'local')).toBe(false)
    expect(carriedOn('both', 'local')).toBe(true)
    expect(carriedOn('both', 'tailnet')).toBe(true)
  })

  it('and the real table is filtered by exactly that rule', () => {
    for (const name of Object.keys(ROUTES) as RouteName[]) {
      const carriage = ROUTES[name].carriedBy
      expect(new Set(routeNamesFor('tailnet')).has(name), `${name} on tailnet`)
        .toBe(carriedOn(carriage, 'tailnet'))
      expect(new Set(routeNamesFor('local')).has(name), `${name} on local`)
        .toBe(carriedOn(carriage, 'local'))
    }
  })

  it('the local listener carries every ordinary and privileged route', () => {
    /**
     * It used to carry *everything*, because "local is strictly more privileged" was expressible
     * only as "local gets all routes." **the security review's B3 broke that**, and the exception is deliberate:
     * `session.start` is `tailnet-only`.
     *
     * The reasoning is not privilege but purpose. The local listener serves no client, so nothing
     * legitimate would ever call the session route there — and with per-listener tokens (B2), a
     * bootstrap route on the local listener would be an unauthenticated dispenser of the
     * **privileged** token, with zero legitimate callers.
     *
     * So the assertion is "everything except what is deliberately withheld," and the withheld set
     * is derived from the table rather than hardcoded, so a future `tailnet-only` route does not
     * need this test edited to keep passing.
     */
    const local = new Set(routeNamesFor('local'))
    for (const [name, definition] of Object.entries(ROUTES)) {
      const expected = definition.carriedBy !== 'tailnet-only'
      expect(local.has(name as RouteName), `${name} on the local listener`).toBe(expected)
    }
  })

  it('a built tailnet router has no key for a route withheld from it', () => {
    // `session.start` is the one route still withheld from a listener (from LOCAL, per the security review's B3).
    // It is what keeps this assertion about the mechanism rather than about a particular verb.
    const { handlers } = spies()
    const router = createRouter('local', handlers)
    expect(router.names.has('session.start')).toBe(false)
  })

  /**
   * Uses `session.start` on the LOCAL router, because that is the only route still withheld from a
   * listener. It used to use `folders.register` on the tailnet router; that route is `both` as of
   * 2026-08-09, so the assertion would have passed vacuously — the handler would not run because
   * the *dispatch* succeeded and the spy recorded it, which is the opposite of what this checks.
   */
  it('refuses a withheld route as NOT_FOUND, never invoking its handler', async () => {
    const { calls, handlers } = spies()
    const router = createRouter('local', handlers)
    const outcome = await router.dispatch('session.start', 'POST', {})

    expect(outcome.status).toBe(404)
    if (!outcome.response.ok) expect(outcome.response.error.code).toBe(TransportErrorCode.NOT_FOUND)
    expect(calls, 'the withheld handler must never run').toEqual([])
  })

  it('does not confirm the route exists — a distinct refusal would be a map for an attacker', async () => {
    const { handlers } = spies()
    const router = createRouter('local', handlers)
    const withheld = await router.dispatch('session.start', 'POST', {})
    const nonsense = await router.dispatch('there.is.no.such.route', 'POST', {})

    // Byte-identical responses. This is the same reasoning as a login that will not tell you
    // whether the username was wrong.
    expect(withheld.response).toEqual(nonsense.response)
    expect(withheld.status).toBe(nonsense.status)
  })

  it('the same route IS reachable on the local listener', async () => {
    const { calls, handlers } = spies()
    const router = createRouter('local', handlers)
    const outcome = await router.dispatch(
      'folders.register', 'POST',
      { id: 'soil', absolutePath: '/tmp/x' },
    )

    expect(outcome.status).toBe(200)
    expect(calls.map(c => c.route)).toEqual(['folders.register'])
  })
})

describe('validation runs before the handler, with no path around it', () => {
  it('never invokes a handler on invalid input', async () => {
    const { calls, handlers } = spies()
    const router = createRouter('tailnet', handlers)

    const bad = [
      { body: { rootId: 'soil', segments: ['..'] }, why: 'traversal' },
      { body: { rootId: 'soil', segments: ['a/b'] }, why: 'separator' },
      { body: { rootId: 'soil', segments: [1] }, why: 'non-string segment' },
      { body: { rootId: 'soil' }, why: 'missing field' },
      { body: { rootId: 'soil', segments: [], extra: true }, why: 'unknown field' },
      { body: JSON.parse('{"rootId":"soil","segments":[],"__proto__":{"x":1}}'), why: 'poison key' },
      { body: 'not an object', why: 'wrong type entirely' },
      { body: null, why: 'null' },
    ]

    for (const { body, why } of bad) {
      const outcome = await router.dispatch('tree.children', 'POST', body)
      expect(outcome.response.ok, `${why} must be refused`).toBe(false)
    }
    expect(calls, 'no handler may run for any invalid input').toEqual([])
  })

  it('passes the VALIDATED value to the handler, not the raw body', async () => {
    const { calls, handlers } = spies()
    const router = createRouter('tailnet', handlers)
    await router.dispatch('tree.children', 'POST', { rootId: 'soil', segments: ['a', 'b.md'] })

    expect(calls).toHaveLength(1)
    const input = calls[0]?.input as { rootId: string; segments: string[] }
    expect(input.rootId).toBe('soil')
    expect(input.segments).toEqual(['a', 'b.md'])
    // The validated object has a null prototype — evidence it came through the validator rather
    // than being forwarded.
    expect(Object.getPrototypeOf(input)).toBeNull()
  })

  it('enforces the method policy', async () => {
    const { calls, handlers } = spies()
    const router = createRouter('tailnet', handlers)
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'PATCH']) {
      const outcome = await router.dispatch('tree.children', method, { rootId: 'soil', segments: [] })
      expect(outcome.status, `${method} must be refused`).toBe(405)
    }
    expect(calls, 'no handler runs on a disallowed method').toEqual([])
  })
})

describe('errors say nothing they should not', () => {
  it('carries a stable code and a fixed message, never the failing value', async () => {
    const { handlers } = spies()
    const router = createRouter('tailnet', handlers)
    const secret = '/Users/hallberg/private/secret-folder-name'
    const outcome = await router.dispatch('tree.children', 'POST', {
      rootId: 'soil', segments: [secret],
    })

    expect(outcome.response.ok).toBe(false)
    const serialised = JSON.stringify(outcome.response)
    expect(serialised, 'the failing value must not be echoed').not.toContain(secret)
    expect(serialised).not.toContain('hallberg')
  })

  it('keeps the detail server-side, where the local log can use it', async () => {
    const { handlers } = spies()
    const router = createRouter('tailnet', handlers)
    const outcome = await router.dispatch('tree.children', 'POST', { rootId: 'soil', segments: ['..'] })

    // Detail exists for the log...
    expect(outcome.failure?.at).toBe('$.segments[0]')
    // ...and is not part of the response.
    expect(JSON.stringify(outcome.response)).not.toContain('segments[0]')
  })

  it('does not leak a thrown handler error, and does not convert it to empty success', async () => {
    // Spec §6: "An empty-but-successful result never stands in for a failure. No catch block
    // converts failure to empty success." A handler that throws must produce a typed error.
    const { handlers } = spies()
    const throwing = {
      ...handlers,
      'tree.children': () => { throw new Error('ENOENT: /Users/hallberg/notes/private.md') },
    } as unknown as Handlers
    const router = createRouter('tailnet', throwing)
    const outcome = await router.dispatch('tree.children', 'POST', { rootId: 'soil', segments: [] })

    expect(outcome.response.ok).toBe(false)
    expect(outcome.status).toBe(500)
    const serialised = JSON.stringify(outcome.response)
    expect(serialised).not.toContain('ENOENT')
    expect(serialised).not.toContain('private.md')
    expect(serialised).not.toContain('hallberg')
  })

  it('an empty result is a SUCCESS carrying an empty list, not an error', async () => {
    // The converse, and the one v1 got backwards. An empty directory must be distinguishable from
    // a failed read by the client, without inspecting a message.
    const empty = {
      ...spies().handlers,
      'tree.children': () => [],
    } as unknown as Handlers
    const router = createRouter('tailnet', empty)
    const outcome = await router.dispatch('tree.children', 'POST', { rootId: 'soil', segments: [] })

    expect(outcome.response.ok).toBe(true)
    if (outcome.response.ok) expect(outcome.response.data).toEqual([])
  })
})

describe('the handler map is total', () => {
  it('every declared route has a handler at runtime', () => {
    // The type enforces this; the runtime check catches an `as unknown as Handlers` cast, which is
    // exactly what these tests themselves use and therefore what a careless caller would copy.
    const { handlers } = spies()
    for (const name of Object.keys(ROUTES)) {
      expect(typeof (handlers as unknown as Record<string, unknown>)[name], `${name} unhandled`)
        .toBe('function')
    }
  })

  it('dispatch is the only way in — a handler is not exposed on the router', () => {
    const { handlers } = spies()
    const router = createRouter('tailnet', handlers)
    const surface = Object.keys(router)
    expect(surface.sort()).toEqual(['dispatch', 'names', 'privilege'])
  })
})

describe('an unknown route', () => {
  it('is refused without invoking anything', async () => {
    const { calls, handlers } = spies()
    const router = createRouter('tailnet', handlers)
    const outcome = await router.dispatch('__proto__', 'POST', {})

    // Also a poison-key probe: a Map lookup is immune to prototype keys where a plain object is not.
    expect(outcome.status).toBe(404)
    expect(calls).toEqual([])
  })

  it('cannot be reached through a prototype key on the route map', async () => {
    const { handlers } = spies()
    const router = createRouter('tailnet', handlers)
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const outcome = await router.dispatch(name, 'POST', {})
      expect(outcome.status, `${name} must not resolve`).toBe(404)
    }
  })
})

describe('the spy harness itself is not lying', () => {
  it('records a call when a handler genuinely runs', async () => {
    // Every "handler never ran" assertion above depends on this. A harness that never records
    // would make all of them pass vacuously.
    const { calls, handlers } = spies()
    const router = createRouter('tailnet', handlers)
    await router.dispatch('folders.list', 'POST', {})
    expect(calls.map(c => c.route)).toEqual(['folders.list'])
  })

})
