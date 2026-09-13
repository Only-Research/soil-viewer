import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * **NO SERVER-ONLY MODULE MAY REACH THE BROWSER.** The security review, P11 C5.
 *
 * ## What actually happens, measured rather than assumed
 *
 * `core/board.ts` mints lane ids with `node:crypto`. The board view imported one rule from it, and
 * **Vite externalises the builtin rather than failing** — build, typecheck and lint all stay green.
 * P11 recorded that as the cause of an app that would not mount, and the security review proved that wrong: built
 * from the pre-split commit the bundle is byte-identical and contains **no stub at all**, because
 * rollup tree-shook an import nothing used. The mount failure was a temporal dead zone.
 *
 * **The hazard is real anyway, and it is worse than an import-time throw.** Three `core/fs` modules
 * sit on the client's *value* import graph today, harmless only because each import takes a bare
 * `const` that rollup can prove side-effect-free. Change one to a *called function* and the bundle
 * ships an empty object where the builtin was — and the failure is a `TypeError` **when the binding
 * is used**, which is conditional on a code path rather than loud at load.
 *
 * ## Why this guards the artefact and not the import graph
 *
 * A source-graph rule would fail on three edges that are correct today, so it would need an
 * allowlist — and record item 47 is about exactly what happens to a gate that grows one. The
 * emitted bundle has no such ambiguity: either a stub is in it or it is not.
 *
 * ESLint's ban is one hop deep. It refuses `src/client/**` importing `node:fs` *directly*, and says
 * nothing about importing `src/core/fs/**`, which imports it on the client's behalf.
 */

const DIST = join(process.cwd(), 'dist', 'assets')

/**
 * **Fails rather than skips when `dist/` is absent**, and that is the whole design of this gate.
 *
 * A skipped check is indistinguishable from a passing one in a summary line, and this build has a
 * ledger of controls that were live and unobservable. `npm run build` takes about two seconds and
 * `npm run ci` runs it; a local run that has not built yet gets told so.
 */
function clientBundles(): string[] {
  if (!existsSync(DIST)) {
    throw new Error('dist/assets is missing — run `npm run build` before this suite')
  }
  return readdirSync(DIST).filter(name => name.endsWith('.js')).map(name => join(DIST, name))
}

describe('the client bundle carries no Node builtin', () => {
  it('finds a built client at all, so the rules below are not vacuous', () => {
    const bundles = clientBundles()
    expect(bundles.length, 'no javascript in dist/assets').toBeGreaterThan(0)
    // A real client bundle is hundreds of kilobytes. A tiny one means the build changed shape and
    // these assertions are reading something other than the app.
    const bytes = bundles.reduce((total, path) => total + readFileSync(path).length, 0)
    expect(bytes, 'the bundle is too small to be the app').toBeGreaterThan(100_000)
  })

  /**
   * The shape Vite emits for an externalised builtin, from the security review's measurement of a deliberately
   * mutated build:
   *
   * ```
   * var wx = (()=>{ exports = {} })()
   * (0, wx.createHash)('sha256')      <- TypeError, at call time
   * ```
   *
   * Matched on the marker Vite puts in the module id rather than on that generated shape, because
   * the variable name is a minifier's choice and would change between builds.
   */
  it('contains no browser-external stub for a Node builtin', () => {
    const offenders: string[] = []
    for (const path of clientBundles()) {
      const source = readFileSync(path, 'utf8')
      /**
       * **The stub itself, matched on what the minifier actually emits.**
       *
       * A first version looked for `__vite-browser-external` and the `node:` specifiers, and a
       * mutation that genuinely reached the bundle sailed through it: none of those strings survive
       * a production build. What does survive is the externalisation stub's body, minified to
       * `exports={}`. Found by mutating and then **reading the artefact** rather than by trusting
       * the marker I expected.
       *
       * **And "none" is honestly the bar**, which it was not when this was first written: the clean
       * bundle carried one, from `node:path` reached through a constant the client wanted. The operator
       * ruled the cleanup rather than the exception, and `core/limits.ts` is where those numbers
       * live now. A gate with an allowlist is a gate that stops meaning anything (record item 47).
       */
      if (/exports\s*=\s*\{\}/.test(source)) {
        offenders.push(`${path.split('/').pop()}: a browser-external stub`)
      }
    }
    expect(offenders, 'a server-only module reached the browser bundle').toEqual([])
  })
})
