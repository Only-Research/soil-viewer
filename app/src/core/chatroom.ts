/**
 * **THE CHATROOM, AS A PARSE.** Spec §14 — *"the user's daily reading surface, and the one they asked
 * to be certain survived."*
 *
 * A chatroom is an ordinary markdown file. Nothing here rewrites it, reformats it, or holds a
 * second copy of it: this module turns bytes into messages for the view, and turns a new message
 * into the bytes to append. The file on disk stays the thing anyone can open in any editor, which
 * is the whole reason the soil keeps conversations as text in the first place.
 *
 * ## The header, exactly
 *
 * > *"Message header: `## M<n> -- <Author>` at line start — two hyphens, spaces either side.
 * > Verified against the real tree; the format is already documented in the soil's own chatroom
 * > protocol. `###` and deeper headings inside a message body are content, never message
 * > boundaries. A `##` line that does not match the pattern is content."*
 *
 * Every clause there is a case this module has to get right, and each one is a way an agent's prose
 * could otherwise be mistaken for structure. A message body that quotes a heading, a message that
 * discusses the format itself, a `##` used as an ordinary heading inside someone's answer — all of
 * them are text, and treating any of them as a boundary would split one person's message in half
 * and attribute the second half to nobody.
 *
 * ## Numbering is read from the file, never from the client
 *
 * > *"The next message number is recomputed **from the file's current bytes at append time**, under
 * > the per-inode lock — never from the client's view."*
 *
 * So `nextNumberIn` takes text and not a count. A phone that has been asleep holds a stale view of
 * the conversation; if it proposed a number, two devices posting a minute apart would both propose
 * the same one and the file would carry two `M7`s. The number is a fact about the bytes.
 *
 * **Highest-plus-one, not count-plus-one.** They differ whenever a message has been edited out by
 * hand, which is a thing a person does to a text file — and count-plus-one would then re-issue a
 * number the conversation has already used, so a reply would point at two different messages.
 */

import { toNFC } from './text'

/**
 * Drops blank lines from both ends of a block, **line by line rather than with a whitespace trim.**
 *
 * The blank line after a header and the blank line before the next one are separators, not content.
 * But `.replace(/^\s+/, '')` would also eat the **indentation of the first line**, which in
 * markdown is the difference between a code block and a paragraph — so a message that opens with an
 * indented block would have its meaning changed by the parser that was only supposed to read it.
 */
function withoutBlankEnds(lines: readonly string[]): string {
  const kept = [...lines]
  while (kept.length > 0 && (kept[0] ?? '').trim() === '') kept.shift()
  while (kept.length > 0 && (kept[kept.length - 1] ?? '').trim() === '') kept.pop()
  return kept.join('\n')
}

export interface ChatMessage {
  /** The `<n>` in `## M<n>`. Not an index — the file's own numbering, gaps and all. */
  readonly number: number
  readonly author: string
  /** Everything between this header and the next one, verbatim, with no trailing blank lines. */
  readonly body: string
}

export interface ChatroomDocument {
  /**
   * Anything before the first message header — a title, a note about the conversation, a template's
   * preamble. Kept rather than dropped: it is content somebody wrote, and a view that discarded it
   * would be showing less than the file holds.
   */
  readonly preamble: string
  readonly messages: readonly ChatMessage[]
}

/**
 * The header pattern, and every piece of it is load-bearing:
 *
 * - `^` with the `m` flag — **at line start**. A `## M1 -- Ada` quoted mid-sentence is prose.
 * - `## ` exactly two hashes. `###` and deeper are content, which the spec states outright.
 * - `M(\d+)` — the number, digits only. `M1a` is not a message header.
 * - ` -- ` two hyphens with a space either side. A single hyphen or an em dash does not match, and
 *   that strictness is deliberate: the soil's protocol writes two, and a looser pattern would start
 *   claiming ordinary headings that happen to contain a dash.
 * - The author runs to end of line and is trimmed. An empty author does not match — a header with
 *   nobody's name on it is not attributable, and attributing it to the empty string would put an
 *   unlabelled bubble in the conversation.
 */
const MESSAGE_HEADER = /^## M(\d+) -- (.+)$/

/**
 * Splits a chatroom's text into its messages.
 *
 * **Line-based rather than a markdown parse**, because the question is not "what does this document
 * mean" but "where does each message start" — and the answer is a property of lines. Running this
 * through a markdown parser would introduce a second opinion about the file's structure, and §8
 * already fixed that a chatroom's *bodies* render through the ordinary renderer. Structure here,
 * meaning there.
 */
export function parseChatroom(text: string): ChatroomDocument {
  const lines = toNFC(text).split('\n')
  const messages: ChatMessage[] = []
  const preamble: string[] = []

  let current: { number: number; author: string; body: string[] } | null = null

  const close = (): void => {
    if (current === null) return
    messages.push({
      number: current.number,
      author: current.author,
      // The blank line after the header and the one before the next message are separators.
      body: withoutBlankEnds(current.body),
    })
    current = null
  }

  for (const line of lines) {
    const header = MESSAGE_HEADER.exec(line)
    if (header !== null) {
      const author = (header[2] ?? '').trim()
      // An author of nothing but whitespace fails the same way an absent one does: this is not a
      // header, so the line is content of whatever message it sits inside.
      if (author !== '') {
        close()
        current = { number: Number(header[1]), author, body: [] }
        continue
      }
    }
    if (current === null) preamble.push(line)
    else current.body.push(line)
  }
  close()

  return { preamble: withoutBlankEnds(preamble), messages }
}

/**
 * The number the next message takes: **the highest already used, plus one.**
 *
 * Not `messages.length + 1`. A conversation someone has edited by hand — deleting a message they
 * posted twice, say — has fewer messages than its highest number, and counting would re-issue a
 * number already spoken for. In a file where people reply to *"as in M7"*, two different M7s is a
 * conversation that cannot be read.
 *
 * An empty or message-less file starts at 1.
 */
export function nextNumberIn(text: string): number {
  const highest = parseChatroom(text).messages
    .reduce((best, message) => (message.number > best ? message.number : best), 0)
  return highest + 1
}

/**
 * The exact bytes an append writes. Nothing else composes this.
 *
 * **A leading newline unless the file already ends in a blank line**, so a message never lands
 * welded to the previous one's last word — and so appending to a file that ends without a trailing
 * newline does not corrupt its final line. The append is `O_APPEND` with no read-modify-write, so
 * this string is the whole of what changes.
 *
 * The author's name and the body are written **verbatim**. A chatroom is prose people wrote; there
 * is no escaping to do here, and §8's renderer is what treats the result as untrusted at display
 * time.
 */
export function appendBlockFor(
  existing: string, number: number, author: string, body: string,
): string {
  // The same line-wise trim the parser uses, so what is written is exactly what is read back.
  const block = `## M${number} -- ${author}\n\n${withoutBlankEnds(body.split('\n'))}\n`
  if (existing === '') return block
  if (existing.endsWith('\n\n')) return block
  if (existing.endsWith('\n')) return `\n${block}`
  return `\n\n${block}`
}
