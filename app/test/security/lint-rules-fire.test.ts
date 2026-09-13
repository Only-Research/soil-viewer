import { readFile } from 'node:fs/promises'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  attributionFailure, banKey, decompose, demotedBans, enumerateBans, extensionGaps,
  danglingFixtures, gutted, malformedBans, messageAmbiguities, messageContainments,
  scopeMismatch, unprovenBans,
  type Ban, type ConfigBlock,
} from './gate-lib'
import { CORPUS, MUST_PASS } from './gate-corpus'

/**
 * THE META-GATE. The security review's merge condition for the file engine, rebuilt 2026-08-07 to the standard
 * they ruled in `the gate-1 standard`.
 *
 * WHAT IT GUARANTEES: every individual ban in `eslint.config.js` is proven to fire, by a
 * hand-written fixture that DECLARES which ban it proves, at a path where that ban is actually
 * live. Not "the rule name is wired up." Not "some message somewhere mentioned it."
 *
 * WHY IT IS THIS ELABORATE — the history, because every clause is a headstone:
 *   1. `document.write` was configured as a no-restricted-properties entry. No property is
 *      literally named "document.write", so it matched nothing from Phase 0 until 2026-08-06.
 *   2. The first gate enumerated at ESLint RULE-NAME granularity, so a rule counted as proven
 *      when any ONE entry under it had a fixture. A reviewer added a property no property has
 *      and a selector matching nothing; the suite stayed 28/28 green.
 *   3. The second gate matched a ban by BARE SUBSTRING of ESLint's message. `node:net`'s message
 *      contains "net", so the bare-`net` ban was certifiable by node:net's fixture. Found to be
 *      already live: the bare `http` ban had no fixture at all.
 *   4. A red-team then ran 45 attacks against the third gate and NINETEEN stayed green.
 *
 * The checks themselves live in `gate-lib.ts` as pure functions, so the same logic can be run
 * against deliberately broken configs — see `meta-gate-regressions.test.ts`, which encodes all 19
 * holes and asserts each one is still rejected. A gate that has only ever been run against a
 * config it passes is a control that has never rejected anything.
 */

const CONFIG_PATH = new URL('../../eslint.config.js', import.meta.url).pathname

describe('the meta-gate', () => {
  let eslint: ESLint
  let config: ConfigBlock[]
  let bans: Ban[]
  let byKey: Map<string, Ban>

  beforeAll(async () => {
    eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname })
    config = (await import(CONFIG_PATH)).default as ConfigBlock[]
    bans = enumerateBans(config)
    byKey = new Map(bans.map(b => [banKey(b.block, b.id), b]))
  })

  it('enumerates the bans, and the config is shaped so it can', () => {
    expect(bans.length, 'no bans enumerated at all').toBeGreaterThan(40)
    expect(byKey.size, 'two bans share a block and id — identity is not unique').toBe(bans.length)
  })

  it('every ban is configured at error, not warn', () => {
    // the security review item (a). One character used to disable every security control in the build with the
    // gate green and CI passing. Paired with --max-warnings 0 on the lint script.
    expect(demotedBans(bans), 'a demoted ban is a disabled ban').toEqual([])
  })

  it('no ban is malformed in a way that makes it unfirable', () => {
    // the security review item (h). `document.write` as a property name would have been rejected here at
    // Phase 0, before any fixture existed to launder it.
    expect(malformedBans(bans), 'a ban that no real code can ever trip').toEqual([])
  })

  it('a message identifies exactly one ban', () => {
    expect(messageAmbiguities(bans), 'one message names two different bans').toEqual([])
  })

  it('no ban message is contained in another', () => {
    expect(messageContainments(bans), 'a ban could be credited by another ban\'s violation')
      .toEqual([])
  })

  it('every fixture names a ban that exists', () => {
    expect(danglingFixtures(bans, CORPUS), 'fixture declares a ban not in the config').toEqual([])
  })

  it('EVERY ban has a declaring fixture — totality', () => {
    expect(
      unprovenBans(bans, CORPUS),
      'these bans have no fixture that names them, so nothing proves they match anything',
    ).toEqual([])
  })

  it('every scope proves itself at EVERY file extension it claims', () => {
    expect(extensionGaps(config, bans, CORPUS), 'a scope claims an extension no fixture exercises')
      .toEqual([])
  })

  describe('each fixture proves the ban it declares, at a path where that ban is live', () => {
    for (const fixture of CORPUS) {
      it(`proves ${fixture.proves} — ${fixture.what}`, async () => {
        const ban = byKey.get(fixture.proves)
        expect(ban, `unknown ban ${fixture.proves}`).toBeDefined()
        if (ban === undefined) return

        // entry↔scope. Ask ESLint which config governs this path, then require the resolved
        // option set for the rule to EQUAL the declaring block's set. Flat config replaces rather
        // than merges, so a rule's resolved options come from exactly one block — equality
        // therefore identifies the governing block without reimplementing glob matching here.
        // A block shadowed by a later one can never satisfy this, which is how an inert block is
        // caught (hole 5), and a block that forgot an extension fails on its .tsx fixture.
        const resolved = await eslint.calculateConfigForFile(fixture.filePath)
        const resolvedBans = decompose(ban.block, ban.rule, resolved.rules?.[ban.rule])
        const declared = bans.filter(b => b.block === ban.block && b.rule === ban.rule)
        expect(
          scopeMismatch(resolvedBans.map(b => b.message), declared.map(b => b.message)),
          `${ban.rule} at ${fixture.filePath} does not resolve to block "${ban.block}"`,
        ).toBeNull()

        // entry↔fixture. The declared ban's message must actually appear.
        const results = await eslint.lintText(fixture.code, { filePath: fixture.filePath })
        expect(attributionFailure(results.flatMap(r => r.messages), ban)).toBeNull()
      })
    }
  })

  describe('the known-good corpus is real code, in scope, that stays clean', () => {
    it('no known-good fixture has been gutted', () => {
      // Hole 9. "It lints clean" is also true of an empty file.
      expect(gutted(MUST_PASS), 'a known-good fixture no longer exercises its construct')
        .toEqual([])
    })

    for (const fixture of MUST_PASS) {
      it(`permits: ${fixture.what}`, async () => {
        const results = await eslint.lintText(fixture.code, { filePath: fixture.filePath })
        const messages = results.flatMap(r => r.messages)

        expect(messages.filter(m => m.fatal === true).map(m => m.message), 'fixture does not parse')
          .toEqual([])

        // It must be GOVERNED. A known-good fixture at a path no security rule covers is clean
        // only because nothing was looking.
        const resolved = await eslint.calculateConfigForFile(fixture.filePath)
        expect(
          resolved.rules?.[fixture.governedBy],
          `${fixture.filePath} is not governed by ${fixture.governedBy}; this fixture proves nothing`,
        ).toBeDefined()

        const violations = messages
          .filter(m => typeof m.ruleId === 'string' && m.ruleId.startsWith('no-restricted'))
          .map(m => `${m.ruleId}: ${m.message}`)
        expect(violations, `${fixture.what} must not trip a security rule`).toEqual([])
      })
    }
  })

  it('an inline eslint-disable cannot switch a security control off', async () => {
    // Amendment D. An inline disable of a security rule is failure #1 (silently-off) wearing a
    // comment; noInlineConfig makes the comment inert across src/.
    const code = `/* eslint-disable no-restricted-imports */\nimport x from 'node:fs'\nexport const used = x\n`
    const results = await eslint.lintText(code, { filePath: 'src/core/probe.ts' })
    const fired = results.flatMap(r => r.messages).filter(m => m.ruleId === 'no-restricted-imports')
    expect(fired.length, 'an inline disable silenced a security rule').toBeGreaterThan(0)
  })

  it('the config on disk is the config being tested', async () => {
    // Guards the whole file: every assertion above reads the config through an import. If this
    // were ever pointed at a copy, or the path went stale, every check would pass vacuously.
    const source = await readFile(CONFIG_PATH, 'utf8')
    expect(source).toContain('no-restricted-imports')
    expect(source).toContain('noInlineConfig')
  })
})
