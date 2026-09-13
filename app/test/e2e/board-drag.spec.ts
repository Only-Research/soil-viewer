import { showOnly } from './board-nav'
import { expect, test, type Page } from '@playwright/test'

/**
 * **THE DRAG, AND THE ONE NUMBER THE BUILD PLAN PUTS ON IT.**
 *
 * P9's gate: *"Board drag reflects in <200 ms (PRD NFR, **previously ungated**)."* Ungated is the
 * word that matters — the board's primary interaction, the one §13.7's whole M2 machinery exists to
 * make safe, has server tests and **no browser coverage whatsoever**. Every refusal is proven
 * against the filesystem and nothing has ever checked that a card dropped on a lane arrives there.
 *
 * ## Why the events are dispatched rather than mimed with the mouse
 *
 * HTML5 drag-and-drop is not a mouse gesture that the DOM happens to observe; it is a separate
 * event sequence the browser synthesises, and driving it by moving a virtual pointer is unreliable
 * across engines — which is the reason this suite has gone this long with no drag test at all.
 *
 * So the sequence is dispatched in the page, with **one `DataTransfer` shared across the three
 * events** exactly as a real drag has. That is honest about what it proves and what it does not:
 * it exercises the app's real `dragstart`, `dragover` and `drop` handlers, the real move request,
 * and the real repaint — and it does **not** prove that a trackpad can begin a drag. The first is
 * what the NFR is about; the second belongs to the fresh-eyes pass on real hardware.
 *
 * ## What the number is measured between
 *
 * From the drop landing to the card being visible in its new lane. Not from `mousedown`, which
 * would be measuring how long the person held the card, and not to "the request returned", which is
 * not something anybody can see.
 */

const laneNamed = (page: Page, name: string) =>
  page.locator('.board-lane').filter({ has: page.locator('.board-lane-name', { hasText: new RegExp(`^${name}$`) }) })

async function openTheBoard(page: Page, project: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()

  await showOnly(page, project)
  await expect(laneNamed(page, 'Next')).toBeVisible()
}

/**
 * Dispatches a full HTML5 drag of one card onto one lane, and returns the moment the drop was
 * delivered — `performance.now()` in page time, so the elapsed measurement below never crosses the
 * process boundary and never includes a round trip to the test runner.
 */
async function dragCardToLane(page: Page, cardTitle: string, laneName: string): Promise<number> {
  return page.evaluate(({ title, lane }) => {
    const card = [...document.querySelectorAll('.board-card')].find(
      node => node.querySelector('.board-card-title')?.textContent === title,
    )
    const column = [...document.querySelectorAll('.board-lane')].find(
      node => node.querySelector('.board-lane-name')?.textContent === lane,
    )
    if (card === undefined || column === undefined) throw new Error('no such card or lane')

    // One DataTransfer across all three, as a real drag has. The app holds the dragged card by
    // reference and ignores the payload — but a `dragstart` with no transfer object is not
    // something WebKit will start, which is the same constraint the view's own comment records.
    const transfer = new DataTransfer()
    const fire = (target: Element, type: string): void => {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    fire(card, 'dragstart')
    fire(column, 'dragover')
    fire(column, 'drop')
    return performance.now()
  }, { title: cardTitle, lane: laneName })
}

test.describe('dragging a card between lanes', () => {
  test('the card lands in the lane, and it reflects in under 200ms',
    async ({ page }, testInfo) => {
      await openTheBoard(page, `scratch-${testInfo.project.name}-board-drag`)

      const urgent = laneNamed(page, 'Urgent')
      const next = laneNamed(page, 'Next')
      await expect(urgent.locator('.board-card-title')).toHaveText('The dragged one')
      await expect(next.locator('.board-card')).toHaveCount(0)

      const droppedAt = await dragCardToLane(page, 'The dragged one', 'Next')

      /**
       * Polled **in the page**, so what is timed is the app repainting rather than Playwright
       * noticing. A locator assertion here would fold this suite's own polling interval into the
       * number, and at a 200ms budget that is most of the budget.
       */
      const reflectedIn = await page.evaluate(async ({ startedAt, lane, title }) => {
        const arrived = (): boolean => {
          const column = [...document.querySelectorAll('.board-lane')].find(
            node => node.querySelector('.board-lane-name')?.textContent === lane,
          )
          return [...(column?.querySelectorAll('.board-card-title') ?? [])]
            .some(node => node.textContent === title)
        }
        const deadline = startedAt + 5_000
        while (!arrived()) {
          if (performance.now() > deadline) return -1
          await new Promise(resolve => { setTimeout(resolve, 4) })
        }
        return performance.now() - startedAt
      }, { startedAt: droppedAt, lane: 'Next', title: 'The dragged one' })

      expect(reflectedIn, 'the card never arrived in the lane at all').toBeGreaterThan(-1)
      // Reported whether or not it passes, because a number that only appears on failure is a
      // number nobody watches drift.
      console.log(`board drag reflected in ${Math.round(reflectedIn)}ms`)
      expect(reflectedIn, 'PRD NFR: a board drag reflects in under 200ms').toBeLessThan(200)

      // ...and it really moved, rather than being painted into both places.
      await expect(urgent.locator('.board-card')).toHaveCount(0)
      await expect(next.locator('.board-card-title')).toHaveText('The dragged one')
    })

  /**
   * **THE REQUEST IS WATCHED, BECAUSE THE SCREEN CANNOT TELL.**
   *
   * Two assertions were tried here and both proved nothing, which is the finding.
   *
   * The first checked that no warning appeared. It passed with the guard removed — the assertion
   * resolves in the same millisecond and a refusal has to cross a round trip first, so it was
   * measuring latency. That is the same fault the quick-add spec was caught with the day before.
   *
   * The second added an anchor and *still* passed, and that one is the interesting failure: the
   * server does not refuse a same-lane move at all. `exclusiveRename` compares `(dev, ino)`, finds
   * the destination **is** the source, and treats it as the case-only-rename path — a successful
   * no-op. So there is no banner to look for, no card to see move, and nothing on screen
   * distinguishing a guarded drop from an unguarded one.
   *
   * What is really being defended is that a gesture which did nothing does not become a `rename`
   * syscall on the operator's file. That is a fact about the *request*, so the request is what is
   * counted — and the count is proven live by a real move afterwards that must raise it to one.
   */
  test('dropping a card back into its own lane never becomes a request', async ({ page }, testInfo) => {
    const moves: string[] = []
    page.on('request', request => {
      if (!request.url().includes('/api/card.move')) return
      moves.push(request.url())
    })

    await openTheBoard(page, `scratch-${testInfo.project.name}-board-drag`)

    // Wherever the case above left it — this file runs with `workers: 1`, so the card has moved.
    const holding = (await laneNamed(page, 'Next').locator('.board-card').count()) === 1
      ? 'Next'
      : 'Urgent'
    await dragCardToLane(page, 'The dragged one', holding)

    /**
     * A real move, whose card arriving proves a full round trip has elapsed — so the count below is
     * read after any request the same-lane drop could have sent would already have been made. It
     * also proves the counter is wired: an assertion that something stayed at zero is worth nothing
     * if it could never have reached one.
     */
    const other = holding === 'Next' ? 'Urgent' : 'Next'
    await dragCardToLane(page, 'The dragged one', other)
    await expect(laneNamed(page, other).locator('.board-card-title')).toHaveText('The dragged one')

    expect(moves, 'the same-lane drop sent a move of its own').toHaveLength(1)
    await expect(page.locator('.feedback-message')).toHaveCount(0)
  })
})

/**
 * **THE OPTIMISTIC PAINT, AND THE SNAP BACK.** PRD's board contract:
 *
 * > *"lane moves render optimistically then reconcile against disk unconditionally (failures
 * > visibly snap back)"*
 *
 * Found missing by P9's annex audit (A18), and found while the file's own header claimed it was
 * there. The reconcile was always real — the caller redraws from the server on every outcome — but
 * with nothing painted first there was nothing to reconcile against: the card sat in its old lane
 * for the whole round trip, and a refusal snapped nothing back because nothing had moved.
 *
 * Both halves need the network held still, so `card.move` is intercepted. That is the only way to
 * tell an optimistic paint from a fast one: at 25ms locally, a board that waits for the server and a
 * board that does not are indistinguishable.
 */
test.describe('a lane move renders before the server has answered', () => {
  test('the card is already in the new lane while the request is still in flight',
    async ({ page }, testInfo) => {
      let released = (): void => { /* replaced below */ }
      const inFlight = new Promise<void>(resolve => { released = () => { resolve() } })
      let sawRequest = false

      await page.route('**/api/card.move', async route => {
        sawRequest = true
        // Held until the assertions below have run. Nothing about the paint may depend on this
        // returning, which is the entire claim being tested.
        await inFlight
        await route.continue()
      })

      await openTheBoard(page, `scratch-${testInfo.project.name}-board-drag`)
      const holding = (await laneNamed(page, 'Next').locator('.board-card').count()) === 1
        ? 'Next'
        : 'Urgent'
      const target = holding === 'Next' ? 'Urgent' : 'Next'

      await dragCardToLane(page, 'The dragged one', target)

      // Short on purpose: the server has not replied and cannot, so anything that appears here was
      // painted by the view. A generous timeout would let a *reconcile* satisfy this instead.
      await expect(laneNamed(page, target).locator('.board-card-title'))
        .toHaveText('The dragged one', { timeout: 1_000 })
      await expect(laneNamed(page, holding).locator('.board-card')).toHaveCount(0)
      // The counts move with it — a header that still claims the old number is a board disagreeing
      // with itself.
      await expect(laneNamed(page, target).locator('.board-lane-count')).toHaveText('1')
      await expect(laneNamed(page, holding).locator('.board-lane-count')).toHaveText('0')
      expect(sawRequest, 'the move was never actually sent').toBe(true)

      released()
      // ...and the reconcile still lands, so the paint is not the end of the story.
      await expect(laneNamed(page, target).locator('.board-card-title'))
        .toHaveText('The dragged one')
    })

  test('a refused move visibly snaps the card back', async ({ page }, testInfo) => {
    await page.route('**/api/card.move', async route => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'IO_FAILED', message: 'nope' } }),
      })
    })

    await openTheBoard(page, `scratch-${testInfo.project.name}-board-drag`)
    const holding = (await laneNamed(page, 'Next').locator('.board-card').count()) === 1
      ? 'Next'
      : 'Urgent'
    const target = holding === 'Next' ? 'Urgent' : 'Next'

    await dragCardToLane(page, 'The dragged one', target)

    /**
     * The card goes back **because the reconcile redraws from disk**, not because anything undoes
     * the paint. That is the whole design: there is one source of truth and the view is a picture
     * of it, so a failed move needs no inverse operation — it needs a redraw, which happens anyway.
     */
    await expect(laneNamed(page, holding).locator('.board-card-title')).toHaveText('The dragged one')
    await expect(laneNamed(page, target).locator('.board-card')).toHaveCount(0)
    // And it says so. A card sliding back with no explanation is the app looking broken.
    await expect(page.locator('.feedback-message')).toHaveCount(1)
  })
})

/**
 * **A21 and A22 — the drop target, and the highlight that must not strobe.**
 *
 * `dragleave` fires on a column every time the pointer crosses into one of its own children, and a
 * lane full of cards is nothing but children. Toggling the highlight on that event makes it flicker
 * all the way down the column, which reads as the drop target refusing you.
 */
test.describe('the drop target', () => {
  test('appears while a card is over the lane, and survives crossing a card inside it',
    async ({ page }, testInfo) => {
      await openTheBoard(page, `scratch-${testInfo.project.name}-board-drag`)

      const state = await page.evaluate(() => {
        const lanes = [...document.querySelectorAll('.board-lane')]
        const withCard = lanes.find(node => node.querySelector('.board-card') !== null)
        const card = withCard?.querySelector('.board-card')
        if (withCard === undefined || card === null || card === undefined) throw new Error('no card')

        const transfer = new DataTransfer()
        const fire = (target: Element, type: string): void => {
          target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
        }
        const visible = (): boolean => {
          const drop = withCard.querySelector('.board-lane-drop')
          return drop !== null && getComputedStyle(drop).display !== 'none'
        }

        const before = visible()
        fire(withCard, 'dragenter')
        const entered = visible()
        // Into a card INSIDE the lane. The enter bubbles to the column, and so does the leave that
        // the browser pairs with it — which is exactly the sequence that used to put the highlight
        // out while the pointer was still over the lane.
        fire(card, 'dragenter')
        fire(withCard, 'dragleave')
        const crossing = visible()
        // ...and out of the lane for real.
        fire(withCard, 'dragleave')
        const left = visible()
        return { before, entered, crossing, left }
      })

      expect(state.before, 'the target must not be showing before a drag').toBe(false)
      expect(state.entered, 'A21: a dashed target appears while dragging over').toBe(true)
      expect(state.crossing, 'A22: crossing a card inside the lane put the highlight out').toBe(true)
      expect(state.left, 'leaving the lane for real must clear it').toBe(false)
    })
})

test.describe('P9F-7 — the guard and the paint agree about where a card is', () => {
  /**
   * **security review, P9 fresh-eyes:** *"the optimistic paint and the same-lane guard disagree about where a
   * card is inside the round-trip window."*
   *
   * The guard used to ask `data` — the board as the server last described it — while the paint moves
   * the node and leaves `data` untouched. Two sources of truth for one question, differing for
   * exactly as long as a round trip.
   *
   * **This test holds that window open.** `page.route` delays `card.move`, so the second drag lands
   * while the first is still in flight, which is the only time the two answers differ. Without the
   * delay the round trip is ~25 ms locally and the case is unreachable — which is precisely why it
   * survived a mutation sweep and a review before this one.
   *
   * **It shares this file's board rather than getting its own, and that is a correction.** The first
   * version added a fixture project, and `playwright.config.ts` records exactly what that costs:
   * every scratch project is seeded per engine and the board's filter enumerates all of them, so
   * *"the tree reached 69 projects and two unrelated specs began missing their deadlines."* It
   * happened again immediately — `board-refresh` went red on WebKit, twice, on the run after the
   * fixture landed. Sharing is safe here because this test leaves the card where it found it.
   */
  test('a second drag inside the round-trip window is not swallowed', async ({ page }, testInfo) => {
    // Held on an object property: assigned only inside a callback, TypeScript narrows a plain
    // `let` to `never` at the release site and the call stops compiling.
    const gate: { release: (() => void) | null } = { release: null }
    await page.route('**/api/card.move', async route => {
      // Hold the FIRST move open; let anything after it through immediately.
      if (gate.release === null) {
        await new Promise<void>(resolve => { gate.release = resolve })
      }
      await route.continue()
    })

    await openTheBoard(page, `scratch-${testInfo.project.name}-board-drag`)

    const from = (await laneNamed(page, 'Next').locator('.board-card').count()) === 1
      ? 'Next'
      : 'Urgent'
    const to = from === 'Next' ? 'Urgent' : 'Next'

    // First drag: paints into `to`, request now hanging.
    await dragCardToLane(page, 'The dragged one', to)
    await expect(laneNamed(page, to).locator('.board-card')).toHaveCount(1)

    /**
     * Second drag, back to where it started, **while the first is still in flight.**
     *
     * With the old guard this was swallowed: `data` still said `from`, so dropping into `from` read
     * as a no-op and the card stayed sitting in `to`. The person's last gesture did nothing.
     */
    await dragCardToLane(page, 'The dragged one', from)
    await expect(laneNamed(page, from).locator('.board-card'), 'the second drag was swallowed')
      .toHaveCount(1)

    // Release the first request and let both reconcile.
    gate.release?.()
    await expect(laneNamed(page, from).locator('.board-card')).toHaveCount(1)
  })
})

