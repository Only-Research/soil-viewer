/**
 * The staging area, and **the only recursive removal in this codebase**. Spec §13.7.
 *
 * Core layer: no HTTP, no browser, no third-party code.
 *
 * §13.7 requires a recursive copy that "fails and leaves nothing behind" — while v1's wording for
 * that required exactly the recursive-remove function the no-delete law forbids. The resolution:
 *
 *   *"Stage into a temp directory outside every registered folder on the same filesystem, then a
 *   single exclusive rename into place on success. The staging area is app scratch and is **the
 *   only place in the codebase where recursive removal exists** — and it MUST refuse to operate
 *   inside a registered folder."*
 *
 * So a half-finished copy is abandoned by deleting a scratch directory the app itself created, and
 * a user's folder is never partially written and never removed.
 *
 * **This file is separate from the copy engine deliberately.** It holds one dangerous function and
 * the guards that make it safe, so the guards can be read, reviewed and attacked on their own
 * rather than found in the middle of a hundred lines of walking logic. If any single function in
 * this build reproduces the original disaster, it is this one.
 */

import { promises as fsp } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { isWithin, splitSegments } from '../paths'
import { type RegisteredRoot } from './containment'

/**
 * Validates a candidate staging directory against every registered root.
 *
 * Called once at startup and again before every removal — cheap, and the set of roots changes at
 * runtime, so validating only at startup would let a folder registered later swallow the staging
 * area. That is precisely the shape of P2's R2 finding, where a mutation log validated its
 * containment once and then wrote inside a root registered afterwards.
 *
 * The rules are positive and structural, not a deny-list:
 *
 *   - absolute (a relative path resolves against the working directory, which is not ours to know)
 *   - not equal to, inside, or containing **any** registered root
 *
 * The "containing" direction matters as much as the other: a staging area at `/Users/hallberg`
 * would be outside no root while having every root inside it, and the removal would take the lot.
 */
export function checkStagingArea(
  stagingRoot: string,
  roots: readonly RegisteredRoot[],
): Result<null> {
  if (!isAbsolute(stagingRoot)) {
    return fail(ErrorCode.INVALID_ROOT, 'the staging area must be an absolute path')
  }
  const staging = splitSegments(stagingRoot)
  if (staging.length === 0) {
    return fail(ErrorCode.INVALID_ROOT, 'the filesystem root may not be a staging area')
  }

  for (const root of roots) {
    const rootSegments = splitSegments(root.absolutePath)
    // Whole-segment comparison in both directions — never a raw string prefix. §5's rule: `/soil`
    // must not match `/soil-old`, and being sloppy here in the permissive direction is what would
    // let a recursive removal run inside a registered folder.
    if (isWithin(rootSegments, staging, root.caseInsensitive)) {
      return fail(ErrorCode.INVALID_ROOT, `the staging area is inside registered root ${root.id}`)
    }
    if (isWithin(staging, rootSegments, root.caseInsensitive)) {
      return fail(ErrorCode.INVALID_ROOT, `registered root ${root.id} is inside the staging area`)
    }
  }
  return ok(null)
}

/**
 * Removes a staged tree, recursively. **The one place in this codebase that does this.**
 *
 * Every guard below has to hold before a single byte is unlinked, and they are checked in this
 * order because each is cheaper and broader than the next:
 *
 *   1. the staging area is still valid against the CURRENT roots (re-checked, not trusted)
 *   2. the target is strictly *inside* the staging area — not equal to it, so a bug that passes an
 *      empty suffix cannot wipe the staging area itself and everything else staged in it
 *   3. the target is inside no registered root, checked independently of (1) rather than inferred
 *      from it, because two guards that share one derivation are one guard
 *   4. the target is a real directory reached without following a symlink — a staged path that
 *      became a symlink would otherwise have `rm -r` follow it out of the staging area entirely
 *
 * The redundancy in (3) is deliberate. Everywhere else in this build a check that cannot
 * independently fire has been deleted for being decorative; here the cost of being wrong is
 * unbounded and irreversible, so the second derivation stays and is tested on its own.
 */
export async function removeStagedTree(
  target: string,
  stagingRoot: string,
  roots: readonly RegisteredRoot[],
): Promise<Result<null>> {
  const areaOk = checkStagingArea(stagingRoot, roots)
  if (!areaOk.ok) return areaOk

  /**
   * **Redundant by construction, kept deliberately, and the sweep says so.** `stagingRoot` is
   * absolute (checked above), so a relative `target` cannot be strictly inside it and the
   * containment test below refuses it anyway — deleting this line changes no test.
   *
   * It stays because the cost of being wrong in this function is unbounded and irreversible, and
   * because it fails for the *right reason*: a relative path here means a caller lost track of
   * what it was handling, which is worth refusing by name rather than by side effect. Everywhere
   * else in this build a check that cannot independently fire has been removed as decorative; this
   * file is the stated exception.
   */
  if (!isAbsolute(target)) {
    return fail(ErrorCode.INVALID_ROOT, 'refusing to remove a relative path')
  }

  const targetSegments = splitSegments(target)
  const stagingSegments = splitSegments(stagingRoot)

  // STRICTLY inside: `isWithin` treats equal paths as contained, which is right for containment
  // and wrong here. Removing the staging area itself would take every other in-flight copy with
  // it, and an off-by-one that produces the staging path exactly is a plausible bug.
  const inside = isWithin(stagingSegments, targetSegments, false)
  if (!inside || targetSegments.length <= stagingSegments.length) {
    return fail(ErrorCode.INVALID_ROOT, 'refusing to remove anything outside the staging area')
  }

  /**
   * **Unreachable if `checkStagingArea` is correct, and that is exactly why it is here.**
   *
   * If the staging area overlaps no root, and the target is strictly inside the staging area, then
   * the target is inside no root — so no test can make this fire, and the sweep reports it
   * undefended. It is not defending against a caller; it is defending against `checkStagingArea`
   * or `isWithin` being wrong.
   *
   * Kept on the same reasoning as the check above: this is the only recursive delete in the
   * codebase, the previous version of this app destroyed 1,610 files, and a guard whose cost is
   * one loop over at most sixteen roots is not worth trading for tidiness.
   */
  for (const root of roots) {
    const rootSegments = splitSegments(root.absolutePath)
    if (isWithin(rootSegments, targetSegments, root.caseInsensitive)) {
      return fail(ErrorCode.INVALID_ROOT, `refusing to remove inside registered root ${root.id}`)
    }
  }

  let stat
  try {
    stat = await fsp.lstat(target)
  } catch {
    // Already gone is success: this is cleanup, and a cleanup that fails because there was nothing
    // to clean would turn every successful copy into a reported error.
    return ok(null)
  }
  /**
   * Anything that is not a directory — including a symlink — is unlinked, never recursed into.
   *
   * **A correction to what an earlier version of this comment claimed.** It said `lstat` above was
   * "the load-bearing part", preventing a recursive delete from following a staged path that had
   * been replaced by a symlink into a registered root. The sweep showed both the `lstat` and this
   * branch to be undefended, so the claim was measured directly: **`fs.rm({recursive: true})` does
   * not follow symlinks.** Pointed at a link to a directory it removes the link and leaves the
   * target's contents untouched — verified on this machine.
   *
   * So the real protection there is `fs.rm`'s own behaviour. `lstat` and this branch classify
   * without resolving and reach the same outcome by a shorter route; neither can be shown to fire
   * on its own, and neither should be described as the guard. Kept for the reason the rest of this
   * file keeps its redundancy, and described accurately so nobody later removes `fs.rm`'s role by
   * trusting ours.
   *
   * A separate `isSymbolicLink()` branch also stood here and did exactly what this line does.
   * Merged rather than left as two branches implying two decisions.
   */
  if (!stat.isDirectory()) {
    await fsp.unlink(target).catch(() => { /* best effort; nothing was followed */ })
    return ok(null)
  }

  try {
    await fsp.rm(target, { recursive: true, force: true })
    return ok(null)
  } catch (error) {
    return fail(ErrorCode.IO_FAILED, `could not remove the staged tree: ${String(error)}`)
  }
}

/**
 * Creates a fresh, uniquely named directory inside the staging area.
 *
 * `mkdtemp` rather than a name we compose: it is the kernel's exclusive create, so two copies
 * running at once cannot land in the same place, and the name cannot be predicted and pre-created
 * as a symlink by something else on the machine.
 */
export async function makeStagingDirectory(
  stagingRoot: string,
  roots: readonly RegisteredRoot[],
): Promise<Result<string>> {
  const areaOk = checkStagingArea(stagingRoot, roots)
  if (!areaOk.ok) return areaOk

  try {
    await fsp.mkdir(stagingRoot, { recursive: true })
    return ok(await fsp.mkdtemp(`${stagingRoot}${sep}copy-`))
  } catch (error) {
    return fail(ErrorCode.IO_FAILED, `could not create a staging directory: ${String(error)}`)
  }
}

/**
 * The name of the scratch directory placed on a volume that is not the app's own.
 *
 * Leading dot so it is hidden, and named for the app so a person finding it on an external drive
 * can tell what put it there and that removing it is safe.
 */
export const VOLUME_SCRATCH_NAME = '.soil-viewer-scratch'

/**
 * The device id a path sits on. `stat`, not `lstat` — the question is which volume the *target*
 * lives on, and a symlink's own device says nothing about that.
 */
async function deviceOf(absolutePath: string): Promise<Result<bigint>> {
  try {
    const stat = await fsp.stat(absolutePath, { bigint: true })
    return ok(stat.dev)
  } catch (error) {
    return fail(ErrorCode.IO_FAILED, `could not stat ${absolutePath}: ${String(error)}`)
  }
}

/**
 * The device of the nearest ancestor that exists.
 *
 * The app's scratch path may be several levels of not-yet-created directory deep — on first run
 * `~/Library/Application Support/SoilViewer/scratch` has two missing levels. An earlier version
 * checked the path and then its immediate parent only, and a test caught it: with both missing it
 * fell through to the other-volume branch and proposed a scratch directory **at the filesystem
 * root**. Walking up until something exists is the general answer.
 */
async function deviceOfNearestExisting(absolutePath: string): Promise<Result<bigint>> {
  let current = absolutePath
  for (let depth = 0; depth < 256; depth++) {
    const device = await deviceOf(current)
    if (device.ok) return device
    const parent = dirname(current)
    if (parent === current) return fail(ErrorCode.IO_FAILED, 'no existing ancestor could be stat-ed')
    current = parent
  }
  return fail(ErrorCode.IO_FAILED, 'gave up looking for an existing ancestor')
}

/**
 * Walks upward until the device id changes — that boundary is the volume's mount point.
 *
 * There is no Node API for "which volume is this on", and parsing `/Volumes/...` out of the path
 * would be a string heuristic that breaks on a volume mounted anywhere else. The device id is what
 * the kernel actually uses, and it is the same `(dev, ino)` identity §4 relies on everywhere else.
 */
export async function findMountPoint(absolutePath: string): Promise<Result<string>> {
  const start = await deviceOf(absolutePath)
  if (!start.ok) return start

  let current = absolutePath
  // Bounded for the same reason the git walk is: `dirname('/')` is `'/'`, and a loop whose exit
  // depends on that identity hangs rather than fails if the assumption is ever wrong.
  for (let depth = 0; depth < 256; depth++) {
    const parent = dirname(current)
    if (parent === current) return ok(current)
    const parentDevice = await deviceOf(parent)
    // A parent we cannot stat is treated as a boundary. Guessing further up would mean placing
    // scratch somewhere unverified, and refusing outright would break a copy for a reason the user
    // cannot act on.
    if (!parentDevice.ok || parentDevice.value !== start.value) return ok(current)
    current = parent
  }
  return ok(current)
}

/**
 * Picks the staging area for one copy: the app's own scratch when it is on the right volume, and a
 * scratch directory on the destination's volume when it is not.
 *
 * **Why this is per-volume rather than one fixed location.** The final step of a copy is a move,
 * and a move is only instant *within* one volume. Across volumes the kernel refuses it (`EXDEV`)
 * and the only way through would be copy-then-delete — which is a delete, and this build does not
 * have one of those outside `removeStagedTree`.
 *
 * the operator, asked directly on 2026-08-08 whether they would ever register a folder on an external
 * drive, answered that they are **not sure and it might change**. So this is built now rather than
 * guessed away: retrofitting per-volume staging later means changing the copy engine's shape after
 * things depend on it.
 *
 * **Placing scratch on someone else's drive is a real side effect**, so it is named for the app and
 * hidden, and it goes through exactly the same `checkStagingArea` guards as the app's own — if the
 * user has registered the whole volume, the copy is refused rather than staged inside a root.
 *
 * **The cross-volume branch is UNPROVEN by the test suite**, and recorded as such rather than
 * counted. Reaching it needs a genuine second volume mounted, which means changing the machine's
 * state, and the sandbox refuses it. What is tested: the same-volume path, the first-run case where
 * the scratch path does not exist yet, the refusal when the preferred area overlaps a root, the
 * mount-point walk on the boot volume, and the filesystem-root guard. What is not: an actual copy
 * staged onto an external drive. It should be exercised by hand the first time the operator registers a
 * folder on one.
 */
export async function resolveStagingArea(
  preferredStagingRoot: string,
  destinationParent: string,
  roots: readonly RegisteredRoot[],
): Promise<Result<string>> {
  const destinationDevice = await deviceOf(destinationParent)
  if (!destinationDevice.ok) return destinationDevice

  const preferredDevice = await deviceOfNearestExisting(preferredStagingRoot)
  if (preferredDevice.ok && preferredDevice.value === destinationDevice.value) {
    const usable = checkStagingArea(preferredStagingRoot, roots)
    if (!usable.ok) return usable
    return ok(preferredStagingRoot)
  }

  const mountPoint = await findMountPoint(destinationParent)
  if (!mountPoint.ok) return mountPoint

  /**
   * **Never the filesystem root**, and this guard exists because a test found the path to it.
   *
   * Reaching here means the app's own scratch is on a different volume from the destination. On a
   * destination that is on the *boot* volume, the mount point is `/` — so a misconfigured scratch
   * location would have this function propose creating a directory at the root of the disk. macOS
   * would very likely refuse it, but "the operating system probably stops us" is not a design.
   *
   * A boot-volume destination whose scratch is elsewhere is a configuration error, and it should
   * say so rather than quietly relocate itself somewhere drastic.
   */
  if (splitSegments(mountPoint.value).length === 0) {
    return fail(
      ErrorCode.INVALID_ROOT,
      'the configured scratch area is not on the same volume as the destination, and the ' +
      'filesystem root will not be used as one',
    )
  }

  const onVolume = join(mountPoint.value, VOLUME_SCRATCH_NAME)
  const usable = checkStagingArea(onVolume, roots)
  if (!usable.ok) {
    return fail(
      ErrorCode.INVALID_ROOT,
      `the destination is on another volume and its scratch area (${onVolume}) is not usable: ` +
      `${usable.detail ?? 'refused'}`,
    )
  }
  return ok(onVolume)
}
