/**
 * Dispatch. The half of spec §6's chokepoint that runs at request time.
 *
 * The property this file exists to deliver: **a handler is only reachable through validation, and
 * a privileged handler is only reachable from the privileged listener.** Both are structural.
 *
 *   - `handlers` is typed as a total map over `RouteName`, so a missing handler is a compile error
 *     and a handler for an undeclared route is a compile error.
 *   - `dispatch` validates before calling, with no branch that skips it.
 *   - `createRouter('tailnet')` **does not register privileged handlers at all**. Spec §7: "Those
 *     handlers are **not registered on its router at all**, so forgetting a check is not
 *     expressible." A router that refused them at call time would be a check that could be
 *     removed; a router that never had them cannot be.
 *
 * The last point is the one v1 got wrong in the most instructive way. It gated privileged verbs on
 * the source address being loopback — and `tailscale serve` terminates TLS and opens a *fresh
 * loopback connection*, so every phone request passed. The gate was not weak; it was inverted. The
 * lesson written into §7 is that **privilege is decided by which listener accepted the connection,
 * never by an address and never by a header** — "headers can demote a request to remote; they can
 * never promote one to local."
 */

import { ErrorCode, refusalCodeOf } from '../core/errors'
import { ROUTES, routeNamesFor, type RouteName, type RoutePrivilege } from './routes'
import { TransportErrorCode, type WireError, type WireResponse } from './wire'
import type { ValidationFailure } from './validate'

/** What a handler receives: the validated input, and nothing else from the request. */
export type Handler = (input: never) => Promise<unknown> | unknown

export type Handlers = { readonly [K in RouteName]: Handler }

/**
 * Fixed messages, chosen here rather than built from the failure.
 *
 * Spec §6: errors carry "no stack traces, no absolute paths outside a root, no verbatim client
 * strings. Full detail goes to the local log." A message assembled from a caught exception is
 * exactly how a path escapes, so the wire message is a constant and the detail stays server-side.
 */
const MESSAGES: Record<string, string> = {
  [TransportErrorCode.BAD_REQUEST]: 'The request was not in the expected shape.',
  [TransportErrorCode.UNKNOWN_FIELD]: 'The request contained a field this route does not accept.',
  [TransportErrorCode.PAYLOAD_TOO_LARGE]: 'The request was too large.',
  [TransportErrorCode.METHOD_NOT_ALLOWED]: 'That method is not allowed on this route.',
  [TransportErrorCode.NOT_FOUND]: 'No such route.',
  [TransportErrorCode.NOT_PRIVILEGED]: 'That operation is not available on this connection.',
  [TransportErrorCode.INTERNAL]: 'The operation could not be completed.',
}

/**
 * The same table for Core's refusal codes.
 *
 * **Constants, and deliberately not built from the refusal's own `detail`.** The detail routinely
 * contains an absolute path — §6 bars those from the wire and puts them in the local log, which is
 * where `DispatchOutcome.thrown` carries them. So the client learns *which* refusal happened from
 * the code, and gets a sentence chosen here.
 *
 * Codes absent from this table still reach the client as themselves; only the sentence falls back.
 * That is the right default: a new Core code should degrade to a vague message, never to a wrong
 * one, and never back to `INTERNAL` — the whole defect this table was added to fix.
 */
const REFUSAL_MESSAGES: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.INVALID_ROOT]: 'That folder cannot be used.',
  // Named without naming a path: §6 bars absolute paths from the wire, and "which folder it
  // overlaps" is exactly the sentence that would carry one.
  [ErrorCode.ROOT_ALREADY_REGISTERED]: 'That folder is already added.',
  [ErrorCode.ROOT_OVERLAPS]: 'That folder contains, or sits inside, one you have already added.',
  [ErrorCode.NOT_MARKDOWN]: 'This app only opens and writes .md files.',
  // Deliberately phrased as a property of the file rather than a fault. §12 makes this a state the
  // non-editing pane renders with a reason, so the sentence has to read as an explanation.
  [ErrorCode.NOT_EDITABLE]: 'This file is not editable text, so the editor will not open it.',
  [ErrorCode.EDITABILITY_BOUNDARY]:
    'A file cannot be renamed into or out of being a markdown document.',
  [ErrorCode.CONFLICT_DETECTED]: 'The file changed on disk since you opened it.',
  [ErrorCode.TRUNCATION_BLOCKED]: 'That save would remove most of the file. Confirm to continue.',
  [ErrorCode.STALE_TARGET]: 'That has changed since this view was loaded. Reload and try again.',
  [ErrorCode.TOO_LARGE]: 'That file is too large to open in the editor.',
  [ErrorCode.PERMISSION_DENIED]: 'The file could not be read or written — check its permissions.',
  [ErrorCode.FILE_IMMUTABLE]: 'That file is locked. Unlock it before saving.',
  [ErrorCode.DISK_FULL]: 'There is no room left to save. Your edit has been kept.',
  [ErrorCode.LOG_FULL]: 'The activity log is full. It must be moved aside before the app can continue.',
  [ErrorCode.PARENT_MISSING]: 'The folder that should contain this no longer exists.',
  [ErrorCode.IDENTITY_CHANGED]: 'A different file is now at that path.',
  [ErrorCode.CHANGED_DURING_READ]: 'The file was being rewritten while it was read. Try again.',
  [ErrorCode.NAME_TAKEN]: 'Something already exists with that name.',
  [ErrorCode.NAME_EMPTY]:
    'That name has no letters or numbers in it, so it cannot become a filename.',
  [ErrorCode.NAME_TOO_LONG]: 'That name is too long for the filesystem.',
  [ErrorCode.HARDLINKED]: 'That file has more than one name, so it cannot be written safely.',
  [ErrorCode.NOT_REGULAR_FILE]: 'That is not an ordinary file.',
  [ErrorCode.PATH_SYMLINK]: 'That path goes through a link, which this app does not follow.',
  [ErrorCode.PATH_ESCAPES_ROOT]: 'That path is outside the folder it claims to be in.',

  /**
   * THE REST, added at Phase 4's gate — because "falls back to a vague message" turned out to mean
   * *falls back to the exact sentence this table was created to eliminate.*
   *
   * The comment above says an absent code "should degrade to a vague message, never back to
   * `INTERNAL`". It degrades to `MESSAGES[INTERNAL]` — "The operation could not be completed" — the
   * one useless sentence the 2026-08-08 flattening defect was about. The table said the right thing
   * and the fallback did the other thing, which is this build's most familiar shape.
   *
   * Nine codes were unmapped, one of them reachable from `board.ts`, and none of them failed
   * anything. There is now a test that turns red when a code has no sentence of its own, so the
   * fallback stops being load-bearing.
   */
  [ErrorCode.PATH_EMPTY]: 'No file or folder was named.',
  [ErrorCode.PATH_NUL]: 'That name contains a character a filename cannot hold.',
  [ErrorCode.PATH_ENCODING]: 'That name is not valid text.',
  [ErrorCode.PATH_MALFORMED_ESCAPE]: 'That path is not correctly encoded.',
  [ErrorCode.PATH_NOT_RELATIVE]: 'Paths are relative to a registered folder.',
  [ErrorCode.PATH_TRAVERSAL]: 'That path tries to leave the folder it is in.',
  // The three genuine machine failures. Specific enough to distinguish from a refusal, and
  // deliberately not detailed — §6 keeps the request's own strings off the wire.
  [ErrorCode.IO_FAILED]: 'The filesystem reported an error. Nothing was changed.',
  [ErrorCode.SHORT_READ]: 'The file could not be read completely, so it was not opened.',
  [ErrorCode.WRITE_SIZE_MISMATCH]: 'The write did not land completely, so it was abandoned.',
}

/**
 * HTTP status per refusal code. Anything unlisted is 400 — a refusal is the server declining, not
 * the server failing, and reporting it as 5xx is what made these look like crashes.
 */
const REFUSAL_STATUS: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.CONFLICT_DETECTED]: 409,
  [ErrorCode.TRUNCATION_BLOCKED]: 409,
  // 409, alongside the other "your view and the disk disagree" refusals. The remedy is a reload,
  // which is what a conflict status already means to every HTTP client ever written.
  [ErrorCode.STALE_TARGET]: 409,
  [ErrorCode.NAME_TAKEN]: 409,
  // 409, like NAME_TAKEN: the request is well-formed and the conflict is with existing state.
  [ErrorCode.ROOT_ALREADY_REGISTERED]: 409,
  [ErrorCode.ROOT_OVERLAPS]: 409,
  [ErrorCode.IDENTITY_CHANGED]: 409,
  [ErrorCode.PARENT_MISSING]: 409,
  [ErrorCode.TOO_LARGE]: 413,
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.FILE_IMMUTABLE]: 403,
  // Genuinely the machine's fault rather than the request's.
  [ErrorCode.DISK_FULL]: 507,
  [ErrorCode.LOG_FULL]: 507,
  [ErrorCode.IO_FAILED]: 500,
  [ErrorCode.SHORT_READ]: 500,
  [ErrorCode.WRITE_SIZE_MISMATCH]: 500,
  [ErrorCode.CHANGED_DURING_READ]: 500,
}

const errorFor = (code: TransportErrorCode): WireError => ({
  code,
  message: MESSAGES[code] ?? MESSAGES[TransportErrorCode.INTERNAL] ?? 'Error.',
})

/**
 * What the caller logs. Carries the detail the wire response deliberately omits, so the local log
 * can be specific while the response stays mute.
 */
export interface DispatchOutcome {
  readonly response: WireResponse<unknown>
  readonly status: number
  /** Present only on a validation failure. Never sent to the client. */
  readonly failure?: ValidationFailure
  /**
   * The exception a handler threw, surfaced for the LOCAL log only.
   *
   * The P2 review found this discarded: `catch {}` swallowed it and the comment said "the caller
   * logs it" while the caller had nothing to log — so a 500 in production was unobservable. It is
   * carried here and never serialised into `response`; spec §6 bars stack traces and verbatim
   * strings from the wire, and the shape of this type is what keeps those two facts separate.
   */
  readonly thrown?: unknown
}

const STATUS: Record<string, number> = {
  [TransportErrorCode.BAD_REQUEST]: 400,
  [TransportErrorCode.UNKNOWN_FIELD]: 400,
  [TransportErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [TransportErrorCode.METHOD_NOT_ALLOWED]: 405,
  [TransportErrorCode.NOT_FOUND]: 404,
  [TransportErrorCode.NOT_PRIVILEGED]: 404,
  [TransportErrorCode.INTERNAL]: 500,
}

const refuse = (code: TransportErrorCode, failure?: ValidationFailure): DispatchOutcome => ({
  response: { ok: false, error: errorFor(code) },
  status: STATUS[code] ?? 500,
  ...(failure === undefined ? {} : { failure }),
})

export interface Router {
  readonly privilege: RoutePrivilege
  /** Exactly the routes this listener carries. Privileged names are absent, not disabled. */
  readonly names: ReadonlySet<string>
  readonly dispatch: (name: string, method: string, body: unknown) => Promise<DispatchOutcome>
}

export function createRouter(privilege: RoutePrivilege, handlers: Handlers): Router {
  // Built once, from the table. The tailnet router's map does not contain the privileged handlers,
  // so there is no key to reach them by and no check that could be deleted.
  const available = new Map<string, { definition: (typeof ROUTES)[RouteName]; handler: Handler }>()
  for (const name of routeNamesFor(privilege)) {
    available.set(name, { definition: ROUTES[name], handler: handlers[name] })
  }

  const dispatch = async (
    name: string,
    method: string,
    body: unknown,
  ): Promise<DispatchOutcome> => {
    const entry = available.get(name)
    if (entry === undefined) {
      // A privileged route reached from the tailnet listener is NOT_FOUND, not FORBIDDEN. A
      // distinct refusal would confirm the route exists, which tells an unauthenticated caller
      // where to aim. It is also honest: from this router's point of view the route does not exist.
      return refuse(TransportErrorCode.NOT_FOUND)
    }

    if (method !== entry.definition.method) {
      return refuse(TransportErrorCode.METHOD_NOT_ALLOWED)
    }

    // The single validation point. There is no branch around it.
    const validated = entry.definition.input(body, '$')
    if (!validated.ok) return refuse(validated.failure.code, validated.failure)

    try {
      const data = await (entry.handler as (input: unknown) => Promise<unknown>)(validated.value)
      return { response: { ok: true, data }, status: 200 }
    } catch (thrown) {
      /**
       * A **deliberate** refusal keeps its code; anything else is a crash and stays `INTERNAL`.
       *
       * The distinction is a brand on the thrown value, not its message or its class name, so
       * nothing a handler happens to throw can promote itself into a typed refusal. The thrown
       * value still goes to the caller intact for the local log — the code crosses the wire, the
       * detail does not.
       */
      const refusal = refusalCodeOf(thrown)
      if (refusal !== null) {
        return {
          response: {
            ok: false,
            error: {
              code: refusal,
              message: REFUSAL_MESSAGES[refusal] ?? MESSAGES[TransportErrorCode.INTERNAL] ?? 'Error.',
            },
          },
          status: REFUSAL_STATUS[refusal] ?? 400,
          thrown,
        }
      }
      // Not inspected further HERE — inspecting an unknown exception in the response path is how
      // its message ends up on the wire. Handed to the caller intact so the local log has all of it.
      return { ...refuse(TransportErrorCode.INTERNAL), thrown }
    }
  }

  return { privilege, names: new Set(available.keys()), dispatch }
}
