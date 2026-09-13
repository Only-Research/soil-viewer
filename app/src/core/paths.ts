/**
 * Path composition and comparison. Spec §4 and §5.
 *
 * This module decides whether a client-supplied relative path may be composed against a
 * registered root at all. It performs no I/O — the filesystem checks (symlink refusal,
 * regular-file and hardlink checks, descriptor identity) live in `core/fs`, which is the only
 * module permitted to import `node:fs`. Keeping the string rules here means they are testable
 * without a disk and cannot be quietly re-implemented at a call site, which is exactly what
 * happened in the lab code: four separate copies of the containment check.
 *
 * Core layer: no HTTP, no browser, no third-party code. Spec §2.
 */

import { ErrorCode, fail, ok, type Result } from './errors'
import { foldCase, toNFC } from './text'

/** Spec §4. The only separator. A backslash is an ordinary character in a macOS filename. */
const SEPARATOR = '/'

/** `C:` or `C:\` — refused outright rather than interpreted. Spec §4. */
const DRIVE_LETTER = /^[a-zA-Z]:/

/**
 * Splits a validated relative path into segments.
 *
 * **Called on paths that are already trusted by construction, and NOT on validator output** —
 * corrected 2026-08-16 on the security review's G6. This said *"only ever called on input that
 * `validateRelativePath` has already accepted"*; it has sixteen call sites and **not one** passes
 * that, because nothing calls `validateRelativePath` at all. Every caller hands it either an
 * absolute path the server composed or a boundary string it owns.
 *
 * No defect follows — splitting a composed absolute path on the separator is correct, and that is
 * what makes this worth stating plainly rather than quietly deleting. The sentence was false at
 * every site while sitting three lines above a dead function, which is how a reader ends up
 * believing a validator runs somewhere it does not.
 *
 * Exported for the index and the watcher, which compare segment arrays.
 */
export function splitSegments(relativePath: string): string[] {
  return relativePath.split(SEPARATOR).filter(segment => segment.length > 0)
}

export function joinSegments(segments: readonly string[]): string {
  return segments.join(SEPARATOR)
}

/**
 * Validates a client-supplied relative path and returns its segments. Spec §4's composition
 * rules, in the order the spec states them.
 *
 * The one rule that carries the most weight: **NFC, never NFKC.** NFKC maps compatibility
 * characters onto ASCII — U+FF0E FULLWIDTH FULL STOP becomes `.` — so normalizing with NFKC
 * would manufacture a traversal sequence out of input that did not contain one. NFC does not
 * do this. A future edit that "upgrades" the normalization form reopens traversal.
 */
export function validateRelativePath(input: unknown): Result<string[]> {
  if (typeof input !== 'string' || input.length === 0) {
    return fail(ErrorCode.PATH_EMPTY, 'path must be a non-empty string')
  }

  // NUL before decoding. Checked again after, because `%00` only becomes NUL once decoded.
  if (input.includes('\0')) return fail(ErrorCode.PATH_NUL, 'NUL in raw input')

  const normalized = toNFC(input)

  // Percent-decode exactly once, then refuse any surviving `%`. This is what stops
  // double-encoding: `%252e%252e` decodes to `%2e%2e`, which still carries a `%` and is
  // refused rather than decoded a second time into `..`.
  let decoded: string
  try {
    decoded = decodeURIComponent(normalized)
  } catch {
    return fail(ErrorCode.PATH_MALFORMED_ESCAPE, 'malformed percent-escape')
  }
  if (decoded.includes('%')) {
    return fail(ErrorCode.PATH_ENCODING, 'percent survived one decode — refusing double-encoding')
  }

  if (decoded.includes('\0')) return fail(ErrorCode.PATH_NUL, 'NUL after decoding')

  // Normalize AGAIN after decoding. The first pass ran on the raw input, so a percent-escaped
  // combining sequence (`cafe%CC%81.md`) decoded into NFD *after* normalization and was handed
  // to join/lstat/open in decomposed form. APFS is normalization-insensitive so it resolved
  // here, but a normalization-sensitive volume (SMB, exFAT, HFSX) would miss the file, and the
  // handle's own relativeSegments were non-NFC.
  const composed = toNFC(decoded)

  if (composed.length === 0) return fail(ErrorCode.PATH_EMPTY, 'empty after decoding')
  if (composed[0] === SEPARATOR) {
    return fail(ErrorCode.PATH_NOT_RELATIVE, 'leading separator')
  }
  if (DRIVE_LETTER.test(composed)) {
    return fail(ErrorCode.PATH_NOT_RELATIVE, 'drive letter')
  }

  // Split on the raw string — NOT with a normalizing join — so that `..` is caught before any
  // library gets a chance to resolve it. Spec §4 forbids path.resolve on user input for
  // exactly this reason: path.resolve(root, '/etc/passwd') silently discards the root.
  const segments = composed.split(SEPARATOR)

  for (const segment of segments) {
    if (segment.length === 0) {
      return fail(ErrorCode.PATH_TRAVERSAL, 'empty segment')
    }
    if (segment === '.' || segment === '..') {
      return fail(ErrorCode.PATH_TRAVERSAL, 'relative segment')
    }
  }

  return ok(segments)
}

/** §6's segment limits. Here rather than in the contract, because Core now enforces them too. */
export const MAX_SEGMENT_LENGTH = 255
export const MAX_PATH_SEGMENTS = 64

/** Why a single path segment is unusable, or `null` when it is fine. */
export type SegmentFault = 'empty' | 'too-long' | 'dot' | 'separator' | 'nul'

/**
 * **THE ONE RULE FOR WHAT A SINGLE PATH SEGMENT MAY CONTAIN.**
 *
 * Added 2026-08-09, after the security review's P7 review demonstrated a live containment escape — and my own
 * re-run of it served the bytes of a file outside every registered folder.
 *
 * The rule existed, in `contract/validate.ts`'s `pathSegment()`, and every JSON route went through
 * it. **The byte endpoint did not.** `parseFileRequest` re-derived its own segment handling from
 * the query string and applied none of these checks, so a single `p=` value carrying `%2F` arrived
 * as one array element containing a separator — and `walkAndVerify` composes `join(current, seg)`
 * once **per array element**, so two path components collapsed into one `lstat`. `lstat` does not
 * follow a final component but does follow every intermediate one, so §4's stated wall — *"lstats
 * every segment from the root down and refuses any symlinked segment"* — was never walked. A
 * symlink planted inside a registered root, which §1's threat model treats as the normal case, then
 * pointed anywhere on the disk. Containment passed, because the composed string genuinely was under
 * the root.
 *
 * Measured, not reasoned: `['link','secret.png']` refused `PATH_SYMLINK` at depth 1;
 * `['link/secret.png']` returned `ok, kind=file`, and reading that path returned the bytes from
 * outside the root.
 *
 * **So the rule moves to Core and both layers call it.** `validate.ts` warned about exactly this —
 * *"re-deriving them at the call site is how two path validators end up disagreeing"* — in the file
 * that owned the only copy. A second implementation was not the risk; a caller that had no
 * implementation was.
 *
 * Returns a fault rather than a `Result`, so each layer maps it to its own error vocabulary — Core
 * to `ErrorCode`, the contract to `TransportErrorCode` — without either importing the other's.
 */
export function segmentFault(segment: string): SegmentFault | null {
  if (segment.length === 0) return 'empty'
  if (segment.length > MAX_SEGMENT_LENGTH) return 'too-long'
  if (segment === '.' || segment === '..') return 'dot'
  // Backslash as well as `/`: a volume mounted from SMB can treat it as a separator, and refusing
  // it costs a filename nobody on this tree has.
  if (segment.includes('/') || segment.includes('\\')) return 'separator'
  // Spelled as an escape, never as a literal. The literal renders as an ordinary space in every
  // tool, so a reviewer cannot tell it from `includes(' ')` — a check that would refuse most of
  // the operator's filenames while letting NUL through. This build has produced four instances of that
  // exact shape.
  if (segment.includes('\u0000')) return 'nul'
  return null
}

/** The fault, as one of Core's codes. */
export function segmentErrorFor(fault: SegmentFault): ErrorCode {
  switch (fault) {
    case 'empty': return ErrorCode.PATH_EMPTY
    case 'too-long': return ErrorCode.NAME_TOO_LONG
    case 'nul': return ErrorCode.PATH_NUL
    // A dot segment and an embedded separator are the same class of input: both try to name
    // somewhere other than where the segment sits.
    case 'dot': return ErrorCode.PATH_TRAVERSAL
    case 'separator': return ErrorCode.PATH_TRAVERSAL
  }
}

/**
 * Segment-boundary containment. Spec §5: "Raw `startsWith` on paths is forbidden — it was a
 * real bug in the lab code that the master audit missed."
 *
 * The bug it prevents: `/soil/notes`.startsWith(`/soil/notes-old`) reasoning, where watcher
 * events were attributed to the wrong folder because one path is a string prefix of another
 * without being inside it. Comparing whole segments cannot make that mistake.
 *
 * `caseInsensitive` comes from the per-root probe recorded at registration (spec §4) — it is
 * never guessed, and never applied globally.
 */
export function isWithin(
  rootSegments: readonly string[],
  candidateSegments: readonly string[],
  caseInsensitive: boolean,
): boolean {
  if (candidateSegments.length < rootSegments.length) return false
  for (let i = 0; i < rootSegments.length; i++) {
    const rootSegment = rootSegments[i]
    const candidateSegment = candidateSegments[i]
    if (rootSegment === undefined || candidateSegment === undefined) return false
    if (!segmentsEqual(rootSegment, candidateSegment, caseInsensitive)) return false
  }
  return true
}

/**
 * Compares one segment. Spec §4: identity keys are NFC-normalized and simple-case-folded on
 * case-insensitive volumes, and NFC exact bytes on case-sensitive ones.
 */
export function segmentsEqual(a: string, b: string, caseInsensitive: boolean): boolean {
  const left = toNFC(a)
  const right = toNFC(b)
  return caseInsensitive ? foldCase(left) === foldCase(right) : left === right
}

/**
 * The comparison key for one path under a root. Spec §4.
 *
 * Used for index keys and lookup only. It is NOT a file identity — spec §4 is explicit that
 * identity is `(dev, ino)` from a descriptor, because overlapping roots, case variants and
 * NFC/NFD all produce two strings for one inode. Anything that must not be fooled by two
 * names for one file uses the inode, not this.
 */
export function comparisonKey(segments: readonly string[], caseInsensitive: boolean): string {
  const normalized = segments.map(segment => {
    const nfc = toNFC(segment)
    return caseInsensitive ? foldCase(nfc) : nfc
  })
  return joinSegments(normalized)
}

/**
 * Returns the segments of `candidate` relative to `root`, or null when it is not contained.
 * Used by the watcher to attribute an event to a registered folder.
 */
export function relativeTo(
  rootSegments: readonly string[],
  candidateSegments: readonly string[],
  caseInsensitive: boolean,
): string[] | null {
  if (!isWithin(rootSegments, candidateSegments, caseInsensitive)) return null
  return candidateSegments.slice(rootSegments.length)
}


/**
 * How many trailing folders the document header shows before it gives up and elides.
 *
 * Two, from the design packet. One is often `tasks` or `01-inbox`, which is a kind rather than a
 * place; two reaches the thing that actually names it — `cider-line/02-work`.
 */
export const HEADER_PATH_SEGMENTS = 2

/** The mark that says something was cut off the FRONT. */
export const PATH_ELISION = '…/'

/**
 * The document header's path line: **the tail, never the head, and never more than one line.**
 *
 * the operator, on their phone: *"it names the whole file path — the width is only letting a handful of
 * characters, so that becomes like four lines, five lines in mobile view."* Ten lines, in a task
 * card.
 *
 * **The tail is the half that identifies the file.** The front of a path in this soil is
 * `02-projects/` on nearly everything, so eliding from the left removes what every file has in
 * common and keeps what distinguishes them. Truncating the other way would leave every header
 * reading `02-projects/…`.
 *
 * **The filename is dropped, because the header already shows it** directly above this line. It was
 * included until 2026-08-15 — the path line ended with the same name the title carried, which is a
 * duplicate paid for in the width that caused the wrapping.
 *
 * **CSS alone could not do this.** `text-overflow: ellipsis` truncates the END, and `direction: rtl`
 * to flip it reorders punctuation in ways that are wrong for paths. Trimming here means the string
 * is short before it is ever laid out, so the header cannot wrap at any width — which is the actual
 * requirement, rather than "usually fits".
 *
 * Returns `''` for a file at the root: there is no folder to name, and an empty line is rendered as
 * no line at all.
 */
export function headerPath(segments: readonly string[]): string {
  // The last segment is the file itself; the header states it separately.
  const folders = segments.slice(0, -1)
  if (folders.length === 0) return ''

  const tail = folders.slice(-HEADER_PATH_SEGMENTS)
  const elided = tail.length < folders.length
  return `${elided ? PATH_ELISION : ''}${tail.join('/')}`
}
