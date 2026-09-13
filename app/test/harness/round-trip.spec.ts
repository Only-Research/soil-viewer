/**
 * **THE GATE.** Spec §20, build plan §5.
 *
 * Every file in P5's denominator goes through the real editor in a real browser and comes back
 * byte-compared. The pass mark is **100% byte-identical**, where files §12 says to refuse are
 * excluded and named rather than scored.
 *
 * ## What this is measuring, and what it is not
 *
 * It measures the **editor**: document construction, the line-separator configuration, the live
 * preview, and every extension the app runs. That is where the old app's damage was, and where
 * §12's removal of the serialization step has to prove itself.
 *
 * It does **not** touch a file. The decode at `file.load`, the JSON transport, the re-encode at
 * `file.save` and the atomic write are each proven by their own suites; the test that proves the
 * whole chain end to end is item 11, which the operator approved on 2026-08-08. Stated here so a green
 * number is never read as more than it is.
 *
 * ## The negative controls
 *
 * A measuring instrument that reports everything as fine is indistinguishable from one that has
 * stopped measuring, and the second is worse than having none. So every run also puts the corpus
 * through **three deliberately lossy editors** — each performing a normalization a well-meaning
 * editor really does — and requires the comparison to find **exactly** the files each one damages.
 *
 * The expected counts are computed from the corpus at run time, never written down. See the block
 * itself for why: the first version asserted invented floors under a comment claiming they were
 * derived.
 *
 * This replaces a check that could only be run by hand. P5 calibrated the instrument against the
 * old TipTap editor, which lives outside this repository in a folder no lockfile governs; if it is
 * ever cleaned up, that calibration cannot be repeated. These are in the repo, cost nothing, and
 * run on every invocation rather than once.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { expect, test } from '@playwright/test'

import { readAll } from './corpus.cjs'
import { tally, type TallyRecord } from './compare.cjs'

/**
 * The record and result shapes come from the harness's own declaration
 * (`results.d.cts`, alongside this file), not from a copy written here. That file exists because P5's gate
 * found four readers each re-deriving the shape from memory and three of them broken by a change to
 * it — so a driver that expects a field the tally does not produce now fails to compile rather than
 * reporting a confident wrong number.
 */
type CorpusFile = Pick<TallyRecord, 'path' | 'bytes'>

/** A run of the whole denominator through one in-page function. */
async function runCorpus(
  evaluate: (input: string) => Promise<string | null>,
  files: readonly CorpusFile[],
): Promise<TallyRecord[]> {
  const records: TallyRecord[] = []
  for (const file of files) {
    /**
     * **The decode happens here, before the editor is involved, and that is a limit rather than a
     * choice.** The contract passes a string, so for a file whose bytes are not valid UTF-8 the
     * editor never sees this file at all — it sees replacement characters. Those files cannot be
     * honestly scored, which is exactly why `compare.cjs` excludes them by name instead of counting
     * them as passes.
     */
    const input = file.bytes.toString('utf8')
    let output: string | null = null
    try {
      output = await evaluate(input)
    } catch {
      // An editor that throws is a failure, not an excluded file. `tally` counts it as `errored`.
      output = null
    }
    records.push({ path: file.path, bytes: file.bytes, output })
  }
  return records
}

/**
 * §20: *"The whole real tree is the extended corpus."* Which tree is ruled 2026-08-08:
 * **"this is why we have a fake soil"** — so it is the mock at `~/soil-viewer-mock`, never their
 * files.
 *
 * The committed denominator above is 67 files chosen to cover every construct. This is every
 * markdown file there is: constructs in combination, at real length, with the incidental mess that
 * only accumulates. A sample proves a table survives; this proves a table survives inside the
 * four-hundredth document of a tree.
 */
const MOCK_SOIL = process.env['SOIL_MOCK_DIR']
  ?? join(homedir(), '.soil-viewer-mock',
          basename(join(import.meta.dirname, '..', '..', '..')))

function walkMockSoil(dir: string, acc: CorpusFile[] = []): CorpusFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMockSoil(full, acc)
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        acc.push({ path: full.slice(MOCK_SOIL.length + 1), bytes: readFileSync(full) })
      } catch {
        // `zz-hazards/permissions` holds a file deliberately unreadable. Not being able to read it
        // is the hazard working, and it is not this gate's subject.
      }
    }
  }
  return acc
}

test.describe('the round-trip gate', () => {
  test('every file in the denominator survives the editor byte-identical', async ({ page }) => {
    const files = readAll()
    expect(files.length, 'the denominator must not be empty — that would be a 100% of nothing').toBeGreaterThan(0)

    await page.goto('/harness.html')
    await page.waitForFunction(() => typeof window.RT?.run === 'function')

    const records = await runCorpus(
      input => page.evaluate(text => window.RT.run(text).out, input),
      files,
    )

    const result = tally(records)

    /**
     * Printed unconditionally, pass or fail. A gate that reports only on failure gives a reader no
     * way to tell "it passed" from "it did not run", and this build has already met a check that
     * passed because it read the wrong line of output.
     */
    console.log(
      `\nDENOMINATOR ${result.total} files\n` +
      `  byte-identical   ${result.identical.length}\n` +
      `  changed          ${result.changed.length}\n` +
      `  errored          ${result.errored.length}\n` +
      `  not editable     ${result.notEditable.length}  (§12 — excluded, named below)\n` +
      `  ROUND-TRIPPABLE  ${result.roundTrippable}\n` +
      `  PERCENT          ${result.percentIdentical === null ? 'n/a' : result.percentIdentical.toFixed(2)}%\n` +
      result.notEditable.map(p => `    excluded: ${p}\n`).join('') +
      result.changed.slice(0, 40).map(p => `    CHANGED:  ${p}\n`).join('') +
      result.errored.slice(0, 40).map(p => `    ERRORED:  ${p}\n`).join(''),
    )

    expect(result.errored, 'files the editor threw on').toEqual([])
    expect(result.changed, 'files the editor changed').toEqual([])
    expect(result.percentIdentical).toBe(100)
  })

  test('THE EXTENDED CORPUS — every markdown file in the mock soil', async ({ page }) => {
    const files = walkMockSoil(MOCK_SOIL)
    expect(files.length, `no markdown found under ${MOCK_SOIL} — run: npm run mock:soil`).toBeGreaterThan(1000)

    await page.goto('/harness.html')
    await page.waitForFunction(() => typeof window.RT?.run === 'function')

    const records = await runCorpus(
      input => page.evaluate(text => window.RT.run(text).out, input),
      files,
    )
    const result = tally(records)

    console.log(
      `\nEXTENDED CORPUS ${result.total} files\n` +
      `  byte-identical   ${result.identical.length}\n` +
      `  changed          ${result.changed.length}\n` +
      `  errored          ${result.errored.length}\n` +
      `  not editable     ${result.notEditable.length}  (§12 — excluded)\n` +
      `  PERCENT          ${result.percentIdentical === null ? 'n/a' : result.percentIdentical.toFixed(3)}%\n` +
      result.notEditable.map(p => `    excluded: ${p}\n`).join('') +
      result.changed.slice(0, 40).map(p => `    CHANGED:  ${p}\n`).join('') +
      result.errored.slice(0, 40).map(p => `    ERRORED:  ${p}\n`).join(''),
    )

    expect(result.errored).toEqual([])
    expect(result.changed).toEqual([])
    expect(result.percentIdentical).toBe(100)
  })

  /**
   * THE NEGATIVE CONTROLS.
   *
   * If these pass silently the gate above is worthless: an editor that damages nothing and an
   * instrument that has stopped measuring look identical from the outside.
   *
   * **Three, not one, and the first version had only the CRLF case.** It caught 2 files of 65 —
   * because only two files in the denominator use CRLF. A true result and a **weak control**: an
   * instrument broken for every case except those two would have passed it.
   *
   * **And the expected counts are computed, not written down. That is the second correction.** The
   * first version of this block asserted invented floors above a comment claiming they were
   * "derived from the corpus rather than from hope" — they were hope. One of them said a
   * trailing-newline normalizer would damage at least 30 files; it damages 3, because the corpus is
   * *tidy* and the transform is a no-op on a file that already ends in exactly one newline. The
   * comment said the right thing while the mechanism did the other thing, which is the failure
   * shape this build has named more than any other, committed here in a comment about rigour.
   *
   * So each control now computes in Node how many files its transform genuinely changes, and
   * requires the browser-side measurement to find **exactly that many** — no more, no fewer. A
   * transform that turns out to damage nothing fails as a control rather than passing vacuously.
   */
  const LOSSY: readonly { name: string; transform: (t: string) => string }[] = [
    {
      // Exactly what stock CodeMirror does with `lineSeparator` unset — the subtle case, and the
      // one configuration mistake that would sail past a careless reviewer.
      name: 'normalizes CRLF to LF',
      transform: t => t.replace(/\r\n/g, '\n'),
    },
    {
      // A markdown hard line break is two trailing spaces. "Tidying" them deletes a line break.
      name: 'trims trailing whitespace on every line',
      transform: t => t.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n'),
    },
    {
      name: 'guarantees a single trailing newline',
      transform: t => `${t.replace(/\n+$/, '')}\n`,
    },
  ]

  for (const { name, transform } of LOSSY) {
    test(`NEGATIVE CONTROL — an editor that ${name} is reported as damage`, async ({ page }) => {
      const files = readAll()

      await page.goto('/harness.html')
      await page.waitForFunction(() => typeof window.RT?.run === 'function')

      // The transform runs in the page, through the same call path as the real editor, so this
      // exercises the plumbing rather than only the comparison.
      const records = await runCorpus(
        input => page.evaluate(
          ([text, source]) => (new Function(`return (${source})`)() as (t: string) => string)(text),
          [input, transform.toString()] as const,
        ),
        files,
      )

      /**
       * The expected count, computed here rather than asserted from memory: the files this
       * transform genuinely alters, judged by the same byte comparison the gate uses, over the same
       * exclusions §12 requires.
       */
      const expectedDamaged = files.filter(f => {
        const decoded = f.bytes.toString('utf8')
        // Excluded files have no honest answer either way — `tally` puts them in `notEditable`.
        if (!Buffer.from(decoded, 'utf8').equals(f.bytes) || f.bytes.includes(0)) return false
        return !Buffer.from(transform(decoded), 'utf8').equals(f.bytes)
      }).length

      const result = tally(records)
      console.log(
        `NEGATIVE CONTROL (${name}): ${result.changed.length} damaged, ${expectedDamaged} expected, of ${result.roundTrippable}`,
      )

      expect(
        expectedDamaged,
        `"${name}" changes no file in this corpus, so it proves nothing — pick a transform that does`,
      ).toBeGreaterThan(0)
      expect(
        result.changed.length,
        `the comparison did not notice every file an editor that ${name} damages`,
      ).toBe(expectedDamaged)
    })
  }
})
