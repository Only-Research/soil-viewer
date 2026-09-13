/**
 * Putting feedback on screen. Annex A27.
 *
 * **`feedback.ts` shipped at P3 with no view at all.** It holds messages, expires toasts, caps the
 * queue and protects banners from being pushed out by a flood of toasts — every rule A27 asks for,
 * correct and mutation-swept — and **nothing rendered any of it.** Every `feedback.banner(...)` in
 * the app went into a list nobody read: the error boundary's report on a tab crash, the tree's
 * "could not read that folder", the folder list failing to load. All invisible.
 *
 * Found when Copy Path needed a confirmation and there was nowhere for one to appear. That is the
 * **fourth** module in this client with the same shape — `document-session.ts` unimported at P6's
 * gate, `call()`'s envelope and its path, and now this. The common cause is stated in
 * `open-items.md` and worth repeating here: a module with no consumer cannot discover that its
 * contract is incomplete, because a contract is only incomplete relative to something relying on
 * it. Its tests were correct. They asserted the list; nobody asserted a screen.
 *
 * ## What A27 specifies, and what is load-bearing in it
 *
 * *"bottom-center pill, radius.full on bg.surface + hairline + shadow.lg, `fadeInUp 0.2s`,
 * auto-dismiss 2500ms, timer keyed on message."*
 *
 * The **dismiss-required banner** is the part that is not decoration. §13.5: *"Data-safety events
 * never use the auto-dismissing toast. Persistent, dismiss-required banners."* A conflict artifact
 * announced by a 2.5-second toast is, on a phone in a pocket, an announcement that did not happen —
 * v1 did exactly that, and it is listed among the six ways its conflict handling lost an edit.
 */

import { append, clear, el } from './dom'
import type { Feedback, FeedbackMessage } from './feedback'

/**
 * Renders the message list into a container, and returns it.
 *
 * Takes a `subscribe` rather than polling: `createFeedback` already reports changes through
 * `onChange`, so the view is driven by the same event the state uses and there is no second
 * source of truth about when to redraw.
 */
export function createFeedbackView(feedback: Feedback): {
  readonly element: HTMLElement
  readonly render: () => void
} {
  const region = el('div', {
    className: 'feedback',
    attributes: {
      /**
       * `status`, not `alert`. A screen reader interrupts for `alert` and announces `status`
       * politely when it finishes what it is saying — and most of what appears here is a
       * confirmation. The one class that should interrupt is a data-safety banner, which gets
       * `role="alert"` on the message itself below.
       */
      role: 'status',
      'aria-live': 'polite',
    },
  })

  const buildMessage = (message: FeedbackMessage): HTMLElement => {
    const node = el('div', {
      className: `feedback-message feedback-${message.kind} feedback-${message.level}`,
      // A banner about a file's state must interrupt; a toast must not.
      ...(message.kind === 'banner' ? { attributes: { role: 'alert' } } : {}),
    })
    // `textContent`. §6: errors render as text, never markdown — and a message can carry a
    // filename, which is agent-written.
    append(node, el('span', { className: 'feedback-text', text: message.text }))

    /**
     * A banner carries its own dismiss control, because **it has no other way to leave.** That is
     * §13.5's requirement rather than a nicety: the message stays until the person acts, so if
     * there is no control, it stays forever and the next one stacks behind it.
     */
    if (message.kind === 'banner') {
      const dismiss = el('button', {
        className: 'feedback-dismiss',
        text: '×',
        attributes: { 'aria-label': 'Dismiss' },
      })
      dismiss.addEventListener('click', () => { feedback.dismiss(message.id) })
      append(node, dismiss)
    }
    return node
  }

  const render = (): void => {
    clear(region)
    for (const message of feedback.messages()) append(region, buildMessage(message))
  }

  render()
  return { element: region, render }
}
