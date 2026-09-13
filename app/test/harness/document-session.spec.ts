/**
 * The document session, against the **real server**.
 *
 * ## Why this exists, found at P6's gate
 *
 * `document-session.ts` holds the autosave, the three-trigger flush contract and C2 — and it was
 * **imported by nothing.** Twenty-six unit tests, a mutation sweep, and no caller. That is this
 * build's signature failure, in the phase's own work, caught by grepping importers at the gate
 * rather than by any suite.
 *
 * It is *scheduled* rather than forgotten: the session needs a file to open, and the tree that picks
 * one is P7. But "scheduled" is what every unreached control in this build has been, and P4's gate
 * exists in the record because four write verbs left the index stale while every unit test passed.
 *
 * So rather than carry it as a promise, it is driven here against the real `file.load` and
 * `file.save` — the same transport the app will hand it. **What P7 adds is a file picker, not a
 * first exercise of this module.**
 *
 * Nothing goes near the user's files: a temp directory, created and removed per test.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

import {
  createDocumentSession,
  type DocumentTransport,
  type Scheduler,
} from '../../src/client/editor/document-session'
import type { SaveStatus } from '../../src/client/editor/save-policy'
import { PORT_LOCAL } from './ports'
import { startProductServer, type RunningServer } from './server'

const LOCAL = `http://127.0.0.1:${PORT_LOCAL}`
const TOKEN_HEADER = 'x-soil-token'

/** Runs nothing until a test says so — no sleeping, no flake. */
function manualScheduler(): Scheduler & { runPending: () => void } {
  let queue: (() => void)[] = []
  return {
    after: (_ms, run) => { queue.push(run); return () => { queue = queue.filter(q => q !== run) } },
    runPending: () => { const due = queue; queue = []; for (const run of due) run() },
  }
}

/**
 * The real transport: the app's own routes over HTTP, with the origin and token §7 requires.
 *
 * Deliberately the thinnest possible adapter. Anything clever here would be a second implementation
 * of the thing under test.
 */
function realTransport(context: APIRequestContext, token: string): DocumentTransport {
  const call = async (route: string, input: unknown): Promise<unknown> => {
    const response = await context.post(`${LOCAL}/api/${route}`, {
      data: input,
      headers: { origin: LOCAL, [TOKEN_HEADER]: token },
    })
    const body = await response.json() as { ok?: boolean; data?: unknown; error?: { code?: string } }
    if (response.status() !== 200 || body.ok !== true) {
      throw new Error(body.error?.code ?? `HTTP ${response.status()}`)
    }
    return body.data
  }
  return {
    load: async location => await call('file.load', location) as never,
    save: async request => await call('file.save', request) as never,
  }
}

test.describe('the document session against the real server', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(({ browserName }) => browserName !== 'chromium', 'no browser is involved; this is the session over real HTTP')

  let server: RunningServer
  let context: APIRequestContext
  let root: string
  let scratch: string

  /**
   * The hooks skip too, not just the tests.
   *
   * `test.skip(({ browserName }) => …)` skips the bodies and **still runs `beforeAll`** — so the
   * second project started a second product server on the same port and the suite failed on a
   * path built from state the skipped setup never assigned. Guarding on the project name is what
   * makes "chromium only" mean the whole fixture rather than only the assertions.
   */
  test.beforeAll(async () => {
    if (test.info().project.name !== 'chromium') return
    server = await startProductServer()
    context = await playwrightRequest.newContext()
    scratch = mkdtempSync(join(tmpdir(), 'soil-viewer-session-'))
    root = join(scratch, 'soil')
    writeFileSync(join(scratch, 'placeholder'), '')
    rmSync(join(scratch, 'placeholder'))
    // A registered root the session can address.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(root, { recursive: true })
    const response = await context.post(`${LOCAL}/api/folders.register`, {
      data: { id: 'session', absolutePath: root },
      headers: { origin: LOCAL, [TOKEN_HEADER]: server.localToken },
    })
    expect(response.status(), await response.text()).toBe(200)
  })

  test.afterAll(async () => {
    if (test.info().project.name !== 'chromium') return
    await context?.dispose()
    server?.stop()
    rmSync(scratch, { recursive: true, force: true })
  })

  test('loads, autosaves after typing stops, and the bytes land on disk', async () => {
    const file = 'notes.md'
    const original = '# Original\n\nBody text that is long enough to survive the truncation guard.\n'
    writeFileSync(join(root, file), original)

    const statuses: SaveStatus[] = []
    const scheduler = manualScheduler()
    const session = createDocumentSession(
      { rootId: 'session', segments: [file] },
      realTransport(context, server.localToken),
      scheduler,
      { onStatus: status => { statuses.push(status) }, onReady: () => {} },
    )

    await session.open()
    expect(session.peek().editable, 'a successful load makes it editable').toBe(true)

    const edited = `${original}\nA line the user typed.\n`
    session.changed(edited)
    expect(readFileSync(join(root, file), 'utf8'), 'nothing written while typing').toBe(original)

    scheduler.runPending()
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(readFileSync(join(root, file), 'utf8'), 'the autosave landed').toBe(edited)
    expect(statuses.at(-1)).toBe('saved')
    expect(session.peek().dirty).toBe(false)
  })

  test('C2 OVER REAL HTTP — a file that will not load leaves the session uneditable', async () => {
    /**
     * The cheapest total-loss path, driven end to end rather than against a stub that rejects. The
     * refusal here is the app's own: §12 declines a NUL-bearing file, and the session must never
     * turn that into an editable buffer.
     */
    const file = 'binary.md'
    const bytes = Buffer.from([0x23, 0x20, 0x61, 0x0a, 0x00, 0x62, 0x0a])
    writeFileSync(join(root, file), bytes)

    const session = createDocumentSession(
      { rootId: 'session', segments: [file] },
      realTransport(context, server.localToken),
      manualScheduler(),
      { onStatus: () => {}, onReady: () => { throw new Error('this file must never become editable') } },
    )

    await session.open()
    expect(session.peek().editable).toBe(false)

    session.changed('one keystroke')
    await session.flush()
    await session.confirmTruncation()

    expect(readFileSync(join(root, file)).equals(bytes), 'the file is untouched').toBe(true)
  })

  test('a conflict leaves the canonical file alone and the buffer dirty', async () => {
    const file = 'contested.md'
    const original = '# Contested\n\nEnough body text here to clear the truncation guard easily.\n'
    writeFileSync(join(root, file), original)

    const session = createDocumentSession(
      { rootId: 'session', segments: [file] },
      realTransport(context, server.localToken),
      manualScheduler(),
      { onStatus: () => {}, onReady: () => {} },
    )
    await session.open()
    session.changed(`${original}My edit.\n`)

    // Something else writes between the load and the save — an agent, on this tree, is the normal case.
    const theirs = `${original}Their edit, written underneath.\n`
    writeFileSync(join(root, file), theirs)

    await session.flush()

    expect(readFileSync(join(root, file), 'utf8'), 'the other writer survives untouched').toBe(theirs)
    expect(session.peek().dirty, 'and the edit is still held, not discarded').toBe(true)
  })

  test('the three exit triggers cost one write, against the real server', async () => {
    const file = 'flush.md'
    const original = '# Flush\n\nBody text long enough that halving it is not the thing being tested.\n'
    writeFileSync(join(root, file), original)

    let saves = 0
    const transport = realTransport(context, server.localToken)
    const counted: DocumentTransport = {
      load: transport.load,
      save: async request => { saves++; return await transport.save(request) },
    }

    const session = createDocumentSession(
      { rootId: 'session', segments: [file] },
      counted,
      manualScheduler(),
      { onStatus: () => {}, onReady: () => {} },
    )
    await session.open()
    session.changed(`${original}Edited.\n`)

    await session.flush()
    await session.flush()
    await session.flush()

    expect(saves, 'three triggers, one write').toBe(1)
  })
})
