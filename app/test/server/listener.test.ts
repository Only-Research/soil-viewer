import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createListener } from '../../src/server/listener'
import type { AssetMap } from '../../src/server/asset-map'
import { createRateLimiter } from '../../src/server/rate-limit'
import { createStreamRegistry } from '../../src/server/stream'
import { createFunnelWatch } from '../../src/server/funnel-watch'
import { createToken, TOKEN_HEADER } from '../../src/server/guards'
import { createSessionStore } from '../../src/server/session'
import { ROUTES } from '../../src/contract/routes'
import type { Handlers } from '../../src/contract/router'
import type { MutationLog, MutationRecord } from '../../src/server/mutation-log'
import type { LocalEntry, LocalLog } from '../../src/server/local-log'
import { ok } from '../../src/core/errors'

/**
 * THE TWO-LISTENER TEST, in the form build-plan §3 requires:
 *
 * > *"Two-listener test uses a **local reverse-proxy stand-in** and asserts the privileged route
 * > 404s on the tailnet listener **and** that `remoteAddress === '127.0.0.1'`, proving it tested
 * > the real condition."*
 *
 * The second half is the whole point. v1 gated privileged verbs on "requests from 127.0.0.1 only",
 * and `tailscale serve` terminates TLS and opens a **fresh loopback connection** to the backend —
 * so every phone request arrived from 127.0.0.1 and passed the gate, while the only requests
 * refused were on a listener nobody used. A test that only asserted the 404 could pass against a
 * design that still had the inversion; asserting the source address was loopback proves the
 * request really did look local and was refused anyway.
 *
 * The proxy below is that stand-in: same machine, plain loopback forwarding, no Tailscale.
 */

/**
 * Can this environment bind a loopback socket at all?
 *
 * The Claude Code sandbox refuses with EPERM — the same class of denial that blocked `fs.watch` in
 * P1. So these tests skip there and run for real everywhere else.
 *
 * The skip is deliberately NOT silent, and it is NOT a branch that asserts something weaker when
 * binding is unavailable. P1's fresh-eyes review raised exactly that (finding S9): a test whose two
 * branches assert different things reports green either way and proves nothing. Here the tests
 * either run in full or are visibly skipped — and in CI, where binding must work, an inability to
 * bind is a hard failure rather than a skip, because that is the environment whose green result
 * anyone actually trusts.
 */
async function canBindLoopback(): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    const done = (result: boolean): void => { probe.close(); resolve(result) }
    probe.once('error', () => done(false))
    try {
      probe.listen(0, '127.0.0.1', () => done(true))
    } catch {
      resolve(false)
    }
  })
}

const CAN_BIND = await canBindLoopback()

if (!CAN_BIND) {
  if (process.env['CI'] !== undefined) {
    throw new Error(
      'Cannot bind a loopback socket in CI. The two-listener test is the one that proves the v1 ' +
      'privilege inversion is gone; it must not be skipped here.',
    )
  }
  console.warn(
    '[listener] SKIPPED the two-listener tests: this environment refuses to bind a socket ' +
    '(EPERM inside the Claude Code sandbox). Run in a normal terminal, or in CI, to exercise them.',
  )
}

const TOKEN = createToken()
const allowedHosts = new Set<string>()
const allowedOrigins = new Set<string>()
const records: MutationRecord[] = []

const capturingLog: MutationLog = {
  record: async record => { records.push(record); return ok(undefined) },
}

const localEntries: LocalEntry[] = []
const capturingLocal: LocalLog = {
  write: async entry => { localEntries.push(entry); return ok(undefined) },
  recordException: async (at, thrown) => {
    localEntries.push({
      timestamp: 'x', level: 'error', at,
      detail: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
    })
    return ok(undefined)
  },
}

/**
 * A watch that has confirmed Funnel is OFF. Required by the type on every tailnet listener now —
 * the security review's P2 condition 1 made it impossible to construct one without a watch, and these three call
 * sites are how that was proven: they stopped compiling.
 */
const funnelOff = createFunnelWatch({ probe: async () => false, intervalMs: 60_000, timeoutMs: 50 })

const handlers = Object.fromEntries(
  Object.keys(ROUTES).map(name => [name, () => ({ route: name })]),
) as unknown as Handlers

let tailnet: Server
let local: Server
let proxy: Server
let tailnetPort = 0
let localPort = 0
let proxyPort = 0

const listen = (server: Server): Promise<number> =>
  new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

const close = (server: Server): Promise<void> =>
  new Promise(resolve => { server.close(() => resolve()) })

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function send(port: number, opts: {
  path?: string; method?: string; body?: string; headers?: Record<string, string>
} = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ?? JSON.stringify({ rootId: 'soil', segments: [] })
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: opts.path ?? '/api/tree.children',
      method: opts.method ?? 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
        [TOKEN_HEADER]: TOKEN,
        'content-length': Buffer.byteLength(payload),
        ...opts.headers,
      },
    }, res => {
      let body = ''
      res.on('data', chunk => { body += String(chunk) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

beforeAll(async () => {
  if (!CAN_BIND) return
  const guards = { allowedHosts, allowedOrigins, token: TOKEN }
  const limiter = () => createRateLimiter({ ratePerSecond: 1000, burst: 1000, now: () => Date.now() })

  await funnelOff.check()
  tailnet = createListener({
    privilege: 'tailnet', handlers, guards, rateLimiter: limiter(), mutationLog: capturingLog, localLog: capturingLocal, sessions: createSessionStore({ token: TOKEN }),
    funnelWatch: funnelOff,
  })
  local = createListener({
    privilege: 'local', handlers, guards, rateLimiter: limiter(), mutationLog: capturingLog, localLog: capturingLocal, sessions: createSessionStore({ token: TOKEN }),
  })

  tailnetPort = await listen(tailnet)
  localPort = await listen(local)

  /**
   * The stand-in for `tailscale serve`: terminates the client connection and opens a FRESH one to
   * the backend from this machine. Exactly the shape that made v1's loopback gate void.
   *
   * **It used to rewrite `Host` to the backend, and that was wrong** — corrected 2026-08-13 while
   * closing G7. The backend behind real `tailscale serve` receives the **mount's own authority**,
   * `mac.tail1234.ts.net:8443`, not `127.0.0.1:8766`. That is the entire reason the
   * phone was refused `BAD_HOST` on its first real run, with the allowlist holding only the bare
   * name (§18.9). A stand-in that rewrote Host to the backend modelled away the one property whose
   * absence produced the defect, so the suite could not have caught it and did not. Forwarding the
   * client's Host reproduces it, because the client here sends the **front** authority, exactly as a
   * phone does.
   *
   * **Where this stand-in is deliberately weaker than serve, measured on the real mount the same
   * day.** Serve does not forward an arbitrary Host — `Host: evil.example` sent through the real
   * mount arrived at the backend as an *allowed* host and was refused `MISSING_TOKEN` rather than
   * `BAD_HOST`, so serve replaced it. This proxy forwards it, and that is on purpose: §7's Host check
   * is the app's own control and must hold on its own evidence, not on Tailscale's. If the mount is
   * ever fronted by anything else, that control is all there is.
   *
   * `X-Forwarded-*` are added because serve adds them — with an address from the range a tailnet
   * actually assigns (`100.64.0.0/10`), so the shape is right even though the address is invented.
   * They are inert: §7 decides privilege by listener and never by a header. They are set so the
   * mutation log's `forwardedFor` column is exercised by something other than a hand-written
   * fixture.
   */
  proxy = createServer((clientReq, clientRes) => {
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: tailnetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        'x-forwarded-for': '100.64.0.2',
        'x-forwarded-proto': 'https',
      },
    }, upstreamRes => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(clientRes)
    })
    upstream.on('error', () => { clientRes.writeHead(502); clientRes.end() })
    clientReq.pipe(upstream)
  })
  proxyPort = await listen(proxy)

  for (const port of [tailnetPort, localPort, proxyPort]) {
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)
  }
})

afterAll(async () => {
  if (!CAN_BIND) return
  await Promise.all([close(tailnet), close(local), close(proxy)])
})

/**
 * **BUILD PLAN §3's TWO-LISTENER TEST, AND ITS SUBJECT NO LONGER EXISTS.**
 *
 * The plan names it as a blocking gate condition: *"Two-listener test uses a local reverse-proxy
 * stand-in and asserts the privileged route 404s on the tailnet listener **and** that
 * `remoteAddress === '127.0.0.1'`, proving it tested the real condition."*
 *
 * It used `folders.register`. As of 2026-08-09 **no route is `local-only`** — the operator moved the
 * last three after being shown the split could not do what it appeared to (see `routes.ts`). So
 * there is nothing for the tailnet listener to withhold, and the assertion as written passes
 * vacuously or fails, depending on which route is named.
 *
 * **Kept, retargeted, and the gap recorded rather than papered over.** The one route still withheld
 * from a listener is `session.start`, withheld from **local** (the security review's B3) — so the direction flips
 * and everything the test proves survives: a withheld route 404s, the backend saw a loopback
 * source, and the refusal is indistinguishable from an unknown route.
 *
 * **What is genuinely lost:** the proxy half. The stand-in exists to reproduce `tailscale serve`,
 * which fronts the *tailnet* listener, and the only withheld route is on the other one. So the
 * loopback-source assertion is now made directly rather than through a proxy. `open-items.md`
 * carries this for the security review's gate — it is a build-plan condition whose subject the product removed.
 */
/**
 * **THE LOG MUST NAME THE SUBJECT, NOT ONLY THE VERB.**
 *
 * §7 specifies the record as *"timestamp, method, route, **folder id + relative path**, …"*, and §1
 * accepts tailnet device trust partly because that record exists. Both fields were hardcoded `null`
 * at both write sites until 2026-09-01, so a stolen-token trail said `file.save` a thousand times
 * and never once said on what — the compensating control was a column of nulls.
 *
 * **Nothing caught it, and the reason is the interesting part.** `mutation-log.test.ts` builds its
 * own record with the fields populated and asserts the serialiser round-trips them. That test was
 * green throughout: it proved the writer while the production caller wrote nulls straight past it.
 * A test that constructs its own input cannot see what its caller actually supplies.
 *
 * So this one goes through the **real listener**, over real HTTP, and reads what the log received.
 */
describe.skipIf(!CAN_BIND)('the mutation log records what was touched', () => {
  it('carries the folder id and the relative path from the request', async () => {
    records.length = 0

    await send(tailnetPort, {
      path: '/api/file.load',
      body: JSON.stringify({ rootId: 'soil', segments: ['02-projects', 'notes.md'] }),
    })

    const entry = records.at(-1)
    expect(entry?.route).toBe('file.load')
    expect(entry?.rootId, 'the log must say which registered folder').toBe('soil')
    expect(entry?.relativePath, 'and which path inside it').toBe('02-projects/notes.md')
  })

  it('records nulls honestly for a route that names no file', async () => {
    records.length = 0

    await send(tailnetPort, { path: '/api/folders.list', body: JSON.stringify({}) })

    const entry = records.at(-1)
    expect(entry?.route).toBe('folders.list')
    // Not a gap — a listing has no subject. Asserted so "null" stays meaningful rather than
    // becoming the value every row happens to have.
    expect(entry?.rootId).toBeNull()
    expect(entry?.relativePath).toBeNull()
  })
})

describe.skipIf(!CAN_BIND)('a withheld route, and the loopback source that proves the condition', () => {
  it('404s on the listener that withholds it, from a genuinely loopback source', async () => {
    records.length = 0
    const reply = await send(localPort, { path: '/api/session.start' })

    expect(reply.status, 'a withheld route must not be reachable').toBe(404)

    // The half that proves the test reproduced the real condition. If this were anything but
    // loopback, the 404 above would be uninformative — it might have been refused for being remote,
    // which is precisely the check v1 had and which did not work.
    const entry = records.at(-1)
    expect(entry?.route).toBe('session.start')
    expect(entry?.sourceAddress, 'the backend must have seen a loopback source, as serve produces')
      .toMatch(/^(::ffff:)?127\.0\.0\.1$/)
    expect(entry?.outcome).toBe('refused')
  })

  it('carries §10\'s Reveal on BOTH listeners, and the build plan\'s original case stays unwritable', async () => {
    /**
     * **THE MANDATED CASE, AND WHY IT STILL CANNOT BE WRITTEN — settled 2026-08-14.**
     *
     * Build plan §3 asks for *"the privileged route 404s on the tailnet listener"*. For a few hours
     * on 2026-08-14 this file asserted exactly that, against `file.reveal` built `local-only` per
     * §10. Then the route proved **unreachable by any interface** — the client calls same-origin
     * paths and the only page comes from the tailnet listener — so the operator ruled it to `both`, with
     * §18.8 keeping the phone out in the UI instead.
     *
     * **§21's gap is therefore permanent, not pending.** It was recorded as "the two-listener test
     * lost its subject when the last privileged routes moved"; the fuller truth is that a
     * `local-only` route **cannot serve a person at all** in this architecture, so the build plan's
     * original subject can never exist while the client is the only caller. The property it wanted
     * is still proven, in the mirror: `session.start` is withheld from the *local* listener, above,
     * with the loopback source asserted on the same request.
     *
     * This case is kept as the record of that, and as the guard: if `file.reveal` is ever quietly
     * moved back to `local-only`, it stops answering here and someone has to read why.
     */
    const throughProxy = await send(proxyPort, {
      path: '/api/file.reveal',
      body: JSON.stringify({ rootId: 'soil', segments: ['note.md'] }),
    })
    expect(throughProxy.status, 'Reveal is not reachable from the listener that serves the UI')
      .toBe(200)

    const direct = await send(localPort, {
      path: '/api/file.reveal',
      body: JSON.stringify({ rootId: 'soil', segments: ['note.md'] }),
    })
    expect(direct.status).toBe(200)
  })

  it('is refused identically to a route that does not exist', async () => {
    const withheld = await send(localPort, { path: '/api/session.start' })
    const nonsense = await send(localPort, { path: '/api/there.is.no.such.route' })
    expect(withheld.status).toBe(nonsense.status)
    expect(JSON.parse(withheld.body)).toEqual(JSON.parse(nonsense.body))
  })

  it('permits an ordinary route through the reverse-proxy stand-in', async () => {
    // The proxy machinery still earns its place: it proves the tailnet listener works behind a
    // `serve`-shaped front, which is how every real request arrives.
    const reply = await send(proxyPort, { path: '/api/tree.children' })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ ok: true, data: { route: 'tree.children' } })
  })
})

/**
 * **G7 — THE PROXY-FRONTED CONTROL TEST NOW ASSERTS THE SOURCE ADDRESS.**
 *
 * the security review filed it in the P7 review on 2026-08-09 and it never reached the ledger: *"the proxy-fronted
 * control test does not assert `remoteAddress`."* The block above has the assertion but no proxy; the
 * one proxy-fronted case above it has the proxy but asserts only a 200. **Neither request is both**,
 * and F6.2's clause is about a single request being both — a control that fired while the source
 * address was loopback is the only evidence that the design does not grant on address.
 *
 * **Why the subject changed, and it is not a softening.** The build plan names `folders.register`
 * 404ing on the tailnet listener. As of 2026-08-09 **no route is `local-only`** — the operator moved the
 * last three (see `routes.ts`, §21) — so the tailnet listener withholds no route from anyone and
 * that assertion cannot be written against this product at all. What the tailnet listener *does*
 * carry, and the local one does not, is the **Funnel gate**: the discriminated union in
 * `listener.ts` makes a tailnet listener unconstructible without one. So the tailnet-only control
 * behind the proxy is the Funnel refusal, and the property under test is unchanged — a §7 control
 * fired on a request the v1 gate would have waved through.
 *
 * The v1 inversion in one line: privileged verbs were gated on `remoteAddress === '127.0.0.1'`, and
 * `tailscale serve` terminates TLS and opens a **fresh loopback connection** to the backend, so every
 * request from the phone satisfied the gate. The third case below is that exact condition, held and
 * asserted: a request arrives through the proxy, the backend records a loopback source, and it is
 * granted nothing it would not have been granted from anywhere else.
 */
describe.skipIf(!CAN_BIND)('a control that fires behind the proxy, on a loopback-sourced request', () => {
  it('refuses a Funnel-marked request through the proxy, from a source the backend saw as 127.0.0.1', async () => {
    records.length = 0
    const reply = await send(proxyPort, {
      path: '/api/tree.children',
      headers: { 'tailscale-funnel-request': '?1' },
    })

    expect(reply.status, 'a Funnel-marked request must be refused (§7)').toBe(403)

    const entry = records.at(-1)
    expect(entry?.outcome).toBe('refused')
    expect(entry?.code).toBe('FUNNEL_REFUSED')

    // The half G7 was filed for. Without it the 403 above is uninformative: it could have come from
    // a gate that refused the request for looking remote — which is the control v1 had, and which
    // `serve` defeated. Asserting the source was loopback proves the refusal survived the very
    // condition that made the old one void.
    expect(entry?.sourceAddress, 'the backend must have seen a loopback source, as serve produces')
      .toMatch(/^(::ffff:)?127\.0\.0\.1$/)
  })

  it('attributes that refusal to the header rather than to the proxy', async () => {
    // Same route, same proxy, same everything but the header. If this were also refused, the case
    // above would prove only that the proxy path is broken.
    const reply = await send(proxyPort, { path: '/api/tree.children' })
    expect(reply.status).toBe(200)
  })

  it('grants a proxy-fronted request nothing extra for arriving from loopback', async () => {
    // `folders.register` is the verb v1 gated on the source address. It is reachable here, and that
    // is the design working rather than failing: privilege is decided by the listener, so the
    // tailnet listener carries this route for the phone exactly as the local one carries it for the
    // Mac. The assertion worth making is that the recorded source is loopback — i.e. this request
    // presented the v1 grant condition in full — and the outcome is identical either way.
    records.length = 0
    const throughProxy = await send(proxyPort, {
      path: '/api/folders.register',
      body: JSON.stringify({ id: 'soil', absolutePath: '/tmp/soil' }),
    })
    const proxied = records.at(-1)

    records.length = 0
    const direct = await send(tailnetPort, {
      path: '/api/folders.register',
      body: JSON.stringify({ id: 'soil', absolutePath: '/tmp/soil' }),
    })
    const straight = records.at(-1)

    expect(proxied?.sourceAddress, 'the proxy-fronted request presented the v1 grant condition')
      .toMatch(/^(::ffff:)?127\.0\.0\.1$/)
    expect(throughProxy.status).toBe(direct.status)
    expect(JSON.parse(throughProxy.body)).toEqual(JSON.parse(direct.body))
    expect(proxied?.outcome).toBe(straight?.outcome)
  })

  it('refuses a bad Host through the proxy, and still records the loopback source', async () => {
    // The second §7 control standing between the phone and the app, and the one that actually
    // refused the user's phone before `SOIL_TAILNET_SERVE_PORT` reached the allowlist (§18.9).
    //
    // Real serve replaces a bogus Host rather than forwarding it (measured 2026-08-13), so this
    // request cannot arrive in this shape through Tailscale today. It is tested anyway, and the
    // stand-in forwards Host for exactly that reason: this control's job is to hold without help.
    records.length = 0
    const reply = await send(proxyPort, {
      path: '/api/tree.children',
      headers: { host: 'evil.example' },
    })

    expect(reply.status).toBe(400)

    const entry = records.at(-1)
    expect(entry?.outcome).toBe('refused')
    expect(entry?.code).toBe('BAD_HOST')
    expect(entry?.sourceAddress).toMatch(/^(::ffff:)?127\.0\.0\.1$/)
  })
})

describe.skipIf(!CAN_BIND)('the same privileged route on the local listener', () => {
  it('succeeds — the route exists, it is the listener that decides', async () => {
    const reply = await send(localPort, {
      path: '/api/folders.register',
      body: JSON.stringify({ id: 'soil', absolutePath: '/tmp/soil' }),
    })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ ok: true, data: { route: 'folders.register' } })
  })
})

describe.skipIf(!CAN_BIND)('every response carries the security headers, including errors', () => {
  it('sets the CSP on a success', async () => {
    const reply = await send(tailnetPort)
    expect(reply.headers['content-security-policy']).toContain("default-src 'none'")
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
  })

  it('sets the CSP on a refusal too — spec §8 says every response including errors', async () => {
    const reply = await send(tailnetPort, { headers: { host: 'evil.example' } })
    expect(reply.status).toBe(400)
    expect(reply.headers['content-security-policy']).toContain("default-src 'none'")
  })

  it('sends no CORS headers on any response', async () => {
    for (const reply of [await send(tailnetPort), await send(tailnetPort, { method: 'GET' })]) {
      for (const name of Object.keys(reply.headers)) {
        expect(name.toLowerCase()).not.toContain('access-control')
      }
    }
  })
})

describe.skipIf(!CAN_BIND)('the guards are wired to the socket, not just unit-tested', () => {
  it('refuses an unlisted Host with 400', async () => {
    expect((await send(tailnetPort, { headers: { host: 'evil.example' } })).status).toBe(400)
  })

  it('refuses a missing token with 403', async () => {
    const reply = await send(tailnetPort, { headers: { [TOKEN_HEADER]: '' } })
    expect(reply.status).toBe(403)
  })

  it('refuses a form content type with 415', async () => {
    const reply = await send(tailnetPort, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(reply.status).toBe(415)
  })

  it('refuses GET with 405', async () => {
    expect((await send(tailnetPort, { method: 'GET' })).status).toBe(405)
  })

  it('refuses Origin: null with 403', async () => {
    expect((await send(tailnetPort, { headers: { origin: 'null' } })).status).toBe(403)
  })

  it('refuses a Funnel request with 403', async () => {
    const reply = await send(tailnetPort, { headers: { 'tailscale-funnel-request': 'true' } })
    expect(reply.status).toBe(403)
  })

  it('refuses an oversized body with 413', async () => {
    const huge = JSON.stringify({ rootId: 'soil', segments: ['x'.repeat(2 * 1024 * 1024)] })
    expect((await send(tailnetPort, { body: huge })).status).toBe(413)
  })

  it('leaks nothing about the failure in the response body', async () => {
    const reply = await send(tailnetPort, { headers: { host: 'evil.example' } })
    expect(reply.body).not.toContain('evil.example')
    expect(reply.body).not.toContain('allowlist')
  })
})

describe.skipIf(!CAN_BIND)('a failed log write fails the operation', () => {
  it('turns a would-be success into a 500 rather than answering unrecorded', async () => {
    // Spec §7. The log is the only evidence anything happened, so answering without recording
    // would make "no incident" an assumption rather than an observation.
    const failing: MutationLog = {
      record: async () => ({ ok: false, code: 'IO_FAILED', detail: 'disk full' }) as never,
    }
    const server = createListener({
      privilege: 'tailnet', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      rateLimiter: createRateLimiter({ ratePerSecond: 1000, burst: 1000, now: () => Date.now() }),
      mutationLog: failing, localLog: capturingLocal, sessions: createSessionStore({ token: TOKEN }), funnelWatch: funnelOff,
    })
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)
    try {
      const before = localEntries.length
      const reply = await send(port)
      expect(reply.status).toBe(500)
      expect(JSON.parse(reply.body).ok).toBe(false)
      // And the reason lands somewhere. Until 2026-09-02 this path refused with no record of why,
      // while the refusal path one function up had recorded its own log failure all along.
      const recorded = localEntries.slice(before).filter(entry => entry.at === 'mutation-log')
      expect(recorded, 'the local log says the mutation log could not be written').toHaveLength(1)
      expect(recorded[0]?.level).toBe('error')
      expect(recorded[0]?.detail).toContain('IO_FAILED')
      expect(recorded[0]?.detail).toContain('disk full')
    } finally {
      await close(server)
    }
  })
})

describe.skipIf(!CAN_BIND)('the rate limiter is wired', () => {
  it('answers 429 once the bucket is empty', async () => {
    const server = createListener({
      privilege: 'tailnet', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      rateLimiter: createRateLimiter({ ratePerSecond: 1, burst: 2, now: () => 0 }),
      mutationLog: capturingLog, localLog: capturingLocal, sessions: createSessionStore({ token: TOKEN }), funnelWatch: funnelOff,
    })
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)
    try {
      const statuses = [
        (await send(port)).status,
        (await send(port)).status,
        (await send(port)).status,
      ]
      expect(statuses.slice(0, 2)).toEqual([200, 200])
      expect(statuses[2], 'the third request exhausts a burst of two').toBe(429)
    } finally {
      await close(server)
    }
  })
})

describe.skipIf(!CAN_BIND)('the rate limiter is GLOBAL, deliberately and by name', () => {
  /**
   * **REWRITTEN, NOT DELETED — the security review's K8.** This described a live defect. It now describes a
   * decision, and the behaviour it asserts is unchanged: the two devices below still share a bucket.
   * What changed is that this is now correct rather than accidental, and the record of why is here
   * rather than in a deleted file.
   *
   * The limiter is keyed on `socket.remoteAddress`, which behind `tailscale serve` is `127.0.0.1`
   * for every device — the same fresh-loopback-connection fact that made v1's privilege gate
   * inverted. **The fix is not to re-key it.** The limiter runs ahead of the entire guard chain,
   * deliberately, so a flood is throttled before it can generate an `fsync`-per-refusal log record.
   * At that point nothing has been validated, so there is no trustworthy identity available — and
   * the tempting one is refused by spec §7 in as many words: *"Trusting `X-Forwarded-For` instead is
   * also wrong — anything reaching the loopback port forges it."*
   *
   * Keying on a caller-supplied header would be strictly worse than sharing: a local process
   * bypassing the proxy could mint a fresh bucket per request and turn the limiter off with a
   * counter, converting a throttled attacker into unbounded synchronous disk writes.
   *
   * **So it is global, it is named global, and it is sized for what it actually covers** — 120 burst
   * at 50/second, derived from six requests per cold page load × four concurrent devices × two. The
   * old 20/20 was three page loads, and it presented as the app being broken three separate times.
   *
   * The two requests below still differ in the only per-device identities that survive the proxy,
   * because that is the thing being ruled on: they are **evidence, recorded in the mutation log**,
   * and never authorization.
   */
  it('shares one bucket across devices, because there is no verified identity to key on', async () => {
    const server = createListener({
      privilege: 'tailnet', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      // Frozen clock, burst of one: the outcome cannot depend on how fast the machine is.
      rateLimiter: createRateLimiter({ ratePerSecond: 1, burst: 1, now: () => 0 }),
      mutationLog: capturingLog, localLog: capturingLocal, sessions: createSessionStore({ token: TOKEN }), funnelWatch: funnelOff,
    })
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)
    try {
      const deviceA = await send(port, {
        headers: { 'x-forwarded-for': '100.64.0.1', 'tailscale-user-login': 'hallberg@example.com' },
      })
      const deviceB = await send(port, {
        headers: { 'x-forwarded-for': '100.64.0.2', 'tailscale-user-login': 'hallberg@example.com' },
      })

      expect(deviceA.status, 'the first device spends the only token').toBe(200)
      expect(
        deviceB.status,
        'the bucket is shared, and that is the ruling rather than an oversight: at this point in ' +
        'the chain nothing has been validated, so there is no identity to key on that a local ' +
        'process could not forge. If this ever returns 200, something has re-keyed the limiter — ' +
        'and that goes to the security review before it ships, because the limiter runs ahead of the guard chain ' +
        'ONLY because it cannot be turned off by the caller.',
      ).toBe(429)
    } finally {
      await close(server)
    }
  })
})

describe.skipIf(!CAN_BIND)('the Funnel watch gates the tailnet listener', () => {
  const spinUp = async (probe: () => Promise<boolean>): Promise<{ port: number; server: Server }> => {
    const watch = createFunnelWatch({ probe, intervalMs: 60_000, timeoutMs: 50 })
    await watch.check()
    const server = createListener({
      privilege: 'tailnet', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      rateLimiter: createRateLimiter({ ratePerSecond: 1000, burst: 1000, now: () => Date.now() }),
      mutationLog: capturingLog, localLog: capturingLocal, sessions: createSessionStore({ token: TOKEN }), funnelWatch: watch,
    })
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)
    return { port, server }
  }

  it('serves when Funnel is confirmed OFF', async () => {
    const { port, server } = await spinUp(async () => false)
    try {
      expect((await send(port)).status).toBe(200)
    } finally { await close(server) }
  })

  it('refuses everything when Funnel is ON', async () => {
    const { port, server } = await spinUp(async () => true)
    try {
      const reply = await send(port)
      expect(reply.status).toBe(403)
      expect(JSON.parse(reply.body).error.code).toBe('FUNNEL_REFUSED')
    } finally { await close(server) }
  })

  it('refuses when the status is UNKNOWN — it must not fail open', async () => {
    // The case spec §7 dwells on: a Tailscale upgrade changes the endpoint, the probe starts
    // failing, and a control that failed open would silently become a no-op on that exact day.
    const { port, server } = await spinUp(async () => { throw new Error('endpoint changed') })
    try {
      const reply = await send(port)
      expect(reply.status).toBe(503)
      expect(JSON.parse(reply.body).error.code, 'a distinct code, so the operator can tell the two apart')
        .toBe('FUNNEL_STATUS_UNKNOWN')
    } finally { await close(server) }
  })

  /**
   * THE ASSET PATH — and every Funnel test above this line builds a listener with **no asset map**,
   * which is why four review rounds missed what follows.
   *
   * Spec §7 requires **two independent mechanisms**, "enforced, not asserted in prose", because
   * "one mistyped command otherwise puts the app on the public internet with zero auth". On the
   * static path there were **zero**:
   *
   * - The header gate (`checkNotFunnel`) is reached only from `checkRequest` and
   *   `checkStreamHandshake`. The asset branch returns 200 before either.
   * - The status gate is above the asset branch — but `main.ts` ships
   *   `funnelProbe: async () => false`, so in the real binary it can only ever say "confirmed off".
   *
   * Measured before the fix: `GET /` carrying `Tailscale-Funnel-Request` answered **200 OK** with
   * the shell, while the same header on `/api/*` and `/events` was correctly refused 403. The shell
   * and the entire JS bundle, on the public internet, if the operator ever ran `tailscale funnel`.
   *
   * This is the same shape the file already congratulates itself on fixing: the Funnel *status* gate
   * was hoisted above the asset route for exactly this reason, and its companion *header* gate was
   * left behind.
   */
  const shellMap = (): AssetMap => {
    const shell = {
      body: Buffer.from('<!doctype html><div id=app></div>'),
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-cache',
    }
    return {
      get: (key: string) => (key === 'index.html' ? shell : undefined),
      shell: () => shell,
      paths: () => ['index.html'],
      size: () => 1,
    }
  }

  const spinUpWithAssets = async (probe: () => Promise<boolean>): Promise<{ port: number; server: Server }> => {
    const watch = createFunnelWatch({ probe, intervalMs: 60_000, timeoutMs: 50 })
    await watch.check()
    const server = createListener({
      privilege: 'tailnet', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      rateLimiter: createRateLimiter({ ratePerSecond: 1000, burst: 1000, now: () => Date.now() }),
      mutationLog: capturingLog, localLog: capturingLocal,
      sessions: createSessionStore({ token: TOKEN }), funnelWatch: watch,
      assets: shellMap(),
    })
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)
    return { port, server }
  }

  it('REFUSES THE SHELL to a Funnel-marked request, on the header alone', async () => {
    // The status probe says "confirmed off" here — exactly what the shipped binary does — so this
    // passes only if the HEADER gate is on the asset path. That is the second mechanism §7 demands.
    const { port, server } = await spinUpWithAssets(async () => false)
    try {
      const reply = await send(port, {
        path: '/', method: 'GET', headers: { 'tailscale-funnel-request': '1' },
      })
      expect(reply.status, 'the shell must not reach the public internet').toBe(403)
      expect(JSON.parse(reply.body).error.code).toBe('FUNNEL_REFUSED')
    } finally { await close(server) }
  })

  it('refuses a bundle asset the same way — the whole static path, not just the shell', async () => {
    const { port, server } = await spinUpWithAssets(async () => false)
    try {
      const reply = await send(port, {
        path: '/assets/index-abc123.js', method: 'GET',
        headers: { 'tailscale-funnel-request': '1' },
      })
      expect(reply.status).toBe(403)
    } finally { await close(server) }
  })

  it('REFUSES a stream opened with POST or DELETE — §7 says those verbs are 405', async () => {
    /**
     * `/events` was the one route in this build with no method policy at all. `checkMethod` exists
     * and is reached only from `checkRequest`, which the stream branch returns before — so a fifth
     * review round measured `POST /events` and `DELETE /events` each answering **200
     * text/event-stream**, and each allocating a slot in the total cap, a `hold()` on the ticket and
     * a heartbeat timer.
     *
     * **THE FIRST VERSION OF THIS TEST PASSED FOR THE WRONG REASON**, and a mutation check caught it
     * within the hour: it used a listener with no stream registry and the ticket string
     * `'whatever'`, so every verb was refused by the missing registry and the invalid ticket long
     * before the method mattered. Removing the method check left it green. It now uses a **real
     * registry and a genuinely valid ticket**, so the method is the only thing left to refuse on —
     * and GET on the same ticket is asserted to succeed, which is what proves that.
     */
    const store = createSessionStore({ token: TOKEN })
    const started = store.start()
    if (!started.ok) throw new Error('session start failed')
    const ticket = started.session.streamTicket

    const watch = createFunnelWatch({ probe: async () => false, intervalMs: 60_000, timeoutMs: 50 })
    await watch.check()
    const server = createListener({
      privilege: 'tailnet', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      rateLimiter: createRateLimiter({ ratePerSecond: 1000, burst: 1000, now: () => Date.now() }),
      mutationLog: capturingLog, localLog: capturingLocal, sessions: store, funnelWatch: watch,
      assets: shellMap(),
      streams: createStreamRegistry({ allowedOrigins, onDropped: () => { /* unused */ } }),
    })
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)

    try {
      for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
        const reply = await send(port, {
          path: `/events?ticket=${ticket}`, method,
          headers: { 'sec-fetch-site': 'same-origin' },
        })
        expect(reply.status, `${method} must not open a stream`).toBe(405)
      }
    } finally { await close(server) }
  })

  it('REFUSES an absolute-form or protocol-relative target — §7, and it was serving the shell', async () => {
    /**
     * §7's Host bullet lists **four** things: *"Reject multiple `Host` headers, illegal bytes,
     * missing Host, **and absolute-form request targets**."* Three of the four were hoisted into the
     * listener's prologue; `checkRequestTarget` stayed inside `checkRequest`, which the stream and
     * asset branches both return before.
     *
     * Measured against the shipped binary:
     *
     *     GET http://evil/ HTTP/1.1   -> 200 OK, the app shell
     *     GET //evil/ HTTP/1.1        -> 200 OK, the app shell
     *
     * `asset-map`'s deep-link rule serves it: an authority with no dot looks like an in-app route.
     * The exposure is a target/Host disagreement in front of a reverse proxy — precisely what the
     * bullet exists to refuse.
     *
     * **The lesson is the hoist, not the check.** Moving a control out of a chain strands its
     * siblings unless someone re-reads the whole sentence it came from. Second time in three
     * commits.
     */
    const { port, server } = await spinUpWithAssets(async () => false)
    try {
      for (const target of ['http://evil/', '//evil/', 'http://evil/deep/link', 'https://evil/x']) {
        const reply = await send(port, { path: target, method: 'GET' })
        expect(reply.status, `${target} must not be served`).toBe(400)
      }
    } finally { await close(server) }
  })

  it('REFUSES HEAD on the stream route — it opens a real, unreclaimable stream', async () => {
    /**
     * The method check admitted HEAD on the reasoning that HEAD is safe wherever GET is. Measured:
     * `HEAD /events` opens a **real stream**, and eight tickets × four HEADs filled all 32 slots of
     * `MAX_STREAMS_TOTAL`, after which a legitimate GET was refused 429.
     *
     * Worse, the slots cannot be reclaimed. **Node discards the body of a HEAD response**, so
     * `res.write()` returns `true` forever — 500/500 true on HEAD against 500/500 false on GET. The
     * backpressure detection keys on that boolean, so on a HEAD stream it can never fire, never arm
     * the grace timer, and never close. The one mechanism that reclaims a non-draining peer is dead
     * on exactly the requests that cannot drain.
     *
     * The earlier version of this test enumerated POST/DELETE/PUT/PATCH and did not include HEAD,
     * while the source comment said "an EventSource issues GET and nothing else".
     */
    const store = createSessionStore({ token: TOKEN })
    const started = store.start()
    if (!started.ok) throw new Error('session start failed')

    const watch = createFunnelWatch({ probe: async () => false, intervalMs: 60_000, timeoutMs: 50 })
    await watch.check()
    const server = createListener({
      privilege: 'tailnet', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      rateLimiter: createRateLimiter({ ratePerSecond: 1000, burst: 1000, now: () => Date.now() }),
      mutationLog: capturingLog, localLog: capturingLocal, sessions: store, funnelWatch: watch,
      assets: shellMap(),
      streams: createStreamRegistry({ allowedOrigins, onDropped: () => { /* unused */ } }),
    })
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)

    try {
      const reply = await send(port, {
        path: `/events?ticket=${started.session.streamTicket}`, method: 'HEAD',
        headers: { 'sec-fetch-site': 'same-origin' },
      })
      expect(reply.status, 'HEAD must not hold a stream slot forever').toBe(405)
    } finally { await close(server) }
  })

  it('RECORDS EVERY PROLOGUE REFUSAL UNDER THE SAME ROUTE LABEL', async () => {
    /**
     * R4 exists so guard-layer refusals are visible in the mutation log — otherwise the compensating
     * control records only what passed every guard, and the attacks are invisible. A record under an
     * inconsistent route name is a weaker form of the same blindness: the log cannot be grouped.
     *
     * Measured against the shipped binary before this: the same `/events` request was logged as
     * `"events"` when the Funnel gate refused it and `"(unrouted)"` when the Host gate did — two
     * labels for one request depending on which guard fired first, plus two different fallbacks
     * (`(static)` and `(unrouted)`) inside one prologue.
     *
     * **And `routeLabelFor` had no proof clause at all.** Reducing it to `return '(static)'` left the
     * entire suite green; the only test touching a mutation-log `route` asserted a *successful*
     * mutation. That is the exact finding the commit which introduced the helper reported about a
     * different fix, recurring inside itself.
     */
    const { port, server } = await spinUpWithAssets(async () => false)
    const before = records.length
    try {
      // Two different guards, same route, both in the prologue.
      await send(port, {
        path: '/events?ticket=x', method: 'GET',
        headers: { 'sec-fetch-site': 'same-origin', 'tailscale-funnel-request': '1' },
      })
      await send(port, {
        path: '/events?ticket=x', method: 'GET',
        headers: { 'sec-fetch-site': 'same-origin', host: 'evil.example' },
      })

      const logged = records.slice(before)
      expect(logged.length, 'both refusals reached the log').toBe(2)
      for (const record of logged) {
        expect(record.route, 'the stream route is named, whichever guard fired').toBe('events')
      }
      // The ticket must not ride into the record on the route name.
      for (const record of logged) expect(record.route).not.toContain('ticket')
    } finally { await close(server) }
  })

  it('labels a static refusal consistently too, whichever guard fires', async () => {
    const { port, server } = await spinUpWithAssets(async () => false)
    const before = records.length
    try {
      await send(port, { path: '/', method: 'GET', headers: { 'tailscale-funnel-request': '1' } })
      await send(port, { path: '/', method: 'GET', headers: { host: 'evil.example' } })

      const logged = records.slice(before)
      expect(logged.length).toBe(2)
      for (const record of logged) {
        expect(record.route, 'one fallback, not two').toBe('(static)')
      }
    } finally { await close(server) }
  })

  it('still serves the shell normally when no Funnel header is present', async () => {
    // The other half, so the fix cannot be "refuse everything" — which would pass the two above.
    const { port, server } = await spinUpWithAssets(async () => false)
    try {
      const reply = await send(port, { path: '/', method: 'GET' })
      expect(reply.status, 'the app must still load for the operator').toBe(200)
    } finally { await close(server) }
  })

  it('CANNOT gate the local listener — the type does not admit a watch there', async () => {
    // Stronger than the runtime assertion this replaced. Under the security review's condition 1 the options are
    // a discriminated union: a `'tailnet'` listener REQUIRES a watch and a `'local'` one does not
    // ACCEPT one. So "the local listener is not gated by Tailscale" is now a fact about the type
    // rather than a behaviour to test — passing `funnelWatch` here is a compile error.
    //
    // It matters because gating loopback on a Tailscale probe would take the whole app down
    // whenever Tailscale hiccuped, to defend a path Funnel cannot reach. This test now proves the
    // local listener serves while a watch elsewhere is in the refusing state.
    const watch = createFunnelWatch({ probe: async () => { throw new Error('down') }, timeoutMs: 50 })
    await watch.check()
    expect(watch.status(), 'a watch in the refusing state exists').toBe('unknown')
    const server = createListener({
      privilege: 'local', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      rateLimiter: createRateLimiter({ ratePerSecond: 1000, burst: 1000, now: () => Date.now() }),
      mutationLog: capturingLog, localLog: capturingLocal, sessions: createSessionStore({ token: TOKEN }),
    })
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)
    try {
      expect((await send(port)).status).toBe(200)
    } finally { await close(server) }
  })
})

describe.skipIf(!CAN_BIND)('an aborted request cannot crash the process', () => {
  it('answers or closes rather than producing an unhandled rejection', async () => {
    // the security review's P2 review, condition 3. `handle` was invoked with `void` and no `.catch`, and
    // `readJsonBody` RETHROWS when the body stream errors mid-read — which is what an aborted
    // request produces. Node 24 exits the process on an unhandled rejection, so an aborted upload
    // was one plausible input away from taking the server down. `requestTimeout` exists to destroy
    // slow requests, and destroying a request is what fires this path.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)

    try {
      const payload = JSON.stringify({ rootId: 'soil', segments: [] })
      await new Promise<void>(resolve => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: tailnetPort,
          path: '/api/tree.children',
          method: 'POST',
          headers: {
            host: `127.0.0.1:${tailnetPort}`,
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${tailnetPort}`,
            'sec-fetch-site': 'same-origin',
            [TOKEN_HEADER]: TOKEN,
            // Promises far more than is sent, then the socket is destroyed mid-body.
            'content-length': Buffer.byteLength(payload) + 4096,
          },
        })
        req.on('error', () => resolve())
        req.write(payload.slice(0, 5))
        setTimeout(() => { req.destroy(); resolve() }, 30)
      })

      // Let the server observe the abort and settle whatever it was doing.
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(rejections, 'an aborted request must not produce an unhandled rejection').toEqual([])

      // And the server is still answering.
      expect((await send(tailnetPort)).status).toBe(200)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

describe.skipIf(!CAN_BIND)('the P2 review debt, paid', () => {
  it('R1: a duplicate Host is refused at the socket, where Node hides it', async () => {
    // Node DISCARDS the second Host before any handler sees it, so the guard's array branch was
    // dead code for real requests. The check now reads rawHeaders, where both copies survive.
    // Sent by hand, because the http client will not emit a duplicate Host for us.
    const reply = await new Promise<number>((resolve, reject) => {
      const socket = netConnect(tailnetPort, '127.0.0.1', () => {
        const body = '{"rootId":"soil","segments":[]}'
        socket.write(
          'POST /api/tree.children HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${tailnetPort}\r\n` +
          'Host: evil.example\r\n' +
          'Content-Type: application/json\r\n' +
          `Origin: http://127.0.0.1:${tailnetPort}\r\n` +
          'Sec-Fetch-Site: same-origin\r\n' +
          `${TOKEN_HEADER}: ${TOKEN}\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        )
      })
      let raw = ''
      socket.on('data', chunk => { raw += String(chunk) })
      socket.on('error', reject)
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('timeout')) })
      socket.on('close', () => {
        const status = Number(raw.split(' ')[1] ?? 0)
        resolve(status)
      })
      setTimeout(() => socket.end(), 200)
    })
    expect(reply, 'a duplicate Host must be refused, not silently first-wins').toBe(400)
  })

  it('R4: a guard-layer refusal now reaches the mutation log', async () => {
    // Before this the log recorded only requests that passed every guard, so the attacks it exists
    // to make visible were the one thing invisible in it.
    records.length = 0
    await send(tailnetPort, { headers: { host: 'evil.example' } })
    const entry = records.at(-1)
    expect(entry?.outcome).toBe('refused')
    expect(entry?.code).toBe('BAD_HOST')
  })

  it('R4: the refusal REASON goes to the local log and never to the wire', async () => {
    localEntries.length = 0
    const reply = await send(tailnetPort, { headers: { host: 'evil.example' } })
    expect(localEntries.some(e => e.detail === 'host not allowed'), 'reason recorded locally').toBe(true)
    expect(reply.body, 'and never sent').not.toContain('host not allowed')
  })

  it('R3: a thrown handler exception reaches the local log with its detail', async () => {
    // Previously discarded entirely by a bare `catch {}`, which made a 500 in production
    // unobservable — an incident manifesting as an exception left no trace anywhere.
    localEntries.length = 0
    const throwing = {
      ...handlers,
      'tree.children': () => { throw new Error('ENOENT: /Users/hallberg/private.md') },
    } as unknown as Handlers
    const server = createListener({
      privilege: 'tailnet', handlers: throwing, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      rateLimiter: createRateLimiter({ ratePerSecond: 1000, burst: 1000, now: () => Date.now() }),
      mutationLog: capturingLog, localLog: capturingLocal, sessions: createSessionStore({ token: TOKEN }), funnelWatch: funnelOff,
    })
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    allowedOrigins.add(`http://127.0.0.1:${port}`)
    try {
      const reply = await send(port)
      expect(reply.status).toBe(500)
      const recorded = localEntries.find(e => e.at === 'route:tree.children')
      expect(recorded?.detail, 'the local log gets everything').toContain('ENOENT')
      expect(reply.body, 'the wire gets none of it').not.toContain('ENOENT')
      expect(reply.body).not.toContain('hallberg')
    } finally { await close(server) }
  })

  it('K4: the connection cap is GLOBAL and is the number we think it is', async () => {
    /**
     * **This test replaces one that could not have caught the defect it was written for.**
     *
     * The old version opened `MAX_CONNECTIONS_PER_ADDRESS + 4` sockets and asserted
     * `destroyed > 0`. That assertion passes if the cap is 64, and it passes if the cap is 1, and it
     * passes whether the cap is per-address or global. It could not distinguish any of the things it
     * was named for — the "fires against its own fixture" shape.
     *
     * What it missed: both listeners bind `127.0.0.1`, so the per-address map held exactly one key.
     * The effective cap was **64 global**, and `MAX_CONNECTIONS = 256` was unreachable by
     * construction, because the 65th socket was destroyed before Node's own limit could apply. The
     * per-address map is now deleted and `server.maxConnections` carries the cap alone.
     *
     * So this asserts the number: comfortably past the old 64, and short of 256, connections must
     * still be **accepted**. If the per-address cap ever returns, this goes red at 65.
     */
    const sockets: ReturnType<typeof netConnect>[] = []
    const connect = (): Promise<'connected' | 'refused'> =>
      new Promise(resolve => {
        const socket = netConnect(tailnetPort, '127.0.0.1')
        sockets.push(socket)
        socket.once('connect', () => resolve('connected'))
        socket.once('error', () => resolve('refused'))
        socket.once('close', () => resolve('refused'))
      })

    try {
      const results: string[] = []
      // 200 is past the old effective cap of 64 by a wide margin, and below the global 256.
      for (let i = 0; i < 200; i++) results.push(await connect())

      // Settle, so a socket destroyed by a cap has had time to report it.
      await new Promise(resolve => setTimeout(resolve, 250))
      const alive = sockets.filter(s => !s.destroyed && !s.closed).length

      expect(
        alive,
        'the 200th concurrent connection must still be open — a cap of 64 wearing a per-address ' +
        'name is what this test exists to catch, and the old assertion could not see it',
      ).toBeGreaterThan(120)
      expect(results.filter(r => r === 'connected').length).toBeGreaterThan(120)
    } finally {
      for (const s of sockets) s.destroy()
    }
  })
})

/**
 * THE SOCKET-LEVEL LIMITS — spec §6, F8.1–F8.6. Every one of these was removable in silence.
 *
 * A whole-suite mutation review deleted each and all 969 tests stayed green: three slowloris
 * timeouts, the header size cap, the URL cap, the connection cap and the rate-limiter eviction.
 * None of the six numbers was imported by any test.
 *
 * **The values are written as LITERALS on purpose.** Importing the constants and asserting they
 * equal themselves is the tautology that let `MAX_HISTORY` go from 50 to 5000 unnoticed. These are
 * the numbers §6 specifies; if someone changes a constant, this fails and they have to come and
 * change the spec's number here too, deliberately.
 */
describe.skipIf(!CAN_BIND)('the socket limits are actually applied to the server', () => {
  const spin = (): Server => createListener({
    privilege: 'tailnet', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
    rateLimiter: createRateLimiter({ ratePerSecond: 1000, burst: 1000, now: () => Date.now() }),
    mutationLog: capturingLog, localLog: capturingLocal,
    sessions: createSessionStore({ token: TOKEN }), funnelWatch: funnelOff,
  })

  it('sets every slowloris timeout and both size caps on the Server itself', () => {
    const server = spin()
    try {
      // F8.1–F8.3: a peer that opens a socket and dribbles bytes holds a slot forever without these.
      expect(server.headersTimeout, 'F8.1 headers must arrive within 10s').toBe(10_000)
      expect(server.requestTimeout, 'F8.2 the whole request within 30s').toBe(30_000)
      expect(server.keepAliveTimeout, 'F8.3 an idle keep-alive closes after 5s').toBe(5_000)
      // HONEST LIMIT, stated so this does not read as more coverage than it is: 5,000ms and
      // 16 KB are ALSO Node's own defaults (measured on Node 24). So these two assertions catch a
      // WRONG value but cannot catch a REMOVED assignment — deleting either line leaves the
      // behaviour identical and this test green. The other four discriminate; these two are a
      // spec-conformance check rather than a regression guard, and pretending otherwise would be
      // the exact overstatement this exercise exists to remove.
      // K4: the whole connection cap, after the per-address map was removed.
      expect(server.maxConnections, 'F8.6 at most 256 sockets').toBe(256)
      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (server as any).maxHeaderSize ?? 16 * 1024,
        'F8.4 headers are capped at 16 KB',
      ).toBe(16 * 1024)
    } finally { server.close() }
  })

  it('refuses a request target over the 2 KB cap, before anything reads it', async () => {
    const server = spin()
    const port = await listen(server)
    allowedHosts.add(`127.0.0.1:${port}`)
    try {
      const reply = await send(port, { path: `/api/x?${'a'.repeat(3000)}`, method: 'POST' })
      expect(reply.status, 'an oversized URL is refused, not parsed').toBe(413)
    } finally { await close(server) }
  })

  it('sweeps idle rate-limit buckets — R6, whose whole finding was that nothing called it', () => {
    /**
     * `evictIdle` existed and was called by nothing, so the bucket map was unbounded by
     * construction — safe only by accident of loopback binding, which is the shape of v1's whole
     * inversion. The fix was one `setInterval`, and removing it again was silent.
     *
     * Fake timers rather than a 30-second wait, and the assertion is on the CALL COUNT rather than
     * on the limiter's type. The first version of this test asserted `typeof swept === 'number'`,
     * which is true whether the sweep runs or not — a test that cannot fail, written while fixing
     * tests that cannot fail.
     */
    vi.useFakeTimers()
    let swept = 0
    const server = createListener({
      privilege: 'tailnet', handlers, guards: { allowedHosts, allowedOrigins, token: TOKEN },
      rateLimiter: { take: () => true, evictIdle: () => { swept++; return 0 }, size: () => 0 },
      mutationLog: capturingLog, localLog: capturingLocal,
      sessions: createSessionStore({ token: TOKEN }), funnelWatch: funnelOff,
    })
    try {
      expect(swept, 'nothing swept before any time passes').toBe(0)
      vi.advanceTimersByTime(90_000)
      expect(swept, 'the bucket map is swept on a timer, not left to grow').toBeGreaterThan(0)
    } finally {
      server.close()
      vi.useRealTimers()
    }
  })
})
