import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { colourFor } from '../../../src/client/chatroom-view'
import { renderMarkdown } from '../../../src/client/render/markdown'
import { FakeElement, installFakeDocument, removeFakeDocument } from '../../support/fake-dom'

/**
 * **THE RENDERER, WHICH SHOWS WHAT AGENTS WROTE.** Spec §8, §19.
 *
 * Two properties outrank everything else here and the cases are ordered by them.
 *
 * **Nothing may run.** The content is agent-written and the app's own origin holds file access, so
 * every destination is asked about rather than assumed, and nothing remote is ever fetched. The
 * decisions themselves live in `url-safety.ts` — what is tested here is that this file *obeys* them,
 * because a renderer that made its own scheme judgement would be the second implementation of a rule
 * that exists to have exactly one.
 *
 * **Nothing may be lost.** §19: *a construct the renderer doesn't style is displayed unstyled,
 * never damaged.* A dropped character is invisible in a structural assertion, so most cases below
 * assert on the **whole text of the output** rather than on its shape.
 */

const render = (text: string, options?: Parameters<typeof renderMarkdown>[1]): FakeElement =>
  renderMarkdown(text, options) as unknown as FakeElement

beforeEach(installFakeDocument)
afterEach(removeFakeDocument)

describe('§8 — a destination is never trusted, and never decided here', () => {
  it('makes an ordinary external link, in a new tab and unable to reach back', () => {
    const out = render('[the docs](https://example.com/page)')
    const anchor = out.byTag('a')[0]
    expect(anchor?.getAttribute('href')).toBe('https://example.com/page')
    // §8, verbatim: external links open in a new tab with rel="noopener noreferrer" and never
    // navigate the app tab. A link that replaced this tab would take the editor with it.
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(anchor?.text()).toBe('the docs')
  })

  /**
   * The three shapes §8 names by hand. None of them is decided in the renderer — it asks
   * `treatmentFor` — so what is asserted is that an inert answer produces **no anchor at all**,
   * rather than an anchor that is styled to look disabled.
   */
  it('renders a javascript: destination as text, with no anchor anywhere', () => {
    for (const hostile of [
      '[x](javascript:alert(1))',
      '[x](java\tscript:alert(1))',
      '[x](&#106;avascript:alert(1))',
      '[x](//example.com/remote)',
      '[x](data:text/html,<script>1</script>)',
    ]) {
      const out = render(hostile)
      expect(out.byTag('a'), `${hostile} produced an anchor`).toHaveLength(0)
      // The label is still on screen. Refusing a destination is not a reason to hide the words.
      expect(out.text()).toContain('x')
    }
  })

  it('leaves an internal link inert when nothing can resolve it', () => {
    const out = render('[a note](notes/thing.md)')
    expect(out.byTag('a')).toHaveLength(0)
    expect(out.text()).toContain('a note')
  })

  it('makes an internal link only from what the resolver returns', () => {
    const out = render('[a note](notes/thing.md)', {
      resolveInternal: target => (target === 'notes/thing.md' ? '/api/file/abc' : null),
    })
    expect(out.byTag('a')[0]?.getAttribute('href')).toBe('/api/file/abc')
  })
})

describe('§8 — nothing remote is ever fetched', () => {
  /**
   * The assertion is that **no element carrying a `src` exists**, not that it is hidden. An `<img>`
   * with a remote `src` has already made the request by the time anything hides it, which is the
   * whole of why the check happens before the element does.
   */
  it('renders a remote image as a placeholder with no src at all', () => {
    const out = render('![a diagram](https://example.com/x.png)')
    expect(out.byTag('img')).toHaveLength(0)
    expect(out.text()).toContain('image not shown')
    expect(out.text()).toContain('a diagram')
  })

  it('renders a local image only when the app resolved it', () => {
    const out = render('![a photo](photo.png)', { resolveImage: () => '/api/file/photo' })
    const image = out.byTag('img')[0]
    expect(image?.getAttribute('src')).toBe('/api/file/photo')
    expect(image?.getAttribute('alt')).toBe('a photo')
  })

  it('falls back to the placeholder when the app declines to resolve it', () => {
    const out = render('![a photo](photo.png)', { resolveImage: () => null })
    expect(out.byTag('img')).toHaveLength(0)
  })
})

describe('§19 — a construct it does not style is displayed unstyled, never damaged', () => {
  /**
   * **THE INHERITED TRAP, and the reason this renderer walks the same tree as the editor.**
   *
   * CommonMark parses *any* bracketed text as a shortcut reference link, so `[draft]`, `[TODO]` and
   * the inner half of a `[[wiki link]]` all arrive as `Link` nodes with no destination.
   * `plan-decorations.ts` found this first and records what it costs: rendering them as links shows
   * `draft` where the file says `[draft]` — **the document appears to have lost characters it still
   * contains**, which is precisely the old app's failure and why nobody noticed it for months.
   */
  it('keeps the brackets of a link that has no destination', () => {
    expect(render('A [draft] note.').text()).toBe('A [draft] note.')
    expect(render('See [[wiki link]] here.').text()).toBe('See [[wiki link]] here.')
    expect(render('A [TODO] and a [a, b] in prose.').text()).toBe('A [TODO] and a [a, b] in prose.')
  })

  it('keeps every word of an ordinary paragraph', () => {
    const prose = 'The quick brown fox, with **bold** and *emphasis* and `code` inside it.'
    // Marks are structure and come out; every other character stays.
    expect(render(prose).text()).toBe(
      'The quick brown fox, with bold and emphasis and code inside it.',
    )
  })

  it('keeps the text of a construct it has no element for', () => {
    // A footnote reference is not in the styled set. It must still be readable.
    expect(render('A line with a [^note] in it.').text()).toContain('[^note]')
  })
})

describe('§8 — the shapes a message actually uses', () => {
  it('renders headings at their own level', () => {
    const out = render('# One\n\n## Two\n\n### Three\n')
    expect(out.byTag('h1')[0]?.text()).toBe('One')
    expect(out.byTag('h2')[0]?.text()).toBe('Two')
    expect(out.byTag('h3')[0]?.text()).toBe('Three')
  })

  it('renders both kinds of list', () => {
    const out = render('- one\n- two\n\n1. first\n2. second\n')
    expect(out.byTag('ul')).toHaveLength(1)
    expect(out.byTag('ol')).toHaveLength(1)
    expect(out.byTag('li')).toHaveLength(4)
    expect(out.text()).toContain('one')
    expect(out.text()).toContain('second')
  })

  it('renders a blockquote and a rule', () => {
    const out = render('> quoted\n\n---\n')
    expect(out.byTag('blockquote')[0]?.text()).toBe('quoted')
    expect(out.byTag('hr')).toHaveLength(1)
  })

  it('renders a table with header cells', () => {
    const out = render('| a | b |\n| - | - |\n| 1 | 2 |\n')
    expect(out.byTag('th').map(cell => cell.text())).toEqual(['a', 'b'])
    expect(out.byTag('td').map(cell => cell.text())).toEqual(['1', '2'])
  })

  it('renders a fenced code block as text, with its language recorded', () => {
    const out = render('```ts\nconst x = 1\n```\n')
    const code = out.byTag('code')[0]
    expect(code?.textContent).toBe('const x = 1')
    expect(code?.getAttribute('data-language')).toBe('ts')
  })

  /**
   * §8: *"code-fence info strings matched to `^[A-Za-z0-9_+-]{1,32}$`"*. Anything else is dropped
   * rather than becoming an attribute value — a class or data value built from agent-written text is
   * a selector somebody else's stylesheet can aim at.
   */
  it('drops an info string that is not a plain language name', () => {
    const out = render('```<script>\nx\n```\n')
    expect(out.byTag('code')[0]?.hasAttribute('data-language')).toBe(false)
  })

  it('never lets a code fence become anything but text', () => {
    const out = render('```\n<script>alert(1)</script>\n```\n')
    expect(out.byTag('script')).toHaveLength(0)
    expect(out.text()).toContain('<script>alert(1)</script>')
  })
})

describe('§8 — nothing agent-written becomes an element', () => {
  it('renders raw HTML in a message as the characters it is', () => {
    const out = render('A line with <img src=x onerror=alert(1)> in it.\n')
    expect(out.byTag('img')).toHaveLength(0)
    expect(out.byTag('script')).toHaveLength(0)
    expect(out.text()).toContain('<img src=x onerror=alert(1)>')
  })

  it('renders an HTML block as text', () => {
    const out = render('<div onclick="steal()">hello</div>\n')
    expect(out.byTag('div').filter(node => node.getAttribute('class') === null)).toHaveLength(0)
    expect(out.text()).toContain('<div onclick="steal()">hello</div>')
  })
})

describe('§14 — an author is one voice, however the header spells them', () => {
  /**
   * Taken from the reference app, which separated an author's **identity** from their **label**: the
   * first word lowercased against the whole header text. A tree writes `Ada (Conductor)` as
   * readily as `Ada`, and colouring on the whole string gives one person two colours in a single
   * conversation — worse than no colour, because the colour is what the eye follows down the page.
   */
  it('gives the same colour to a name with and without a role', () => {
    expect(colourFor('Ada (Conductor)')).toBe(colourFor('Ada'))
    expect(colourFor('ada')).toBe(colourFor('Ada'))
    expect(colourFor('  Ines  ')).toBe(colourFor('Ines'))
  })

  it('still tells different people apart', () => {
    // Not a guarantee of the palette — a guarantee that the key is the name, not the whole line.
    expect(colourFor('Ada')).not.toBe(colourFor('Ines'))
  })
})

/**
 * **§12: A LEADING `---` BLOCK IS PROPERTIES, NEVER A HEADING.**
 *
 * The spec names this one twice and names the cost both times:
 *
 * > *"In the render, a leading `---` block renders as a collapsed properties block — **never as a
 * > thematic break plus a setext heading**, which is the old app's bug and the reason 944 files were
 * > being silently flattened."*
 *
 * `@lezer/markdown` is not wrong to produce that parse — in CommonMark those characters *are* a rule
 * and an underline, which is precisely why the old app's regenerator printed them back that way. So
 * the renderer cannot take the tree at face value here, and it does not get its own opinion about
 * where frontmatter ends either: it asks `core/frontmatter.ts`, the same function the editor's
 * decorations ask. §19's rule is that the two can never disagree about what a document says, and two
 * definitions of frontmatter is a document that is properties to one half of the app and a heading
 * to the other.
 *
 * **Found by looking at the running app, not by a test.** The renderer shipped with P10 and every
 * case above passed; the first mock chatroom opened after it had `title:` across the top of the pane
 * in 32px type. That is the eighth time in this build something correct-in-isolation was wrong in
 * place, and it is the reason this block asserts against a *rendered document* rather than a node.
 */
describe('§12 — frontmatter is a properties block, and the old app\'s bug is the thing being tested', () => {
  const WITH_FRONTMATTER = '---\ntitle: RT1 chatroom\nstatus: blocked\n---\n\n# Cold store\n\nBody text.\n'

  it('renders no heading for the frontmatter, which is the whole bug', () => {
    const out = render(WITH_FRONTMATTER)
    /**
     * The assertion is on **every heading in the output**, not on the absence of one node. The bug
     * produces `SetextHeading2` — an `h2` reading `title: RT1 chatroom status: blocked` — and a test
     * that only looked for `h1` would have passed on the broken build.
     */
    const headings = [...out.byTag('h1'), ...out.byTag('h2'), ...out.byTag('h3')]
    expect(headings.map(h => h.text())).toEqual(['Cold store'])
    // And no thematic break, which is the other half of the misparse.
    expect(out.byTag('hr')).toHaveLength(0)
  })

  it('puts the keys in a collapsed block that is closed until it is opened', () => {
    const out = render(WITH_FRONTMATTER)
    const block = out.byClass('md-frontmatter')[0]
    expect(block, 'no properties block was rendered').toBeDefined()
    expect(block?.tag).toBe('details')
    /**
     * **Collapsed**, which the spec asks for by name. `details` without `open` is closed by the
     * browser's own behaviour — no script, no state, and it survives the CSP that forbids both.
     */
    expect(block?.hasAttribute('open')).toBe(false)
    /**
     * **The label has to be a `summary`, and a sweep is why this line exists.** Swapping it for a
     * `div` left every other assertion here green — the block is still `details`, still closed,
     * still carries the text — and in a browser the disclosure would have lost its control and the
     * word "Properties" would have disappeared along with the keys. A test that cannot see that is
     * testing the tag name of a container.
     */
    expect(block?.byTag('summary')[0]?.text()).toBe('Properties')
    expect(block?.text()).toContain('title: RT1 chatroom')
    expect(block?.text()).toContain('status: blocked')
  })

  it('renders the document under it exactly as if the block were not there', () => {
    const out = render(WITH_FRONTMATTER)
    expect(out.byTag('h1')[0]?.text()).toBe('Cold store')
    expect(out.text()).toContain('Body text.')
  })

  /**
   * **Nothing is lost, which outranks everything else here.** §19's rule does not get suspended
   * because a block is collapsed: every character of the frontmatter is still in the document, in a
   * disclosure the reader can open. Hiding is a display decision; dropping would be the old bug
   * wearing different clothes.
   */
  it('keeps every character of the frontmatter somewhere in the output', () => {
    const out = render(WITH_FRONTMATTER)
    expect(out.text()).toContain('title: RT1 chatroom')
    expect(out.text()).toContain('status: blocked')
  })

  /**
   * The delimiters themselves are chrome. Asserted because the first draft of the fix sliced from
   * `from` rather than `openTo` and put a bare `---` at the top of the properties list.
   */
  it('does not show the --- delimiters inside the block', () => {
    expect(render(WITH_FRONTMATTER).byClass('md-frontmatter')[0]?.text()).not.toContain('---')
  })

  /**
   * **A `---` anywhere but line one is a thematic break and must stay one.** The rule is
   * *first line only*, and a fix that searched for the first `---` in the document would eat a real
   * horizontal rule and everything above it.
   */
  it('leaves a rule that is not on the first line alone', () => {
    const out = render('Some words.\n\n---\n\nMore words.\n')
    expect(out.byClass('md-frontmatter')).toHaveLength(0)
    expect(out.byTag('hr')).toHaveLength(1)
    expect(out.text()).toContain('Some words.')
    expect(out.text()).toContain('More words.')
  })

  /**
   * **An unterminated block is left exactly as the parser saw it**, and that is a deliberate
   * agreement rather than a gap. `plan-decorations.ts` uses `frontmatterSpan`, which returns null
   * here, so the editor draws no properties styling either. Matching it is the §19 requirement; a
   * renderer that collapsed an unterminated block would hide the rest of the document behind a
   * disclosure the editor does not show.
   */
  it('leaves an unterminated block to the parser, exactly as the editor does', () => {
    const out = render('---\ntitle: never closed\n\nStill going.\n')
    expect(out.byClass('md-frontmatter')).toHaveLength(0)
    expect(out.text()).toContain('title: never closed')
    expect(out.text()).toContain('Still going.')
  })

  /**
   * **CRLF, which is the case `core/frontmatter.ts` warns about in its own header:** the CR stays in
   * the buffer as ordinary text, so a matcher that missed it *"would fail to recognise frontmatter in
   * every CRLF file while working perfectly in the tests."* This is that test, written so it cannot
   * be the one that works perfectly.
   */
  it('recognises frontmatter in a CRLF document, and leaves no CR behind', () => {
    const out = render('---\r\ntitle: windows\r\n---\r\n\r\n# Heading\r\n')
    /**
     * **Exact, not `toContain`.** A `toContain` here passes with a stray `\r` still on the end of the
     * line — the trimming written for LF only — and a CR that reaches `textContent` is a control
     * character sitting in the properties list. The whole reason this case exists is the CR, so the
     * assertion has to be the one that can see it.
     */
    expect(out.byClass('md-frontmatter')[0]?.byTag('pre')[0]?.text()).toBe('title: windows')
    expect(out.byTag('h2')).toHaveLength(0)
  })

  it('closes it with YAML\'s other terminator too', () => {
    const out = render('---\ntitle: dots\n...\n\n# Heading\n')
    expect(out.byClass('md-frontmatter')[0]?.text()).toContain('title: dots')
  })

  it('does nothing at all to a document that has none', () => {
    const out = render('# Heading\n\nWords.\n')
    expect(out.byClass('md-frontmatter')).toHaveLength(0)
    expect(out.byTag('h1')[0]?.text()).toBe('Heading')
  })

  /**
   * **A FRAGMENT IS NOT A DOCUMENT, and the caller has to say so.**
   *
   * Frontmatter is defined by being at the top of a *file*. A chatroom message body is a slice from
   * the middle of one, and a message that happens to open with a `---` rule and close with another
   * is not carrying properties — collapsing it would fold a paragraph of somebody's message into a
   * disclosure labelled "Properties".
   *
   * The default is the document, because that is what `renderMarkdown(text)` reads as and what every
   * caller but one is handing over. The fragment case is the one that opts out.
   */
  it('never reads a leading --- block as frontmatter in a fragment', () => {
    const source = '---\n\nA message that opens with a rule.\n\n---\n'
    const asDocument = render(source)
    expect(asDocument.byClass('md-frontmatter')).toHaveLength(1)

    const asFragment = render(source, { fragment: true })
    expect(asFragment.byClass('md-frontmatter')).toHaveLength(0)
    expect(asFragment.text()).toContain('A message that opens with a rule.')
    expect(asFragment.byTag('hr')).toHaveLength(2)
  })
})
