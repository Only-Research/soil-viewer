/**
 * **THE MARKDOWN RENDERER.** Spec §8, arriving in P10 with the chatroom — its only consumer.
 *
 * The P7 brief scheduled it here deliberately and said why: *"a renderer built in P7 for a consumer
 * that arrives in P10 is that finding, scheduled deliberately"* — the finding being this build's
 * signature failure, a component complete, tested, swept, and reachable by nothing.
 *
 * ## It renders content agents wrote, so it is a security surface first
 *
 * §8: *"The app's own origin is what holds file access, and the markdown it renders was written by
 * agents. So rendered content must never be able to run."* Three rules do the work, and none of
 * them is invented here:
 *
 * - **DOM construction only.** `createElement` / `textContent` / `setAttribute`, through the one
 *   allowlisted module. There is no string of HTML anywhere in this file and no parameter that
 *   could accept one. `innerHTML` and its family are lint-banned across `src/`.
 * - **Every destination goes through `url-safety.ts`** — P7's normalize-then-allowlist, which is
 *   what makes tab-broken `javascript:`, entity-encoded `javascript:` and protocol-relative
 *   `//host` inert. This file makes **no scheme decisions of its own**; it asks and obeys. A second
 *   opinion about what is a safe URL is how one of them ends up wrong.
 * - **Nothing remote is ever fetched.** An image whose source is not a file in a registered folder
 *   renders as a placeholder, per §8's "zero outbound network for content".
 *
 * ## One parser, and the same tree the editor walks
 *
 * §19: *"One parser, shared by editor and renderer."* This uses `markdownLanguage.parser` — the
 * exact parser instance `create-editor.ts` configures, GFM set and all. Two parsers would be two
 * opinions about what the document says, and §12 records what that costs: *"two rendering paths
 * that must stay pixel-identical is exactly how the old app's preview came to disagree with its
 * editor — and that disagreement is why 62% of damaged files still looked correct."*
 *
 * ## The rule that outranks looking good
 *
 * §19: *a construct the renderer doesn't style is displayed unstyled, **never damaged**.* Every
 * unknown node falls through to its own source text, verbatim. A renderer that silently drops what
 * it does not understand is the old app's failure in miniature — the document appears to have lost
 * characters it still contains, and nobody notices for months.
 *
 * The sharpest instance is inherited from `plan-decorations.ts`, which found it first: CommonMark
 * parses **any** bracketed text as a shortcut reference link, so `[draft]`, `[TODO]` and the inner
 * half of a `[[wiki link]]` all arrive as `Link` nodes with no destination. Treating those as links
 * would render `[draft]` as `draft` — brackets gone from a file that still contains them. A `Link`
 * or `Image` earns its treatment **only when it has a `URL` child**; everything else is text.
 */

import { markdownLanguage } from '@codemirror/lang-markdown'
import type { SyntaxNode } from '@lezer/common'

import { frontmatterSpan } from '../../core/frontmatter'
import { imageIsLoadable, treatmentFor } from '../../core/url-safety'
import { append, el, setText } from '../dom'

export interface RenderOptions {
  /**
   * Turns a destination with no scheme into something the app can open, or `null` to leave it
   * inert.
   *
   * Injected because **only the server can answer it** — §4's checker decides whether a relative
   * path names a file inside a registered folder, and a client that guessed would be composing a
   * path, which §6 forbids. The renderer's job is to ask.
   */
  readonly resolveInternal?: (target: string) => string | null
  /**
   * Turns an image destination into a `src` the app may load, or `null` for the placeholder.
   *
   * Same reasoning, and one more: §8 requires that anything remote is **never fetched**, so this
   * returning `null` must produce an element with no `src` at all rather than one that is hidden.
   * An image element carrying a remote source has already made the request by the time anyone
   * hides it.
   */
  readonly resolveImage?: (target: string) => string | null
  /**
   * True when `text` is a slice out of a document rather than a document.
   *
   * It exists for one decision: **whether a leading `---` block is frontmatter.** Frontmatter is
   * defined by sitting at the top of a *file*, so the question is meaningless for a fragment — and
   * answering it wrongly there folds a message that opens and closes with a thematic break into a
   * disclosure labelled "Properties".
   *
   * **The default is the document**, because that is what `renderMarkdown(text)` reads as and what
   * every caller but one is handing over. Defaulting the other way would mean a future reading view
   * reproduces the old app's bug by forgetting to opt in, and that trade is not close: §12 names
   * that bug and the 944 files it flattened.
   */
  readonly fragment?: boolean
}

/** Structural punctuation the parse exposes and the reader should never see. */
const MARKS: ReadonlySet<string> = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'ListMark',
  'QuoteMark',
  'LinkMark',
  'TableDelimiter',
])

/**
 * A link's destination, which is plumbing rather than label.
 *
 * **Not folded into `MARKS`**, and the difference is a real case: an autolink shows its URL *as* its
 * text, so a blanket skip of `URL` would render it as nothing at all. This set is passed only where
 * a destination has already been read off and turned into an `href`.
 */
const DESTINATION: ReadonlySet<string> = new Set(['URL'])

/** §8's info-string rule: letters, digits, underscore, plus and hyphen, up to 32 of them. */
const CODE_INFO = /^[A-Za-z0-9_+-]{1,32}$/

const HEADING_LEVELS: Readonly<Record<string, string>> = {
  ATXHeading1: 'h1', ATXHeading2: 'h2', ATXHeading3: 'h3',
  ATXHeading4: 'h4', ATXHeading5: 'h5', ATXHeading6: 'h6',
  SetextHeading1: 'h1', SetextHeading2: 'h2',
}

function* childrenOf(node: SyntaxNode): Generator<SyntaxNode> {
  for (let child = node.firstChild; child !== null; child = child.nextSibling) yield child
}

/** The child that carries a link's destination, or `null` when there is none. */
function urlChildOf(node: SyntaxNode): SyntaxNode | null {
  for (const child of childrenOf(node)) if (child.name === 'URL') return child
  return null
}

/**
 * Appends source text as text. The one place characters reach the document, and it is `textContent`
 * by construction: `el`'s signature has no parameter that accepts markup.
 */
function appendText(parent: HTMLElement, text: string): void {
  if (text === '') return
  const span = el('span')
  setText(span, text)
  append(parent, span)
}

interface InlineOptions {
  /**
   * Child node names to pass over entirely. One caller uses it: a link's own `URL` child is its
   * destination, not its label — without this, a link renders with its own address glued to the end
   * of its words and the reader sees the plumbing.
   */
  readonly skip?: ReadonlySet<string>
  /**
   * Drop the spaces that separate a leading mark from its content. A heading is a `HeaderMark`
   * followed by a space, and that space is punctuation rather than the first character of the
   * heading.
   */
  readonly trimStart?: boolean
}

/**
 * Renders a node's children as inline content, **emitting the source between them verbatim.**
 *
 * Walking children alone would silently drop every character the parse did not put in a node — the
 * ordinary words of a sentence. Tracking the cursor and emitting the gaps is what makes "never
 * damaged" true rather than aspirational.
 */
function inlineInto(
  parent: HTMLElement,
  node: SyntaxNode,
  text: string,
  options: RenderOptions,
  inline: InlineOptions = {},
): void {
  let at = node.from
  let emitted = false
  const emit = (raw: string): void => {
    const gap = !emitted && inline.trimStart === true ? raw.replace(/^[ \t]+/, '') : raw
    if (gap !== '') emitted = true
    appendText(parent, gap)
  }

  for (const child of childrenOf(node)) {
    if (child.from > at) emit(text.slice(at, child.from))
    at = child.to
    if (inline.skip?.has(child.name) === true) continue
    inlineNode(parent, child, text, options)
  }
  if (at < node.to) emit(text.slice(at, node.to))
}

/** The visible text of a link or image: its children, minus the plumbing. */
function labelOf(node: SyntaxNode, text: string): string {
  let label = ''
  let at = node.from
  for (const child of childrenOf(node)) {
    if (child.from > at) label += text.slice(at, child.from)
    if (!MARKS.has(child.name) && child.name !== 'URL') label += text.slice(child.from, child.to)
    at = child.to
  }
  return label + text.slice(at, node.to)
}

function inlineNode(
  parent: HTMLElement, node: SyntaxNode, text: string, options: RenderOptions,
): void {
  const source = text.slice(node.from, node.to)

  if (MARKS.has(node.name)) return

  /**
   * **Classed, 2026-08-16 — these four were the only nodes in this renderer built bare.**
   *
   * Every other node here gets an `md-*` class and a rule. `em`, `strong`, `s` and `code` got
   * neither, and the stylesheet has no element selector for them either — so **bold, italic and
   * `backticks` rendered as ordinary body text** everywhere this renderer draws, which is the
   * chatroom: the surface the M-threads are read on.
   *
   * Three tokens were written for exactly this and referenced by nothing: `--inline-code-text`
   * ("warm tan"), `--emphasis`, and `--weight-strong`, whose own comment reads *"ONLY prose h1 and
   * strong"*. The values existed; nothing ever pointed at them.
   */
  if (node.name === 'Emphasis' || node.name === 'StrongEmphasis' || node.name === 'Strikethrough') {
    const tag = node.name === 'Emphasis' ? 'em' : node.name === 'StrongEmphasis' ? 'strong' : 's'
    const wrapper = el(tag, {
      className: node.name === 'Emphasis' ? 'md-em'
        : node.name === 'StrongEmphasis' ? 'md-strong' : 'md-strike',
    })
    inlineInto(wrapper, node, text, options)
    append(parent, wrapper)
    return
  }

  if (node.name === 'InlineCode') {
    // `md-inline-code`, not `md-code` — that one is the FENCED block, and giving both the same
    // class would put a block's padding and ground inside a sentence.
    const code = el('code', { className: 'md-inline-code' })
    // The backticks are `CodeMark` children, so the content is what sits between them.
    inlineInto(code, node, text, options)
    append(parent, code)
    return
  }

  if (node.name === 'Link' || node.name === 'Image') {
    const url = urlChildOf(node)
    /**
     * **No destination means this was never a link.** `[draft]` and the inner half of a
     * `[[wiki link]]` both arrive here. Rendering their source verbatim is what keeps the brackets
     * a reader typed on the screen where they typed them.
     */
    if (url === null) {
      appendText(parent, source)
      return
    }
    const destination = text.slice(url.from, url.to)
    if (node.name === 'Image') appendImage(parent, destination, labelOf(node, text), options)
    else appendLink(parent, node, destination, text, options)
    return
  }

  // Anything else: render its children if it has them, and its source if it does not. Neither
  // branch can lose a character, which is the whole rule.
  if (node.firstChild !== null) inlineInto(parent, node, text, options)
  else appendText(parent, source)
}

function appendLink(
  parent: HTMLElement, node: SyntaxNode, destination: string, text: string, options: RenderOptions,
): void {
  const treatment = treatmentFor(destination)

  if (treatment.kind === 'inert') {
    /**
     * §8: *"anything else renders as plain text."* The label is shown, the destination is not, and
     * the reason goes in a `title` — *"never for a URL"*, as `url-safety.ts` says of that field.
     */
    const inert = el('span', {
      className: 'md-inert-link', attributes: { title: treatment.reason },
    })
    inlineInto(inert, node, text, options, { skip: DESTINATION })
    append(parent, inert)
    return
  }

  const href = treatment.kind === 'external'
    ? treatment.href
    : options.resolveInternal?.(treatment.target) ?? null

  if (href === null) {
    // Internal, and nobody could resolve it — a path that names no file in a registered folder.
    const unresolved = el('span', {
      className: 'md-inert-link',
      attributes: { title: 'this link does not point at a file in a registered folder' },
    })
    inlineInto(unresolved, node, text, options, { skip: DESTINATION })
    append(parent, unresolved)
    return
  }

  /**
   * §8: *"external links open in a new tab with `rel="noopener noreferrer"` and never navigate the
   * app tab."* Both attributes are set on internal links too — an internal target still opens a
   * document, and a link that replaced the app's own tab would take the editor with it.
   */
  const anchor = el('a', {
    className: 'md-link',
    attributes: { href, target: '_blank', rel: 'noopener noreferrer' },
  })
  inlineInto(anchor, node, text, options, { skip: DESTINATION })
  append(parent, anchor)
}

function appendImage(
  parent: HTMLElement, destination: string, alt: string, options: RenderOptions,
): void {
  /**
   * **The source is set only when the app has decided the file is one of the operator's.** Everything
   * else becomes a placeholder that names what it would have loaded — §8's *"remote images and
   * iframes are never loaded"*, and the reason the check happens before the element exists: an
   * image element carrying a remote source has already made the request by the time anything hides
   * it.
   */
  const src = imageIsLoadable(destination) ? options.resolveImage?.(destination) ?? null : null

  if (src === null) {
    const placeholder = el('span', { className: 'md-image-placeholder' })
    setText(placeholder, alt === '' ? 'image not shown' : `image not shown: ${alt}`)
    append(parent, placeholder)
    return
  }

  append(parent, el('img', {
    className: 'md-image',
    attributes: { src, alt, loading: 'lazy' },
  }))
}

function blockInto(
  parent: HTMLElement, node: SyntaxNode, text: string, options: RenderOptions,
): void {
  const heading = HEADING_LEVELS[node.name]
  if (heading !== undefined) {
    const element = el(heading, { className: 'md-heading' })
    inlineInto(element, node, text, options, { trimStart: true })
    append(parent, element)
    return
  }

  if (node.name === 'Paragraph') {
    const paragraph = el('p', { className: 'md-paragraph' })
    inlineInto(paragraph, node, text, options)
    append(parent, paragraph)
    return
  }

  if (node.name === 'BulletList' || node.name === 'OrderedList') {
    const list = el(node.name === 'BulletList' ? 'ul' : 'ol', { className: 'md-list' })
    for (const item of childrenOf(node)) {
      if (item.name !== 'ListItem') continue
      const li = el('li')
      for (const child of childrenOf(item)) {
        if (MARKS.has(child.name)) continue
        blockInto(li, child, text, options)
      }
      append(list, li)
    }
    append(parent, list)
    return
  }

  if (node.name === 'Blockquote') {
    const quote = el('blockquote', { className: 'md-quote' })
    for (const child of childrenOf(node)) {
      if (MARKS.has(child.name)) continue
      blockInto(quote, child, text, options)
    }
    append(parent, quote)
    return
  }

  if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
    const pre = el('pre', { className: 'md-code' })
    const code = el('code')
    let info = ''
    let body = ''
    for (const child of childrenOf(node)) {
      if (child.name === 'CodeInfo') info = text.slice(child.from, child.to)
      if (child.name === 'CodeText') body = text.slice(child.from, child.to)
    }
    // An indented code block has no marks and no CodeText child; its whole source is the content.
    if (body === '' && node.name === 'CodeBlock') body = text.slice(node.from, node.to)
    /**
     * §8's info-string pattern. Anything else is dropped rather than becoming an attribute value —
     * a value built from agent-written text is a selector somebody else's stylesheet can aim at.
     */
    if (CODE_INFO.test(info)) code.setAttribute('data-language', info)
    setText(code, body)
    append(pre, code)
    append(parent, pre)
    return
  }

  if (node.name === 'Table') {
    append(parent, tableFor(node, text, options))
    return
  }

  if (node.name === 'HorizontalRule') {
    append(parent, el('hr', { className: 'md-rule' }))
    return
  }

  // Unknown block: its own source, unstyled and whole.
  const fallback = el('p', { className: 'md-paragraph' })
  appendText(fallback, text.slice(node.from, node.to))
  append(parent, fallback)
}

function tableFor(node: SyntaxNode, text: string, options: RenderOptions): HTMLElement {
  const table = el('table', { className: 'md-table' })
  for (const row of childrenOf(node)) {
    if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue
    const tr = el('tr')
    for (const cell of childrenOf(row)) {
      if (cell.name !== 'TableCell') continue
      const td = el(row.name === 'TableHeader' ? 'th' : 'td')
      inlineInto(td, cell, text, options)
      append(tr, td)
    }
    append(table, tr)
  }
  return table
}

/** Strips the blank lines the span leaves on either side, without touching YAML's own indentation. */
function withoutSurroundingBlankLines(yaml: string): string {
  return yaml.replace(/^(\r?\n)+/, '').replace(/(\r?\n)+$/, '')
}

/**
 * The frontmatter block, §12's *"collapsed properties block"*.
 *
 * **`details` rather than a class and a click handler**, and that is a CSP decision as much as a
 * simplicity one: disclosure is browser behaviour, so it needs no script, holds no state, and cannot
 * be left half-wired the way a hand-built toggle can.
 *
 * The keys are shown as the file's own text rather than parsed into rows. There is no YAML parser in
 * this app and adding one to *display* something would be a second reader of a format §19 is at
 * pains to have exactly one reader of — and a wrong parse would show the operator values their file does
 * not contain, which is the same disagreement-with-the-file this whole build is organised against.
 */
function propertiesBlock(yaml: string): HTMLElement {
  const block = el('details', { className: 'md-frontmatter' })
  const summary = el('summary', { className: 'md-frontmatter-summary', text: 'Properties' })
  const body = el('pre', { className: 'md-frontmatter-body' })
  setText(body, withoutSurroundingBlankLines(yaml))
  append(block, summary, body)
  return block
}

/**
 * Renders markdown into a fresh element.
 *
 * The container carries `md-rendered`, which §8 requires be **confined** (`contain`, `isolation`)
 * so agent-written content can never draw over app chrome — a message with a wide table or an
 * absolutely-positioned construct stays inside its own box.
 *
 * **Frontmatter is lifted out before the parse, not styled after it.** §12: *"a leading `---` block
 * renders as a collapsed properties block — never as a thematic break plus a setext heading, which
 * is the old app's bug and the reason 944 files were being silently flattened."* The tree cannot
 * help here, because in CommonMark those characters genuinely *are* a rule and an underline —
 * `@lezer/markdown` is right and the appearance is still the old bug. So the span comes from
 * `core/frontmatter.ts`, the same function `plan-decorations.ts` asks, and the body is parsed
 * without it. §19 requires the editor and the renderer never disagree about what a document says;
 * one definition of frontmatter is how that is kept true rather than remembered.
 */
export function renderMarkdown(text: string, options: RenderOptions = {}): HTMLElement {
  const root = el('div', { className: 'md-rendered' })

  const span = options.fragment === true ? null : frontmatterSpan(text)
  if (span !== null) append(root, propertiesBlock(text.slice(span.openTo, span.closeFrom)))
  /**
   * Parsed from the remainder, so every offset in the tree is an offset into `body`. Slicing after
   * the parse would have been the other way round and wrong by the length of the block — the class
   * of off-by-N that renders as formatting drifting away from the thing it formats.
   */
  const body = span === null ? text : text.slice(span.to)

  const tree = markdownLanguage.parser.parse(body)
  for (const child of childrenOf(tree.topNode)) blockInto(root, child, body, options)
  return root
}
