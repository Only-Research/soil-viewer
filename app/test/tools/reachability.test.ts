import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  emptyArrowsIn, importsIn, reachableFrom, resolveImport, stripCommentary, type SourceTree,
} from '../support/module-graph'

/**
 * **THE REACHABILITY GATE.** The security review's recommendation after the Phase 7 security review, built.
 *
 * Nine controls in this build have been individually correct, thoroughly tested, mutation-swept,
 * and reachable by no product code. That is this build's signature failure, and every single one of
 * them was found by a person grepping — three of them by an adversarial reviewer, one by a
 * close-out sweep the day before a compaction, one by wondering aloud why a feature "didn't seem to
 * do anything". The security review measured that a mechanical check would have caught six of the first seven on
 * the day they landed.
 *
 * A unit suite cannot see this defect. **A test is a caller**, so a module with tests always has an
 * importer, and "is anything importing this?" always answers yes. The only question that
 * distinguishes a shipped feature from a museum piece is what the **product** reaches from the
 * entry points the build actually emits — a path tests are not on.
 *
 * ## Three rules
 *
 * 1. **Every file under `src/` is reachable from a product entry point**, or is named in
 *    `NOT_SHIPPED` with a reason and a phase.
 * 2. **No empty function body in product code**, same exemption. Two of the nine were *reachable*
 *    modules whose callback was `() => {}` — a graph walk calls those files fine, because they are;
 *    the wiring is what was missing. Rule 1 alone would have missed both.
 * 3. **No NUL byte in a source file.** Added 2026-08-10 after two literal NULs were written into
 *    `live-refresh.ts` during the very change that closed the ninth unreachable control. That is
 *    the fifth time invisible control characters have landed in this codebase; the previous four
 *    were each caught by hand, once after `grep` silently reported zero matches in a file it had
 *    decided was binary. This is three lines and it retires the class.
 *
 * ## The allowlist is checked in both directions
 *
 * An entry naming a file that IS reachable fails the gate. A list that only ever grows is a list
 * that stops meaning anything — and "this is deferred to P10" written beside a module that shipped
 * in P8 is worse than no note at all, because someone will believe it.
 */

const APP = join(import.meta.dirname, '..', '..')

/**
 * Deliberately not shipped. Every entry needs a phase, and the gate fails when one becomes
 * reachable — so this list shrinks by itself and cannot quietly rot.
 */
const NOT_SHIPPED: Record<string, string> = {
  'src/client/harness-entry.ts':
    'Permanent. The measurement harness\'s own entry, loaded by `harness.html` and driven by '
    + '`playwright.harness.config.ts`. Not in `dist/` — an instrument, not a product surface. '
    + 'Recorded as correctly unreachable by the P7 review; the security review\'s P8-5 restored that.',
  /**
   * `src/core/url-safety.ts` was here, with the note *"P10. Deferred on purpose with the reason
   * written down, and cleared by the security review as a false positive in the P7 review — the first unreachable
   * module in this build handled correctly."*
   *
   * **It came off the list in P10, and the gate is what took it off.** The markdown renderer landed,
   * imported it, and this file's second rule failed: an allowlisted module that has become reachable
   * is a stale entry, and the entry is the thing that goes rather than the assertion. That is the
   * list shrinking by itself exactly as the comment above promises — a deferral with a phase written
   * on it, honoured in the phase it named.
   */
  /**
   * `src/client/board/project-filter.ts` was here for one commit, deferred to P11 with the reason
   * written down — and **came off within the same phase, taken off by this gate.** `main.tsx`
   * imported it and the stale-entry rule failed, exactly as the entry itself predicted in writing.
   * Second time the list has shrunk by itself; the first was `url-safety.ts` in P10.
   */
  /**
   * `src/core/quick-open.ts` was here for one commit, deferred to P11 with its reason written down,
   * and **came off in the next one** — `services.ts` imported it and the stale-entry rule failed.
   * **Third time the list has shrunk by itself** (`url-safety.ts` in P10, `project-filter.ts` one
   * unit ago), and the second time in this phase. The pattern is now the build's normal order:
   * prove the rule, allowlist it with a phase, wire it, and let the gate retire the entry.
   */
  /**
   * `src/client/quick-open-panel.ts` was here for one commit and came off in the next, retired by
   * this gate when `main.tsx` bound ⌘K to it. **Fourth time the list has shrunk by itself**, third
   * in this phase. The order — prove, allowlist with a phase, wire, let the gate retire it — is now
   * how every control in this build arrives.
   */
}

/** Product code with an empty function body. Same rule: a phase, or it is a defect. */
const EMPTY_BODIES_ALLOWED: Record<string, string> = {}

function sourceFilesUnder(directory: string, prefix: string): string[] {
  const found: string[] = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${item.name}`
    if (item.isDirectory()) {
      found.push(...sourceFilesUnder(join(directory, item.name), relative))
    } else if (/\.tsx?$/.test(item.name) && !item.name.endsWith('.d.ts')) {
      // `.d.ts` files declare types for the toolchain and are imported by nothing on purpose —
      // `vite-env.d.ts` is the whole population. Excluded from the walk rather than allowlisted,
      // because "this ambient declaration is not reachable" is a category, not a finding.
      found.push(relative)
    }
  }
  return found
}

const files = sourceFilesUnder(join(APP, 'src'), 'src')

/**
 * **Rule 3 covers `test/` as well, and the security review's C3 is why.**
 *
 * The first version scanned `src/` only, and the record claimed the NUL class was "retired". It was
 * not: two test files still carried literal NULs, **including `test/core/url-safety.test.ts` — the
 * exact file that cost the P7 review twenty minutes** and produced the `grep -a` rule in the first
 * place. A gate that leaves the original offender in place has not retired anything; it has moved
 * the hazard somewhere nobody is looking.
 */
const testFiles = sourceFilesUnder(join(APP, 'test'), 'test')

/**
 * Test fixtures that must contain a real NUL, because the byte IS the subject.
 *
 * Allowlisted rather than exempted by a rule, so each one is a decision somebody made and can be
 * read back. Anything else with a NUL in it is a mistake — five of them so far.
 */
const NUL_FIXTURES: Record<string, string> = {
  'test/core/url-safety.test.ts':
    'Asserts a URL carrying a literal NUL is refused. The byte is the input under test.',
  'test/client/session-memory.test.ts':
    'Restored view-state keys are NUL-joined by `rowKey`; the fixture is a real stored key.',
}
const tree: SourceTree = {
  files,
  read: file => readFileSync(join(APP, file), 'utf8'),
}

/**
 * The entry points, **derived from the build rather than restated**.
 *
 * A hard-coded pair would be a fourth place that has to agree with `vite.config.ts`,
 * `vite.server.config.ts` and the HTML — and the moment it stopped agreeing, the gate would go on
 * passing while measuring a build nobody ships. So the HTML is parsed for its module script and the
 * server config for its rollup input, and a failure to find either is a failure of the gate rather
 * than a silent empty set.
 */
function entryPoints(): string[] {
  const entries: string[] = []

  for (const name of readdirSync(join(APP, 'src', 'client'))) {
    if (!name.endsWith('.html')) continue
    /**
     * **`harness.html` is not a product entry point** — the security review's P8-5.
     *
     * `dist/` contains `index.html` and nothing else; the harness page is a measuring instrument
     * driven by `playwright.harness.config.ts` and is served by nothing. Globbing every HTML file
     * made the gate's idea of "the product" larger than the product, and it quietly promoted
     * `harness-entry.ts` — which the P7 review had explicitly recorded as correctly unreachable.
     *
     * Costs one file today. The mechanism is the finding: the day the harness imports something
     * `main.tsx` does not, the gate certifies a module as shipped that ships nowhere, and says
     * nothing. **An entry point is a file the build emits.**
     */
    if (name === 'harness.html') continue
    const html = readFileSync(join(APP, 'src', 'client', name), 'utf8')
    for (const match of html.matchAll(/<script[^>]*\bsrc="\/([^"]+\.tsx?)"/g)) {
      entries.push(`src/client/${match[1] ?? ''}`)
    }
  }

  const serverConfig = readFileSync(join(APP, 'vite.server.config.ts'), 'utf8')
  const input = /\binput:\s*'([^']+)'/.exec(serverConfig)
  if (input?.[1] !== undefined) entries.push(input[1])

  return entries
}

describe('the instrument itself', () => {
  /**
   * **Tested before it is believed.** A gate that reports "everything is reachable" because its
   * import parser matched nothing would be indistinguishable from a healthy build — the exact shape
   * of failure it was built to catch, wearing its own uniform.
   */
  const synthetic = (contents: Record<string, string>): SourceTree => ({
    files: Object.keys(contents),
    read: file => contents[file] ?? '',
  })

  it('finds a module nothing imports', () => {
    const reached = reachableFrom(['src/main.ts'], synthetic({
      'src/main.ts': "import { a } from './used'\n",
      'src/used.ts': 'export const a = 1\n',
      'src/orphan.ts': 'export const b = 2\n',
    }))
    expect([...reached].sort()).toEqual(['src/main.ts', 'src/used.ts'])
  })

  it('follows a chain rather than only direct imports', () => {
    const reached = reachableFrom(['src/main.ts'], synthetic({
      'src/main.ts': "import './one'\n",
      'src/one.ts': "import './two'\n",
      'src/two.ts': "import './three'\n",
      'src/three.ts': 'export const x = 1\n',
    }))
    expect(reached.size).toBe(4)
  })

  /** A cycle must terminate rather than hang the suite. */
  it('survives a circular import', () => {
    const reached = reachableFrom(['src/a.ts'], synthetic({
      'src/a.ts': "import './b'\n",
      'src/b.ts': "import './a'\n",
    }))
    expect(reached.size).toBe(2)
  })

  it('reads through re-exports and dynamic imports', () => {
    const reached = reachableFrom(['src/main.ts'], synthetic({
      'src/main.ts': "export { a } from './re'\nconst later = import('./lazy')\n",
      'src/re.ts': 'export const a = 1\n',
      'src/lazy.ts': 'export const b = 2\n',
    }))
    expect([...reached].sort()).toEqual(['src/lazy.ts', 'src/main.ts', 'src/re.ts'])
  })

  /**
   * **THE ONE THAT MATTERS MOST, and the reason the stripper is a scanner.**
   *
   * A gate that reads its own documentation as source would report a module reachable because some
   * file's doc comment happened to mention it. This build has already shipped the mirror image: a
   * purity test that matched `Buffer` inside a comment, which a correct file failed and a
   * paraphrase could turn green.
   */
  it('does not read imports out of comments or strings', () => {
    const reached = reachableFrom(['src/main.ts'], synthetic({
      'src/main.ts': [
        "// import './commented-out'",
        "/* see import './in-a-block' for the older approach */",
        "const doc = \"import './in-a-string'\"",
        "import './real'",
      ].join('\n'),
      'src/commented-out.ts': '',
      'src/in-a-block.ts': '',
      'src/in-a-string.ts': '',
      'src/real.ts': '',
    }))
    expect([...reached].sort()).toEqual(['src/main.ts', 'src/real.ts'])
  })

  it('ignores dependencies and node builtins', () => {
    expect(resolveImport('src/a.ts', 'node:fs', new Set(['src/a.ts']))).toBeNull()
    expect(resolveImport('src/a.ts', '@codemirror/state', new Set(['src/a.ts']))).toBeNull()
  })

  it('resolves .ts, .tsx and parent-relative specifiers', () => {
    const set = new Set(['src/client/a.ts', 'src/client/b.tsx', 'src/core/c.ts'])
    expect(resolveImport('src/client/a.ts', './b', set)).toBe('src/client/b.tsx')
    expect(resolveImport('src/client/a.ts', '../core/c', set)).toBe('src/core/c.ts')
  })

  it('keeps the specifier intact through the comment mask', () => {
    expect(importsIn("import { x } from './deep/thing'\n")).toEqual(['./deep/thing'])
  })

  it('preserves line numbers when stripping', () => {
    const stripped = stripCommentary('a\n/* two\n   three */\nfour\n')
    expect(stripped.split('\n')).toHaveLength(5)
    expect(stripped.split('\n')[3]).toBe('four')
  })

  describe('the empty-body rule', () => {
    it('flags a callback that promises to do something and does not', () => {
      expect(emptyArrowsIn('createThing({\n  onEvent: () => {},\n})\n')).toEqual([2])
    })

    it('flags an empty named function', () => {
      expect(emptyArrowsIn('function doTheThing(): void {}\n')).toEqual([1])
    })

    /** The typed hole four dialogs fill a moment later is not the same animal. */
    it('exempts a declaration placeholder', () => {
      expect(emptyArrowsIn('let stopListening = (): void => {}\n')).toEqual([])
      expect(emptyArrowsIn('const noop = () => {}\n')).toEqual([])
    })

    it('does not read an empty callback out of a comment', () => {
      expect(emptyArrowsIn('/** was onEvent: () => {} before P8 */\nconst a = 1\n')).toEqual([])
    })

    /**
     * **Silence with a reason is a decision.** Seven `.catch` sites in this build swallow an error
     * on purpose and say why in the braces. Flagging those would teach people to delete the
     * explanation rather than write one, which is the opposite of the point.
     */
    it('exempts a swallow that explains itself', () => {
      expect(emptyArrowsIn('await close().catch(() => { /* already closed */ })\n')).toEqual([])
    })

    it('flags the same swallow with the reason removed', () => {
      expect(emptyArrowsIn('await close().catch(() => {})\n')).toEqual([1])
    })

    /**
     * **THE SECURITY REVIEW'S C3.** Every spelling below was invisible to the first version, which matched the
     * arrow form only — so a rule whose entire subject is empty callbacks could not see
     * `onEvent() {}`, which is as idiomatic as the one it caught.
     */
    it('flags method shorthand on an object literal', () => {
      expect(emptyArrowsIn('const wiring = {\n  onEvent() {},\n}\n')).toEqual([2])
    })

    it('flags a class method', () => {
      expect(emptyArrowsIn('class Thing {\n  onEvent(): void {}\n}\n')).toEqual([2])
    })

    it('flags an anonymous function expression', () => {
      expect(emptyArrowsIn('createThing({\n  onEvent: function () {},\n})\n')).toEqual([2])
    })

    /**
     * **The one keystroke that defeated the old exemption.** It tested whether the *line* started
     * with `const`, so collapsing the object onto its declaration line hid the callback. The
     * exemption now looks backwards from the arrow and asks whether it is the declarator's own
     * initializer, which this is not.
     */
    it('flags an empty callback hidden on a declaration line', () => {
      expect(emptyArrowsIn('const wiring = { onEvent: () => {} }\n')).toEqual([1])
    })

    /** …while the placeholder it was written to exempt still is exempt, in both spellings. */
    it('still exempts the typed placeholder a dialog fills later', () => {
      expect(emptyArrowsIn('let stopListening = (): void => {}\n')).toEqual([])
      expect(emptyArrowsIn('const refreshBar = () => {}\n')).toEqual([])
    })

    /** An empty block is a different defect and not this rule's. */
    it('does not flag empty control-flow blocks', () => {
      expect(emptyArrowsIn('if (ready) {}\nfor (const x of xs) {}\nwhile (go) {}\n')).toEqual([])
    })
  })
})

describe('the gate', () => {
  it('found the entry points the build actually emits', () => {
    // If this ever reports one entry, the HTML or the server config changed shape and every other
    // assertion below has been measuring a smaller product than the one that ships.
    // Two, not three: the harness page is an instrument and is excluded above.
    expect(entryPoints().sort()).toEqual(['src/client/main.tsx', 'src/server/main.ts'])
  })

  it('read a source tree at all', () => {
    // A glob that silently returns nothing makes every rule below vacuously true.
    expect(files.length).toBeGreaterThan(50)
  })

  /**
   * **RULE 1.** Every module under `src/` is reached by the product, or is on the list with a
   * reason and a phase.
   *
   * The failure message names the file and nothing else, because that is the whole finding: this
   * file is not part of the application. Whether it should be wired or should be deleted is a
   * decision for a person — and in this build the answer has been "wire it" nine times out of nine.
   */
  it('ships every module under src/, or says why not', () => {
    const reached = reachableFrom(entryPoints(), tree)
    const unreachable = files.filter(file => !reached.has(file) && !(file in NOT_SHIPPED))
    expect(unreachable).toEqual([])
  })

  /**
   * The allowlist read backwards. Without this the list only ever grows, and a stale "deferred to
   * P10" beside a module that shipped in P8 is worse than no note: someone will believe it.
   */
  it('has no stale allowlist entries', () => {
    const reached = reachableFrom(entryPoints(), tree)
    const shipped = Object.keys(NOT_SHIPPED).filter(file => reached.has(file))
    expect(shipped).toEqual([])
  })

  it('has no allowlist entries for files that no longer exist', () => {
    const known = new Set(files)
    expect(Object.keys(NOT_SHIPPED).filter(file => !known.has(file))).toEqual([])
  })

  /**
   * **RULE 2.** The one reachability cannot see. §6's error-message table and live updates were
   * both imported, constructed, called — and handed their result to an empty function.
   */
  it('has no empty function bodies in product code', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file in EMPTY_BODIES_ALLOWED) continue
      for (const line of emptyArrowsIn(tree.read(file))) offenders.push(`${file}:${line}`)
    }
    expect(offenders).toEqual([])
  })

  /**
   * **RULE 3.** No invisible control characters in source, ever again.
   *
   * Five occurrences to date. The most recent two were written into `live-refresh.ts` during the
   * change that closed the ninth unreachable control, and the file they landed in became one
   * `grep` reported as binary — which is how twenty minutes disappeared during the P7 review.
   */
  it('has no NUL bytes in any source file', () => {
    const offenders = files.filter(file => readFileSync(join(APP, file)).includes(0))
    expect(offenders).toEqual([])
  })

  /**
   * **And in the tests, which is where the hazard actually lived.** Two files legitimately carry
   * one; every other NUL under `test/` is the mistake that has now been made five times.
   */
  it('has no unexplained NUL bytes in the test suite', () => {
    const offenders = testFiles
      .filter(file => !(file in NUL_FIXTURES))
      .filter(file => readFileSync(join(APP, file)).includes(0))
    expect(offenders).toEqual([])
  })

  /**
   * The fixture allowlist read backwards, so it cannot outlive the fixtures — **and so the scan
   * above cannot pass vacuously.** Without this, deleting the offender computation entirely would
   * leave the suite green, which the mutation sweep demonstrated.
   */
  it('has no stale NUL-fixture entries', () => {
    const stale = Object.keys(NUL_FIXTURES)
      .filter(file => !readFileSync(join(APP, file)).includes(0))
    expect(stale).toEqual([])
  })

  /** And the scan really is looking: without the allowlist, the two fixtures are offenders. */
  it('would flag the deliberate fixtures if they were not allowlisted', () => {
    const unfiltered = testFiles.filter(file => readFileSync(join(APP, file)).includes(0))
    expect(unfiltered.sort()).toEqual(Object.keys(NUL_FIXTURES).sort())
  })
})
