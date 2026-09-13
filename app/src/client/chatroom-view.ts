/**
 * **THE CONVERSATION ON SCREEN.** Spec §14 — *"the user's daily reading surface, and the one they asked
 * to be certain survived."*
 *
 * Three inherited requirements the annex calls out and the spec repeats, because each one is the
 * difference between a conversation you can read and one you fight:
 *
 * > *"Two inherited requirements from the binding annex, both easy to miss: a **jump-to-bottom**
 * > control, and **auto-scroll only when already near the bottom** (never yank the view while
 * > reading history)."*
 *
 * > *"The **copy-path-into-file bar** is part of this surface — it is the affordance the operator
 * > remembered and asked to keep."*
 *
 * The scroll rule is the one that matters most and it is the least obvious. A conversation that
 * scrolls to the bottom on every update is unusable the moment somebody is reading back through it:
 * an agent posts, and the screen jumps away from the paragraph being read. So the view asks where
 * the reader is *before* it redraws, and only follows if they were already at the end.
 */

import { parseChatroom, type ChatMessage } from '../core/chatroom'
import { append, clear, el, setText } from './dom'
import { renderMarkdown, type RenderOptions } from './render/markdown'

/**
 * How close to the end counts as "at the end", in pixels.
 *
 * Not zero: a reader sitting at the bottom of a conversation is rarely at *exactly* the bottom —
 * a trackpad leaves a few pixels, and a message whose last line is half-visible still reads as
 * being at the end. Zero would mean the view stopped following for reasons nobody could see.
 */
export const NEAR_BOTTOM_PX = 120

/**
 * Whether a redraw should scroll to the end.
 *
 * A pure function, and separated for that reason: it is the rule the annex actually states, and
 * everything around it is DOM. A test can ask this directly; it cannot ask a scroll container
 * anything without a browser.
 */
export function shouldFollow(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  // A conversation shorter than its own viewport has nothing to scroll, and is therefore always at
  // the end. Without this the first messages in a new room would never auto-follow.
  if (scrollHeight <= clientHeight) return true
  return scrollHeight - (scrollTop + clientHeight) <= NEAR_BOTTOM_PX
}

/**
 * A stable colour for an author.
 *
 * §14 says *"author colors come from config"*, and there is **no Settings section to set them from
 * yet** — so a config key would be a control with no way to reach it, which is this build's
 * signature failure. Instead the colour is derived from the name, deterministically, from the
 * annex's own palette: the same person is the same colour in every conversation and on both
 * devices, with nothing to configure and nothing to migrate.
 *
 * **The config override is owed, not forgotten.** When Settings grows the section, this becomes the
 * fallback for a name nobody has chosen a colour for — which is the shape it should have had all
 * along, since a conversation gains authors without anyone configuring them.
 */
const AUTHOR_COLOURS = [
  'var(--lane-todo)',
  'var(--lane-doing)',
  'var(--lane-done)',
  'var(--accent-teal)',
  'var(--status-paused)',
  'var(--status-complete)',
]

/**
 * **Keyed on the first word, case-folded** — taken from the reference app, which got this right.
 *
 * It kept two things where this had one: an *identity* (the first word, lowercased) and a *label*
 * (the whole header text). The soil writes `## M4 -- the operator (Conductor)` as readily as
 * `## M2 -- the operator`, and hashing the whole string would give the same person two colours in one
 * conversation — which is worse than no colour, because the colour is what the eye uses to follow a
 * voice down the page.
 *
 * The label is untouched: the header shows exactly what the file says.
 */
export function colourFor(author: string): string {
  const identity = (author.trim().split(/\s+/)[0] ?? author).toLowerCase()
  let hash = 0
  for (const character of identity) hash = (hash * 31 + character.codePointAt(0)!) % 100_000
  return AUTHOR_COLOURS[hash % AUTHOR_COLOURS.length] ?? 'var(--text-secondary)'
}

export interface ChatroomOptions {
  /** Posts a message. Resolves when the append has landed and the file has been re-read. */
  readonly onPost: (body: string) => Promise<void>
  /** The name this device posts under — §7's viewer identity. */
  readonly author: string
  /** Copy Path, which §14 keeps on this surface. Built by the caller so it stays one implementation. */
  readonly copyPath: () => HTMLElement
  /** How the renderer resolves destinations. Passed through untouched. */
  readonly render?: RenderOptions
}

export interface ChatroomView {
  /** Redraws from new text, following the reader's position per the annex's rule. */
  readonly update: (text: string) => void
}

/**
 * Mounts the conversation into `host` and returns a handle that can redraw it.
 *
 * **The composer is outside the scroller.** It has to be: a composer inside the scrolling region
 * moves away as the conversation grows, and the one thing that must never move is the box you are
 * typing into.
 */
export function mountChatroom(
  host: HTMLElement, text: string, options: ChatroomOptions,
): ChatroomView {
  clear(host)

  const bar = el('div', { className: 'chat-bar' })
  append(bar, options.copyPath())

  const scroller = el('div', { className: 'chat-scroller' })
  const list = el('div', { className: 'chat-messages' })
  append(scroller, list)

  /**
   * The jump-to-bottom control, hidden while the reader is already there. Annex, via §14 — and it
   * is the other half of the scroll rule: the view stops following when you read back, so it has to
   * offer a way to return that does not involve dragging.
   */
  const jump = el('button', {
    className: 'chat-jump',
    text: 'Jump to latest',
    attributes: { type: 'button', hidden: 'true' },
  })
  jump.addEventListener('click', () => {
    scroller.scrollTop = scroller.scrollHeight
    jump.toggleAttribute('hidden', true)
  })

  const composer = el('div', { className: 'chat-composer' })
  const field = el('textarea', {
    className: 'chat-field',
    attributes: { rows: '3', 'aria-label': `Post as ${options.author}` },
  }) as HTMLTextAreaElement
  const post = el('button', {
    className: 'chat-post', text: 'Post', attributes: { type: 'button' },
  })
  append(composer, field, post)

  append(host, bar, scroller, jump, composer)

  const paint = (source: string): void => {
    /**
     * **Asked BEFORE the redraw**, because afterwards the numbers describe the new content and the
     * question — *was the reader at the end* — is about the old.
     */
    const follow = shouldFollow(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)

    const document_ = parseChatroom(source)
    clear(list)

    if (document_.preamble !== '') {
      const preamble = el('div', { className: 'chat-preamble' })
      append(preamble, renderMarkdown(document_.preamble, options.render))
      append(list, preamble)
    }

    for (const message of document_.messages) append(list, messageElement(message, options))

    if (document_.messages.length === 0 && document_.preamble === '') {
      append(list, el('div', {
        className: 'chat-empty',
        // §15's written empty state. It says what the file is and what happens next, rather than
        // "no messages" — a conversation nobody has spoken in looks identical to one that failed.
        text: 'Nothing has been said here yet. Anything posted below is appended to this file.',
      }))
    }

    if (follow) scroller.scrollTop = scroller.scrollHeight
    jump.toggleAttribute('hidden', follow)
  }

  scroller.addEventListener('scroll', () => {
    jump.toggleAttribute(
      'hidden',
      shouldFollow(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight),
    )
  })

  const submit = (): void => {
    const said = field.value.trim()
    if (said === '') return
    /**
     * Cleared before the round trip, not after. The next thing anyone does is type the next
     * message, and leaving the last one in the box is how two of them end up as one.
     */
    field.value = ''
    void options.onPost(said)
  }
  post.addEventListener('click', submit)
  field.addEventListener('keydown', event => {
    const key = event as KeyboardEvent
    /**
     * **Enter makes a newline; Cmd/Ctrl+Enter posts.** The opposite of a chat app, and deliberate:
     * these messages are prose with paragraphs and lists in them, and a composer that posts on
     * Enter cannot write the second line of anything.
     */
    if (key.key !== 'Enter' || !(key.metaKey || key.ctrlKey)) return
    event.preventDefault()
    submit()
  })

  paint(text)
  return { update: paint }
}

function messageElement(message: ChatMessage, options: ChatroomOptions): HTMLElement {
  const item = el('div', { className: 'chat-message' })

  const header = el('div', { className: 'chat-message-header' })
  const author = el('span', { className: 'chat-author' })
  setText(author, message.author)
  author.setAttribute('style', `color: ${colourFor(message.author)}`)
  const number = el('span', { className: 'chat-number' })
  setText(number, `M${message.number}`)
  append(header, author, number)

  const body = el('div', { className: 'chat-body' })
  /**
   * **A message body is a fragment, and says so.** It is a slice from the middle of the file, so a
   * `---` at the top of it is a thematic break somebody typed — not properties. The preamble above
   * is the opposite case and passes nothing: it *is* the head of the document, which is exactly
   * where a chatroom's frontmatter lives.
   */
  append(body, renderMarkdown(message.body, { ...options.render, fragment: true }))

  append(item, header, body)
  return item
}
