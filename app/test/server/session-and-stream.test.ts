import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect, type AddressInfo } from 'node:net'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bootstrap } from '../../src/server/bootstrap'
import { TOKEN_HEADER } from '../../src/server/guards'
import { TICKET_IDLE_MS } from '../../src/server/session'

/**
 * The session route and the live-update stream, end to end through a real bootstrap on a real
 * socket — the security review's B1–B5 and C1/C4/C5/C8.
 *
 * These two land together because they are one mechanism: the session route exists so the client can
 * obtain a credential at all, and the stream exists to consume the half of it that `EventSource` can
 * carry. Testing either alone would leave the join untested, and this build's failures live in joins.
 */

async function canBindLoopback(): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    const done = (result: boolean): void => { probe.close(); resolve(result) }
    probe.once('error', () => done(false))
    try { probe.listen(0, '127.0.0.1', () => done(true)) } catch { resolve(false) }
  })
}

const CAN_BIND = await canBindLoopback()

if (!CAN_BIND) {
  if (process.env['CI'] !== undefined) {
    throw new Error('Cannot bind a loopback socket in CI. These tests must run here.')
  }
  console.warn('[session] SKIPPED: this environment refuses to bind a socket (sandbox EPERM).')
}

let sandbox: string

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-sess-'))
})

afterEach(async () => {
  const tempBase = process.env['TMPDIR'] ?? tmpdir()
  const ours = typeof sandbox === 'string' && sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-sess-')
  if (!ours) throw new Error(`refusing to recursively delete: ${String(sandbox)}`)
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const SHELL = '<!doctype html><meta name="soil-build" content="2026-08-07T00:00:00.000Z" /><div id=app></div>'

async function reservePort(): Promise<number> {
  const probe = createServer()
  const port = await new Promise<number>(resolve => {
    probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port))
  })
  await new Promise<void>(resolve => { probe.close(() => resolve()) })
  return port
}

async function boot(options: { funnelOn?: boolean; funnelBroken?: boolean; now?: () => number } = {}) {
  const tailnetPort = await reservePort()
  const localPort = await reservePort()
  const stateDir = join(sandbox, 'state')
  const distDir = join(sandbox, 'dist')
  await fsp.mkdir(stateDir, { recursive: true })
  await fsp.mkdir(distDir, { recursive: true })
  await fsp.writeFile(join(distDir, 'index.html'), SHELL)

  const result = await bootstrap({
      // The suite's own sandbox — never `$HOME`. The security review's C2/C3: the scope bounds both the
      // folder picker and registration, so a test that left it defaulted would point the real
      // home directory at a temp-tree fixture.
      browseScope: { home: sandbox, volumes: sandbox },
    stateDir,
    distDir,
    allowedHosts: [`127.0.0.1:${tailnetPort}`, `127.0.0.1:${localPort}`],
    allowedOrigins: [`http://127.0.0.1:${tailnetPort}`, `http://127.0.0.1:${localPort}`],
    ...(options.now === undefined ? {} : { now: options.now }),
    funnelProbe: async () => {
      if (options.funnelBroken === true) throw new Error('LocalAPI moved')
      return options.funnelOn === true
    },
  })
  if (!result.ok) throw new Error(`bootstrap failed: ${result.code}`)

  await new Promise<void>(r => { result.value.tailnet.listen(tailnetPort, '127.0.0.1', () => r()) })
  await new Promise<void>(r => { result.value.local.listen(localPort, '127.0.0.1', () => r()) })
  return { ...result.value, tailnetPort, localPort, stateDir }
}

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function post(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = '{}'
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`,
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      let body = ''
      res.on('data', c => { body += String(c) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/**
 * Opens the stream over a raw socket and returns the status line plus whatever arrived.
 *
 * Raw rather than `httpRequest`, because an SSE response never ends — a client that waits for `end`
 * waits forever. This reads for a moment and then hangs up, which is also what lets it assert that
 * the connection was *held open* rather than closed.
 */
function openStream(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise(resolve => {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ]
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    let data = ''
    socket.on('data', chunk => { data += String(chunk) })
    socket.on('error', () => resolve(data))
    setTimeout(() => { socket.destroy(); resolve(data) }, 250)
  })
}

async function startSession(app: { tailnetPort: number }): Promise<{ token: string; streamTicket: string }> {
  const reply = await post(app.tailnetPort, '/api/session.start', { 'sec-fetch-site': 'same-origin' })
  expect(reply.status, `session.start failed: ${reply.body}`).toBe(200)
  return (JSON.parse(reply.body) as { data: { token: string; streamTicket: string } }).data
}

describe.skipIf(!CAN_BIND)('the session route — security review B1 to B5', () => {
  it('hands out both credentials WITHOUT a token, because it is the route that issues one', async () => {
    const app = await boot()
    try {
      const session = await startSession(app)
      expect(session.token).toMatch(/^[0-9a-f]{32}$/)
      expect(session.streamTicket).toMatch(/^[0-9a-f]{32}$/)

      // C4(a): distinct values. The token's whole CSRF property is that it travels only in a custom
      // header; if the same value also rode a query string that property would be void.
      expect(session.streamTicket).not.toBe(session.token)
    } finally { await app.shutdown() }
  })

  it('issues the token this listener actually accepts', async () => {
    const app = await boot()
    try {
      const session = await startSession(app)
      const reply = await post(app.tailnetPort, '/api/folders.list', {
        'sec-fetch-site': 'same-origin', [TOKEN_HEADER]: session.token,
      })
      expect(reply.status, 'a freshly issued token must work on the listener that issued it').toBe(200)
    } finally { await app.shutdown() }
  })

  it('EVERY other route still demands the token — the exemption is one route, not a mode', async () => {
    const app = await boot()
    try {
      for (const route of ['/api/folders.list', '/api/tree.children', '/api/tree.entry']) {
        const reply = await post(app.tailnetPort, route, { 'sec-fetch-site': 'same-origin' })
        expect(reply.status, `${route} must refuse without a token`).toBe(403)
      }
    } finally { await app.shutdown() }
  })

  it('an unknown route name cannot select the weaker chain — default-deny', async () => {
    // B1's core property. If an unrouted name could answer "no token needed", an attacker-chosen
    // path would pick the chain without `checkToken`.
    const app = await boot()
    try {
      for (const route of ['/api/session.start.x', '/api/nope', '/api/__proto__', '/api/constructor']) {
        const reply = await post(app.tailnetPort, route, { 'sec-fetch-site': 'same-origin' })
        expect([403, 404], `${route} must not be served`).toContain(reply.status)
      }
    } finally { await app.shutdown() }
  })

  it('is absent from the LOCAL listener — security review B3', async () => {
    // The local listener serves no client, so nothing legitimate would call it there; with
    // per-listener tokens it would be an unauthenticated dispenser of the PRIVILEGED token.
    const app = await boot()
    try {
      const reply = await post(app.localPort, '/api/session.start', { 'sec-fetch-site': 'same-origin' })
      expect(reply.status).toBe(404)
    } finally { await app.shutdown() }
  })

  it('the token it issues does NOT authenticate on the privileged listener — security review B2', async () => {
    /**
     * The finding this test exists for. One `guards` object was passed to both listeners, so one
     * token authenticated on both — including the listener carrying `folders.register`, spec §11's
     * *"most powerful thing the app does."* Both listeners bind loopback, so once the session route
     * existed a local process could bootstrap on the tailnet listener and present the result to the
     * privileged one.
     */
    const app = await boot()
    try {
      const session = await startSession(app)
      const reply = await post(app.localPort, '/api/folders.deregister', {
        'sec-fetch-site': 'same-origin', [TOKEN_HEADER]: session.token,
      })
      expect(
        reply.status,
        'a credential from the listener a phone can reach must not authenticate where folders are registered',
      ).toBe(403)
    } finally { await app.shutdown() }
  })

  it('never writes either credential into either log', async () => {
    // §7 property 4. The session route is where both values are produced, so it is where a leak
    // would begin — and the ticket rides a query string, the most log-prone place a value can sit.
    const app = await boot()
    try {
      const session = await startSession(app)
      await openStream(app.tailnetPort, `/events?ticket=${session.streamTicket}`, {
        'sec-fetch-site': 'same-origin', Connection: 'close',
      })
      for (const name of ['mutations.log', 'local.log']) {
        const contents = await fsp.readFile(join(app.stateDir, name), 'utf8').catch(() => '')
        expect(contents, `${name} must not contain the token`).not.toContain(session.token)
        expect(contents, `${name} must not contain the ticket`).not.toContain(session.streamTicket)
      }
    } finally { await app.shutdown() }
  })

  it('records the issuance under a stable route name — security review B8', async () => {
    // So `grep` over the permanent log lists every device that ever obtained a credential.
    const app = await boot()
    try {
      await startSession(app)
      const contents = await fsp.readFile(join(app.stateDir, 'mutations.log'), 'utf8')
      expect(contents).toContain('session.start')
    } finally { await app.shutdown() }
  })
})

describe.skipIf(!CAN_BIND)('the live-update stream — security review C1, C4, C5, C8', () => {
  it('opens with a valid ticket and holds the connection open', async () => {
    const app = await boot()
    try {
      const session = await startSession(app)
      const reply = await openStream(app.tailnetPort, `/events?ticket=${session.streamTicket}`, {
        'sec-fetch-site': 'same-origin',
        accept: 'text/event-stream',
      })
      expect(reply, `stream handshake did not succeed:\n${reply}`).toContain('200')
      expect(reply).toContain('text/event-stream')
      // S6: the security headers travel with the stream response, not only with the JSON ones.
      expect(reply.toLowerCase()).toContain('content-security-policy')
      expect(reply.toLowerCase()).toContain('nosniff')
    } finally { await app.shutdown() }
  })

  it('sends a comment line IMMEDIATELY, without waiting for the first heartbeat', async () => {
    /**
     * SAFARI DOES NOT OPEN A STREAM UNTIL A BODY BYTE ARRIVES. Measured against the real server:
     * with headers flushed and nothing written, **WebKit's `EventSource` sat in `readyState 0`
     * indefinitely** — firing neither `onopen` nor `onerror` — while Chromium opened on the headers
     * alone. This server writes nothing until the 15s heartbeat, so Safari showed "Connecting…" for
     * fifteen seconds after every connect.
     *
     * Worse than cosmetic: the client's backoff resets only on a **confirmed** open and `onVisible`
     * reconnects unconditionally, so a repeatedly-backgrounded phone would live in a state it
     * reports as disconnected while the server considers it connected.
     *
     * A `:`-prefixed comment is ignored by SSE, so it cannot be mistaken for an event, and it
     * doubles as the anti-buffering flush proxies need.
     */
    const app = await boot()
    try {
      const session = await startSession(app)
      const reply = await openStream(app.tailnetPort, `/events?ticket=${session.streamTicket}`, {
        'sec-fetch-site': 'same-origin',
      })
      const body = reply.split('\r\n\r\n').slice(1).join('\r\n\r\n')

      // Chunk-encoded, so the payload is wrapped in length markers — assert on content rather than
      // on the first character, which is a transfer-encoding detail and not the property under test.
      expect(body, 'the stream must write something the moment it opens').not.toBe('')
      expect(body, 'an SSE comment line, sent before any event').toContain(': open')
      expect(body, 'and it must not be an event — a comment cannot be mistaken for data')
        .not.toContain('event:')
    } finally { await app.shutdown() }
  })

  it('refuses a MISSING ticket and a WRONG ticket identically', async () => {
    const app = await boot()
    try {
      await startSession(app)
      const missing = await openStream(app.tailnetPort, '/events', { 'sec-fetch-site': 'same-origin' })
      const wrong = await openStream(app.tailnetPort, `/events?ticket=${'a'.repeat(32)}`, {
        'sec-fetch-site': 'same-origin',
      })
      expect(missing).toContain('403')
      expect(wrong).toContain('403')
    } finally { await app.shutdown() }
  })

  it('refuses a malformed ticket without throwing', async () => {
    // The ticket is parsed by hand rather than with `new URL()`, because a throw carrying the
    // request target is how a credential reaches `recordException`'s verbatim message and stack.
    const app = await boot()
    try {
      await startSession(app)
      for (const raw of ['', 'x', '%', '%zz', 'a'.repeat(4096), '../../etc/passwd']) {
        const reply = await openStream(app.tailnetPort, `/events?ticket=${raw}`, {
          'sec-fetch-site': 'same-origin',
        })
        expect(reply, `ticket=${raw.slice(0, 12)} must be refused cleanly`).not.toContain('500')
      }
    } finally { await app.shutdown() }
  })

  it('refuses a REPEATED ticket parameter rather than picking one', async () => {
    // Same reasoning as duplicate Host headers: a value that appears twice is not resolved to one of
    // its appearances, because two parsers would resolve it differently.
    const app = await boot()
    try {
      const session = await startSession(app)
      const reply = await openStream(
        app.tailnetPort,
        `/events?ticket=${session.streamTicket}&ticket=${'b'.repeat(32)}`,
        { 'sec-fetch-site': 'same-origin' },
      )
      expect(reply).toContain('403')
    } finally { await app.shutdown() }
  })

  it('refuses an ABSENT Sec-Fetch-Site — security review C1, no fallback', async () => {
    /**
     * The tempting branch is `if (site === undefined) allow`, and it converts "old Safari" into
     * "any client that omits a header" — a pass by omission, strictly easier than the forgery that
     * was already impossible. The operator's iPhone runs Safari 26.5.2; the header shipped in 16.4.
     */
    const app = await boot()
    try {
      const session = await startSession(app)
      const reply = await openStream(app.tailnetPort, `/events?ticket=${session.streamTicket}`, {})
      expect(reply).toContain('403')
    } finally { await app.shutdown() }
  })

  it('refuses Sec-Fetch-Site: SAME-SITE — the measured cross-origin attacker', async () => {
    /**
     * THE TRAP. The cross-origin `EventSource` came back `same-site`, not `cross-site`, because a
     * different port on the same host is the same *site*. In production that covers every other
     * machine on the user's tailnet. A check written as "refuse cross-site" would pass all of them.
     */
    const app = await boot()
    try {
      const session = await startSession(app)
      /**
       * `'same-origin '` with a trailing space is deliberately NOT in this list, and the reason is
       * worth recording rather than discovering twice: HTTP strips leading and trailing whitespace
       * from a field value, so it is not a distinct input at all — it arrives as `same-origin` and
       * is correctly allowed. Asserting it must be refused would be asserting against the HTTP
       * parser, and the test would have been "fixed" by loosening the guard.
       */
      for (const site of ['same-site', 'cross-site', 'none', 'SAME-ORIGIN', 'sameorigin', '']) {
        const reply = await openStream(app.tailnetPort, `/events?ticket=${session.streamTicket}`, {
          'sec-fetch-site': site,
        })
        expect(reply, `Sec-Fetch-Site: ${site} must be refused`).toContain('403')
      }
    } finally { await app.shutdown() }
  })

  it('is refused when the Funnel status is unknown — security review C8', async () => {
    /**
     * The stream branch sits above the asset route but BELOW the Funnel gate, and this is what says
     * so. The asset route once sat above the Funnel gate, which meant that with Funnel status
     * `unknown` the app's shell was served to the public internet. A stream branch placed beside it
     * would have inherited exactly that.
     */
    const app = await boot({ funnelBroken: true })
    try {
      const reply = await openStream(app.tailnetPort, `/events?ticket=${'c'.repeat(32)}`, {
        'sec-fetch-site': 'same-origin',
      })
      expect(reply).not.toContain('200')
    } finally { await app.shutdown() }
  })

  it('does not serve the shell for /events — the route is not coupled to the asset map', async () => {
    // `/events` is kept out of the asset map by a constant. If that constant were edited,
    // `resolveAsset` would find no key, see no dot, and serve the SHELL with 200 — and an
    // EventSource handed 200 text/html fails in a way that looks like a client bug.
    const app = await boot()
    try {
      const reply = await openStream(app.tailnetPort, '/events', { 'sec-fetch-site': 'same-origin' })
      expect(reply).not.toContain('<div id=app>')
      expect(reply).not.toContain('text/html')
    } finally { await app.shutdown() }
  })
})

describe.skipIf(!CAN_BIND)('the ticket pool must be reclaimable — security review K6', () => {
  /**
   * **A LIVE BRICK, and it is a correct implementation of B5.**
   *
   * B5 required the session route not be an unbounded allocator: a named bound, and exhaustion that
   * REFUSES rather than evicts. All three are implemented exactly. What B5 did not require is that
   * the bound be *reclaimable* — and `release` is exported and called by nothing, so
   * `MAX_LIVE_TICKETS` is a one-way counter for the life of the process.
   *
   * Every page load spends one. After the last, `start()` refuses, the handler throws, the router
   * answers 500, and the client's recovery is 403-only by design — so it never recovers. The app is
   * dead until the process restarts, and it gets worse the more the app is used.
   *
   * This is item 14's shape inside a condition written to prevent it: the wording met, the property
   * not delivered.
   */
  /**
   * **REPOINTED, not deleted.** This used to fill the pool over real HTTP and assert the recovery.
   * That was the right test when the pool was 64; it is impractical at 1024 — a paced loop of a
   * thousand requests takes a minute — and the property is now covered deterministically, with an
   * injected clock and a mutation-verified discriminator, in `test/server/session.test.ts`.
   *
   * What only a real socket can prove is the **wiring**: that opening and closing a stream over HTTP
   * actually reaches `hold` and `release`. That wiring is what the whole reclaim rests on, and an
   * adversarial review pointed out it had **no test anywhere** — the once-guard added for item 26
   * was proof-clause-free in exactly the way item 25's lesson forbids.
   */
  it('a stream opened and closed over HTTP releases its ticket — the hold/release wiring', async () => {
    const clock = 1_000_000
    const app = await boot({ now: () => clock })
    try {
      const session = await startSession(app)

      // Open and let it close. `openStream` hangs up after its read window, which fires the
      // listener's `close` — and, on a destroyed socket, plausibly `error` as well. If the
      // once-guard were absent, both firing would decrement twice.
      const opened = await openStream(app.tailnetPort, `/events?ticket=${session.streamTicket}`, {
        'sec-fetch-site': 'same-origin',
      })
      expect(opened, 'the stream must open before this proves anything').toContain('200')

      // Let the close propagate to the server before asking about the ticket.
      await new Promise(resolve => setTimeout(resolve, 150))

      // A finished ticket is reclaimable immediately, so the next session forces a sweep that
      // collects it. Re-presenting it must now be refused.
      await post(app.tailnetPort, '/api/session.start', { 'sec-fetch-site': 'same-origin' })

      const reused = await openStream(app.tailnetPort, `/events?ticket=${session.streamTicket}`, {
        'sec-fetch-site': 'same-origin',
      })
      expect(
        reused,
        'a ticket whose stream has ended must not still open a new one — if this passes, `release` ' +
        'is not reaching the store and the pool grows with every reconnect',
      ).toContain('403')
    } finally { await app.shutdown() }
  })

  it('NEVER reclaims a ticket whose stream is open, however idle the clock says it is', async () => {
    /**
     * The half that makes the reclaim safe. An installed web app can legitimately hold one stream
     * for days without the ticket being re-verified — nothing re-checks a connection that is already
     * open. Expiring it underneath a live connection would be an eviction, which is exactly what B5
     * refused, arriving through the mechanism added to satisfy K6.
     */
    let clock = 1_000_000
    const app = await boot({ now: () => clock })
    try {
      const session = await startSession(app)

      // Hold the stream open across the idle window rather than letting the helper hang up.
      const held = new Promise<string>(resolve => {
        const socket = netConnect(app.tailnetPort, '127.0.0.1', () => {
          socket.write(
            `GET /events?ticket=${session.streamTicket} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${app.tailnetPort}\r\nSec-Fetch-Site: same-origin\r\n\r\n`,
          )
        })
        let data = ''
        socket.on('data', chunk => { data += String(chunk) })
        socket.on('error', () => resolve(data))
        setTimeout(() => { socket.destroy(); resolve(data) }, 900)
      })

      await new Promise(resolve => setTimeout(resolve, 200))
      clock += TICKET_IDLE_MS * 10

      // A new session forces a sweep. The held ticket must survive it.
      await post(app.tailnetPort, '/api/session.start', { 'sec-fetch-site': 'same-origin' })

      const opened = await openStream(app.tailnetPort, `/events?ticket=${session.streamTicket}`, {
        'sec-fetch-site': 'same-origin',
      })
      expect(opened, 'a ticket with an open stream must survive any sweep').toContain('200')

      await held
    } finally { await app.shutdown() }
  })
})
