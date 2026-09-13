import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * THE ADVERSARIAL CORPUS. The security review's item (g), amended from the builder's proposal.
 *
 * The builder proposed an evasion fixture per ban. The security review rejected that as non-terminating: sixty-three
 * bans means sixty-three evasion fixtures, every future ban owes one, and the cost scales with the
 * config forever. Worse — those fixtures would be written by the same person, in the same sitting,
 * from the same threat model as the config itself. **A fixture authored alongside its ban inherits
 * the ban's blind spot.** You cannot fix "the fixture mirrors the config" by writing more fixtures
 * derived from the config.
 *
 * This is the amended form: ONE flat list of realistic hostile snippets, each asserted only to
 * produce **at least one** security violation. **No snippet declares which ban is supposed to catch
 * it** — that is the entire point. The meta-gate proves each ban matches its own fixture; this
 * proves the config as a whole refuses code an attacker would actually write. The two are different
 * questions and this file is the only one that asks the second.
 *
 * IT GROWS ON DISCOVERY, NEVER ON CONFIGURATION. A new ban does not owe an entry here. A newly
 * FOUND attack does. Cost therefore scales with attacks discovered — finite and slow — rather than
 * with config size, which is neither.
 *
 * Everything below was found by an actual red-team against an actual green build, not invented for
 * this file. Every one of them linted CLEAN at some point in this build's history.
 */

const APP_ROOT = new URL('../..', import.meta.url).pathname

interface Attack {
  readonly what: string
  readonly filePath: string
  readonly code: string
  /** Where it came from, so nobody deletes an entry without knowing what it cost to find. */
  readonly found: string
}

const ATTACKS: Attack[] = [
  // ---- module acquisition: the routes that made the security review's "unaliasable chokepoint" false --------
  {
    what: 'child_process via dynamic import',
    filePath: 'src/core/attack.ts',
    code: `export const cp = await import('node:child_process')\n`,
    found: 'red-team round 4; premise of the gate-5 ratification',
  },
  {
    what: 'child_process via createRequire',
    filePath: 'src/core/attack.ts',
    code: `import { createRequire } from 'node:module'\nexport const cp = createRequire(import.meta.url)('node:child_process')\n`,
    found: 'red-team round 4',
  },
  {
    what: 'fs via process.getBuiltinModule — idiomatic modern Node',
    filePath: 'src/core/attack.ts',
    code: `export const fs = process.getBuiltinModule('node:fs')\n`,
    found: 'red-team round 4',
  },
  {
    what: 'the full command injection: getBuiltinModule then a template-literal shell call',
    filePath: 'src/core/attack.ts',
    code: `const cp = process.getBuiltinModule('node:child_process') as { execSync(c: string): void }\nexport function f(name: string) { cp.execSync(\`ls \${name}\`) }\n`,
    found: 'red-team round 4 — live and unblocked at HEAD 09bcec4',
  },
  {
    what: 'fs via require() in an ESM package',
    filePath: 'src/core/attack.ts',
    code: `declare function require(m: string): unknown\nexport const fs = require('node:fs')\n`,
    found: 'security review, second gate-1 ruling',
  },
  {
    what: 'native bindings via process.binding behind a cast',
    filePath: 'src/core/attack.ts',
    code: `export const b = (process as unknown as { binding(n: string): unknown }).binding('fs')\n`,
    found: 'security review — the constrained selector missed this form; the object is a TSAsExpression',
  },

  // ---- execution sinks: never banned anywhere in this build until 2026-08-07 ------------------
  {
    what: 'eval of an interpolated string',
    filePath: 'src/core/attack.ts',
    code: `export function f(name: string) { return eval(\`readFile("\${name}")\`) }\n`,
    found: 'security review — absent from its own Q6 gate list',
  },
  {
    what: 'new Function, eval by another name',
    filePath: 'src/server/attack.ts',
    code: `export function f(body: string) { return new Function(body)() }\n`,
    found: 'security review — absent from its own Q6 gate list',
  },

  // ---- scope holes: the config was blind to the file, not to the code -------------------------
  {
    what: 'node:fs imported from a .tsx file inside the Core',
    filePath: 'src/core/attack.tsx',
    code: `import { readFileSync } from 'node:fs'\nexport const x = readFileSync\n`,
    found: 're-gate round 3 — live on committed HEAD, third instance of the scope-overlap class',
  },
  {
    what: 'an inline eslint-disable used to switch a security rule off',
    filePath: 'src/core/attack.ts',
    code: `/* eslint-disable no-restricted-imports */\nimport { readFileSync } from 'node:fs'\nexport const x = readFileSync\n`,
    found: 'security review, amendment D',
  },

  // ---- sinks outside the client, which the block did not cover until the re-partition ---------
  {
    what: 'innerHTML assigned in the Core, where the sink ban did not reach',
    filePath: 'src/core/attack.ts',
    code: `export function f(el: HTMLElement, markup: string) { el.innerHTML = markup }\n`,
    found: 'red-team round 4',
  },
  {
    what: 'document.write reached through window',
    filePath: 'src/client/attack.ts',
    code: `declare const markup: string\nexport function f() { window.document.write(markup) }\n`,
    found: 'the original document.write defect, 2026-08-06',
  },

  // ---- shell ----------------------------------------------------------------------------------
  {
    what: 'a bare shell call with an interpolated filename',
    filePath: 'src/server/attack.ts',
    code: `declare function execSync(c: string): void\nexport function f(name: string) { execSync(\`open "\${name}"\`) }\n`,
    found: 'spec §10 — the rule that was silently disabled from Phase 0 to 2026-08-05',
  },
]

describe('the adversarial corpus — realistic hostile code must not lint clean', () => {
  let eslint: ESLint

  beforeAll(() => {
    eslint = new ESLint({ cwd: APP_ROOT })
  })

  it('the corpus is seeded with everything the red-teams found', () => {
    // Guards the file: an empty or truncated corpus would pass every assertion below.
    expect(ATTACKS.length, 'the corpus has shrunk — entries are removed only with a reason')
      .toBeGreaterThanOrEqual(13)
  })

  for (const attack of ATTACKS) {
    it(`refuses: ${attack.what}`, async () => {
      const results = await eslint.lintText(attack.code, { filePath: attack.filePath })
      const messages = results.flatMap(r => r.messages)

      expect(messages.filter(m => m.fatal === true).map(m => m.message), 'attack does not parse')
        .toEqual([])

      const violations = messages.filter(
        m => typeof m.ruleId === 'string' && /(^|\/)no-restricted-/.test(m.ruleId),
      )
      expect(
        violations.length,
        `this lints CLEAN. Found by: ${attack.found}. It does not matter which ban catches it — ` +
        `something must.`,
      ).toBeGreaterThan(0)

      // Severity matters as much as coverage: a warning does not fail CI.
      expect(
        violations.every(v => v.severity === 2),
        'caught, but only as a warning — CI would pass',
      ).toBe(true)
    })
  }
})
