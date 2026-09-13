import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * **A gate condition, not tidiness.**
 *
 * P6's gate is a number the harness produces by mounting an editor in a browser. If the harness
 * entry assembles its own configuration, that number describes an editor **nobody ships** — and it
 * would look exactly like evidence while being none. The failure is silent and total: a perfectly
 * green 100% over a corpus, measuring something the user never runs.
 *
 * So `createEditor` is the only constructor, and this proves the harness has not grown a second
 * one.
 *
 * ## Why this reads imports rather than searching the source text
 *
 * Earlier phases had five source-text assertions that matched a **comment** rather than code and
 * passed while the control was absent. A test that greps for `EditorState` would be defeated by
 * this very file's own prose, and — worse — would pass for the wrong reason the moment someone
 * mentions the name in a docstring.
 *
 * Import statements are the honest surface: an extension cannot be configured without being
 * imported, and an import line is unambiguous in a way a mention is not.
 */
const CLIENT = join(import.meta.dirname, '../../../src/client')

function importedModules(file: string): string[] {
  const source = readFileSync(join(CLIENT, file), 'utf8')
  return [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1] ?? '')
}

describe('there is one editor, and the harness measures it', () => {
  it('the harness entry imports no CodeMirror module of its own', () => {
    const imports = importedModules('harness-entry.ts')
    const codemirror = imports.filter(m => m.startsWith('@codemirror/') || m.startsWith('@lezer/') || m === 'codemirror')
    expect(
      codemirror,
      'the harness must not configure an editor — it must mount the one the app ships',
    ).toEqual([])
  })

  it('the harness entry reaches the editor only through the shared factory', () => {
    const editorImports = importedModules('harness-entry.ts').filter(m => m.includes('editor/'))
    expect(editorImports).toEqual(['./editor/create-editor'])
  })

  it('the app entry constructs its editor the same way', () => {
    // If the app stopped using the factory, the harness would still be measuring the factory —
    // the same divergence from the other end.
    const imports = importedModules('main.tsx')
    expect(imports).toContain('./editor/create-editor')
    expect(imports.filter(m => m.startsWith('@codemirror/'))).toEqual([])
  })

  it('only the editor modules import CodeMirror at all', () => {
    /**
     * The boundary, stated once. Everything CodeMirror-shaped lives under `editor/`, so a future
     * screen cannot quietly build a second surface with its own configuration — which is how the
     * old app came to have a preview and an editor that disagreed.
     */
    const offenders = ['main.tsx', 'harness-entry.ts', 'dom.ts', 'navigation.ts', 'overlays.ts', 'feedback.ts']
      .filter(f => importedModules(f).some(m => m.startsWith('@codemirror/') || m === 'codemirror'))
    expect(offenders).toEqual([])
  })
})
