/**
 * Deciding whether a link in a document is allowed to be a link. Spec §8.
 *
 * Core layer: pure, no `node:fs`, no browser globals beyond what both runtimes have.
 *
 * **Every markdown file in this tree was written by an agent.** §1's threat model is not a
 * hypothesis here, it is the normal case — so a URL arriving out of a document is untrusted input
 * in the strict sense, and this module is the only thing that decides what becomes an `href`.
 *
 * §8's rule, verbatim, and the order is the whole design:
 *
 *   *"Scheme allowlisting **after normalization**: strip control characters, decode entities and
 *   exactly one percent layer, lowercase, *then* test against `http`/`https`/`mailto`/internal-file.
 *   This is what makes `java\tscript:`, `&#106;avascript:` and protocol-relative `//host` inert.
 *   Anything else renders as plain text."*
 *
 * ## The part that is easy to get backwards: normalize to DECIDE, never to EMIT
 *
 * The normalized string is used to answer one question — *is this allowed?* — and is **never** what
 * gets written into the DOM. The emitted `href` is the raw text from the document.
 *
 * That sounds like the unsafe way round and it is the safe one, because every normalization step
 * here is **strictly more suspicious than the browser is**:
 *
 *   - **Control characters.** A browser strips tab, CR and LF from a URL before parsing it, which
 *     is the entire trick behind `java\tscript:`. Stripping them too means we test exactly the
 *     string the browser will act on. Emitting the raw is therefore equivalent — *and* if we
 *     emitted the stripped form instead, we would be the ones assembling `javascript:` out of text
 *     that did not contain it.
 *   - **HTML entities.** A browser does **not** decode `&#106;` inside an attribute set through
 *     `setAttribute`; no HTML parsing happens on that path, so it stays six literal characters.
 *     Decoding them to decide is a check the browser will never need, kept because CommonMark
 *     *does* decode entities in link destinations, and this app must not depend on which of the two
 *     a future renderer resembles.
 *   - **One percent layer.** A browser does not percent-decode a scheme, so `%6aavascript:` is
 *     already inert to it. Decoding once to decide costs a false refusal at worst.
 *
 * So the normalization can only ever reject more than the browser would. A URL that survives it is
 * one whose raw form the browser will read the same way we did.
 *
 * ## What "internal" means, and why this module does not resolve it
 *
 * A destination with no scheme is a **candidate** relative path and nothing more. §8: *"Internal
 * links are resolved **server-side** through the §4 checker."* Resolution needs the containment
 * rules, the registered root and the document's own location — none of which belong in a pure
 * function, and all of which already exist exactly once elsewhere. This module says *"that could be
 * a file, ask the server"*; it never decides that it is one.
 */

/**
 * What a destination is allowed to become.
 *
 * A discriminated union rather than a boolean plus a string, so a caller cannot render an `href`
 * without having established which kind it is holding — the same reasoning as `SaveOutcome`.
 */
export type LinkTreatment =
  /** `http`, `https` or `mailto`. Opens in a new tab, `rel="noopener noreferrer"`. */
  | { readonly kind: 'external'; readonly href: string }
  /** No scheme: possibly a file in a registered folder. The server decides — §4's checker. */
  | { readonly kind: 'internal'; readonly target: string }
  /** Renders as plain text. `reason` is for a title attribute or a log, never for a URL. */
  | { readonly kind: 'inert'; readonly reason: string }

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto'])

/**
 * Characters removed before the scheme is read.
 *
 * Written as escapes, never as literal characters: a control character pasted into source is
 * invisible to the next reader and, on the first attempt at this file, silently terminated the
 * regular expression. A rule about characters you cannot see must be spelled out.
 *
 * C0 and DEL, C1, the soft hyphen and Mongolian vowel separator, the bidi and zero-width family,
 * the Unicode space separators, and the BOM.
 *
 * **Broader than the tab/CR/LF a browser strips, deliberately.** Stripping more can only make the
 * decision *more* suspicious — an ideographic space inside `java script:` is not stripped by a
 * browser, so that URL is already inert to it, and treating it as `javascript:` here costs a false
 * refusal and nothing else. The module header sets out why every step is allowed to over-reject
 * but never to under-reject.
 */
const STRIPPED = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F'
  + '\\u2028-\\u202F\\u205F-\\u2060\\u3000\\uFEFF]',
  'g',
)

/**
 * Removing the characters a browser ignores, in **one place**.
 *
 * It was three places — before the loop, inside it, and after the percent decode — and a mutation
 * sweep showed the first two were unprovable: deleting either left the others covering for it, so
 * no test could see it go. Three copies of a rule is also three chances for one of them to drift.
 *
 * Now one function, called three times. A change to the rule is a change in one line, and a sweep
 * that breaks it breaks every use at once — which is the only way a control of this shape can be
 * shown to be load-bearing.
 */
const strip = (value: string): string => value.replace(STRIPPED, '').trim()

/** `&#106;`, `&#x6a;` — the numeric forms, which cover every character. */
const NUMERIC_ENTITY = /&#(x[0-9a-f]+|[0-9]+);?/gi

/**
 * The named entities that can change how a scheme parses.
 *
 * Not a full HTML entity table, and it does not need to be: a named entity that decodes to a letter
 * or a digit cannot manufacture a scheme delimiter, and one that decodes to anything else is only
 * interesting if it is a colon, a slash, or whitespace. Those are here.
 */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['colon', ':'], ['sol', '/'], ['tab', '\t'], ['newline', '\n'],
  ['nbsp', ' '], ['amp', '&'], ['lpar', '('], ['rpar', ')'],
])
const NAMED_ENTITY = /&([a-z]+);/gi

/**
 * `//host` and `#anchor`, as anchored patterns rather than `startsWith`.
 *
 * Not a style choice. §5 bans `startsWith` outright — *"Paths compare on whole segments, never by
 * prefix"* — and the ban is on the property name, so it catches genuine string uses like these two
 * as well. The rule says a real non-path use is an escalation rather than a local disable; an
 * anchored regular expression makes the question moot, reads the same, and leaves the ban intact
 * for the case it was written for.
 */
const PROTOCOL_RELATIVE = /^\/\//
const FRAGMENT_ONLY = /^#/

function decodeEntities(value: string): string {
  return value
    .replace(NUMERIC_ENTITY, (whole, digits: string) => {
      const code = digits[0]?.toLowerCase() === 'x'
        ? Number.parseInt(digits.slice(1), 16)
        : Number.parseInt(digits, 10)
      // An out-of-range code point would throw. Left as written rather than dropped: a malformed
      // entity is not a decoded character, and pretending it is could only ever remove text that
      // the scheme test then no longer sees.
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    })
    .replace(NAMED_ENTITY, (whole, name: string) => NAMED_ENTITIES.get(name.toLowerCase()) ?? whole)
}

/** The outcome of normalising, including whether it finished. */
export interface Normalized {
  readonly value: string
  /**
   * False when the entity decoder hit its pass limit with the string still changing.
   *
   * A caller must treat that as untrustworthy rather than as a result. See `treatmentFor`.
   */
  readonly converged: boolean
}

/**
 * The decision form of a destination. Exported for tests and for nothing else — no caller should
 * ever put this string in front of a browser.
 */
export function normalizeForDecision(raw: string): Normalized {
  /**
   * **Trimmed, and only at the ends.** Browsers strip leading and trailing whitespace from a URL
   * before parsing it, so `'   javascript:alert(1)'` is a live `javascript:` URL to a browser.
   *
   * Found by this module's own test, which is the useful kind of finding: the stripped set covers
   * C0 (`\u0000`–`\u001F`) and deliberately excludes the ASCII space at `\u0020`, because a
   * browser does **not** strip an interior space — `java script:` is not a scheme — and removing
   * interior spaces here would have us manufacturing schemes out of text that has none. So the
   * space is handled by trimming rather than by the character class, which is exactly the
   * distinction the browser makes.
   */
  const withoutControls = strip(raw)
  /**
   * Entities are decoded **to a fixed point**, and the percent layer exactly **once**.
   *
   * §8 says "decode entities and exactly one percent layer". The asymmetry is not sloppiness in the
   * spec: `&amp;#106;` decodes to `&#106;` decodes to `j`, so a single entity pass leaves a live
   * `javascript:` one step out of reach — while percent-decoding repeatedly would start rejecting
   * ordinary URLs whose *content* happens to contain an encoded percent sign.
   *
   * Bounded, because a fixed point over attacker-supplied input is otherwise a loop they control.
   */
  let decoded = withoutControls
  let converged = false
  for (let pass = 0; pass < 4; pass += 1) {
    const next = strip(decodeEntities(decoded))
    if (next === decoded) { converged = true; break }
    decoded = next
  }

  let percentDecoded = decoded
  try {
    percentDecoded = decodeURIComponent(decoded)
  } catch {
    // Malformed percent escapes: keep the undecoded string. Refusing to decode is not refusing to
    // check — the scheme test below still runs, on the form the browser would actually see.
  }

  return { value: strip(percentDecoded).toLowerCase(), converged }
}

/**
 * What a document's link destination is allowed to become.
 *
 * `raw` is the destination exactly as it appeared in the file.
 */
export function treatmentFor(raw: string): LinkTreatment {
  const { value: normalized, converged } = normalizeForDecision(raw)

  /**
   * **Did not finish normalising, so it is not trusted.**
   *
   * The entity decoder is bounded because a fixed point over attacker-supplied input is a loop the
   * attacker controls. That bound has to fail *closed*: a string still changing on the last pass is
   * one whose final form we do not know, and "we could not finish checking" must never come out the
   * same door as "we checked and it was fine."
   */
  if (!converged) return { kind: 'inert', reason: 'this link could not be read safely' }

  if (normalized === '') return { kind: 'inert', reason: 'this link has no destination' }

  /**
   * **Protocol-relative `//host` — no scheme, and emphatically not internal.**
   *
   * §8 names it. It inherits the page's scheme, so on the app's own origin it is an ordinary
   * outbound request to someone else's server — the exact thing "zero outbound network" forbids for
   * content. It has to be caught before the no-scheme branch, because that branch's whole premise
   * is that a destination without a scheme is a path inside the tree.
   */
  if (PROTOCOL_RELATIVE.test(normalized)) {
    return { kind: 'inert', reason: 'this link points at another site' }
  }

  /**
   * A fragment is not a file. §8's allowlist is `http`/`https`/`mailto`/internal-file, and an
   * in-document anchor is none of them — there is no anchor machinery in this build to jump to.
   * Inert rather than silently broken, so it reads as text instead of as a link that does nothing.
   */
  if (FRAGMENT_ONLY.test(normalized)) {
    return { kind: 'inert', reason: 'in-document links are not supported' }
  }

  const scheme = /^([a-z][a-z0-9+.\-]*):/.exec(normalized)?.[1]

  if (scheme === undefined) {
    // No scheme, not protocol-relative, not a fragment: a candidate path. The server resolves it.
    return { kind: 'internal', target: raw }
  }

  if (ALLOWED_SCHEMES.has(scheme)) {
    // The RAW string, not the normalized one. See the module header — normalizing to emit is how a
    // renderer assembles a dangerous URL out of text that did not contain one.
    return { kind: 'external', href: raw }
  }

  /**
   * Everything else, and the reason is deliberately generic.
   *
   * Naming the scheme back — "javascript: links are not allowed" — is a small oracle and a large
   * invitation. Someone probing the renderer learns which schemes are recognised and which merely
   * fall through, and a person reading their own document learns nothing they need.
   */
  return { kind: 'inert', reason: 'this kind of link is not opened' }
}

/**
 * Whether an image's source may be fetched.
 *
 * §8: *"Remote images and iframes are never loaded — an image whose src isn't a registered-folder
 * file renders as a placeholder. This is how 'zero outbound network' holds for *content*, not just
 * for the app's own calls."*
 *
 * So the rule for images is **stricter than for links**: `http` and `https` are allowed
 * destinations to *click*, and are never allowed sources to *load*. A remote image is a silent
 * request on page render, which is a tracking pixel with no user action behind it.
 */
export function imageIsLoadable(raw: string): boolean {
  return treatmentFor(raw).kind === 'internal'
}
