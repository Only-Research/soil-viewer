/**
 * The boundary. Every index row becomes a wire row here and nowhere else.
 *
 * Spec §6 puts one doorway between screen and file engine. This is the half of that doorway that
 * faces outward, and the reason it is a single function rather than a convention is the failure
 * P1 pinned with a test: `JSON.stringify` throws a TypeError on BigInt, and index rows carry three
 * BigInt fields. A conversion that is "done in each handler" is one that is eventually forgotten in
 * one handler, and the symptom is a 500 on a route nobody exercised.
 *
 * So: handlers never touch an `IndexEntry`. They call this.
 */

import type { EntityIdentity } from '../core/entity-token'
import type { IndexEntry } from '../core/index-store'
import type { WireEntry } from './wire'

const NS_PER_MS = 1_000_000n

/**
 * Nanoseconds to milliseconds, for display only.
 *
 * Integer division, deliberately — not `Number(ns) / 1e6`. Converting the BigInt to a Number first
 * would round through a float at the top of the range and hand back a time that is close but not
 * equal, which is the kind of "nearly right" that survives review. Dividing in BigInt space and
 * converting the (small) result is exact.
 *
 * A 2026 nanosecond timestamp is about 1.8e18; divided by a million it is about 1.8e12, four orders
 * of magnitude inside `Number.MAX_SAFE_INTEGER`. The guard below is therefore not expected to fire
 * — it exists because "not expected to fire" is exactly what was said about every silent failure in
 * this build's history, and an unrepresentable timestamp must not become a plausible wrong one.
 */
export function millisecondsFrom(nanoseconds: bigint): number {
  const ms = Number(nanoseconds / NS_PER_MS)
  return Number.isSafeInteger(ms) ? ms : 0
}

/**
 * One index row as the client sees it.
 *
 * Written as an explicit field list rather than a spread of `entry`. A spread would carry `dev`,
 * `ino` and `mtimeNs` straight onto the wire — and would keep carrying whatever field the index
 * gains next, silently. The verbosity is the control: adding a field to the wire has to be a
 * decision made here, in the file whose whole subject is what the client is allowed to see.
 *
 * **`mintToken` is a required parameter and not an optional one, deliberately.** An optional minter
 * with a `''` fallback would let a handler emit rows whose token never matches anything, and §13.8
 * fails *open* in that shape: the mutation route compares a token the client could not have been
 * given, refuses, and the symptom is "the app says everything is stale" rather than a missing
 * control. Making it required turns that into a compile error at the call site instead.
 */
export function toWireEntry(
  entry: IndexEntry,
  mintToken: (identity: EntityIdentity) => string,
): WireEntry {
  return {
    rootId: entry.rootId,
    segments: entry.segments,
    name: entry.name,
    kind: entry.kind,
    title: entry.title,
    size: entry.size,
    modifiedMs: millisecondsFrom(entry.mtimeNs),
    isMarkdown: entry.isMarkdown,
    contentUnavailable: entry.contentUnavailable,
    token: mintToken({ dev: entry.dev, ino: entry.ino }),
  }
}

/**
 * Walks a value and reports every path at which a BigInt appears.
 *
 * This is the structural guard behind the whole decision, and it is exported rather than kept in a
 * test because it is also usable as a last-resort assertion in the response path. The lesson from
 * P1's four rounds is that "we were careful" is not a control: the meta-gate exists because a
 * reviewed, plausible-looking config enforced nothing. A serialisation rule is the same shape of
 * claim, so it gets the same treatment — something checks it, and that something is proven to fire
 * against a known-bad input.
 */
export function bigintPathsIn(value: unknown, path = '$'): string[] {
  if (typeof value === 'bigint') return [path]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((v, i) => bigintPathsIn(v, `${path}[${i}]`))
  return Object.entries(value).flatMap(([k, v]) => bigintPathsIn(v, `${path}.${k}`))
}
