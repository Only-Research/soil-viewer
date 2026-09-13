/**
 * The wire types. Spec §6: "One shared typed contract; CI fails on drift."
 *
 * THE BIGINT DECISION, made here once and enforced by test.
 *
 * Index rows carry three BigInt fields — `dev`, `ino` and `mtimeNs`. Inode numbers exceed 2^53 and
 * nanosecond mtimes are the basis of the watcher's echo dedup, so BigInt is correct *inside* the
 * engine. But `JSON.stringify` **throws a TypeError on BigInt**, so any handler that serialises an
 * index row directly fails at runtime. P1 pinned that with a test rather than a comment; this is
 * where it gets paid.
 *
 * The brief named two decisions. Both are made, and both are made the conservative way:
 *
 * **1. Identity does not cross the boundary at all.** `dev` and `ino` are an *internal* identity —
 * spec §4's "path strings are not identities" is about how the engine locks a file, not about what
 * a screen needs to draw. The client addresses files by `(rootId, relative path)` and nothing else.
 * So the inode is simply absent from every type below. **Not sending it is stronger than sending it
 * safely**: a field that does not exist cannot be truncated, cannot be logged, and cannot become a
 * handle the client starts depending on.
 *
 * **2. Time crosses as milliseconds, for display only.** `modifiedMs` is a plain number, derived
 * once at the boundary. That is lossy — it discards sub-millisecond precision — and it is lossy on
 * purpose: the precision exists for echo dedup, which is a server-side concern the client must
 * never participate in. Crucially this is NOT load-bearing for safety, because spec §13.4 settles
 * conflict detection on **content hash, not mtime**. If that ever changes, this decision has to be
 * revisited before the hash does — the note is here so the next reader finds it.
 *
 * The net effect: **no value of type BigInt is reachable from any wire type.** That is asserted
 * structurally by a test that walks a real response and refuses BigInt anywhere in it, rather than
 * by review — the same reasoning as the meta-gate, since "we were careful" is what the last four
 * rounds disproved.
 */

import type { ErrorCode } from '../core/errors'

/** A registered folder's stable id. Never a path — spec §6 forbids absolute paths on the API. */
export type RootId = string

/**
 * How the API addresses a file, always. Spec §6: "Path parameters are always
 * `(registered-folder id, relative path)`. The API **never** accepts an absolute path."
 *
 * `segments` rather than a joined string: a joined path invites the client to build one by
 * concatenation, and re-splitting it server-side reintroduces the separator ambiguity the Core
 * spent P1 eliminating. Segments arrive already decomposed and are validated segment-wise.
 */
export interface WireLocation {
  readonly rootId: RootId
  readonly segments: readonly string[]
}

/**
 * What kind of thing a row is. Symlinks are recorded and never followed — spec §4.
 *
 * `'other'` is carried through rather than collapsed. It covers sockets, FIFOs, device files and
 * anything else `lstat` reports that is not a regular file, a directory or a link. The first draft
 * of this type omitted it and the typechecker refused the conversion — which was the right answer:
 * mapping `'other'` onto `'file'` would have told the client a device node was a document it could
 * open, and spec §6's rule that the boundary never launders a failure into a plausible success
 * applies to kinds as much as to results.
 */
export type WireKind = 'file' | 'directory' | 'symlink' | 'other'

/**
 * One row as the client sees it.
 *
 * Deliberately absent: `dev`, `ino` (see the BigInt decision above) and any file content. Spec §5
 * makes the index hold no file bytes, and the contract must not be the place that reintroduces
 * them — a `preview` field here would defeat the budget the indexer was built to respect.
 *
 * *Amended at P7 for §13.8's `token`, and the amendment is consistent with decision 1 above rather
 * than an exception to it. The token is a salted digest of `(dev, ino)`: the client can echo it and
 * do nothing else with it, and no inode reaches the wire. `core/entity-token.ts` carries the full
 * reasoning, including why it covers identity and not content.*
 */
export interface WireEntry {
  readonly rootId: RootId
  readonly segments: readonly string[]
  readonly name: string
  readonly kind: WireKind
  /** First heading, or the filename stem when there is none. Never taken from frontmatter. */
  readonly title: string
  readonly size: number
  /** Milliseconds since epoch, for display only. See the BigInt decision above. */
  readonly modifiedMs: number
  /** The one extension predicate in the codebase lives in Core — spec §6. */
  readonly isMarkdown: boolean
  /**
   * Spec §5: a cloud-sync file that is not materialised is "not available offline" and **never**
   * an empty document. The client must render this state rather than an empty editor.
   */
  readonly contentUnavailable: boolean
  /**
   * §13.8's identity token — what the client must send back with any mutation aimed at this row,
   * so the server can refuse `STALE_TARGET` if the entity was replaced since this row was painted.
   *
   * Opaque by contract. The client stores it, echoes it, and never parses it.
   */
  readonly token: string
}

/**
 * Every response is a typed success or a typed error. Spec §6: "**An empty-but-successful result
 * never stands in for a failure.** An empty list means the directory was empty, never that reading
 * it failed. No catch block converts failure to empty success."
 *
 * Modelled as a discriminated union so that is structural rather than conventional: a handler
 * cannot return data without saying `ok: true`, and cannot claim `ok: true` without data.
 */
export type WireResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: WireError }

/**
 * Spec §6 on errors: "stable machine codes; no stack traces, no absolute paths outside a root, no
 * verbatim client strings. Full detail goes to the local log. **The client renders errors as text,
 * never as markdown.**"
 *
 * `message` is a fixed, human-readable string chosen from a table on the server — never a caught
 * exception's `.message`, which is how paths and stack fragments escape.
 */
export interface WireError {
  readonly code: ErrorCode | TransportErrorCode
  readonly message: string
}

/**
 * Transport-level failures, disjoint from Core's `ErrorCode` so neither list has to know about the
 * other. Kept as a union of string literals for the same reason Core's is: a typo is a type error.
 */
export const TransportErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FORBIDDEN_ORIGIN: 'FORBIDDEN_ORIGIN',
  BAD_HOST: 'BAD_HOST',
  MISSING_TOKEN: 'MISSING_TOKEN',
  NOT_PRIVILEGED: 'NOT_PRIVILEGED',
  RATE_LIMITED: 'RATE_LIMITED',
  FUNNEL_REFUSED: 'FUNNEL_REFUSED',
  FUNNEL_STATUS_UNKNOWN: 'FUNNEL_STATUS_UNKNOWN',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
} as const

export type TransportErrorCode = (typeof TransportErrorCode)[keyof typeof TransportErrorCode]
