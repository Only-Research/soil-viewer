/**
 * The app's memory of itself, held in one place and written to disk. Spec §13.8.
 *
 * **Why this file exists at all: `config-store.ts` was complete, tested, mutation-swept, and
 * imported by nothing.** Registered folders lived in a `Map` and were gone when the process
 * stopped — the operator could add a folder, be told it worked, and find it forgotten after a restart.
 * The phase brief said item J was *"implemented here and verified end-to-end at P9"*, and P9 would
 * have been the first moment anyone noticed it was unreachable.
 *
 * Two files, never one — M7. See `config-store.ts`'s header for why that rule was already broken
 * in the module this wraps.
 *
 * **THE INVARIANT THAT SHAPES EVERY DECISION BELOW: a damaged file is never written over.**
 * §13.8 is explicit — *"a config that fails to parse is preserved and surfaced, never silently
 * replaced with defaults, which would deregister everything."* So damage is a state this service
 * carries and reports, not an error it recovers from. While a file is damaged:
 *
 *   - the in-memory copy stays empty, so nothing pretends the record was read;
 *   - **every write to that file is refused**, so the damaged bytes survive for a human to look at;
 *   - the app still starts, because "surfaced" requires something to surface it to.
 *
 * Refusing to start would also preserve the file, and it was rejected: an app that will not open
 * cannot tell the operator what is wrong with it, and the one thing worse than a lost folder list is a
 * lost folder list with no explanation.
 */

import { ErrorCode, fail, ok, type Result } from '../core/errors'
import { IndexStore } from '../core/index-store'
import { indexRegisteredRoot } from '../core/indexer'
import {
  EMPTY_REGISTRY,
  EMPTY_UI_STATE,
  markUnresolvedKeys,
  readConfig,
  validateRegistry,
  validateUiState,
  writeConfig,
  type RegistryFile,
  type UiStateFile,
} from '../core/fs/config-store'
import type { RootRegistry } from './root-registry'

export interface ConfigPaths {
  /** The folder registry. Written only by register and deregister. */
  readonly registryPath: string
  /** UI state. Rewritten often, and therefore a different file. */
  readonly uiStatePath: string
}

export interface ConfigService {
  /** A sentence when the file on disk could not be parsed, `null` when it is fine or absent. */
  readonly registryDamage: string | null
  readonly uiStateDamage: string | null
  readonly registry: () => RegistryFile
  readonly uiState: () => UiStateFile
  /** Applies a change and persists it. Serialized; refused while the file is damaged. */
  readonly updateRegistry: (change: (current: RegistryFile) => RegistryFile) => Promise<Result<null>>
  readonly updateUiState: (change: (current: UiStateFile) => UiStateFile) => Promise<Result<null>>
}

/**
 * Reads both files and returns the service. **Never fails**, by design — see the header.
 *
 * A file that is merely `missing` is first run, and defaults are correct. A file that is
 * `unreadable` leaves its half of the service damaged and read-only.
 */
export async function loadConfigService(paths: ConfigPaths): Promise<ConfigService> {
  const registryLoad = await readConfig(paths.registryPath, validateRegistry)
  const uiStateLoad = await readConfig(paths.uiStatePath, validateUiState)

  let registry = registryLoad.kind === 'loaded' ? registryLoad.config : EMPTY_REGISTRY
  let uiState = uiStateLoad.kind === 'loaded' ? uiStateLoad.config : EMPTY_UI_STATE

  const registryDamage = registryLoad.kind === 'unreadable' ? registryLoad.detail : null
  const uiStateDamage = uiStateLoad.kind === 'unreadable' ? uiStateLoad.detail : null

  /**
   * One promise chain for both files, and the reason is the same one that makes the mutation lock
   * exist: two concurrent updates that each read, change and write would interleave, and the second
   * write would land the first's stale copy. **That is M7's loss with no stale *copy* involved** —
   * just two callers racing — so the change function is applied inside the chain, against whatever
   * the state is by then, rather than against a value captured by the caller.
   *
   * One chain rather than one per file because a shared chain cannot deadlock and the write volume
   * here is measured in events per hour.
   */
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    // Swallowed on the queue only — the caller still receives the real result. Without this an
    // earlier rejection would poison every later update.
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    registryDamage,
    uiStateDamage,
    registry: () => registry,
    uiState: () => uiState,

    updateRegistry: change => serialize(async () => {
      if (registryDamage !== null) {
        return fail(ErrorCode.IO_FAILED, `the folder list on disk is damaged: ${registryDamage}`)
      }
      const next = change(registry)
      // A change function that hands back what it was given is saying nothing changed, and a write
      // of identical bytes is a rename over a file for no reason. See `updateUiState`.
      if (next === registry) return ok(null)
      const written = await writeConfig(paths.registryPath, next)
      // **Memory follows disk, never the other way round.** Updating first and writing second would
      // leave the app reporting folders that a failed write means it will not remember.
      if (!written.ok) return written
      registry = next
      return ok(null)
    }),

    updateUiState: change => serialize(async () => {
      if (uiStateDamage !== null) {
        return fail(ErrorCode.IO_FAILED, `the saved layout on disk is damaged: ${uiStateDamage}`)
      }
      const next = change(uiState)
      /**
       * **Identity means "nothing changed", and nothing changed means no write.**
       *
       * The startup unresolved-marking pass runs on every boot and usually finds nothing to mark.
       * Without this it would rewrite the layout file each time the app opened — putting an atomic
       * replace, and every failure mode that comes with one, on a file the app had no reason to
       * touch. Identity rather than deep equality because the change functions here are pure and
       * return their input when they decline to change it.
       */
      if (next === uiState) return ok(null)
      const written = await writeConfig(paths.uiStatePath, next)
      if (!written.ok) return written
      uiState = next
      return ok(null)
    }),
  }
}

/** What restoring the stored folders did. Reported rather than thrown — see below. */
export interface RestoreReport {
  readonly restored: readonly string[]
  readonly failed: readonly { readonly id: string; readonly reason: string }[]
  /**
   * Set when the unresolved-key pass could not be written — which a damaged layout file makes
   * certain, and which is not fatal because the registry is a different file.
   *
   * **Its own field rather than an entry in `failed`.** It went in there first, and bootstrap logs
   * every `failed` entry as *"folder X could not be restored and was KEPT in the registry"* — a
   * sentence that would have been simply false about the saved layout. A log line that misdescribes
   * what happened is worse than no log line, because it is the thing someone reads at 2am.
   */
  readonly layoutNotUpdated?: string
}

/**
 * Re-registers the folders from the last run, and indexes them.
 *
 * **A folder that fails to restore is kept in the file, not dropped.** This is §13.8's retained-not-
 * dropped rule applied to the registry rather than to path keys, and the case is the same one: an
 * external drive that is unplugged this morning is plugged in this afternoon. Deleting the entry
 * because the path did not resolve *once* would make an unplugged drive permanently erase the fact
 * that the operator ever registered anything on it.
 *
 * **The backup check is waived on restore, deliberately.** §11's check is a question asked at
 * registration and answered by a human typing through it; there is no human at startup, and no
 * prompt to show one. Re-asking it would mean silently refusing to restore every folder that is not
 * in a git repository — turning a safety warning into the data loss it exists to prevent. The
 * decision was already made, once, by the person entitled to make it.
 */
export async function restoreRegisteredRoots(
  config: ConfigService,
  registry: RootRegistry,
  index: IndexStore,
): Promise<RestoreReport> {
  const restored: string[] = []
  const failed: { id: string; reason: string }[] = []

  for (const stored of config.registry().roots) {
    const result = await registry.register(stored.id, stored.absolutePath)
    if (!result.ok) {
      failed.push({ id: stored.id, reason: result.detail ?? result.code })
      continue
    }
    await indexRegisteredRoot(result.value, index)
    restored.push(stored.id)
  }

  /**
   * §13.8's last clause, and it runs here because here is the only moment the answer is knowable:
   * every root that could be restored has been, and indexed, so the index can say whether a saved
   * key still points at anything.
   *
   * *"A config key whose path no longer resolves is **retained, not dropped**, and surfaced in
   * Settings as unresolved."* The build plan names the case that makes it matter: during the
   * copy-first trial week the operator's keys all point into the copy, and switching to the real tree
   * makes every one of them unresolved at once. A build that dropped them would discard a week of
   * arrangement in a single startup.
   *
   * **Written only when a mark actually changed.** An unconditional write on every boot would put
   * the registry's frequent-writer hazard on the UI-state file for no gain — and would rewrite a
   * file the app had no reason to touch.
   */
  const marked = await config.updateUiState(state => {
    const next = markUnresolvedKeys(
      state, (rootId, segments) => index.get(rootId, segments) !== undefined,
    )
    return next.pathKeys.every((key, i) => key === state.pathKeys[i]) ? state : next
  })

  return {
    restored,
    failed,
    ...(marked.ok ? {} : { layoutNotUpdated: marked.detail ?? marked.code }),
  }
}
