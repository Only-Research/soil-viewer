/**
 * Folder registration. Spec §4 and §5.
 *
 * Registration is where the two facts the rest of the engine treats as given get *measured*:
 * whether the volume is case-insensitive, and which volume it actually is. Spec §4 is explicit
 * that case sensitivity is "probed once per root at registration and stored" — v1 said "define
 * case explicitly" twice and never defined it, which is circular.
 */

import { constants, promises as fsp } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { ErrorCode, fail, ok, type Result } from '../errors'
import { segmentErrorFor, segmentFault, splitSegments } from '../paths'
import type { RegisteredRoot } from './containment'

/** How the case-sensitivity answer was arrived at. Recorded so an inference is never mistaken
 *  for a measurement — spec §4 requires this be probed, not guessed. */
export type CaseProbeMethod = 'root-name-flip' | 'entry-name-flip' | 'assumed-platform-default'

export interface CaseProbeResult {
  readonly caseInsensitive: boolean
  readonly method: CaseProbeMethod
}

/**
 * macOS ships APFS case-insensitive by default. Used ONLY when both read-only probes are
 * inconclusive — which means a root whose own name and whose every entry name contain no
 * cased letters. Recorded as `assumed-platform-default` so the caller can surface it.
 */
const PLATFORM_DEFAULT_CASE_INSENSITIVE = true

function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

/** Returns a name with its case inverted, or null when it contains no cased letters. */
function flipCase(name: string): string | null {
  let flipped = ''
  let changed = false
  for (const char of name) {
    const upper = char.toUpperCase()
    const lower = char.toLowerCase()
    if (upper !== lower) {
      const isUpper = char === upper
      flipped += isUpper ? lower : upper
      changed = true
    } else {
      flipped += char
    }
  }
  return changed ? flipped : null
}

/**
 * True when `candidate` resolves to the same inode as `original`.
 * Read-only: `lstat` on both, compare `(dev, ino)`. Never writes into the user's tree.
 */
async function resolvesToSameInode(original: string, candidate: string): Promise<boolean | null> {
  try {
    const [a, b] = await Promise.all([
      fsp.lstat(original, { bigint: true }),
      fsp.lstat(candidate, { bigint: true }),
    ])
    return a.dev === b.dev && a.ino === b.ino
  } catch (error) {
    // ENOENT on the flipped name is a definitive answer: the volume is case-SENSITIVE.
    if (errnoOf(error) === 'ENOENT') return false
    return null // could not determine — never treated as either answer
  }
}

/**
 * Probes case sensitivity without writing anything.
 *
 * Two read-only attempts, in order of preference:
 * 1. Flip the case of the root's own final path segment and see whether it resolves to the
 *    same inode.
 * 2. Failing that (a root whose name has no cased letters), do the same with an entry inside.
 *
 * Deliberately no write-a-probe-file fallback: registration must not create files in a folder
 * the user just pointed at, and this app's entire promise is that it does not touch what it
 * was not asked to touch.
 */
export async function probeCaseInsensitive(absolutePath: string): Promise<Result<CaseProbeResult>> {
  const name = basename(absolutePath)
  const parent = dirname(absolutePath)

  const flippedRoot = flipCase(name)
  if (flippedRoot !== null) {
    const same = await resolvesToSameInode(absolutePath, join(parent, flippedRoot))
    if (same !== null) return ok({ caseInsensitive: same, method: 'root-name-flip' })
  }

  let entries: string[]
  try {
    entries = await fsp.readdir(absolutePath)
  } catch (error) {
    const code = errnoOf(error)
    // Spec §5 (M13) requires the permission probe to happen AT REGISTRATION, because a
    // background process meets EPERM on ~/Documents, ~/Desktop, iCloud and external volumes
    // with no prompt at all. Registering a folder is exactly when the operator is present to grant
    // it, so this must arrive as "permission needed" and not as a broken path.
    return fail(
      code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
      `readdir failed: ${code ?? 'unknown'}`,
    )
  }

  for (const entry of entries) {
    const flipped = flipCase(entry)
    if (flipped === null) continue
    const same = await resolvesToSameInode(join(absolutePath, entry), join(absolutePath, flipped))
    if (same !== null) return ok({ caseInsensitive: same, method: 'entry-name-flip' })
  }

  return ok({
    caseInsensitive: PLATFORM_DEFAULT_CASE_INSENSITIVE,
    method: 'assumed-platform-default',
  })
}

/**
 * Cloud-sync provider roots, by path. Spec §5 (M8): "detect provider roots at registration and
 * warn."
 *
 * Path matching is the only detection available at registration — the per-file signal
 * (`SF_DATALESS` in `st_flags`) is not exposed by Node, verified on 24.14.0. The walker
 * carries a second, per-file check (`size > 0` with `blocks === 0`) that catches placeholders
 * this list misses, so a provider we do not recognise still cannot be force-materialised.
 */
const CLOUD_PROVIDER_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['iCloud Drive', /\/Library\/Mobile Documents(\/|$)/],
  ['Dropbox', /\/Dropbox(\/|$)/],
  ['Google Drive', /\/Google Drive(\/|$)|\/GoogleDrive-[^/]*(\/|$)/],
  ['OneDrive', /\/OneDrive([^/]*)(\/|$)/],
  ['Box', /\/Box(\/|$)|\/Box Sync(\/|$)/],
  ['Sync.com', /\/Sync(\/|$)/],
]

/** Returns the provider's name when this path looks like it lives in a sync folder. */
export function detectCloudProvider(absolutePath: string): string | null {
  for (const [name, pattern] of CLOUD_PROVIDER_MARKERS) {
    if (pattern.test(absolutePath)) return name
  }
  return null
}

/**
 * Registers a folder: verifies it is a real directory, refuses a symlinked root, records its
 * volume identity, probes readability (the TCC check) and probes case sensitivity.
 *
 * A symlinked root is refused for the same reason a symlinked segment is (spec §4): the target
 * can be repointed after registration, and every containment check afterwards would be
 * measuring the wrong tree.
 *
 * **WHAT THIS DOES NOT YET DO — spec §11's registration rules are NOT implemented.** Added
 * 2026-08-06 after the Phase 1 fresh-eyes review (S2), which verified on disk that an outer
 * root and a descendant root both register, that the same path registers twice, and that a
 * root reached through a symlinked *ancestor* registers. Build-plan §11 places registration
 * itself at P2/P7 and only provider/volume detection in P1, so the omission is in scope — but
 * this function is named `registerRoot`, it returns the security-critical `RegisteredRoot`,
 * and a P2 builder would reasonably read the list above as the whole story. Still owed:
 *
 * - ~~**overlap refusal**~~ — **DONE, and this entry was stale. The security review's G8, closed 2026-08-13.**
 *   "Neither equal to, nor an ancestor of, nor a descendant of an existing root" (the F4.5 fix) is
 *   implemented at **`server/root-registry.ts`** — `overlaps()` and its caller. It is not in this
 *   file and was never going to be: registration is P2/P7's, and this function is the *filesystem*
 *   half. **The list was right that a P2 builder would read it as the whole story, and then it
 *   became the thing doing the misleading** — an unmaintained "not yet" is indistinguishable from a
 *   gap, and this one survived two phases past its own completion.
 * - ~~the deny set beyond `/`~~ — **DONE.** Reserved paths are refused in the same file, and P7
 *   bounded the browse scope to `$HOME` + `/Volumes` on the security review's finding.
 * - ~~the 16-root cap~~ — **DONE, and this entry was stale.** Implemented at `server/root-registry.ts`
 *   as `MAX_REGISTERED_ROOTS`, enforced on every registration. It read "still owed" long after it
 *   was owed, which is the state this same comment block warns about four lines up. Originally the security review's G5, and each root costs a watcher and a
 *   blocking index walk, so the cap is about cost rather than containment.
 * - dot-segment refusal
 * - ~~`realpath`, and refusal of a symlinked *ancestor*~~ — **CLOSED 2026-09-01.** This read as an
 *   accepted gap for three weeks: `walkAndVerify` `lstat`s every segment BELOW the root but never
 *   the root's own ancestry, so §11's "contain no symlinked segment" was unenforced for the root
 *   itself and a link under `$HOME` registered a root outside it. `registerRoot` now `realpath`s
 *   and refuses a difference. **An unmaintained "known gap" is indistinguishable from an unknown
 *   one**, which is the argument this same comment block makes four lines up about a different
 *   item — and then demonstrated.
 */
export async function registerRoot(id: string, absolutePath: string): Promise<Result<RegisteredRoot>> {
  // A relative root would resolve against the process's working directory, and every
  // containment comparison afterwards would be made against relative segments — which is not
  // a refusal, it is a wrong answer. Refuse rather than normalize.
  if (!isAbsolute(absolutePath)) {
    return fail(ErrorCode.INVALID_ROOT, 'a registered root must be an absolute path')
  }
  // A root of `/` has zero segments, and `isWithin([], anything)` is vacuously true — every
  // path on the machine would be "contained". Containment would still hold structurally, but
  // the wall would be doing nothing, and nothing in this app should ever be handed the volume.
  const rootSegments = splitSegments(absolutePath)
  if (rootSegments.length === 0) {
    return fail(ErrorCode.INVALID_ROOT, 'the filesystem root may not be registered')
  }

  /**
   * **G6 — the root's own segments go through §4's composition rules, like every other path.**
   *
   * security review, P7 review, 2026-08-09: *"A root path containing `..` registers and is stored verbatim;
   * every child then fails — silently bricked instead of refused."*
   *
   * **Nothing below this line would ever catch it, and that is the whole shape of the bug.** Every
   * other check here asks the *filesystem*, and the filesystem is perfectly happy: the kernel
   * resolves `..` before it answers, so `lstat` reports a real directory and `opendir` succeeds.
   * The path is then stored **verbatim**, and containment is decided afterwards by comparing whole
   * segments — §5 forbids `startsWith` on paths — so a root of `/a/b/../c` carries the literal
   * segment `..` into every comparison made against it. `walkAndVerify` refuses, correctly, and the
   * folder is bricked with nothing anywhere saying why.
   *
   * **It fails closed, which is why it is Low and not High** — nothing escapes containment. It is
   * still the failure this build refuses everywhere else: an operation that reports success and
   * leaves something that cannot work.
   *
   * The rule is not new and is not written here. `segmentFault` is the same function
   * `walkAndVerify` runs on every segment of every path the app composes; registration was simply
   * the one door that skipped it. A root is a path, so it goes through the same door.
   */
  for (const segment of rootSegments) {
    const fault = segmentFault(segment)
    if (fault !== null) {
      return fail(
        segmentErrorFor(fault),
        `a registered root may not contain a "${segment}" segment: ${fault}`,
      )
    }
  }

  let stat: Awaited<ReturnType<typeof fsp.lstat>> & { dev: bigint; ino: bigint; mode: bigint }
  try {
    stat = await fsp.lstat(absolutePath, { bigint: true })
  } catch (error) {
    // Same rule as everywhere else: EACCES/EPERM is a macOS privacy denial, not a broken path.
    // This line was missed when that defect was fixed in containment.ts, twenty lines above the
    // TCC probe that exists specifically to avoid it.
    const code = errnoOf(error)
    return fail(
      code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
      `cannot stat root: ${code ?? 'unknown'}`,
    )
  }

  const type = Number(stat.mode) & constants.S_IFMT
  if (type === constants.S_IFLNK) {
    return fail(ErrorCode.PATH_SYMLINK, 'a registered root may not be a symlink')
  }
  if (type !== constants.S_IFDIR) {
    return fail(ErrorCode.NOT_REGULAR_FILE, 'a registered root must be a directory')
  }

  // The TCC probe. Spec §5 (M13): a background process meets EPERM on ~/Documents, ~/Desktop,
  // iCloud and external volumes **with no prompt at all**, so the app must probe and enter a
  // named "permission needed" state. It has to be its own step: the case probe below answers
  // from the PARENT directory's inode and short-circuits before ever reading this folder, so a
  // root that cannot be listed was registering successfully and only failing later, during
  // indexing — long after the moment the operator was present to grant access.
  try {
    const handle = await fsp.opendir(absolutePath)
    await handle.close()
  } catch (error) {
    const code = errnoOf(error)
    return fail(
      code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
      `root is not readable: ${code ?? 'unknown'}`,
    )
  }

  const probe = await probeCaseInsensitive(absolutePath)
  if (!probe.ok) return probe

  /**
   * **Where the root actually goes.** `lstat` above refuses a symlink *as* the root, and
   * `walkAndVerify` refuses one anywhere *below* it — the root's own ancestry was checked by
   * nothing, and the note at the head of this file recorded that as an accepted gap for three
   * weeks. Resolved here, in the one layer permitted to touch the filesystem, and bounded by the
   * caller that knows what the permitted area is.
   */
  let resolvedPath: string
  try {
    resolvedPath = await fsp.realpath(absolutePath)
  } catch (error) {
    const code = errnoOf(error)
    return fail(
      code === 'EACCES' || code === 'EPERM' ? ErrorCode.PERMISSION_DENIED : ErrorCode.IO_FAILED,
      `cannot resolve root: ${code ?? 'unknown'}`,
    )
  }

  return ok({
    id,
    absolutePath,
    resolvedPath,
    caseInsensitive: probe.value.caseInsensitive,
    dev: stat.dev,
    rootIno: stat.ino,
  })
}
