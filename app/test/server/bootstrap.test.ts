import { createServer, request as httpRequest, type Server } from 'node:http'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { connect as netConnect, type AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bootstrap } from '../../src/server/bootstrap'

/**
 * **The composition root, and the test that makes build-plan §3's first acceptance condition LIVE.**
 *
 * The P3 review recorded it as proven at module level only: `resolveAsset` was called by nothing, so
 * "no client route resolves a URL to a disk path" had no client route to be true of. These requests
 * go over a real socket, through a real bootstrap, at a real port — and the traversal targets are
 * files that genuinely exist on disk beside the served directory.
 *
 * It also makes R2 reachable: until a bootstrap passed the log's path to the registrar, the rule
 * that a root may not contain the app's own state was code nothing could invoke.
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
    throw new Error('Cannot bind a loopback socket in CI. The acceptance-condition test must run here.')
  }
  console.warn(
    '[bootstrap] SKIPPED: this environment refuses to bind a socket (EPERM inside the Claude Code ' +
    'sandbox). Run in a normal terminal, or in CI, to exercise the live acceptance condition.',
  )
}

let sandbox: string

/**
 * Reserves an ephemeral port and releases it, so the host allowlist can be built BEFORE the server
 * binds.
 *
 * This mirrors production rather than working around it: spec §7 requires the allowlist be "derived
 * at startup from the actual bind config", so the port is known before the listener exists. A test
 * that bound first and widened the allowlist afterwards would be exercising a shape the real app
 * never has — and mutable security config is exactly the shape worth not normalising.
 */
async function reservePort(): Promise<number> {
  const probe = createServer()
  const port = await new Promise<number>(resolve => {
    probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port))
  })
  await new Promise<void>(resolve => { probe.close(() => resolve()) })
  return port
}

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-boot-'))
})

afterEach(async () => {
  const tempBase = process.env['TMPDIR'] ?? tmpdir()
  const ours =
    typeof sandbox === 'string' &&
    sandbox.length > tempBase.length &&
    sandbox.startsWith(tempBase) &&
    basename(sandbox).startsWith('soil-viewer-boot-')
  if (!ours) throw new Error(`refusing to recursively delete: ${String(sandbox)}`)
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const SHELL = '<!doctype html><meta name="soil-build" content="2026-08-07T00:00:00.000Z" /><div id=app></div>'

async function boot(overrides: { funnelOn?: boolean; funnelBroken?: boolean; port?: number } = {}) {
  const stateDir = join(sandbox, 'state')
  const distDir = join(sandbox, 'dist')
  await fsp.mkdir(stateDir, { recursive: true })
  await fsp.mkdir(join(distDir, 'assets'), { recursive: true })
  await fsp.writeFile(join(distDir, 'index.html'), SHELL)
  await fsp.writeFile(join(distDir, 'assets', 'app-A1B2C3D4.js'), 'export const x = 1')

  // A real file on disk, OUTSIDE dist, beside it. Every traversal below aims at this. If anything
  // in the resolution path touched the filesystem, this is what it would find.
  await fsp.writeFile(join(sandbox, 'secret.txt'), 'PRIVATE-CONTENTS')

  const result = await bootstrap({
      // The suite's own sandbox — never `$HOME`. The security review's C2/C3: the scope bounds both the
      // folder picker and registration, so a test that left it defaulted would point the real
      // home directory at a temp-tree fixture.
      browseScope: { home: sandbox, volumes: sandbox },
    stateDir,
    distDir,
    allowedHosts: overrides.port === undefined ? [] : [`127.0.0.1:${overrides.port}`],
    allowedOrigins: overrides.port === undefined ? [] : [`http://127.0.0.1:${overrides.port}`],
    funnelProbe: async () => {
      if (overrides.funnelBroken === true) throw new Error('LocalAPI moved')
      return overrides.funnelOn === true
    },
  })
  if (!result.ok) throw new Error(`bootstrap failed: ${result.code} ${result.detail ?? ''}`)
  return { ...result.value, stateDir, distDir }
}

const listen = (server: Server, port: number): Promise<void> =>
  new Promise(resolve => { server.listen(port, '127.0.0.1', () => resolve()) })

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } },
      res => {
        let body = ''
        res.on('data', c => { body += String(c) })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe.skipIf(!CAN_BIND)('THE ACCEPTANCE CONDITION, live on a real socket', () => {
  it('serves the shell and a hashed asset', async () => {
    const port = await reservePort()
    const app = await boot({ port })
    await listen(app.tailnet, port)
    try {
      const shell = await get(port, '/')
      expect(shell.status, 'the shell must serve').toBe(200)
      expect(shell.body).toContain('<div id=app>')

      const asset = await get(port, '/assets/app-A1B2C3D4.js')
      expect(asset.status).toBe(200)
      expect(asset.headers['cache-control']).toContain('immutable')
    } finally { await app.shutdown() }
  })

  it('NO REQUEST REACHES A FILE ON DISK — the condition, over a socket', async () => {
    const port = await reservePort()
    const app = await boot({ port })
    await listen(app.tailnet, port)
    try {
      const attacks = [
        '/../secret.txt',
        '/../../secret.txt',
        '/assets/../../secret.txt',
        '/%2e%2e/secret.txt',
        '/%2e%2e%2fsecret.txt',
        '/..%2fsecret.txt',
        '/%252e%252e%252fsecret.txt',
        '/....//secret.txt',
        '/assets/app-A1B2C3D4.js/../../secret.txt',
        '/index.html/../secret.txt',
      ]
      for (const attack of attacks) {
        const reply = await get(port, attack)
        expect(reply.body, `${attack} must not return the file`).not.toContain('PRIVATE-CONTENTS')
      }
    } finally { await app.shutdown() }
  })

  it('serves the shell for a deep app route, and 404s something asking for a file', async () => {
    const port = await reservePort()
    const app = await boot({ port })
    await listen(app.tailnet, port)
    try {
      expect((await get(port, '/files')).status).toBe(200)
      expect((await get(port, '/missing.js')).status).toBe(404)
    } finally { await app.shutdown() }
  })

  it('carries the CSP on an asset response', async () => {
    const port = await reservePort()
    const app = await boot({ port })
    await listen(app.tailnet, port)
    try {
      const reply = await get(port, '/')
      expect(reply.headers['content-security-policy']).toContain("default-src 'none'")
      expect(reply.headers['x-content-type-options']).toBe('nosniff')
    } finally { await app.shutdown() }
  })

  it('refuses an unrecognised Host even for a static asset', async () => {
    const port = await reservePort()
    const app = await boot({ port })
    await listen(app.tailnet, port)
    try {
      const reply = await get(port, '/', { host: 'evil.example' })
      expect(reply.status).toBe(400)
      expect(reply.body).not.toContain('<div id=app>')
    } finally { await app.shutdown() }
  })

  it('the LOCAL listener serves no client at all', async () => {
    // The client is reached through the tailnet listener, which is the sole serve target. The local
    // listener carries the privileged verbs and nothing else.
    const port = await reservePort()
    const app = await boot({ port })
    await listen(app.local, port)
    try {
      expect((await get(port, '/')).status).not.toBe(200)
    } finally { await app.shutdown() }
  })

  it('refuses every tailnet request when Funnel cannot be determined', async () => {
    // Fail-closed, end to end. `unknown` refuses exactly as `on` does.
    const port = await reservePort()
    const app = await boot({ funnelBroken: true, port })
    await listen(app.tailnet, port)
    try {
      expect((await get(port, '/')).status).toBe(503)
    } finally { await app.shutdown() }
  })
})

describe('the bootstrap refuses to start on a broken install', () => {
  it('fails when the client was never built', async () => {
    const stateDir = join(sandbox, 'state')
    await fsp.mkdir(stateDir, { recursive: true })
    const result = await bootstrap({
      // The suite's own sandbox — never `$HOME`. The security review's C2/C3: the scope bounds both the
      // folder picker and registration, so a test that left it defaulted would point the real
      // home directory at a temp-tree fixture.
      browseScope: { home: sandbox, volumes: sandbox },
      stateDir,
      distDir: join(sandbox, 'never-built'),
      allowedHosts: [], allowedOrigins: [],
      funnelProbe: async () => false,
    })
    expect(result.ok, 'a server with no client is a blank page, not a degraded server').toBe(false)
  })

  it('fails when the state directory cannot be written', async () => {
    const stateDir = join(sandbox, 'locked')
    await fsp.mkdir(stateDir, { recursive: true })
    await fsp.chmod(stateDir, 0o500)
    try {
      const result = await bootstrap({
      // The suite's own sandbox — never `$HOME`. The security review's C2/C3: the scope bounds both the
      // folder picker and registration, so a test that left it defaulted would point the real
      // home directory at a temp-tree fixture.
      browseScope: { home: sandbox, volumes: sandbox },
        stateDir, distDir: join(sandbox, 'dist'),
        allowedHosts: [], allowedOrigins: [],
        funnelProbe: async () => false,
      })
      expect(result.ok).toBe(false)
    } finally { await fsp.chmod(stateDir, 0o700) }
  })

  it('mints well-formed tokens that nothing else could have supplied', async () => {
    const app = await boot()
    try {
      for (const token of [app.tailnetToken, app.localToken]) {
        expect(token).toMatch(/^[0-9a-f]{32}$/)
        expect(token, 'never empty — an empty expected token once authenticated everyone').not.toBe('')
      }
    } finally { await app.shutdown() }
  })

  it('mints a DIFFERENT token per listener — security review B2', async () => {
    /**
     * One `guards` object was passed to both listeners, so one token authenticated on both —
     * including the local listener, which carries `folders.register`: spec §11's *"most powerful
     * thing the app does — it's what decides how much of your disk is in play."*
     *
     * Not exploitable while nothing handed the token out. The session route changes that: both
     * listeners bind loopback, so a local process could bootstrap on the tailnet listener and
     * present the result to the privileged one. The credential carried no privilege distinction at
     * all.
     */
    const app = await boot()
    try {
      expect(
        app.tailnetToken,
        'the tailnet and local tokens must not be the same value — a credential obtained from the ' +
        'listener a phone can reach must not authenticate on the listener that registers folders',
      ).not.toBe(app.localToken)
    } finally { await app.shutdown() }
  })

  it('reads the build stamp, so freshness is machine-checkable', async () => {
    const app = await boot()
    try {
      expect(app.buildStamp).toBe('2026-08-07T00:00:00.000Z')
    } finally { await app.shutdown() }
  })

  it('never writes the token into either log', async () => {
    // Spec §7 property 4 and §20's acceptance test, asserted against the real files the bootstrap
    // opened rather than a fake sink.
    const app = await boot()
    try {
      for (const name of ['mutations.log', 'local.log']) {
        const contents = await fsp.readFile(join(app.stateDir, name), 'utf8').catch(() => '')
        for (const token of [app.tailnetToken, app.localToken]) {
          expect(contents, `${name} must not contain a token`).not.toContain(token)
        }
      }
    } finally { await app.shutdown() }
  })

  it('persists both tokens to a 0600 file in the state directory', async () => {
    // Spec §7 property 3 — and the reason property 4 needed this file: the banner used to print the
    // tokens, and the spec's own LaunchAgent recipe captures the banner to a file. 2026-09-02.
    const app = await boot()
    try {
      expect(app.tokenPath.startsWith(app.stateDir), 'in the state directory').toBe(true)
      const stat = await fsp.stat(app.tokenPath)
      expect(stat.mode & 0o777, 'owner read/write only, from creation').toBe(0o600)
      const contents = await fsp.readFile(app.tokenPath, 'utf8')
      expect(contents).toBe(`tailnet ${app.tailnetToken}\nlocal   ${app.localToken}\n`)
    } finally { await app.shutdown() }
  })

  it('rewrites the token file on every start — the tokens are per-process', async () => {
    const first = await boot()
    const firstToken = first.tailnetToken
    await first.shutdown()

    const second = await boot()
    try {
      expect(second.tailnetToken).not.toBe(firstToken)
      const contents = await fsp.readFile(second.tokenPath, 'utf8')
      expect(contents).toContain(second.tailnetToken)
      expect(contents, 'the previous process token is gone').not.toContain(firstToken)
      expect((await fsp.stat(second.tokenPath)).mode & 0o777, 'still 0600 after the rewrite').toBe(0o600)
    } finally { await second.shutdown() }
  })
})

/**
 * Sends a request Node's own client cannot construct.
 *
 * `httpRequest` collapses a repeated `Host` into one value, so a duplicate-header test written with
 * it sends a single header and passes for the wrong reason — the same class of measurement error as
 * `fetch` silently dropping a `Host` override, which once made a working allowlist look broken.
 */
function rawRequest(port: number, lines: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    let data = ''
    socket.on('data', chunk => { data += String(chunk) })
    socket.on('error', reject)
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''))
  })
}

describe.skipIf(!CAN_BIND)('duplicate singleton headers are refused on EVERY path — security review C7', () => {
  /**
   * The check lived only inside `checkRequest`, and the asset route returns before `checkRequest` is
   * reached — so the shell and every asset were served with no duplicate-header check at all.
   *
   * It was not caught by reasoning. It was caught by sending two `Host` headers at a running server
   * and being answered `200 OK`, while the identical request to `/api/…` was refused `400`.
   *
   * Node keeps the FIRST `Host` and discards the rest. A proxy that keeps the last then disagrees
   * with us about who the request was addressed to, which is the foundation of request smuggling —
   * and it is why `Content-Length` is on the same singleton list.
   */
  it('refuses two Host headers on the ASSET path, where the guard chain used to end early', async () => {
    const port = await reservePort()
    const app = await boot({ port })
    await listen(app.tailnet, port)
    try {
      const control = await rawRequest(port, [
        'GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: close',
      ])
      expect(control, 'the shell must still serve normally').toContain('200')

      // The allowlisted host first, so `checkHost` cannot be what refuses this. If the duplicate
      // check regresses, Node hands the guard the ALLOWED value and the request is served.
      const smuggled = await rawRequest(port, [
        'GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Host: evil.example', 'Connection: close',
      ])
      expect(smuggled, 'two Host headers must be refused on the asset path').toContain('400')

      const duplicateContentLength = await rawRequest(port, [
        'GET /assets/app-A1B2C3D4.js HTTP/1.1', `Host: 127.0.0.1:${port}`,
        'Content-Length: 0', 'Content-Length: 0', 'Connection: close',
      ])
      expect(duplicateContentLength, 'duplicate Content-Length must be refused').toContain('400')
    } finally { await app.shutdown() }
  })

  it('still refuses them on the API path', async () => {
    // The path that always had the check. Kept so a future "simplification" that removes the guard
    // from `checkRequest` because the listener now runs it cannot pass unnoticed.
    const port = await reservePort()
    const app = await boot({ port })
    await listen(app.tailnet, port)
    try {
      const smuggled = await rawRequest(port, [
        'POST /api/listRoots HTTP/1.1', `Host: 127.0.0.1:${port}`, `Host: 127.0.0.1:${port}`,
        'Content-Type: application/json', 'Content-Length: 2', 'Connection: close',
      ])
      expect(smuggled).toContain('400')
    } finally { await app.shutdown() }
  })
})

describe('R2 is now reachable — the registrar knows where the logs live', () => {
  it('is wired with both log paths reserved', async () => {
    // Until a bootstrap existed, this rule was code nothing could invoke: `createRootRegistry`
    // required `reservedPaths` and no caller passed the real ones. The registry is internal, so the
    // assertion is that the log files are where the registrar was told they are.
    const app = await boot()
    try {
      await fsp.access(join(app.stateDir, 'mutations.log'))
      await fsp.access(join(app.stateDir, 'local.log'))
    } finally { await app.shutdown() }
  })
})
