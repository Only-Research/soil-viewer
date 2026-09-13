import { promises as fsp } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * **THE `child_process` EXCEPTION HAS EXACTLY ONE MEMBER, AND ESLINT IS ASKED RATHER THAN READ.**
 *
 * Spec §10. The operator granted the exception on 2026-08-14; `src/server/reveal.ts` may import
 * `child_process` so Reveal in Finder can exist. Every other module may not.
 *
 * **Why this file has to exist at the same time as the exception.** `eslint.config.js` says adding
 * the sanctioned module is *"an escalation to the operator and the security review, not a local decision"* — and that
 * sentence is enforced by nothing but itself. A second entry in the `files` list would be one line,
 * would lint clean, and would look exactly like the first one. This is what makes widening it a
 * **test failure** rather than a preference, which is the same mechanism that has held the sole
 * `document` exception for `dom.ts` since P3.
 *
 * **Asked, not read.** `scope-boundary.test.ts` records why: glob-reasoning survives any amount of
 * review, and neither hole it found survives one loop over real files. So these assertions run
 * ESLint's own resolution against real paths — the config object could be renamed, reordered or
 * restructured and this would still be measuring what actually governs each file.
 */

const APP_ROOT = new URL('../..', import.meta.url).pathname
const SRC = join(APP_ROOT, 'src')

/** The one file. Written out here so a change to the config has to change this line too. */
const SANCTIONED = 'src/server/reveal.ts'

const BANNED_MODULES = ['child_process', 'node:child_process']

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** The `no-restricted-imports` paths ESLint would actually apply to a given file. */
async function bannedPathsFor(eslint: ESLint, file: string): Promise<string[]> {
  const config = await eslint.calculateConfigForFile(join(APP_ROOT, file)) as {
    rules?: Record<string, unknown>
  }
  const entry = config.rules?.['no-restricted-imports']
  if (!Array.isArray(entry)) return []
  const options = entry[1] as { paths?: { name: string }[] } | undefined
  return (options?.paths ?? []).map(p => p.name)
}

describe('the child_process exception', () => {
  let eslint: ESLint
  let code: string[]

  beforeAll(async () => {
    eslint = new ESLint({ cwd: APP_ROOT })
    const all = (await walk(SRC)).map(f => relative(APP_ROOT, f).split(sep).join('/'))
    code = all.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
  })

  it('finds the real source tree', () => {
    // Guards every assertion below: a walk returning nothing would pass all of them silently.
    expect(code.length, 'no source files found — the walk is broken, not the config')
      .toBeGreaterThan(10)
  })

  it('is granted to exactly one file, and it is the one named here', async () => {
    const exempt: string[] = []
    for (const file of code) {
      const banned = await bannedPathsFor(eslint, file)
      if (!BANNED_MODULES.some(name => banned.includes(name))) exempt.push(file)
    }
    // The assertion that matters. Not "reveal.ts is exempt" — **only** reveal.ts is exempt.
    expect(exempt, 'the child_process exception has more than one member').toEqual([SANCTIONED])
  })

  it('the sanctioned module is still banned from every other module it never needed', async () => {
    // Nothing else is relaxed for it. An exception that quietly widened to `node:fs` would be a
    // module that can both run programs and read the disk outside the Core's one gate.
    const banned = await bannedPathsFor(eslint, SANCTIONED)
    expect(banned, 'node:fs is no longer banned in the sanctioned module').toContain('node:fs')
    expect(banned.length, 'the sanctioned module bans nothing at all').toBeGreaterThan(1)
  })

  it('no other file under src/ so much as mentions child_process', async () => {
    // The lint rule governs `import`. This governs the text, and catches the shapes a linter cannot:
    // a comment describing how to reach it, a string handed to something dynamic, a half-finished
    // second module that nobody has wired up yet.
    for (const file of code) {
      if (file === SANCTIONED) continue
      const source = await fsp.readFile(join(APP_ROOT, file), 'utf8')
      expect(source, `${file} mentions child_process`).not.toContain('child_process')
    }
  })
})

describe('the sanctioned module builds no command line', () => {
  let source = ''
  /**
   * **Comments stripped before anything is asserted, and this file learned it the hard way.**
   *
   * Both text assertions below failed on their first run, against a correct module — because its
   * docstring quotes the injection it defends against, `exec("open …")`, and explains the template
   * literal it avoids. A rule satisfied or broken by *prose* is not testing the code.
   * `conventions/sandbox-and-verification.md` records this exact failure from the opposite
   * direction, where an over-eager match would have passed a dangerous file whose wording changed.
   */
  let code = ''

  beforeAll(async () => {
    source = await fsp.readFile(join(APP_ROOT, SANCTIONED), 'utf8')
    code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // The needle: proves stripping left the code behind, so nothing below can pass vacuously.
    expect(code, 'comment stripping removed the code as well').toContain('execFile(')
  })

  it('calls execFile and never a shell-invoking sibling', () => {
    for (const forbidden of ['exec(', 'execSync(', 'spawnSync(', 'spawn(']) {
      expect(code, `${SANCTIONED} calls ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('states shell:false explicitly rather than relying on the default', () => {
    // §10 names it, and a default can change in a Node major. A reader auditing this line should
    // not have to know which version's default applied.
    expect(code.replace(/\s+/g, ' ')).toContain('shell: false')
  })

  it('passes the binary as an absolute path, never a bare name', () => {
    // A bare `open` resolves through PATH, which is inherited. Anything earlier on it wins.
    expect(code).toContain("'/usr/bin/open'")
  })

  it('reveals rather than opens — the two-character difference from a cut feature', () => {
    // Without `-R` the same binary OPENS the file in whatever application claims it, which is Open
    // in Default App, cut from v1 on 2026-08-09. It would come back through a missing flag.
    expect(code).toContain("REVEAL_FLAG = '-R'")
  })

  it('ends option parsing, so a file named -n is a path', () => {
    expect(code).toContain("END_OF_OPTIONS = '--'")
  })

  it('builds its argument array from named constants and the path, and nothing else', () => {
    expect(code.replace(/\s+/g, ' '))
      .toContain('[REVEAL_FLAG, END_OF_OPTIONS, absolutePath]')
  })

  /**
   * **SINGULARITY — the security review's C2, P12 review, 2026-08-15. The gate below is line-scoped and they got
   * past it.**
   *
   * Every assertion above constrains *the* invocation, on the unstated assumption that there is only
   * one. The security review tested that assumption with an eight-mutant sweep against the real file. Seven were
   * caught. The eighth was not:
   *
   *     CAUGHT   M6 second invocation: sh -c, ONE LINE, concatenated
   *     GREEN    M7 second invocation: sh -c, MULTI-LINE, template literal   <-- got through
   *
   * The line filter below asks whether any single *line* containing `execFile(` also contains `${`
   * or ` + `. Split a second call across three lines — **which is exactly what a formatter does to a
   * three-argument call** — and the interpolation sits on a line the filter never looks at. That is
   * not an input built from the control's own definition; it is how a hurried engineer adds a second
   * OS action.
   *
   * **Counting is the fix, and it needs no parser.** The module is permitted exactly one invocation
   * and exactly one binary. A second of either is a design change that should have to come here
   * first. Verified before being written: both counts are 1 on the shipped file, and 2 on M7.
   *
   * This also closes the half of record item 4 that turned real on 2026-08-14. Interpolation into a
   * command line is prevented here by the module being singular and its one invocation pinned — not
   * by a lint rule, because `execFile('/bin/sh', ['-c', …])` is lint-clean and always was.
   */
  it('holds exactly ONE invocation and ONE binary — a second of either is the hole', () => {
    const invocations = code.match(/execFile\(/g) ?? []
    expect(invocations.length,
      'the sanctioned module may invoke exactly once; a second call escapes every line-scoped rule below')
      .toBe(1)

    const binaries = code.match(/'\/usr\/bin\/open'/g) ?? []
    expect(binaries.length,
      'exactly one binary literal — a second names a second program the gate above never sees')
      .toBe(1)
  })

  it('interpolates nothing on any line that invokes the binary', () => {
    /**
     * **Scoped to the invocation, not to the file.** A template literal in an error message is
     * fine — it never reaches a command line. One in the arguments is the entire vulnerability.
     * The first version of this test banned `${` everywhere and failed on `could not reveal the
     * file: ${detail}`, which is a message, not an argument.
     */
    const invoking = code
      .split('\n')
      .filter(line => line.includes('execFile(') || line.includes('seam.run(') || line.includes('run('))
    expect(invoking.length, 'no invocation lines found — the filter is wrong').toBeGreaterThan(0)
    for (const line of invoking) {
      expect(line, `interpolation on an invocation line: ${line.trim()}`).not.toContain('${')
      expect(line, `concatenation on an invocation line: ${line.trim()}`).not.toContain(' + ')
    }
  })
})
