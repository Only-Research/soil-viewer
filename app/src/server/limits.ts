/**
 * The numeric limits. Spec §6, F8.1–F8.6.
 *
 * Collected in one file because a limit that lives at its use site drifts from the spec silently,
 * and because the relationship between two of them is load-bearing and needs to be visible.
 */

import { MAX_EDITABLE_BYTES } from '../core/fs/document'

/**
 * Spec §6 and §12. The largest file the editor will open.
 *
 * **Defined in Core and re-exported here, deliberately.** It moved when P4 built the load path: §6
 * makes it a rule about documents rather than about transport, and Core's write gate is where it is
 * enforced. Core cannot import from an adapter, so leaving a copy here would have created a second
 * number free to drift from the one that actually decides whether a file is editable. Re-exported
 * rather than deleted so `MAX_WRITE_BODY_BYTES` below stays derived and no import site changed.
 */
export { MAX_EDITABLE_BYTES }

/**
 * The body limit for the editable-write route.
 *
 * Spec §6: "**`MAX_EDITABLE_BYTES = 2 MiB`**, and the API body limit is **`MAX_EDITABLE_BYTES +
 * 64 KiB`** and MUST NOT be lower — otherwise a save is rejected for size *after* the edit was
 * accepted (FT-3)."
 *
 * That is the whole reason for the headroom, and it is a data-loss rule rather than a sizing one:
 * the editor accepts an edit up to `MAX_EDITABLE_BYTES`, and the request carrying it is larger than
 * the content by the JSON envelope. If the body cap equalled the content cap, a file at the limit
 * would be editable but unsavable — the user's work accepted by the screen and refused by the
 * server. Derived rather than written as a number so the two cannot drift.
 *
 * **Twice the content, not the content plus 64 KiB — the spec's figure is a floor.** Found
 * 2026-09-02. The content travels as a JSON string, and JSON escapes a newline, a quote, a
 * backslash, a tab and a carriage return to two bytes each. Sixty-four kilobytes of headroom
 * therefore covered a document at the cap only when its lines averaged 32 bytes or longer; a 2 MiB
 * list of short lines — an ordinary markdown file — was **editable and unsavable**. The third
 * instance of one defect in a week, each a pair of gates measuring the same document in different
 * units: `body.ts` on U+FFFD, `dom.ts` on UTF-16 units against a byte cap, and this. The 64 KiB
 * stays on top, for the envelope's other fields; the spec's "MUST NOT be lower" permits the rest.
 *
 * **The residual, stated:** control characters other than those five escape to six bytes. A
 * document at the cap that is more than about a fifth raw control characters still exceeds this —
 * and is not text by any reading; `editabilityRefusal` admits it only because FT-2 names NUL alone.
 * Covering it would mean a 12 MiB body held per connection, 256 connections deep. The boundary is
 * pinned in `body.test.ts`, so moving it is a decision rather than a drift.
 */
export const MAX_WRITE_BODY_BYTES = MAX_EDITABLE_BYTES * 2 + 64 * 1024

/** Spec §6: body 1 MB for every route except the editable-write one above. */
export const MAX_BODY_BYTES = 1024 * 1024

/**
 * The routes that carry a document body, and therefore the larger cap.
 *
 * **THIS SET EXISTS BECAUSE `MAX_WRITE_BODY_BYTES` WAS USED NOWHERE.** Found 2026-08-09 by the
 * end-to-end chain test, on its first complete run: `zz-hazards/content-edges/just-under-the-cap.md`
 * loaded fine — it is under `MAX_EDITABLE_BYTES` — and its save came back `PAYLOAD_TOO_LARGE`,
 * because the listener read **every** body at `MAX_BODY_BYTES`, 1 MB.
 *
 * So every file between 1 MB and 2 MiB was **editable and unsavable**: exactly FT-3, the failure the
 * constant above was written to prevent, with its own comment describing the rule it was not
 * enforcing.
 *
 * The reason no test caught it is worth more than the fix. `body.test.ts` asserts
 * `MAX_WRITE_BODY_BYTES > MAX_EDITABLE_BYTES`, that the headroom was (then) exactly 64 KiB, and that
 * `readJsonBody` honours the value when handed it directly. **Every one of those passes with the
 * constant wired to nothing.** They prove the number is well-formed; none of them proves the server
 * uses it. A control correct in isolation and never reached — this build's signature shape, in a
 * data-loss rule the spec calls out by name.
 *
 * A named set rather than a check on the route's input shape: it is greppable, and a route that
 * starts carrying a document must be added here deliberately rather than qualifying by accident.
 */
export const DOCUMENT_BODY_ROUTES: ReadonlySet<string> = new Set(['file.save'])

/** The body cap for a route. The only place either constant should be read from. */
export function bodyCapFor(route: string): number {
  return DOCUMENT_BODY_ROUTES.has(route) ? MAX_WRITE_BODY_BYTES : MAX_BODY_BYTES
}

/** Spec §6: headers 16 KB, URL 2 KB. */
export const MAX_HEADER_BYTES = 16 * 1024
export const MAX_URL_BYTES = 2 * 1024

/** Spec §6, F8.1–F8.3. Node's own socket timeouts. */
export const HEADERS_TIMEOUT_MS = 10_000
export const REQUEST_TIMEOUT_MS = 30_000
export const KEEP_ALIVE_TIMEOUT_MS = 5_000

/**
 * Concurrent connections. **GLOBAL, and there is no per-source cap** — the security review's K4.
 *
 * Spec §6 asked for "256 connections, 64 per address", and the per-address half was implemented on
 * `socket.remoteAddress`. **Both listeners bind `127.0.0.1`** (`main.ts`), and `tailscale serve`
 * opens a fresh loopback connection per client anyway, so that map held exactly one key: the
 * effective cap was **64 global**, and `MAX_CONNECTIONS = 256` was unreachable by construction —
 * the 65th connection was destroyed before Node's own limit could ever apply.
 *
 * That is the second constant in this build to be dead by construction, after `MAX_STREAMS_TOTAL`
 * sitting behind a per-address cap of four. Both had the same cause and neither was visible from
 * reading the constant.
 *
 * A per-source connection cap is **undeliverable** on a loopback-bound listener behind a terminating
 * proxy: at `'connection'` time no HTTP exists, so there is no identity to read and none will arrive
 * before the socket is already counted. So it is deleted rather than renamed, and `server.maxConnections`
 * carries the global cap natively — no map, no key, nothing unbounded to reason about.
 *
 * **Forward condition:** if either listener ever binds a non-loopback address, a per-source cap
 * becomes meaningful again and the question returns to the security review.
 */
export const MAX_CONNECTIONS = 256

/**
 * The request rate limiter. **GLOBAL — one bucket for every client**, and named so.
 *
 * It is keyed on `socket.remoteAddress`, which behind `tailscale serve` is `127.0.0.1` for every
 * device. That is not a defect to be fixed by re-keying: the limiter runs **ahead of the whole guard
 * chain**, deliberately, so a flood is throttled before it can generate `fsync`-per-refusal log
 * records. At that point nothing has been validated, so there is no trustworthy identity to key on —
 * and keying on one the caller supplies would let any local process mint unlimited buckets and turn
 * the limiter off with a counter. Spec §7 already refused that: *"Trusting `X-Forwarded-For` instead
 * is also wrong — anything reaching the loopback port forges it."*
 *
 * So it is global, and the honest response is to size it for what it actually covers.
 *
 * THE DERIVATION, from a measurement rather than a guess (the security review's K2):
 *
 *   - **6 requests per cold page load.** Measured in WebKit against the real server: the shell, the
 *     manifest, the module, the stylesheet, `POST /api/session.start`, and the stream handshake.
 *     (Chromium issues 5 — it does not fetch the manifest eagerly. Safari is the target, so 6.)
 *   - **× 4 concurrent loads.** The user's tailnet is three devices, plus a duplicate tab.
 *   - **× 2**, because a reload while another device is still loading is ordinary behaviour.
 *   = **48**, rounded up to **120** for the API calls the P7 screens will issue in parallel.
 *
 * The old value was **20 for both**, which is three cold loads. It was set before this server
 * carried static assets *or* a session route, and it silently became too small when they arrived.
 * It cost three separate debugging sessions wearing three different disguises — *"the background is
 * transparent"*, *"the app did not mount"*, *"the deep link 404s"* — none of which look like a rate
 * limit. **A refused asset is not a retried asset:** a stylesheet answered 429 is a broken page with
 * no recovery path, unlike an API call, which backs off.
 *
 * The sustained rate bounds the `fsync` rate on the refusal path, which is the property that made
 * the limiter's position in the chain safe. 50/s is eight cold loads per second — far above anything a
 * person produces, and far below what a disk minds. It divides 1000ms evenly, so the refill lands
 * on whole milliseconds rather than a repeating fraction the integer token math has to round.
 */
export const RATE_LIMIT_GLOBAL_PER_SECOND = 50
export const RATE_LIMIT_GLOBAL_BURST = 120

/**
 * The size cap on each append-only log. **The app never rotates or deletes a log.** At the cap, the
 * write that would cross it is refused as `LOG_FULL`, and — spec §7, "a failed log write fails the
 * operation" — the request fails with it. The operator moves the file aside and restarts.
 *
 * Found 2026-09-02 by the security reviewer. `session.start` carries no token, so anything on the
 * tailnet can drive the mutation log at the limiter's ceiling without ever authenticating: 50
 * records a second at roughly 250 bytes each is about a gigabyte a day, indefinitely. The limiter
 * above bounds the *rate* — it was sized for `fsync` pressure, and says so — and nothing bounded
 * the *total*. A full volume takes down more than this app; a full log takes down this app, with
 * the reason in the local log and the fix a rename.
 *
 * Why refuse rather than rotate: the mutation log is §7's compensating control for device trust —
 * the trail that makes an incident detectable at all. Rotation that drops the oldest generation is
 * the standard tool and the wrong one here, because a flood would then push the records from
 * before it off the end, which is the one thing a flood is for. A cap keeps every record ever
 * written and bounds the disk; the price is that a sustained flood eventually stops the app rather
 * than the trail. At ordinary use — a few thousand requests a day — a gigabyte is several years.
 */
export const MAX_LOG_BYTES = 1024 * 1024 * 1024

/**
 * **Lives here rather than in `main.ts`, and that is not filing — it is a real hazard avoided.**
 *
 * It was written in `main.ts` first. `main.ts` ends with `void main()` at module scope, so a test
 * importing it for this one function **starts a server**: it tried to load `dist` from the wrong
 * working directory, printed a startup failure into an otherwise green unit run, and would have
 * **bound the live ports** if that path had happened to resolve. A helper belongs in a module that
 * does nothing when imported.
 *
 * Reads the two test-only rate-limit variables. **Both or neither**, and any malformed value is a
 * refusal to start rather than a fallback — see the call site.
 */
type RateLimitRead =
  | { readonly ok: true; readonly value: { ratePerSecond: number; burst: number } | null }
  | { readonly ok: false; readonly detail: string }

export function readRateLimitOverride(env: NodeJS.ProcessEnv): RateLimitRead {
  const rate = env['SOIL_RATE_PER_SECOND']
  const burst = env['SOIL_RATE_BURST']
  if (rate === undefined && burst === undefined) return { ok: true, value: null }
  if (rate === undefined || burst === undefined) {
    return {
      ok: false,
      detail: 'SOIL_RATE_PER_SECOND and SOIL_RATE_BURST must be set together, or neither',
    }
  }
  const usable = (raw: string): number | null => {
    if (!/^[0-9]+$/.test(raw)) return null
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  const ratePerSecond = usable(rate)
  const burstValue = usable(burst)
  if (ratePerSecond === null || burstValue === null) {
    return { ok: false, detail: 'SOIL_RATE_PER_SECOND and SOIL_RATE_BURST must be positive integers' }
  }
  return { ok: true, value: { ratePerSecond, burst: burstValue } }
}

