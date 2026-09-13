/**
 * DRIVING THE REAL APP THROUGH THE MOCK TREE.
 *
 * Every other test in this build exercises a module. This one boots the actual server on an actual
 * socket, registers a fifteen-hundred-file tree, and puts it through the operations that destroyed
 * the previous version — then **hashes every file in the tree and checks that nothing moved except
 * what was asked to move.**
 *
 * That last assertion is the whole point. v1 destroyed 1,610 of 1,611 markdown files, and it did so
 * while every individual piece of it presumably looked fine. A per-module test cannot catch that
 * shape; only a census can. So the census is the headline here and the individual operations are
 * the setup for it.
 *
 * **It never touches the user's tree.** The mock tree is built into a temp directory per run and
 * removed after — see `../support/mock-soil/generate.ts` for the refusals that make aiming this at
 * the real soil impossible rather than merely discouraged.
 *
 * ## One thing this test is honest about
 *
 * It authenticates with `localToken` taken straight from `bootstrap`'s return value, because
 * nothing hands that token out yet: `session.start` is tailnet-only and the write routes are
 * local-only, on purpose, until the security review rules on what may authorize a bootstrap. So this proves the
 * engine and the wire, and it does **not** prove that a real client can reach them. That gap is
 * real, it is recorded in the phase brief, and it is not papered over here.
 */

import { createServer, request as httpRequest, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'

import { bootstrap, type Bootstrapped } from '../../src/server/bootstrap'
import { makeMockSoil, removeMockSoil } from '../support/mock-soil/generate.ts'

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
    throw new Error('Cannot bind a loopback socket in CI. The end-to-end drive must run here.')
  }
  console.warn('[drive] SKIPPED: this environment refuses to bind a socket (sandbox). Run in a normal terminal.')
}

const SHELL = '<!doctype html><meta name="soil-build" content="2026-08-08T00:00:00.000Z" /><div id=app></div>'

interface Reply { status: number; body: unknown }

let tailnetPort: number
let ticket: string
let sandbox: string
let mockRoot: string
let app: Bootstrapped
let port: number
/** The state of the whole tree before anything is driven through it. */
let before: Map<string, string> = new Map()
/**
 * Where §13.5's rescue landed, folder-relative. Filled by the conflict test, read by the census.
 *
 * It cannot be hand-written like the other census entries — the name carries a timestamp and four
 * random characters, which is precisely what stops a second conflict clobbering the first.
 */
let rescuedArtifact = ''

/** A census of the tree: every path that is not a symlink, mapped to the SHA-256 of its bytes. */
async function census(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const key = relative(root, full).split(sep).join('/')
      if (entry.isSymbolicLink()) { out.set(key, 'symlink:' + await fsp.readlink(full)); continue }
      if (entry.isDirectory()) { out.set(key, 'dir'); await walk(full); continue }
      try {
        out.set(key, createHash('sha256').update(await fsp.readFile(full)).digest('hex'))
      } catch (error) {
        out.set(key, `unreadable:${(error as NodeJS.ErrnoException).code}`)
      }
    }
  }
  await walk(root)
  return out
}

function post(path: string, body: unknown, token: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-soil-token': token,
      },
    }, res => {
      let raw = ''
      res.on('data', c => { raw += String(c) })
      res.on('end', () => {
        let parsed: unknown = raw
        try { parsed = JSON.parse(raw) } catch { /* leave as text */ }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/**
 * A raw GET against the TAILNET listener, returning the body as bytes.
 *
 * Bytes rather than a string, because the whole subject of §9 is what actually arrives — a `.png`
 * compared as UTF-8 is a comparison that passes for the wrong reasons.
 */
function get(path: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: tailnetPort, path, method: 'GET',
      headers: { host: `127.0.0.1:${tailnetPort}` },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => { chunks.push(c) })
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** The §9 endpoint's URL for one path in the mock tree. */
const fileUrl = (path: string): string =>
  `/file?ticket=${encodeURIComponent(ticket)}&root=${ROOT_ID}`
  + path.split('/').map(s => `&p=${encodeURIComponent(s)}`).join('')

/** Calls a route and fails the test with the server's own words if it did not succeed. */
async function call<T = Record<string, unknown>>(route: string, body: unknown): Promise<T> {
  const reply = await post(`/api/${route}`, body, app.localToken)
  if (reply.status !== 200) {
    throw new Error(`${route} -> ${reply.status} ${JSON.stringify(reply.body)}`)
  }
  // Every response is the `{ ok, data }` envelope — spec §6's discriminated union. `data` is
  // whatever the service returned, which for the list routes is a bare array.
  return (reply.body as { data: T }).data
}

/** Calls a route expecting a refusal, and returns it. */
async function refusal(route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const reply = await post(`/api/${route}`, body, app.localToken)
  expect(reply.status, `${route} should have been refused, got 200: ${JSON.stringify(reply.body)}`)
    .not.toBe(200)
  return reply
}

const ROOT_ID = 'mock'
const seg = (path: string): string[] => path.split('/')

/**
 * §13.8's token for a path, fetched over HTTP exactly as the client fetches it.
 *
 * This is the most realistic token read in the suite — a real request to `tree.entry` on a real
 * listener, against the real mock tree — which is the point of this file.
 */
async function tokenOf(path: string): Promise<string> {
  const entry = await call<{ token: string }>('tree.entry', { rootId: ROOT_ID, segments: seg(path) })
  return entry.token
}

describe.skipIf(!CAN_BIND)('the real server, driven through the mock tree', () => {
  beforeAll(async () => {
    sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-drive-'))
    mockRoot = join(sandbox, 'mock-soil')
    await makeMockSoil(mockRoot, {
      // The repository is elsewhere as far as this build is concerned; the guard is proven in
      // mock-soil.test.ts and re-asserting it here would only slow the run down.
      repositoryRoot: join(sandbox, 'not-a-repository'),
      home: join(sandbox, 'not-a-home'),
    })

    const stateDir = join(sandbox, 'state')
    const distDir = join(sandbox, 'dist')
    await fsp.mkdir(stateDir, { recursive: true })
    await fsp.mkdir(join(distDir, 'assets'), { recursive: true })
    await fsp.writeFile(join(distDir, 'index.html'), SHELL)
    await fsp.writeFile(join(distDir, 'assets', 'app-A1B2C3D4.js'), 'export const x = 1')

    // The allowlist is derived before the bind, as production does it. **Both** ports, because
    // Host validation runs on every request to either listener and the tailnet one now carries the
    // §9 byte endpoint.
    const pickPort = async (): Promise<number> => {
      const probe = createServer()
      const picked = await new Promise<number>(resolve => {
        probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port))
      })
      await new Promise<void>(resolve => { probe.close(() => resolve()) })
      return picked
    }
    port = await pickPort()
    tailnetPort = await pickPort()

    const booted = await bootstrap({
      // The suite's own sandbox — never `$HOME`. The security review's C2/C3: the scope bounds both the
      // folder picker and registration, so a test that left it defaulted would point the real
      // home directory at a temp-tree fixture.
      browseScope: { home: sandbox, volumes: sandbox },
      stateDir,
      distDir,
      allowedHosts: [`127.0.0.1:${port}`, `127.0.0.1:${tailnetPort}`],
      allowedOrigins: [`http://127.0.0.1:${port}`, `http://127.0.0.1:${tailnetPort}`],
      funnelProbe: async () => false,
    })
    if (!booted.ok) throw new Error(`bootstrap failed: ${booted.code} ${booted.detail ?? ''}`)
    app = booted.value

    await new Promise<void>(resolve => {
      (app.local as Server).listen(port, '127.0.0.1', () => resolve())
    })

    /**
     * The TAILNET listener too, because §9's byte endpoint lives there — it is where the client is,
     * and the local listener serves no UI. Bound on its own port so the two are never confused.
     */
    await new Promise<void>(resolve => {
      (app.tailnet as Server).listen(tailnetPort, '127.0.0.1', () => resolve())
    })

    // A real ticket, minted the way the client mints one. `session.start` is tailnet-only.
    const session = await new Promise<{ ticket: string }>((resolve, reject) => {
      const payload = '{}'
      const req = httpRequest({
        host: '127.0.0.1', port: tailnetPort, path: '/api/session.start', method: 'POST',
        headers: {
          host: `127.0.0.1:${tailnetPort}`,
          origin: `http://127.0.0.1:${tailnetPort}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      }, res => {
        let raw = ''
        res.on('data', c => { raw += String(c) })
        res.on('end', () => {
          // `streamTicket` on the wire — the query parameter it travels in is `ticket`, and the
          // two names differing is worth reading twice rather than assuming.
          const parsed = JSON.parse(raw) as { data?: { streamTicket?: string } }
          const value = parsed.data?.streamTicket
          if (value === undefined) reject(new Error(`no ticket: ${raw}`))
          else resolve({ ticket: value })
        })
      })
      req.on('error', reject)
      req.end(payload)
    })
    ticket = session.ticket

    // The mock tree is in a temp directory, so it is in no git repository and Time Machine cannot
    // be seen from Node — §11's check refuses it, correctly. This is the typed override, which is
    // what a user does after reading the warning.
    await call('folders.register', {
      id: ROOT_ID, absolutePath: mockRoot,
    })

    // The census, taken last: the tree is complete and nothing has been driven through it yet.
    // It lives here rather than in a file-level hook because Vitest runs file-level `beforeAll`
    // *before* a suite's — which would have taken this census of a directory that did not exist.
    before = await census(mockRoot)
  }, 180_000)

  afterAll(async () => {
    await app?.shutdown?.().catch(() => undefined)
    if (mockRoot) {
      await removeMockSoil(mockRoot, {
        repositoryRoot: join(sandbox, 'not-a-repository'),
        home: join(sandbox, 'not-a-home'),
      }).catch(() => undefined)
    }
    if (sandbox) await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => undefined)
  })

  // -------------------------------------------------------------------------------------------
  // Reading a real tree
  // -------------------------------------------------------------------------------------------

  it('registered a fifteen-hundred-file tree and can list it', async () => {
    const folders = await call<Array<{ id: string; name: string }>>('folders.list', {})
    expect(folders.some(f => f.id === ROOT_ID)).toBe(true)
    // §6: the wire never carries an absolute path, in either direction.
    expect(JSON.stringify(folders)).not.toContain(sandbox)
  })

  /**
   * **§11's backup gate was proven here and was CUT on 2026-08-09** — the operator: *"cut it"*. The old
   * test refused an unbacked folder, then registered it once the override was typed.
   *
   * What replaces it asserts the *absence*, against the real server through the real wire, because
   * that is the half that could silently come back. It also still catches the defect the original
   * was written for: hard-coding a waiver somewhere in the service used to pass the whole suite.
   * Now there is no waiver to hard-code, and a registration that started refusing unbacked folders
   * again would fail right here.
   */
  it('registers a folder with no git repository above it, with nothing to acknowledge', async () => {
    const other = join(sandbox, 'another-unbacked-folder')
    await fsp.mkdir(other, { recursive: true })
    await fsp.writeFile(join(other, 'note.md'), '# A note\n')

    await call('folders.register', { id: 'unbacked', absolutePath: other })
    expect((await call<Array<{ id: string }>>('folders.list', {})).some(f => f.id === 'unbacked'))
      .toBe(true)
  })

  it('indexes a cloud-sync folder without reading a single body — §5, v1s failure', async () => {
    // v1 indexed an iCloud root by reading every file, which materialised the entire tree out of
    // the cloud. §5's answer is that a provider root takes its titles from filenames and never
    // opens a body. `detectCloudProvider` matches on the path, so a folder named Dropbox is the
    // real trigger rather than a mocked flag.
    const cloud = join(sandbox, 'Dropbox', 'shared-notes')
    await fsp.mkdir(cloud, { recursive: true })
    await fsp.writeFile(join(cloud, 'quarterly-plan.md'), '# A Heading Only A Body Read Would Find\n')

    await call('folders.register', { id: 'cloud', absolutePath: cloud })

    const entries = await call<Array<{ name: string; title: string }>>('tree.children', {
      rootId: 'cloud', segments: [],
    })
    const row = entries.find(e => e.name === 'quarterly-plan.md')
    expect(row).toBeDefined()
    expect(row?.title).not.toContain('A Heading Only A Body Read Would Find')

    // And the folder is reported as cloud-backed, so the client can say so.
    const folders = await call<Array<{ id: string; cloudProvider?: string | null }>>('folders.list', {})
    expect(folders.find(f => f.id === 'cloud')?.cloudProvider).toBe('Dropbox')
  })

  it('walks into a project and finds its children', async () => {
    const entries = await call<Array<{ name: string }>>('tree.children', {
      rootId: ROOT_ID, segments: seg('02-projects/cold-store-expansion'),
    })
    const names = entries.map(e => e.name)
    expect(names).toContain('00-context')
    expect(names).toContain('02-work')
    expect(names).toContain('03-discovery')
  })

  it('does not walk the symlinked folder and index the same files twice', async () => {
    const entries = await call<Array<{ name: string; kind?: string }>>('tree.children', {
      rootId: ROOT_ID, segments: seg('zz-hazards/links'),
    })
    const link = entries.find(e => e.name === 'link-to-a-folder-inside')
    // Appearing as a row is fine. Being walked as a directory is not — that is how one tree gets
    // indexed twice, and how a cycle becomes an infinite walk.
    if (link) expect(link.kind).not.toBe('directory')
    const inside = await call<Array<{ name: string }>>('tree.children', {
      rootId: ROOT_ID, segments: seg('zz-hazards/links/link-to-a-folder-inside'),
    }).catch(() => [])
    expect(inside).toEqual([])
  })

  // -------------------------------------------------------------------------------------------
  // Load and save, on a real document
  // -------------------------------------------------------------------------------------------

  it('loads a document and hands back an identity to save with', async () => {
    const loaded = await call('file.load', {
      rootId: ROOT_ID, segments: seg('02-projects/cider-line/00-context/context.md'),
    })
    expect(String(loaded['content'])).toContain('The perennial')
    expect(String(loaded['hash'])).toMatch(/^[0-9a-f]{64}$/)
  })

  it('saves an edit, and the bytes on disk are exactly what was sent', async () => {
    const path = '99-inbox-main/bin-tag-printer-quote.md'
    const loaded = await call('file.load', { rootId: ROOT_ID, segments: seg(path) })
    const edited = `${String(loaded['content'])}\n\nApproved at the April board meeting.\n`

    await call('file.save', {
      rootId: ROOT_ID, segments: seg(path),
      content: edited, expectedHash: loaded['hash'], confirmTruncation: false,
    })

    expect(await fsp.readFile(join(mockRoot, path), 'utf8')).toBe(edited)
  })

  it('RESCUES the edit when the baseline is stale — the agent-wrote-underneath-you case', async () => {
    const path = '99-inbox-main/email-from-cfia.md'
    const loaded = await call('file.load', { rootId: ROOT_ID, segments: seg(path) })
    const mine = '# Email from CFIA\n\nMy edit, which must not win silently.\n'

    // An agent edits the file while the editor holds it open. `mv` preserves mtime, so this is
    // written the way an agent actually does it: content changes, the clock may not.
    await fsp.writeFile(join(mockRoot, path), '# Email from CFIA\n\nRewritten by something else.\n')

    /**
     * **Over the wire, and that is the point of doing it here.** The unit suite proves the service
     * returns a `conflict` outcome; this proves the whole envelope survives the trip — that the
     * client receives `ok: true`, a discriminant, and a usable path, rather than the constant
     * refusal sentence §6 would otherwise have flattened it to.
     */
    const outcome = await call<{ outcome: string; rescue: string[] }>('file.save', {
      rootId: ROOT_ID, segments: seg(path),
      content: mine, expectedHash: loaded['hash'], confirmTruncation: false,
    })
    expect(outcome.outcome).toBe('conflict')

    // The agent's bytes are still there. Nothing was overwritten.
    expect(await fsp.readFile(join(mockRoot, path), 'utf8')).toContain('Rewritten by something else')
    // And the edit exists somewhere other than a browser tab.
    rescuedArtifact = outcome.rescue.join('/')
    expect(await fsp.readFile(join(mockRoot, rescuedArtifact), 'utf8')).toBe(mine)
  })

  it('blocks a save that would cut a document down, NAMING THE LOSS, until it is confirmed', async () => {
    const path = '02-projects/cold-store-expansion/00-context/m-thread-cold-store-expansion.md'
    const loaded = await call('file.load', { rootId: ROOT_ID, segments: seg(path) })
    const original = String(loaded['content'])

    const blocked = await call<{ outcome: string; wasBytes: number; willBeBytes: number }>(
      'file.save',
      {
        rootId: ROOT_ID, segments: seg(path),
        content: '# M-thread\n', expectedHash: loaded['hash'], confirmTruncation: false,
      },
    )
    // §13.2 requires the confirmation to name the loss. The numbers have to reach the client for
    // that sentence to be writable at all.
    expect(blocked.outcome).toBe('truncation-blocked')
    expect(blocked.wasBytes).toBe(Buffer.byteLength(original))
    expect(blocked.willBeBytes).toBe(Buffer.byteLength('# M-thread\n'))
    expect(await fsp.readFile(join(mockRoot, path), 'utf8')).toBe(original)

    // And it goes through once the loss has been named and accepted.
    await call('file.save', {
      rootId: ROOT_ID, segments: seg(path),
      content: '# M-thread\n', expectedHash: loaded['hash'], confirmTruncation: true,
    })
    expect(await fsp.readFile(join(mockRoot, path), 'utf8')).toBe('# M-thread\n')
  })

  // -------------------------------------------------------------------------------------------
  // The hazards, through the wire rather than through the module
  // -------------------------------------------------------------------------------------------

  it('refuses the oversized document rather than opening it truncated', async () => {
    const reply = await refusal('file.load', {
      rootId: ROOT_ID, segments: seg('zz-hazards/content-edges/over-the-cap.md'),
    })
    expect(JSON.stringify(reply.body)).not.toContain('The intake curve is contractual')
  })

  it('opens the document just under the cap', async () => {
    const loaded = await call('file.load', {
      rootId: ROOT_ID, segments: seg('zz-hazards/content-edges/just-under-the-cap.md'),
    })
    expect(String(loaded['content']).length).toBeGreaterThan(1_000_000)
  })

  it('reports a failed read as a failure, never as an empty document', async () => {
    const reply = await refusal('file.load', {
      rootId: ROOT_ID, segments: seg('zz-hazards/permissions/unreadable.md'),
    })
    // §6: an empty-but-successful result must never stand in for a failure. This is the C2 loss
    // path — an empty editor, one keystroke, and a file is gone.
    expect(reply.status).not.toBe(200)
  })

  it('refuses to write a file that is not markdown, whatever the client asks', async () => {
    await refusal('file.load', { rootId: ROOT_ID, segments: seg('zz-hazards/not-markdown/notes.markdown') })
    await refusal('file.load', { rootId: ROOT_ID, segments: seg('zz-hazards/not-markdown/config.json') })
  })

  it('will not follow a symlink out of the tree', async () => {
    await refusal('file.load', { rootId: ROOT_ID, segments: seg('zz-hazards/links/link-escaping-the-tree') })
    // /etc is still /etc.
    expect((await fsp.lstat('/etc')).isSymbolicLink() || (await fsp.stat('/etc')).isDirectory()).toBe(true)
  })

  // -------------------------------------------------------------------------------------------
  // Rename, copy, and the conflict already sitting in the tree
  // -------------------------------------------------------------------------------------------

  it('refuses a rename onto an existing file, and both files survive', async () => {
    const from = '99-inbox-main/hollis-wants-a-meeting.md'
    const onto = '99-inbox-main/bin-tag-printer-quote.md'
    const before = await fsp.readFile(join(mockRoot, onto), 'utf8')

    /**
     * A VALID token, and the reason is worth the line.
     *
     * `refusal` asserts only that the status is not 200 — so when the token became required, this
     * test kept passing on a 400 for a *missing token* while claiming to prove §13.6 refuses a
     * rename onto an occupied name. The collision was no longer being exercised at all. Asserting
     * the code below rather than merely "not 200" is what makes the difference visible.
     */
    const refused = await refusal('entry.rename', {
      rootId: ROOT_ID, from: seg(from), to: seg(onto), token: await tokenOf(from),
    })
    expect((refused.body as { error: { code: string } }).error.code).not.toBe('BAD_REQUEST')

    expect(await fsp.readFile(join(mockRoot, onto), 'utf8')).toBe(before)
    expect((await fsp.lstat(join(mockRoot, from))).isFile()).toBe(true)
  })

  it('renames to a free name, and the old path is gone', async () => {
    const from = '98-random-discovery/why-do-we-grade-on-the-line.md'
    const to = '98-random-discovery/grading-at-intake.md'
    await call('entry.rename', {
      rootId: ROOT_ID, from: seg(from), to: seg(to), token: await tokenOf(from),
    })
    expect((await fsp.lstat(join(mockRoot, to))).isFile()).toBe(true)
    await expect(fsp.lstat(join(mockRoot, from))).rejects.toThrow()
  })

  it('creates a file from a name a person would type, and slugifies it', async () => {
    const made = await call<{ segments: string[]; kind: string }>('entry.create', {
      rootId: ROOT_ID, parent: seg('99-inbox-main'), name: 'Hollis Follow Up', kind: 'file',
    })
    expect(made.segments).toEqual(['99-inbox-main', 'hollis-follow-up.md'])
    expect((await fsp.lstat(join(mockRoot, ...made.segments))).isFile()).toBe(true)
    /**
     * Annex A5's seed, carrying **what was typed** rather than the slug.
     *
     * This assertion read `toBe('')` first, matching a create that deliberately wrote nothing. The
     * annex says otherwise and is right: a document's title here is its first heading, so an empty
     * file shows `hollis-follow-up` where a seeded one shows `Hollis Follow Up`.
     */
    expect(await fsp.readFile(join(mockRoot, ...made.segments), 'utf8'))
      .toBe('# Hollis Follow Up\n')
  })

  it('creates a folder, one level, inside an existing one', async () => {
    const made = await call<{ segments: string[] }>('entry.create', {
      rootId: ROOT_ID, parent: seg('99-inbox-main'), name: 'Cider Line Notes', kind: 'directory',
    })
    expect(made.segments).toEqual(['99-inbox-main', 'cider-line-notes'])
    expect((await fsp.lstat(join(mockRoot, ...made.segments))).isDirectory()).toBe(true)
  })

  it('M16 — refuses a name that would slugify into an invisible file', async () => {
    const before = await fsp.readdir(join(mockRoot, '99-inbox-main'))
    const refused = await refusal('entry.create', {
      rootId: ROOT_ID, parent: seg('99-inbox-main'), name: '...', kind: 'file',
    })
    expect((refused.body as { error: { code: string } }).error.code).toBe('NAME_EMPTY')
    // And nothing was made — least of all a file named `.md`.
    expect(await fsp.readdir(join(mockRoot, '99-inbox-main'))).toEqual(before)
  })

  it('PRESERVES a non-Latin name rather than emptying it — the M16 input', async () => {
    const made = await call<{ segments: string[] }>('entry.create', {
      rootId: ROOT_ID, parent: seg('99-inbox-main'), name: '日本語', kind: 'file',
    })
    expect(made.segments).toEqual(['99-inbox-main', '日本語.md'])
    expect((await fsp.lstat(join(mockRoot, ...made.segments))).isFile()).toBe(true)
  })

  it('refuses a create whose parent does not exist, and makes no folders on the way', async () => {
    const refused = await refusal('entry.create', {
      rootId: ROOT_ID, parent: seg('99-inbox-main/not-there'), name: 'a', kind: 'file',
    })
    expect((refused.body as { error: { code: string } }).error.code).toBe('PARENT_MISSING')
    await expect(fsp.lstat(join(mockRoot, '99-inbox-main', 'not-there'))).rejects.toThrow()
  })

  it('refuses a second create at the same name, and the first file survives', async () => {
    await call('entry.create', {
      rootId: ROOT_ID, parent: seg('98-random-discovery'), name: 'Twice', kind: 'file',
    })
    await fsp.writeFile(join(mockRoot, '98-random-discovery', 'twice.md'), 'the first one\n')

    const refused = await refusal('entry.create', {
      rootId: ROOT_ID, parent: seg('98-random-discovery'), name: 'Twice', kind: 'file',
    })
    expect((refused.body as { error: { code: string } }).error.code).toBe('NAME_TAKEN')
    expect(await fsp.readFile(join(mockRoot, '98-random-discovery', 'twice.md'), 'utf8'))
      .toBe('the first one\n')
  })

  it('plans a folder copy before writing a byte, and the plan names the count', async () => {
    const planned = await call('entry.copy', {
      rootId: ROOT_ID, from: seg('02-projects/cider-line'),
      to: seg('02-projects/cider-line-copy'), plan: true,
      token: await tokenOf('02-projects/cider-line'),
    })
    expect(Number(planned['files'])).toBeGreaterThan(0)
    // Nothing written yet.
    await expect(fsp.lstat(join(mockRoot, '02-projects/cider-line-copy'))).rejects.toThrow()
  })

  it('copies a folder, and the copy matches the original file for file', async () => {
    await call('entry.copy', {
      rootId: ROOT_ID, from: seg('02-projects/cider-line'),
      to: seg('02-projects/cider-line-copy'), plan: false,
      token: await tokenOf('02-projects/cider-line'),
    })
    const source = await census(join(mockRoot, '02-projects/cider-line'))
    const copy = await census(join(mockRoot, '02-projects/cider-line-copy'))
    expect([...copy.keys()].sort()).toEqual([...source.keys()].sort())
    for (const [path, hash] of source) expect(copy.get(path)).toBe(hash)
  })

  it('resolves the conflict that was already sitting in the tree, and keeps the loser', async () => {
    const canonical = 'zz-hazards/already-conflicted/harvest-plan.md'
    const artifact = 'zz-hazards/already-conflicted/harvest-plan.conflict-20260806-134700-a3f7.md'
    const mine = await fsp.readFile(join(mockRoot, artifact), 'utf8')

    await call('conflict.resolve', {
      rootId: ROOT_ID, canonical: seg(canonical), artifact: seg(artifact), choice: 'mine',
      token: await tokenOf(canonical),
    })

    // One file at the canonical path, holding the edit that was rescued.
    expect(await fsp.readFile(join(mockRoot, canonical), 'utf8')).toBe(mine)
    // And the artifact is no longer sitting in the tree as an unresolved thing.
    await expect(fsp.lstat(join(mockRoot, artifact))).rejects.toThrow()
  })

  // -------------------------------------------------------------------------------------------
  // §9 — THE BYTE ENDPOINT, against the real tree and the hostile fixtures
  // -------------------------------------------------------------------------------------------

  it('serves a real PNG as an image, inline', async () => {
    const reply = await get(fileUrl('zz-hazards/not-markdown/real-photo.png'))
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('image/png')
    expect(reply.headers['content-disposition']).toContain('inline;')
    // The bytes, not the length: a signature check is what proves an image arrived intact.
    expect(reply.body.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  })

  /**
   * **THE ONE §9 EXISTS FOR.** v1 said bytes are never served as `text/html` or
   * `application/javascript`, and `image/svg+xml` is neither — while an SVG loaded as a document
   * runs its `<script>` in the origin that holds every file.
   */
  it('NEVER serves an .svg as image/svg+xml — it downloads', async () => {
    const reply = await get(fileUrl('zz-hazards/malicious/script-carrier.svg'))
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('application/octet-stream')
    expect(reply.headers['content-type']).not.toContain('svg')
    expect(reply.headers['content-disposition']).toContain('attachment;')
    // The bytes are handed over unchanged — refusing to RENDER it is not refusing to serve it.
    expect(reply.body.toString('utf8')).toContain('<script')
  })

  it('serves an .html file as an attachment, never as a document', async () => {
    const reply = await get(fileUrl('zz-hazards/malicious/page.html'))
    expect(reply.headers['content-type']).toBe('application/octet-stream')
    expect(reply.headers['content-disposition']).toContain('attachment;')
  })

  it('serves a small .csv as read-only plain text — FT-10', async () => {
    const reply = await get(fileUrl('zz-hazards/not-markdown/spreadsheet.csv'))
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(reply.body.toString('utf8')).toContain('Hollis')
  })

  it('does not serve a .md through this endpoint as text — the editor owns those', async () => {
    const reply = await get(fileUrl('99-inbox-main/bin-tag-printer-quote.md'))
    expect(reply.headers['content-type']).toBe('application/octet-stream')
  })

  it('carries §9\'s full header set on a success', async () => {
    const reply = await get(fileUrl('zz-hazards/not-markdown/real-photo.png'))
    expect(reply.headers['content-security-policy'])
      .toBe("sandbox; default-src \'none\'; style-src \'unsafe-inline\'")
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(reply.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(reply.headers['referrer-policy']).toBe('no-referrer')
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['accept-ranges']).toBe('bytes')
  })

  it('carries the same header set on a REFUSAL, where they most often go missing', async () => {
    const reply = await get(`/file?ticket=${encodeURIComponent(ticket)}&root=${ROOT_ID}&p=nope.png`)
    expect(reply.status).toBe(404)
    expect(reply.headers['content-security-policy']).toContain('sandbox')
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
  })

  it('refuses without a valid ticket, and says nothing about the file', async () => {
    const forged = `/file?ticket=notaticket&root=${ROOT_ID}&p=zz-hazards&p=not-markdown&p=real-photo.png`
    const reply = await get(forged)
    expect(reply.status).toBe(403)
    expect(reply.body.byteLength).toBe(0)
  })

  it('a missing file and a traversal are indistinguishable — no existence oracle', async () => {
    const missing = await get(fileUrl('99-inbox-main/does-not-exist.png'))
    const escape = await get(fileUrl('../../../../etc/passwd'))
    expect(missing.status).toBe(404)
    expect(escape.status).toBe(404)
    expect(escape.body.byteLength).toBe(0)
  })

  /**
   * **This test passed before it was correct**, which is worth leaving on the record.
   *
   * Its first version asked for `zz-hazards/symlinks/link-to-outside.md` — a path that does not
   * exist in the mock soil, where the symlinks live under `links/`. It got its 404 for "no such
   * file" and reported that the symlink rule held. The rule was never exercised.
   *
   * So the fixture's existence is now asserted first: a 404 only means what this test says it
   * means if there is really a symlink there to refuse.
   */
  it('refuses to follow a symlink, pointing outside the tree OR inside it', async () => {
    for (const path of ['zz-hazards/links/link-escaping-the-tree',
      'zz-hazards/links/link-to-a-file-inside.md']) {
      const stat = await fsp.lstat(join(mockRoot, path))
      expect(stat.isSymbolicLink(), `${path} must be a symlink for this test to mean anything`)
        .toBe(true)

      const reply = await get(fileUrl(path))
      expect(reply.status, path).toBe(404)
      expect(reply.body.byteLength).toBe(0)
    }
  })

  it('refuses a directory', async () => {
    expect((await get(fileUrl('99-inbox-main'))).status).toBe(404)
  })

  it('serves a byte range, and reports it', async () => {
    const whole = await get(fileUrl('zz-hazards/not-markdown/real-photo.png'))
    const ranged = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>(
      (resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1', port: tailnetPort,
          path: fileUrl('zz-hazards/not-markdown/real-photo.png'), method: 'GET',
          headers: { host: `127.0.0.1:${tailnetPort}`, range: 'bytes=0-7' },
        }, res => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => { chunks.push(c) })
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks),
          }))
        })
        req.on('error', reject)
        req.end()
      })

    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe(`bytes 0-7/${whole.body.byteLength}`)
    expect(ranged.body).toEqual(whole.body.subarray(0, 8))
  })

  it('answers an unsatisfiable range with 416 and the file size', async () => {
    const reply = await new Promise<{ status: number; headers: Record<string, string> }>(
      (resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1', port: tailnetPort,
          path: fileUrl('zz-hazards/not-markdown/real-photo.png'), method: 'GET',
          headers: { host: `127.0.0.1:${tailnetPort}`, range: 'bytes=99999-' },
        }, res => {
          res.resume()
          res.on('end', () => resolve({
            status: res.statusCode ?? 0, headers: res.headers as Record<string, string>,
          }))
        })
        req.on('error', reject)
        req.end()
      })
    expect(reply.status).toBe(416)
    expect(reply.headers['content-range']).toBe('bytes */70')
  })

  it('the endpoint is absent from the LOCAL listener', async () => {
    // Not a privilege decision — the local listener serves no UI, so nothing there would build an
    // <img>. A second door to the same bytes with no caller is a door nobody watches.
    const reply = await post(
      fileUrl('zz-hazards/not-markdown/real-photo.png'), {}, app.localToken)
    expect(reply.status).not.toBe(200)
  })

  // -------------------------------------------------------------------------------------------
  // THE CENSUS — the assertion this whole file exists for
  // -------------------------------------------------------------------------------------------

  it('THE CENSUS: after all of that, nothing changed except what was asked to change', async () => {
    const after = await census(mockRoot)

    // Everything above either touched a named path or was refused. This is that list, and it is
    // written out by hand rather than derived — a derived expectation would absorb a surprise
    // instead of reporting it.
    const intentionallyTouched = [
      '99-inbox-main/bin-tag-printer-quote.md',                    // saved
      '99-inbox-main/email-from-cfia.md',                          // rewritten underneath us
      '02-projects/cold-store-expansion/00-context/m-thread-cold-store-expansion.md', // truncated
      '98-random-discovery/why-do-we-grade-on-the-line.md',        // renamed away
      '98-random-discovery/grading-at-intake.md',                  // renamed to
      'zz-hazards/already-conflicted/harvest-plan.md',             // conflict resolved
      'zz-hazards/already-conflicted/harvest-plan.conflict-20260806-134700-a3f7.md', // consumed
      // P7's creation verb. Each of these is a file `entry.create` was asked to make, named here
      // by hand for the same reason as the rest of this list — a derived expectation would absorb
      // an unintended create rather than report it.
      '99-inbox-main/hollis-follow-up.md',                         // created
      '99-inbox-main/日本語.md',                                    // created, M16's input
      '98-random-discovery/twice.md',                              // created, then written to
    ]
    /**
     * Folders `entry.create` made.
     *
     * Kept separate from the list above because a folder is two things to this census: `census`
     * records the directory itself with the value `'dir'` **and** recurses into it, so a created
     * folder must be excluded both as an entry in its own right and as a prefix of anything under
     * it. Written after getting it wrong once — the first version of this comment claimed the
     * census walked files only, which the census immediately disproved.
     */
    const createdFolders = ['99-inbox-main/cider-line-notes']
    const isCopy = (path: string): boolean => path.startsWith('02-projects/cider-line-copy')

    const unchanged = new Map([...before].filter(([path]) =>
      !intentionallyTouched.includes(path) && !isCopy(path)))

    const lost: string[] = []
    const altered: string[] = []
    for (const [path, hash] of unchanged) {
      const now = after.get(path)
      if (now === undefined) lost.push(path)
      else if (now !== hash) altered.push(path)
    }

    expect(lost, `files that disappeared: ${lost.slice(0, 20).join(', ')}`).toEqual([])
    expect(altered, `files that changed on their own: ${altered.slice(0, 20).join(', ')}`).toEqual([])
    // And the census is not vacuous — it covered the whole tree.
    expect(unchanged.size).toBeGreaterThan(2_500)

    /**
     * **The other direction, and it was missing.** Everything above compares `before` against
     * `after`, so a file that *appeared* was invisible to it: an app scattering stray siblings
     * through the tree would have passed this census unremarked.
     *
     * It went unnoticed until the save path started creating a file on purpose — §13.5's rescue —
     * and there was nowhere to assert that. Noted rather than quietly added, because "the census
     * only looked one way" is the same class of gap as the rest of today's findings.
     */
    const appeared = [...after.keys()]
      .filter(path =>
        !before.has(path) && !isCopy(path) && !intentionallyTouched.includes(path)
        && !createdFolders.some(folder => path === folder || path.startsWith(`${folder}/`)))
      .sort()
    expect(appeared, 'nothing appeared except the rescue file we provoked').toEqual(
      rescuedArtifact === '' ? [] : [rescuedArtifact],
    )
    expect(rescuedArtifact, 'and the conflict test did run').not.toBe('')
  })
})

