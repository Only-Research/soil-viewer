/**
 * Reading a request body, safely.
 *
 * Written against an async iterable of chunks rather than an `IncomingMessage`, so the dangerous
 * cases can be tested without a socket: a lying `Content-Length`, a body that keeps arriving after
 * the cap, a chunk that lands exactly on the boundary, a truncated multi-byte character.
 *
 * THREE RULES, and each one is a way this goes wrong:
 *
 *   1. **The cap is enforced while streaming, not after.** Checking length after buffering means
 *      the memory was already spent — the check would report the attack it just absorbed.
 *   2. **`Content-Length` is used only to refuse early, never to trust.** A declared length under
 *      the cap does not license reading an unbounded body; the streaming cap still governs. A
 *      declared length *over* the cap lets us refuse before reading a byte, which is worth having.
 *   3. **A parse failure is a typed refusal, never a thrown exception that becomes a 500** — and
 *      never an empty object. Spec §6: "An empty-but-successful result never stands in for a
 *      failure."
 */

import { TransportErrorCode } from '../contract/wire'

export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: TransportErrorCode; readonly reason: string }

const refuse = (code: TransportErrorCode, reason: string): BodyResult => ({ ok: false, code, reason })

/**
 * Parses a declared `Content-Length`.
 *
 * Refuses anything that is not a plain run of ASCII digits. `Number()` would accept `'1e9'`,
 * `' 12 '`, `'0x10'` and `'+5'`, and a header parser that disagrees with the framing layer about a
 * length is the foundation of request smuggling. Absent is fine — chunked encoding has no length.
 */
export function declaredLength(raw: string | string[] | undefined): number | null | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) return null // repeated Content-Length: refuse, never pick one
  if (!/^[0-9]+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

export interface ReadBodyOptions {
  readonly maxBytes: number
  readonly contentLength?: string | string[] | undefined
}

/**
 * Reads at most `maxBytes`, then parses as JSON.
 *
 * Returns the parsed value, or a typed refusal. Never throws for input reasons — a caller that has
 * to wrap this in a try/catch would eventually forget to, and the catch would become the 500 that
 * hides a 400.
 */
export async function readJsonBody(
  chunks: AsyncIterable<Buffer | Uint8Array>,
  options: ReadBodyOptions,
): Promise<BodyResult> {
  const declared = declaredLength(options.contentLength)
  if (declared === null) {
    return refuse(TransportErrorCode.BAD_REQUEST, 'malformed or repeated Content-Length')
  }
  if (declared !== undefined && declared > options.maxBytes) {
    // Refused before a byte is read. The streaming cap below still governs regardless, because a
    // declared length is a claim and not a fact.
    return refuse(TransportErrorCode.PAYLOAD_TOO_LARGE, 'declared length over cap')
  }

  const collected: Buffer[] = []
  let total = 0
  for await (const chunk of chunks) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > options.maxBytes) {
      // Stop here. Not after the loop — by then the memory is already committed, which is the
      // thing the limit exists to prevent.
      return refuse(TransportErrorCode.PAYLOAD_TOO_LARGE, 'body over cap')
    }
    collected.push(buffer)
  }

  // A body that is shorter than it promised is a truncated request, not an empty document. Spec §6
  // again: a failure must not arrive looking like a success.
  if (declared !== undefined && total !== declared) {
    return refuse(TransportErrorCode.BAD_REQUEST, 'body length did not match Content-Length')
  }

  if (total === 0) {
    // An empty body is not `{}`. A route whose validator accepts an empty object should receive an
    // explicit `{}` from the client; inventing one here would let a bodyless request satisfy a
    // schema by accident.
    return refuse(TransportErrorCode.BAD_REQUEST, 'empty body')
  }

  const bytes = Buffer.concat(collected, total)
  const text = bytes.toString('utf8')

  /**
   * **The test is a round trip, not a search for U+FFFD — and the difference is a data-loss bug.**
   *
   * `Buffer.toString('utf8')` substitutes U+FFFD for invalid sequences rather than throwing, so a
   * malformed body would otherwise parse into plausible-looking nonsense. That reasoning is right
   * and the check it produced was wrong: it asked whether the decoded text *contains* U+FFFD, and
   * U+FFFD is an ordinary, valid code point that documents legitimately hold — mojibake from an
   * older import, a note discussing Unicode, anything pasted out of a tool that had already lost
   * some bytes.
   *
   * **What that cost:** such a file loads (`editabilityRefusal` correctly judges it editable, since
   * its bytes round-trip) and can then never be saved. Every autosave is refused `BAD_REQUEST`, the
   * session stays dirty, and the loop repeats for as long as the document is open. `chatroom.append`
   * was affected identically — a message containing the character could not be posted.
   *
   * Re-encoding and comparing bytes distinguishes the two cases exactly: text that decoded losslessly
   * encodes back to what arrived, and text that lost bytes to substitution does not. It is the same
   * rule `compare.cjs` uses to decide whether a file is scoreable at all, and the same rule
   * `editabilityRefusal` already applies at load — so the two gates now agree, which is why a file
   * could be admitted by one and refused forever by the other.
   */
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    return refuse(TransportErrorCode.BAD_REQUEST, 'body is not valid UTF-8')
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    // The parse error's message quotes the offending input. Spec §6 bars verbatim client strings
    // from responses, so it is discarded here rather than carried and filtered later.
    return refuse(TransportErrorCode.BAD_REQUEST, 'body is not valid JSON')
  }
}
