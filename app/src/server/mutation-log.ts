/**
 * The mutation log. Spec §7's compensating control for device trust.
 *
 * *"Without this, device trust means no incident is ever detectable — under a token, a stolen token
 * at least leaves a trail."* The app has no login and no device pairing by the decision, so
 * this log is the entire answer to "how would we ever know?".
 *
 * **The token must never appear here.** Spec §7 token property 4: *"never written to the mutation
 * log, never to an error message, never to a stack trace, and never to any other log"* — and §20
 * adds the acceptance test by name: assert the token's value appears nowhere in the mutation log
 * after a mutation. This log "is designed never to be deleted", so a token that lands in it is
 * recorded permanently.
 *
 * The defense is structural, not a redaction pass. `record()` takes **named fields**, never a
 * headers object, so there is no value for the token to arrive in. A redaction step would be a
 * filter that has to know every name the secret might travel under; not accepting the container is
 * a property of the type signature. The test still asserts the absence, because a structural
 * argument that nothing checks is exactly what this build keeps disproving.
 */

import type { AppendLog } from '../core/fs/append-log'
import type { Result } from '../core/errors'

/**
 * One record. Every field spec §7 enumerates, and nothing else.
 *
 * `sourceAddress` is recorded because the spec asks for it, and it is worth restating that it is
 * **evidence, not authorization** — §7 is explicit that privilege is decided by which listener
 * accepted the connection. Behind `tailscale serve` this is always loopback, which is precisely why
 * `tailscaleUserLogin` is recorded alongside it.
 */
export interface MutationRecord {
  readonly timestamp: string
  readonly method: string
  readonly route: string
  readonly rootId: string | null
  readonly relativePath: string | null
  readonly sourceAddress: string | null
  readonly forwardedFor: string | null
  readonly tailscaleUserLogin: string | null
  readonly origin: string | null
  readonly outcome: 'ok' | 'refused' | 'error'
  /** The refusal or error code, when there is one. Never a message, never an exception. */
  readonly code: string | null
}

/**
 * Serialises one record as a single JSON line.
 *
 * JSON rather than a delimited format because a path can contain any character except NUL and a
 * separator, and a log whose fields can be forged by putting a comma in a filename is not evidence.
 * `JSON.stringify` escapes newlines, so a crafted filename cannot inject a second record — and the
 * writer refuses a line containing a newline anyway, which is the belt to this brace.
 */
export function serialiseRecord(record: MutationRecord): string {
  return JSON.stringify(record)
}

export interface MutationLog {
  /**
   * Records one entry. **The caller must abort the operation if this fails** — spec §7: "A failed
   * log write fails the operation." Returning a Result rather than throwing keeps that decision at
   * the call site, where the operation can actually be abandoned.
   */
  readonly record: (record: MutationRecord) => Promise<Result<void>>
}

export function createMutationLog(sink: AppendLog): MutationLog {
  return {
    record: async (record: MutationRecord) => sink.append(serialiseRecord(record)),
  }
}
