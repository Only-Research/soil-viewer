import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorCode, refusalCodeOf } from '../../src/core/errors'
import { hashBytes } from '../../src/core/fs/document'
import { isConflictArtifact } from '../../src/core/grammar'
import { IndexStore } from '../../src/core/index-store'
import { loadConfigService } from '../../src/server/config-service'
import { createRootRegistry } from '../../src/server/root-registry'
import { createServices, type SaveOutcome, type Services } from '../../src/server/services'
import { tokenReader } from '../support/entry-tokens'

/**
 * The write routes, at the service layer — where §13.8's per-target lock is actually held and where
 * the client's claimed hash meets the file on disk.
 *
 * Until these existed, everything Phase 4 built was unreachable by the app: a complete, well-tested
 * engine that nothing could call.
 *
 * **Nothing goes near `/Users/hallberg/notes`.** Scratch tree per test.
 */
let sandbox: string
let rootPath: string
let services: Services
/** §13.8's token for a path, fetched the way the client fetches it. See the helper. */
let token: (segments: readonly string[]) => Promise<string>

const ORIGINAL = '# Notes\n\nthe original content, long enough to halve\n'
const MINE = '# Notes\n\nmy replacement text, comfortably over half the original\n'

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'soil-viewer-p4-svc-'))
  rootPath = join(sandbox, 'root')
  await fsp.mkdir(rootPath, { recursive: true })
  await fsp.writeFile(join(rootPath, 'notes.md'), ORIGINAL)

  const registry = createRootRegistry({ reservedPaths: [join(sandbox, 'log.jsonl')], browsableRoots: [], browsableRootsResolved: [] })
  // The fixture is not in a git repository, so §11's backup check is waived explicitly — these
  // tests are about writing, not about backups.
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed to register: ${registered.code}`)

  const config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })

  const index = new IndexStore()
  services = createServices(registry, index, {
    // Scratch and archive live in the test's own sandbox, outside the registered root — the same
    // rule production follows, just somewhere disposable.
    stagingRoot: join(sandbox, 'app-scratch'),
    archiveRoot: join(sandbox, 'app-archive'),
      // §11's browsable area, pointed INSIDE this test's sandbox. Never the real home directory:
      // these suites are not about browsing, and a scope that reached `$HOME` would make an
      // unrelated test capable of listing the user's disk.
      browseScope: { home: join(sandbox, 'browse-home'), volumes: join(sandbox, 'browse-volumes') },
  }, config)
  token = tokenReader({ services, index, root: registered.value })
})

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true })
})

const onDisk = (name = 'notes.md') => fsp.readFile(join(rootPath, name), 'utf8')

/**
 * Narrowing helpers, and they are assertions rather than casts on purpose.
 *
 * `expect(o.outcome).toBe('saved')` followed by `o.hash` does not narrow — TypeScript does not read
 * vitest matchers — so every one of these would otherwise be an `as`. An `as` on a discriminated
 * union throws away the exact guarantee the union was introduced for: a test could then assert
 * against the wrong arm and still compile.
 */
function mustSave(outcome: SaveOutcome): Extract<SaveOutcome, { outcome: 'saved' }> {
  if (outcome.outcome !== 'saved') throw new Error(`expected a save, got ${outcome.outcome}`)
  return outcome
}
function mustConflict(outcome: SaveOutcome): Extract<SaveOutcome, { outcome: 'conflict' }> {
  if (outcome.outcome !== 'conflict') throw new Error(`expected a conflict, got ${outcome.outcome}`)
  return outcome
}

describe('loading a document for editing', () => {
  it('returns the content and the hash the client must give back', async () => {
    const loaded = await services['file.load']({ rootId: 'soil', segments: ['notes.md'] })
    expect(loaded.content).toBe(ORIGINAL)
    expect(loaded.hash).toBe(hashBytes(Buffer.from(ORIGINAL)))
    expect(loaded.bytes).toBe(Buffer.byteLength(ORIGINAL))
  })

  it('refuses a file whose bytes are not valid UTF-8, rather than mangling it', async () => {
    /**
     * JSON cannot carry a Buffer, so the transport decodes to a string here. A file with ill-formed
     * bytes does not survive that round trip: decoding replaces the bad bytes, re-encoding produces
     * different ones, and the hash the client returns would not match anything on disk.
     *
     * The visible failure would be a **phantom conflict on a file the user never touched**, which
     * is worse than a refusal because it is unexplainable. So it refuses, and says why.
     */
    const raw = Buffer.from([0x23, 0x20, 0x61, 0x0a, 0xff, 0xfe, 0x0a])
    await fsp.writeFile(join(rootPath, 'ill-formed.md'), raw)

    await expect(services['file.load']({ rootId: 'soil', segments: ['ill-formed.md'] }))
      .rejects.toThrow(/UTF-8/)
    expect((await fsp.readFile(join(rootPath, 'ill-formed.md'))).equals(raw), 'and is untouched')
      .toBe(true)
  })

  it('refuses NUL-bearing bytes too, and both arrive as NOT_EDITABLE rather than a failure', async () => {
    /**
     * **Both halves of §12 at the layer the client meets**, and the code is the assertion that
     * matters. Until P6 opened, the ill-formed case above reached the wire as `IO_FAILED` — the
     * same code a genuine disk fault produces — and the NUL case did not refuse at all.
     *
     * §12 makes these a **state**: the file opens the non-editing pane *with a reason*. P7 builds
     * that pane by branching on the code, so "not editable" and "the filesystem broke" being
     * indistinguishable would leave it nothing to branch on. The message check above pins the
     * sentence; this pins the thing the UI actually reads.
     */
    for (const [name, bad] of [
      ['ill-formed', Buffer.from([0xff, 0xfe])],
      ['NUL-bearing', Buffer.from([0x00])],
    ] as const) {
      const file = `${name}.md`
      await fsp.writeFile(join(rootPath, file), Buffer.concat([Buffer.from('# a\n'), bad]))
      const thrown = await services['file.load']({ rootId: 'soil', segments: [file] })
        .then(() => null, (error: unknown) => error)
      expect(refusalCodeOf(thrown), name).toBe(ErrorCode.NOT_EDITABLE)
    }
  })

  it('refuses an unregistered folder', async () => {
    await expect(services['file.load']({ rootId: 'nope', segments: ['notes.md'] }))
      .rejects.toThrow()
  })

  it('refuses a non-markdown file', async () => {
    await fsp.writeFile(join(rootPath, 'thing.txt'), 'not markdown\n')
    await expect(services['file.load']({ rootId: 'soil', segments: ['thing.txt'] }))
      .rejects.toThrow()
  })
})

describe('saving', () => {
  const save = (over: Partial<Parameters<Services['file.save']>[0]> = {}) =>
    services['file.save']({
      rootId: 'soil',
      segments: ['notes.md'],
      content: MINE,
      expectedHash: hashBytes(Buffer.from(ORIGINAL)),
      confirmTruncation: false,
      ...over,
    })

  it('writes the content and returns the new hash', async () => {
    const saved = mustSave(await save())
    expect(await onDisk()).toBe(MINE)
    expect(saved.hash).toBe(hashBytes(Buffer.from(MINE)))
  })

  it('hands back a hash good enough for the next save', async () => {
    const first = mustSave(await save())
    await services['file.save']({
      rootId: 'soil',
      segments: ['notes.md'],
      content: MINE + 'and more\n',
      expectedHash: first.hash,
      confirmTruncation: false,
    })
    expect(await onDisk()).toBe(MINE + 'and more\n')
  })

  it('cannot be fooled by a well-formed hash the client invented', async () => {
    /**
     * The server never reconstructs a baseline from what the client sent. It re-loads the document,
     * gets a real one, and compares. A digest that is the right shape but describes nothing is just
     * a mismatch — so this is a conflict, and the edit is rescued like any other.
     */
    const outcome = await save({ expectedHash: 'a'.repeat(64) })
    expect(outcome.outcome).toBe('conflict')
    expect(await onDisk()).toBe(ORIGINAL)
  })

  it('blocks a truncating save NAMING THE LOSS, then allows it once confirmed', async () => {
    /**
     * §13.2 does not merely require the block; it requires the confirmation to name what would go:
     * *"an explicit confirmation naming the loss ('this will remove 380 lines')"*.
     *
     * As a thrown refusal this was unmeetable. §6 replaces a refusal's detail with a constant
     * sentence on the way to the wire — correctly, that rule keeps request-derived strings off the
     * transport — so the client received "That save would remove most of the file" with both
     * numbers stripped and had nothing to put in the sentence.
     */
    const blocked = await save({ content: 'x' })
    expect(blocked).toEqual({
      outcome: 'truncation-blocked',
      wasBytes: Buffer.byteLength(ORIGINAL),
      willBeBytes: 1,
    })
    expect(await onDisk(), 'and nothing is written while the question is open').toBe(ORIGINAL)

    mustSave(await save({ content: 'x', confirmTruncation: true }))
    expect(await onDisk()).toBe('x')
  })
})

/**
 * §13.5's rescue, at the layer that has to call it.
 *
 * **This suite exists because the previous behaviour was a throw and a comment.** `file.save`
 * refused a stale hash with `CONFLICT_DETECTED`, the line above it read *"§13.5's rescue and
 * resolution take over from here"*, and `writeConflictArtifact` — complete, tested, mutation-swept
 * — was imported by no production module. The edit lived in the browser and nowhere else.
 *
 * The artifact's own construction is proven in `conflict.test.ts`. What is proven here is only that
 * the save path reaches it, with the right bytes, at both of the two places a conflict is found.
 */
describe('A CONFLICTING SAVE RESCUES THE EDIT — §13.5', () => {
  const THEIRS = '# Notes\n\nan agent wrote this while the editor was open\n'

  const saveStale = (content = MINE) => services['file.save']({
    rootId: 'soil',
    segments: ['notes.md'],
    content,
    expectedHash: hashBytes(Buffer.from(ORIGINAL)),
    confirmTruncation: false,
  })

  const artifacts = async () =>
    (await fsp.readdir(rootPath)).filter(name => name.includes('.conflict-'))

  it('THE ONE THAT MATTERS: the edit is on disk, and so is the other writer\'s', async () => {
    await fsp.writeFile(join(rootPath, 'notes.md'), THEIRS)

    const outcome = mustConflict(await saveStale())

    // Both sides survive. That is the whole requirement: nothing chose between them, and neither
    // was discarded to make room for the other.
    expect(await onDisk(), 'the canonical file is the other writer\'s, untouched').toBe(THEIRS)
    expect(await onDisk(outcome.rescue.join('/')), 'and the rescue holds MY edit').toBe(MINE)
  })

  /**
   * **A stale baseline over IDENTICAL bytes is not a conflict**, and this pair is the cap on the
   * worst thing the sweep of 2026-08-16 found.
   *
   * A conflict is two *different* versions of a document. When the bytes being saved are the bytes
   * already on disk there is no second version — the state the caller is asking for is already
   * true — and rescuing writes a sibling byte-identical to the file beside it. §13.4 names that as
   * a harm of its own: a question with no answer teaches a person to dismiss the dialog unread, and
   * the one that mattered goes with it.
   */
  it('does NOT rescue when the bytes on disk are already exactly what is being saved', async () => {
    await fsp.writeFile(join(rootPath, 'notes.md'), MINE)

    const outcome = mustSave(await saveStale(MINE))

    expect(await artifacts(), 'a sibling identical to the file it sits beside').toEqual([])
    expect(await onDisk(), 'and the canonical file is untouched').toBe(MINE)
    /**
     * **The hash is the one actually on disk**, which is the half that stops the loop rather than
     * merely declining to add to it: the client advances its baseline and stops re-sending. Handing
     * back the stale `expectedHash` would leave it dirty and arriving here again forever.
     */
    expect(outcome.hash).toBe(hashBytes(Buffer.from(MINE)))
  })

  /**
   * **The unbounded case, run to five.** `saveDocument` reports `IO_FAILED` when the directory
   * `fsync` fails *after* the rename has landed — `write.ts` puts that call inside the outer try
   * deliberately, so a save that succeeded is announced as failed. The client keeps `dirty`, never
   * advances its hash, and every later flush re-sends the same content against the same stale
   * baseline. Before this, each one wrote another identical artifact, permanently, in an app with
   * **no delete**. The volume that does it is the one the code already anticipates: an external or
   * SMB disk that refuses `fsync` on a directory descriptor.
   */
  it('does not breed one artifact per retry when a landed save was reported as failed', async () => {
    await fsp.writeFile(join(rootPath, 'notes.md'), MINE)

    for (let attempt = 0; attempt < 5; attempt++) mustSave(await saveStale(MINE))

    expect(await artifacts(), 'five retries, nothing accumulated').toEqual([])
    expect(await onDisk()).toBe(MINE)
  })

  it('reports where it landed, folder-relative, and that is where it actually is', async () => {
    await fsp.writeFile(join(rootPath, 'notes.md'), THEIRS)
    const outcome = mustConflict(await saveStale())

    /**
     * The location is the reason a conflict is an outcome rather than an error: §6 keeps paths off
     * the error envelope, and without it the client cannot open the two-pane resolution — it would
     * know a conflict happened and not which file to open against.
     */
    expect(outcome.rescue).toHaveLength(1)
    expect(outcome.rescue[0]).toMatch(/^notes\.conflict-/)
    /**
     * Recognised by **the grammar's own predicate**, not by a pattern written out here.
     *
     * A hand-rolled regex is how generation and detection drift apart, and `grammar.ts` says in
     * capitals why that is not cosmetic: an artifact the grammar fails to recognise becomes a task
     * card that can never be removed — C5, the defect §13.5 was rewritten to eliminate. My first
     * draft of this line spelled out `[a-z]{4}` and the alphabet is uppercase, which is the same
     * mistake in miniature and is why the assertion now defers.
     */
    expect(isConflictArtifact(outcome.rescue[0] ?? '')).toBe(true)
    expect(await artifacts()).toEqual([...outcome.rescue])
  })

  it('rescues at the SECOND conflict check too — the one inside the write', async () => {
    /**
     * `saveDocument` re-reads and re-hashes from the descriptor it is about to write (§13.4 F4.6),
     * which catches a writer that arrived *after* this handler took its own baseline. The lock
     * closes that window against this app and not against an agent, which is the traffic this tree
     * actually has.
     *
     * Reaching it needs a write that lands between the handler's load and the engine's re-read, so
     * the clock is not what is being raced — `loadDocument` is monkey-patched for exactly one call.
     * Crude, and the alternative is a timing test that passes by luck.
     */
    const documentModule = await import('../../src/core/fs/document')
    const real = documentModule.loadDocument
    const spy = vi.spyOn(documentModule, 'loadDocument').mockImplementation(async (...args) => {
      const loaded = await real(...args)
      // The interleaved writer, landing after the baseline was taken and before the write runs.
      await fsp.writeFile(join(rootPath, 'notes.md'), THEIRS)
      spy.mockRestore()
      return loaded
    })

    const outcome = await saveStale()
    expect(outcome.outcome, 'a late writer is still a conflict, not a 500').toBe('conflict')
    expect(await onDisk(), 'and the late writer is not overwritten').toBe(THEIRS)
    expect(await artifacts(), 'and the edit was rescued here too').toHaveLength(1)
  })

  it('reports conflict-unrescued — not conflict — when the rescue cannot be written', async () => {
    /**
     * §13.5: *"If the conflict file cannot be written for any reason, the buffer is retained
     * client-side and the editor enters a blocking unsaved state."* The client can only do that if
     * it is told, and it can only be reliably told by a **separate discriminant** — an absent
     * `rescue?` field on a `conflict` is something a client can forget to check, and forgetting it
     * means silently treating a lost edit as a rescued one.
     *
     * Provoked by making the directory unwritable, which is a real cause rather than a stub: a
     * folder synced read-only, or one whose permissions an agent changed.
     */
    await fsp.writeFile(join(rootPath, 'notes.md'), THEIRS)
    await fsp.chmod(rootPath, 0o555)
    try {
      const outcome = await saveStale()
      expect(outcome).toEqual({ outcome: 'conflict-unrescued', reason: 'PERMISSION_DENIED' })
    } finally {
      await fsp.chmod(rootPath, 0o755)
    }
    expect(await artifacts(), 'nothing was written, which is why the client must block').toEqual([])
  })

  it('never spawns a conflict child — an artifact that conflicts is unrescued, not chained', async () => {
    /**
     * §13.5: *"A conflict file never spawns a conflict child."* v1's names grew unbounded toward
     * `NAME_MAX` and the overflow lost the edit. Editing an artifact and hitting a conflict is the
     * ordinary way to reach that, and it must come back as the blocking outcome rather than as a
     * second artifact.
     */
    const artifact = 'notes.conflict-20260808-120000-abcd.md'
    await fsp.writeFile(join(rootPath, artifact), ORIGINAL)

    const outcome = await services['file.save']({
      rootId: 'soil',
      segments: [artifact],
      content: MINE,
      expectedHash: 'b'.repeat(64),
      confirmTruncation: false,
    })
    expect(outcome).toEqual({ outcome: 'conflict-unrescued', reason: 'NOT_MARKDOWN' })
    expect(await artifacts(), 'the artifact is still the only one').toEqual([artifact])
  })

  it('a save that is NOT in conflict writes no artifact', async () => {
    // The other half. A rescue that fires on ordinary saves would bury the tree in siblings that
    // nothing in this app can delete.
    mustSave(await services['file.save']({
      rootId: 'soil',
      segments: ['notes.md'],
      content: MINE,
      expectedHash: hashBytes(Buffer.from(ORIGINAL)),
      confirmTruncation: false,
    }))
    expect(await artifacts()).toEqual([])
  })
})

describe('THE LOCK IS ACTUALLY HELD — §13.8', () => {
  it('serializes two concurrent saves of the same file', async () => {
    /**
     * **The test that closes "the lock is built but not wired".** It was written, tested and
     * connected to nothing for several commits, which is this build's signature failure shape: a
     * control correct in isolation and never reached.
     *
     * Both saves are issued against the same starting hash. Unserialized, they interleave: both
     * load, both see the original, both write, and the second silently destroys the first — the
     * double-tap defect §13.8 names, with no error anywhere.
     *
     * Serialized, the first wins and the second finds a file that no longer matches the hash it was
     * given, so it is refused as a conflict. **One success and one conflict is the correct
     * outcome**; two successes would mean an edit was lost.
     */
    const startingHash = hashBytes(Buffer.from(ORIGINAL))
    /**
     * **Reads the discriminant, and no longer resolve-versus-reject.** A conflict is now a returned
     * outcome, so `.then(() => 'saved', () => 'refused')` would have counted the loser as a second
     * success and this test would have gone green on the exact defect it exists to catch. Recorded
     * because it is the hazard of the whole change: a test that discriminates on the shape of the
     * promise stops discriminating on anything.
     */
    const attempt = (content: string) => services['file.save']({
      rootId: 'soil',
      segments: ['notes.md'],
      content,
      expectedHash: startingHash,
      confirmTruncation: false,
    }).then(
      outcome => outcome.outcome === 'saved' ? 'saved' as const : 'refused' as const,
      () => 'refused' as const,
    )

    const outcomes = await Promise.all([
      attempt('# Notes\n\nthe first writer, long enough to clear the guard\n'),
      attempt('# Notes\n\nthe second writer, also long enough to clear it\n'),
    ])

    expect(outcomes.filter(o => o === 'saved'), 'exactly one save may succeed').toHaveLength(1)
    expect(outcomes.filter(o => o === 'refused'), 'and the other must be refused').toHaveLength(1)

    const final = await onDisk()
    expect(
      final === '# Notes\n\nthe first writer, long enough to clear the guard\n' ||
      final === '# Notes\n\nthe second writer, also long enough to clear it\n',
      'the file must be exactly one of the two, not a mixture',
    ).toBe(true)
  })

  it('does not serialize saves to DIFFERENT files', async () => {
    // The other half: a lock that serializes everything would make the app single-threaded across
    // unrelated documents.
    await fsp.writeFile(join(rootPath, 'other.md'), ORIGINAL)
    const hash = hashBytes(Buffer.from(ORIGINAL))

    const both = await Promise.all([
      services['file.save']({
        rootId: 'soil', segments: ['notes.md'], content: MINE,
        expectedHash: hash, confirmTruncation: false,
      }),
      services['file.save']({
        rootId: 'soil', segments: ['other.md'], content: MINE,
        expectedHash: hash, confirmTruncation: false,
      }),
    ])
    expect(both).toHaveLength(2)
    expect(await onDisk('notes.md')).toBe(MINE)
    expect(await onDisk('other.md')).toBe(MINE)
  })
})

describe('rename, copy and resolve — the rest of the write surface', () => {
  it('renames without replacing what is already there', async () => {
    await fsp.writeFile(join(rootPath, 'occupied.md'), 'do not destroy me\n')
    await expect(services['entry.rename']({
      rootId: 'soil', from: ['notes.md'], to: ['occupied.md'], token: await token(['notes.md']),
    })).rejects.toThrow()
    expect(await onDisk('occupied.md')).toBe('do not destroy me\n')
    expect(await onDisk('notes.md')).toBe(ORIGINAL)
  })

  it('renames when the destination is free', async () => {
    const moved = await services['entry.rename']({
      rootId: 'soil', from: ['notes.md'], to: ['renamed.md'], token: await token(['notes.md']),
    })
    expect(moved.to).toEqual(['renamed.md'])
    expect(await onDisk('renamed.md')).toBe(ORIGINAL)
  })

  it('plans a copy without writing anything', async () => {
    await fsp.mkdir(join(rootPath, 'project'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'project', 'a.md'), '# a\n')

    const planned = await services['entry.copy']({
      rootId: 'soil', from: ['project'], to: ['copied'], plan: true,
      token: await token(['project']),
    })
    expect(planned.files).toBe(1)
    expect(planned.to, 'a plan reports no destination because it made none').toBeUndefined()
    await expect(fsp.stat(join(rootPath, 'copied'))).rejects.toThrow()
  })

  it('copies a folder for real', async () => {
    await fsp.mkdir(join(rootPath, 'project'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'project', 'a.md'), '# a\n')

    const copied = await services['entry.copy']({
      rootId: 'soil', from: ['project'], to: ['copied'], plan: false,
      token: await token(['project']),
    })
    expect(copied.to).toEqual(['copied'])
    expect(await onDisk(join('copied', 'a.md'))).toBe('# a\n')
  })

  it('resolves a conflict and reports where the document ended up', async () => {
    const artifact = 'notes.conflict-20260808-143205-ABCD.md'
    await fsp.writeFile(join(rootPath, artifact), MINE)

    const resolved = await services['conflict.resolve']({
      rootId: 'soil', canonical: ['notes.md'], artifact: [artifact], choice: 'mine',
      token: await token(['notes.md']),
    })
    expect(resolved.canonical).toEqual(['notes.md'])
    expect(await onDisk('notes.md')).toBe(MINE)
  })

  it('refuses a resolve whose second path is not a conflict artifact', async () => {
    await fsp.writeFile(join(rootPath, 'ordinary.md'), 'an ordinary document\n')
    await expect(services['conflict.resolve']({
      rootId: 'soil', canonical: ['notes.md'], artifact: ['ordinary.md'], choice: 'theirs',
      token: await token(['notes.md']),
    })).rejects.toThrow()
    expect(await onDisk('ordinary.md')).toBe('an ordinary document\n')
  })

  it('holds BOTH parents when moving between folders', async () => {
    /**
     * A move touches two folders. Holding only the source's lock leaves the destination free for a
     * concurrent create to take the name between the check and the link — so both are acquired, in
     * one sorted acquisition, which is also what makes two opposite-direction moves unable to
     * deadlock.
     *
     * Two moves aimed at the same destination name: exactly one may win.
     */
    await fsp.mkdir(join(rootPath, 'inbox'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'one.md'), 'first\n')
    await fsp.writeFile(join(rootPath, 'two.md'), 'second\n')

    // Tokens resolved BEFORE the race, not inside it. Fetching one inside `race` would serialise
    // the two calls behind their own reconciles and the two renames would no longer overlap — the
    // test would pass while proving nothing about the lock it exists to prove.
    const tokens = {
      'one.md': await token(['one.md']),
      'two.md': await token(['two.md']),
    } as Record<string, string>

    const race = (from: string) => services['entry.rename']({
      rootId: 'soil', from: [from], to: ['inbox', 'landed.md'], token: tokens[from] ?? '',
    }).then(() => 'moved' as const, () => 'refused' as const)

    const outcomes = await Promise.all([race('one.md'), race('two.md')])
    expect(outcomes.filter(o => o === 'moved'), 'one winner').toHaveLength(1)
    expect(outcomes.filter(o => o === 'refused'), 'one refusal').toHaveLength(1)
  })
})

/**
 * §13.8's IDENTITY TOKEN — the control, exercised.
 *
 * **This block exists because of what P7's state check found.** `STALE_TARGET` had been an error
 * code with its own sentence, its own 409 and two tests since P4's gate, and **nothing in `src/`
 * ever threw it.** Both existing tests proved the code was well-formed — that it maps to a status
 * and has a sentence of its own — and neither asked who raises it. That is the same shape as P6's
 * `MAX_WRITE_BODY_BYTES`: three tests on a constant, none on its reader, and the constant was read
 * by nobody for two phases.
 *
 * So these are deliberately written the other way round: every one begins from a *file*, not from
 * a code, and asserts what happened on disk.
 */
describe('§13.8 — a mutation aimed at a target that changed is refused', () => {
  /** Replaces a file the way an agent would: a new file at the same path, so a new inode. */
  const replaceOnDisk = async (name: string, content: string): Promise<void> => {
    await fsp.unlink(join(rootPath, name))
    await fsp.writeFile(join(rootPath, name), content)
  }

  const staleTarget = (thrown: unknown): boolean =>
    refusalCodeOf(thrown) === ErrorCode.STALE_TARGET

  it('THE ONE THAT MATTERS: an agent replaces the file, and the rename does not touch it', async () => {
    // The user's screen was painted while `notes.md` was theirs.
    const shown = await token(['notes.md'])

    // An agent replaces it. Same path, different file — §13.4's `mv draft.md notes.md`, the case
    // mtime cannot see and this token can.
    await replaceOnDisk('notes.md', '# Something else entirely\n\nnot the file that was shown\n')

    // The user taps Rename on the row they are looking at.
    await expect(services['entry.rename']({
      rootId: 'soil', from: ['notes.md'], to: ['renamed.md'], token: shown,
    })).rejects.toSatisfy(staleTarget)

    // The agent's file is still where the agent put it, under its own name, unrenamed.
    expect(await onDisk('notes.md')).toContain('not the file that was shown')
    await expect(fsp.lstat(join(rootPath, 'renamed.md'))).rejects.toThrow()
  })

  it('refuses a token that never came from this server', async () => {
    await expect(services['entry.rename']({
      rootId: 'soil', from: ['notes.md'], to: ['renamed.md'], token: 'AAAAAAAAAAAAAAAAAAAAAA',
    })).rejects.toSatisfy(staleTarget)
    expect(await onDisk()).toBe(ORIGINAL)
  })

  it('refuses an empty token rather than treating it as "no opinion"', async () => {
    // The failure-open shape: a control that accepts the absence of its own input.
    await expect(services['entry.rename']({
      rootId: 'soil', from: ['notes.md'], to: ['renamed.md'], token: '',
    })).rejects.toSatisfy(staleTarget)
    expect(await onDisk()).toBe(ORIGINAL)
  })

  it('refuses when the target is gone, rather than reporting it as missing', async () => {
    const shown = await token(['notes.md'])
    await fsp.unlink(join(rootPath, 'notes.md'))
    // One recovery path for the client — reload the view — rather than two.
    await expect(services['entry.rename']({
      rootId: 'soil', from: ['notes.md'], to: ['renamed.md'], token: shown,
    })).rejects.toSatisfy(staleTarget)
  })

  it('accepts a token for a file whose CONTENT changed — content is not identity', async () => {
    /**
     * The false-positive half, and it is as load-bearing as the refusal.
     *
     * §13.4: *"false positives are equally harmful — an agent rewriting identical bytes would spawn
     * a permanent conflict artifact, which on this tree is the common case."* An in-place edit does
     * not make the rename act on the wrong file; it acts on exactly the file the user pointed at.
     * A token built over size or mtime would refuse here, and the app would look broken.
     */
    const shown = await token(['notes.md'])
    const handle = await fsp.open(join(rootPath, 'notes.md'), 'r+')
    try {
      await handle.write('# Edited in place, same inode, longer than it was before\n', 0)
    } finally {
      await handle.close()
    }

    const moved = await services['entry.rename']({
      rootId: 'soil', from: ['notes.md'], to: ['renamed.md'], token: shown,
    })
    expect(moved.to).toEqual(['renamed.md'])
  })

  it('refuses a copy whose source was replaced, and writes nothing', async () => {
    await fsp.mkdir(join(rootPath, 'project'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'project', 'a.md'), 'a\n')
    const shown = await token(['project'])

    // A directory replaced by a different directory at the same path.
    await fsp.rename(join(rootPath, 'project'), join(rootPath, 'project-moved-away'))
    await fsp.mkdir(join(rootPath, 'project'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'project', 'b.md'), 'b\n')

    await expect(services['entry.copy']({
      rootId: 'soil', from: ['project'], to: ['copied'], plan: false, token: shown,
    })).rejects.toSatisfy(staleTarget)
    await expect(fsp.lstat(join(rootPath, 'copied'))).rejects.toThrow()
  })

  it('refuses a PLAN whose source was replaced — a count for a thing the user never saw', async () => {
    await fsp.mkdir(join(rootPath, 'project'), { recursive: true })
    await fsp.writeFile(join(rootPath, 'project', 'a.md'), 'a\n')
    const shown = await token(['project'])

    await fsp.rename(join(rootPath, 'project'), join(rootPath, 'gone'))
    await fsp.mkdir(join(rootPath, 'project'), { recursive: true })

    await expect(services['entry.copy']({
      rootId: 'soil', from: ['project'], to: ['copied'], plan: true, token: shown,
    })).rejects.toSatisfy(staleTarget)
  })

  it('refuses a conflict resolution whose canonical file was rewritten underneath it', async () => {
    const saved = await services['file.save']({
      rootId: 'soil', segments: ['notes.md'], content: MINE,
      expectedHash: 'not-the-hash-on-disk', confirmTruncation: false,
    })
    const artifact = mustConflict(saved).rescue

    const shown = await token(['notes.md'])
    // An agent rewrites the canonical file while the two-pane view sits open. Keep Theirs would
    // otherwise discard the rescued edit in favour of content the user has never seen.
    await replaceOnDisk('notes.md', '# Rewritten by an agent mid-resolution\n')

    await expect(services['conflict.resolve']({
      rootId: 'soil', canonical: ['notes.md'], artifact: [...artifact], choice: 'theirs', token: shown,
    })).rejects.toSatisfy(staleTarget)

    // Both files still there. Nothing was archived, nothing was chosen.
    expect(await onDisk('notes.md')).toContain('Rewritten by an agent')
    expect((await fsp.lstat(join(rootPath, ...artifact))).isFile()).toBe(true)
  })
})
