/**
 * The registered folders. Spec §11.
 *
 * This is where **R2** from the Phase 2 security review lands, and it is the reason this file
 * knows about the mutation log at all.
 *
 * `openAppendLog` checks that the log is outside every registered root — but it takes the roots
 * **once, at open time**, and `append` never re-checks. The review proved the consequence: open the
 * log with no roots registered (which is the state at startup), then register a folder that
 * contains it — the operator registering their home directory, an entirely ordinary thing to do — and the
 * log writes inside a registered root forever. The check was real; nothing re-ran it.
 *
 * The fix belongs here rather than in the writer. A writer that re-checked on every append would be
 * doing filesystem work on the hot path to defend against a condition that changes only at
 * registration. **Registration is the event; registration is where it is refused.**
 */

import { ErrorCode, fail, ok, type Result } from '../core/errors'

/**
 * Spec §11: *"a cap of 16 roots."* The one number that section states about how many.
 *
 * A parameter would invite raising it; a constant makes raising it a decision someone has to make
 * in this file, next to the reason. Each root is a watcher and a blocking index walk at every
 * startup — see the check that uses this.
 */
export const MAX_REGISTERED_ROOTS = 16
import { isWithin, splitSegments } from '../core/paths'
import { registerRoot } from '../core/fs/registration'
import type { RegisteredRoot } from '../core/fs/containment'

export interface RootRegistry {
  readonly list: () => readonly RegisteredRoot[]
  readonly get: (id: string) => RegisteredRoot | undefined
  readonly register: (id: string, absolutePath: string) => Promise<Result<RegisteredRoot>>
  readonly deregister: (id: string) => Result<void>
}

export interface RootRegistryOptions {
  /**
   * The mutation log's absolute path, so a root that would contain it can be refused.
   *
   * Required rather than optional. An optional reserved path is one a bootstrap forgets to pass,
   * and the whole finding is that this check was skippable — the same reasoning that made
   * `funnelWatch` a required field on the tailnet listener.
   */
  readonly reservedPaths: readonly string[]
  /**
   * **The only areas of the disk a folder may be registered from.** The security review's C2, 2026-08-09.
   *
   * §11 calls registration *"the most powerful thing the app does — it's what decides how much of
   * your disk is in play."* Until P7 it was bounded by nothing except `/`, the overlap rule and the
   * reserved paths, and that was survivable only because nothing could reach it: the route was
   * `local-only`, and the client is served by the other listener. The operator's Settings ruling made it
   * reachable from every device on the tailnet, and the exposure arrived with it — measured,
   * `register('/private/etc')` succeeded, after which every file under it is readable and writable
   * through the ordinary routes.
   *
   * The distinct refusal codes made it a **whole-disk existence-and-type oracle** as well:
   * `INVALID_ROOT` for `/`, `PATH_SYMLINK` for `/etc`, `IO_FAILED` for a path that does not exist,
   * `NOT_REGULAR_FILE` for a file. `folders.browse` closed exactly this oracle with care; the verb
   * next to it never had the check.
   *
   * Bounded to the same area the folder picker browses — `$HOME` and `/Volumes` — because that is
   * where every folder the operator would register lives, and it is already the only place the UI can
   * offer. So this costs nothing a person can perceive and closes both problems at once.
   *
   * **Required, not optional**, for the reason `reservedPaths` gives directly above: an optional
   * boundary is one a bootstrap forgets to pass, and the whole finding here is that the check was
   * skippable. A caller that genuinely wants no bound says so with `[]`, visibly.
   */
  readonly browsableRoots: readonly string[]
  /**
   * **The same areas after `realpath`, and they are a separate field on purpose.**
   *
   * Stage one compares the caller's raw string against `browsableRoots` — it must, because its job
   * is to refuse before any syscall and so close the existence-and-type oracle. Stage three compares
   * where the candidate *resolves*, and a resolved path can only be judged against a resolved area:
   * on macOS `/var`, `/tmp` and `/etc` are symlinks, so an area given as `/var/x` and a candidate
   * resolving to `/private/var/x` are the same place spelled two ways.
   *
   * Comparing one resolved and one raw is how a correct-looking check refuses everything or nothing.
   */
  readonly browsableRootsResolved: readonly string[]
}

/** Whole-segment containment in either direction. Spec §5 — never a raw prefix comparison. */
function overlaps(a: readonly string[], b: readonly string[], caseInsensitive: boolean): boolean {
  return isWithin(a, b, caseInsensitive) || isWithin(b, a, caseInsensitive)
}

export function createRootRegistry(options: RootRegistryOptions): RootRegistry {
  const roots = new Map<string, RegisteredRoot>()

  return {
    list: () => [...roots.values()],
    get: id => roots.get(id),

    register: async (id: string, absolutePath: string): Promise<Result<RegisteredRoot>> => {
      if (roots.has(id)) {
        return fail(ErrorCode.ROOT_ALREADY_REGISTERED, 'a folder with this id is already registered')
      }

      /**
       * **THE BROWSABLE BOUND, STAGE ONE: THE STRING, BEFORE ANY SYSCALL.**
       *
       * the security review's C2. §11 calls registration *"the most powerful thing the app does — it's what
       * decides how much of your disk is in play."* Until P7 it was bounded by nothing but `/`, the
       * overlap rule and the reserved paths — survivable only while nothing could reach it, since
       * the route was `local-only` and the client is served by the other listener. The operator's
       * Settings ruling made it reachable from every device on the tailnet, and the security review measured the
       * result: `register('/private/etc')` succeeded.
       *
       * **Before the probe, and that is the whole of the second finding.** `registerRoot` answers
       * `PATH_SYMLINK` for `/etc`, `IO_FAILED` for a path that does not exist, `NOT_REGULAR_FILE`
       * for a file — so a bound applied *after* it leaves the verb a whole-disk existence-and-type
       * oracle, refusing every out-of-area path with a code that says what is there. One string
       * comparison first, one code for everything outside, nothing touched.
       *
       * This is `browse.ts`'s two-stage check, applied to the verb next to it. That module closed
       * exactly this oracle with care and wrote down why; the rule was then implemented in one
       * place. Case-sensitive here for its reason too: the per-volume probe has not run yet, and
       * comparing exactly errs toward refusing, which is the safe direction for a scope check.
       */
      const bounded = (segments: readonly string[], caseInsensitive: boolean): boolean =>
        options.browsableRoots.length === 0
        || options.browsableRoots.some(
          area => isWithin(splitSegments(area), segments, caseInsensitive),
        )
      const outsideTheArea = (): Result<never> =>
        fail(ErrorCode.PATH_ESCAPES_ROOT, 'that folder is outside the area this app may be pointed at')

      if (!bounded(splitSegments(absolutePath), false)) return outsideTheArea()

      // Registration runs the full §4 probe: absolute path, not a symlink, a real directory,
      // readable, case-sensitivity probed, volume identity recorded, cloud provider detected.
      const registered = await registerRoot(id, absolutePath)
      if (!registered.ok) return registered
      const root = registered.value

      const rootSegments = splitSegments(root.absolutePath)

      /**
       * **STAGE TWO, with the real case sensitivity, against the path as the probe recorded it.**
       *
       * The first stage compared the caller's string; this compares what registration actually
       * settled on, under the volume's own case rule. Both are needed for the same reason
       * `browse.ts` needs both — the first decides what the *answer* may reveal, the second decides
       * where the path actually goes.
       */
      if (!bounded(rootSegments, root.caseInsensitive)) return outsideTheArea()

      /**
       * **STAGE THREE — where the path RESOLVES, which is the only stage that was load-bearing.**
       *
       * Stages one and two both compare a *string*, and until 2026-09-01 they compared the **same**
       * string: `registerRoot` stores the caller's path verbatim, so two checks were being made
       * against one fact. Nothing anywhere resolved it.
       *
       * **The bypass that left open.** `registerRoot` `lstat`s only the final component, and
       * `walkAndVerify` starts *at* the root — so a symlinked **parent** was checked by nothing. A
       * caller passing `~/<link>/private/etc`, where `<link>` is any symlink under the home
       * directory pointing outside it, registered: the last component is a real directory, the
       * string sits inside the bound, and every read and write afterwards happens outside it. No
       * race — just a link the machine may already have, and `~/bin`, `~/tmp` and dotfile-manager
       * links are ordinary.
       *
       * **Resolve and re-scope rather than refuse a difference.** Refusing any symlinked ancestor
       * is the stricter rule and it is wrong here: on macOS `/var`, `/tmp` and `/etc` are themselves
       * symlinks, so ordinary paths would be refused for nothing. What matters is not whether a link
       * was traversed but whether the destination is still inside the area — which is the question
       * the bound was always asking, and the one `browse.ts` has answered this way since 2026-08-09.
       *
       * The path is still *stored* verbatim. Storing the resolved form would register a folder the
       * operator did not name, and the id, the displayed path and every config key keyed to it would
       * then describe somewhere else.
       */
      const boundedResolved = (segments: readonly string[]): boolean =>
        options.browsableRootsResolved.length === 0
        || options.browsableRootsResolved.some(
          area => isWithin(splitSegments(area), segments, root.caseInsensitive),
        )
      if (!boundedResolved(splitSegments(root.resolvedPath))) return outsideTheArea()

      // R2. The reserved paths are checked AFTER the probe, because `root.caseInsensitive` comes
      // from that probe and a containment comparison needs it — spec §4 is explicit that case
      // sensitivity is per-volume and never guessed globally.
      for (const reserved of options.reservedPaths) {
        if (overlaps(rootSegments, splitSegments(reserved), root.caseInsensitive)) {
          return fail(
            ErrorCode.PATH_ESCAPES_ROOT,
            'this folder contains, or sits inside, the app\'s own log storage',
          )
        }
      }

      // And against every root already registered. Spec §11 forbids overlapping roots, and an
      // overlap is not merely untidy: the same file would have two identities, two index entries,
      // and two watchers — which is how a change in one view fails to appear in the other.
      for (const existing of roots.values()) {
        const existingSegments = splitSegments(existing.absolutePath)
        const caseInsensitive = root.caseInsensitive || existing.caseInsensitive
        if (!overlaps(rootSegments, existingSegments, caseInsensitive)) continue

        /**
         * **The same folder, said as "the same folder".**
         *
         * A path is trivially an overlap with itself, so re-adding a folder that is already
         * registered fell out of this loop as `ROOT_OVERLAPS` — *"contains, or sits inside, one you
         * have already added"* — which is technically true and reads as nonsense about the folder
         * you just picked. It does not reach the id check above, because Settings derives a fresh
         * id (`notes`, then `notes-2`) rather than making a person invent one, so the ids differ
         * even when the path does not.
         *
         * Found end to end, by adding the same folder twice. Neither refusal was wrong; the one a
         * person got was the unhelpful one.
         */
        const same = isWithin(rootSegments, existingSegments, caseInsensitive)
          && isWithin(existingSegments, rootSegments, caseInsensitive)
        return same
          ? fail(ErrorCode.ROOT_ALREADY_REGISTERED, 'this folder is already registered')
          : fail(ErrorCode.ROOT_OVERLAPS, 'this folder overlaps a folder already registered')
      }

      /**
       * **§11's backup check used to run here, and it was CUT on 2026-08-09: "cut it".**
       *
       * It asked one question — is there a `.git` anywhere above this folder — and made the user
       * type a word if the answer was no. Two things were wrong with it, and the operator named both:
       *
       *   *"This is weird to me because I don't always back it up and I also run non-soil things in
       *   the viewer sometimes."*
       *
       * **It never checked whether anything was committed.** A repo with three days of uncommitted
       * work passed silently, so on the tree it was meant to protect it gave false comfort. And it
       * fired on every folder outside a repo, which for the operator is a routine case, so it charged
       * friction exactly where the risk was lowest.
       *
       * The deeper fault is the moment. "Is this folder in a repo" is a fact about the folder, true
       * forever once true; "is my work recoverable" is a fact about *right now* and changes on every
       * keystroke. A check that runs once at registration cannot answer the second, and it was
       * answering the first because that is the one that is cheap.
       *
       * What actually protects the files is unchanged and is not a dialog: the app never deletes,
       * writes atomically, verifies by content hash, and rescues an edit into a conflict artifact
       * rather than discarding it. Recovery beyond that is git, and no registration prompt was ever
       * going to supply it.
       */
      /**
       * **G5 — §11's cap of sixteen roots, implemented 2026-08-14.**
       *
       * the security review filed it Low-medium and framed it exactly right: *"cost, not containment."* Nothing
       * escapes by registering a seventeenth folder. But **each root costs a watcher and a blocking
       * index walk**, and both are paid at startup, every startup — so an unbounded registry is a
       * cold start that gets slower forever and a file-descriptor budget with no ceiling.
       *
       * §11 names the number and this is the first place it exists. Checked **last**, after every
       * refusal that tells you something about the folder itself: a person who picked a symlink
       * should hear about the symlink, not about a quota.
       *
       * The refusal names the number, because the only action it leaves is removing one — and
       * "you have too many" without a figure does not say how many too many.
       */
      if (roots.size >= MAX_REGISTERED_ROOTS) {
        return fail(
          ErrorCode.TOO_LARGE,
          `this app holds at most ${MAX_REGISTERED_ROOTS} folders; remove one before adding another`,
        )
      }

      roots.set(id, root)
      return ok(root)
    },

    deregister: (id: string): Result<void> => {
      if (!roots.delete(id)) return fail(ErrorCode.INVALID_ROOT, 'no folder with this id is registered')
      return ok(undefined)
    },
  }
}
