import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseChatroom } from '../../src/core/chatroom'
import { IndexStore } from '../../src/core/index-store'
import { indexRegisteredRoot } from '../../src/core/indexer'
import { loadConfigService } from '../../src/server/config-service'
import { createRootRegistry } from '../../src/server/root-registry'
import { createServices, type Services } from '../../src/server/services'

/**
 * **POSTING TO A CHATROOM.** Spec §14, and P10's own acceptance condition in the build plan:
 * *"append during a concurrent save does not interleave or reuse a number."*
 *
 * The whole subject is that **an append is not a save**. Every other write in this build reads a
 * file, changes it, and writes the result back over the top; that is what makes a save atomic and
 * it is exactly what must not happen here. A conversation has more than one writer by design —
 * the operator on a phone, an agent on the Mac — and a read-modify-write from either one silently
 * deletes whatever the other added in between.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree per test.
 */
let sandbox: string
let rootPath: string
let services: Services
let index: IndexStore

const ROOM = ['02-projects', 'orchard', 'chatroom.md']
const roomPath = (): string => join(rootPath, ...ROOM)
const readRoom = (): Promise<string> => fsp.readFile(roomPath(), 'utf8')

const post = (author: string, body: string) =>
  services['chatroom.append']({ rootId: 'soil', segments: [...ROOM], author, body })

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-chat-'))
  rootPath = join(sandbox, 'root')
  await fsp.mkdir(join(rootPath, '02-projects', 'orchard'), { recursive: true })
  await fsp.writeFile(roomPath(), '# Orchard\n\nThe conversation starts here.\n')
  // The two files §14 names as ordinary documents, so the refusals below have real subjects.
  await fsp.writeFile(join(rootPath, '02-projects', 'orchard', 'chatroom-protocol.md'), '# How\n')
  await fsp.writeFile(join(rootPath, '02-projects', 'orchard', 'notes.md'), '# Notes\n')

  const registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)

  index = new IndexStore()
  await indexRegisteredRoot(registered.value, index)

  const config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })
  services = createServices(registry, index, {
    stagingRoot: join(sandbox, 'app-scratch'),
    archiveRoot: join(sandbox, 'app-archive'),
    browseScope: { home: join(sandbox, 'browse-home'), volumes: join(sandbox, 'browse-volumes') },
  }, config)
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

describe('a message is appended and numbered from the file', () => {
  it('writes a message the parser reads back', async () => {
    const posted = await post('Ellis', 'First thing.')
    expect(posted.number).toBe(1)

    const doc = parseChatroom(await readRoom())
    expect(doc.messages).toEqual([{ number: 1, author: 'Ellis', body: 'First thing.' }])
    // The preamble is untouched — an append adds, it never rewrites.
    expect(doc.preamble).toContain('The conversation starts here.')
  })

  it('numbers from the bytes on disk, not from anything the client sent', async () => {
    // A message written by something that is not this app at all — an agent with a text editor.
    await fsp.appendFile(roomPath(), '\n## M1 -- Ada\n\nPosted by an agent.\n')
    await fsp.appendFile(roomPath(), '\n## M2 -- Ada\n\nAnd another.\n')

    const posted = await post('Ellis', 'Mine.')
    expect(posted.number, 'the number ignored what was already in the file').toBe(3)
  })

  it('leaves everything that was already there exactly as it was', async () => {
    const before = await readRoom()
    await post('Ellis', 'Added.')
    const after = await readRoom()
    // Byte-for-byte prefix. A read-modify-write would be free to reformat, re-encode line endings,
    // or drop a trailing byte — and the file is the operator's, not the app's.
    expect(after.startsWith(before)).toBe(true)
  })
})

describe('§14 — the acceptance condition: appends do not interleave or reuse a number', () => {
  /**
   * **Ten posts at once.** This is the shape the spec is written against: *"an agent posting while
   * the phone appends"*. Under a read-modify-write every one of these would read the same starting
   * bytes and the last writer would win, leaving one message where ten were sent.
   */
  it('keeps every message and gives each a distinct number', async () => {
    const sent = Array.from({ length: 10 }, (_, at) => post('Ada', `Message ${at}`))
    const results = await Promise.all(sent)

    const numbers = results.map(result => result.number).sort((a, b) => a - b)
    expect(numbers, 'a number was reused or skipped').toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    const doc = parseChatroom(await readRoom())
    expect(doc.messages, 'a message was lost').toHaveLength(10)
    // Every body arrived intact — nothing was half-written into the middle of another.
    for (let at = 0; at < 10; at += 1) {
      expect(doc.messages.some(message => message.body === `Message ${at}`)).toBe(true)
    }
  })

  /**
   * **THE ONE THE BUILD PLAN NAMES.** A full-file save and an append, together, on the same file.
   *
   * They take the same lock key, and §14 says why that matters: *"the same key governs full-file
   * saves, so an append can never race a save of the same file."* Without it the save's
   * temp-and-rename would replace the file **including** the appended message, and the message
   * would be gone with no error anywhere — the save succeeded, after all.
   */
  it('an append during a concurrent save loses neither', async () => {
    const loaded = await services['file.load']({ rootId: 'soil', segments: [...ROOM] })
    const edited = `${loaded.content}\nEdited by the editor.\n`

    const [, appended] = await Promise.all([
      services['file.save']({
        rootId: 'soil',
        segments: [...ROOM],
        content: edited,
        expectedHash: loaded.hash,
        confirmTruncation: false,
      }),
      post('Ellis', 'Posted from the phone.'),
    ])

    const after = await readRoom()
    const doc = parseChatroom(after)

    /**
     * Whichever order they landed in, **both changes are present**. If the save ran second it wrote
     * bytes that did not contain the message — so the message being here proves the append was not
     * overwritten; if the append ran second it added to the saved bytes.
     *
     * One outcome is legitimately absent: the save may be refused as a conflict, because the append
     * changed the file after the hash was taken. That is correct and is the conflict contract doing
     * its job — so the assertion is on the *message*, which must survive either way.
     */
    expect(doc.messages, 'the message was lost to the save').toHaveLength(1)
    expect(doc.messages[0]?.body).toBe('Posted from the phone.')
    expect(appended.number).toBe(1)
  })
})

describe('§14 — what may be appended to, and what may not', () => {
  it('refuses a file that is not named chatroom.md', async () => {
    await expect(services['chatroom.append']({
      rootId: 'soil',
      segments: ['02-projects', 'orchard', 'notes.md'],
      author: 'Ellis',
      body: 'x',
    })).rejects.toThrow()
  })

  /**
   * §14's equality, at the route. `chatroom-protocol.md` is the document that *explains* the format;
   * a composer appended to it would be writing messages into the instructions.
   */
  it('refuses chatroom-protocol.md', async () => {
    await expect(services['chatroom.append']({
      rootId: 'soil',
      segments: ['02-projects', 'orchard', 'chatroom-protocol.md'],
      author: 'Ellis',
      body: 'x',
    })).rejects.toThrow()
    expect(await fsp.readFile(
      join(rootPath, '02-projects', 'orchard', 'chatroom-protocol.md'), 'utf8',
    )).toBe('# How\n')
  })

  it('refuses a chatroom that does not exist rather than creating one', async () => {
    await expect(services['chatroom.append']({
      rootId: 'soil',
      segments: ['02-projects', 'orchard', 'nowhere', 'chatroom.md'],
      author: 'Ellis',
      body: 'x',
    })).rejects.toThrow()
    await expect(fsp.stat(join(rootPath, '02-projects', 'orchard', 'nowhere'))).rejects.toThrow()
  })

  /**
   * §12's gate, on the way in. A NUL appended into a conversation makes the file one this app can
   * never open again — and it would arrive through the same composer as every ordinary message.
   */
  it('refuses a body carrying a NUL, and writes nothing', async () => {
    const before = await readRoom()
    await expect(post('Ellis', `bad${String.fromCharCode(0)}message`)).rejects.toThrow()
    expect(await readRoom()).toBe(before)
  })

  it('refuses an empty author or an empty body', async () => {
    await expect(post('   ', 'x')).rejects.toThrow()
    await expect(post('Ellis', '   ')).rejects.toThrow()
  })

  it('refuses a path that escapes the root', async () => {
    await expect(services['chatroom.append']({
      rootId: 'soil', segments: ['..', 'chatroom.md'], author: 'A', body: 'x',
    })).rejects.toThrow()
  })
})
