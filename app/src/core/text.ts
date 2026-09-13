/**
 * Text normalization primitives.
 *
 * Spec §3 and §4 both reduce to this module. §3's grammar matching and §4's identity keys are
 * the same three operations in different orders, and v1's bug was implementing them three
 * separate times with three different meanings. There is one implementation here and nothing
 * re-implements it.
 *
 * Core layer: no HTTP, no browser, no third-party code. Spec §2.
 */

/** Unicode NFC. Spec §4 makes this the first step of every comparison. */
export function toNFC(value: string): string {
  return value.normalize('NFC')
}

/**
 * Characters where Unicode *simple* case folding — what spec §4 names — differs from
 * JavaScript's `toLowerCase()`, which implements the Default Case Conversion instead.
 *
 * There is no case-folding primitive in the standard library and spec §2 forbids adding a
 * package for one, so the fold below is `toLowerCase()` with these divergences corrected.
 * Each entry is from CaseFolding.txt; the comment says which direction `toLowerCase()` errs.
 *
 * KNOWN LIMIT, stated rather than hidden: this table covers the Latin and Greek divergences
 * and common punctuation. It does NOT correct **Cherokee** (U+13A0–13F5, where `toLowerCase()`
 * over-folds to the U+AB70 block) or several historic scripts. Correcting those needs the full
 * CaseFolding.txt table, which is a data file, not logic.
 *
 * Widened 2026-08-06 after the Phase 1 fresh-eyes review (S6), which measured the claim and
 * found it false: the comment said Greek was covered while six live Greek cases were wrong.
 * They are below now. The lesson is the point — **a comment that overstates coverage is how
 * the next reader stops looking**, which is the same failure as a control that reads as
 * correct and enforces nothing.
 *
 * Why that limit is tolerable: per spec §4, file identity is `(dev, ino)` from a descriptor and
 * never a path string — "path strings are not identities". This fold produces *index* keys and
 * grammar matches, not the identity that locking depends on. A wrong fold here degrades lookup;
 * it cannot defeat a lock. Escalate before that stops being true.
 */
const FOLD_CORRECTIONS = new Map<string, string>([
  ['İ', 'İ'], // İ — toLowerCase over-folds to "i" + U+0307; simple fold leaves it alone
  ['ς', 'σ'], // ς final sigma — toLowerCase under-folds; simple fold gives σ
  ['µ', 'μ'], // µ micro sign — toLowerCase under-folds; simple fold gives Greek μ
  ['ſ', 's'], // ſ long s — toLowerCase under-folds; simple fold gives s
  ['ẞ', 'ß'], // ẞ capital sharp s — folds to ß (toLowerCase agrees; pinned by test)
  // The six Greek cases the comment used to claim were already handled. Each is a symbol
  // variant that folds to its ordinary letter; toLowerCase leaves all of them alone.
  ['ϐ', 'β'], // U+03D0 GREEK BETA SYMBOL
  ['ϑ', 'θ'], // U+03D1 GREEK THETA SYMBOL
  ['ϕ', 'φ'], // U+03D5 GREEK PHI SYMBOL
  ['ϰ', 'κ'], // U+03F0 GREEK KAPPA SYMBOL
  ['ϱ', 'ρ'], // U+03F1 GREEK RHO SYMBOL
  ['ϵ', 'ε'], // U+03F5 GREEK LUNATE EPSILON SYMBOL
  // These two are written as ESCAPES on purpose. Typed as literals they are visually
  // indistinguishable from an ordinary iota, and the first version of this table mapped
  // iota to itself and matched nothing — the same "looks right, does nothing" failure this
  // build keeps producing. The test is what caught it.
  ['\u1FBE', '\u03B9'], // GREEK PROSGEGRAMMENI → iota
  ['\u0345', '\u03B9'], // COMBINING GREEK YPOGEGRAMMENI → iota
])

/**
 * Unicode simple case folding, to the extent the standard library allows. Spec §4.
 *
 * Applied per code point so a correction cannot be swallowed by a surrounding lowercase pass.
 * Callers compare folded values; they never display them — spec §4 requires display to use the
 * on-disk bytes.
 */
export function foldCase(value: string): string {
  let out = ''
  for (const codePoint of value) {
    const correction = FOLD_CORRECTIONS.get(codePoint)
    out += correction ?? codePoint.toLowerCase()
  }
  return out
}

/**
 * ASCII-only lowercase. Spec §6 specifies the extension test as "NFC-normalized and
 * ASCII-lowercased" — deliberately narrower than the fold above, so that a Unicode character
 * cannot lowercase its way into looking like `md`.
 */
export function toASCIILowerCase(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : value[i]
  }
  return out
}

/** Matches a leading `NN-` ordering prefix: one or more ASCII digits then a single hyphen. */
const NUMERIC_PREFIX = /^[0-9]+-/

/**
 * Strips the soil's `NN-` ordering prefix. Spec §3: `02-next` matches `next`, and the display
 * name of a lane drops the prefix while its sort order uses it.
 *
 * Only ASCII digits count. Unicode digits are not ordering prefixes and must not be stripped —
 * stripping them would let a crafted name impersonate a grammar entry.
 */
export function stripNumericPrefix(segment: string): string {
  return segment.replace(NUMERIC_PREFIX, '')
}

/**
 * Reads the `NN-` prefix as a number for ordering. Spec §3: "order follows the numeric prefix,
 * then alphabetical." Returns null when there is no prefix, which sorts after every numbered
 * sibling rather than alongside zero.
 */
export function numericPrefixOf(segment: string): number | null {
  const match = NUMERIC_PREFIX.exec(segment)
  if (!match) return null
  const digits = match[0].slice(0, -1)
  const value = Number.parseInt(digits, 10)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * The single matching rule spec §3 requires be "stated once": NFC-normalize, strip an optional
 * leading `NN-` prefix, then simple-case-fold.
 *
 * v1 had three name lists with three different semantics; this function is why that cannot
 * recur. Every grammar list comparison goes through it.
 */
export function grammarKey(segment: string): string {
  return foldCase(stripNumericPrefix(toNFC(segment)))
}
