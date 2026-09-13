/**
 * The feedback channel — toasts and banners. Annex A27.
 *
 * A store rather than a component, so the rule that matters is testable without a DOM: **a
 * data-safety message must not be able to disappear on its own.**
 *
 * A27 names a persistent, dismiss-required variant specifically because the ordinary toast is
 * wrong for anything about the user's files. A conflict artifact was written; a save failed; a file
 * could not be read. If that message fades after four seconds and they were looking at their phone, the
 * event is gone and the only record is a log they have no reason to open. **Auto-dismiss is a
 * property of unimportant messages, and this build has a history of important things presenting
 * quietly.**
 */

export type FeedbackLevel = 'info' | 'success' | 'warning' | 'danger'

export type FeedbackKind =
  /** Fades on its own. For things that do not matter if missed. */
  | 'toast'
  /**
   * Stays until dismissed by hand. For anything about the state of a file.
   *
   * Never given a timeout, and not merely "given a long one" — a long timeout is still a timeout,
   * and the failure it produces is invisible by construction.
   */
  | 'banner'

export interface FeedbackMessage {
  readonly id: string
  readonly kind: FeedbackKind
  readonly level: FeedbackLevel
  /** Plain text. Rendered with `textContent` — spec §6: errors render as text, never markdown. */
  readonly text: string
  /** Present only on a toast. A banner has none, by type and by construction. */
  readonly timeoutMs?: number
}

export interface FeedbackOptions {
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly onChange?: (messages: readonly FeedbackMessage[]) => void
  /** Injected so ids are deterministic in tests and never collide in production. */
  readonly nextId?: () => string
}

/**
 * Annex A27, verbatim: `auto-dismiss 2500ms`.
 *
 * Was 4000 — a number I chose rather than transcribed, in a section headed "verbatim values
 * (preserve exactly)". The P3 review caught it, and it was the ONLY hard drift against §C in the
 * whole phase. Small, and exactly the drift §C exists to prevent: the inherited design language is
 * the one part of the old app that was unambiguously good, and it goes generic one improved value
 * at a time.
 */
export const TOAST_MS = 2_500

/**
 * The cap. Beyond this the oldest TOAST is dropped — never a banner.
 *
 * A flood of toasts must not be able to push a data-safety banner off the screen. That would be a
 * denial of service against the one message class that cannot be re-derived.
 */
export const MAX_MESSAGES = 6

export interface Feedback {
  readonly toast: (level: FeedbackLevel, text: string) => string
  /** A message that stays until dismissed. Use for anything about a file's state. */
  readonly banner: (level: FeedbackLevel, text: string) => string
  readonly dismiss: (id: string) => void
  readonly dismissAll: () => void
  readonly messages: () => readonly FeedbackMessage[]
}

export function createFeedback(options: FeedbackOptions = {}): Feedback {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as never) })

  let counter = 0
  const nextId = options.nextId ?? (() => `m${++counter}`)

  const messages: FeedbackMessage[] = []
  const timers = new Map<string, unknown>()

  const announce = (): void => { options.onChange?.([...messages]) }

  const remove = (id: string): boolean => {
    const index = messages.findIndex(m => m.id === id)
    if (index === -1) return false
    messages.splice(index, 1)
    const timer = timers.get(id)
    if (timer !== undefined) { clearTimer(timer); timers.delete(id) }
    return true
  }

  const add = (message: FeedbackMessage): string => {
    messages.push(message)

    if (messages.length > MAX_MESSAGES) {
      // Drop the oldest TOAST. If there is none, the banners stay and the cap is exceeded — which
      // is the right trade: a screen with seven banners is a problem, a screen missing the one
      // saying a save failed is a lost file.
      const oldestToast = messages.findIndex(m => m.kind === 'toast')
      if (oldestToast !== -1) {
        const victim = messages[oldestToast]
        if (victim !== undefined) remove(victim.id)
      }
    }

    if (message.kind === 'toast' && message.timeoutMs !== undefined) {
      timers.set(message.id, setTimer(() => {
        timers.delete(message.id)
        if (remove(message.id)) announce()
      }, message.timeoutMs))
    }

    announce()
    return message.id
  }

  return {
    toast: (level, text) => add({ id: nextId(), kind: 'toast', level, text, timeoutMs: TOAST_MS }),

    // No timeout is passed, and none can be: `banner` takes no duration, so a caller cannot give
    // one even by mistake. That is the difference between a rule and a convention.
    banner: (level, text) => add({ id: nextId(), kind: 'banner', level, text }),

    dismiss: id => { if (remove(id)) announce() },

    dismissAll: () => {
      for (const timer of timers.values()) clearTimer(timer)
      timers.clear()
      messages.length = 0
      announce()
    },

    messages: () => [...messages],
  }
}
