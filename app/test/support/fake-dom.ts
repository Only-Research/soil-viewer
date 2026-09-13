/**
 * **A DELIBERATELY SHALLOW DOM, for the client modules that build one.**
 *
 * The unit environment is `environment: 'node'` and this repo carries no DOM library — spec §2 keeps
 * the dependency list short, and nobody installs a package to write a test. So the client modules
 * that construct elements get this, and everything about *appearance* — layout, geometry, what a
 * browser does with a stylesheet — stays in the e2e suite against real engines, because a fake that
 * answered questions about layout would be answering them from assumptions rather than from a
 * browser.
 *
 * **One fake, not one per suite.** It started inside `card-panel.test.ts` and was lifted here the
 * moment a second suite needed it. Two hand-rolled DOMs is two sets of assumptions about what a
 * browser does, drifting apart in the direction of whichever test was written last — the same
 * two-implementations shape this build refuses in product code, and there is no reason it should be
 * acceptable in the instruments.
 *
 * What is faithful rather than shallow is stated where it is: `classList` is backed by the `class`
 * attribute exactly as the real one is, because `el()` writes the class with `setAttribute` and
 * modules read it back through `classList`.
 */

export interface FakeListener {
  readonly type: string
  readonly handler: (event: Event) => void
}

export class FakeElement {
  readonly children: FakeElement[] = []
  private readonly attributes = new Map<string, string>()
  parent: FakeElement | null = null
  textContent = ''
  /**
   * **Empty string, because a real input's is.** `document.createElement('input').value` is `''`,
   * never `undefined` — and product code reads it without guarding, correctly. A fake that left it
   * undefined turned every view reading its own field into a `TypeError` at mount, which reads as
   * the view being broken rather than the instrument being unfaithful.
   */
  value = ''
  /** Read by anything forcing a style flush. The value is never used. */
  readonly offsetWidth = 0

  constructor(readonly tag: string) {}

  /**
   * Backed by the `class` attribute, because the real one is. `el()` sets the class through
   * `setAttribute` and callers read it through `classList`; keeping two stores would make every
   * `contains` answer `false` and silently disable whichever branch depended on it.
   */
  get classList(): {
    add: (name: string) => void
    remove: (name: string) => void
    contains: (name: string) => boolean
  } {
    const read = (): Set<string> =>
      new Set((this.attributes.get('class') ?? '').split(' ').filter(name => name !== ''))
    const write = (names: Set<string>): void => { this.attributes.set('class', [...names].join(' ')) }
    return {
      add: name => { const names = read(); names.add(name); write(names) },
      remove: name => { const names = read(); names.delete(name); write(names) },
      contains: name => read().has(name),
    }
  }

  /**
   * Focus, recorded rather than performed. There is nothing to give focus *to* here, but a view
   * that focuses its own field must be mountable — and `focused` is worth keeping because "did it
   * put the caret where a person expects" is a real assertion, not decoration.
   */
  focused = false
  focus(): void { this.focused = true }
  blur(): void { this.focused = false }
  /** No selection model in a fake; the call must not throw for a view to mount. */
  setSelectionRange(): void { /* nothing to select */ }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }

  toggleAttribute(name: string, force: boolean): void {
    if (force) this.attributes.set(name, '')
    else this.attributes.delete(name)
  }

  /**
   * Element-level listeners, so a module that wires its own controls can be mounted at all.
   *
   * **Kept, not discarded.** A fake whose `addEventListener` did nothing would let every view mount
   * and let every test about what a click *does* pass by never running the handler — which is the
   * shape of a test that measures nothing. `fire` is the other half, and the only reason this
   * stores them.
   */
  private readonly handlers: FakeListener[] = []

  addEventListener(type: string, handler: (event: Event) => void): void {
    this.handlers.push({ type, handler })
  }

  removeEventListener(type: string, handler: (event: Event) => void): void {
    const at = this.handlers.findIndex(entry => entry.type === type && entry.handler === handler)
    if (at !== -1) this.handlers.splice(at, 1)
  }

  /** Runs this element's listeners for `type`. No bubbling — nothing here needs it yet. */
  fire(type: string, event: Partial<Event> = {}): void {
    for (const entry of [...this.handlers]) {
      if (entry.type === type) entry.handler(event as Event)
    }
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = this
    this.children.push(child)
    return child
  }

  /**
   * Enough of `insertBefore` for the board's optimistic paint, which moves a card's node into
   * another lane before the server has answered. Without it the success path of a drop cannot be
   * exercised at all — only the refusal path, which is the half that needs proving least.
   *
   * A null reference appends, as the real one does.
   */
  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = this
    const at = before === null ? -1 : this.children.indexOf(before)
    if (at === -1) this.children.push(child)
    else this.children.splice(at, 0, child)
    return child
  }

  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null
  }

  replaceChildren(): void {
    for (const child of this.children) child.parent = null
    this.children.length = 0
  }

  remove(): void {
    const holder = this.parent
    if (holder === null) return
    holder.children.splice(holder.children.indexOf(this), 1)
    this.parent = null
  }

  /**
   * `.class` and `tag` selectors only — the two forms product code actually uses here.
   *
   * **Anything else throws rather than returning null.** A fake selector engine that quietly
   * answered "no match" to a selector it did not understand would turn every unsupported query into
   * a silently skipped branch, which is precisely the failure this fake exists to catch.
   */
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector.startsWith('.')) return this.byClass(selector.slice(1)).filter(node => node !== this)
    if (/^[a-z]+$/.test(selector)) return this.byTag(selector).filter(node => node !== this)
    throw new Error(`fake-dom: unsupported selector ${selector}`)
  }

  // ---- queries, for assertions ------------------------------------------------------------

  /** Every element in this subtree, this one first. */
  descendants(): FakeElement[] {
    return [this, ...this.children.flatMap(child => child.descendants())]
  }

  /** Every element with this tag name, in document order. */
  byTag(tag: string): FakeElement[] {
    return this.descendants().filter(node => node.tag === tag)
  }

  /** Every element carrying this class, in document order. */
  byClass(name: string): FakeElement[] {
    return this.descendants().filter(node => node.classList.contains(name))
  }

  /**
   * All the text this subtree would show, concatenated in order.
   *
   * The assertion most of the renderer's cases are written against, because the rule that matters
   * most is that **nothing is lost** — and a character dropped from the middle of a document is
   * invisible in a structural assertion and obvious in this one.
   */
  text(): string {
    return this.descendants().map(node => node.textContent).join('')
  }
}

let listeners: FakeListener[] = []

/** The listeners currently registered on the fake document. */
export const documentListeners = (): readonly FakeListener[] => listeners

/**
 * Installs the fake as the `document` global.
 *
 * `defineProperty` rather than assignment: `document` is declared read-only by the DOM lib this
 * project compiles against, so an assignment does not typecheck.
 */
export function installFakeDocument(): void {
  listeners = []
  const fake = {
    /**
     * **A fresh root per install**, so one test's `data-layout` cannot be the next test's starting
     * state. Added for §18.1's layout mode, which publishes its decision as an attribute here
     * rather than keeping it in a module variable only it can see — the point being that CSS and
     * script read the same one thing, so a test that could not read it would be testing a copy.
     */
    documentElement: new FakeElement('html'),
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string, handler: (event: Event) => void) => {
      listeners.push({ type, handler })
    },
    removeEventListener: (type: string, handler: (event: Event) => void) => {
      listeners = listeners.filter(entry => !(entry.type === type && entry.handler === handler))
    },
  }
  Object.defineProperty(globalThis, 'document', { value: fake, configurable: true, writable: true })

  /**
   * **`HTMLElement` has to exist, even though nothing is an instance of it.**
   *
   * `dom.ts` guards its focus helpers with `activeElement instanceof HTMLElement`, and in
   * `environment: 'node'` the identifier is simply undefined — so any view calling them throws
   * `ReferenceError` before reaching the behaviour under test. Defining an empty class makes the
   * guard *run* and answer `false`, which is the truthful answer here: a fake document has no
   * focused element. The alternative is that no view using focus restoration can be mounted in a
   * unit test at all, and those are the views this build has most often left unobserved.
   */
  Object.defineProperty(globalThis, 'HTMLElement', {
    value: class FakeHTMLElement {}, configurable: true, writable: true,
  })
}

export function removeFakeDocument(): void {
  Reflect.deleteProperty(globalThis, 'HTMLElement')
  Reflect.deleteProperty(globalThis, 'document')
}
