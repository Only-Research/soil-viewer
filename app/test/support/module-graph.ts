/**
 * A module graph over the source tree, and the two questions it exists to answer.
 *
 * **This is an instrument, and instruments in this build get tested like anything else.** The
 * harness went ten scripts deep reading from a directory that no longer existed, with only one of
 * them failing loudly enough to notice — an instrument nothing checks is an instrument whose
 * reports are believed rather than known. `test/tools/reachability.test.ts` runs it against
 * synthetic trees with a known answer before it is allowed to judge the real one.
 *
 * ## Why it exists
 *
 * Nine controls in this build have been individually correct, thoroughly tested, mutation-swept,
 * and called by no product code. `indexRoot`. `document-session`. `feedback`. The editor's entire
 * write surface. `inspectBackup`. §6's error-message table. Root rows in the tree.
 * `retained-buffer`. Live-update consumption. Every one of them had a green suite; every one of
 * them did nothing for a person.
 *
 * Unit tests are structurally blind to this: a test IS a caller, so a module with tests always has
 * an importer. The only way to see the defect is to ask what the **product** reaches, starting from
 * the entry points the build actually ships, and tests are not on that path.
 *
 * the security review's recommendation after the P7 review — that this become a CI gate rather than a discipline
 * — is what this file is. They measured that it would have caught six of the first seven the day they
 * landed.
 *
 * ## The second rule, which reachability alone cannot see
 *
 * Two of the nine were *reachable modules with an empty callback*: §6's error-message table, and
 * live updates. Both were imported, constructed and called; both handed their result to `() => {}`.
 * A graph walk says those files are fine, because they are — the wiring is what is missing. So
 * `emptyArrowsIn` is the second rule, and it is deliberately blunt: an empty function body in
 * product code is either allowlisted with a reason, or it is a defect.
 *
 * ## What it cannot see, stated rather than discovered later
 *
 * - **A type-only import counts as an edge.** A module reachable only because someone imported a
 *   type from it is reported as reachable, though nothing of it ships. Fixing that needs a real
 *   parser; the blind spot is narrow and named here rather than pretended away.
 * - **A dynamic specifier is invisible.** `import(someVariable)` resolves nothing, so a module
 *   reached only that way reads as unreachable. Nothing in this build does it; if something starts,
 *   the gate will say so loudly rather than silently miss it, which is the right direction to fail.
 * - **It is a file-level answer.** An imported module with one unused export still counts as
 *   reached. Dead exports are a different question and this does not pretend to answer it.
 */

/** A source file, keyed by a path relative to `app/`, always with forward slashes. */
export interface SourceTree {
  readonly files: readonly string[]
  readonly read: (file: string) => string
}

/**
 * Removes comments and string bodies, so a later regex cannot match inside either.
 *
 * **Written as a scanner rather than a regex, and that is not gold-plating.** A previous test in
 * this build asserted a module contained no `Buffer` and matched the word inside its own doc
 * comment — a test a correct file failed and a paraphrase could turn green. The mirror-image
 * failure is available here: this file's own header names `import(someVariable)` and `() => {}`,
 * and a naive stripper would let the gate read its own prose as source.
 *
 * String *bodies* are blanked rather than removed, so column and line positions survive and an
 * `import './x'` keeps its quotes and its specifier. Only the risk of matching **inside** the text
 * is removed.
 */
export function stripCommentary(source: string): string {
  const out: string[] = []
  let i = 0
  const n = source.length

  while (i < n) {
    const two = source.slice(i, i + 2)

    if (two === '//') {
      while (i < n && source[i] !== '\n') { out.push(' '); i += 1 }
      continue
    }
    if (two === '/*') {
      while (i < n && source.slice(i, i + 2) !== '*/') {
        // Newlines are kept so line numbers stay true; everything else becomes a space.
        out.push(source[i] === '\n' ? '\n' : ' ')
        i += 1
      }
      out.push('  ')
      i += 2
      continue
    }

    const char = source[i]
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      out.push(quote)
      i += 1
      while (i < n) {
        if (source[i] === '\\') {
          // An escape and whatever it escapes are both consumed, so `'\''` does not end the string.
          out.push('  ')
          i += 2
          continue
        }
        if (source[i] === quote) break
        out.push(source[i] === '\n' ? '\n' : ' ')
        i += 1
      }
      out.push(quote)
      i += 1
      continue
    }

    out.push(char ?? '')
    i += 1
  }
  return out.join('')
}

/**
 * The import specifiers a file names.
 *
 * Run against the ORIGINAL source, not the stripped one — the stripped copy has blanked the
 * specifiers themselves. The comment stripper is used to find which regions are code, and the
 * matches are then read back out of the original at the same offsets, which works because
 * `stripCommentary` preserves length exactly.
 */
export function importsIn(source: string): string[] {
  const masked = stripCommentary(source)
  const found: string[] = []
  // `from '…'`, a bare `import '…'`, and `import('…')`. Covers `export … from` too, since the
  // `from` clause is identical.
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(?:[^'"\n]*)\1/g

  for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
    const quote = match[1] ?? "'"
    const start = match.index + match[0].indexOf(quote) + 1
    const end = match.index + match[0].length - 1
    found.push(source.slice(start, end))
  }
  return found
}

/** Joins a relative specifier onto a file's directory, resolving `.` and `..`. Posix only. */
function resolveRelative(fromFile: string, specifier: string): string {
  const parts = fromFile.split('/').slice(0, -1)
  for (const step of specifier.split('/')) {
    if (step === '.' || step === '') continue
    if (step === '..') { parts.pop(); continue }
    parts.push(step)
  }
  return parts.join('/')
}

/**
 * The file a specifier names, or `null` for anything outside the tree.
 *
 * Bare specifiers (`vitest`, `node:fs`, `@codemirror/state`) resolve to `null` on purpose: a
 * dependency is not a module of ours and cannot be unreachable.
 */
export function resolveImport(
  fromFile: string, specifier: string, files: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolveRelative(fromFile, specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (files.has(candidate)) return candidate
  }
  return null
}

/** Every file reachable from the entry points by following imports. Entries included. */
export function reachableFrom(entries: readonly string[], tree: SourceTree): Set<string> {
  const files = new Set(tree.files)
  const seen = new Set<string>()
  const queue = [...entries]

  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file) || !files.has(file)) continue
    seen.add(file)
    for (const specifier of importsIn(tree.read(file))) {
      const target = resolveImport(file, specifier, files)
      if (target !== null && !seen.has(target)) queue.push(target)
    }
  }
  return seen
}

/**
 * Lines holding an **undocumented** empty function body, one-based.
 *
 * Two exemptions, and each one is a distinction the codebase already draws by hand.
 *
 * **A declaration's initializer is a placeholder, not an unkept promise.**
 * `let stopListening = (): void => {}` is a typed hole that a dialog fills four lines later;
 * `onEvent: () => {}` is a promise to do something, kept by nobody. The second shape survived a
 * whole phase twice — §6's error-message table and §15's live updates — and is what this rule is
 * for.
 *
 * **Silence with a stated reason is a decision.** Seven `.catch(() => { … })` sites in this build
 * swallow an error on purpose and every one of them says why in the braces: *"already closed on the
 * success path"*, *"reporting the original failure matters more"*, *"last resort"*. That is exactly
 * the behaviour the rule wants to encourage, so flagging it would train people to delete the
 * explanation rather than write one. A body with nothing between the braces has no reason, which is
 * the whole finding.
 *
 * The candidates are found in the **masked** copy so the gate cannot read its own documentation as
 * source, and then checked against the **original** at the same offsets — which works only because
 * `stripCommentary` preserves length exactly.
 */
export function emptyArrowsIn(source: string): number[] {
  const masked = stripCommentary(source)
  const lines: number[] = []

  const record = (index: number, length: number): void => {
    // A comment lived between the braces: the silence is explained, which is what we want.
    const original = source.slice(index, index + length)
    const open = original.indexOf('{')
    if (open !== -1 && original.slice(open + 1, original.lastIndexOf('}')).trim() !== '') return

    const line = masked.slice(0, index).split('\n').length
    /**
     * **The placeholder exemption looks BACKWARDS from the arrow, not at the line.**
     *
     * It used to test whether the line started with `let`/`const`/`var`, which the security review's C3 broke in
     * one keystroke: `const wiring = { onEvent: () => {} }` starts with `const`, so collapsing an
     * object onto its declaration line hid an empty callback from the rule that exists to find
     * empty callbacks.
     *
     * The real question is whether this arrow **is** the declarator's initializer, and the text
     * between the declaration and the arrow answers it: a bare `name =` or `name: Type =`, with no
     * `{`, `,` or `(` in between. Anything else — an object literal, an argument list — means the
     * arrow is nested inside something the declaration merely contains, which is the shape that
     * was slipping through.
     */
    const before = masked.slice(0, index)
    const declaration =
      /\b(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=;{,]*)?=\s*(?:\([^()]*\)\s*(?::[^={,;]*)?|[A-Za-z_$][\w$]*)?\s*$/
    if (declaration.test(before)) return
    if (!lines.includes(line)) lines.push(line)
  }

  const arrow = /=>\s*\{\s*\}/g
  for (let m = arrow.exec(masked); m !== null; m = arrow.exec(masked)) record(m.index, m[0].length)

  /**
   * `function foo() {}`, `function () {}`, and **method shorthand** — `onEvent() {}` on an object
   * literal or a class. The security review's C3 on Phase 8: the first version matched the arrow spelling only,
   * so `onEvent() {}` was invisible to a rule whose entire subject is empty callbacks, and it is as
   * idiomatic as the spelling that was caught.
   *
   * The name is optional and the leading `function` is optional, which is what makes one pattern
   * cover all three. A bare `) {}` would also match `if (x) {}` and `for (…) {}`, so the pattern
   * requires an identifier or `function` immediately before the parameter list, and the keyword
   * exclusion below removes the control-flow words that would otherwise qualify.
   */
  const method = /(?:\bfunction\s*)?\b([A-Za-z_$][\w$]*)?\s*\([^()]*\)\s*(?::[^{;=]*)?\{\s*\}/g
  const CONTROL_FLOW = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'do'])
  for (let m = method.exec(masked); m !== null; m = method.exec(masked)) {
    const name = m[1]
    // `if (x) {}` is an empty block, not an unkept promise. A different defect, and not this rule's.
    if (name !== undefined && CONTROL_FLOW.has(name)) continue
    // An anonymous `() {}` with no `function` is not valid syntax on its own — it is the tail of an
    // arrow, already counted above, or of a call. Requiring one or the other keeps the noise out.
    if (name === undefined && !m[0].trimStart().startsWith('function')) continue
    record(m.index, m[0].length)
  }

  return lines.sort((a, b) => a - b)
}
