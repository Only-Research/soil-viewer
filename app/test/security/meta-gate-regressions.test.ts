import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  EnumerationFailure, attributionFailure, demotedBans, enumerateBans, extensionGaps,
  danglingFixtures, gutted, malformedBans, messageAmbiguities, messageContainments,
  scopeMismatch, unprovenBans,
  type Ban, type ConfigBlock, type Fixture, type PassFixture,
} from './gate-lib'
import { CORPUS, MUST_PASS } from './gate-corpus'

/**
 * THE 19 HOLES, ENCODED SO THEY STAY RED.
 *
 * Required by the security review's gate-1 standard (`the gate-1 standard`,
 * item 3). A red-team ran 45 attacks against the previous meta-gate and nineteen stayed green.
 * Fixing them is not the same as proving they are fixed: a gate that has only ever been run
 * against a config it passes is, by this build's own governing principle, a control that has
 * never rejected anything and is therefore assumed non-functional.
 *
 * Every test below breaks something on purpose and asserts the gate refuses it. They run against
 * mutated copies of the real config — nothing here writes to disk, so a failure means the gate
 * genuinely stopped catching that attack rather than that someone forgot to restore a file.
 */

const CONFIG_PATH = new URL('../../eslint.config.js', import.meta.url).pathname

/** JSON round-trip: the restriction rules are plain data, and this drops plugin objects. */
const cloneBlocks = (config: readonly ConfigBlock[]): ConfigBlock[] =>
  config
    .filter(b => b.name !== undefined && Object.keys(b.rules ?? {}).some(r => r.startsWith('no-restricted-')))
    .map(b => JSON.parse(JSON.stringify({ name: b.name, files: b.files, ignores: b.ignores, rules: b.rules })) as ConfigBlock)

describe('the 19 red-team holes stay closed', () => {
  let real: ConfigBlock[]
  let bans: Ban[]

  beforeAll(async () => {
    const config = (await import(CONFIG_PATH)).default as ConfigBlock[]
    real = cloneBlocks(config)
    bans = enumerateBans(real)
  })

  const blockNamed = (blocks: ConfigBlock[], name: string): ConfigBlock & { rules: Record<string, unknown> } => {
    const found = blocks.find(b => b.name === name)
    if (found === undefined) throw new Error(`test setup: no block named ${name}`)
    return found as ConfigBlock & { rules: Record<string, unknown> }
  }

  // -------------------------------------------------------------------------------------------
  // HOLE 1 — the .tsx scope hole. A block protecting both extensions, proven on only one.
  // -------------------------------------------------------------------------------------------

  it('HOLE 1: a scope claiming an extension no fixture exercises is rejected', () => {
    const withoutTsx = CORPUS.filter(f => !f.filePath.endsWith('.tsx'))
    expect(extensionGaps(real, bans, withoutTsx).length).toBeGreaterThan(0)
  })

  it('HOLE 1: the live config claims .ts and .tsx everywhere, and both are exercised', () => {
    expect(extensionGaps(real, bans, CORPUS)).toEqual([])
  })

  it('HOLE 1: a block that declares no globs at all is unprovable, not silently fine', () => {
    // The key is OMITTED, not set to undefined — exactOptionalPropertyTypes distinguishes them,
    // and "absent" is what a block that forgot its globs actually looks like.
    const mutated = cloneBlocks(real).map(b => {
      if (b.name !== 'imports/core-fs') return b
      const withoutGlobs: ConfigBlock = { name: b.name, rules: b.rules ?? {} }
      return withoutGlobs
    })
    expect(extensionGaps(mutated, enumerateBans(mutated), CORPUS).join(' ')).toContain('unprovable')
  })

  // -------------------------------------------------------------------------------------------
  // HOLE 2 — sub-entry bundling. One "entry" hiding many independent bans.
  // -------------------------------------------------------------------------------------------

  it('HOLE 2a: typo-ing one decomposed selector orphans its fixture and leaves the new ban unproven', () => {
    // Originally demonstrated on the CSP directive list — sixteen directives behind one selector,
    // two fixtures. Those eighteen bans were DELETED on the security review's second ruling rather than
    // hardened, so this now targets the surviving decomposed family: the bare shell calls, which
    // were split out of `/^(exec|execSync|spawnSync)$/` for exactly the same reason.
    const mutated = cloneBlocks(real)
    // .slice(1) drops the 'error' severity that leads every rule value.
    const syntax = (blockNamed(mutated, 'security-syntax-bans').rules['no-restricted-syntax'] as unknown[]).slice(1)
    const entry = syntax.find(e => (e as { selector: string }).selector.includes("callee.name='spawnSync'")) as { selector: string }
    entry.selector = entry.selector.replace('spawnSync', 'spawnnSync')
    const mutatedBans = enumerateBans(mutated)
    expect(danglingFixtures(mutatedBans, CORPUS).join(' ')).toContain('spawnSync')
    expect(unprovenBans(mutatedBans, CORPUS).join(' ')).toContain('spawnnSync')
  })

  it('HOLE 2b: deleting the fixture for one bare shell call is rejected', () => {
    const without = CORPUS.filter(f => !f.proves.includes("callee.name='execSync'"))
    expect(unprovenBans(bans, without).join(' ')).toContain('execSync')
  })

  it('HOLE 2c: adding a third glob to the layer pattern group needs its own fixture', () => {
    const mutated = cloneBlocks(real)
    const rule = blockNamed(mutated, 'imports/core-except-fs').rules['no-restricted-imports'] as [string, { patterns: Array<{ group: string[]; message: string }> }]
    rule[1].patterns.push({ group: ['**/zzz-nowhere/**'], message: 'a ban nobody proved' })
    expect(unprovenBans(enumerateBans(mutated), CORPUS).join(' ')).toContain('zzz-nowhere')
  })

  // -------------------------------------------------------------------------------------------
  // HOLES 3 & 4 — duplicate messages defeating attribution (and, before, the collision guard).
  // -------------------------------------------------------------------------------------------

  it('HOLE 3: two different bans sharing one message is rejected', () => {
    const mutated = cloneBlocks(real)
    const rule = blockNamed(mutated, 'imports/core-except-fs').rules['no-restricted-imports'] as [string, { paths: Array<{ name: string; message: string }> }]
    const donor = rule[1].paths[0]
    if (donor === undefined) throw new Error('test setup: no paths')
    rule[1].paths.push({ name: 'zzz-dead-module', message: donor.message })
    expect(messageAmbiguities(enumerateBans(mutated)).length).toBeGreaterThan(0)
  })

  it('HOLE 4: a dead selector carrying a live one\'s message is rejected', () => {
    // Failure #2, re-achieved by copy-paste instead of rule-name granularity. Two selectors in
    // the real config already carry near-identical wording, so this is the natural bad edit.
    const mutated = cloneBlocks(real)
    const syntax = blockNamed(mutated, 'security-syntax-bans').rules['no-restricted-syntax'] as Array<{ selector: string; message: string }>
    const live = syntax.slice(1).find(e => e.selector.includes("callee.name='eval'"))
    if (live === undefined) throw new Error('test setup: no eval selector')
    syntax.push({ selector: "CallExpression[callee.name='thisRuleMatchesNothingAtAll']", message: live.message })
    expect(messageAmbiguities(enumerateBans(mutated)).length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------------------------
  // HOLE 5 — scope never verified.
  // -------------------------------------------------------------------------------------------

  it('HOLE 5a: a whole new block of bans with no fixtures is rejected', () => {
    const mutated = cloneBlocks(real)
    mutated.push({
      name: 'imports/electron',
      files: ['src/electron/**/*.ts', 'src/electron/**/*.tsx'],
      rules: {
        'no-restricted-imports': ['error', {
          paths: [{ name: 'node:fs', message: 'a ban in a scope nobody proved' }],
        }],
      },
    })
    expect(unprovenBans(enumerateBans(mutated), CORPUS).join(' ')).toContain('imports/electron')
  })

  it('HOLE 5b: an INERT block — shadowed by a later one — cannot satisfy the scope check', async () => {
    // The sharpest form: the block is present and reads as protective, but every file it claims
    // is governed by a later block, so its options never resolve anywhere. Proven against real
    // ESLint rather than the pure helpers, because "which config wins" is ESLint's answer to give.
    const eslint = new ESLint({
      cwd: new URL('../..', import.meta.url).pathname,
      overrideConfigFile: true,
      overrideConfig: [
        {
          name: 'inert/first',
          files: ['src/**/*.ts'],
          rules: { 'no-restricted-imports': ['error', { paths: [{ name: 'node:fs', message: 'INERT BAN' }] }] },
        },
        {
          name: 'shadowing/second',
          files: ['src/**/*.ts'],
          rules: { 'no-restricted-imports': ['error', { paths: [{ name: 'node:net', message: 'the winner' }] }] },
        },
      ],
    })
    const resolved = await eslint.calculateConfigForFile('src/core/probe.ts')
    const messages = ((resolved.rules?.['no-restricted-imports'] as [string, { paths: Array<{ message: string }> }])[1].paths).map(p => p.message)
    expect(messages, 'the first block was silently replaced, exactly as flat config does')
      .not.toContain('INERT BAN')
  })

  // -------------------------------------------------------------------------------------------
  // HOLES 6 & 7 — enumeration must fail closed, not skip quietly.
  // -------------------------------------------------------------------------------------------

  it('HOLE 6: the legacy varargs form aborts the gate', () => {
    const mutated = cloneBlocks(real)
    blockNamed(mutated, 'imports/outside-core').rules['no-restricted-imports'] = ['error', 'zzz-typo-module', 'node:vm']
    expect(() => enumerateBans(mutated)).toThrow(EnumerationFailure)
  })

  it('HOLE 7: a restriction rule the enumerator does not understand aborts the gate', () => {
    const mutated = cloneBlocks(real)
    blockNamed(mutated, 'imports/outside-core').rules['no-restricted-exports'] = ['error', { restrictedNamedExports: ['zzzNeverExported'] }]
    expect(() => enumerateBans(mutated)).toThrow(EnumerationFailure)
  })

  it('a ban with no message aborts the gate — attribution would be impossible', () => {
    const mutated = cloneBlocks(real)
    const rule = blockNamed(mutated, 'imports/outside-core').rules['no-restricted-imports'] as [string, { paths: Array<{ name: string; message?: string }> }]
    rule[1].paths.push({ name: 'zzz-unmessaged' })
    expect(() => enumerateBans(mutated)).toThrow(EnumerationFailure)
  })

  it('an anonymous block carrying a restriction rule aborts the gate', () => {
    const mutated = cloneBlocks(real)
    mutated.push({
      files: ['src/**/*.ts'],
      rules: { 'no-restricted-globals': ['error', { name: 'zzz', message: 'nameless block' }] },
    })
    expect(() => enumerateBans(mutated)).toThrow(EnumerationFailure)
  })

  // -------------------------------------------------------------------------------------------
  // HOLE 8 — a ban credited by another ban's message.
  // -------------------------------------------------------------------------------------------

  it('HOLE 8: a ban whose message is contained in another\'s is rejected', () => {
    // This is the `http` / `node:http` family in its general form — the defect that was already
    // LIVE at af64acc, where the bare `http` ban had no fixture and rode node:http's message.
    const mutated = cloneBlocks(real)
    const rule = blockNamed(mutated, 'imports/core-except-fs').rules['no-restricted-imports'] as [string, { paths: Array<{ name: string; message: string }> }]
    const donor = rule[1].paths[0]
    if (donor === undefined) throw new Error('test setup: no paths')
    rule[1].paths.push({ name: 'zzz-contained', message: donor.message.slice(0, 40) })
    expect(messageContainments(enumerateBans(mutated)).length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------------------------
  // HOLE 9 — the known-good corpus asserted nothing.
  // -------------------------------------------------------------------------------------------

  it('HOLE 9: a gutted known-good fixture is rejected', () => {
    const guttedCorpus: PassFixture[] = MUST_PASS.map((f, i) =>
      i === 0 ? { ...f, code: 'export const x = 1\n' } : f)
    expect(gutted(guttedCorpus).length).toBeGreaterThan(0)
  })

  it('HOLE 9: the live known-good corpus still exercises every construct it claims', () => {
    expect(gutted(MUST_PASS)).toEqual([])
  })

  it('HOLE 9: a known-good fixture at an ungoverned path proves nothing, and is detectable', async () => {
    const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname })
    const resolved = await eslint.calculateConfigForFile('scripts/probe.ts')
    expect(
      resolved.rules?.['no-restricted-imports'],
      'scripts/ is outside every security scope — a fixture parked there is clean because ' +
      'nothing is looking, which is what the governedBy assertion exists to catch',
    ).toBeUndefined()
  })

  // -------------------------------------------------------------------------------------------
  // HOLE 10 — a style rule in a security block used to break the gate, pressuring a weakening.
  // -------------------------------------------------------------------------------------------

  it('HOLE 10: an ordinary style rule in a security block does NOT break the gate', () => {
    const mutated = cloneBlocks(real)
    blockNamed(mutated, 'properties/core-and-server').rules['eqeqeq'] = 'error'
    expect(() => enumerateBans(mutated)).not.toThrow()
    expect(unprovenBans(enumerateBans(mutated), CORPUS)).toEqual([])
  })

  // -------------------------------------------------------------------------------------------
  // HOLE 11 — inline disables. Asserted against real ESLint in lint-rules-fire.test.ts; here the
  // converse, so the setting cannot be quietly dropped from the config.
  // -------------------------------------------------------------------------------------------

  it('HOLE 11: src/ is configured so inline disables are inert', async () => {
    const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname })
    for (const path of ['src/core/a.ts', 'src/core/a.tsx', 'src/client/a.tsx', 'src/server/a.ts']) {
      const resolved = await eslint.calculateConfigForFile(path)
      expect(resolved.linterOptions?.noInlineConfig, `${path} allows inline disables`).toBe(true)
    }
  })

  // -------------------------------------------------------------------------------------------
  // The corpus itself must stay honest.
  // -------------------------------------------------------------------------------------------

  it('a fixture pointed at a ban that no longer exists is rejected', () => {
    const stale: Fixture[] = [...CORPUS, {
      what: 'points at nothing', filePath: 'src/core/probe.ts', code: 'export const x = 1\n',
      proves: 'imports/core-except-fs::import:zzz-removed-module',
    }]
    expect(danglingFixtures(bans, stale).length).toBeGreaterThan(0)
  })

  it('deleting any single fixture leaves at least one ban unproven', () => {
    // The property in its most general form: there is no redundant fixture, so no fixture can be
    // dropped without the gate noticing. This is what "http rode on node:http" violated.
    const provenOnlyOnce = new Map<string, number>()
    for (const f of CORPUS) provenOnlyOnce.set(f.proves, (provenOnlyOnce.get(f.proves) ?? 0) + 1)
    const soleProofs = CORPUS.filter(f => provenOnlyOnce.get(f.proves) === 1)
    expect(soleProofs.length, 'expected most bans to have exactly one fixture').toBeGreaterThan(40)
    for (const fixture of soleProofs) {
      const without = CORPUS.filter(f => f !== fixture)
      expect(unprovenBans(bans, without), `dropping "${fixture.what}" went unnoticed`)
        .toEqual([fixture.proves])
    }
  })

  // -------------------------------------------------------------------------------------------
  // The two assertions that carry the whole guarantee. The security review item (f), non-negotiable.
  //
  // Until 2026-08-07 these lived inline in `lint-rules-fire.test.ts`, where the red-team proved
  // EITHER COULD BE DELETED OUTRIGHT with zero test failures. Everything else in this build had
  // been mutation-tested except the two lines doing the actual work. Three times now the thing
  // that failed has been the gate rather than the config: the watcher is the demonstrated weak
  // point, so the watcher gets watched.
  // -------------------------------------------------------------------------------------------

  it('scopeMismatch rejects a ban that is not live where a fixture claims it', () => {
    // The inert-block and shrunken-scope classes reduce to this: the resolved set is not the
    // declaring block's set.
    expect(scopeMismatch(['a', 'b'], ['a', 'b']), 'identical sets must pass').toBeNull()
    expect(scopeMismatch(['a'], ['a', 'b']), 'a shrunken scope must be caught').not.toBeNull()
    expect(scopeMismatch(['a', 'b', 'c'], ['a', 'b']), 'a widened scope must be caught').not.toBeNull()
    expect(scopeMismatch([], ['a']), 'a scope with nothing live must be caught').not.toBeNull()
    expect(scopeMismatch(['x'], ['y']), 'a different block entirely must be caught').not.toBeNull()
  })

  it('attributionFailure rejects a ban that did not actually fire', () => {
    const ban = {
      block: 'b', rule: 'no-restricted-imports', id: 'import:node:fs',
      message: 'UNIQUE BAN WORDING', severity: 'error',
    }
    expect(
      attributionFailure([{ ruleId: 'no-restricted-imports', message: "'node:fs' … UNIQUE BAN WORDING" }], ban),
      'a genuine firing must pass',
    ).toBeNull()
    expect(
      attributionFailure([], ban),
      'no violations at all must be caught — this is the dead-ban case',
    ).not.toBeNull()
    expect(
      attributionFailure([{ ruleId: 'no-restricted-syntax', message: 'UNIQUE BAN WORDING' }], ban),
      'the right wording under the WRONG RULE must not certify',
    ).not.toBeNull()
    expect(
      attributionFailure([{ ruleId: 'no-restricted-imports', message: 'some other ban entirely' }], ban),
      'a different ban firing must not certify this one',
    ).not.toBeNull()
    expect(
      attributionFailure([{ ruleId: null, message: 'Parsing error', fatal: true }], ban),
      'a fixture that does not parse reports one fatal and no violations, which used to read as clean',
    ).not.toBeNull()
  })

  it('demotedBans catches a security rule flipped to warn', () => {
    // the security review item (a). One character used to disable every control in the build with the gate
    // green, `eslint .` exiting 0, and CI passing.
    const mutated = cloneBlocks(real)
    const rule = blockNamed(mutated, 'imports/core-except-fs').rules['no-restricted-imports'] as [string, unknown]
    rule[0] = 'warn'
    expect(demotedBans(enumerateBans(mutated)).length).toBeGreaterThan(0)
  })

  it('demotedBans passes on the live config, and accepts the numeric form', () => {
    expect(demotedBans(bans)).toEqual([])
    expect(demotedBans([{ block: 'b', rule: 'r', id: 'i', message: 'm', severity: 2 }])).toEqual([])
    expect(demotedBans([{ block: 'b', rule: 'r', id: 'i', message: 'm', severity: 1 }]).length).toBe(1)
  })

  it('malformedBans catches a ban no real code could ever trip', () => {
    // the security review item (h), and the structural answer to the dead-ban class. `document.write` as a
    // PROPERTY NAME — failure #1 — would have been rejected here at Phase 0, before any fixture
    // existed to launder it. The red-team resurrected exactly this and the gate went green.
    const mutated = cloneBlocks(real)
    const rule = blockNamed(mutated, 'properties/core-and-server').rules['no-restricted-properties'] as unknown[]
    rule.push({ property: 'document.write', message: 'failure #1, verbatim' })
    expect(malformedBans(enumerateBans(mutated)).join(' ')).toContain('document.write')
  })

  it('malformedBans passes on the live config', () => {
    expect(malformedBans(bans)).toEqual([])
  })
})
