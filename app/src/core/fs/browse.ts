/**
 * The folder browser behind Settings → Folders. Spec §11.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * **This is the most dangerous route in Phase 7, and §11 says why in one line:**
 *
 *   *"The folder-browser enumeration API is **equally privileged** (F6.3 — v1 gated *registration*
 *   and left *browsing* arguably open, which is a whole-disk read oracle)."*
 *
 * Registration is obviously powerful, so it was obviously gated. Browsing looks like a convenience
 * beside it — a file picker — and a file picker that answers "what directories exist at this path"
 * for any path is a way to map someone's entire disk one request at a time. It never reads a file,
 * which is exactly why it does not look like a read.
 *
 * ## The scope is a positive rule, not a deny-list
 *
 * §11 on registration: *"Positive structural rules, not a deny-list (F4.5 — a deny-list loses,
 * because `/Users`, `~/Library` and `~/Documents` are not 'system directories')."* The same
 * reasoning applies with more force here, so browsing is confined to two places:
 *
 *   - **the user's own home directory**, which is where the folders worth registering live, and
 *   - **`/Volumes`**, because the operator answered *"not sure, it might change"* when asked whether they
 *     would register a folder on an external drive, so the general case was built rather than the
 *     guess (`open-items.md`, A4).
 *
 * Everything else is refused. That includes `/System`, `/private`, another user's home, and the
 * volume root — not because each was thought of and listed, but because none of them is one of the
 * two places above. A rule shaped this way cannot be defeated by naming a directory nobody
 * anticipated, which is the failure mode a deny-list has by construction.
 *
 * **Scoped twice: once on the string, once on the `realpath`.** Both are load-bearing and they
 * defend different things. The string check runs before any syscall, so an out-of-scope path is
 * refused without the filesystem being consulted at all — otherwise the *error code* becomes the
 * oracle, answering "no such directory" for a path that does not exist and "outside the scope" for
 * one that does. The `realpath` check catches the other direction: a symlink the caller planted in
 * their own home is in scope as a string and may resolve anywhere.
 *
 * Written the obvious way first — resolve, then scope — and a test in this module's own suite
 * found the existence oracle. Recorded here rather than quietly fixed, because "the leak was in
 * which error came back" is a shape worth recognising again.
 *
 * ## What it hands back
 *
 * **Directory names only.** No files, no sizes, no mtimes, no contents. §11's phrasing is
 * *"Directory names only"*, and the reduction is doing real work: the caller is choosing a folder
 * to register, and a listing of filenames in `~/Documents` is precisely the disk map this route
 * must not become.
 *
 * **Symlinks are neither listed nor followed.** A symlinked directory inside an allowed scope can
 * point anywhere, so reporting it would hand back a doorway out of the scope, and following it
 * would walk through one. `lstat` decides, never `stat`.
 *
 * **§3's ignore list is applied**, so dot-directories, `node_modules` and `.app` bundles are
 * omitted. Noise for someone choosing a workspace folder, and Finder hides the same things. Not a
 * security control — a caller can still name one directly, and registration applies its own rules
 * — so it is not written here as though it were one. Reusing §3's predicate rather than testing
 * for a leading dot keeps one answer to "is this segment worth showing" across the whole app.
 */

import { promises as fsp } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isIgnoredSegment } from '../grammar'
import { isWithin, splitSegments } from '../paths'
import { errnoOf } from './containment'

/** One directory the caller may descend into. */
export interface BrowseEntry {
  readonly name: string
  readonly path: string
}

export interface BrowseListing {
  /** The resolved path actually listed — never the string that arrived. */
  readonly path: string
  /** Where "up" goes, or `null` at the edge of the allowed scope. */
  readonly parent: string | null
  readonly directories: readonly BrowseEntry[]
}

/**
 * Where browsing is allowed to look. Injected rather than read from `node:os` here, because the
 * home directory is an environment fact and Core does not read the environment — the same reason
 * the clock and the random source are injected elsewhere in this layer.
 */
export interface BrowseScope {
  readonly home: string
  /** `/Volumes` on macOS. Named rather than hardcoded so a test can point it somewhere writable. */
  readonly volumes: string
}

/**
 * True when `candidate` is `boundary` itself or sits underneath it.
 *
 * **Whole segments, via §5's shared helper — never a string prefix.** The first version of this
 * function hand-rolled the comparison with `startsWith` plus a separator, and the lint rule caught
 * it, correctly: §5 forbids raw `startsWith` on paths because *"it was a real bug in the lab code
 * that the master audit missed"* — `/soil/notes` is a string prefix of `/soil/notes-old` without
 * being inside it. The hand-rolled version happened to append the separator and so happened to be
 * right, which is the worst kind of correct: a second implementation of a rule that exists to have
 * exactly one, sitting one careless edit away from the bug it was imitating.
 *
 * **Case-sensitive comparison, deliberately.** The volume's case-folding is probed per registered
 * root (§4) and there is no root here — browsing happens outside every one of them. Comparing
 * exactly errs toward refusing, which is the safe direction for a scope check, and costs nothing
 * in practice: the paths the client sends are paths this route handed it, and `realpath` returns
 * the filesystem's own casing.
 */
function isUnder(candidate: string, boundary: string): boolean {
  return isWithin(splitSegments(boundary), splitSegments(candidate), false)
}

/** The two allowed roots, in the order the caller should offer them. */
export function browseRoots(scope: BrowseScope): readonly string[] {
  return [scope.home, scope.volumes]
}

/**
 * Resolves an absolute path and proves it is inside the browsable area — **the whole of §11's
 * scope rule, in one place, because there is now more than one caller.**
 *
 * Extracted 2026-08-09 when a second caller — `folders.inspect` — needed the same scoping. That
 * route was cut hours later with the backup check it served, so there is one caller again and this
 * is **not exported**: an exported helper with no consumer outside its own module is the shape this
 * build keeps finding, and the argument for keeping it separate now is readability alone.
 *
 * **THE SCOPE IS CHECKED TWICE, and the first check is the one that closes the oracle.**
 *
 * Written the obvious way first — resolve, then scope — and a test caught it: an out-of-scope path
 * that *exists* refused with `PATH_ESCAPES_ROOT`, and one that does not exist refused with
 * `IO_FAILED`, because `realpath` failed `ENOENT` before the scope was ever consulted. Two
 * different answers is an existence oracle for **every path on the disk**, from a route that never
 * reads a file — precisely the shape F6.3 warns about, arriving through the error codes rather than
 * through the data.
 *
 * So the input string is scoped **before anything touches the filesystem**. An out-of-scope path is
 * refused without a syscall, so there is nothing for its answer to depend on.
 *
 * The second check, after `realpath`, is the one that catches a symlink: a link the caller planted
 * in their own home is in scope as a string and may resolve anywhere. Both are needed — the first
 * for what the answer reveals, the second for where the path actually goes.
 */
async function resolveWithinScope(
  absolutePath: string,
  scope: BrowseScope,
): Promise<Result<string>> {
  if (!isAbsolute(absolutePath)) {
    return fail(ErrorCode.INVALID_ROOT, 'a browse path must be absolute')
  }
  /**
   * Dot-segments refused outright rather than normalised away. §11 requires the refusal, and
   * normalising would mean the path the caller named and the path we listed could differ without
   * anyone saying so — which is how `~/../otheruser` becomes a successful request.
   */
  if (resolve(absolutePath) !== absolutePath) {
    return fail(ErrorCode.PATH_TRAVERSAL, 'a browse path may not contain . or .. segments')
  }

  const roots = browseRoots(scope)
  const outside = (): Result<never> =>
    fail(ErrorCode.PATH_ESCAPES_ROOT, 'that folder is outside the browsable area')

  if (!roots.some(root => isUnder(absolutePath, root))) return outside()

  let resolved: string
  try {
    resolved = await fsp.realpath(absolutePath)
  } catch (error) {
    const code = errnoOf(error)
    return fail(
      code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
      `cannot resolve that path: ${code ?? 'unknown'}`,
    )
  }

  if (!roots.some(root => isUnder(resolved, root))) return outside()
  return ok(resolved)
}

/**
 * `realpath`, exposed so a caller outside `core/fs` can resolve a path without importing `node:fs`
 * — the import partition forbids that, and forbidding it is the point.
 *
 * Returns the input unchanged when it cannot be resolved. That is deliberate for its one caller: a
 * **scope boundary** that fails to resolve must not silently widen. Comparing an unresolved area
 * against a resolved candidate refuses, which is the safe direction.
 */
export async function realPathOf(absolutePath: string): Promise<string> {
  try {
    return await fsp.realpath(absolutePath)
  } catch {
    return absolutePath
  }
}

export async function browseDirectories(
  absolutePath: string,
  scope: BrowseScope,
): Promise<Result<BrowseListing>> {
  const within = await resolveWithinScope(absolutePath, scope)
  if (!within.ok) return within
  const resolved = within.value

  let entries
  try {
    entries = await fsp.readdir(resolved, { withFileTypes: true })
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOTDIR') return fail(ErrorCode.NOT_REGULAR_FILE, 'that is not a folder')
    return fail(
      code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
      `cannot list that folder: ${code ?? 'unknown'}`,
    )
  }

  const directories = entries
    // `isDirectory()` on a Dirent is `lstat`-based, so a symlinked directory reports `false` here
    // and is dropped rather than followed. Verified by test, because the opposite would be a
    // one-line way out of the scope above.
    .filter(entry => entry.isDirectory() && !isIgnoredSegment(entry.name))
    .map(entry => ({ name: entry.name, path: join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  /**
   * `parent` is `null` at an allowed root, so the caller cannot walk out of the scope by following
   * its own "up" affordance. The refusal above would catch it anyway; this stops the UI offering a
   * button whose only outcome is an error.
   */
  const atARoot = browseRoots(scope).some(root => resolved === root)
  const parent = atARoot ? null : join(resolved, '..')

  return ok({ path: resolved, parent, directories })
}
