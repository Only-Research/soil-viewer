import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { conflictNameFor } from '../../src/core/fs/conflict'
import { IndexStore } from '../../src/core/index-store'
import { indexRegisteredRoot } from '../../src/core/indexer'
import { loadConfigService } from '../../src/server/config-service'
import { createRootRegistry, type RootRegistry } from '../../src/server/root-registry'
import { createServices, type Services } from '../../src/server/services'

/**
 * **EVERY INBOX IN ONE VIEW.** PRD's Inbox tab.
 *
 * *"Every inbox across the tree in one view — soil defaults: any `01-inbox` folder, plus the root
 * `99-inbox-main`. Items are files **and** folders, shown flat, grouped by which project's inbox
 * they sit in."*
 *
 * `isInboxItem` had been in the grammar since P1 with **no product caller** — the twelfth control
 * in this build that was complete and reachable by nothing. It already knew the two rules that
 * matter here, and both are asserted below rather than assumed.
 */
let sandbox: string
let rootPath: string
let registry: RootRegistry
let index: IndexStore
let services: Services

const reindex = async (): Promise<void> => {
  const root = registry.get('soil')
  if (root === undefined) throw new Error('no root')
  index.clearRoot('soil')
  await indexRegisteredRoot(root, index)
}

beforeEach(async () => {
  sandbox = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'soil-inbox-')))
  rootPath = join(sandbox, 'root')

  // The workspace inbox at the top, and a project's own.
  await fsp.mkdir(join(rootPath, '99-inbox-main'), { recursive: true })
  await fsp.writeFile(join(rootPath, '99-inbox-main', 'stray-thought.md'), '# Stray\n')
  await fsp.mkdir(join(rootPath, '02-projects', 'cider-line', '01-inbox'), { recursive: true })
  /**
   * **An inbox that is NOT inside a recognised project** — the case that was broken and had no
   * fixture. A round table, a department, any folder the grammar has no opinion about: under the old
   * rule every one of these was labelled with the registered folder's id, which is what produced
   * the operator's twenty-plus identical rows.
   */
  await fsp.mkdir(join(rootPath, '01-internal', 'coffee-branding', '01-inbox'), { recursive: true })
  await fsp.writeFile(
    join(rootPath, '01-internal', 'coffee-branding', '01-inbox', 'note.md'), '# Note\n')

  registry = createRootRegistry({ reservedPaths: [], browsableRoots: [], browsableRootsResolved: [] })
  const registered = await registry.register('soil', rootPath)
  if (!registered.ok) throw new Error(`fixture root failed: ${registered.code}`)
  index = new IndexStore()
  await indexRegisteredRoot(registered.value, index)

  const config = await loadConfigService({
    registryPath: join(sandbox, 'registry.json'),
    uiStatePath: join(sandbox, 'ui-state.json'),
  })
  services = createServices(registry, index, {
    stagingRoot: join(sandbox, 'scratch'),
    archiveRoot: join(sandbox, 'archive'),
    browseScope: { home: sandbox, volumes: join(sandbox, 'volumes') },
  }, config)
})

afterEach(async () => { await fsp.rm(sandbox, { recursive: true, force: true }) })

const groupFor = (label: string) =>
  services['inbox.list']().find(group => group.label === label)

/**
 * **THE LABELS CHANGED ON 2026-08-19, and these tests asserted the bug.**
 *
 * A group used to be labelled by asking *"is this inbox inside a formally-recognised project?"* and
 * falling back to the registered folder's **id** when it was not. The operator, looking at their own tree:
 * *"there's a bunch of inboxes called **the soil**… it's reading too high up. The inbox main should
 * be the name, and then projects — I have an inbox in projects, it should be showing projects."*
 *
 * Twenty-plus identical rows were that one fallback firing over and over — not duplication.
 *
 * A group is now labelled by its **parent folder**, and the top-level one names itself, which is their
 * stated exception. So `soil` (an id nobody chose) becomes `99-inbox-main`.
 */
describe('finding the inboxes', () => {
  it('finds both the workspace inbox and a project one', () => {
    expect(services['inbox.list']().map(group => group.label).sort())
      .toEqual(['99-inbox-main', 'cider-line', 'coffee-branding'])
  })

  /**
   * **THE ONE REPORTED.** An inbox whose parent is not a project used to be labelled with
   * the registered folder's id, so every such inbox in their tree read as the same thing.
   *
   * MUTATION: label by `enclosingProject(...) ?? rootId` again. Must redden — and note the project
   * case below stays green under that mutation, which is exactly why the bug survived: the rule was
   * right for the one shape anyone had a fixture for.
   */
  it('labels an inbox that is NOT in a project with its own parent folder', () => {
    expect(groupFor('coffee-branding')?.segments)
      .toEqual(['01-internal', 'coffee-branding', '01-inbox'])
    expect(services['inbox.list']().map(group => group.label))
      .not.toContain('soil')
  })

  it('labels a project inbox with the project it belongs to', () => {
    expect(groupFor('cider-line')?.segments).toEqual(['02-projects', 'cider-line', '01-inbox'])
  })

  /**
   * **An empty inbox is still listed.** It is where a quick capture goes, and a folder that
   * disappeared the moment it was emptied would be the one you could not put anything into.
   */
  it('lists an inbox with nothing in it', () => {
    expect(groupFor('cider-line')?.items).toEqual([])
  })

  /** PRD: *"items are files AND folders"*. The soil's inboxes take folders of reference material. */
  it('shows a folder as an item, not only files', async () => {
    await fsp.mkdir(join(rootPath, '99-inbox-main', 'reference-pack'), { recursive: true })
    await reindex()

    expect(groupFor('99-inbox-main')?.items.map(item => item.name).sort())
      .toEqual(['reference-pack', 'stray-thought.md'])
  })

  /** Flat: what is inside a folder in an inbox is not itself an inbox item. */
  it('does not descend into a folder that is in an inbox', async () => {
    await fsp.mkdir(join(rootPath, '99-inbox-main', 'reference-pack'), { recursive: true })
    await fsp.writeFile(join(rootPath, '99-inbox-main', 'reference-pack', 'deep.md'), '# Deep\n')
    await reindex()

    expect(groupFor('99-inbox-main')?.items.map(item => item.name)).not.toContain('deep.md')
  })

  /**
   * §3 again: an inbox inside an archive is a record, not a place things arrive.
   *
   * **The GROUP must be absent, not merely empty**, and that distinction is the whole test. The
   * first version asserted only that `old.md` was not among the items — which passed even with the
   * archive check deleted, because `isInboxItem` filters archived *items* on its own. What it did
   * not catch is the archived inbox still appearing in the list as a labelled, empty capture
   * target: a folder the Inbox tab would happily write a new note into. Writing into an archive is
   * the failure, not seeing an old file.
   */
  it('does not offer an archived inbox at all', async () => {
    const archived = ['02-projects', 'archive-me', 'archive', '01-inbox']
    await fsp.mkdir(join(rootPath, ...archived), { recursive: true })
    await fsp.writeFile(join(rootPath, ...archived, 'old.md'), '# Old\n')
    await reindex()

    const groups = services['inbox.list']()
    expect(groups.map(group => group.segments.join('/'))).not.toContain(archived.join('/'))
    expect(groups.flatMap(group => group.items.map(item => item.name))).not.toContain('old.md')
  })

  /**
   * §13.5: a conflict artifact is *"never a card, inbox item, project or chatroom"*. The grammar
   * already refuses it; this proves the tab inherits that rather than re-deriving it and getting
   * it wrong — which is what happened to the card path once, in a different tab.
   */
  it('does not show a conflict artifact as a second inbox item', async () => {
    /**
     * **The real name, produced by the real function.** The first version of this test invented
     * `stray-thought.conflict-ABCD.md`, which the grammar does not recognise — so the artifact
     * appeared in the list and the test failed for a fixture reason while looking like a product
     * defect. A rule about a naming convention has to be tested with a name the convention makes.
     */
    const named = conflictNameFor('stray-thought.md', new Date(Date.UTC(2026, 7, 10, 9, 30)), 'ABCD')
    if (!named.ok) throw new Error('fixture name failed')
    await fsp.writeFile(join(rootPath, '99-inbox-main', named.value), '# Rescued\n')
    await reindex()

    expect(groupFor('99-inbox-main')?.items.map(item => item.name)).toEqual(['stray-thought.md'])
  })

  /**
   * **Fullest first.** The tab exists to show what needs dealing with; alphabetical order would
   * bury the pile under a run of empty project inboxes.
   */
  it('puts the fullest inbox first', async () => {
    /**
     * **The fixture is chosen so fullness and alphabet disagree.** The first version made
     * `cider-line` the fuller one — which also sorts first alphabetically, so deleting the count
     * comparison entirely left the test green. `soil` sorts last and is given the bigger pile, so
     * only a real count check puts it at the top.
     */
    for (const name of ['a.md', 'b.md', 'c.md']) {
      await fsp.writeFile(join(rootPath, '99-inbox-main', name), '# x\n')
    }
    await fsp.writeFile(join(rootPath, '02-projects', 'cider-line', '01-inbox', 'one.md'), '# x\n')
    await reindex()

    const labels = services['inbox.list']().map(group => group.label)
    expect(labels[0]).toBe('99-inbox-main')
    expect(labels.indexOf('99-inbox-main')).toBeLessThan(labels.indexOf('cider-line'))
  })
})

/**
 * **Capture is `entry.create`, and there is no second creation verb.** Dropping a note into an
 * inbox is making a file in a folder — a path already proven for exclusive create, §13.6's
 * slugification, and never making a directory along the way.
 */
describe('quick capture', () => {
  it('lands in the inbox it was aimed at and appears in the list', async () => {
    const inbox = groupFor('99-inbox-main')
    if (inbox === undefined) throw new Error('no inbox')

    await services['entry.create']({
      rootId: 'soil', parent: [...inbox.segments], name: 'Call Hollis Back', kind: 'file',
    })
    await reindex()

    expect(groupFor('99-inbox-main')?.items.map(item => item.name)).toContain('call-hollis-back.md')
  })
})

/**
 * **THE TWO THINGS SEEN IN THE INBOX**, on their first pass through the built app, 2026-08-12.
 *
 * Neither is exotic. Both are the kind of thing that only shows up when a real person looks at a
 * real list — which is the argument for them looking, and the reason their pass is recorded rather
 * than summarised.
 */
describe('what the first real look at the Inbox found', () => {
  /**
   * > *"I see all these dropped items"* — forty-four of them, sorted `1, 10, 11 … 2, 20`.
   *
   * The file tree already sorts numerically, and says why in `sortEntries`: *"this tree is full of
   * numeric prefixes and a plain string sort gets them backwards."* This list did not go through
   * it. The user's soil is full of numeric prefixes, so it shows up on real content.
   */
  it('sorts numerically, so item 2 comes before item 10', async () => {
    for (const name of ['Dropped item 1.md', 'Dropped item 2.md', 'Dropped item 10.md']) {
      await fsp.writeFile(join(rootPath, '99-inbox-main', name), '# x\n')
    }
    await reindex()
    const names = groupFor('99-inbox-main')?.items.map(item => item.name)
      .filter(name => name.startsWith('Dropped'))
    expect(names).toEqual(['Dropped item 1.md', 'Dropped item 2.md', 'Dropped item 10.md'])
  })

  /**
   * > *"I don't want to see 00-context. There's a ton of inboxes that have nothing in them except
   * > that and they're clogging up."* — ruled 2026-08-21, on their own tree.
   *
   * The context folder is furniture that every unit of work carries, not something that arrived in
   * an inbox.
   */
  it('does not show the context folder as an inbox item', async () => {
    await fsp.mkdir(join(rootPath, '99-inbox-main', '00-context'), { recursive: true })
    await reindex()

    expect(groupFor('99-inbox-main')?.items.map(item => item.name)).toEqual(['stray-thought.md'])
  })

  /**
   * **The second half of their ask, and it needed no second rule.** *"If an inbox only has that, it
   * shouldn't show that inbox."*
   *
   * Hiding the folder makes such an inbox **empty**, and empty inboxes already sort last — so the
   * clog falls to the bottom of the list on its own. Deliberately NOT hidden: the list is also the
   * capture target, and an inbox that vanished the moment it emptied would be the one you could not
   * put anything into. An empty inbox is exactly where the first thing gets dropped.
   *
   * MUTATION: drop the `isContextName` filter. The count goes to 1 and the position assertion
   * reddens — this inbox would sort level with the one holding a real note.
   */
  it('an inbox holding only the context folder counts as empty, and sorts last', async () => {
    const onlyContext = ['02-projects', 'cider-line', '01-inbox', '00-context']
    await fsp.mkdir(join(rootPath, ...onlyContext), { recursive: true })
    await fsp.writeFile(join(rootPath, ...onlyContext, 'about.md'), '# About\n')
    await reindex()

    const groups = services['inbox.list']()
    expect(groupFor('cider-line')?.items, 'nothing in it but furniture').toEqual([])
    expect(groups.map(group => group.label).indexOf('cider-line'),
      'so it sits below every inbox that actually holds something')
      .toBeGreaterThan(groups.map(group => group.label).indexOf('coffee-branding'))
    // Still listed, because this is where a capture goes.
    expect(groups.map(group => group.label)).toContain('cider-line')
  })

  /**
   * §3's one matching rule. `grammarKey` strips the numeric prefix and folds case, so the filter
   * covers the whole family rather than the one spelling that happened to be in front of me.
   *
   * MUTATION: compare `item.name === '00-context'` instead of going through the grammar. Reddens.
   */
  it('hides the context folder however it is prefixed or cased', async () => {
    for (const name of ['00-Context', 'context', '02-context']) {
      await fsp.mkdir(join(rootPath, '99-inbox-main', name), { recursive: true })
    }
    await reindex()

    expect(groupFor('99-inbox-main')?.items.map(item => item.name)).toEqual(['stray-thought.md'])
  })

  /**
   * **The rule is about the inbox, not about the name.** A `00-context` folder elsewhere in the tree
   * is untouched — this hides furniture from one list, it does not make the folder invisible.
   */
  it('leaves a context folder that is not in an inbox alone', async () => {
    await fsp.mkdir(join(rootPath, '02-projects', 'cider-line', '00-context'), { recursive: true })
    await reindex()

    const entry = index.subtree('soil', [])
      .find(row => row.segments.join('/') === '02-projects/cider-line/00-context')
    expect(entry, 'still indexed, still browsable in Files').toBeDefined()
  })

  it('still folds case and NFC the way the rest of the build decides sameness', async () => {
    // The numeric comparison is layered ON the comparison key, not instead of it — losing the
    // folding to gain the digits would trade one wrong order for another.
    for (const name of ['beta.md', 'Alpha.md']) {
      await fsp.writeFile(join(rootPath, '99-inbox-main', name), '# x\n')
    }
    await reindex()
    const names = groupFor('99-inbox-main')?.items.map(item => item.name)
      .filter(name => name === 'Alpha.md' || name === 'beta.md')
    expect(names).toEqual(['Alpha.md', 'beta.md'])
  })
})
