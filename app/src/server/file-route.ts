/**
 * `GET /file` — the one place this app hands raw file bytes to a browser. Spec §9.
 *
 * **A different shape from everything else in the server, and that is the risk.** Every other route
 * is a POST through one validated funnel: same body parser, same CSRF gate, same error envelope,
 * same `securityHeaders()`. This one is a GET, returns bytes rather than JSON, needs its own
 * content type, its own disposition, its own cache policy and its own CSP — so **none of the funnel's
 * guarantees arrive here by inheritance.** Every control it needs, it states.
 *
 * That is exactly the shape §9 was written about: v1's rule sounded complete and left `image/svg+xml`
 * outside it, because the rule was phrased in terms of two types rather than an allowlist.
 *
 * ## Why the ticket, and not the CSRF token
 *
 * §7's gate is a per-request token in a **header**, and `<img src>` cannot send one. Neither can
 * `<iframe src>`. A route reachable only by a header is a route no image can load.
 *
 * The precedent already exists and is security-reviewed: `/events` has the identical problem —
 * `EventSource` cannot set headers either — and it is answered with the **ticket**, a value that
 * travels in the query string and whose documented property is exactly what is needed here:
 *
 *   *"the ticket is obtainable only through the same authorization that yields the main token, and
 *   never through a weaker one."*
 *
 * So this route verifies a ticket. Three consequences, all deliberate:
 *
 *   - **It verifies and nothing more.** `verifyTicket` is a constant-time comparison that neither
 *     consumes the ticket nor opens a stream. `hold`/`release` are not called, so the stream
 *     accounting in `session.ts` is untouched and a page full of images cannot exhaust the stream
 *     cap.
 *   - **The ticket lives as long as the page.** A ticket with no open stream is reclaimed after a
 *     grace period (K6), but the client holds an open `EventSource` for live updates, which keeps
 *     it held. An image URL therefore stays valid for as long as the page that built it.
 *   - **The ticket must never reach a log.** §7's token property 4 applies to it by the same
 *     reasoning, and the URL is where it lives — so the route label recorded for this path is a
 *     constant, and the query string is never written anywhere. See `fileRouteLabel`.
 *
 * **This is the security decision in P7 most worth the security review's attention**, and it is written down here
 * rather than left implicit in a diff: reusing the stream ticket as a file-read capability is a
 * widening of what that ticket authorises, from "receive events" to "receive bytes of any file in a
 * registered folder". The alternative considered was a separate short-lived per-path capability,
 * rejected as a second credential with a second lifecycle for no additional guarantee — anything
 * holding the ticket can already call `file.load` and read the same bytes as text.
 *
 * ## Addressing
 *
 * `/file?ticket=…&root=…&p=…&p=…` — one `p` per path segment, never a joined path. Same reasoning
 * as `WireLocation`: *"a joined path invites the client to build one by concatenation, and
 * re-splitting it server-side reintroduces the separator ambiguity the Core spent P1 eliminating."*
 * A query string is the one place a client would be most tempted to join.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  MAX_SERVED_BYTES,
  contentDisposition,
  servingDecisionFor,
} from '../core/file-serving'
import type { RegisteredRoot } from '../core/fs/containment'
import { openForReading } from '../core/fs/read-bytes'
import type { SessionStore } from './session'

/** The path this route answers on. A constant, so nothing derives it twice. */
export const FILE_PATH = '/file'

/**
 * What the mutation log and the local log are allowed to know about a request here.
 *
 * **A constant, never the target.** The target carries the ticket, and §7 property 4 forbids a
 * credential reaching a log. `routeLabelFor` elsewhere derives a label from the URL, which is
 * correct for every route whose URL is inert and wrong for this one.
 */
export const fileRouteLabel = 'file.bytes'

/** True when this request is for the file endpoint, ignoring any query string. */
export function isFileRequest(target: string): boolean {
  const path = target.split('?')[0] ?? ''
  return path === FILE_PATH
}

export interface FileRequest {
  readonly ticket: string
  readonly rootId: string
  readonly segments: readonly string[]
}

/**
 * Parses the query string, and refuses anything ambiguous rather than picking a winner.
 *
 * A repeated `ticket` or `root` is refused outright — the same rule `ticketFrom` applies in
 * `listener.ts`, and for the same reason: two values mean the client and the server can disagree
 * about which one was checked, which is the request-smuggling shape one layer up.
 */
export function parseFileRequest(target: string): FileRequest | null {
  const query = target.split('?')[1]
  if (query === undefined) return null

  let ticket: string | null = null
  let rootId: string | null = null
  const segments: string[] = []

  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    const key = pair.slice(0, separator)
    let value: string
    try {
      value = decodeURIComponent(pair.slice(separator + 1))
    } catch {
      // A malformed escape is a malformed request. Refusing beats guessing at the intent.
      return null
    }

    if (key === 'ticket') {
      if (ticket !== null) return null
      ticket = value
    } else if (key === 'root') {
      if (rootId !== null) return null
      rootId = value
    } else if (key === 'p') {
      segments.push(value)
    } else {
      // Unknown keys refused, matching the contract's strict objects: an ignored parameter is a
      // parameter a future reader assumes is honoured.
      return null
    }
  }

  if (ticket === null || rootId === null || segments.length === 0) return null
  return { ticket, rootId, segments }
}

/** A single byte range, already clamped to the file. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * RFC 7233's `Range`, restricted to what §9 permits: **a single range**, clamped.
 *
 * Returns `null` when there is no range header (send the whole file) and `'invalid'` when there is
 * one that cannot be honoured (416). Multi-range is `'invalid'` rather than "first range only":
 * answering a multi-range request with one range is a wrong answer dressed as a right one, and a
 * client that asked for two and got one silently loses the second.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (header === undefined) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return 'invalid'

  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'

  // A zero-length file has no satisfiable range at all — every start is past the end.
  if (size === 0) return 'invalid'

  if (rawStart === '') {
    // `bytes=-N`: the LAST n bytes. Clamped to the file rather than refused, per RFC 7233.
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return 'invalid'

  if (rawEnd === '') return { start, end: size - 1 }

  const end = Number(rawEnd)
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  // Clamped, not refused: a client asking for more than exists gets what exists.
  return { start, end: Math.min(end, size - 1) }
}

/**
 * §9's header set, in full, on **every** response this route makes including its refusals.
 *
 * The CSP here is **not** the app's. `sandbox` puts the response in an opaque origin, so even if
 * every other control failed and a document arrived, it would have no access to the origin that
 * holds the files. `default-src 'none'` stops it fetching anything at all.
 */
export function fileHeaders(): Record<string, string> {
  return {
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    // §15 requires an explicit policy on every response. `no-store` because these are the user's
    // own files: a cached copy on a shared proxy is a copy of their document.
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  }
}

export interface FileRouteOptions {
  readonly sessions: SessionStore
  readonly rootFor: (rootId: string) => RegisteredRoot | null
  /**
   * §9's 25 MiB refusal, injected **so that a test can reach it**.
   *
   * A mutation sweep deleted the size check and nothing went red: the largest fixture in the mock
   * soil is 2 MiB, so the branch was unreachable by any test that existed. The alternatives were a
   * 25 MiB fixture written on every generation — 25 MB of disk and seconds of I/O, on every run,
   * to exercise one comparison — or a seam. Same reasoning as `session.ts`'s injected `mint` and
   * `now`: *"injected so a test can force a collision"*.
   *
   * **A seam proves the mechanism, not the number**, which is the FT-3 lesson exactly: three tests
   * proved `MAX_WRITE_BODY_BYTES` was well-formed and none asked who read it. So both are pinned —
   * a test asserts this defaults to `MAX_SERVED_BYTES`, and another asserts the route refuses at
   * whatever it is set to.
   */
  readonly maxBytes?: number
}

/**
 * Answers one `GET /file`.
 *
 * Every refusal is a bare status with §9's headers and **no body** — no path, no reason, no
 * distinction between "not registered", "not there" and "outside the root". §6 keeps detail off the
 * wire, and here the detail is an existence oracle over the whole disk.
 */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  options: FileRouteOptions,
): Promise<void> {
  const refuse = (status: number): void => {
    res.writeHead(status, fileHeaders())
    res.end()
  }

  const parsed = parseFileRequest(req.url ?? '')
  if (parsed === null) { refuse(400); return }

  // The credential first, before any path is looked at — an unauthenticated caller must not be able
  // to learn anything, including how long a lookup took.
  if (options.sessions.verifyTicket(parsed.ticket) === null) { refuse(403); return }

  const root = options.rootFor(parsed.rootId)
  if (root === null) { refuse(404); return }

  /**
   * §4's checker and the open, as one operation.
   *
   * `openForReading` lives in Core because `src/server` may not import `node:fs` — and the rule is
   * doing real work rather than keeping a diagram tidy. With the open in Core, the containment
   * check is not something this route has to remember to call; there is no way to obtain the stream
   * without it having run.
   */
  const opened = await openForReading(root, parsed.segments)
  if (!opened.ok) { refuse(404); return }

  const { size, name: fileName } = opened.value
  if (size > (options.maxBytes ?? MAX_SERVED_BYTES)) { refuse(413); return }

  const decision = servingDecisionFor(fileName, size)

  const range = parseRange(req.headers['range'], size)
  if (range === 'invalid') {
    res.writeHead(416, { ...fileHeaders(), 'content-range': `bytes */${size}` })
    res.end()
    return
  }

  const headers: Record<string, string> = {
    ...fileHeaders(),
    'content-type': decision.contentType,
    'content-disposition': contentDisposition(
      // Only the positively-recognised kinds may be `inline`. Everything else is an attachment,
      // which is the second half of §9's pairing — the type stops it rendering, the disposition
      // stops it being treated as a document if something ever sniffs anyway.
      decision.kind === 'download' ? 'attachment' : 'inline',
      fileName,
    ),
  }

  if (range === null) {
    headers['content-length'] = String(size)
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return }
    await pipe(opened.value.open(), res)
    return
  }

  headers['content-length'] = String(range.end - range.start + 1)
  headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`
  res.writeHead(206, headers)
  if (req.method === 'HEAD') { res.end(); return }
  await pipe(opened.value.open(range), res)
}

/**
 * Streams the file to the response, and **never leaves a descriptor open on failure**.
 *
 * A read error mid-body cannot become a status — the head is already sent — so the connection is
 * destroyed rather than ended. A truncated body that arrives as a clean `200` is a corrupted file
 * the client believes it received in full, which on an endpoint whose whole subject is bytes is the
 * worst available outcome.
 */
function pipe(source: NodeJS.ReadableStream, res: ServerResponse): Promise<void> {
  return new Promise(resolve => {
    source.on('error', () => {
      res.destroy()
      resolve()
    })
    res.on('close', () => {
      // The client went away mid-download. Without this the read stream keeps going and the
      // descriptor is held until it finishes.
      if ('destroy' in source && typeof source.destroy === 'function') source.destroy()
      resolve()
    })
    source.pipe(res)
    res.on('finish', () => { resolve() })
  })
}
