import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page, type TestInfo } from '@playwright/test'

import { openRoot } from './tree-nav'

import { E2E_TREE } from '../../playwright.config'

/**
 * **UNSAVED WORK SURVIVES THE TAB DYING.** Spec §13.8, in a real browser against a real IndexedDB.
 *
 * `retained-buffer.ts` has held every rule in §13.8 since P3 — never auto-replay, discard corrupt or
 * oversized blobs, treat a quota failure as blocking rather than as a dropped edit — with the store
 * injected so all of it was testable without a browser. **Nothing ever passed it a store.** Correct,
 * thoroughly tested, and reachable by no product code: the security review's eighth unreachable module and finding
 * G4 of the P7 review. An unsaved edit on a phone iOS had suspended had no rescue at all.
 *
 * So the unit suite could never have proven this feature, and cannot now: there is no IndexedDB in
 * Node, and the whole missing piece was the adapter. These tests are the only place the claim is
 * actually tested.
 *
 * **The crash is real, not simulated.** The test types, waits until the buffer is genuinely in
 * IndexedDB, and then reloads the page — which destroys the pending autosave along with everything
 * else, exactly as closing a lid or an iOS eviction would. That window exists because
 * `RETAIN_QUIET_MS` (400 ms) is deliberately shorter than `AUTOSAVE_QUIET_MS` (1000 ms): keep, then
 * save, then drop.
 */

const STORE_DEADLINE_MS = 10_000

/** Named once. `session.ts` posts every verb under `/api/`, and this is the one that saves. */
const SAVE_ROUTE = '/api/file.save'

test.beforeEach(async ({ page }) => {
  const problems: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', error => { problems.push(error.message) })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  ;(test.info() as { problems?: string[] }).problems = problems
})

function scratchFolder(testInfo: TestInfo, purpose: string): string {
  return `scratch-${testInfo.project.name}-${purpose}`
}

/** Opens the scratch folder's `subject.md` in the editor. */
async function openSubject(page: Page, testInfo: TestInfo, purpose: string) {
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  const folder = scratchFolder(testInfo, purpose)
  await tree.locator('.tree-row').filter({ has: page.getByText(folder, { exact: true }) }).click()
  await tree.getByText('subject', { exact: true }).click()
  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('the scratch document')
  return editor
}

/**
 * How many retained buffers this origin is holding.
 *
 * Reads the real database by name, so it also proves the adapter created the store it says it
 * creates — a count read out of the app's own module would only prove the app agrees with itself.
 */
async function retainedCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase | null>(resolve => {
      const request = indexedDB.open('soil-viewer')
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { resolve(null) }
    })
    if (db === null || !db.objectStoreNames.contains('retained-buffers')) return 0
    return new Promise<number>(resolve => {
      const request = db.transaction('retained-buffers', 'readonly')
        .objectStore('retained-buffers').count()
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { resolve(0) }
    })
  })
}

/**
 * Reloads, and waits for the app to reopen the file by itself.
 *
 * **Nothing is clicked here on purpose.** §15's per-client session memory reopens the last file
 * after a reload, which means the restore question arrives on the path a person actually takes —
 * they do not navigate back to the document, the app puts them there. Re-navigating by hand would
 * open the file a second time and ask a second time, which is a race the test would have created.
 */
async function crashAndReopen(page: Page) {
  await page.reload()
  await expect(page.locator('#app')).toBeAttached()
  const editor = page.locator('.cm-content')
  await expect(editor).toBeVisible({ timeout: STORE_DEADLINE_MS })
  return editor
}

/**
 * **Keep, then save, then drop** — the whole loop, against the real store.
 *
 * The second half is not housekeeping. A buffer that outlives its save is found by the next open,
 * compared against a file that already holds the same text, and produces a question with no answer
 * — which is how a person learns to dismiss this dialog without reading it.
 */
test('an unsaved edit is kept in IndexedDB, and dropped once it reaches disk', async (
  { page }, testInfo,
) => {
  const editor = await openSubject(page, testInfo, 'retain')

  await editor.click()
  await page.keyboard.type('UNSAVED')

  // Kept before the save is even attempted.
  await expect.poll(() => retainedCount(page), { timeout: STORE_DEADLINE_MS })
    .toBeGreaterThan(0)

  await expect(page.locator('.save-status')).toHaveText('Saved', { timeout: STORE_DEADLINE_MS })

  // And dropped once the bytes are on disk.
  await expect.poll(() => retainedCount(page), { timeout: STORE_DEADLINE_MS }).toBe(0)
})

/**
 * **THE ONE THAT MATTERS: the tab dies mid-edit, and the work is still there.**
 *
 * **And it comes back on its own — changed 2026-08-26.** This comment used to say the work is
 * *offered, never replayed*, citing §13.8's rule that a retained copy is never restored
 * automatically. That rule exists to stop a stale copy overwriting an agent's work, and the app now
 * removes that case at the root: a copy whose file changed underneath is dropped unseen. What
 * reaches this path is a file nothing has touched, where the copy is simply the person's own newer
 * text and there is no second version to weigh it against.
 *
 * the operator ruled it on 2026-08-26 with the trade in front of them, after the screen had asked them to
 * choose between versions of their own work twice in a week: *"this is unacceptable UI."*
 */
test('a reload before the save finds the work and puts it back, without asking', async (
  { page }, testInfo,
) => {
  const editor = await openSubject(page, testInfo, 'rescue')
  const file = join(E2E_TREE, '02-projects', scratchFolder(testInfo, 'rescue'), 'subject.md')
  const before = await readFile(file, 'utf8')

  /**
   * **The save is held open, and this is what makes it a test rather than a race.**
   *
   * The first version simply typed and reloaded, betting the reload would beat the 1000 ms
   * autosave. WebKit lost that race and passed; Chromium won it and failed — the save landed, the
   * buffer was correctly discarded, and there was nothing left to offer. A test whose result
   * depends on which browser is quicker is not measuring the feature.
   *
   * **ABORTED rather than held open, changed 2026-08-15, and the reason is a fix landing.** This
   * used to hold the request open and never answer it. §12's `keepalive` was then implemented — it
   * had been specified since 2026-08-06 and was missing — and this test went red, correctly: a
   * `keepalive` request **survives the page teardown**, so the held-open save reached the server
   * during the crash and the file was written. Measured, not guessed: the probe that found it read
   * the file afterwards and saw the typed text on disk.
   *
   * **That is the feature working**, and it narrows what the rescue is for rather than removing it.
   * A save still fails to land when the network is gone, when the server is down, or when the
   * document is over the 64 KiB `keepalive` cap — and `abort()` is the first of those, which is the
   * most ordinary: a dropped tailnet connection, a lid closed away from the network.
   */
  await page.route(`**${SAVE_ROUTE}`, route => route.abort())

  await editor.click()
  await page.keyboard.type('RESCUE ME')
  await expect.poll(() => retainedCount(page), { timeout: STORE_DEADLINE_MS })
    .toBeGreaterThan(0)
  /**
   * **`Not saved`, not `Saving…` — and the new wording is the stronger precondition.**
   *
   * The old assertion proved the save was *in flight*. This proves it **definitively did not land**,
   * which is what the rescue exists for and what the rest of this test depends on. It changed with
   * the abort above; a request that is refused fails fast rather than hanging.
   */
  await expect(page.locator('.save-status')).toHaveText('Not saved', { timeout: STORE_DEADLINE_MS })

  // The crash.
  const reopened = await crashAndReopen(page)

  /**
   * **It comes back by itself, and nothing is asked.** Changed 2026-08-26 on the ruling.
   *
   * This test used to assert the resolution screen: both versions side by side, "Decide later"
   * keeping the copy, a second reload asking again. That screen is retired — the reasoning is at
   * the call site in `main.tsx` — and what replaces it here is the `available` branch: the file is
   * byte-for-byte what it was when the copy was taken, so there is no competing version and nothing
   * to choose between. The copy is simply the newer text and it goes back on screen.
   */
  await expect(reopened).toContainText('RESCUE ME', { timeout: STORE_DEADLINE_MS })
  await expect(page.getByRole('dialog', { name: 'Unsaved work from earlier' })).toHaveCount(0)

  /**
   * **Into the editor, never onto disk.** The dispatch marks the document dirty and the ordinary
   * autosave carries it from there — which this test's aborted route prevents, so the file is still
   * exactly as it was. Nothing on the restore path writes to a file.
   *
   * MUTATION: write the retained text to disk instead of dispatching it. Must redden.
   */
  expect(await readFile(file, 'utf8')).toBe(before)
})

/**
 * **THE NAG RULE, against the case that actually produces a nag.**
 *
 * The first version of this test typed, waited for "Saved", reloaded and asserted no dialog — and
 * it proved the wrong thing. A successful save *discards* the buffer, so there was nothing left for
 * the offer rule to be consulted about; the mutation sweep caught it by flipping `worthOffering` to
 * always-true and watching all six tests stay green.
 *
 * The real case is a save that **lands on disk but is never answered** — a dropped tailnet
 * connection on the response, which on this setup is an ordinary Tuesday. The bytes are written,
 * the client never hears back, so it never discards, and the next open finds a buffer holding
 * exactly what the file now contains.
 *
 * Asking "which of these two identical documents do you want?" there is not a rescue, it is
 * training: a person who dismisses this dialog unread three times will dismiss the fourth one too,
 * and the fourth is the one holding an hour of work. §13.4 makes the same argument about conflicts
 * over byte-identical content.
 */
test('a save that landed but was never answered does not ask on reopen', async (
  { page }, testInfo,
) => {
  const editor = await openSubject(page, testInfo, 'nonag')
  const file = join(E2E_TREE, '02-projects', scratchFolder(testInfo, 'nonag'), 'subject.md')

  // The request goes through and the bytes land. The ANSWER never gets back.
  await page.route(`**${SAVE_ROUTE}`, async route => { await route.fetch() })

  await editor.click()
  await page.keyboard.type('SAVED PROPERLY')
  await expect.poll(() => retainedCount(page), { timeout: STORE_DEADLINE_MS })
    .toBeGreaterThan(0)

  // The write really happened, which is what makes the buffer and the file identical.
  await expect.poll(() => readFile(file, 'utf8'), { timeout: STORE_DEADLINE_MS })
    .toContain('SAVED PROPERLY')
  // And the client still believes it is waiting, so nothing has discarded the buffer.
  await expect(page.locator('.save-status')).toHaveText('Saving…')

  await crashAndReopen(page)

  /**
   * **The copy is now DROPPED here, not merely left unasked-about.** Changed 2026-08-26.
   *
   * Until this ruling the rule was only "do not ask about a copy that matches the file", which left
   * the copy sitting in storage — silent, and a time bomb: the next agent edit made it stop
   * matching, and *that* was the dialog the operator kept meeting. A copy that matches the file has
   * provably done its job, so it goes now, while the fact is still knowable.
   *
   * MUTATION: skip the discard in the byte-identical branch. Must redden.
   */
  await expect.poll(() => retainedCount(page), { timeout: STORE_DEADLINE_MS }).toBe(0)
  await expect(page.locator('.save-status')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Unsaved work from earlier' })).toHaveCount(0)
})

/**
 * **A SAVED DOCUMENT LEAVES NOTHING BEHIND WHEN THE TAB GOES AWAY.**
 *
 * ruled 2026-08-25: *"I'm having agents do work on files, and then when I go back into them in
 * the soil viewer it's like, hey, pick which version you want… why is anything unsaved?"* They were
 * right that nothing should have been, and the answer was not in the restore prompt — it was here.
 *
 * `retainNow()` is called on every end-of-session trigger, and it guards itself with
 * `worthOffering(text, loadedFromDisk)` so it can never store a buffer the read end would refuse.
 * The predicate is the right one. **The baseline was not.** `loadedFromDisk` was assigned once, in
 * `onReady`, and never again — so it answered *"has this document changed since it was opened"*
 * rather than *"is there unsaved work in it"*. Every document they edited and then walked away from
 * wrote a rescue copy of text that was already on disk, and `doc.flush()` beside it saved nothing,
 * so nothing ever discarded it.
 *
 * The buffer is invisible until something else touches the file — which on this tree is constant.
 * The test below is that half; this one is the leak itself, measured at the store.
 *
 * MUTATION: stop refreshing the baseline on a landed save. Must redden.
 */
test('a document that is fully saved retains nothing when the tab goes away', async (
  { page }, testInfo,
) => {
  const editor = await openSubject(page, testInfo, 'retain-phantom')

  await editor.click()
  await page.keyboard.type('EDITED AND SAVED')
  await expect(page.locator('.save-status')).toHaveText('Saved', { timeout: STORE_DEADLINE_MS })
  // The save landed and dropped the buffer. Asserted, so the count below starts from zero rather
  // than from a buffer that happened never to be written.
  await expect.poll(() => retainedCount(page), { timeout: STORE_DEADLINE_MS }).toBe(0)

  /**
   * Switching apps, backgrounding, closing the tab. `onSessionEnding` binds `pagehide`
   * unconditionally, so dispatching it drives the real listener rather than a stand-in.
   */
  await page.evaluate(() => { globalThis.dispatchEvent(new Event('pagehide')) })

  /**
   * **Nothing to rescue, so nothing is kept.** Polled rather than read once: `retainNow` is async
   * and a single read immediately after the event would pass while the write was still in flight.
   */
  await expect.poll(() => retainedCount(page), { timeout: 3000 }).toBe(0)
})

/**
 * **AND THE SYMPTOM THEY ACTUALLY SAW.** The same leak, from the outside.
 *
 * A file they edited in the viewer, left, and an agent then rewrote. Before the fix this reopened
 * onto *"subject.md changed on disk while your edit was unsaved. Keeping yours will replace what is
 * on disk now"* — over an edit they had saved and an agent's work that was never in danger.
 *
 * **This is worse than a nuisance and that is why it is pinned separately.** The offer is real: one
 * click on "Use your unsaved version" followed by a save replaces the agent's file with a copy of
 * what they wrote earlier. The dialog that exists to prevent silent loss was the thing offering it.
 */
test('an agent rewriting a saved file does not produce a version to choose between', async (
  { page }, testInfo,
) => {
  const editor = await openSubject(page, testInfo, 'retain-phantom')
  const file = join(E2E_TREE, '02-projects', scratchFolder(testInfo, 'retain-phantom'), 'subject.md')

  await editor.click()
  await page.keyboard.type('THEIR EARLIER EDIT')
  await expect(page.locator('.save-status')).toHaveText('Saved', { timeout: STORE_DEADLINE_MS })
  await expect.poll(() => readFile(file, 'utf8'), { timeout: STORE_DEADLINE_MS })
    .toContain('THEIR EARLIER EDIT')

  // They walk away.
  await page.evaluate(() => { globalThis.dispatchEvent(new Event('pagehide')) })

  // An agent does the work they asked it to do.
  await writeFile(file, '# Subject\n\nthe scratch document, rewritten by an agent\n')

  await crashAndReopen(page)
  await expect(page.locator('.cm-content')).toContainText('rewritten by an agent', {
    timeout: STORE_DEADLINE_MS,
  })
  await expect(page.getByRole('dialog', { name: 'Unsaved work from earlier' })).toHaveCount(0)
})

/**
 * **A KEYSTROKE DURING THE ROUND TRIP IS STILL UNSAVED WORK, and the obvious fix loses it.**
 *
 * The two tests above are satisfied by *any* baseline that moves when a save lands — including
 * `editorHandle.current?.text()`, which is shorter, reads fine, and is wrong. That version was
 * written, mutated in, and **all five tests stayed green**, which is why this one exists.
 *
 * The difference only shows when the buffer is ahead of the request: type, the save goes out, type
 * again before it answers. `text()` at the moment the response lands includes the second keystroke,
 * which is *not* on disk — so the baseline says the document is safe, `retainNow` declines to keep
 * it, and the one copy is dropped by the save that discards the buffer. Close the lid and the edit
 * is gone from everywhere.
 *
 * `detail.onDisk` is the text the session captured *before* its await, for exactly this reason —
 * the same capture that keeps `expectedHash` describing the same document as the content it is sent
 * with. This test is that capture, proven from the outside.
 *
 * MUTATION: take the baseline from the editor instead of the response. Must redden.
 */
test('an edit typed while a save was in flight is still kept', async ({ page }, testInfo) => {
  const editor = await openSubject(page, testInfo, 'retain-inflight')

  /**
   * The first save is held, then allowed through; every later one is refused.
   *
   * Both halves matter. The delay opens the window to type into. The refusal is what leaves the
   * second edit genuinely unsaved — otherwise the follow-up autosave lands a second later, writes
   * it, and there is nothing left for the rescue to be right or wrong about.
   */
  let saves = 0
  await page.route(`**${SAVE_ROUTE}`, async route => {
    saves += 1
    if (saves > 1) { await route.abort(); return }
    await new Promise(resolve => setTimeout(resolve, 2500))
    await route.continue()
  })

  await editor.click()
  await page.keyboard.type('ALPHA')
  await expect(page.locator('.save-status')).toHaveText('Saving…', { timeout: STORE_DEADLINE_MS })

  // Into the window. This text never reaches disk.
  await page.keyboard.type('BETA')

  // The first save lands — and discards the buffer, which is correct: those bytes ARE on disk.
  await expect(page.locator('.save-status')).toHaveText('Saved', { timeout: STORE_DEADLINE_MS })
  // The follow-up is refused, so BETA is now unsaved and unrescued.
  await expect(page.locator('.save-status')).toHaveText('Not saved', { timeout: STORE_DEADLINE_MS })

  // The lid closes.
  await page.evaluate(() => { globalThis.dispatchEvent(new Event('pagehide')) })

  await expect.poll(() => retainedCount(page), { timeout: STORE_DEADLINE_MS })
    .toBeGreaterThan(0)
})

/**
 * **THE QUESTION, MEASURED: can an agent's edit still put the dialog in front of them?**
 *
 * 2026-08-26: *"agents are the main editors of my files, I really don't want to be getting asked
 * which version I want, is that fixed?"*
 *
 * The baseline fix closes the common path — an edited-and-saved document now leaves nothing behind.
 * This is the case it does NOT close, and the point of this test is to find out whether it is
 * reachable in a browser rather than to argue about it on paper.
 *
 * The sequence: the save's bytes reach disk, the ANSWER is lost on the way back, so the client never
 * learns it landed and never discards its rescue copy. On its own that is silent — the copy matches
 * the file, and `worthOffering` declines to ask. Then an agent rewrites the file, and the copy stops
 * matching.
 *
 * A dropped response is not exotic here: this app is reached over a tailnet from a phone, and the
 * existing `nonag` test above was written around exactly this loss.
 *
 * **This test asserts what actually happens, not what should.** If it goes red the residual is real
 * and the operator gets told; if it passes, the fix covers their case and they get told that instead.
 */
test('an agent rewriting a file whose save answer was lost does not ask them to choose', async (
  { page }, testInfo,
) => {
  const editor = await openSubject(page, testInfo, 'retain-lost-answer')
  const file = join(E2E_TREE, '02-projects', scratchFolder(testInfo, 'retain-lost-answer'), 'subject.md')

  // The bytes land. The answer never comes back.
  await page.route(`**${SAVE_ROUTE}`, async route => { await route.fetch() })

  await editor.click()
  await page.keyboard.type('THEIR TYPING')
  await expect.poll(() => retainedCount(page), { timeout: STORE_DEADLINE_MS }).toBeGreaterThan(0)
  await expect.poll(() => readFile(file, 'utf8'), { timeout: STORE_DEADLINE_MS })
    .toContain('THEIR TYPING')
  // The client still believes it is waiting, so nothing has discarded the rescue copy.
  await expect(page.locator('.save-status')).toHaveText('Saving…')

  // An agent does its job.
  await writeFile(file, '# Subject\n\nthe scratch document, rewritten by an agent\n')

  await crashAndReopen(page)
  await expect(page.locator('.cm-content')).toContainText('rewritten by an agent', {
    timeout: STORE_DEADLINE_MS,
  })
  await expect(page.getByRole('dialog', { name: 'Unsaved work from earlier' })).toHaveCount(0)
})
