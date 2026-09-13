/**
 * The in-memory index. Spec §5.
 *
 * **What this is authoritative for: display, and nothing else.** Spec §5 is explicit —
 * "The index is authoritative for display only. Disk is authoritative for every write
 * decision." No write ever consults an index mtime. That single sentence is what keeps
 * "never overwrite an external edit" from failing open after a dropped watcher event, so
 * nothing in this file may be used to decide whether a write is safe.
 *
 * **What it holds:** path, title, mtime, size and `(dev, ino)` — never file bodies (§5's
 * budget). At the 10,000-markdown / 50,000-file scale target, bodies would be hundreds of
 * megabytes of resident memory for data that is re-read on open anyway.
 *
 * Updates are incremental only: a change to one file updates that file's entry. There is no
 * routine full rebuild — bounded per-subtree reconciliation is the recovery path, and it
 * lives in the indexer rather than here.
 */

import { comparisonKey, isWithin } from './paths'
import type { EntryKind } from './fs/containment'

/** One row. Immutable — an update replaces the entry rather than mutating it, so a consumer
 *  holding a reference cannot observe a half-applied change. */
export interface IndexEntry {
  readonly rootId: string
  readonly segments: readonly string[]
  readonly name: string
  readonly kind: EntryKind
  /** First heading, or the filename. Display only. */
  readonly title: string
  readonly size: number
  readonly mtimeNs: bigint
  /** Spec §4: file identity is `(dev, ino)` from a descriptor, never a path string. */
  readonly dev: bigint
  readonly ino: bigint
  readonly isMarkdown: boolean
  /** True when the body could not be read to find a title — a cloud placeholder that was
   *  deliberately not materialised, or a permission failure. Spec §5: never an empty document. */
  readonly contentUnavailable: boolean
}

/** Uniquely names a row across roots. Case/NFC folding is applied per the root's own probe. */
export function entryKey(rootId: string, segments: readonly string[], caseInsensitive: boolean): string {
  return `${rootId}\u0000${comparisonKey(segments, caseInsensitive)}`
}

/** The `(dev, ino)` identity key. Spec §4 — two names for one inode must collide here. */
export function inodeKey(dev: bigint, ino: bigint): string {
  return `${dev}:${ino}`
}

export class IndexStore {
  readonly #entries = new Map<string, IndexEntry>()
  /** parent key → child keys. Maintained so a tree render is a lookup, not a scan of 50,000. */
  readonly #children = new Map<string, Set<string>>()
  /** `(dev, ino)` → entry key. Lets a move be recognised as the same file under a new name. */
  readonly #byInode = new Map<string, string>()
  readonly #caseInsensitiveByRoot = new Map<string, boolean>()

  registerRootCasing(rootId: string, caseInsensitive: boolean): void {
    this.#caseInsensitiveByRoot.set(rootId, caseInsensitive)
  }

  #casing(rootId: string): boolean {
    // Default to case-insensitive when a root is unknown: on this platform that is the common
    // case, and folding too much produces a lookup miss, whereas folding too little produces
    // two rows for one file and hides one of them behind the other.
    return this.#caseInsensitiveByRoot.get(rootId) ?? true
  }

  keyFor(rootId: string, segments: readonly string[]): string {
    return entryKey(rootId, segments, this.#casing(rootId))
  }

  get size(): number {
    return this.#entries.size
  }

  get(rootId: string, segments: readonly string[]): IndexEntry | undefined {
    return this.#entries.get(this.keyFor(rootId, segments))
  }

  getByKey(key: string): IndexEntry | undefined {
    return this.#entries.get(key)
  }

  /** The entry currently believed to hold this inode, if any. Spec §4's identity, not a path. */
  getByInode(dev: bigint, ino: bigint): IndexEntry | undefined {
    const key = this.#byInode.get(inodeKey(dev, ino))
    return key === undefined ? undefined : this.#entries.get(key)
  }

  /**
   * Inserts or replaces one entry. Incremental by construction: nothing else is touched.
   * Returns the previous entry when this replaced one.
   */
  upsert(entry: IndexEntry): IndexEntry | undefined {
    const key = this.keyFor(entry.rootId, entry.segments)
    const previous = this.#entries.get(key)

    if (previous !== undefined) {
      const previousInode = inodeKey(previous.dev, previous.ino)
      // Only drop the old inode mapping if it still points here. A move can have already
      // re-pointed it at the new path, and clobbering that would lose the identity.
      if (this.#byInode.get(previousInode) === key) this.#byInode.delete(previousInode)
    } else {
      this.#linkToParent(key, entry)
    }

    this.#entries.set(key, entry)
    this.#byInode.set(inodeKey(entry.dev, entry.ino), key)
    return previous
  }

  /** Removes one entry and its subtree membership. Returns what was removed. */
  remove(rootId: string, segments: readonly string[]): IndexEntry | undefined {
    const key = this.keyFor(rootId, segments)
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined

    this.#entries.delete(key)
    const inode = inodeKey(entry.dev, entry.ino)
    if (this.#byInode.get(inode) === key) this.#byInode.delete(inode)

    const parentKey = this.keyFor(rootId, entry.segments.slice(0, -1))
    this.#children.get(parentKey)?.delete(key)
    this.#children.delete(key)
    return entry
  }

  #linkToParent(key: string, entry: IndexEntry): void {
    if (entry.segments.length === 0) return
    const parentKey = this.keyFor(entry.rootId, entry.segments.slice(0, -1))
    const set = this.#children.get(parentKey)
    if (set === undefined) this.#children.set(parentKey, new Set([key]))
    else set.add(key)
  }

  /** Immediate children of a directory. A lookup rather than a scan — this is what makes the
   *  tree render at 50,000 files. */
  childrenOf(rootId: string, segments: readonly string[]): IndexEntry[] {
    const keys = this.#children.get(this.keyFor(rootId, segments))
    if (keys === undefined) return []
    const out: IndexEntry[] = []
    for (const key of keys) {
      const entry = this.#entries.get(key)
      if (entry !== undefined) out.push(entry)
    }
    return out
  }

  /**
   * Every entry beneath a path, inclusive. Used by reconciliation to bound its work to one
   * subtree, and by a directory move to re-key what it contains.
   *
   * Segment-boundary containment, never a string prefix — `/soil/notes` must not sweep up
   * `/soil/notes-old` (spec §5, and a real bug in the lab code).
   */
  subtree(rootId: string, segments: readonly string[]): IndexEntry[] {
    const caseInsensitive = this.#casing(rootId)
    const out: IndexEntry[] = []
    for (const entry of this.#entries.values()) {
      if (entry.rootId !== rootId) continue
      if (isWithin(segments, entry.segments, caseInsensitive)) out.push(entry)
    }
    return out
  }

  /** Every entry, unordered. Callers derive boards and lists from this. */
  all(): IterableIterator<IndexEntry> {
    return this.#entries.values()
  }

  /** Drops one root entirely — deregistration, or a volume that went away. */
  clearRoot(rootId: string): number {
    let removed = 0
    for (const [key, entry] of [...this.#entries]) {
      if (entry.rootId !== rootId) continue
      this.#entries.delete(key)
      this.#children.delete(key)
      const inode = inodeKey(entry.dev, entry.ino)
      if (this.#byInode.get(inode) === key) this.#byInode.delete(inode)
      removed++
    }
    for (const [parentKey, set] of [...this.#children]) {
      for (const childKey of [...set]) {
        if (!this.#entries.has(childKey)) set.delete(childKey)
      }
      if (set.size === 0) this.#children.delete(parentKey)
    }
    return removed
  }
}
