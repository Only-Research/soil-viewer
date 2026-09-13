/**
 * The client's credentials, and the only place that holds them.
 *
 * The server mints two values and hands them over together from `POST /api/session.start`:
 *
 *   - **the token**, which goes in the `x-soil-token` header and nowhere else. Its entire CSRF
 *     property is that a custom header cannot be set cross-origin.
 *   - **the ticket**, which goes in the live-stream URL's query string and nowhere else, because
 *     `EventSource` cannot set a custom header.
 *
 * **THEY MUST NOT CROSS, and this module is where that is enforced structurally** — the security review's B7.
 * `call()` can reach the token and cannot reach the ticket; `streamUrl()` can reach the ticket and
 * cannot reach the token. Neither is returned to a caller, neither is stored, and the session object
 * is never stringified anywhere. A token that reached a URL would void the property it exists for.
 *
 * **NOTHING IS PERSISTED.** Not `localStorage`, not `sessionStorage`, not IndexedDB. The security review's
 * requirement 2: neither value may outlive the process that minted it. The failure that rule
 * prevents is specific to the operator's setup — an installed iOS web app is **resumed, never
 * relaunched**, so a credential cached on the phone survives a Mac restart, is refused by the new
 * server forever, and nothing ever reloads the page to fix it. Held in a closure, gone on reload.
 */

/** The one route that issues credentials. */
/**
 * Where every route lives. **Built here, once, rather than at each call site.**
 *
 * `call()` took a full PATH while being named `route`, and its only caller inside this module
 * hardcoded `/api/session.start`. P7's first real caller passed a route name — `folders.list`,
 * which is what the route table calls it — and the request went to `/folders.list`, got a 404, and
 * the Files tab rendered "No folders registered yet." over a folder that was registered.
 *
 * That took three wrong guesses and a browser to find, because every layer answered honestly: the
 * server had the folder, the client asked the wrong URL, and a 404 on an unknown path is the same
 * 404 as a missing file. **The API's shape was the defect** — a parameter named `route` that
 * silently accepts a path, in a client that shipped with no callers to notice.
 */
const API_PREFIX = '/api/'

const SESSION_ROUTE = `${API_PREFIX}session.start`

/** §9's byte endpoint. Kept beside the stream path, which shares its ticket-in-the-URL shape. */
const FILE_PATH = '/file'
/** Where the live stream lives, and the parameter the ticket rides in. */
const STREAM_PATH = '/events'
const TICKET_PARAM = 'ticket'

export const TOKEN_HEADER = 'x-soil-token'

export interface HttpReply {
  readonly status: number
  readonly body: unknown
}

/** The one browser capability this module needs, injected so tests need no network. */
export type PostJson = (
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
) => Promise<HttpReply>

export type CallResult =
  | { readonly ok: true; readonly data: unknown }
  | {
    readonly ok: false
    readonly status: number
    /** For the console and for developers. Not a sentence to show a person. */
    readonly reason: string
    /**
     * The server's own code and message, when the failure came back as a §6 envelope.
     *
     * **Absent until 2026-08-09, and that is the sixth control this phase with no consumer.** §6
     * specifies that a refusal carries *"stable machine codes"* and a message *"chosen from a table
     * on the server"* — the whole apparatus exists so the client can say something true. The client
     * discarded both and substituted `'the server refused the request'` for every refusal, so the
     * table had no reader and no failure could be distinguished from any other.
     *
     * Found by Settings → Folders, where three different registration refusals have to produce
     * three different sentences. Nothing else had ever needed to tell two failures apart.
     *
     * `undefined` when there was no envelope to read — a transport failure, or a body that was not
     * an object. A caller that shows this must therefore have a fallback, and must not treat its
     * absence as success.
     */
    readonly error?: { readonly code: string; readonly message: string }
  }

/**
 * A request that cannot reach the server at all, as a **value**.
 *
 * `call()` promised a `CallResult` and could **reject**: `post` throws on a transport failure and
 * only `fetchSession` wrapped it. So a caller reading `if (!result.ok)` — which is what the type
 * invites — got an unhandled rejection instead whenever the network was the problem.
 *
 * Surfaced by WebKit reporting `TypeError: Load failed` when a page reload cancelled a request in
 * flight. **The reload is incidental; the case that matters is the Mac asleep and the phone
 * mid-request**, which is §15's normal case, not an edge one.
 *
 * Third defect in this module found by its first real caller, after the envelope and the path. The
 * common cause is not carelessness — it is that a client shipped with no consumers has no way to
 * discover that its contract is wrong, because a contract is only wrong relative to someone
 * relying on it.
 */
async function attempt(
  send: () => Promise<HttpReply>,
): Promise<HttpReply | { readonly failed: true }> {
  try {
    return await send()
  } catch {
    return { failed: true }
  }
}

/**
 * Unwraps §6's envelope, so `CallResult.data` is the **payload** and not the wrapper.
 *
 * **This existed as a defect until P7's first real caller.** `call()` returned `data: first.body`,
 * and `first.body` is the whole `{ ok, data }` envelope — so the field named `data` held a thing
 * with a `data` inside it, and every caller would have had to write `result.data.data`. P3 built
 * this client and shipped it with **no consumer at all**; the Files tab is the first, and the shape
 * was wrong the moment it was read.
 *
 * The same shape as `document-session.ts` at P6's gate: a module with tests, a mutation sweep, and
 * nobody calling it. A test can assert what a function returns; only a caller notices that what it
 * returns is awkward to use.
 *
 * **A 200 carrying `ok: false` is a failure, not a success.** The status and the envelope can
 * disagree — §6 puts the verdict in the body — and treating the status as the answer would hand a
 * caller an error object typed as its payload.
 */
/**
 * §6's `{ code, message }`, read defensively, as a spreadable fragment.
 *
 * **Defensively rather than by cast**, because this is the one place a *refused* body is
 * interpreted: a malformed error object that threw here would surface as an exception from inside
 * error handling, and the caller would report that the server could not be reached when the server
 * had in fact answered.
 *
 * Returns `{}` rather than `{ error: undefined }` — the field is optional under
 * `exactOptionalPropertyTypes`, and a present-but-undefined property is a different type from an
 * absent one.
 */
function wireErrorOf(body: unknown): { error?: { code: string; message: string } } {
  if (typeof body !== 'object' || body === null) return {}
  const raw = (body as { error?: unknown }).error
  if (typeof raw !== 'object' || raw === null) return {}
  const wire = raw as { code?: unknown; message?: unknown }
  if (typeof wire.code !== 'string' || typeof wire.message !== 'string') return {}
  return { error: { code: wire.code, message: wire.message } }
}

function payloadOf(body: unknown, status: number): CallResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status, reason: 'the reply was not an object' }
  }
  const envelope = body as { ok?: unknown; data?: unknown; error?: unknown }
  if (envelope.ok !== true) {
    return { ok: false, status, reason: 'the server refused the request', ...wireErrorOf(body) }
  }
  return { ok: true, data: envelope.data }
}

export interface SessionClient {
  /** Calls a route with the token attached. Recovers from a stale session once — see below. */
  readonly call: (route: string, body?: unknown) => Promise<CallResult>
  /**
   * The live-stream URL, with a **freshly obtained** ticket. The security review's C6.
   *
   * Awaited on every connect the client itself initiates — `start`, `onVisible`, and each backoff
   * retry — because `EventSource` reconnects on its own with no opportunity to change the URL, and
   * `onerror` fires identically for "server down" and "403, bad ticket" with no status exposed. So
   * a client that minted its ticket once and kept it would, after a Mac restart, reconnect forever
   * against a dead ticket on a phone that never relaunches.
   */
  readonly streamUrl: () => Promise<string>
  /**
   * The §9 byte endpoint's URL for one file, for an `<img src>` or a sandboxed `<iframe src>`.
   *
   * Returns `null` before a session exists. A caller must render its own placeholder rather than
   * an `<img>` with an empty `src`, which browsers resolve against the current page and request.
   */
  readonly fileUrl: (rootId: string, segments: readonly string[]) => string | null

  /** Forgets the current session. The next call or connect obtains a new one. */
  readonly reset: () => void
}

interface Credentials {
  readonly token: string
  readonly streamTicket: string
}

function credentialsFrom(body: unknown): Credentials | null {
  // Read defensively and narrowly: this is the one response whose shape the whole client depends on,
  // and a server that answered `{ok:true, data:{}}` would otherwise produce `undefined` tokens that
  // fail much later and much less legibly.
  if (typeof body !== 'object' || body === null) return null
  const wrapper = body as { ok?: unknown; data?: unknown }
  if (wrapper.ok !== true || typeof wrapper.data !== 'object' || wrapper.data === null) return null
  const data = wrapper.data as { token?: unknown; streamTicket?: unknown }
  if (typeof data.token !== 'string' || typeof data.streamTicket !== 'string') return null
  if (data.token === '' || data.streamTicket === '') return null
  return { token: data.token, streamTicket: data.streamTicket }
}

export function createSessionClient(post: PostJson): SessionClient {
  let credentials: Credentials | null = null
  /** In flight, so five simultaneous calls do not mint five sessions. */
  let pending: Promise<Credentials | null> | null = null

  /**
   * Asks the server for a session. **Always hits the route** — no cache, no dedup.
   *
   * Separated from `obtain` so the two callers can differ where the condition requires them to:
   * `call()` wants the cached credentials (an API request per page load should not mint a session),
   * and `streamUrl()` must not (C6 — a connect attempt carrying a stale ticket cannot recover).
   */
  const fetchSession = async (): Promise<Credentials | null> => {
    try {
      // No token on this one. It is the route that issues the token, so it cannot require it —
      // reaching the listener is the authorization, which is the operator's recorded tailnet-trust
      // decision rather than a property of this request.
      const reply = await post(SESSION_ROUTE, {}, {})
      return reply.status === 200 ? credentialsFrom(reply.body) : null
    } catch {
      return null
    }
  }

  /** The cached session, fetched once. Used by `call()`; deliberately NOT by `streamUrl()`. */
  const obtain = async (): Promise<Credentials | null> => {
    if (credentials !== null) return credentials
    if (pending !== null) return pending

    pending = fetchSession().finally(() => { pending = null })
    credentials = await pending
    return credentials
  }

  return {
    /** `route` is a name from the route table — `folders.list`, not `/api/folders.list`. */
    call: async (route: string, body: unknown = {}): Promise<CallResult> => {
      const path = `${API_PREFIX}${route}`
      const held = await obtain()
      if (held === null) return { ok: false, status: 0, reason: 'no session' }

      // The token, in the header, and this is the only expression in the module that reads it.
      const first = await attempt(() => post(path, body, { [TOKEN_HEADER]: held.token }))
      if ('failed' in first) {
        return { ok: false, status: 0, reason: 'the server could not be reached' }
      }
      if (first.status === 200) return payloadOf(first.body, first.status)

      /**
       * B6 — RECOVERY IS BOUNDED AND STATUS-AWARE, and the 429 exclusion is the load-bearing half.
       *
       * **403 only.** A 403 means the credential is stale — the server restarted and minted new
       * values — so one refetch and one retry is the correct recovery, and it needs no page reload.
       *
       * **Never on 429.** The rate limiter is keyed on an address that `tailscale serve` collapses
       * to `127.0.0.1`, so its bucket is *shared across every device*. A client that treated any
       * failure as "session is stale, refetch" would hammer this route while throttled and deepen
       * the throttle for every other device — a self-amplifying loop built out of a recovery path.
       *
       * **At most once.** `retried` is not a counter to tune; a second attempt after a second 403
       * means the server is refusing a credential it just issued, and repeating cannot fix that.
       */
      if (first.status !== 403) {
        /**
         * **The envelope is read here too, and it was not until 2026-08-09.**
         *
         * This branch returned a bare `'request failed'`, so every refusal that arrived with a
         * status other than 200 — which is *most* of them; §6's table maps 404, 409, 413, 403, 507
         * — lost the server's code and message before any caller saw it. `payloadOf` was reading
         * the envelope correctly the whole time and only ran on a 200.
         *
         * Found the moment registration needed 409 to say which of three things went wrong. Not
         * `payloadOf` itself, because a non-200 carrying `ok: true` is still a failure and
         * `payloadOf` would report it as a success.
         */
        return {
          ok: false,
          status: first.status,
          reason: 'request failed',
          ...wireErrorOf(first.body),
        }
      }

      credentials = null
      const renewed = await obtain()
      if (renewed === null) return { ok: false, status: 403, reason: 'could not renew session' }

      const second = await attempt(() => post(path, body, { [TOKEN_HEADER]: renewed.token }))
      if ('failed' in second) {
        return { ok: false, status: 0, reason: 'the server could not be reached' }
      }
      if (second.status === 200) return payloadOf(second.body, second.status)
      return { ok: false, status: second.status, reason: 'request failed after renewing' }
    },

    streamUrl: async (): Promise<string> => {
      /**
       * A **FRESH** session on every call, never the cached one — the security review's C6.
       *
       * This called `obtain()`, which returns the cached credentials when it has them. The async
       * supplier the condition asked for was built and the property it was built to deliver was not:
       * the client took one ticket per page load and had no path that could ever replace it, because
       * the only two things that clear the cache — the 403 branch in `call()` and `reset()` — are
       * invoked by nothing in the client.
       *
       * The failure that produces is the one C6 was written against, and it is not recoverable:
       * the operator restarts the Mac, the server mints new credentials, and the phone's installed web app
       * is **resumed, never relaunched**. `onVisible` tears down and reconnects with the same dead
       * ticket; the server refuses it; `EventSource.onerror` cannot distinguish that from a server
       * being down, so it backs off to 60s and retries forever. The status line reads "Reconnecting…"
       * and nothing but a manual reload breaks the loop — which is the one thing that app never does.
       *
       * So this is unconditional. `createLiveStream` calls it on `start`, on `onVisible`, and on every
       * backoff retry — exactly the three client-initiated connects the condition names — and each
       * one now costs one small POST and yields a ticket the server will actually accept.
       *
       * The token is refreshed alongside it rather than discarded: the same response carries both, so
       * keeping it costs nothing and means a stale token is repaired by a reconnect too.
       */
      const fresh = await fetchSession()
      if (fresh === null) throw new Error('no session')
      credentials = fresh
      const held = fresh
      /**
       * Relative, always — spec §7/F9.3 forbids an absolute URL anywhere in the bundle.
       *
       * `encodeURIComponent` on a value that is already 32 hex characters is not superstition: it
       * is what keeps a malformed or hostile value from becoming a second query parameter if the
       * server's shape ever loosens. The ticket is the only expression here that reads the ticket.
       */
      return `${STREAM_PATH}?${TICKET_PARAM}=${encodeURIComponent(held.streamTicket)}`
    },

    /**
     * The file endpoint's URL. Spec §9.
     *
     * **The CACHED ticket, deliberately, where `streamUrl` insists on a fresh one.** The two look
     * alike and the reasoning is opposite. `streamUrl`'s freshness is C6: `EventSource` reconnects
     * on its own with no chance to change the URL, so a stale ticket there is unrecoverable and
     * silent. An `<img>` has no such trap — a stale ticket is a 403, the image does not appear, and
     * the next render asks again. Minting a session per image would put one POST in front of every
     * picture in a document.
     *
     * The ticket stays valid for as long as the page: it is reclaimed only after a grace period
     * with no open stream, and the client holds an `EventSource` throughout (`session.ts`, K6).
     *
     * Relative, always — §7/F9.3 forbids an absolute URL anywhere in the bundle. One `p` per
     * segment, never a joined path, matching `WireLocation`'s reasoning: a joined path invites
     * concatenation and re-splitting it reintroduces the separator ambiguity P1 removed.
     */
    fileUrl: (rootId: string, segments: readonly string[]): string | null => {
      if (credentials === null) return null
      const parts = [
        `${TICKET_PARAM}=${encodeURIComponent(credentials.streamTicket)}`,
        `root=${encodeURIComponent(rootId)}`,
        ...segments.map(segment => `p=${encodeURIComponent(segment)}`),
      ]
      return `${FILE_PATH}?${parts.join('&')}`
    },

    reset: (): void => { credentials = null },
  }
}
