import { promises as fsp } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

import { decompose, enumerateBans, type Ban, type ConfigBlock } from './gate-lib'

/**
 * SCOPE VERIFIED AGAINST THE FILESYSTEM, NOT AGAINST GLOBS. The security review's item (e), strengthened, plus
 * items 6, 7 and 8 of their termination list.
 *
 * Every other check in this suite reasons from the config outward: it takes the globs a block
 * declares and asks whether a fixture exercises them. **That direction is structurally incapable
 * of noticing a file the config never claimed.** It is how the `.tsx` hole survived Phase 0 and
 * Phase 1 — the meta-gate demanded a fixture per claimed extension, and `.tsx` under `src/core`
 * was claimed by nothing, so nothing was demanded. The red-team then found the same shape again in
 * `.js`, `.jsx`, `.mjs`, `.mts` and `.cts`.
 *
 * So this file goes the other way. It walks the **real** `src/` tree, and for every file that
 * actually exists it asks ESLint which config governs that exact path. Glob-reasoning survives any
 * amount of review; neither hole survives one loop over real files.
 *
 * It also closes the two ways a scope can silently shrink, which sampling cannot see:
 *   - `ignores`: adding one entry disabled all 22 syntax bans inside the sanctioned filesystem
 *     module, with the meta-gate fully green.
 *   - a `files` list narrowed to exclude a subtree no fixture happens to sit in.
 */

const APP_ROOT = new URL('../..', import.meta.url).pathname
const SRC = join(APP_ROOT, 'src')

/** Extensions the security config claims. These are the files the lint rules govern. */
const CLAIMED_EXTENSIONS = new Set(['.ts', '.tsx'])

/**
 * Extensions that would carry EXECUTABLE code and are NOT claimed.
 *
 * The distinction matters and the first version of this check missed it. `src/client/` legitimately
 * contains `index.html`, `tokens.css` and a web manifest — assets the bundler consumes, which no
 * lint rule governs and none should. But a `.js` or `.mts` under `src/` is code the config does not
 * cover, which is the `.tsx` hole in a new extension.
 *
 * So: an unclaimed ASSET is fine, an unclaimed EXECUTABLE is a build failure by existing.
 */
const EXECUTABLE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

/** Non-code files the bundler owns. Enumerated so a new kind is a decision, not a drift. */
const ASSET_EXTENSIONS = new Set([
  '.html', '.css', '.webmanifest', '.json', '.svg', '.png', '.ico', '.woff2', '.ttf', '.txt',
])

/**
 * Which restriction rules must be live on which real files.
 *
 * `no-restricted-globals` is deliberately client-only — the `document` global has no meaning in the
 * Core or the server. Everything else applies to every file under `src/`, with no exceptions, which
 * is the property that makes an `ignores` carve-out detectable.
 */
const REQUIRED_RULES: ReadonlyArray<{ rule: string; appliesTo: (path: string) => boolean }> = [
  { rule: 'no-restricted-imports', appliesTo: () => true },
  { rule: 'no-restricted-properties', appliesTo: () => true },
  { rule: 'no-restricted-syntax', appliesTo: () => true },
  {
    rule: 'no-restricted-globals',
    // THE ONE ALLOWLISTED FILE. The security review's amendment D requires a genuine exception be a sanctioned,
    // greppable mechanism rather than an inline disable. `src/client/dom.ts` is the single module
    // permitted to touch the `document` global, named by path in eslint.config.js. The exception is
    // asserted to have exactly this member below, so a second one is a test failure.
    appliesTo: path => path.startsWith('src/client/') && path !== 'src/client/dom.ts',
  },
]

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot)
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

describe('every real file under src/ is governed', () => {
  let eslint: ESLint
  let files: string[]
  let code: string[]
  let bans: Ban[]

  beforeAll(async () => {
    eslint = new ESLint({ cwd: APP_ROOT })
    const all = (await walk(SRC)).map(f => relative(APP_ROOT, f).split(sep).join('/'))
    files = all
    // The lint rules govern code. Assets are checked for KIND above, not for governance — asking
    // whether a stylesheet is covered by an import ban is a question with no meaning.
    code = all.filter(f => CLAIMED_EXTENSIONS.has(extensionOf(f)))
    const config = (await import(new URL('../../eslint.config.js', import.meta.url).pathname))
      .default as ConfigBlock[]
    bans = enumerateBans(config)
  })

  it('finds the real source tree', () => {
    // Guards every assertion below: a walk that silently returned nothing would pass all of them.
    expect(files.length, 'no files found under src/ — the walk is broken, not the config')
      .toBeGreaterThan(10)
  })

  it('no EXECUTABLE file under src/ has an extension the security config does not claim', () => {
    // Item 7. The security review: "either carry the full security set or are a build failure by existing."
    // This build is TypeScript-only, so the second is the honest choice — a .js file under src/ is
    // itself the smell. .mts and .cts are valid TS module extensions that both tsc and vite build,
    // and both would resolve to ZERO security rules.
    const ungoverned = files.filter(f => EXECUTABLE_EXTENSIONS.has(extensionOf(f)))
    expect(
      ungoverned,
      'these carry executable code and no security rules, because no block claims their extension',
    ).toEqual([])
  })

  it('every non-code file under src/ is a known asset kind', () => {
    // The converse. src/client legitimately holds a shell, a stylesheet and a manifest, which no
    // lint rule governs and none should. Enumerating them means a new kind of file is a decision
    // rather than a drift — and stops "it is only an asset" from becoming the reason nobody looked.
    const unknown = files.filter(f => {
      const ext = extensionOf(f)
      return !CLAIMED_EXTENSIONS.has(ext) && !ASSET_EXTENSIONS.has(ext)
    })
    expect(unknown, 'an unrecognised file kind under src/').toEqual([])
  })

  it('every required restriction rule is live on every real file it applies to', async () => {
    // Items 6 and (e). This is what an `ignores` carve-out or a narrowed `files` list cannot hide.
    const missing: string[] = []
    for (const path of code) {
      const resolved = await eslint.calculateConfigForFile(path)
      for (const { rule, appliesTo } of REQUIRED_RULES) {
        if (!appliesTo(path)) continue
        if (resolved.rules?.[rule] === undefined) missing.push(`${path} has no ${rule}`)
      }
    }
    expect(missing, 'a real file is not governed by a rule that must apply to it').toEqual([])
  })

  it('every rule resolves to exactly ONE declared block per real file', async () => {
    // The partition, asserted against reality rather than by reading the globs. Flat config
    // REPLACES rather than merges, so a file's resolved options for a rule must equal exactly one
    // block's declared set. Two blocks that overlap silently drop one of them.
    //
    // This is the assertion that catches the security review's own finding: `no-restricted-properties` was a
    // partition by luck of non-overlap, and widening the DOM-sink block — the obvious repair —
    // made src/core resolve to `startsWith` only, with all five sinks gone and the gate green.
    const violations: string[] = []
    for (const path of code) {
      const resolved = await eslint.calculateConfigForFile(path)
      for (const { rule, appliesTo } of REQUIRED_RULES) {
        if (!appliesTo(path)) continue
        const resolvedMessages = decompose('resolved', rule, resolved.rules?.[rule])
          .map(b => b.message).sort()
        const blocks = [...new Set(bans.filter(b => b.rule === rule).map(b => b.block))]
        const matching = blocks.filter(block => {
          const declared = bans.filter(b => b.block === block && b.rule === rule)
            .map(b => b.message).sort()
          return declared.length === resolvedMessages.length
            && declared.every((m, i) => m === resolvedMessages[i])
        })
        if (matching.length !== 1) {
          violations.push(`${path}: ${rule} resolves to ${matching.length} declared blocks (${matching.join(', ') || 'none'})`)
        }
      }
    }
    expect(violations, 'a real file does not map cleanly onto exactly one governing block')
      .toEqual([])
  })

  it('EXACTLY ONE file is exempt from the document-global ban', async () => {
    // The exception exists because a client has to reach the DOM somewhere, and amendment D says a
    // genuine case gets a named allowlist rather than a line comment. An allowlist that quietly
    // grows is the same failure as the comment it replaced, so its size is pinned.
    const exempt: string[] = []
    for (const path of code.filter(f => f.startsWith('src/client/'))) {
      const resolved = await eslint.calculateConfigForFile(path)
      if (resolved.rules?.['no-restricted-globals'] === undefined) exempt.push(path)
    }
    expect(exempt, 'only the sanctioned renderer may touch the document global')
      .toEqual(['src/client/dom.ts'])
  })

  it('the exempt file does NOT get a way to inject markup', async () => {
    // The important half. dom.ts gets `document`. It does not get innerHTML, outerHTML,
    // insertAdjacentHTML, srcdoc or document.write — those live in the property and syntax scopes,
    // which cover all of src/ including this file.
    const resolved = await eslint.calculateConfigForFile('src/client/dom.ts')
    expect(resolved.rules?.['no-restricted-properties'], 'HTML sinks still banned here').toBeDefined()
    expect(resolved.rules?.['no-restricted-syntax'], 'document.write still banned here').toBeDefined()
  })

  it('every real file has inline eslint-disable switched off', async () => {
    // Item 8. noInlineConfig coverage must follow the same partition as the rules themselves —
    // a file that carries the bans but permits a disable comment carries nothing.
    const permissive: string[] = []
    for (const path of code) {
      const resolved = await eslint.calculateConfigForFile(path)
      if (resolved.linterOptions?.noInlineConfig !== true) permissive.push(path)
    }
    expect(permissive, 'these files allow an inline eslint-disable to silence a security rule')
      .toEqual([])
  })

  it('every ban is live on at least one real file — no ban protects an empty set', async () => {
    // The converse of coverage, and the honest limit on it: a ban can be perfectly enumerated,
    // uniquely messaged and individually proven against a fixture while applying to no code that
    // exists. That is not a security hole, but it is a maintenance signal — and it is how a scope
    // quietly becomes vestigial after a refactor.
    const liveSomewhere = new Set<string>()
    for (const path of code) {
      const resolved = await eslint.calculateConfigForFile(path)
      for (const rule of new Set(bans.map(b => b.rule))) {
        for (const ban of decompose('resolved', rule, resolved.rules?.[rule])) {
          liveSomewhere.add(ban.message)
        }
      }
    }
    const vestigial = [...new Set(bans.filter(b => !liveSomewhere.has(b.message)).map(b => b.id))]

    // Declared exceptions, each with a reason and an expiry. A ban scoped to a directory a later
    // phase creates is legitimately vestigial today — but it must be NAMED here rather than
    // tolerated silently, because "applies to nothing" and "was quietly orphaned by a refactor"
    // look identical from the outside.
    //
    // EMPTIED 2026-08-07. It held one entry — `global:document`, vestigial because `src/client/`
    // did not exist — and the expiry assertion below fired the moment Phase 3 created that
    // directory, which is exactly what it was written to do. The ban is live and checked for real
    // now, so the exception is gone rather than left to rot.
    const EXPECTED_VESTIGIAL = new Map<string, string>()

    const unexplained = vestigial.filter(id => !EXPECTED_VESTIGIAL.has(id))
    expect(unexplained, 'these bans apply to no file that exists, and nothing explains why')
      .toEqual([])

    // And the converse, so the exception list cannot outlive its reason.
    const stale = [...EXPECTED_VESTIGIAL.keys()].filter(id => !vestigial.includes(id))
    expect(stale, 'these are listed as expected-vestigial but are now live — remove the exception')
      .toEqual([])
  })
})
