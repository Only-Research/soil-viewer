/**
 * The id a newly registered folder gets. §11, and Settings → Folders.
 *
 * **A registry id is not a display name and not a path.** It is the stable handle every wire
 * message uses to say which folder it means — `(rootId, segments)` is the app's only addressing
 * scheme (§6), and this is the `rootId` half. It therefore has to be: derived without asking the
 * person for one more thing they do not care about, readable enough to recognise in a log, and
 * **unique against what is already registered**, because `register` refuses a duplicate id with
 * `INVALID_ROOT` and the user would have no idea what they were being told.
 *
 * Derived from the folder's own last segment rather than its whole path. `~/work/notes` becomes
 * `notes`, not `users-hallberg-work-notes` — the path is already stored beside it, and an id
 * that repeats the path is a second copy of a fact that can drift from the first.
 *
 * Kept in its own module, pure, and tested directly, because the alternative is deriving it inline
 * at the one call site — which is how a rule ends up with no test that can see it.
 */

import { slugStem } from '../../core/slug'

/**
 * The last segment of an absolute POSIX path, or `''` if there is not one.
 *
 * Written here rather than reaching for `node:path`: this module is client-side, and `basename` is
 * not something a browser has. The convention this file follows was set after `slug.ts` shipped
 * `Buffer.byteLength` and froze the New File dialog — **a module the client imports may use only what both runtimes have.**
 */
function lastSegment(absolutePath: string): string {
  const parts = absolutePath.split('/').filter(part => part !== '')
  return parts[parts.length - 1] ?? ''
}

/**
 * A registry id for `absolutePath` that is not already in `taken`.
 *
 * Collisions get a numeric suffix — `notes`, then `notes-2` — rather than a random string,
 * so two folders with the same name stay legible to a person reading the config file. The
 * disambiguation matches annex A2's, which does the same job for duplicate filenames, because two
 * different answers to "how do we number a repeat" is two things to remember.
 *
 * Falls back to `folder` when the name slugifies to nothing at all — a folder named `…` is a real
 * thing on this tree, and §13.6's M16 guard exists because the empty answer used to be shipped as a
 * name. Here the empty answer would be an id of `''`, which every route would then fail to resolve.
 */
export function folderIdFor(absolutePath: string, taken: Iterable<string>): string {
  const existing = new Set(taken)
  const base = slugStem(lastSegment(absolutePath)) || 'folder'
  if (!existing.has(base)) return base

  // Starts at 2, so the pair reads `notes` and `notes-2` rather than `-1` and `-2`. Bounded
  // by the loop's own condition rather than a cap: `existing` is finite, so this terminates.
  let suffix = 2
  while (existing.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}
