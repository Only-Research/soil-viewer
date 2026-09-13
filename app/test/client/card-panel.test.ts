import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PANEL_SLIDE_MS, createCardPanel, type CardPanel } from '../../src/client/board/card-panel'
import {
  FakeElement, documentListeners, installFakeDocument, removeFakeDocument,
} from '../support/fake-dom'

/**
 * The slide-over's sequencing. The security review's **C2 / P9-2**, which the module shipped with **no unit tests
 * at all** — the only coverage was seven sequential e2e cases, and sequential is precisely what the
 * bug is not.
 *
 * WHAT IS ACTUALLY AT STAKE. The panel's teardown is §13's flush: it is where an edit made in the
 * slide-over reaches disk. `open` and `close` both `await` it, both were re-entrant, and both
 * resumed against state a later tap had already changed. So every ordering failure below is a lost
 * edit, not a cosmetic glitch — a card tapped twice while a save was in flight discarded the save.
 *
 * ## Why there is a hand-rolled DOM in this file
 *
 * The unit environment is `environment: 'node'` and this repo carries no DOM library — spec §2 keeps
 * the dependency list short, and nobody installs a package to write a test. The alternative was to
 * put these cases in e2e with deliberately slowed teardowns, and that would have proved less: a real
 * browser cannot be made to interleave on demand, so the interesting orderings would be timing
 * hopes rather than assertions.
 *
 * The fake is therefore **deliberately shallow, and only where card-panel touches**. It is not a DOM
 * and does not pretend to be one. Everything about *appearance* — the 180ms slide, the transform,
 * the panel leaving layout when hidden — stays in `test/e2e/card-panel.spec.ts` against a real
 * engine, because a fake that answered questions about layout would be answering them from my own
 * assumptions. What is asserted here is order: which teardown ran, whether it ran at all, and which
 * card the panel believes it is showing.
 *
 * The one place the fake has to be faithful rather than shallow is `classList`, which is backed by
 * the `class` attribute exactly as the real one is — `el()` writes the class with `setAttribute` and
 * the module then reads it back through `classList.contains('is-open')`, so a fake that kept the two
 * apart would report the panel closed on every swap and quietly disable the mount-then-animate
 * branch.
 */

/** A promise the test resolves by hand. This is the "slow flush" every case here is built on. */
function deferred(): { promise: Promise<void>; settle: () => void } {
  let settle = (): void => {}
  const promise = new Promise<void>(resolve => { settle = () => { resolve() } })
  return { promise, settle }
}

/**
 * The fake DOM lives in `test/support/fake-dom.ts` now. It started here and was lifted the moment a
 * second suite — the markdown renderer's — needed one: two hand-rolled DOMs is two sets of
 * assumptions about what a browser does, drifting apart in the direction of whichever test was
 * written last. That is the two-implementations shape this build refuses in product code, and there
 * is no reason it should be acceptable in the instruments.
 */
beforeEach(installFakeDocument)
afterEach(removeFakeDocument)

/** A panel on a fresh parent, plus the handles every case needs to read it back. */
function mount(): {
  panel: CardPanel
  parent: FakeElement
  aside: () => FakeElement | undefined
  bodyText: () => string
  isOpen: () => boolean
} {
  const parent = new FakeElement('div')
  const panel = createCardPanel(parent as unknown as HTMLElement, {
    exemptClasses: ['board-card'],
    blockedByOverlay: () => false,
  })
  const aside = (): FakeElement | undefined => parent.children[0]
  return {
    panel,
    parent,
    aside,
    bodyText: () => (aside()?.children[0]?.children ?? []).map(node => node.textContent).join(''),
    isOpen: () => aside()?.classList.contains('is-open') ?? false,
  }
}

/** Renders one marker into the panel and records its teardown in `log` when it runs. */
function card(name: string, log: string[], gate?: Promise<void>) {
  return (host: HTMLElement): (() => Promise<void>) => {
    const marker = new FakeElement('p')
    marker.textContent = name
    ;(host as unknown as FakeElement).appendChild(marker)
    log.push(`render ${name}`)
    return async () => {
      log.push(`flush ${name} begins`)
      if (gate !== undefined) await gate
      log.push(`flush ${name} ends`)
    }
  }
}

describe('A25 — the transition is the annex number, not a copy of it', () => {
  it('slides for 180ms', () => {
    expect(PANEL_SLIDE_MS).toBe(180)
  })
})

describe('P9-2 — a second tap during a slow flush cannot skip a flush', () => {
  /**
   * THE ONE THE SECURITY REVIEW FOUND, exactly as they described it. Two taps arrive while card A is still saving.
   *
   * Unguarded, both `open` calls got past the same-key check together and both called `release()`.
   * The first took A's teardown; the second found it already nulled and sailed through. C then
   * rendered and stored its own teardown — and when A's flush finally resolved, B resumed, wiped
   * C's contents, stored B's teardown over C's, and left the panel reporting **B** for a card the
   * person never tapped. B's edit was never written.
   */
  it('runs every teardown in order and ends on the card the person last tapped', async () => {
    const log: string[] = []
    const slowFlush = deferred()
    const { panel, bodyText } = mount()

    await panel.open('A', card('A', log, slowFlush.promise))

    // Not awaited — this is a person tapping, and a person does not wait for a promise.
    const toB = panel.open('B', card('B', log))
    const toC = panel.open('C', card('C', log))

    slowFlush.settle()
    await Promise.all([toB, toC])

    expect(log, 'B rendering before A finished flushing is the lost edit').toEqual([
      'render A',
      'flush A begins', 'flush A ends', 'render B',
      'flush B begins', 'flush B ends', 'render C',
    ])
    expect(panel.openKey()).toBe('C')
    expect(bodyText()).toBe('C')
  })

  it('leaves nothing of the outgoing card behind when three land at once', async () => {
    const log: string[] = []
    const slowFlush = deferred()
    const { panel, bodyText } = mount()

    await panel.open('A', card('A', log, slowFlush.promise))
    const queuedOpens = [
      panel.open('B', card('B', log)),
      panel.open('C', card('C', log)),
      panel.open('D', card('D', log)),
    ]
    slowFlush.settle()
    await Promise.all(queuedOpens)

    // One marker, not four. The unguarded version appended each render into a body that the
    // resuming call cleared at the wrong moment, so what survived depended on who resumed last.
    expect(bodyText()).toBe('D')
    expect(log.filter(line => line.startsWith('flush')).length).toBe(6)
  })
})

describe('P9-2 — an open landing inside a close is not wiped by it', () => {
  /**
   * The second loss, and the one that looks like nothing is wrong: the panel reports the new card,
   * shows an empty body, and slides shut while believing it is open. `close` set `key = null`, went
   * away to flush, and came back to run `classList.remove('is-open')` and `clear(body)` over
   * contents that arrived while it was gone.
   */
  it('keeps the new contents and stays open', async () => {
    const log: string[] = []
    const slowFlush = deferred()
    const { panel, bodyText, isOpen } = mount()

    await panel.open('A', card('A', log, slowFlush.promise))

    const closing = panel.close()
    const opening = panel.open('B', card('B', log))
    slowFlush.settle()
    await Promise.all([closing, opening])

    expect(panel.openKey()).toBe('B')
    expect(bodyText(), 'the close resumed and cleared the body underneath B').toBe('B')
    expect(isOpen(), 'the close resumed and slid a panel shut that had just been re-opened').toBe(true)
  })
})

describe('P9-2 — destroy flushes', () => {
  it('runs the teardown, detaches the listeners, and removes the panel', async () => {
    const log: string[] = []
    const { panel, parent } = mount()

    await panel.open('A', card('A', log))
    expect(documentListeners().length, 'Escape and the outside click').toBe(2)

    await panel.destroy()

    // The whole of C2's third limb: this used to drop the teardown, so destroying a surface with an
    // editor in it discarded the edit with no error and no trace.
    expect(log).toEqual(['render A', 'flush A begins', 'flush A ends'])
    expect(documentListeners()).toEqual([])
    expect(parent.children).toEqual([])
    expect(panel.openKey()).toBeNull()
  })

  it('waits for a flush already in flight rather than racing it', async () => {
    const log: string[] = []
    const slowFlush = deferred()
    const { panel } = mount()

    await panel.open('A', card('A', log, slowFlush.promise))
    const closing = panel.close()
    const destroying = panel.destroy()
    slowFlush.settle()
    await Promise.all([closing, destroying])

    expect(log).toEqual(['render A', 'flush A begins', 'flush A ends'])
  })

  it('refuses an open that arrives after it', async () => {
    const log: string[] = []
    const { panel, parent } = mount()

    await panel.destroy()
    await panel.open('A', card('A', log))

    // A render after destroy would mount an editor into a detached element: a surface that takes
    // keystrokes and saves none of them.
    expect(log).toEqual([])
    expect(panel.openKey()).toBeNull()
    expect(parent.children).toEqual([])
  })
})

describe('P9-2 — a failing flush does not wedge the panel shut forever', () => {
  /**
   * A teardown that rejects is a save that failed — a 500, a dropped connection. If the rejection
   * travelled down the shared chain it would poison every later `open` and `close` on this panel,
   * and the person would be left with a slide-over that no longer responds to anything. The
   * rejection belongs to the caller, who can report it; the chain has to keep running.
   */
  it('reports the failure to the caller and still accepts the next card', async () => {
    const log: string[] = []
    const { panel, bodyText } = mount()

    await panel.open('A', () => () => { throw new Error('flush failed') })
    await expect(panel.close()).rejects.toThrow('flush failed')

    await panel.open('B', card('B', log))
    expect(panel.openKey()).toBe('B')
    expect(bodyText()).toBe('B')
  })
})

describe('A25 — same card closes, still, now that the check runs when the call does', () => {
  it('toggles rather than re-rendering', async () => {
    const log: string[] = []
    const { panel } = mount()

    await panel.open('A', card('A', log))
    await panel.open('A', card('A again', log))

    expect(panel.openKey()).toBeNull()
    expect(log).toEqual(['render A', 'flush A begins', 'flush A ends'])
  })

  it('is decided against the settled state, so a double tap during a flush still closes', async () => {
    const log: string[] = []
    const slowFlush = deferred()
    const { panel } = mount()

    await panel.open('A', card('A', log, slowFlush.promise))
    const toB = panel.open('B', card('B', log))
    const backToB = panel.open('B', card('B again', log))
    slowFlush.settle()
    await Promise.all([toB, backToB])

    // The second tap on B is a close, because by the time it runs B is what is open. Deciding it
    // against the state at *call* time would have opened B twice and left it on screen.
    expect(panel.openKey()).toBeNull()
    expect(log).toEqual([
      'render A',
      'flush A begins', 'flush A ends', 'render B',
      'flush B begins', 'flush B ends',
    ])
  })
})

describe('P9F-1 — the one thing outside the chain, and the guard nothing could see', () => {
  /**
   * **The hide timer runs outside `queued`, so it needs its own red-first test.** The security review's
   * generalisation, and the correction it filed against its own C2 clause: a condition that names
   * *which transitions to serialize* gets a correct implementation with an uncovered edge —
   * *"anything that survives outside the chain carries its own red-first test naming the state it
   * protects."*
   *
   * `closeNow` schedules `hidden` at +180ms so the slide-out can animate. The guard on that timer
   * is `key === null`, and the file previously claimed it was **sufficient** — in the same breath as
   * recording that a generation counter had been deleted from that exact spot for being
   * unobservable. The replacement was equally unobservable: the security review flipped it to always hide and the
   * whole shipped suite stayed green.
   *
   * The failure needs no race at all. Close the panel and tap another card inside 180ms: the
   * outgoing close's timer fires and hides a panel that has since re-opened. `openKey()` reports the
   * card, the body holds it, and there is nothing on screen — a surface that lies about itself, in
   * the module whose lying about itself produced both High findings the day before.
   */
  it('does not hide a panel that re-opened while the slide-out was still running', async () => {
    const log: string[] = []
    const { panel, aside, bodyText } = mount()

    await panel.open('A', card('A', log))
    await panel.close()
    // Inside the 180ms window — this is the ordinary double tap, not a contrived interleave.
    await panel.open('B', card('B', log))

    await new Promise(resolve => { setTimeout(resolve, PANEL_SLIDE_MS + 40) })

    expect(panel.openKey()).toBe('B')
    expect(bodyText()).toBe('B')
    expect(
      aside()?.hasAttribute('hidden'),
      'the outgoing close hid a panel that had already re-opened',
    ).toBe(false)
  })

  it('still hides once the slide-out finishes with nothing re-opened', async () => {
    // The other half. Without it, deleting the timer entirely would leave the case above green —
    // and a panel that never hides is the phantom-scroll regression the e2e suite already carries.
    const log: string[] = []
    const { panel, aside } = mount()

    await panel.open('A', card('A', log))
    await panel.close()
    await new Promise(resolve => { setTimeout(resolve, PANEL_SLIDE_MS + 40) })

    expect(panel.openKey()).toBeNull()
    expect(aside()?.hasAttribute('hidden')).toBe(true)
  })
})
