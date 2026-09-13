import { describe, expect, it } from 'vitest'

import { TOKEN_HEADER, createSessionClient, type HttpReply } from '../../src/client/session'

/**
 * The client's credentials — the security review's B6 and B7.
 *
 * Two values that must never cross: the token travels only in a custom header (its whole CSRF
 * property is that a cross-origin caller cannot set one), the ticket only in the stream URL (because
 * `EventSource` cannot set a header at all). A token that reached a URL would void the property it
 * exists for, and a URL is the most reachable place a value can sit.
 */

const TOKEN = 'a'.repeat(32)
const TICKET = 'b'.repeat(32)

interface Call {
  path: string
  body: unknown
  headers: Readonly<Record<string, string>>
}

/** Records every request, and answers each path from a queue so a sequence can be scripted. */
function transport(script: Record<string, Array<HttpReply | (() => HttpReply)>>) {
  const calls: Call[] = []
  const remaining = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]))

  const post = async (
    path: string, body: unknown, headers: Readonly<Record<string, string>>,
  ): Promise<HttpReply> => {
    calls.push({ path, body, headers })
    const queue = remaining.get(path)
    const next = queue?.shift()
    if (next === undefined) return { status: 404, body: null }
    return typeof next === 'function' ? next() : next
  }

  return { post, calls, countOf: (path: string) => calls.filter(c => c.path === path).length }
}

const session = (overrides: Partial<{ token: string; streamTicket: string }> = {}): HttpReply => ({
  status: 200,
  body: { ok: true, data: { token: TOKEN, streamTicket: TICKET, ...overrides } },
})

const OK: HttpReply = { status: 200, body: { ok: true, data: { rows: [] } } }
const FORBIDDEN: HttpReply = { status: 403, body: { ok: false } }
const THROTTLED: HttpReply = { status: 429, body: { ok: false } }

describe('obtaining a session', () => {
  it('fetches credentials once and reuses them', async () => {
    const t = transport({ '/api/session.start': [session()], '/api/folders.list': [OK, OK, OK] })
    const client = createSessionClient(t.post)

    await client.call('folders.list')
    await client.call('folders.list')
    await client.call('folders.list')

    expect(t.countOf('/api/session.start'), 'one session, not one per request').toBe(1)
  })

  it('does not mint several sessions when calls overlap', async () => {
    // Five requests fired at once on a cold start is the normal case for a screen that loads, and
    // five sessions would burn five tickets out of a bounded pool for one client.
    const t = transport({
      '/api/session.start': [session()],
      '/api/folders.list': [OK, OK, OK, OK, OK],
    })
    const client = createSessionClient(t.post)

    await Promise.all(Array.from({ length: 5 }, () => client.call('folders.list')))

    expect(t.countOf('/api/session.start')).toBe(1)
  })

  /**
   * **The assertion whose absence cost a browser session to find.**
   *
   * `call()` took a full path while being named `route`, and its one in-module caller hardcoded
   * `/api/session.start`. P7's first real caller passed `folders.list` — the name the route table
   * uses — and the request went to `/folders.list`, 404'd, and the Files tab reported no registered
   * folders over a folder that was registered.
   *
   * Every test here passed throughout, because they each passed a full path *and* asserted against
   * that same full path. The one thing none of them asked was **what `call` does to its argument**.
   */
  it('builds the path from a route NAME — call(\'folders.list\') hits /api/folders.list', async () => {
    const t = transport({ '/api/session.start': [session()], '/api/folders.list': [OK] })
    const client = createSessionClient(t.post)
    await client.call('folders.list')

    expect(t.calls.map(c => c.path)).toContain('/api/folders.list')
    expect(t.calls.map(c => c.path), 'a bare route name must never reach the network')
      .not.toContain('folders.list')
  })

  it('sends NO token on the session route itself', async () => {
    // It is the route that issues the token, so it cannot require one.
    const t = transport({ '/api/session.start': [session()] })
    const client = createSessionClient(t.post)
    await client.streamUrl()

    const call = t.calls.find(c => c.path === '/api/session.start')
    expect(call?.headers[TOKEN_HEADER]).toBeUndefined()
  })

  it('refuses a malformed session response rather than carrying undefined around', async () => {
    for (const body of [
      null, {}, { ok: true }, { ok: true, data: {} },
      { ok: true, data: { token: TOKEN } },
      { ok: true, data: { token: '', streamTicket: TICKET } },
      { ok: true, data: { token: 5, streamTicket: TICKET } },
      { ok: false, data: { token: TOKEN, streamTicket: TICKET } },
    ]) {
      const t = transport({ '/api/session.start': [{ status: 200, body }] })
      const client = createSessionClient(t.post)
      const result = await client.call('folders.list')
      expect(result.ok, `body ${JSON.stringify(body)} must not yield a session`).toBe(false)
    }
  })
})

describe('the two values never cross — security review B7', () => {
  it('puts the token in the header and never in a URL', async () => {
    const t = transport({ '/api/session.start': [session(), session()], '/api/folders.list': [OK] })
    const client = createSessionClient(t.post)

    await client.call('folders.list')
    const url = await client.streamUrl()

    const call = t.calls.find(c => c.path === '/api/folders.list')
    expect(call?.headers[TOKEN_HEADER]).toBe(TOKEN)
    expect(url, 'the token must never appear in a URL').not.toContain(TOKEN)
    for (const recorded of t.calls) {
      expect(recorded.path, 'no request path may carry the token').not.toContain(TOKEN)
    }
  })

  it('puts the ticket in the URL and never in a header', async () => {
    const t = transport({ '/api/session.start': [session(), session()], '/api/folders.list': [OK] })
    const client = createSessionClient(t.post)

    const url = await client.streamUrl()
    await client.call('folders.list')

    expect(url).toContain(TICKET)
    for (const recorded of t.calls) {
      expect(
        JSON.stringify(recorded.headers),
        'no request header may carry the stream ticket',
      ).not.toContain(TICKET)
    }
  })

  it('builds a RELATIVE stream url with the ticket as a query parameter', async () => {
    const t = transport({ '/api/session.start': [session()] })
    const client = createSessionClient(t.post)
    const url = await client.streamUrl()

    // Spec §7/F9.3: no absolute URL, port or hostname anywhere in the bundle.
    expect(url.startsWith('/events?')).toBe(true)
    expect(url).not.toContain('://')
    expect(url).toBe(`/events?ticket=${TICKET}`)
  })

  it('escapes the ticket, so a loosened server shape cannot inject a second parameter', async () => {
    const t = transport({
      '/api/session.start': [session({ streamTicket: 'abc&admin=1' })],
    })
    const client = createSessionClient(t.post)
    const url = await client.streamUrl()
    expect(url).toBe('/events?ticket=abc%26admin%3D1')
  })
})

describe('recovery is bounded and status-aware — security review B6', () => {
  it('renews ONCE on a 403 and retries', async () => {
    // A 403 means the server restarted and minted new values. One refetch and one retry is the whole
    // recovery, and it needs no page reload — which matters because an installed iOS web app is
    // resumed and never relaunched.
    const t = transport({
      '/api/session.start': [session(), session({ token: 'c'.repeat(32) })],
      '/api/folders.list': [FORBIDDEN, OK],
    })
    const client = createSessionClient(t.post)

    const result = await client.call('folders.list')

    expect(result.ok).toBe(true)
    expect(t.countOf('/api/session.start'), 'exactly one renewal').toBe(2)
    expect(t.countOf('/api/folders.list'), 'exactly one retry').toBe(2)
    // The retry must carry the NEW token, not the one that was just refused.
    expect(t.calls.filter(c => c.path === '/api/folders.list')[1]?.headers[TOKEN_HEADER])
      .toBe('c'.repeat(32))
  })

  it('gives up after ONE renewal — a second 403 is not retried', async () => {
    // A server refusing a credential it has just issued cannot be fixed by asking again, and a
    // counter to tune here is a loop waiting to happen.
    const t = transport({
      '/api/session.start': [session(), session(), session()],
      '/api/folders.list': [FORBIDDEN, FORBIDDEN, OK],
    })
    const client = createSessionClient(t.post)

    const result = await client.call('folders.list')

    expect(result.ok).toBe(false)
    expect(t.countOf('/api/folders.list'), 'two attempts, never a third').toBe(2)
  })

  it('NEVER renews on a 429 — the condition that stops a self-amplifying loop', async () => {
    /**
     * The load-bearing half of B6. The rate limiter is keyed on an address that `tailscale serve`
     * collapses to `127.0.0.1`, so its bucket is **shared across every device**. A client that
     * treated any failure as "session is stale, refetch" would hammer the session route while
     * throttled — deepening the throttle for every other device, out of a recovery path.
     */
    const t = transport({
      '/api/session.start': [session()],
      '/api/folders.list': [THROTTLED, OK],
    })
    const client = createSessionClient(t.post)

    const result = await client.call('folders.list')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(429)
    expect(t.countOf('/api/session.start'), 'a 429 must NOT trigger a renewal').toBe(1)
    expect(t.countOf('/api/folders.list'), 'and must NOT be retried').toBe(1)
  })

  it('does not renew on 500 or 404 either — only 403 means the credential is stale', async () => {
    for (const status of [400, 404, 413, 500, 503]) {
      const t = transport({
        '/api/session.start': [session()],
        '/api/folders.list': [{ status, body: null }, OK],
      })
      const client = createSessionClient(t.post)
      const result = await client.call('folders.list')

      expect(result.ok, `${status} must not be treated as success`).toBe(false)
      expect(t.countOf('/api/session.start'), `${status} must not renew`).toBe(1)
    }
  })

  it('survives the transport throwing rather than propagating it', async () => {
    // A network failure on the session route must present as "no session", not as an unhandled
    // rejection from a visibilitychange handler, where a throw goes nowhere at all.
    const t = transport({ '/api/session.start': [() => { throw new Error('offline') }] })
    const client = createSessionClient(t.post)

    await expect(client.call('folders.list')).resolves.toMatchObject({ ok: false })
    await expect(client.streamUrl()).rejects.toThrow()
  })
})

describe('a fresh ticket on every client-initiated connect — security review C6', () => {
  it('obtains a new ticket after the session is reset', async () => {
    /**
     * The failure this prevents: the operator restarts the Mac, the server mints new credentials, and a
     * client holding one ticket reconnects forever against a value that will never be accepted —
     * on a phone whose installed web app is resumed and never relaunched, so nothing reloads to fix
     * it. `EventSource`'s `onerror` cannot distinguish that from "server down".
     */
    const t = transport({
      '/api/session.start': [session(), session({ streamTicket: 'd'.repeat(32) })],
    })
    const client = createSessionClient(t.post)

    expect(await client.streamUrl()).toContain(TICKET)
    client.reset()
    expect(await client.streamUrl()).toContain('d'.repeat(32))
  })

  /**
   * **THIS TEST USED TO ASSERT THE DEFECT.** It was called *"does not re-fetch when the session is
   * still good"* and required three `streamUrl()` calls to produce **one** `session.start` — which is
   * precisely the caching that made C6 undeliverable. It would have stayed green with C6 deleted,
   * because it was pinning the bug.
   *
   * Inverted rather than removed, per the rule this build applies elsewhere: a deleted test leaves no
   * record that the behaviour ever changed.
   */
  it('obtains a FRESH ticket on every connect attempt, never a cached one', async () => {
    const t = transport({
      '/api/session.start': [
        session(),
        session({ streamTicket: 'd'.repeat(32) }),
        session({ streamTicket: 'e'.repeat(32) }),
      ],
    })
    const client = createSessionClient(t.post)

    const first = await client.streamUrl()
    const second = await client.streamUrl()
    const third = await client.streamUrl()

    expect(t.countOf('/api/session.start'), 'one fetch per connect attempt').toBe(3)
    expect(first).toContain(TICKET)
    expect(second).toContain('d'.repeat(32))
    expect(third).toContain('e'.repeat(32))
  })

  it('recovers from a rotated server ticket with no page reload — C6\'s required proof', async () => {
    /**
     * The condition's own words: *"Proven by a test that rotates the server's ticket mid-flight and
     * asserts the client reconnects without a page reload."* This test did not exist, and C6 was
     * recorded as met without it.
     *
     * The scenario is a Mac restart. The server mints new credentials; the phone's installed web app
     * is **resumed, never relaunched**, so nothing reloads the page. `EventSource.onerror` cannot
     * distinguish "bad ticket" from "server down", so the only thing that can save it is fetching a
     * fresh ticket on the next attempt — which is the whole of C6.
     */
    const live = { ticket: TICKET }
    const t = transport({
      '/api/session.start': [
        () => ({ status: 200, body: { ok: true, data: { token: TOKEN, streamTicket: live.ticket } } }),
        () => ({ status: 200, body: { ok: true, data: { token: TOKEN, streamTicket: live.ticket } } }),
      ],
    })
    const client = createSessionClient(t.post)

    expect(await client.streamUrl()).toContain(TICKET)

    // The server restarts and everything it issued before is now refused.
    live.ticket = 'f'.repeat(32)

    // The next connect attempt — no reload, no reset() call, nothing but the stream retrying.
    expect(
      await client.streamUrl(),
      'the reconnect must carry the ticket the NEW server issued, or the app is bricked until reinstalled',
    ).toContain('f'.repeat(32))
  })

  it('an API call still uses the cached session, so a screen does not mint one per request', async () => {
    // The other half of the split: `call()` caches, `streamUrl()` does not. Minting a session per
    // API request would burn a bounded pool for no reason.
    const t = transport({
      '/api/session.start': [session()],
      '/api/folders.list': [OK, OK, OK],
    })
    const client = createSessionClient(t.post)

    await client.call('folders.list')
    await client.call('folders.list')
    await client.call('folders.list')

    expect(t.countOf('/api/session.start')).toBe(1)
  })
})

/**
 * §6's error envelope, reaching the caller. Added 2026-08-09.
 *
 * §6 specifies that a refusal carries *"stable machine codes"* and a message *"chosen from a table
 * on the server"* — a whole apparatus whose only purpose is to let the client say something true.
 * **The client discarded both**, substituting one sentence for every refusal, so the table had no
 * reader and no two failures could be told apart.
 *
 * Found by Settings → Folders, where three registration refusals must produce three sentences.
 * Nothing before it had ever needed to distinguish one failure from another — which is why a
 * control specified in P2 was still unconsumed in P7.
 */
describe('what a refusal tells the caller — §6\'s message table', () => {
  const call = async (reply: HttpReply) => {
    const net = transport({ '/api/session.start': [session()], '/api/folders.register': [reply] })
    const client = createSessionClient(net.post)
    return client.call('folders.register', {})
  }

  it('carries the server\'s code and message through', async () => {
    const result = await call({
      status: 409,
      body: { ok: false, error: { code: 'ROOT_ALREADY_REGISTERED', message: 'That folder is already added.' } },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error?.code).toBe('ROOT_ALREADY_REGISTERED')
    expect(result.error?.message).toBe('That folder is already added.')
  })

  it('tells two different refusals apart, which is the whole point', async () => {
    const taken = await call({
      status: 409, body: { ok: false, error: { code: 'ROOT_ALREADY_REGISTERED', message: 'That folder is already added.' } },
    })
    const overlapping = await call({
      status: 409, body: { ok: false, error: { code: 'ROOT_OVERLAPS', message: 'That folder contains, or sits inside, one you have already added.' } },
    })

    expect(taken.ok).toBe(false)
    expect(overlapping.ok).toBe(false)
    if (taken.ok || overlapping.ok) return
    expect(taken.error?.message).not.toBe(overlapping.error?.message)
  })

  /**
   * A malformed error object must not throw from **inside** error handling. If it did, the caller
   * would see a transport failure and report the wrong thing entirely — the app would say the
   * server could not be reached when the server had answered.
   */
  it('leaves the error absent, rather than throwing, when the envelope is malformed', async () => {
    for (const body of [
      { ok: false },
      { ok: false, error: null },
      { ok: false, error: 'nope' },
      { ok: false, error: { code: 42 } },
      { ok: false, error: { code: 'X' } },
    ]) {
      const result = await call({ status: 400, body })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error).toBeUndefined()
      // Still a usable failure, so a caller that only reads `reason` is unaffected.
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  /**
   * **A 200 carrying `ok: false` is still a refusal**, and its envelope must still be read. The
   * status and the body can disagree — §6 puts the verdict in the body — and a client keyed on the
   * status would hand the caller an error object typed as its payload.
   */
  it('reads the envelope even when the status says 200', async () => {
    const result = await call({
      status: 200, body: { ok: false, error: { code: 'ROOT_OVERLAPS', message: 'That folder contains, or sits inside, one you have already added.' } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error?.code).toBe('ROOT_OVERLAPS')
  })
})
