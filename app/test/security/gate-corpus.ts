/**
 * The meta-gate's fixture corpus.
 *
 * FIXTURES ARE HAND-WRITTEN ON PURPOSE, and this is the single most important property in the
 * file. Generating them from the config would be circular: a ban on a module nobody imports, or
 * on a property no object has, would get a generated fixture that triggers it and would certify
 * as live. That is defect #1 exactly — `document.write` was configured as a property name, no
 * property is named that, and it matched nothing for weeks while every test stayed green.
 *
 * Each known-bad fixture NAMES the ban it proves, as "<block>::<id>". Each known-good fixture
 * names the rule that must govern its path and the construct it exists to vindicate.
 */

import type { Fixture, PassFixture } from './gate-lib'

const imp = (mod: string): string => `import x from '${mod}'\nexport const used = x\n`

export const MUST_FAIL: Fixture[] = [
  // --- imports/outside-core -------------------------------------------------------------
  { what: 'fs imported in the server', filePath: 'src/server/probe.ts', code: imp('fs'),
    proves: 'imports/outside-core::import:fs' },
  { what: 'node:fs imported in the server', filePath: 'src/server/probe.ts', code: imp('node:fs'),
    proves: 'imports/outside-core::import:node:fs' },
  { what: 'fs/promises imported in the contract', filePath: 'src/contract/probe.ts', code: imp('fs/promises'),
    proves: 'imports/outside-core::import:fs/promises' },
  { what: 'node:fs/promises imported in the contract', filePath: 'src/contract/probe.ts', code: imp('node:fs/promises'),
    proves: 'imports/outside-core::import:node:fs/promises' },
  { what: 'child_process imported in the server', filePath: 'src/server/probe.ts', code: imp('child_process'),
    proves: 'imports/outside-core::import:child_process' },
  { what: 'node:child_process imported in the server', filePath: 'src/server/probe.ts', code: imp('node:child_process'),
    proves: 'imports/outside-core::import:node:child_process' },
  { what: 'node:fs imported from a .tsx file outside the Core', filePath: 'src/client/probe.tsx', code: imp('node:fs'),
    proves: 'imports/outside-core::import:node:fs' },

  // --- imports/sanctioned-shell ---------------------------------------------------------
  //
  // The scope the operator's 2026-08-14 ruling created: `src/server/reveal.ts` may import
  // `child_process` and NOTHING ELSE is relaxed. These four prove the second half — an exception
  // that quietly widened to `node:fs` would be a module able to run programs AND read the disk
  // outside the Core's one gate, and it would lint clean.
  { what: 'fs imported in the sanctioned shell module', filePath: 'src/server/reveal.ts',
    code: imp('fs'), proves: 'imports/sanctioned-shell::import:fs' },
  { what: 'node:fs imported in the sanctioned shell module', filePath: 'src/server/reveal.ts',
    code: imp('node:fs'), proves: 'imports/sanctioned-shell::import:node:fs' },
  { what: 'fs/promises imported in the sanctioned shell module', filePath: 'src/server/reveal.ts',
    code: imp('fs/promises'), proves: 'imports/sanctioned-shell::import:fs/promises' },
  { what: 'node:fs/promises imported in the sanctioned shell module',
    filePath: 'src/server/reveal.ts', code: imp('node:fs/promises'),
    proves: 'imports/sanctioned-shell::import:node:fs/promises' },

  // --- imports/core-except-fs -----------------------------------------------------------
  { what: 'fs imported inside the Core', filePath: 'src/core/probe.ts', code: imp('fs'),
    proves: 'imports/core-except-fs::import:fs' },
  { what: 'node:fs imported inside the Core (the scope that was silently unprotected)',
    filePath: 'src/core/probe.ts', code: imp('node:fs'),
    proves: 'imports/core-except-fs::import:node:fs' },
  { what: 'fs/promises imported inside the Core', filePath: 'src/core/probe.ts', code: imp('fs/promises'),
    proves: 'imports/core-except-fs::import:fs/promises' },
  { what: 'node:fs/promises imported inside the Core', filePath: 'src/core/probe.ts', code: imp('node:fs/promises'),
    proves: 'imports/core-except-fs::import:node:fs/promises' },
  { what: 'child_process imported inside the Core', filePath: 'src/core/probe.ts', code: imp('child_process'),
    proves: 'imports/core-except-fs::import:child_process' },
  { what: 'node:child_process imported inside the Core', filePath: 'src/core/probe.ts', code: imp('node:child_process'),
    proves: 'imports/core-except-fs::import:node:child_process' },
  { what: 'http imported inside the Core', filePath: 'src/core/probe.ts', code: imp('http'),
    proves: 'imports/core-except-fs::import:http' },
  { what: 'node:http imported inside the Core', filePath: 'src/core/probe.ts', code: imp('node:http'),
    proves: 'imports/core-except-fs::import:node:http' },
  { what: 'https imported inside the Core', filePath: 'src/core/probe.ts', code: imp('https'),
    proves: 'imports/core-except-fs::import:https' },
  { what: 'node:https imported inside the Core', filePath: 'src/core/probe.ts', code: imp('node:https'),
    proves: 'imports/core-except-fs::import:node:https' },
  { what: 'net imported inside the Core', filePath: 'src/core/probe.ts', code: imp('net'),
    proves: 'imports/core-except-fs::import:net' },
  { what: 'node:net imported inside the Core', filePath: 'src/core/probe.ts', code: imp('node:net'),
    proves: 'imports/core-except-fs::import:node:net' },
  { what: 'react imported inside the Core', filePath: 'src/core/probe.ts', code: imp('react'),
    proves: 'imports/core-except-fs::import:react' },
  { what: 'react-dom imported inside the Core', filePath: 'src/core/probe.ts', code: imp('react-dom'),
    proves: 'imports/core-except-fs::import:react-dom' },
  { what: 'the Core reaching into the server adapter', filePath: 'src/core/probe.ts',
    code: `import { thing } from '../server/thing'\nexport const used = thing\n`,
    proves: 'imports/core-except-fs::importPattern:**/server/**' },
  { what: 'the Core reaching into the client adapter', filePath: 'src/core/probe.ts',
    code: `import { thing } from '../client/thing'\nexport const used = thing\n`,
    proves: 'imports/core-except-fs::importPattern:**/client/**' },
  { what: 'node:fs imported from a .tsx file inside the Core (the scope hole)',
    filePath: 'src/core/probe.tsx', code: imp('node:fs'),
    proves: 'imports/core-except-fs::import:node:fs' },

  // --- imports/core-fs ------------------------------------------------------------------
  { what: 'child_process in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('child_process'),
    proves: 'imports/core-fs::import:child_process' },
  { what: 'node:child_process in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('node:child_process'),
    proves: 'imports/core-fs::import:node:child_process' },
  { what: 'http in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('http'),
    proves: 'imports/core-fs::import:http' },
  { what: 'node:http in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('node:http'),
    proves: 'imports/core-fs::import:node:http' },
  { what: 'https in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('https'),
    proves: 'imports/core-fs::import:https' },
  { what: 'node:https in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('node:https'),
    proves: 'imports/core-fs::import:node:https' },
  { what: 'net in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('net'),
    proves: 'imports/core-fs::import:net' },
  { what: 'node:net in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('node:net'),
    proves: 'imports/core-fs::import:node:net' },
  { what: 'react in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('react'),
    proves: 'imports/core-fs::import:react' },
  { what: 'react-dom in the sanctioned fs module', filePath: 'src/core/fs/probe.ts', code: imp('react-dom'),
    proves: 'imports/core-fs::import:react-dom' },
  { what: 'the fs module reaching into the server adapter', filePath: 'src/core/fs/probe.ts',
    code: `import { thing } from '../../server/thing'\nexport const used = thing\n`,
    proves: 'imports/core-fs::importPattern:**/server/**' },
  { what: 'the fs module reaching into the client adapter', filePath: 'src/core/fs/probe.ts',
    code: `import { thing } from '../../client/thing'\nexport const used = thing\n`,
    proves: 'imports/core-fs::importPattern:**/client/**' },
  { what: 'child_process in a .tsx file in the sanctioned fs module',
    filePath: 'src/core/fs/probe.tsx', code: imp('child_process'),
    proves: 'imports/core-fs::import:child_process' },

  // --- no-html-string-sinks-in-client ---------------------------------------------------
  { what: 'innerHTML assigned in the client', filePath: 'src/client/probe.ts',
    code: `export function f(el: HTMLElement, s: string) { el.innerHTML = s }\n`,
    proves: 'properties/outside-core-and-server::property:innerHTML' },
  { what: 'outerHTML assigned in the client', filePath: 'src/client/probe.ts',
    code: `export function f(el: HTMLElement, s: string) { el.outerHTML = s }\n`,
    proves: 'properties/outside-core-and-server::property:outerHTML' },
  { what: 'insertAdjacentHTML called in the client', filePath: 'src/client/probe.ts',
    code: `export function f(el: HTMLElement, s: string) { el.insertAdjacentHTML('beforeend', s) }\n`,
    proves: 'properties/outside-core-and-server::property:insertAdjacentHTML' },
  { what: 'srcdoc assigned in the client', filePath: 'src/client/probe.ts',
    code: `export function f(el: HTMLIFrameElement, s: string) { el.srcdoc = s }\n`,
    proves: 'properties/outside-core-and-server::property:srcdoc' },
  { what: 'the document reached through window (the alias route)', filePath: 'src/client/probe.ts',
    code: `export function f() { return window.document }\n`,
    proves: 'properties/outside-core-and-server::property:window.document' },
  { what: 'the bare document global used in the client', filePath: 'src/client/probe.ts',
    code: `export function f() { return document.title }\n`,
    proves: 'no-document-global-in-client::global:document' },
  { what: 'the bare document global used from a .tsx client file', filePath: 'src/client/probe.tsx',
    code: `export function f() { return document.title }\n`,
    proves: 'no-document-global-in-client::global:document' },
  { what: 'innerHTML assigned from a .tsx client file', filePath: 'src/client/probe.tsx',
    code: `export function f(el: HTMLElement, s: string) { el.innerHTML = s }\n`,
    proves: 'properties/outside-core-and-server::property:innerHTML' },

  // --- security-syntax-bans -------------------------------------------------------------
  { what: 'bare exec()', filePath: 'src/server/probe.ts',
    code: `declare function exec(c: string): void\nexport function f(n: string) { exec('ls ' + n) }\n`,
    proves: "security-syntax-bans::syntax:CallExpression[callee.name='exec']" },
  { what: 'bare execSync()', filePath: 'src/server/probe.ts',
    code: `declare function execSync(c: string): void\nexport function f(n: string) { execSync('ls ' + n) }\n`,
    proves: "security-syntax-bans::syntax:CallExpression[callee.name='execSync']" },
  { what: 'bare spawnSync()', filePath: 'src/server/probe.ts',
    code: `declare function spawnSync(c: string): void\nexport function f(n: string) { spawnSync('ls ' + n) }\n`,
    proves: "security-syntax-bans::syntax:CallExpression[callee.name='spawnSync']" },
  { what: 'document.write, the fifth HTML sink', filePath: 'src/client/probe.ts',
    code: `declare const markup: string\nexport function f() { document.write(markup) }\n`,
    proves: "security-syntax-bans::syntax:MemberExpression[property.name=/^(write|writeln)$/][object.name='document']" },
  { what: 'document.write reached through window', filePath: 'src/client/probe.ts',
    code: `declare const markup: string\nexport function f() { window.document.write(markup) }\n`,
    proves: "security-syntax-bans::syntax:MemberExpression[property.name=/^(write|writeln)$/][object.property.name='document']" },
  { what: 'bare exec() from a .tsx file', filePath: 'src/client/probe.tsx',
    code: `declare function exec(c: string): void\nexport function f(n: string) { exec('ls ' + n) }\n`,
    proves: "security-syntax-bans::syntax:CallExpression[callee.name='exec']" },

  // --- no-raw-startsWith-on-paths -------------------------------------------------------
  { what: 'raw startsWith on a path in the Core', filePath: 'src/core/probe.ts',
    code: `export function f(a: string, b: string) { return a.startsWith(b) }\n`,
    proves: 'properties/core-and-server::property:startsWith' },
  { what: 'raw startsWith in the server', filePath: 'src/server/probe.ts',
    code: `export function f(a: string, b: string) { return a.startsWith(b) }\n`,
    proves: 'properties/core-and-server::property:startsWith' },
  { what: 'raw startsWith from a .tsx file in the Core', filePath: 'src/core/probe.tsx',
    code: `export function f(a: string, b: string) { return a.startsWith(b) }\n`,
    proves: 'properties/core-and-server::property:startsWith' },
// --- properties/core-and-server: the sinks now apply here too -------------------------
  // the security review's finding. These bans did not exist outside src/client until the re-partition, and the
  // OBVIOUS repair — widening the client block — silently disabled all five at Core paths while
  // the gate stayed green. Markup is not built only in the client.
  { what: 'innerHTML assigned in the Core', filePath: 'src/core/probe.ts',
    code: `export function f(el: HTMLElement, s: string) { el.innerHTML = s }\n`,
    proves: 'properties/core-and-server::property:innerHTML' },
  { what: 'outerHTML assigned in the server', filePath: 'src/server/probe.ts',
    code: `export function f(el: HTMLElement, s: string) { el.outerHTML = s }\n`,
    proves: 'properties/core-and-server::property:outerHTML' },
  { what: 'insertAdjacentHTML called in the Core', filePath: 'src/core/probe.ts',
    code: `export function f(el: HTMLElement, s: string) { el.insertAdjacentHTML('beforeend', s) }\n`,
    proves: 'properties/core-and-server::property:insertAdjacentHTML' },
  { what: 'srcdoc assigned in the server', filePath: 'src/server/probe.ts',
    code: `export function f(el: HTMLIFrameElement, s: string) { el.srcdoc = s }\n`,
    proves: 'properties/core-and-server::property:srcdoc' },
  { what: 'the document reached through window, in the Core', filePath: 'src/core/probe.ts',
    code: `export function f() { return window.document }\n`,
    proves: 'properties/core-and-server::property:window.document' },
  { what: 'innerHTML assigned from a .tsx file in the Core', filePath: 'src/core/probe.tsx',
    code: `export function f(el: HTMLElement, s: string) { el.innerHTML = s }\n`,
    proves: 'properties/core-and-server::property:innerHTML' },

  // --- module acquisition and execution sinks -------------------------------------------
  // the security review's re-ruling of gate 5. Their ratification rested on "an import is an unaliasable
  // chokepoint", which was false; these close the routes that made it false, so the chokepoint
  // becomes a theorem rather than a claim.
  { what: 'dynamic import of fs', filePath: 'src/core/probe.ts',
    code: `export const m = import('fs')\n`,
    proves: "security-syntax-bans::syntax:ImportExpression[source.value='fs']" },
  { what: 'dynamic import of node:fs', filePath: 'src/core/probe.ts',
    code: `export const m = import('node:fs')\n`,
    proves: "security-syntax-bans::syntax:ImportExpression[source.value='node:fs']" },
  { what: 'dynamic import of fs/promises', filePath: 'src/core/probe.ts',
    code: `export const m = import('fs/promises')\n`,
    proves: "security-syntax-bans::syntax:ImportExpression[source.value='fs/promises']" },
  { what: 'dynamic import of node:fs/promises', filePath: 'src/core/probe.ts',
    code: `export const m = import('node:fs/promises')\n`,
    proves: "security-syntax-bans::syntax:ImportExpression[source.value='node:fs/promises']" },
  { what: 'dynamic import of child_process', filePath: 'src/core/probe.ts',
    code: `export const m = import('child_process')\n`,
    proves: "security-syntax-bans::syntax:ImportExpression[source.value='child_process']" },
  { what: 'dynamic import of node:child_process — the route that walked past the import ban',
    filePath: 'src/core/probe.ts',
    code: `export const m = import('node:child_process')\n`,
    proves: "security-syntax-bans::syntax:ImportExpression[source.value='node:child_process']" },
  { what: 'createRequire, which builds a require that reaches any builtin',
    filePath: 'src/core/probe.ts',
    code: `import { createRequire } from 'node:module'\nexport const r = createRequire(import.meta.url)\n`,
    proves: "security-syntax-bans::syntax:CallExpression[callee.name='createRequire']" },
  { what: 'process.getBuiltinModule — idiomatic modern Node, and the sharpest bypass',
    filePath: 'src/core/probe.ts',
    code: `export const cp = process.getBuiltinModule('node:child_process')\n`,
    proves: "security-syntax-bans::syntax:MemberExpression[property.name='getBuiltinModule']" },
  { what: 'require() in an ESM package', filePath: 'src/core/probe.ts',
    code: `declare function require(m: string): unknown\nexport const fs = require('node:fs')\n`,
    proves: "security-syntax-bans::syntax:CallExpression[callee.name='require']" },
  { what: 'process.binding through a cast — the form the constrained selector missed',
    filePath: 'src/core/probe.ts',
    code: `export const b = (process as unknown as { binding(n: string): unknown }).binding('fs')\n`,
    proves: "security-syntax-bans::syntax:MemberExpression[property.name='binding']" },
  { what: 'eval of a string', filePath: 'src/core/probe.ts',
    code: `export function f(s: string) { return eval(s) }\n`,
    proves: "security-syntax-bans::syntax:CallExpression[callee.name='eval']" },
  { what: 'new Function — eval by another name', filePath: 'src/core/probe.ts',
    code: `export function f(s: string) { return new Function(s) }\n`,
    proves: "security-syntax-bans::syntax:NewExpression[callee.name='Function']" },
]

// The eighteen CSP fixtures that lived here were DELETED 2026-08-07 with the bans they proved.
// See the note in eslint.config.js: they certified a control that the normal way of writing a CSP
// walks straight past. The replacement is a Phase 2 test on the emitted header.

export const CORPUS: Fixture[] = MUST_FAIL

/**
 * The known-good corpus. Re-gate hole 9: nothing previously checked that these fixtures parsed,
 * landed in a governed scope, or exercised anything — every one could be replaced with
 * `export const x = 1` and the suite stayed green. `mustContain` is the third of those.
 */
export const MUST_PASS: PassFixture[] = [
  { what: 'node:fs inside the sanctioned fs module — its entire purpose',
    filePath: 'src/core/fs/containment.ts', code: imp('node:fs'),
    governedBy: 'no-restricted-imports', mustContain: `'node:fs'` },
  { what: 'child_process in the ONE module permitted it — the exception itself',
    filePath: 'src/server/reveal.ts', code: imp('node:child_process'),
    governedBy: 'no-restricted-imports', mustContain: `'node:child_process'` },
  { what: 'the unprefixed spelling too, in the same module',
    filePath: 'src/server/reveal.ts', code: imp('child_process'),
    governedBy: 'no-restricted-imports', mustContain: `'child_process'` },
  { what: 'execFile with an argument array — the prescribed form',
    filePath: 'src/server/ok.ts',
    code: `declare function execFile(f: string, a: string[], o: object): void\nexport function f(p: string) { execFile('/usr/bin/open', ['-R', p], { shell: false }) }\n`,
    governedBy: 'no-restricted-syntax', mustContain: 'execFile(' },
  { what: "the real CSP, which carries style-src 'unsafe-inline' and must not trip",
    filePath: 'src/server/ok.ts',
    code: `export const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'"\n`,
    governedBy: 'no-restricted-syntax', mustContain: `style-src 'self' 'unsafe-inline'` },
  { what: 'textContent, the prescribed alternative to innerHTML',
    filePath: 'src/client/ok.ts',
    code: `export function f(el: HTMLElement, s: string) { el.textContent = s }\n`,
    governedBy: 'no-restricted-properties', mustContain: 'textContent' },
  { what: 'RegExp.prototype.exec — safe, ubiquitous, and once falsely flagged',
    filePath: 'src/core/ok.ts',
    code: `const RE = /^[0-9]+-/\nexport function f(s: string) { return RE.exec(s) }\n`,
    governedBy: 'no-restricted-syntax', mustContain: '.exec(' },
  { what: 'a .tsx client file using the prescribed renderer calls',
    filePath: 'src/client/ok.tsx',
    code: `export function f(d: Document, s: string) { const n = d.createElement('div'); n.textContent = s; return n }\n`,
    governedBy: 'no-restricted-properties', mustContain: 'createElement' },
]
