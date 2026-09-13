import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page, type TestInfo } from '@playwright/test'

import { openRoot } from './tree-nav'

import { E2E_TREE } from '../../playwright.config'

/**
 * **THE CONVERSATION, IN A REAL BROWSER.** Spec §14 — *"the user's daily reading surface, and the one
 * they asked to be certain survived."*
 *
 * The parse and the append are proven against the filesystem in `test/core/chatroom.test.ts` and
 * `test/server/chatroom.test.ts`. What only a browser can answer is whether any of it reaches a
 * person: whether a `chatroom.md` opens as a conversation rather than as an editor, whether the
 * document that *explains* the format stays an ordinary document, and whether a message typed into
 * the composer arrives in the file.
 */

const room = (testInfo: TestInfo): string => `scratch-${testInfo.project.name}-chatroom`

async function openTheRoom(page: Page, testInfo: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()
  const tree = await openRoot(page)
  await tree.getByText('02-projects', { exact: true }).click()
  await tree.getByText(room(testInfo), { exact: true }).click()
  await tree.getByText('chatroom', { exact: true }).click()
}

test.describe('a chatroom opens as a conversation', () => {
  test('shows its messages with their authors, and never as an editor',
    async ({ page }, testInfo) => {
      await openTheRoom(page, testInfo)

      // The editor must not be here. A chatroom that opened in CodeMirror would be the branch
      // failing silently — every character present, and none of the structure.
      await expect(page.locator('.files-main .cm-content')).toHaveCount(0)

      await expect(page.locator('.chat-message')).toHaveCount(2)
      await expect(page.locator('.chat-author').nth(0)).toHaveText('Ada')
      await expect(page.locator('.chat-author').nth(1)).toHaveText('Ellis')
      await expect(page.locator('.chat-number').nth(0)).toHaveText('M1')

      // The preamble is kept rather than dropped — it is content somebody wrote.
      await expect(page.locator('.chat-preamble')).toContainText('Orchard planning')

      // Rendered, not raw: the bold is an element and its markers are gone.
      await expect(page.locator('.chat-body strong').first()).toHaveText('bold')

      /**
       * **The brackets survive.** `[draft]` parses as a shortcut reference link with no
       * destination, and rendering it as a link would show `draft` — the document appearing to have
       * lost characters it still contains, which is the old app's failure exactly.
       */
      await expect(page.locator('.chat-message').nth(1)).toContainText('[draft]')
    })

  /**
   * §14's equality, on screen. `chatroom-protocol.md` is the document that *explains* the message
   * format — its example heading is a `## M1 -- Example` line — so a glob would render the
   * instructions as an unreadable conversation.
   */
  test('leaves chatroom-protocol.md as an ordinary document', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()
    const tree = await openRoot(page)
    await tree.getByText('02-projects', { exact: true }).click()
    await tree.getByText(room(testInfo), { exact: true }).click()
    await tree.getByText('chatroom protocol', { exact: true }).click()

    // The editor, not the conversation — even though the file contains a valid message header.
    await expect(page.locator('.files-main .cm-content')).toBeVisible()
    await expect(page.locator('.chat-message')).toHaveCount(0)
  })

  test('posts a message, which lands in the file and appears in the conversation',
    async ({ page }, testInfo) => {
      await openTheRoom(page, testInfo)

      await page.locator('.chat-field').fill('Posted from the browser.')
      await page.locator('.chat-post').click()

      /**
       * The name is asked for once, at the first post rather than when the room opens — reading a
       * conversation should never put a dialog in front of anyone, and most visits are reading.
       */
      await page.locator('.modal-input').fill('Tester')
      await page.locator('.modal-confirm').click()

      await expect(page.locator('.chat-message')).toHaveCount(3)
      await expect(page.locator('.chat-author').nth(2)).toHaveText('Tester')
      await expect(page.locator('.chat-number').nth(2)).toHaveText('M3')

      // ...and it is in the file, which is the only place it counts.
      const onDisk = await readFile(
        join(E2E_TREE, '02-projects', room(testInfo), 'chatroom.md'), 'utf8',
      )
      expect(onDisk).toContain('## M3 -- Tester')
      expect(onDisk).toContain('Posted from the browser.')
      // The messages that were already there are untouched — an append adds, it never rewrites.
      expect(onDisk).toContain('## M1 -- Ada')
      expect(onDisk).toContain('# Orchard planning')
    })

  test('does not ask for the name a second time', async ({ page }, testInfo) => {
    await openTheRoom(page, testInfo)

    await page.locator('.chat-field').fill('First one.')
    await page.locator('.chat-post').click()
    await page.locator('.modal-input').fill('Tester')
    await page.locator('.modal-confirm').click()
    await expect(page.locator('.chat-author').last()).toHaveText('Tester')

    await page.locator('.chat-field').fill('Second one.')
    await page.locator('.chat-post').click()

    // No dialog this time — the name is remembered with the rest of this client's view state.
    await expect(page.locator('.modal-backdrop')).toHaveCount(0)
    await expect(page.locator('.chat-message').last()).toContainText('Second one.')
  })
})
