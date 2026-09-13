import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * **EVERY `var()` NAMES A TOKEN THAT EXISTS, AND NO `var()` CARRIES A FALLBACK.**
 *
 * Annex §C is binding and `tokens.css` opens by saying why:
 *
 * > *"the failure mode it guards against is a builder 'improving' a value in passing — a slightly
 * > bluer teal, a slightly whiter white — until the thing that felt expensive feels generic. Every
 * > hex below is copied, not chosen."*
 *
 * It happened anyway, inside that same file, and the P9 annex audit is what found it. **Twenty uses
 * of two names that were never defined:**
 *
 * - `var(--accent, #4a9d9c)` — five times. There is no `--accent`. The token is `--accent-teal`,
 *   and it is `#5b9fa6`. Every teal on the boards — the drop-target highlight, the filter's focus
 *   ring — was a *different teal*, arrived at by exactly the route the header warns about.
 * - `var(--border-subtle, #2a2928)` — fifteen times. There is no `--border-subtle`. The annex
 *   defines `--border-primary: #2f2e2b` for "every hairline". Every lane, every card, every board
 *   bar was drawn with an invented grey.
 *
 * **CSS made all of it silent.** A `var()` naming nothing falls through to its fallback without a
 * warning, a console message or a build error — the declaration works perfectly and is simply the
 * wrong colour. No behavioural test can see this: the app functions identically. It took reading
 * the token list against its own uses.
 *
 * ## Why fallbacks are banned outright rather than checked
 *
 * The fallback is not a safety net here, it is the camouflage. Every token is defined on `:root`,
 * which always applies, so a fallback can only ever be dead — except in the one case where the name
 * is wrong, and there it is what stops anyone noticing. Banning the syntax makes the first rule
 * self-enforcing: a misspelled token with no fallback renders as nothing and is seen immediately.
 */

/**
 * **DERIVED FROM THE TREE, NEVER FROM A LIST.** The security review, P9F-4 — record item 47, one phase later.
 *
 * The first version named its two subjects by hand. Both stylesheets that existed happened to be on
 * it, so the gate was complete *that day* — and the security review dropped a third `.css` under `src/` carrying
 * both banned shapes and watched it pass **green**. A gate written *because* twenty `var()` calls
 * named nothing must not itself be blind to the file that reintroduces them, and the design pass
 * the operator has scheduled is the likeliest moment for a third stylesheet to appear.
 *
 * Item 47 said it about entry points: *"a gate derived from the build has to derive from what the
 * build outputs, not from what its input directory contains."* The same sentence, one word changed.
 */
function stylesheets(): readonly string[] {
  const found: string[] = []
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.css')) found.push(path)
    }
  }
  walk(join(process.cwd(), 'src'))
  return found.sort()
}

const STYLESHEETS = stylesheets()

const read = (absolute: string): string => readFileSync(absolute, 'utf8')

/** Every `--name:` declaration, from every stylesheet — `:root` is shared across them. */
function definedNames(): ReadonlySet<string> {
  const names = new Set<string>()
  for (const sheet of STYLESHEETS) {
    for (const match of read(sheet).matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) names.add(match[1] ?? '')
  }
  return names
}

interface Use { readonly sheet: string; readonly line: number; readonly name: string; readonly fallback: string }

function uses(): readonly Use[] {
  const found: Use[] = []
  for (const sheet of STYLESHEETS) {
    const css = read(sheet)
    for (const match of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,[^)]*)?\)/g)) {
      found.push({
        sheet,
        line: css.slice(0, match.index).split('\n').length,
        name: match[1] ?? '',
        fallback: (match[2] ?? '').replace(/^,\s*/, '').trim(),
      })
    }
  }
  return found
}

describe('annex §C — the tokens are the single source, and nothing quietly bypasses them', () => {
  it('finds tokens and uses of them at all, so the rules below are not vacuous', () => {
    // The whole file is regex over text. If a rename ever breaks the patterns, every assertion
    // below passes over an empty list — which is the shape of a green suite proving nothing.
    expect(definedNames().size).toBeGreaterThan(100)
    expect(uses().length).toBeGreaterThan(100)
    // Every stylesheet under `src/` is a subject. Asserted as a count rather than as names, so
    // adding one is covered automatically and removing the walk is not.
    expect(STYLESHEETS.length, 'the walk found no stylesheets at all').toBeGreaterThan(1)
  })

  it('every var() names a property that is actually defined', () => {
    const defined = definedNames()
    const orphans = uses()
      .filter(use => !defined.has(use.name))
      .map(use => `${use.sheet}:${use.line} ${use.name}`)
    expect(orphans, 'a var() naming nothing renders its fallback, silently and forever').toEqual([])
  })

  it('no var() carries a fallback, because the fallback is what hid the above', () => {
    const withFallback = uses()
      .filter(use => use.fallback !== '')
      .map(use => `${use.sheet}:${use.line} ${use.name} -> ${use.fallback}`)
    expect(withFallback, 'every token is on :root, so a fallback can only ever mask a typo')
      .toEqual([])
  })

  /**
   * **THE BOX MODEL IS DECLARED ONCE, UNIVERSALLY.**
   *
   * Not a style preference — the absence of this rule was a defect the operator found from the outside:
   * *"there's padding to the left side but there's no padding to the right side of those boxes."*
   * Without it, `width: 100%` sizes the *content* box, so every element carrying padding overflows
   * its container by exactly that padding. Four did.
   *
   * Asserted in the stylesheet rather than only in a browser because a text assertion is what
   * survives the rule being deleted during the design pass. The behavioural half — that the fields
   * actually sit inside their modal — is `test/e2e/box-model.spec.ts`, and it is the one that would
   * catch the rule being present but overridden.
   */
  it('declares box-sizing: border-box universally, once', () => {
    const css = STYLESHEETS.map(read).join('\n')
    // The universal selector specifically. A `.modal-input { box-sizing }` would satisfy a looser
    // check while leaving every other padded element exactly as broken as it was.
    expect(css.replace(/\s+/g, ' '), 'the universal reset is gone — every padded full-width element overflows again')
      .toMatch(/\*, \*::before, \*::after \{ box-sizing: border-box; \}/)
  })

  it('names the two colours the annex is most explicit about, as literals', () => {
    const css = read(join(process.cwd(), 'src/client/tokens.css'))
    // THE LITERALS, not the tokens — the overlays suite records why: assertions scaled off the
    // constant they are checking pass against a build that deleted the value.
    expect(css, 'annex §C: the accent teal').toContain('--accent-teal: #5b9fa6')
    // "a warm off-white, never #fff" — stated in the annex as a rule, so asserted as one.
    expect(css, 'annex §C: text.primary is warm, never white').toContain('--text-primary: #ece9e1')
  })
})
