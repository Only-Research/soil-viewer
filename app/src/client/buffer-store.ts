/**
 * The IndexedDB behind retained buffers. Spec §13.8.
 *
 * `retained-buffer.ts` has held every rule since P3 — never auto-replay, discard corrupt or
 * oversized blobs, report a quota failure as blocking rather than dropping the edit — with the
 * store injected so all of it is testable without a browser. **The store was never built.** So the
 * module was correct, thoroughly tested, and reachable by nothing: the security review's eighth unreachable
 * control, finding G4 of the P7 review. An unsaved edit on a suspended phone had no rescue.
 *
 * This is the missing adapter and nothing else. Every decision lives on the other side of the
 * interface; what is here is the browser.
 *
 * ## Why IndexedDB and not `localStorage`, restated because half the original reasoning was false
 *
 * §13.8 gave two reasons and the second was wrong: it claimed `localStorage` is evicted after seven
 * days on iOS while IndexedDB is not. **Both are evicted, on the same schedule, by the same
 * mechanism.** Moving buys zero eviction immunity.
 *
 * The quota reason is sound on its own and is why the decision stands: `localStorage` shares a ~5 MB
 * origin quota and throws on a large write, and the throw is easy to swallow — which turns "your
 * work is kept" into a silent lie. IndexedDB's quota is orders of magnitude larger and its failures
 * arrive as rejections that this file refuses to hide.
 *
 * ## Failing loudly is the whole contract of this file
 *
 * **No operation here degrades to a no-op.** If IndexedDB is missing, blocked by a private-browsing
 * mode, or the database will not open, every call rejects — because `retain()` turns a rejection
 * into `{ ok: false, reason: 'store-failed' }`, and §13.8 requires the caller to *block* on that.
 * An adapter that quietly resolved on failure would satisfy every type in the system while
 * producing the one outcome the rule forbids: the person believes their work is safe.
 */

import type { BufferStore, RetainedBuffer } from './retained-buffer'

export const DATABASE_NAME = 'soil-viewer'
export const STORE_NAME = 'retained-buffers'
const DATABASE_VERSION = 1

/**
 * Adapts one `IDBRequest` to a promise.
 *
 * `onerror` is wired before anything can fire, and the rejection carries the request's own error so
 * `retain()` can tell a `QuotaExceededError` from anything else — that distinction is the difference
 * between "your disk is full" and "something is broken", and §13.8 asks the caller to say which.
 */
function promiseFor<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => {
      reject(request.error ?? new Error('the retained-buffer store failed'))
    }
  })
}

/**
 * Resolves when the transaction **commits**, not when the request succeeds. The security review's C2, Phase 8.
 *
 * `request.onsuccess` fires while the transaction is still open. A transaction that aborts after
 * that — quota exhausted at commit, the tab closing, the connection going away — leaves the request
 * looking successful and **nothing on disk.** Measured in Chromium: the request succeeded, the
 * transaction was aborted, `retain()` returned `{ ok: true }`, and the key read back `undefined`.
 *
 * That is the one outcome this file's header forbids in so many words — *"an adapter that quietly
 * resolved on failure would satisfy every type in the system while producing the one outcome the
 * rule forbids: the person believes their work is safe"* — and it is the case §13.8 cares about
 * most, because **a quota failure surfaced at commit rather than at the request lands entirely
 * inside that hole**, where `retained-buffer.ts`'s `QuotaExceededError` branch can never see it.
 *
 * Reads are exempt on purpose: a `get` has nothing to commit, and waiting for the transaction would
 * add a turn of the event loop to every open for no property gained.
 */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => { resolve() }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('the retained-buffer write was rolled back'))
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('the retained-buffer write failed'))
    }
  })
}

/**
 * Opens the database, creating the object store on first run.
 *
 * The promise is cached, so a burst of keystrokes shares one open rather than racing several. A
 * **failed** open is not cached: a database that could not be opened because the tab was still
 * starting up, or because another tab held a version-change lock, must be retryable — caching the
 * rejection would make one bad moment permanent for the life of the page.
 */
function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('could not open the store')) }
    /**
     * A blocked open is a REJECTION, not a wait.
     *
     * `onblocked` fires when another tab holds the database at an older version, and without this
     * the promise would simply never settle — which on the retain path means an `await` that hangs
     * forever while the person keeps typing, believing each keystroke is being kept. A silent hang
     * is the worst available failure here: it is indistinguishable from success.
     */
    request.onblocked = () => { reject(new Error('another tab is holding the store open')) }
  })
}

/**
 * The real store. Rejects rather than degrading, always.
 *
 * The factory is a parameter so a test can hand in a fake or an absent one; production passes the
 * browser's. A missing factory is an error at every call rather than at construction, because a
 * constructor that throws during module load takes the whole app down over a feature that is
 * supposed to fail softly *to the caller* and loudly *on the screen*.
 */
export function createBufferStore(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB,
): BufferStore {
  let open: Promise<IDBDatabase> | null = null

  const database = async (): Promise<IDBDatabase> => {
    if (factory === undefined) {
      throw new Error('this browser has no IndexedDB, so unsaved work cannot be kept')
    }
    if (open === null) {
      open = openDatabase(factory)
      // Not cached on failure — see `openDatabase`. A transient block must not be permanent.
      open.catch(() => { open = null })
    }
    return open
  }

  /**
   * Runs one request in one transaction.
   *
   * `awaitCommit` is what separates a write from a read: a write is only true once the transaction
   * commits (the security review's C2), and a read has nothing to commit. Both are awaited on the request too,
   * because a request that errors has to reject with **its own** error — `QuotaExceededError` among
   * them — rather than with the transaction's more generic one.
   */
  const transaction = async <T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
    awaitCommit = false,
  ): Promise<T> => {
    const db = await database()
    const tx = db.transaction(STORE_NAME, mode)
    const settled = promiseFor(work(tx.objectStore(STORE_NAME)))
    if (!awaitCommit) return settled
    /**
     * Both awaited, and the request first. An aborting transaction usually errors the request as
     * well, and the request's error is the specific one — reporting `QuotaExceededError` rather
     * than "the write was rolled back" is what lets `retain()` tell the person which problem they
     * have.
     */
    const value = await settled
    await committed(tx)
    return value
  }

  return {
    get: async key => transaction('readonly', store => store.get(key) as IDBRequest<unknown>),

    put: async (key, value: RetainedBuffer) => {
      // The key is passed out-of-line rather than stored on the record: `keyFor` composes it with
      // NUL separators, and a NUL inside an in-line key path is a place for the two spellings of a
      // path to diverge. One key, built in one place, used as a key and nothing else.
      await transaction('readwrite', store => store.put(value, key), true)
    },

    delete: async key => {
      await transaction('readwrite', store => store.delete(key), true)
    },

    keys: async () => {
      const keys = await transaction<IDBValidKey[]>('readonly', store => store.getAllKeys())
      // Non-string keys cannot occur — `put` only ever writes strings — but restored state is
      // untrusted input (F9.2) and `forgetRoot` does prefix arithmetic on whatever comes back.
      return keys.filter((key): key is string => typeof key === 'string')
    },
  }
}
