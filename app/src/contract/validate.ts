/**
 * The validation wrapper. Spec §6's chokepoint, hand-written because spec §2 forbids a runtime
 * dependency and a schema library is exactly the kind of thing that gets reached for here.
 *
 * WHAT THIS REFUSES, and why each one is named in the spec rather than inferred:
 *   - **Unknown keys.** Strict by default. A tolerated extra key is how a client and a server drift
 *     apart while both look correct.
 *   - **Non-string path segments.** v1 accepted whatever arrived and joined it; a number or an
 *     object stringifies into something that is not a path but looks like one.
 *   - **Prototype-pollution keys.** `JSON.parse('{"__proto__":{...}}')` creates a real own property
 *     named `__proto__`, and the damage happens later, when something spreads or assigns it. The
 *     defense is at the door, not at the assignment.
 *   - **Over-limit bodies**, before parsing rather than after.
 *
 * The output of a successful validation is built on a **null-prototype object**, so even if a key
 * slipped through it could not reach `Object.prototype`. Belt and braces, deliberately: the key
 * rejection is the control, and this is what makes a failure of that control survivable.
 */

import { segmentFault, type SegmentFault } from '../core/paths'
import { TransportErrorCode } from './wire'

export interface ValidationFailure {
  readonly code: TransportErrorCode
  /** Where in the body the problem is, e.g. `$.location.segments[2]`. Never echoes the value. */
  readonly at: string
  readonly detail: string
}

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ValidationFailure }

const fail = (code: TransportErrorCode, at: string, detail: string): Validated<never> =>
  ({ ok: false, failure: { code, at, detail } })

const pass = <T>(value: T): Validated<T> => ({ ok: true, value })

/**
 * Keys that must never appear in a request body, at any depth.
 *
 * `__proto__` is the classic. `constructor` and `prototype` are here because the same trick works
 * through them (`{"constructor":{"prototype":{...}}}`) and a defense that names only the famous one
 * is the kind of partial control this build keeps finding.
 */
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** A validator is a function from unknown to Validated. Nothing more — no class, no registry. */
export type Validator<T> = (input: unknown, at: string) => Validated<T>

export const str = (): Validator<string> => (input, at) =>
  typeof input === 'string' ? pass(input) : fail(TransportErrorCode.BAD_REQUEST, at, 'expected a string')

/**
 * A name a person typed, on its way to becoming a filename, the heading seeded into a new file, or
 * a label in the config. **`str()` with control characters refused.**
 *
 * **the security review's P9F-5, and the consequence is the reason it is not cosmetic.** The path a name becomes
 * is slugified, so the *filename* was always safe; the **seed** was not. `card.create` and
 * `entry.create` both write `` `# ${name}` `` into the new file as annex A5's title, carrying what
 * the person typed rather than the slug — deliberately, so the board draws their words. A NUL
 * riding in on that name lands in the file, and **a file containing a NUL is classified as binary
 * and silently skipped by every plain `grep`.** This is the user's notes tree, and their own agents are
 * instructed to find things in it by grepping. A note that cannot be found is not far from a note
 * that is gone.
 *
 * **Refused rather than stripped**, which is this build's standing preference and is right here for
 * a specific reason: a silent strip means the name in the file is not the name that was typed, and
 * nothing says so. §13.6 already takes the same line on slugification — the kernel refuses a name
 * it cannot honour instead of inventing one.
 *
 * **The trim is the whole subtlety.** The check runs against `input.trim()`, so a name pasted with a
 * trailing newline — an ordinary thing to do, and already harmless because the seed trims too — is
 * accepted, while anything that would actually reach the file is refused. **NUL survives `trim()`**
 * (it is neither whitespace nor a line terminator), so the character that motivated this cannot slip
 * through the concession made for the ones that are fine.
 *
 * **No regex**, so there is no `no-control-regex` suppression to read past, and the range is legible.
 *
 * **Not applied to `body`.** `projects.stage`'s body is free prose and multi-line is the point of the
 * feature. Bounding a field's *size* is a different question and belongs to P8-10.
 */
export const displayName = (): Validator<string> => (input, at) => {
  if (typeof input !== 'string') {
    return fail(TransportErrorCode.BAD_REQUEST, at, 'a name must be a string')
  }
  for (const character of input.trim()) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return fail(TransportErrorCode.BAD_REQUEST, at, 'name contains a control character')
    }
  }
  return pass(input)
}

export const bool = (): Validator<boolean> => (input, at) =>
  typeof input === 'boolean' ? pass(input) : fail(TransportErrorCode.BAD_REQUEST, at, 'expected a boolean')

/**
 * A bounded integer. `Number.isSafeInteger` rather than `typeof === 'number'`: NaN, Infinity and
 * 2^53+1 are all numbers, and each one produces a different flavour of nonsense downstream.
 */
export const int = (min: number, max: number): Validator<number> => (input, at) => {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    return fail(TransportErrorCode.BAD_REQUEST, at, 'expected a safe integer')
  }
  if (input < min || input > max) {
    return fail(TransportErrorCode.BAD_REQUEST, at, `expected between ${min} and ${max}`)
  }
  return pass(input)
}

export const arrayOf = <T>(item: Validator<T>, maxLength: number): Validator<T[]> =>
  (input, at) => {
    if (!Array.isArray(input)) return fail(TransportErrorCode.BAD_REQUEST, at, 'expected an array')
    if (input.length > maxLength) {
      return fail(TransportErrorCode.PAYLOAD_TOO_LARGE, at, `at most ${maxLength} items`)
    }
    const out: T[] = []
    for (let i = 0; i < input.length; i++) {
      const result = item(input[i], `${at}[${i}]`)
      if (!result.ok) return result
      out.push(result.value)
    }
    return pass(out)
  }

/**
 * A strict object. Unknown keys are an error, not a warning, and poison keys are an error before
 * anything else is looked at.
 */
export const object = <S extends Record<string, Validator<unknown>>>(
  shape: S,
): Validator<{ [K in keyof S]: S[K] extends Validator<infer T> ? T : never }> =>
  (input, at) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return fail(TransportErrorCode.BAD_REQUEST, at, 'expected an object')
    }

    // `Object.keys` on a JSON.parse result includes an own `__proto__` if one was sent, which is
    // exactly the case being caught. Checked before any field is read.
    for (const key of Object.keys(input)) {
      if (POISON_KEYS.has(key)) {
        return fail(TransportErrorCode.BAD_REQUEST, `${at}.${key}`, 'forbidden key')
      }
      if (!Object.hasOwn(shape, key)) {
        return fail(TransportErrorCode.UNKNOWN_FIELD, `${at}.${key}`, 'unknown field')
      }
    }

    // Null prototype: a key that somehow survived the check above still cannot reach
    // Object.prototype from here.
    const out = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(shape)) {
      const validator = shape[key]
      if (validator === undefined) continue
      const result = validator((input as Record<string, unknown>)[key], `${at}.${key}`)
      if (!result.ok) return result
      out[key] = result.value
    }
    return pass(out as { [K in keyof S]: S[K] extends Validator<infer T> ? T : never })
  }

/**
 * The maximum number of path segments the API will accept.
 *
 * Not a security boundary — Core's containment is — but a request carrying ten thousand segments is
 * a denial-of-service shaped like a path, and it should die at the door rather than inside the
 * walker.
 */
export const MAX_PATH_SEGMENTS = 64

/**
 * How many projects a board's filter may name at once.
 *
 * **Bounded rather than open**, because P9-5 is on the ledger for exactly the opposite: staged
 * cards were uncapped and 120 of them at 100 KB each was 12 MB of config. A selection is small
 * data, but it arrives on every board read and an unbounded list is an unbounded loop over the
 * index.
 *
 * 512 is far above any real answer — the mock soil has around thirty projects — and far below
 * anything that costs a person waiting for a board.
 */
export const MAX_SELECTED_PROJECTS = 512

/**
 * The longest card order one column may carry. P14 B4.
 *
 * Same reasoning as the bound above: the list is not sensitive, but it arrives on a write and an
 * unbounded one is an unbounded write to the state file plus an unbounded loop on every board read.
 *
 * 2,048 is far above any real column — a board is *"kind of ephemeral, moving through projects"* in
 * the operator's words, so a column of thousands is not a board that got big, it is a board pointed at
 * the wrong folder. And it is far below anything that costs a person waiting for a board.
 */
export const MAX_CARD_ORDER = 2048

/** The longest single segment. macOS caps a filename at 255 bytes; this is generous and finite. */
/** Re-exported from Core, which now owns the segment rules. One definition, two names. */
export { MAX_SEGMENT_LENGTH } from '../core/paths'

/**
 * A path segment. **This is not the containment check** — that lives in Core and runs against the
 * real filesystem with `lstat` on every segment. This is the door: it refuses shapes that are
 * obviously not a segment, so Core is never handed nonsense.
 *
 * Explicitly rejected here rather than deferred: empty segments, `.` and `..`, anything containing
 * a separator, and NUL. Spec §4 has Core refuse all of these too, and the duplication is deliberate
 * — the API's own contract should be legible without reading the file engine.
 */
export const pathSegment = (): Validator<string> => (input, at) => {
  if (typeof input !== 'string') {
    return fail(TransportErrorCode.BAD_REQUEST, at, 'a path segment must be a string')
  }
  /**
   * **The rules are Core's, and this layer only chooses the error vocabulary.**
   *
   * They used to live here, in full, and this file's own docstring warned that *"re-deriving them
   * at the call site is how two path validators end up disagreeing."* The warning was right and
   * incomplete: what actually happened on 2026-08-09 was not a second, divergent implementation —
   * it was the §9 byte endpoint having **none**, because it parsed its path out of a query string
   * instead of going through a validator. A separator inside one segment then walked straight
   * through §4's per-segment symlink refusal and served bytes from outside the registered root.
   *
   * So the rule moved to `core/paths.ts`, where `walkAndVerify` — the chokepoint every read and
   * write passes — enforces it regardless of which route asked. This validator still runs, because
   * refusing malformed input at the edge with a 400 is better than refusing it deep with a 500.
   * It is now a second line rather than the only one.
   */
  const faultReason: Record<SegmentFault, string> = {
    empty: 'empty segment',
    'too-long': 'segment too long',
    dot: 'dot segment',
    separator: 'segment contains a separator',
    nul: 'segment contains NUL',
  }
  const fault = segmentFault(input)
  if (fault !== null) return fail(TransportErrorCode.BAD_REQUEST, at, faultReason[fault])
  return pass(input)
}

/**
 * The only way the API addresses a file. Spec §6: "Path parameters are always
 * `(registered-folder id, relative path)`. The API **never** accepts an absolute path."
 *
 * There is no validator anywhere in this file that accepts an absolute path, which is how that rule
 * is enforced — not by checking for a leading slash, but by there being no shape that could carry
 * one. A leading slash would have to arrive as an empty first segment or a segment containing a
 * separator, and both are refused above.
 */
export const location = (): Validator<{ rootId: string; segments: string[] }> =>
  object({
    rootId: str(),
    segments: arrayOf(pathSegment(), MAX_PATH_SEGMENTS),
  }) as Validator<{ rootId: string; segments: string[] }>

/**
 * The `segments` half of a location, on its own.
 *
 * `location()` bundles `rootId` and `segments`, which is right for a read. A write route needs the
 * same segment rules alongside fields of its own, and re-deriving them at the call site is how two
 * path validators end up disagreeing — the divergence §6 forbids for `isMarkdown` applies just as
 * well to the thing that decides what a path may contain.
 */
export const pathSegments = (): Validator<string[]> =>
  arrayOf(pathSegment(), MAX_PATH_SEGMENTS)

/**
 * A lowercase hex SHA-256, exactly 64 characters.
 *
 * Checked for shape at the boundary so a malformed value is refused as bad input rather than
 * quietly failing a comparison deeper in — §6 wants the boundary to reject what it can name.
 */
export const hex64 = (): Validator<string> => (input, at) => {
  if (typeof input !== 'string') {
    return fail(TransportErrorCode.BAD_REQUEST, at, 'expected a string')
  }
  // Anchored, lowercase-only, exact length. An unanchored pattern would accept a digest with
  // anything appended, which is the shape of check that looks strict and is not.
  if (!/^[0-9a-f]{64}$/.test(input)) {
    return fail(TransportErrorCode.BAD_REQUEST, at, 'expected a 64-character lowercase hex digest')
  }
  return pass(input)
}

/**
 * One of a fixed set of strings.
 *
 * Validated at the boundary rather than by a `switch` downstream. A `switch` on an unvalidated
 * string either needs a `default` that someone must remember to make a refusal, or silently falls
 * through — and §6 wants the boundary to reject what it can name.
 */
export const oneOf = <const T extends readonly string[]>(allowed: T): Validator<T[number]> =>
  (input, at) => {
    if (typeof input !== 'string') {
      return fail(TransportErrorCode.BAD_REQUEST, at, 'expected a string')
    }
    if (!allowed.includes(input)) {
      return fail(TransportErrorCode.BAD_REQUEST, at, `expected one of: ${allowed.join(', ')}`)
    }
    return pass(input as T[number])
  }
