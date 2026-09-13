import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * **EVERY `§n` IN THE SOURCE MUST RESOLVE TO A PUBLISHED SECTION.**
 *
 * ## The failure this exists to stop, which had already happened
 *
 * The comments in this repository cite spec sections constantly — `§7`, `§13.5`, `§18.9` — and those
 * citations are the load-bearing half of the documentation: a rule that looks arbitrary is almost
 * always a rule with a section behind it explaining what went wrong once. A citation that resolves
 * to nothing is worse than no citation, because the reader spends the effort before discovering
 * there is nothing there.
 *
 * **Seven section numbers were dangling when this was written** — 2.4, 2.5, 4.1, 4.2, 4.6, 4.7 and
 * 4.8, across sixty-seven sites. Not one of them was a typo. They were citations into two *other*
 * documents that shared the same section namespace: a build plan and a design packet. The code cited
 * 4.6 meaning the packet, while 4 in the same file meant the spec's path-safety section, and nothing
 * in the syntax distinguished them.
 *
 * **Those numbers are written here without the section sign on purpose**, so that this gate applies
 * to its own file like every other. A gate that has to exempt itself to pass is one exemption away
 * from exempting something that matters.
 *
 * That is the defect: **a shared numbering namespace across documents, cited without naming the
 * document.** It resolved by publishing the packet alongside the spec, so both live in
 * `00-context/` and both are readable by anyone who reads the code.
 *
 * ## Why the check is "resolves in either", not "resolves in the right one"
 *
 * §4 exists in both documents and means different things in each. A test that tried to attribute
 * each citation to the correct document would need to parse intent from prose, and would be a
 * second unproven surface guarding the first — the shape this codebase refuses elsewhere. The
 * failure actually worth catching is **a citation with no section anywhere behind it**, which is
 * unambiguous and is what this asserts.
 *
 * A consequence worth stating rather than discovering: renumbering a section in either document
 * fails this test at every site that cited it. That is the intent. Section numbers are an interface.
 */

const REPO = join(import.meta.dirname, '..', '..', '..')
const DOCS = ['00-context/spec.md', '00-context/design.md']
const ROOTS = ['src', 'test']

/** Extensions that carry comments citing the spec. `.css` is in here because the tokens do. */
const SOURCE = new Set(['.ts', '.tsx', '.css', '.cjs', '.html'])

function filesUnder(directory: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      // `harness/corpus` and `harness/probes` are markdown fixtures, not source, and a probe that
      // happens to contain a section sign is a document being round-tripped rather than a citation.
      if (entry.name === 'corpus' || entry.name === 'probes' || entry.name === 'fixtures') continue
      filesUnder(full, acc)
    } else if (SOURCE.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      acc.push(full)
    }
  }
  return acc
}

/** Every heading number the published documents define, as strings: `13`, `13.5`, `18.9`. */
function publishedSections(): Set<string> {
  const out = new Set<string>()
  for (const doc of DOCS) {
    const text = readFileSync(join(REPO, doc), 'utf8')
    for (const line of text.split('\n')) {
      const heading = /^#{2,4} (\d+(?:\.\d+)*)/.exec(line)
      if (heading?.[1] !== undefined) out.add(heading[1])
    }
  }
  return out
}

describe('the spec citations in the source', () => {
  it('every §n cited in the code has a section behind it', () => {
    const sections = publishedSections()

    /**
     * Asserted before the citations are checked. An empty set would make every citation "missing"
     * and the failure would read as sixty broken comments rather than one unreadable document —
     * and a *renamed* spec file would produce exactly that.
     */
    expect(sections.size, `no headings found in ${DOCS.join(' or ')} — is the path right?`)
      .toBeGreaterThan(20)

    const dangling: string[] = []
    for (const root of ROOTS) {
      for (const file of filesUnder(join(REPO, 'app', root))) {
        const text = readFileSync(file, 'utf8')
        for (const match of text.matchAll(/§(\d+(?:\.\d+)*)/g)) {
          // A trailing dot is sentence punctuation, not a subsection: `§13.` cites §13.
          const cited = (match[1] ?? '').replace(/\.$/, '')
          if (cited !== '' && !sections.has(cited)) {
            dangling.push(`${file.slice(REPO.length + 1)} cites §${cited}`)
          }
        }
      }
    }

    expect(
      [...new Set(dangling)].sort(),
      'these citations point at a section no published document defines',
    ).toEqual([])
  })

  /**
   * The other direction, and it is deliberately **not** an assertion.
   *
   * An uncited section is not a defect — §0, §1 and §22 are framing and open questions, and nothing
   * in the code should be citing them. Reported so a reader can see the shape of the coverage
   * without a gate that would fail for a good reason.
   */
  it('reports which sections nothing in the code cites', () => {
    const sections = publishedSections()
    const cited = new Set<string>()
    for (const root of ROOTS) {
      for (const file of filesUnder(join(REPO, 'app', root))) {
        for (const match of readFileSync(file, 'utf8').matchAll(/§(\d+(?:\.\d+)*)/g)) {
          cited.add((match[1] ?? '').replace(/\.$/, ''))
        }
      }
    }
    const uncited = [...sections].filter(section => !cited.has(section)).sort()
    console.log(`\n  ${cited.size} sections cited, ${uncited.length} never cited: ${uncited.join(' ') || 'none'}\n`)
    expect(sections.size).toBeGreaterThan(0)
  })
})
