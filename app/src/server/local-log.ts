/**
 * The local log. Spec §6: *"Full detail goes to the local log."*
 *
 * **This existed as a sentence and nothing else, and the P2 review found it.** `router.ts` caught a
 * handler exception with a bare `catch {}` and discarded it entirely; `listener.ts` computed a
 * correctly-scrubbed validation detail and threw it away. So **a 500 in production was
 * unobservable** — an incident that manifested as an exception left no trace anywhere, which is the
 * thing the mutation log exists to prevent, one layer over.
 *
 * The division of labour, and it is the whole design:
 *
 *   - **The wire says almost nothing.** Stable machine code, fixed message, no stack trace, no path,
 *     no verbatim client string. That is right and must stay right.
 *   - **This says everything.** It is local, it is `0600`, and it is the only place the detail
 *     lives.
 *
 * It is deliberately NOT the mutation log. That log is append-only, outside every registered folder,
 * and designed never to be deleted — it is evidence. This is diagnostics, and mixing the two would
 * put an exception message somewhere permanent, which is how a path or a secret ends up preserved
 * forever.
 */

import type { AppendLog } from '../core/fs/append-log'
import type { Result } from '../core/errors'

export type LocalLevel = 'error' | 'warn' | 'info'

export interface LocalEntry {
  readonly timestamp: string
  readonly level: LocalLevel
  /** What was happening — a route name, a subsystem. Never a client-supplied string. */
  readonly at: string
  /** Free text for a human. This is the field the wire never gets. */
  readonly detail: string
}

export interface LocalLog {
  readonly write: (entry: LocalEntry) => Promise<Result<void>>
  /**
   * Records a caught exception with as much as can be safely extracted.
   *
   * `unknown` because that is what `catch` gives you, and the shapes that arrive are not all
   * `Error`: a thrown string, a rejected non-error, `undefined`. Each is handled rather than
   * assumed away — the P1 review found a control that only worked for the shape its author
   * pictured.
   */
  readonly recordException: (at: string, thrown: unknown) => Promise<Result<void>>
}

/** Everything a thrown value can safely contribute, without assuming it is an Error. */
function describe(thrown: unknown): string {
  if (thrown instanceof Error) {
    const stack = thrown.stack ?? ''
    return `${thrown.name}: ${thrown.message}${stack === '' ? '' : `\n${stack}`}`
  }
  if (typeof thrown === 'string') return `non-Error thrown: ${thrown}`
  if (thrown === undefined) return 'non-Error thrown: undefined'
  if (thrown === null) return 'non-Error thrown: null'
  try {
    return `non-Error thrown: ${JSON.stringify(thrown)}`
  } catch {
    // A thrown object with a circular reference, a BigInt, or a hostile toJSON. The point is to
    // record *that* something was thrown; failing to stringify it must not itself throw and take
    // out the handler that is already handling an error.
    return 'non-Error thrown: unserialisable'
  }
}

export function createLocalLog(
  sink: AppendLog,
  nowIso: () => string = () => new Date().toISOString(),
  /**
   * Where a line goes when the sink itself refuses it. Every caller of `write` discards its
   * Result — correctly, since diagnostics must not fail a request — which meant a sink that could
   * not be written produced silence, and once the sink gained a size cap (2026-09-02) silence became
   * a state the app reaches by design. stderr is what a LaunchAgent captures. Injected so a test can
   * watch it fire.
   *
   * **The entry's `detail` stays out of it.** The detail is the field that may carry a path or an
   * exception message, and this log is `0600` precisely so that field lives nowhere else; a captured
   * stderr file is at launchd's umask. What lands is that a write was dropped, why, and where it was
   * headed — enough to go and look.
   */
  lastResort: (line: string) => void = line => { process.stderr.write(line) },
): LocalLog {
  const write = async (entry: LocalEntry): Promise<Result<void>> => {
    // Newlines are escaped by JSON.stringify, which matters here more than in the mutation log:
    // a stack trace is multi-line by nature and would otherwise be several records.
    const result = await sink.append(JSON.stringify(entry))
    if (!result.ok) {
      lastResort(
        `soil-viewer: local log write failed (${result.code}${result.detail === undefined ? '' : `: ${result.detail}`}) — ` +
        `dropped a ${entry.level} at ${entry.at}\n`,
      )
    }
    return result
  }

  return {
    write,
    recordException: async (at: string, thrown: unknown) =>
      write({ timestamp: nowIso(), level: 'error', at, detail: describe(thrown) }),
  }
}
