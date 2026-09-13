/**
 * How a file's bytes are allowed to leave the server. Spec §9.
 *
 * Core layer: pure. No `node:fs`, no HTTP — this module decides, the server obeys.
 *
 * **§9 exists because v1's rule had a hole an SVG walks straight through.** v1 said bytes are
 * "never served as `text/html` or `application/javascript`", and **`image/svg+xml` is neither** —
 * while an SVG loaded *as a document* executes `<script>` in the serving origin. That origin is the
 * one holding file access. Two reviewers found it independently (F3.1).
 *
 * ## The control is the allowlist, and the deny-list is a test
 *
 * §9 names two things: a closed positive allowlist of extensions that may carry a real content
 * type, and an explicit list that must never be `image/svg+xml` — `.svg .svgz .html .htm .xhtml
 * .xht .xml .xsl .xslt .mhtml .webmanifest .js .mjs`.
 *
 * **Only the allowlist is implemented.** A deny-list beside it would be a second control saying the
 * same thing, and the failure mode of two controls saying one thing is that they drift — F4.5's
 * finding, and the reason §11 is written positively too. Since `.svg` is not in the allowlist it
 * gets `application/octet-stream` and an attachment disposition, which is what the rule demands.
 *
 * The named extensions are not therefore untested. They are enumerated **in the test suite**, one
 * assertion each, so the spec's list is checked against behaviour rather than against a matching
 * list in the source. A test can afford to be a second copy of a rule; a control cannot.
 *
 * ## Three outcomes, and `download` is the default
 *
 * Anything not positively recognised leaves as `application/octet-stream` with
 * `Content-Disposition: attachment`. That pairing matters: the type stops the browser rendering it,
 * and the disposition stops it being treated as a document even if a future browser decides to
 * sniff anyway. Neither is load-bearing alone.
 */

import { extensionOf } from './grammar'

/** What the server may say a file is. */
export type ServingDecision =
  /**
   * Safe to render in place — an `<img>`, or a `<iframe sandbox>` for a PDF. §9 is explicit that a
   * PDF gets **no** `allow-scripts` and **no** `allow-same-origin`, and that no preview ever
   * navigates the top frame to a file URL. Those are the server's and the client's obligations
   * respectively; this type only says the bytes may be shown.
   */
  | { readonly kind: 'inline'; readonly contentType: string }
  /**
   * FT-10's read-only plain-text pane — the one place round 2 recommended *adding* scope, because
   * without it these files are simply unreadable on the phone.
   *
   * **`text/plain` and nothing else.** It is served with `nosniff`, has no edit affordance and no
   * write path, and §9 is explicit that this does not weaken §6: the *editor* still opens `.md`
   * only.
   */
  | { readonly kind: 'text'; readonly contentType: 'text/plain; charset=utf-8' }
  /** Everything else. Never rendered, never sniffed. */
  | { readonly kind: 'download'; readonly contentType: 'application/octet-stream' }

/**
 * §9's positive allowlist, keyed on extension. **Never sniffed, never client-supplied.**
 *
 * `heic` is here because it is what an iPhone produces, and this app is used from one.
 */
const INLINE_TYPES: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['heic', 'image/heic'],
  ['pdf', 'application/pdf'],
])

/**
 * FT-10's set: `.txt`, `LICENSE`, `.json`, `.yml`, `.csv`.
 *
 * **`.yaml` is deliberately absent, and that is the spec's list rather than an oversight here.**
 * Noted because it is the first thing a reader will reach for: extending the set is a spec change,
 * and a spec change affecting behaviour is an escalation under build plan §5 — not a one-word edit
 * to this map. `.md` is absent for a different reason: it belongs to the editor.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['txt', 'json', 'yml', 'csv'])

/**
 * Extensionless filenames that are conventionally text. §9 names exactly one: `LICENSE`.
 *
 * **This set had `readme`, `changelog` and `licence` in it for about a minute**, and they are gone
 * because they were a widening of the spec's list written directly beneath a comment saying that
 * widening the spec's list is an escalation. The inconsistency is recorded rather than quietly
 * tidied: reaching for "and obviously also these" is how a closed allowlist stops being closed,
 * and it is more tempting in a set that looks like a convenience than in one that looks like a
 * control. This set is a control.
 *
 * Case-insensitive, which is not a widening — `LICENSE`, `license` and `License` are one file to
 * whoever wrote it, and the spec's entry is the same entry in each spelling.
 */
const TEXT_NAMES: ReadonlySet<string> = new Set(['license'])

/** §9: refuse over 25 MiB. */
export const MAX_SERVED_BYTES = 25 * 1024 * 1024

/** FT-10: the plain-text pane is for small files. Anything larger downloads instead. */
export const MAX_TEXT_BYTES = 256 * 1024

/**
 * What a file of this name, at this size, may be served as.
 *
 * `size` participates because FT-10's text pane is bounded: a 4 MB `.json` is not a thing to render
 * into a pane, and the honest answer for it is a download rather than a truncated view. The 25 MiB
 * refusal is *not* here — a refusal is not a serving decision, and the server checks it first.
 */
export function servingDecisionFor(fileName: string, size: number): ServingDecision {
  const extension = extensionOf(fileName)

  const inline = INLINE_TYPES.get(extension)
  if (inline !== undefined) return { kind: 'inline', contentType: inline }

  const isText = extension === ''
    ? TEXT_NAMES.has(fileName.toLowerCase())
    : TEXT_EXTENSIONS.has(extension)

  if (isText && size <= MAX_TEXT_BYTES) {
    return { kind: 'text', contentType: 'text/plain; charset=utf-8' }
  }

  return { kind: 'download', contentType: 'application/octet-stream' }
}

/**
 * RFC 6266's `Content-Disposition`, with the filename encoded rather than interpolated.
 *
 * §9 calls this out by name: *"a raw filename in a header is header injection"*. A file called
 * `report.pdf"\r\nSet-Cookie: x=y` is a legal macOS filename and, dropped into a header value
 * unescaped, is two headers.
 *
 * Both forms are emitted, which is what RFC 6266 asks for:
 *
 *   - a plain `filename=` carrying an **ASCII-only, quote-free** fallback, for anything that does
 *     not understand the extended form;
 *   - `filename*=UTF-8''…` percent-encoded, which is the one that actually carries the real name.
 *
 * `encodeURIComponent` is the whole defence for the second: CR, LF, quotes and every non-ASCII byte
 * come out as `%xx`, so there is no sequence left that can terminate a header. The fallback is
 * built by *dropping* everything outside a conservative set rather than escaping it — an escaping
 * bug there would reintroduce exactly what the extended form is avoiding.
 */
export function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  // Conservative on purpose: letters, digits, and four punctuation marks that cannot end a quoted
  // string or start a new header. Everything else, including spaces, becomes `_`.
  const ascii = fileName.replace(/[^A-Za-z0-9._-]/g, '_')
  // An empty or dot-only fallback would produce `filename=""`, so give it something nameable.
  const fallback = /[A-Za-z0-9]/.test(ascii) ? ascii : 'download'
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}
