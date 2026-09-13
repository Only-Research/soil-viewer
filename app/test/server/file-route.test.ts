import { promises as fsp } from 'node:fs'
import { Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type RegisteredRoot } from '../../src/core/fs/containment'
import { registerRoot } from '../../src/core/fs/registration'

import { MAX_SERVED_BYTES } from '../../src/core/file-serving'
import {
  FILE_PATH,
  fileHeaders,
  fileRouteLabel,
  isFileRequest,
  parseFileRequest,
  parseRange,
  serveFile,
} from '../../src/server/file-route'

/**
 * A `SessionStore` that accepts exactly one ticket.
 *
 * Only `verifyTicket` is implemented, and the rest throw rather than returning a benign default —
 * if the route ever calls `hold` or `release` this fails loudly, which is the assertion that its
 * documented promise (verify, never touch the stream accounting) stays true.
 */
function acceptingSessions(good: string): Parameters<typeof serveFile>[2]['sessions'] {
  const refuse = (name: string) => (): never => {
    throw new Error(`serveFile must not call ${name}`)
  }
  return {
    start: refuse('start'),
    verifyTicket: presented => (presented === good ? (presented as never) : null),
    hold: refuse('hold'),
    release: refuse('release'),
    liveTickets: refuse('liveTickets'),
  }
}

/**
 * A real `Writable` wearing a `ServerResponse`'s head.
 *
 * The first version was a plain object with `write`, `end` and `on`, and the two tests that
 * actually stream a file **hung for five seconds and timed out** — `createReadStream().pipe(res)`
 * needs genuine stream machinery, and a hand-rolled shape that merely has the right method names
 * gets piped into and never finishes. The refusal tests passed throughout, because they only ever
 * touch `writeHead` and `end`.
 *
 * Worth the note: a stub that satisfies the type checker and not the runtime is the same class of
 * thing as a control that satisfies a reader and not the machine.
 */
function fakeResponse() {
  const chunks: Buffer[] = []
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  const state = {
    status: 0,
    headers: {} as Record<string, string>,
    get body() { return Buffer.concat(chunks) },
    response: writable as never,
  }
  Object.assign(writable, {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      state.headers = headers ?? {}
      return writable
    },
  })
  return state
}

describe('recognising the route', () => {
  it('matches the path with and without a query string', () => {
    expect(isFileRequest(FILE_PATH)).toBe(true)
    expect(isFileRequest('/file?ticket=a&root=b&p=c')).toBe(true)
  })

  it('does not match a prefix or a sibling', () => {
    // `/files` and `/file/x` are different routes; matching them here would claim paths the asset
    // map or a future route owns.
    expect(isFileRequest('/files')).toBe(false)
    expect(isFileRequest('/file/x')).toBe(false)
    expect(isFileRequest('/api/file.load')).toBe(false)
  })
})

describe('parsing the request', () => {
  const ok = (target: string) => {
    const parsed = parseFileRequest(target)
    if (parsed === null) throw new Error('expected a parse')
    return parsed
  }

  it('reads the ticket, the root and one segment per p', () => {
    expect(ok('/file?ticket=T&root=soil&p=02-projects&p=a.png')).toEqual({
      ticket: 'T', rootId: 'soil', segments: ['02-projects', 'a.png'],
    })
  })

  it('percent-decodes each segment', () => {
    expect(ok('/file?ticket=T&root=soil&p=caf%C3%A9&p=a%20b.png').segments)
      .toEqual(['café', 'a b.png'])
  })

  it('keeps a slash inside a segment as a literal, never as a separator', () => {
    // The reason segments are repeated parameters rather than a joined path: `a%2Fb` is one
    // segment named `a/b`, and re-splitting a joined string would silently make it two.
    expect(ok('/file?ticket=T&root=soil&p=a%2Fb.png').segments).toEqual(['a/b.png'])
  })

  it('REFUSES a repeated ticket or root rather than picking one', () => {
    expect(parseFileRequest('/file?ticket=a&ticket=b&root=r&p=x')).toBeNull()
    expect(parseFileRequest('/file?ticket=a&root=r1&root=r2&p=x')).toBeNull()
  })

  it('refuses an unknown parameter rather than ignoring it', () => {
    expect(parseFileRequest('/file?ticket=a&root=r&p=x&download=1')).toBeNull()
  })

  it('refuses a missing ticket, root or path', () => {
    expect(parseFileRequest('/file?root=r&p=x')).toBeNull()
    expect(parseFileRequest('/file?ticket=a&p=x')).toBeNull()
    expect(parseFileRequest('/file?ticket=a&root=r')).toBeNull()
    expect(parseFileRequest('/file')).toBeNull()
  })

  it('refuses a malformed percent escape rather than guessing', () => {
    expect(parseFileRequest('/file?ticket=a&root=r&p=%zz')).toBeNull()
  })
})

/**
 * §9: *"Range requests: single range, clamped, 416 on invalid, `Accept-Ranges` advertised."*
 */
describe('ranges', () => {
  it('no header means the whole file', () => {
    expect(parseRange(undefined, 100)).toBeNull()
  })

  it('an ordinary range', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
  })

  it('an open-ended range runs to the last byte', () => {
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
  })

  it('a suffix range takes the last n bytes', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })

  it('CLAMPS an end past the file rather than refusing it', () => {
    expect(parseRange('bytes=90-100000', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-100000', 100)).toEqual({ start: 0, end: 99 })
  })

  it('refuses a start past the end of the file', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=200-300', 100)).toBe('invalid')
  })

  it('refuses a reversed range', () => {
    expect(parseRange('bytes=50-10', 100)).toBe('invalid')
  })

  /**
   * A multi-range request is refused rather than answered with its first range.
   *
   * Answering one of two is a wrong answer dressed as a right one: the client gets a 206 it will
   * treat as complete and silently loses the second range.
   */
  it('refuses a MULTI-range request rather than serving the first', () => {
    expect(parseRange('bytes=0-9,20-29', 100)).toBe('invalid')
  })

  it('refuses junk, other units, and negatives', () => {
    for (const header of ['', 'bytes=', 'bytes=abc', 'items=0-9', 'bytes=-', 'bytes=--5', '0-9']) {
      expect(parseRange(header, 100), header).toBe('invalid')
    }
  })

  it('refuses any range on an empty file, where none can be satisfied', () => {
    expect(parseRange('bytes=0-0', 0)).toBe('invalid')
    expect(parseRange('bytes=-1', 0)).toBe('invalid')
  })

  it('refuses a start that is not a safe integer', () => {
    expect(parseRange('bytes=99999999999999999999-', 100)).toBe('invalid')
  })
})

/**
 * §9 lists these by name, and every one of them is on **every** response the route makes —
 * including its refusals, which is where a header set most often goes missing.
 */
describe('the header set', () => {
  it('carries the sandbox CSP, and it is NOT the app policy', () => {
    const headers = fileHeaders()
    expect(headers['content-security-policy']).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    // The app's own policy would let a served document load from the origin holding the files.
    expect(headers['content-security-policy']).not.toContain("script-src 'self'")
  })

  it('carries nosniff, same-origin CORP, no-referrer, no-store and Accept-Ranges', () => {
    const headers = fileHeaders()
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(headers['referrer-policy']).toBe('no-referrer')
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['accept-ranges']).toBe('bytes')
  })

  it('sets no content type of its own — that is the serving decision\'s job', () => {
    expect(fileHeaders()['content-type']).toBeUndefined()
  })
})

/**
 * §9: *"Refuse over 25 MiB."*
 *
 * **Two assertions, and the second one is the one that matters.** Pinning the constant is what
 * FT-3's three tests did — they proved `MAX_WRITE_BODY_BYTES` was well-formed while nothing in
 * `src/` read it. So the mechanism is driven as well: a real file, a real `serveFile`, and a cap
 * the route is asked to honour.
 *
 * The first version of this block asserted `options.maxBytes ?? MAX_SERVED_BYTES` in the test —
 * arithmetic performed by the test, about a value the route was never asked for. Recorded because
 * it is the same mistake one layer along, written by someone who had just finished describing it.
 */
describe('the size cap', () => {
  let sandbox: string
  let root: RegisteredRoot

  beforeEach(async () => {
    sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p7-cap-'))
    await fsp.writeFile(join(sandbox, 'small.png'), Buffer.alloc(4096, 1))
    const registered = await registerRoot('scratch', sandbox)
    if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)
    root = registered.value
  })

  afterEach(async () => {
    await fsp.rm(sandbox, { recursive: true, force: true })
  })

  const serve = async (maxBytes?: number) => {
    const res = fakeResponse()
    await serveFile(
      { url: '/file?ticket=good&root=scratch&p=small.png', method: 'GET', headers: {} } as never,
      res.response,
      {
        sessions: acceptingSessions('good'),
        rootFor: () => root,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      },
    )
    return res
  }

  it('is 25 MiB', () => {
    expect(MAX_SERVED_BYTES).toBe(25 * 1024 * 1024)
  })

  it('THE ROUTE READS IT — a file over the cap is refused 413, with §9\'s headers', async () => {
    const refused = await serve(1024)
    expect(refused.status).toBe(413)
    expect(refused.headers['x-content-type-options']).toBe('nosniff')
    expect(refused.body.byteLength).toBe(0)
  })

  it('and a file under it is served', async () => {
    const served = await serve(8192)
    expect(served.status).toBe(200)
    expect(served.headers['content-length']).toBe('4096')
  })

  it('with no override, the cap in force is the spec\'s — a 4 KiB file is served', async () => {
    expect((await serve()).status).toBe(200)
  })
})

describe('what the route refuses outright', () => {
  let sandbox: string
  let root: RegisteredRoot

  beforeEach(async () => {
    sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p7-refuse-'))
    await fsp.mkdir(join(sandbox, 'a-folder'), { recursive: true })
    const registered = await registerRoot('scratch', sandbox)
    if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)
    root = registered.value
  })

  afterEach(async () => {
    await fsp.rm(sandbox, { recursive: true, force: true })
  })

  const serveTarget = async (url: string, rootFor: () => RegisteredRoot | null = () => root) => {
    const res = fakeResponse()
    await serveFile(
      { url, method: 'GET', headers: {} } as never,
      res.response,
      { sessions: acceptingSessions('good'), rootFor },
    )
    return res
  }

  it('a DIRECTORY is a 404, never a listing and never a stream', async () => {
    const res = await serveTarget('/file?ticket=good&root=scratch&p=a-folder')
    expect(res.status).toBe(404)
    expect(res.body.byteLength).toBe(0)
  })

  it('an unregistered root is a 404 with nothing said about it', async () => {
    const res = await serveTarget('/file?ticket=good&root=nope&p=x.png', () => null)
    expect(res.status).toBe(404)
  })

  it('a bad ticket is a 403, and the path is never looked at', async () => {
    const res = fakeResponse()
    let looked = false
    await serveFile(
      { url: '/file?ticket=WRONG&root=scratch&p=a-folder', method: 'GET', headers: {} } as never,
      res.response,
      {
        sessions: acceptingSessions('good'),
        rootFor: () => { looked = true; return root },
      },
    )
    expect(res.status).toBe(403)
    expect(looked, 'the credential is checked before anything is resolved').toBe(false)
  })

  it('a malformed request is a 400', async () => {
    expect((await serveTarget('/file?ticket=good&root=scratch')).status).toBe(400)
  })
})

describe('what a log is allowed to know', () => {
  it('the route label is a constant, so a ticket can never reach a record', () => {
    // §7 property 4: the credential never appears in a log. Here it lives in the URL, so a label
    // derived from the URL would carry it.
    expect(fileRouteLabel).toBe('file.bytes')
    expect(fileRouteLabel).not.toContain('?')
    expect(fileRouteLabel).not.toContain('ticket')
  })
})
