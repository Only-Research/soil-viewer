import { describe, expect, it } from 'vitest'

import { appendBlockFor, nextNumberIn, parseChatroom } from '../../src/core/chatroom'
import { isChatroom, isChatroomName } from '../../src/core/grammar'

/**
 * The chatroom's grammar and its parse. Spec §14.
 *
 * **This is the user's daily reading surface** — their words, and the one they asked to be certain
 * survived. Everything here is about not mistaking prose for structure: a conversation whose
 * messages split in the wrong place attributes half of what somebody said to somebody else, and it
 * does it silently, on the surface they read most.
 */

describe('§14 — the match is an equality, never a glob', () => {
  it('renders only a file named exactly chatroom.md', () => {
    expect(isChatroomName('chatroom.md')).toBe(true)
    // Case-folded and NFC-normalised, as the spec says.
    expect(isChatroomName('Chatroom.MD')).toBe(true)
  })

  /**
   * **The two files the spec names, and they are not hypothetical.** The soil's own chatroom
   * protocol lives in one of them. A glob would render the document that *explains* the message
   * format as an unreadable conversation whose every example heading became a message — and that
   * document is how anyone learns the format.
   */
  it('leaves chatroom-protocol.md and chatroom-template.md as ordinary documents', () => {
    expect(isChatroomName('chatroom-protocol.md')).toBe(false)
    expect(isChatroomName('chatroom-template.md')).toBe(false)
    expect(isChatroomName('chatroom.markdown')).toBe(false)
    expect(isChatroomName('my-chatroom.md')).toBe(false)
    expect(isChatroomName('chatroom.md.bak')).toBe(false)
  })

  /**
   * §13.5 and §14: *"a conflict artifact of a chatroom is never itself a chatroom."* Without this,
   * a conflict on a conversation renders as a second conversation with its own composer, appending
   * into a file nobody is reading — the C5 shape that has already appeared once, on inbox items.
   */
  it('never treats a conflict artifact as a chatroom', () => {
    expect(isChatroomName('chatroom (conflict 2026-08-11).md')).toBe(false)
  })

  it('excludes archived conversations, like every other grammar predicate', () => {
    expect(isChatroom(['02-projects', 'orchard', 'chatroom.md'])).toBe(true)
    expect(isChatroom(['archive', 'orchard', 'chatroom.md'])).toBe(false)
  })
})

describe('§14 — what is a message boundary and what is prose', () => {
  it('reads the headers the soil actually writes', () => {
    const doc = parseChatroom([
      '# Orchard planning',
      '',
      '## M1 -- Ada',
      '',
      'The first thing.',
      '',
      '## M2 -- Ellis',
      '',
      'The second thing.',
      '',
    ].join('\n'))

    expect(doc.preamble).toBe('# Orchard planning')
    expect(doc.messages).toEqual([
      { number: 1, author: 'Ada', body: 'The first thing.' },
      { number: 2, author: 'Ellis', body: 'The second thing.' },
    ])
  })

  /**
   * **The clause most likely to be got wrong, and the most expensive.** A message that contains
   * headings is ordinary — people structure long answers. Treating `###` as a boundary would cut
   * one person's message into pieces and hand the pieces to nobody.
   */
  it('keeps deeper headings inside a body as content', () => {
    const doc = parseChatroom([
      '## M1 -- Ada',
      '',
      '### What I found',
      '',
      'Something.',
      '',
      '#### Detail',
      '',
      'More.',
    ].join('\n'))

    expect(doc.messages).toHaveLength(1)
    expect(doc.messages[0]?.body).toContain('### What I found')
    expect(doc.messages[0]?.body).toContain('#### Detail')
  })

  /** *"A `##` line that does not match the pattern is content."* Stated in the spec, asserted here. */
  it('keeps a plain ## heading inside a body as content', () => {
    const doc = parseChatroom([
      '## M1 -- Ada',
      '',
      '## Notes',
      '',
      'Under an ordinary heading.',
    ].join('\n'))

    expect(doc.messages).toHaveLength(1)
    expect(doc.messages[0]?.body).toContain('## Notes')
  })

  /**
   * Every near-miss of the header, each one a way prose could be mistaken for structure. The
   * separator is **two hyphens with a space either side** because that is what the soil's protocol
   * writes; a looser pattern would start claiming ordinary headings that happen to contain a dash.
   */
  it('refuses every near-miss of the header', () => {
    const nearMisses = [
      '## M1 - Ada',          // one hyphen
      '## M1 — Ada',          // em dash
      '## M1--Ada',           // no spaces
      '## M1 --',              // no author
      '## M1 --   ',           // an author of whitespace
      '## M -- Ada',          // no number
      '## M1a -- Ada',        // not digits
      '### M1 -- Ada',        // three hashes
      '#M1 -- Ada',           // no space after the hashes
      ' ## M1 -- Ada',        // indented, so not at line start
    ]
    for (const line of nearMisses) {
      const doc = parseChatroom(`${line}\n\nbody\n`)
      expect(doc.messages, `"${line}" was read as a message header`).toHaveLength(0)
    }
  })

  it('keeps a header quoted mid-sentence as prose', () => {
    const doc = parseChatroom('## M1 -- Ada\n\nThe format is `## M2 -- Ada` and it is at line start.\n')
    expect(doc.messages).toHaveLength(1)
    expect(doc.messages[0]?.body).toContain('## M2 -- Ada')
  })

  it('keeps everything before the first message, rather than dropping it', () => {
    const doc = parseChatroom('Some notes about this conversation.\n\n## M1 -- Ada\n\nHello.\n')
    expect(doc.preamble).toBe('Some notes about this conversation.')
  })

  it('reads a file with no messages at all as pure preamble', () => {
    const doc = parseChatroom('# Just a document\n\nNothing here is a message.\n')
    expect(doc.messages).toEqual([])
    expect(doc.preamble).toContain('Nothing here is a message.')
  })
})

describe('§14 — the next number is a fact about the bytes', () => {
  it('starts at 1 on an empty or message-less file', () => {
    expect(nextNumberIn('')).toBe(1)
    expect(nextNumberIn('# A document\n\nwith no messages\n')).toBe(1)
  })

  it('is the highest already used plus one', () => {
    expect(nextNumberIn('## M1 -- A\n\nx\n\n## M2 -- B\n\ny\n')).toBe(3)
  })

  /**
   * **Highest-plus-one, not count-plus-one**, and the difference is not academic: a text file is a
   * thing people edit by hand. Delete a message you posted twice and the count no longer matches
   * the numbering — count-plus-one would then re-issue a number the conversation has already used,
   * and a reply saying *"as in M7"* would point at two different messages.
   */
  it('does not re-issue a number after a message was removed by hand', () => {
    const withAGap = '## M1 -- A\n\nx\n\n## M7 -- B\n\ny\n'
    expect(parseChatroom(withAGap).messages).toHaveLength(2)
    expect(nextNumberIn(withAGap)).toBe(8)
  })
})

describe('§14 — the bytes an append writes', () => {
  it('writes the header the parser reads back', () => {
    const block = appendBlockFor('', 1, 'Ellis', 'Hello.')
    expect(block).toBe('## M1 -- Ellis\n\nHello.\n')
    // The round trip is the assertion that matters: what is written must be what is read.
    expect(parseChatroom(block).messages).toEqual([
      { number: 1, author: 'Ellis', body: 'Hello.' },
    ])
  })

  /**
   * The separator cases. An append is `O_APPEND` with no read-modify-write, so this string is the
   * entire change — and a file that does not end in a newline would otherwise have its last line
   * welded to the new header.
   */
  it('never welds itself to whatever the file ended with', () => {
    expect(appendBlockFor('x', 2, 'A', 'y')).toBe('\n\n## M2 -- A\n\ny\n')
    expect(appendBlockFor('x\n', 2, 'A', 'y')).toBe('\n## M2 -- A\n\ny\n')
    expect(appendBlockFor('x\n\n', 2, 'A', 'y')).toBe('## M2 -- A\n\ny\n')
  })

  it('round-trips through a file that already holds messages', () => {
    const before = '## M1 -- Ada\n\nFirst.\n'
    const after = before + appendBlockFor(before, nextNumberIn(before), 'Ellis', 'Second.')
    expect(parseChatroom(after).messages).toEqual([
      { number: 1, author: 'Ada', body: 'First.' },
      { number: 2, author: 'Ellis', body: 'Second.' },
    ])
  })

  it('carries a body that contains headings without breaking the parse', () => {
    const body = '### A heading\n\nand a `## M9 -- Nobody` in a code span'
    const block = appendBlockFor('', 1, 'Ada', body)
    const parsed = parseChatroom(block)
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0]?.body).toBe(body)
  })
})

describe('§14 — the parser does not change what a message means', () => {
  /**
   * **The reason the blank-line trim is line-wise and not a whitespace regex.**
   *
   * In markdown, four leading spaces is a code block. A trim that ate the indentation of the first
   * line would turn a code block into a paragraph — the parser silently changing what somebody
   * wrote, on the surface the operator reads most. Without this case that distinction is invisible:
   * every other body here starts at column zero, so both implementations agree.
   */
  it('keeps the indentation of a body that opens with a code block', () => {
    const body = '    npm run serve\n    # and a comment'
    const doc = parseChatroom(`## M1 -- Ada\n\n${body}\n`)
    expect(doc.messages[0]?.body).toBe(body)
  })

  it('keeps the indentation of a preamble that opens with one too', () => {
    const doc = parseChatroom('    indented preamble\n\n## M1 -- Ada\n\nx\n')
    expect(doc.preamble).toBe('    indented preamble')
  })

  it('keeps blank lines INSIDE a body, which are paragraph breaks', () => {
    const body = 'First paragraph.\n\nSecond paragraph.'
    const doc = parseChatroom(`## M1 -- Ada\n\n${body}\n\n## M2 -- Ada\n\nx\n`)
    expect(doc.messages[0]?.body).toBe(body)
  })

  it('round-trips an indented body through an append', () => {
    const body = '    a code block\n\n    and another'
    const block = appendBlockFor('', 1, 'Ada', body)
    expect(parseChatroom(block).messages[0]?.body).toBe(body)
  })
})
