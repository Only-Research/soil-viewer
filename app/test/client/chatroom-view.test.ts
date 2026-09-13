import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mountChatroom } from '../../src/client/chatroom-view'
import { el } from '../../src/client/dom'
import { FakeElement, installFakeDocument, removeFakeDocument } from '../support/fake-dom'

/**
 * **THE CONVERSATION SURFACE, ASKED WHERE IT PUTS THE DOCUMENT BOUNDARY.**
 *
 * `markdown.test.ts` proves the renderer handles frontmatter correctly and proves it obeys
 * `fragment`. Neither of those says anything about **who passes it**, and that gap is this build's
 * signature failure written out in full: an option that is correct, tested, and handed over by
 * nobody — or handed over by the wrong caller, which is worse, because it looks connected.
 *
 * There are exactly two calls into the renderer from this surface and they must disagree:
 *
 * - **the preamble is the head of the file**, so a `---` block at the top of it is properties;
 * - **a message body is a slice from the middle**, so a `---` in it is a rule somebody typed.
 *
 * Both are asserted here, in one mount, on one document — because a suite that tested them in
 * separate fixtures would pass with both calls doing the same thing.
 */

const host = (): FakeElement => el('div') as unknown as FakeElement

const mount = (text: string): FakeElement => {
  const into = host()
  mountChatroom(into as unknown as HTMLElement, text, {
    onPost: async () => { /* nothing is posted in these cases */ },
    author: 'Ines',
    copyPath: () => el('div', { className: 'copy-path' }),
  })
  return into
}

beforeEach(installFakeDocument)
afterEach(removeFakeDocument)

describe('§12/§14 — the preamble is a document head, a message body is not', () => {
  /**
   * One room carrying both cases. The frontmatter is real; the `---` pair inside M2 is a person
   * using a thematic break in the middle of a conversation, which is ordinary and must stay visible.
   */
  const ROOM = [
    '---',
    'title: RT1 chatroom',
    'status: blocked',
    '---',
    '',
    '# Chatroom — RT1',
    '',
    '## M1 -- Ada',
    '',
    'Opening this one.',
    '',
    '## M2 -- Ellis',
    '',
    '---',
    '',
    'A break, then the point.',
    '',
    '---',
    '',
  ].join('\n')

  it('collapses the file\'s frontmatter and nothing else', () => {
    const out = mount(ROOM)
    const blocks = out.byClass('md-frontmatter')
    /**
     * **Exactly one**, and the count is the assertion. Two would mean the message body was read as a
     * document; zero would mean the preamble was read as a fragment. Either way the number says
     * which call is wrong, which a boolean would not.
     */
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text()).toContain('title: RT1 chatroom')
  })

  it('puts that block in the preamble, not in a message', () => {
    const out = mount(ROOM)
    const preamble = out.byClass('chat-preamble')[0]
    expect(preamble?.byClass('md-frontmatter')).toHaveLength(1)
    for (const message of out.byClass('chat-message')) {
      expect(message.byClass('md-frontmatter'), 'a message swallowed its own text').toHaveLength(0)
    }
  })

  it('leaves the rules a person typed inside a message as rules', () => {
    const out = mount(ROOM)
    const second = out.byClass('chat-message')[1]
    expect(second?.byTag('hr')).toHaveLength(2)
    expect(second?.text()).toContain('A break, then the point.')
  })

  /**
   * The heading the bug produced, asserted by its absence at the surface rather than in the
   * renderer. This is the sentence the operator would have read across the top of the pane in 32px type,
   * and the reason the fix exists.
   */
  it('shows no heading made out of the frontmatter', () => {
    const out = mount(ROOM)
    const headings = [...out.byTag('h1'), ...out.byTag('h2')].map(node => node.text())
    expect(headings).toEqual(['Chatroom — RT1'])
  })

  it('still shows every message, numbered and attributed', () => {
    const out = mount(ROOM)
    expect(out.byClass('chat-message')).toHaveLength(2)
    expect(out.byClass('chat-author').map(node => node.text())).toEqual(['Ada', 'Ellis'])
    expect(out.byClass('chat-number').map(node => node.text())).toEqual(['M1', 'M2'])
  })
})
