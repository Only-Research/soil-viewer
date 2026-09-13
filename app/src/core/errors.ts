/**
 * Stable machine error codes. Spec §6: "stable machine codes; no stack traces, no absolute
 * paths outside a root, no verbatim client strings."
 *
 * These strings are part of the contract. They are matched by tests and, from P2, by the
 * client. Renaming one is a breaking change; add rather than repurpose.
 *
 * Core layer: no HTTP, no browser, no third-party code. Spec §2. Nothing here knows about
 * status codes — mapping a code to a transport lives in the adapter.
 */

export const ErrorCode = {
  /** Input was empty, not a string, or otherwise unusable before any check ran. */
  PATH_EMPTY: 'PATH_EMPTY',
  /** A NUL byte appeared, before or after percent-decoding. */
  PATH_NUL: 'PATH_NUL',
  /** A `%` survived one round of decoding — double-encoding, refused. */
  PATH_ENCODING: 'PATH_ENCODING',
  /** Percent-decoding threw: the escape sequence was malformed. */
  PATH_MALFORMED_ESCAPE: 'PATH_MALFORMED_ESCAPE',
  /** Absolute path, drive letter, or UNC prefix. The API only ever takes relative paths. */
  PATH_NOT_RELATIVE: 'PATH_NOT_RELATIVE',
  /** A `..`, `.`, or empty segment. Traversal, refused before composition. */
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  /** Composed successfully but landed outside the registered root. */
  PATH_ESCAPES_ROOT: 'PATH_ESCAPES_ROOT',
  /** A segment of the path is a symlink. Spec §4 refuses rather than resolves. */
  PATH_SYMLINK: 'PATH_SYMLINK',
  /** The target is not a regular file — FIFO, device, socket, directory where a file was due. */
  NOT_REGULAR_FILE: 'NOT_REGULAR_FILE',
  /** A regular file with more than one hard link. Refused in both directions. Spec §4. */
  HARDLINKED: 'HARDLINKED',
  /** The descriptor's (dev, ino) did not match what the checker recorded. TOCTOU. */
  IDENTITY_CHANGED: 'IDENTITY_CHANGED',
  /** Read exceeded the 25 MB cap. Spec §4. */
  TOO_LARGE: 'TOO_LARGE',
  /**
   * EACCES/EPERM. Spec §5: a background process gets EPERM on ~/Documents, ~/Desktop, iCloud
   * and external volumes **with no prompt at all**. This is its own code because §5 requires a
   * named "permission needed" state that reconciles on grant — conflating it with a
   * containment refusal would present a fixable macOS permission as a corrupt path.
   */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** A filesystem call failed for a reason that is not one of the above. Never swallowed. */
  IO_FAILED: 'IO_FAILED',
  /**
   * Fewer bytes were read than the descriptor's own `fstat` promised — the file was truncated
   * or replaced mid-read.
   *
   * Its own code because spec §13.2 names it: "A failed **or partial** read renders a named
   * error with editing disabled." Returning the short buffer as a success is the read half of
   * the C2 total-loss path — the editor mounts what looks like an empty document, one keystroke
   * autosaves, and the file is gone.
   */
  SHORT_READ: 'SHORT_READ',
  /**
   * The descriptor's size or mtime changed between the open and the end of the read — something
   * rewrote the file **in place** while it was being read, so the buffer is a mix of two versions.
   *
   * Distinct from `SHORT_READ`, which is a read that came up empty-handed, and from
   * `IDENTITY_CHANGED`, which is a different file. This one is the *right* file, the *right* number
   * of bytes, and content that never existed on disk in that combination.
   *
   * Its own code because the failure it prevents is silent: a torn buffer hashed into a
   * `DocumentBaseline` produces a conflict decision about a document the user never saw, and
   * §13.5's Keep Mine would then write it over the real file. The control fires and the data is
   * still wrong.
   */
  CHANGED_DURING_READ: 'CHANGED_DURING_READ',
  /** A registered root was not absolute, or was the filesystem root itself. */
  INVALID_ROOT: 'INVALID_ROOT',
  /**
   * Registration refused because that folder — or its id — is already registered.
   *
   * **Split out of `INVALID_ROOT` on 2026-08-09, and the reason is §6.** The wire carries a *code*
   * and a fixed message from a table; the free-text `detail` beside a refusal goes to the local log
   * and never leaves the machine. So three genuinely different registration refusals sharing one
   * code meant one sentence — *"That folder cannot be used."* — for "you already added this",
   * "this overlaps something you added" and "this is not a usable path". A person re-picking the
   * same folder could not be told which.
   *
   * The fix is more codes rather than free text, because free text is the thing §6 forbids: it is
   * how absolute paths and caught-exception strings escape onto the wire.
   */
  ROOT_ALREADY_REGISTERED: 'ROOT_ALREADY_REGISTERED',
  /** Registration refused because the folder contains, or sits inside, one already registered. */
  ROOT_OVERLAPS: 'ROOT_OVERLAPS',
  /** Write or append attempted on a path that is not markdown. Spec §6. */
  NOT_MARKDOWN: 'NOT_MARKDOWN',

  /**
   * The file's **bytes** disqualify it from the editor. Spec §12's editability gate: a `.md` file
   * is editable only if its bytes decode as valid UTF-8 **with no NUL**.
   *
   * **Its own code because §12 makes this a state, not a failure.** These files open the
   * non-editing pane *with a reason* — they are perfectly good files the editor is not allowed to
   * touch. Reported as `IO_FAILED` (which is what the load path did until 2026-08-08) a client
   * cannot tell "this file is not editable, here is why" from "the disk broke", and the pane P7
   * builds has nothing to render.
   *
   * Distinct from `NOT_MARKDOWN`, which is about the *name*, and from `TOO_LARGE`, which is about
   * the size. This one is about the content.
   */
  NOT_EDITABLE: 'NOT_EDITABLE',

  /**
   * A rename or move would change whether the thing is an editable document. Spec §12's FT-5.
   *
   * `photo.png` → `photo.md` is the case the spec names: it makes a PNG look like something the
   * editor should open. **Its own code rather than a reuse of `NOT_EDITABLE`** — that one describes
   * a file whose *content* cannot be edited, and it is the code the non-editing pane branches on.
   * This one describes a rename that was refused, which is a different sentence on a different
   * screen. Collapsing them would send the tree's rename dialog a message written for the editor.
   */
  EDITABILITY_BOUNDARY: 'EDITABILITY_BOUNDARY',

  /**
   * The bytes on disk no longer hash to the baseline the caller loaded. Spec §13.4.
   *
   * **A conflict, not an error** — the edit is intact and the resolution flow (§13.5) takes over.
   * Distinct from `IDENTITY_CHANGED`, which is a different *file* at the path rather than
   * different *content* in the same one.
   */
  CONFLICT_DETECTED: 'CONFLICT_DETECTED',

  /**
   * The save would remove most of the file. Spec §13.2: zero bytes, or under half the loaded
   * count, is blocked pending an explicit confirmation that names the loss.
   *
   * Its own code because the caller must be able to re-issue the identical save with the
   * confirmation attached — this is a question, not a refusal.
   */
  TRUNCATION_BLOCKED: 'TRUNCATION_BLOCKED',

  /**
   * The client acted on a view of the tree that no longer matches disk. Spec §13.8's `stale-target`.
   *
   * **Named in the spec since round two and absent from this enum until 2026-08-08**, because
   * nothing had yet been built that could detect the condition. §13.7's M2 is the first: a lane
   * drag whose destination lane has been renamed or removed since the board was drawn.
   *
   * Its own code, and one code for every version of the condition, because the client's answer is
   * always the same — **reload and show what is actually there.** A lane renamed and a project
   * archived are the same event to a person looking at a board that no longer matches the disk, and
   * splitting them would invite a client to try to be clever about one of them.
   */
  STALE_TARGET: 'STALE_TARGET',

  /**
   * The file carries a macOS immutable flag (`uchg`/`schg`). Spec §13.2.
   *
   * Separate from `PERMISSION_DENIED` because the remedy is different and so is the sentence the
   * user needs to read: permission bits are a Finder "Get Info" change, an immutable flag is
   * `chflags nouchg`. Node cannot read `st_flags` at all — measured — so this is detected by
   * `access(W_OK)` returning `EPERM`, which is exactly how it differs from a mode denial's
   * `EACCES`.
   */
  FILE_IMMUTABLE: 'FILE_IMMUTABLE',

  /**
   * ENOSPC or EDQUOT. Spec §13.2's C3 path: "a full disk must never rename a truncated temp over
   * good content."
   *
   * Its own code because §13.2 requires it be **sticky** — the buffer is retained and the error
   * stays on screen. A disk-full save reported as a generic IO failure is one the user retries
   * forever.
   */
  DISK_FULL: 'DISK_FULL',
  /**
   * An append-only log has reached its size cap (`MAX_LOG_BYTES`). Not `DISK_FULL` — the volume
   * has room; the log has been told not to take it. Spec §7: a failed log write fails the
   * operation, and this is a failed log write. The app never rotates or deletes a log; the operator
   * moves the file aside and restarts. Added 2026-09-02, when an unauthenticated route was found
   * able to grow the mutation log by a gigabyte a day.
   */
  LOG_FULL: 'LOG_FULL',

  /**
   * The temp file's own `fstat` did not report the number of bytes we intended to write.
   *
   * The C3 assertion, and the reason it is a named code rather than a generic failure: this is the
   * last thing standing between a short write and a `rename` that puts a truncated file over good
   * content. If this ever fires, the write path stopped early without erroring — worth seeing by
   * name rather than as "IO failed".
   */
  WRITE_SIZE_MISMATCH: 'WRITE_SIZE_MISMATCH',

  /**
   * The directory that should contain the file does not exist. Spec §13.3: "Writes never create
   * directories. A write whose parent doesn't exist **fails loudly**."
   *
   * v1's rule said the same thing and was satisfiable while `mkdir -p` lived in move.
   */
  PARENT_MISSING: 'PARENT_MISSING',

  /** A generated path exceeded `NAME_MAX` or `PATH_MAX` **in bytes**. Spec §13.5. */
  /**
   * A typed name slugified to nothing. Spec §13.6's M16.
   *
   * Its own code rather than `BAD_REQUEST` because the request was perfectly well-formed — the
   * *name* was the problem, and the client has to say which field to correct. Reported generically
   * this is a create button that fails with no indication of what to change.
   */
  /**
   * Something already exists at the name a create, rename, move or duplicate was aiming at.
   * Spec §13.6: *"Collisions are refused with a named error offering an auto-suffixed
   * alternative."* The refusal is ours; the alternative is the caller's to offer.
   *
   * **Added at P7 because `CONFLICT_DETECTED` was standing in for this**, and its sentence is
   * *"The file changed on disk since you opened it."* That is true of a save whose baseline moved
   * and false of a rename onto an occupied name — the file did not change, the name was taken.
   * §6 gives each code one fixed sentence, so a code doing two jobs necessarily tells one of them
   * a lie. Harmless while nothing rendered it; P7 is the phase that puts it in front of a person.
   */
  NAME_TAKEN: 'NAME_TAKEN',

  NAME_EMPTY: 'NAME_EMPTY',

  NAME_TOO_LONG: 'NAME_TOO_LONG',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/*
 * **`PathError` was here and is deleted, 2026-08-16.**
 *
 * A refusal carrying a stable code — superseded by `RefusalError` below, which does the same job
 * and is the one the product uses (`server/services.ts`'s `ServiceError extends RefusalError`).
 *
 * It was the only finding of the reachability sweep with **no caller and no test**: the sole two
 * occurrences of the name in the whole repository were its own declaration and the `this.name`
 * assignment inside its own constructor. Its doc comment still described it as the live one, which
 * is how a superseded class survives a rename — the replacement lands, the original is left, and
 * the comment goes on being read as current.
 */

/**
 * The brand that lets an adapter recognise a *deliberate* refusal in a `catch`.
 *
 * A `Symbol.for` key rather than `instanceof`: the server bundle and the test process can end up
 * with separate copies of a class, and an identity check that works in a unit test and fails in
 * the bundle is worse than no check. A registry symbol is the same symbol in both.
 */
export const REFUSAL_CODE = Symbol.for('soil-viewer.refusal-code')

/**
 * An expected refusal, thrown rather than returned.
 *
 * Core returns `Result` for refusals precisely so they cannot be swallowed — see the note below.
 * The **adapters** need the throwing form, because a service handler's signature is its return
 * type and threading a `Result` through every route would put the refusal decision back in the
 * caller's hands. So the adapter throws this, and the dispatcher is required to turn it into a
 * typed wire error.
 *
 * **This class exists because that requirement was stated and not met.** `ServiceError` in
 * `src/server/services.ts` carried a comment reading *"Thrown so `dispatch` turns it into a typed
 * error"* — and `dispatch` caught every throw alike and answered `INTERNAL`. Every designed
 * refusal in the entire service layer reached the client as *"The operation could not be
 * completed."*: a folder with no backup, a save that would truncate, a conflict, a non-markdown
 * path. All of them indistinguishable from a crash, and `WireError.code` typed
 * `ErrorCode | TransportErrorCode` the whole time, ready for a code nothing ever sent.
 *
 * Found by the first end-to-end drive (`test/tools/drive-the-mock-soil.test.ts`) and by nothing
 * before it: the service tests call the handlers directly and see the thrown code, and the router
 * tests use handlers that throw plain errors. Each half was locally correct.
 */
export class RefusalError extends Error {
  readonly code: ErrorCode;
  readonly [REFUSAL_CODE]: ErrorCode

  constructor(code: ErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'RefusalError'
    this.code = code
    this[REFUSAL_CODE] = code
  }
}

/**
 * The code a thrown value carries, or `null` if it is not a deliberate refusal.
 *
 * Returns `null` for anything unbranded, so a genuine crash still becomes `INTERNAL` — the point
 * is to distinguish the two, not to start narrating exceptions to the client.
 */
export function refusalCodeOf(thrown: unknown): ErrorCode | null {
  if (typeof thrown !== 'object' || thrown === null) return null
  const carried = (thrown as Record<symbol, unknown>)[REFUSAL_CODE]
  return typeof carried === 'string' && Object.hasOwn(ErrorCode, carried)
    ? (carried as ErrorCode)
    : null
}

/**
 * Typed success or typed failure. Spec §6: "Every response is a typed success or a typed error.
 * An empty-but-successful result never stands in for a failure."
 *
 * Core returns these rather than throwing for expected refusals, so a caller cannot swallow a
 * refusal in a catch block and turn it into empty success — the failure mode §6 names.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; detail?: string }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail<T>(code: ErrorCode, detail?: string): Result<T> {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail }
}
