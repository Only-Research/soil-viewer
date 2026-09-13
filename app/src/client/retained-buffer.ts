/**
 * Retained buffers. Spec §13.8.
 *
 * A retained buffer is an unsaved edit kept locally so a crash, a reload or a closed lid does not
 * lose it. It is the rescue path for §13.5, which makes the rules below data-safety rules rather
 * than storage plumbing.
 *
 * **A RETAINED BUFFER IS NEVER AUTO-REPLAYED.** That is the single most important line in §13.8.
 * On finding one, the app compares the retained identity token against the file's current one and
 * presents explicit resolution — *view diff / save as conflict sibling / discard*. Auto-replay is
 * how a stale buffer silently overwrites work an agent did in the meantime, which is the exact
 * class of loss this build exists to prevent.
 *
 * **IndexedDB, never `localStorage` — on QUOTA grounds only**, and the correction matters. §13.8
 * originally gave two reasons and *the second was false*: it claimed `localStorage` is evicted
 * after 7 days on iOS while IndexedDB is not. **IndexedDB is evicted on the same schedule by the
 * same mechanism.** Moving buys zero eviction immunity. The quota reason is sound on its own —
 * `localStorage` shares a ~5 MB quota, so a large buffer throws and is dropped *silently* — so the
 * decision stands, but the durability belief underneath it did not, and this comment exists so
 * nobody restores it.
 *
 * **Retained buffers are NOT durable on a phone in a plain browser tab.** WebKit deletes all
 * script-writable storage after 7 idle days, and Apple's list names IndexedDB explicitly. The only
 * documented exemption is a Home Screen web app. That is accepted and recorded, not a bug — and the
 * app must *say so* in plain language rather than let it be discovered.
 *
 * The store is injected so every rule below is testable without a browser.
 */

/**
 * **The phone durability notice is CUT (ruled 2026-08-10). §21.**
 *
 * §13.8 required the app to say, in plain language, that unsaved work is only durable on a phone if
 * Soil Viewer is on the Home Screen — WebKit deletes script-writable storage after seven idle days
 * and Apple's list names IndexedDB explicitly. The sentence was written and never shown, and it is
 * now gone rather than left sitting here looking forgotten.
 *
 * Their reasoning, and it is the right answer rather than an override of one: *"I'm just gonna put it
 * on my home screen."* The notice existed to warn about a condition they do not have. A warning
 * about a problem the reader cannot be in is not a safety control, it is a thing to learn to ignore
 * — and this app already has a rule about training people to dismiss dialogs unread.
 *
 * **The seven-day eviction is still real and is not a bug**; what is gone is the sentence. It costs
 * nothing anyway: the buffer covers seconds between typing and saving, so a copy that survives a
 * week has already failed at something else.
 *
 * §13.8/F9.2: "discard corrupt or >256 KB blobs." Restored state is untrusted input. */
export const MAX_BUFFER_BYTES = 256 * 1024

/**
 * How long the editor waits after a keystroke before keeping a local copy.
 *
 * **This MUST be shorter than `AUTOSAVE_QUIET_MS`, and the test beside this file asserts it.** Both
 * timers are armed by the same keystroke, and `doc.changed()` runs before the retain is scheduled —
 * so at equal delays the save fires first, its success discards the buffer, and the retain then
 * writes a *new* buffer immediately afterwards. The result is a rescue copy left behind after every
 * successful save: harmless in the common case, because the next open compares it against a file
 * holding the same text and stays quiet, and wrong in the case that matters, because storage fills
 * with copies of documents the person has already saved.
 *
 * The order this build wants is **keep, then save, then drop.** 400 ms delivers it with 600 ms of
 * headroom, and is short enough that the window in which a crash loses work is a fraction of a
 * second rather than the second the save already costs.
 *
 * Written as a relationship rather than a number is exactly what this codebase failed to do once
 * before: the 1 MB request limit and the 2 MB editability limit were each correct alone, and every
 * file between them could be opened and never saved.
 */
export const RETAIN_QUIET_MS = 400

/**
 * UTF-8 byte length, without Node's `Buffer`.
 *
 * The first version used `Buffer.byteLength`, which **does not exist in a browser** — and every
 * test passed anyway, because vitest runs in a Node environment where the global is present. The
 * suite was structurally incapable of noticing. Found by the P3 review, and the failure it would
 * have produced is the worst available: the editor calls `retain()` on the first keystroke, it
 * throws `ReferenceError`, and every unsaved edit is silently lost — the exact inversion of "a
 * quota failure is never a dropped edit."
 *
 * `TextEncoder` is a web standard, present in browsers and in Node, so this measures the same
 * bytes in both.
 */
const encoder = new TextEncoder()
const utf8Bytes = (value: string): number => encoder.encode(value).length

export interface RetainedBuffer {
  readonly rootId: string
  readonly segments: readonly string[]
  /** The unsaved text. */
  readonly content: string
  /**
   * The identity token the client was last shown for this file. Compared on restore; a mismatch
   * means the file changed underneath and the buffer must NOT be replayed.
   */
  readonly identityToken: string
  readonly savedAtMs: number
}

/** The minimum of IndexedDB this needs. Injected — a real store is wired in the entry. */
export interface BufferStore {
  readonly get: (key: string) => Promise<unknown>
  readonly put: (key: string, value: RetainedBuffer) => Promise<void>
  readonly delete: (key: string) => Promise<void>
  readonly keys: () => Promise<string[]>
}

export type RetainResult =
  | { readonly ok: true }
  /**
   * **A quota failure is a blocking error, never a dropped edit** (§13.8). Silently discarding the
   * buffer is the failure this rule exists to name: the user believes their work is safe.
   */
  | { readonly ok: false; readonly reason: 'quota' | 'too-large' | 'store-failed' }

export type RestoreOutcome =
  /** Nothing retained for this file. */
  | { readonly kind: 'none' }
  /** A buffer whose identity still matches. Offer to restore — still never automatically. */
  | { readonly kind: 'available'; readonly buffer: RetainedBuffer }
  /**
   * A buffer whose identity does NOT match: the file changed while the edit was unsaved. This is
   * the case auto-replay would destroy. Resolution is explicit and the choices are named.
   */
  | { readonly kind: 'stale'; readonly buffer: RetainedBuffer }
  /** Corrupt, oversized, or for a folder that is no longer registered. Discarded. */
  | { readonly kind: 'discarded'; readonly reason: string }

/**
 * The storage key. NUL-delimited, and spelled as an ESCAPE rather than typed.
 *
 * NUL is the one byte a path cannot contain, which makes it the only delimiter that cannot be
 * forged by a filename — a space or a slash would let `a/b.md` and `a`,`b.md` collide. But a typed
 * NUL renders as an ordinary space in every editor and diff, so the first version of this looked
 * like it joined on a space and nobody could have told by reading. Same reasoning as the NUL check
 * in the path validator.
 */
const keyFor = (rootId: string, segments: readonly string[]): string =>
  `${rootId}\u0000${segments.join('\u0000')}`

/** Shape-checks a value read back out of storage. Restored state is untrusted input (F9.2). */
function isBuffer(value: unknown): value is RetainedBuffer {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v['rootId'] === 'string'
    && Array.isArray(v['segments']) && v['segments'].every(s => typeof s === 'string')
    && typeof v['content'] === 'string'
    && typeof v['identityToken'] === 'string'
    && typeof v['savedAtMs'] === 'number'
}

export interface RetainedBuffers {
  readonly retain: (buffer: RetainedBuffer) => Promise<RetainResult>
  /** Never replays. Reports what was found and lets the caller ask. */
  readonly inspect: (
    rootId: string,
    segments: readonly string[],
    currentIdentityToken: string,
    isRegisteredRoot: (rootId: string) => boolean,
  ) => Promise<RestoreOutcome>
  readonly discard: (rootId: string, segments: readonly string[]) => Promise<void>
  /** Drops every buffer for a folder that is no longer registered. */
  readonly forgetRoot: (rootId: string) => Promise<number>
}

export function createRetainedBuffers(store: BufferStore): RetainedBuffers {
  return {
    retain: async (buffer: RetainedBuffer): Promise<RetainResult> => {
      const bytes = utf8Bytes(buffer.content)
      if (bytes > MAX_BUFFER_BYTES) return { ok: false, reason: 'too-large' }

      try {
        await store.put(keyFor(buffer.rootId, buffer.segments), buffer)
        return { ok: true }
      } catch (thrown) {
        // Quota is reported distinctly because the caller must BLOCK on it. §13.8: "a quota failure
        // is a blocking error, never a dropped edit." Swallowing it here would let the user believe
        // their work is safe when nothing was written.
        const name = thrown instanceof Error ? thrown.name : ''
        return { ok: false, reason: name === 'QuotaExceededError' ? 'quota' : 'store-failed' }
      }
    },

    inspect: async (rootId, segments, currentIdentityToken, isRegisteredRoot) => {
      // A buffer for a folder that is no longer registered is not restorable and not evidence of
      // anything. §13.8/F9.2: discard unknown folder ids.
      if (!isRegisteredRoot(rootId)) {
        await store.delete(keyFor(rootId, segments)).catch(() => { /* nothing to discard */ })
        return { kind: 'discarded', reason: 'the folder is no longer registered' }
      }

      let raw: unknown
      try {
        raw = await store.get(keyFor(rootId, segments))
      } catch {
        return { kind: 'discarded', reason: 'the retained buffer could not be read' }
      }

      if (raw === undefined || raw === null) return { kind: 'none' }
      if (!isBuffer(raw)) return { kind: 'discarded', reason: 'the retained buffer was corrupt' }
      if (utf8Bytes(raw.content) > MAX_BUFFER_BYTES) {
        return { kind: 'discarded', reason: 'the retained buffer was too large' }
      }

      // The whole point. A mismatch means the file changed while the edit sat unsaved, and
      // replaying over it would destroy whatever changed it — an agent, another device, the operator.
      return raw.identityToken === currentIdentityToken
        ? { kind: 'available', buffer: raw }
        : { kind: 'stale', buffer: raw }
    },

    discard: async (rootId, segments) => {
      await store.delete(keyFor(rootId, segments))
    },

    forgetRoot: async (rootId: string) => {
      const prefix = `${rootId}\u0000`
      const keys = await store.keys()
      let dropped = 0
      for (const key of keys) {
        // Whole-key prefix on a NUL-delimited key, so `soil` cannot match `soil-archive`. The same
        // segment-boundary reasoning as spec §5, applied to a storage key.
        if (key.slice(0, prefix.length) === prefix) {
          await store.delete(key)
          dropped++
        }
      }
      return dropped
    },
  }
}
