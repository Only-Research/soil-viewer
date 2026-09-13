/**
 * The route table. Spec §6: "**One validation wrapper, and the route table is generated from it**
 * (§2) so an unchecked route cannot exist."
 *
 * That is a **structural** claim, not a discipline, and this file is where it is made true. A route
 * is a record whose `input` field is required by its type, so a route without a validator is a
 * compile error rather than an oversight. The router in `router.ts` is then derived from this
 * table, which means:
 *
 *   - a handler cannot be registered for a route that does not exist here;
 *   - a route declared here without a handler is a compile error;
 *   - and dispatch runs the validator before the handler, with no path around it, because the
 *     handler is only reachable through dispatch.
 *
 * v1 "had a contract that was never actually enforced — that's how bugs got in" (§6). The
 * difference is not that this one is written down; it is that skipping it is not expressible.
 *
 * PRIVILEGE IS PART OF THE ROUTE, and spec §7 is emphatic about why. v1 gated privileged verbs on
 * "requests from 127.0.0.1 only", which was **inverted and void**: `tailscale serve` terminates TLS
 * and opens a fresh loopback connection, so every phone request passed the gate and the only
 * requests refused were on a listener nobody used. So privilege here is not checked at request
 * time — privileged routes are **not present on the tailnet router at all**. Forgetting a check is
 * not something you can do, because there is no check to forget.
 */

import {
  MAX_CARD_ORDER,
  MAX_SELECTED_PROJECTS,
  arrayOf, bool, displayName, hex64, location, object, oneOf, pathSegments, str, type Validator,
} from './validate'

/**
 * Spec §7: "state-changing verbs are POST/PATCH only; no side effects on GET/HEAD."
 *
 * Every route below is POST, including the read routes. That is deliberate and it is a CSRF
 * consequence rather than REST taste: §7 requires `Content-Type: application/json` on every
 * non-static route so the browser is forced into a preflight, and a GET cannot carry a body or a
 * content type. Making reads POST costs nothing here — this is a local app, not a public API with
 * caching semantics to preserve — and it removes the category of route that a cross-origin page can
 * trigger with a plain image tag.
 */
export type RouteMethod = 'POST'

/**
 * Which listener may carry a route.
 *
 * `local` — loopback only, never a `serve` target. Registration, deregistration, folder-browser
 * enumeration, Reveal in Finder, Open in Default App, any config write touching roots.
 * `tailnet` — the sole `serve` target, and therefore what the phone reaches.
 *
 * A `local` route is reachable from the loopback listener only. A `tailnet` route is reachable from
 * both, because the local listener is strictly more privileged.
 */
export type RoutePrivilege = 'local' | 'tailnet'

/**
 * WHICH LISTENERS CARRY A ROUTE — separated from `RoutePrivilege`, which identifies a *listener*.
 *
 * The two were one field, and it could express only two of the three cases. `'local'` meant
 * "privileged, loopback listener alone" and `'tailnet'` meant "both, because local is strictly more
 * privileged." There was no way to say **tailnet listener only**, and the security review's B3 requires exactly
 * that for the session route: the local listener serves no client, so a bootstrap route there would
 * be an unauthenticated dispenser of the *privileged* token with **zero legitimate callers**.
 *
 * Naming the three cases explicitly also removes a real ambiguity — `privilege: 'tailnet'` reading
 * as "tailnet only" when it meant "both" is a misreading waiting to happen on a field that decides
 * reachability.
 */
export type RouteCarriage =
  /** Privileged. The loopback listener alone; absent from the tailnet router entirely. */
  | 'local-only'
  /** Ordinary. Both listeners, because the local listener is strictly more privileged. */
  | 'both'
  /** The tailnet listener alone. For routes that only mean anything where a client is served. */
  | 'tailnet-only'

/**
 * Whether a route requires the per-request token. The security review's B1.
 *
 * **Required by the type, and that is the whole point.** The session route must skip `checkToken` —
 * it is the route that *hands out* the token, so it cannot require it. The tempting implementation
 * is a name comparison in the listener (`if (name === 'session.start') skip`), and that is the
 * Funnel-gate bug's exact shape: an **attacker-supplied string selecting the guard chain**.
 *
 * Here it is a fact about the route table instead. The listener resolves the name to a definition
 * once, and the definition says whether the token is required. A name that resolves to nothing
 * requires the token, because the default is deny and there is no third state.
 *
 * A new route must state this. It cannot be defaulted, and a default is precisely how an
 * unauthenticated route would appear by omission.
 */
export type RouteAuth =
  /** The per-request token in `x-soil-token` is required. Every route but one. */
  | 'token'
  /** No token. Reaching the listener is the authorization — see the session route's note. */
  | 'none'

export interface RouteDefinition<T> {
  readonly method: RouteMethod
  readonly carriedBy: RouteCarriage
  readonly auth: RouteAuth
  /** Required by the type. This is the clause that makes an unvalidated route inexpressible. */
  readonly input: Validator<T>
}

/**
 * Identity function with a constraining type: the table is checked against `RouteDefinition` while
 * each route keeps its exact literal type.
 *
 * The obvious alternative — a trailing `satisfies Record<string, RouteDefinition<unknown>>` — was
 * tried and removed, because it does real damage here. It widens `ROUTES` to an **index
 * signature**, and two things fall out of that: `RouteName` becomes `string` instead of the union
 * of five literals, so the compiler stops catching a typo'd or missing handler; and under
 * `noUncheckedIndexedAccess` every lookup becomes `T | undefined`, which invites the `?? throw` or
 * `!` that would quietly reintroduce the "route with no validator" case this file exists to make
 * impossible.
 *
 * A generic identity function keeps the literal types and the totality check. Recorded because the
 * two spellings look interchangeable and only one preserves the guarantee.
 */
const defineRoutes = <T extends Record<string, RouteDefinition<unknown>>>(table: T): T => table

/**
 * The table. Read routes only, for now: **P2 builds no write path.** The first write route arrives
 * in P4 with the atomic-write machinery, and it will pass through this same chokepoint — including
 * spec §6's rule that write and append accept only paths satisfying `isMarkdown()` *regardless of
 * what the client asked*, which is C1/FT-1 and the mistake v1 made by treating it as UI behaviour.
 */
export const ROUTES = defineRoutes({
  /**
   * THE BOOTSTRAP ROUTE. The only route in this table with `auth: 'none'`.
   *
   * It returns the per-request token and the live-stream ticket, and it is the reason either ever
   * reaches the browser: the shell is served from an immutable in-memory map built at startup and
   * does no per-request work, so there is nowhere to inject a per-load value into it.
   *
   * **REACHING THIS LISTENER IS THE AUTHORIZATION.** The security review's B8, stated here in the words it
   * required rather than left as an unexamined consequence:
   *
   * > The tailnet is the authentication boundary — every device on it was explicitly admitted by
   * > the operator. Admitting a device grants it the full tailnet route set, which from P4 includes
   * > write access to every registered root. Spec §1 records this as an accepted risk; the mutation
   * > log is the compensating control.
   *
   * That is **the decision, already on the record**, not one this route introduces. Spec §1,
   * under "Out of scope, accepted, recorded": *"Any device on the tailnet can reach the files
   * (the tailnet-trust call)."* And §7: *"This is not a login and not device pairing —
   * the operator's no-pairing decision stands."* the security review ruled YES on 2026-08-07 having read both.
   *
   * **POST, not GET, and that is measured rather than stylistic.** A same-origin GET `fetch()`
   * sends **no `Origin` header** — confirmed in Chromium, WebKit, and on the operator's iPhone through
   * `tailscale serve`. A GET route would therefore need the whole `Sec-Fetch-Site` treatment the
   * stream needs, which is a third guard chain. A same-origin POST **does** send `Origin`, also
   * measured on the phone. So this is the existing chain minus exactly one guard.
   *
   * **`tailnet-only`**, per B3: the local listener serves no client, so nothing legitimate would
   * ever call this there — and with per-listener tokens (B2) a bootstrap route on the local
   * listener would be an unauthenticated dispenser of the *privileged* token.
   */
  'session.start': {
    method: 'POST',
    carriedBy: 'tailnet-only',
    auth: 'none',
    input: object({}),
  },

  /** Every registered folder. No input — and an empty strict object still rejects unknown keys. */
  'folders.list': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({}),
  },

  /** The children of one directory. An empty result means empty, never "the read failed" (§6). */
  'tree.children': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: location(),
  },

  /** One row, by location. */
  'tree.entry': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: location(),
  },

  /**
   * How many indexed files sit under a path, for a confirmation that names the cost.
   *
   * §13.7's M6: *"Guards are measured in indexed files affected, not bytes — a directory rename
   * moves zero bytes, so v1's byte threshold would let a project move silently remove 200 files
   * from every view. Confirmation names the count."*
   *
   * **The index, never the disk.** §5 makes the index authoritative for display, and this is a
   * display question — how much is about to move out of view. Walking the disk to answer it would
   * put a filesystem traversal in front of a dialog.
   *
   * A read, so it is carried by both listeners. Its own route rather than a field on `WireEntry`
   * because the answer costs a scan of the index: fine once, at a confirmation, and ruinous on
   * every row of a ten-thousand-file tree.
   */
  'tree.count': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: location(),
  },

  /**
   * Register a folder. **Local listener only** — spec §7 puts registration among the privileged
   * verbs, and §7 additionally requires same-origin *plus* token *plus* an in-app confirmation.
   * The confirmation is a P3 surface; the listener restriction is enforced here and now, so the
   * route cannot be reached from a phone even before that surface exists.
   */
  'folders.register': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      id: str(),
      absolutePath: str(),
      /*
       * `acknowledgedNoBackup` was here, carrying §11's typed override. **The backup check was cut
       * on 2026-08-09** — see the note in `root-registry.ts` — so there is no override to carry.
       */
    }),
  },

  /**
   * The folder browser behind Settings → Folders. §11, F6.3.
   *
   * **§11 calls this route as privileged as `folders.register`, and that is still true — it simply
   * is not expressed by the carriage split any more.** §11: *"The folder-browser enumeration API is
   * equally privileged."* v1 gated registration and left browsing open, which is a whole-disk read
   * oracle. This route answers questions about paths outside every registered folder, so it is
   * exactly as sensitive as registration and must carry exactly the same protections.
   *
   * What protects it now is the `browseScope` allowlist in `browse.ts` — the enumeration is bounded
   * before any syscall, so "whole-disk read oracle" is not a thing this can be even for a caller
   * that is allowed to reach it. That is the real control, and it always was: the carriage split
   * was a second lock on a door that the client could not walk through either way. See the block
   * below for why every route is now `both`.
   *
   * **`absolutePath` is the one shape §6 otherwise forbids on the wire.** The rule is that the API
   * never accepts an absolute path — and it has a standing exception for the registration verbs,
   * because a folder that is not yet registered has no `(rootId, segments)` to be named by.
   * Browsing is in that same family and takes the same exception, rather than inventing a third
   * addressing scheme.
   */
  'folders.browse': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      /** Empty means "start at the allowed roots" — the caller does not have to know the home path. */
      absolutePath: str(),
    }),
  },

  /**
   * Deregister a folder — **the registry entry only. No file is touched, ever.**
   *
   * Stated here because the name reads like a removal and this app has none. The operator: *"There needs
   * to be zero remove features anywhere in this app… nothing gets deleted, no files get deleted, I
   * move them, they get archived."* Deregistering forgets a path; the folder and everything in it
   * stays exactly where it is on disk. Whether a **control** for this appears in Settings is a
   * separate question and is open — see `build/open-items.md`.
   */
  'folders.deregister': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({ id: str() }),
  },

  // -------------------------------------------------------------------------
  // TEMPLATES. Phase 8, and the reason there is no `templates.instantiate` here.
  //
  // A template is a NAMED POINTER to a folder — the operator: *"that template might change… these
  // things take shape."* Scaffolding from one is therefore an ordinary recursive copy of that
  // folder, and `entry.copy` below already is one: pre-flight before a byte is written, staged
  // outside every root, one exclusive rename into place, nothing left behind on failure. It has
  // been mutation-swept since P4.
  //
  // **A fourth verb would be a second way to copy a directory tree.** `validate.ts` warns that
  // "re-deriving them at the call site is how two path validators end up disagreeing", and the byte
  // endpoint taught the sharper version of that lesson in the P7 review: the danger was not a
  // second divergent implementation, it was a caller with none. A template scaffold is a copy, so
  // it goes through the copy.
  //
  // These three verbs are `token` and `both` like the folder verbs they sit beside. They edit the
  // registry, which is the same class of thing as registering a folder.
  // -------------------------------------------------------------------------

  /** Every stored template. Includes ones whose folder is no longer registered; see the service. */
  'templates.list': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({}),
  },

  /**
   * Name a folder as a template.
   *
   * **`(rootId, segments)`, never an absolute path** — and this is the one registration-family verb
   * that does *not* take the `absolutePath` exception §6 grants the others. It does not need it: a
   * template points at a folder **inside** one the user has already registered, so it has a
   * `(rootId, segments)` to be named by, and taking the exception anyway would open a second way
   * into the filesystem beside the one §4 proves.
   */
  'templates.register': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      id: str(),
      name: displayName(),
      rootId: str(),
      /**
       * `pathSegments()` rather than a hand-rolled array, and rather than `location()`.
       *
       * `location()` bundles `rootId` and `segments` and is right for a read; this route has fields
       * of its own alongside them. `pathSegments()` exists for exactly that case, and its own
       * docstring says why: *"re-deriving them at the call site is how two path validators end up
       * disagreeing."*
       */
      segments: pathSegments(),
    }),
  },

  /**
   * Forget a template. **The registry entry only — the folder it pointed at is untouched.**
   *
   * Same sentence as `folders.deregister`, for the same reason: the name reads like a removal and
   * this app has none. The operator: *"nothing gets deleted, no files get deleted."*
   */
  'templates.deregister': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({ id: str() }),
  },

  // -------------------------------------------------------------------------
  // THE WRITE ROUTES. Phase 4, spec §13. **`both` — RESOLVED 2026-08-09 by the operator.**
  //
  // These were `local-only` as a holding position pending a ruling, and the holding position was
  // wrong in a way nobody noticed for three phases: **the client is served only by the TAILNET
  // listener**, so restricting them to the local one made them reachable by nothing at all. Not
  // "the phone cannot write" — nothing could, the Mac included. Found by clicking a file in a
  // browser, which was the first time anything tried.
  //
  // §7 never put document editing among the privileged verbs. Its list is folder registration and
  // deregistration, the folder-browser enumeration API, and the shell actions. **The code was
  // stricter than the spec**, so this is the code being corrected rather than the spec being
  // relaxed.
  //
  // the ruling, in their words:
  //
  //   *"Yes, the phone can edit. Needs to be able to edit files. Needs to be able to create files.
  //   Needs to be able to create tasks, and needs to be able to do anything, ideally anything it
  //   can do that the app can do… this is being served over Tailscale to a network [that includes]
  //   my computer that's always on that this runs on, a laptop which connects to it via Jump
  //   Desktop, and the phone. That's the only things that will ever be on this tailscale network
  //   period."*
  //
  // **NOTHING STAYS `local-only` AS OF 2026-08-09.** The operator, after being shown that the split
  // could not do what it appeared to: *"obviously, add a folder should just be on port one if
  // that's where the app lives… I want this just to be a normal settings menu within the main
  // interface just like it is in the app as it exists today."*
  //
  // **Why the split could not do it.** The two listeners were meant to express "the Mac may do
  // this, the phone may not". They cannot: the local listener **serves no UI**, so the only page
  // that exists comes from the tailnet listener — on the Mac exactly as on the phone. There was
  // never a screen anywhere that could call these three. "Mac-only" was not a restriction, it was
  // an absence.
  //
  // **What is actually lost, stated rather than glossed.** §7 keeps two listeners so that an
  // accidental `tailscale funnel` cannot reach the privileged verbs — *"one mistyped command
  // otherwise puts the app on the public internet with zero auth."* That defence in depth is gone
  // for registration. What remains in front of it is the Funnel gate itself, which §7 requires be
  // **two independent mechanisms** and which refuses *all* tailnet traffic when Funnel is detected
  // — the header check and the status probe, both live, both tested. So the outer wall stands and
  // the inner one is removed, for a set of verbs the operator uses from a device on a three-machine
  // private network.
  //
  // **the security review reviews this at the P7 gate**, and it is the most consequential thing on their list.
  // Recorded here rather than in a commit message because a future reader will find these three
  // marked `both` and need to know it was a decision.

  // Reveal in Finder stays Mac-only for a different reason entirely: it acts on the Mac's screen
  // and is meaningless from a phone (§10). Not a restriction — an absence of meaning.
  //
  // **IT EXISTS NOW — built 2026-08-14, see `file.reveal` below.** From 2026-08-13 this paragraph
  // carried a note saying the route had never been built (the security review's G9), because until then it
  // described the carriage of something that did not exist. That note has done its job and is
  // replaced by the route itself.
  //
  // **the security review reviews it at P12's gate** rather than P7's — the paragraph originally named P7 because
  // it was written expecting the route that phase.
  // -------------------------------------------------------------------------

  /**
   * **Show a file in Finder. The only route in this application that invokes the operating system.**
   *
   * §10, and the ruling of 2026-08-09 that made it necessary: the non-editing pane offers no
   * download and simply says it cannot display the file, *"for non compliant file types, wherever
   * the reveal and finder option lives is the users path."* Without this, a PDF or a video is a dead
   * end.
   *
   * **`both`, and §10 says `local-only`. That is a deliberate amendment, ruled
   * 2026-08-14, and the reason is that `local-only` does not mean what §10's sentence assumes.**
   *
   * §10 asks for it *"refused entirely on `PORT_TAILNET` — it acts on the Mac's screen and is
   * meaningless from the phone."* It was built that way first, and the refusal **also refused the
   * Mac**. Four steps, each pinned by a test that predates the route:
   *
   *   1. the client calls same-origin paths (`session.ts`);
   *   2. the page exists **only** on the tailnet listener — the local one serves no UI, by
   *      construction in `bootstrap.ts` and asserted in `listener-separation.spec.ts`;
   *   3. so every request the interface makes reaches the **tailnet** router, on the Mac exactly as
   *      on the phone;
   *   4. and a `local-only` route is absent from that router.
   *
   * **This is the same contradiction the operator resolved on 2026-08-09** for `folders.register`,
   * `folders.browse` and `folders.deregister`, in the words recorded above: *"Mac-only was an
   * absence, not a restriction."* §10 was written before that ruling and kept the older idea.
   *
   * **The phone is kept out by §18.8 instead**, which already required it: Reveal *"must not render
   * as a dead control"* below the breakpoint. That is where desktop-only now lives — in what the
   * interface offers, not in what the router carries.
   *
   * **Why that is not a security reduction.** Anyone on the tailnet already holds full read and
   * write to every registered root; §1 records it as an accepted risk with the mutation log as the
   * compensating control. Reveal grants strictly less than what is already granted — it cannot read,
   * write or move a file. The most a tailnet device could do is make Finder windows appear.
   *
   * **What was explicitly NOT done:** a runtime check refusing the route when the request arrives on
   * the tailnet listener. §7 is emphatic that privilege is decided by **which listener carries the
   * route** and never by a check — v1's inverted loopback gate is precisely what that rule exists to
   * prevent, and a check here would be the same shape under a new name.
   *
   * **`(rootId, segments)`, never an absolute path**, like every other file verb. The absolute path
   * is composed by the server *after* `walkAndVerify` has `lstat`ed every segment from the
   * registered root down and refused a symlinked one — so the path handed to `open` is the real
   * path, which is exactly what §10 requires and what a client string could never be.
   */
  'file.reveal': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      segments: pathSegments(),
    }),
  },

  /**
   * Load a document for editing.
   *
   * Distinct from `tree.entry`, which reports a row. This returns **bytes plus the identity the
   * client must hand back to save** — §13.2's "no save without a load", expressed on the wire.
   */
  'file.load': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: location(),
  },

  /**
   * Save a document.
   *
   * `expectedHash` is what the client was given at load. **The server does not reconstruct a
   * baseline from it** — it re-loads the document itself, gets a real baseline, and refuses unless
   * the hash it just read matches what the client claims. That keeps §13.2's rule structural: the
   * only baseline that can reach the write path is one produced by an actual read, and a client
   * cannot manufacture one by sending the right-looking string.
   *
   * `confirmTruncation` re-issues the identical save after the user has seen §13.2's warning. It
   * waives exactly one check and nothing else.
   *
   * **This route answers `ok: true` with a discriminated outcome, not a bare success** — `saved`,
   * `conflict`, `conflict-unrescued` or `truncation-blocked` (`SaveOutcome` in `services.ts`, where
   * the reasoning is). A conflict has to carry the rescue file's location and a blocked truncation
   * has to carry the byte counts, and §6 keeps both off the error envelope by design. So the two
   * things that are *questions* rather than *failures* come back on the success side.
   */
  'file.save': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      segments: pathSegments(),
      content: str(),
      expectedHash: hex64(),
      confirmTruncation: bool(),
    }),
  },

  /**
   * The lanes of one project, with the ids a card move must name. Spec §3 and §13.7's M2.
   *
   * **This is the payload the move route's `laneId` comes from**, and the two land together on
   * purpose: a move route whose ids nothing publishes would be a control reachable by nobody, which
   * is the failure this build has spent a phase removing. The board that *renders* these is P8;
   * this is the read it will call.
   *
   * A lane id is a digest, not a path — see `core/board.ts`. There is no string a client can send
   * that means "make a folder called this".
   */
  'board.lanes': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      project: pathSegments(),
    }),
  },

  /**
   * The cards on one project's board, grouped by lane.
   *
   * Separate from `board.lanes` rather than folded into it, because the two answer different
   * questions and change at different rates: lanes are the folders that exist, cards are what is in
   * them. A board redrawn after a drag needs the second and not the first, and a picker listing
   * projects needs neither.
   *
   * **Every id in the reply came from the same enumeration `board.lanes` uses.** A card whose lane
   * id resolved to nothing would be a card that cannot be dropped anywhere.
   */
  /**
   * Every project in every registered folder. The Projects tab, and the Tasks board's picker.
   *
   * No input: the answer is *"every project"*, and a filter parameter would be a second place the
   * grammar decides what a project is. The client filters what it shows; the server reports what
   * exists.
   */
  'projects.list': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({}),
  },

  /**
   * Every board in every registered folder. The Boards tab's home list. P14 B1.
   *
   * **No input, for the reason `projects.list` above states:** the answer is *"every board"*, and a
   * filter parameter would be a second place the grammar decides what a board is. The client filters
   * what it shows; the server reports what exists.
   *
   * **Read-only, and the whole of B1 is.** No route in this phase writes to the file tree.
   */
  'boards.list': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({}),
  },

  /**
   * One board's columns and cards, with the remembered arrangement applied. P14 B2 + B3.
   *
   * **Takes a path because it opens one board**, unlike `boards.list` — and the path is resolved
   * against the index by the service rather than trusted, exactly as `board.lanes` does. Still
   * read-only.
   *
   * `location()` rather than a hand-built object: this route has no fields of its own beside the
   * path, which is the case that helper exists for. Re-deriving one here is how two path validators
   * end up disagreeing.
   */
  'boards.open': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: location(),
  },

  /**
   * Remembers a column's card order. P14 B4.
   *
   * **Writes app config and never the file tree**, exactly as the Projects board's edits do —
   * the rule there applies verbatim: *"when I drag stuff around that board nothing is supposed
   * to happen on disk."* Everything in Boards that *does* touch the tree goes through
   * `entry.create` and `entry.rename`, so Boards adds no new way to write.
   *
   * `segments` names the **column**, not the board. The board is derived from it, because a caller
   * supplying both could name a column under one and a board under another.
   */
  /**
   * Remembers a board's COLUMN order. Config only; nothing on disk moves.
   *
   * `segments` names the board. A sibling route rather than a flag on `boards.setOrder`, because a
   * path whose meaning depends on a flag is how a card order ends up written onto a board.
   */
  'boards.setColumnOrder': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      segments: pathSegments(),
      order: arrayOf(str(), MAX_CARD_ORDER),
    }),
  },

  'boards.setOrder': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      segments: pathSegments(),
      /** Filenames, in the order they should appear. Bounded like every other list on the wire. */
      order: arrayOf(str(), MAX_CARD_ORDER),
    }),
  },

  // -------------------------------------------------------------------------
  // THE PROJECTS BOARD. Phase 9, and the opposite of the Tasks board by design.
  //
  // A column here is NOT a folder, and **no verb below writes to the file tree.** The operator, and it
  // is the one thing they were conclusive about: *"when I drag stuff around that board nothing is
  // supposed to happen on disk."* Every one of these edits app config and nothing else.
  //
  // That is why none of them takes a destination path, a name to create, or anything a filesystem
  // verb would recognise. `projects.place` names a project that already exists and a column that
  // already exists; there is no shape it could be given that would make a folder.
  // -------------------------------------------------------------------------

  /** The board: its columns, every project as a card, and every staged plan. */
  'projects.board': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({}),
  },

  /**
   * Replace the column set — add, rename, reorder. The operator: *"I can add a new column, I can edit
   * the names of the column."*
   *
   * The whole set at once rather than one verb per operation, because the client holds the order
   * and a per-operation API would make ordering a second thing to keep in step. Cards whose column
   * disappears fall back rather than vanishing; see `projectBoardOf`.
   */
  'projects.setColumns': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      columns: arrayOf(object({ id: str(), name: displayName() }), 32),
    }),
  },

  /** File a project under a column. Config only — the folder does not move. */
  'projects.place': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      segments: pathSegments(),
      columnId: str(),
    }),
  },

  /**
   * Create or update a staged card — a plan with no folder.
   *
   * `id` empty means "new". **`body` is free text and is the point of the feature**: the operator asked
   * for a name *and a description*, so that a project they are not ready to scaffold still has
   * somewhere the thinking lives.
   */
  'projects.stage': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      id: str(),
      name: displayName(),
      body: str(),
      columnId: str(),
    }),
  },

  /**
   * Forget a staged card. **There is no file, so there is nothing to delete** — this is the safest
   * removal in the app.
   *
   * It is still confirmed on screen, and that sentence used to be a lie: the comment claimed it
   * asked while the Remove button fired on one click (security review, P9-4). What is lost is not a file but
   * the description, which is prose that exists nowhere else, so `plan-prompt.ts` now arms the
   * button and requires a second click. Corrected here rather than deleted, because a comment that
   * describes a control the code does not have is worse than no comment.
   */
  'projects.unstage': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({ id: str() }),
  },

  /**
   * Every inbox across every registered folder, with what is in it.
   *
   * No input, for the same reason `projects.list` has none: the answer is *"every inbox"*, and a
   * filter parameter would be a second place the grammar decides what an inbox is.
   *
   * **Capture uses `entry.create`** — there is no `inbox.add`. Dropping a note into an inbox is
   * creating a file in a folder, which is a verb that already exists and has already been proven:
   * exclusive create, slugified name, no directory made along the way. A second creation verb would
   * be a second thing to keep in step with §13.6.
   */
  'inbox.list': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({}),
  },

  /**
   * The columns of a board scoped to a **folder**, with same-named lanes merged. P11's Scope facet.
   *
   * **Separate from `board.lanes` rather than replacing it.** That route answers "what are this
   * project's lanes" and its ids are what a drag resolves against; this one answers "what is under
   * here". A single project asked through this route is the degenerate case, and the ids in both
   * replies are the same digests — so a card dragged on a gathered board resolves through exactly
   * the machinery §13.7's M2 already hardened.
   *
   * **`scope` is a folder the client can already see**, not a path it composed: §6's chokepoint is
   * unchanged, and the reply's lane ids remain the only thing a mutation may name. A column carries
   * **no id of its own** — there is no folder called "every Next under here", so an addressable
   * column would be a name for a place that does not exist.
   */
  'board.columns': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      /** Empty means every project — the board's default. */
      projects: arrayOf(pathSegments(), MAX_SELECTED_PROJECTS),
    }),
  },

  /**
   * The cards of every lane under a scope, keyed by lane id. P11's gathered board.
   *
   * The same split `board.cards` makes, one scope wider: the client holds the columns and groups
   * these into them by lane id. A redraw after a drag calls this and not `board.columns`.
   */
  /**
   * §16's quick-open. Ranked matches over paths **already in the index** — no new index, no
   * full-text scan, and no pattern built from the query.
   */
  /**
   * Whether the app's own records are damaged. §13.8, and P11 C4.
   *
   * **Its own route, called only when the folder list comes back empty.** The distinction between
   * *"nothing is registered"* and *"the record naming what is registered could not be read"* exists
   * carefully on the server — `config-store.ts`: *"Collapsing them is exactly how a corrupt config
   * becomes an empty one"* — and stopped at the wire, which carried no way to tell them apart. It
   * costs a round trip on first run and none on any other boot.
   */
  /**
   * The Tasks board's remembered filter. P11F-6 — built, capped, tested, and connected to nothing
   * until this route existed.
   *
   * **Read and write are separate, and the write takes the whole selection.** A board's filter is
   * small and is replaced wholesale by every tick; an add/remove pair would be two ways to reach
   * one state, and this file has a paragraph on what two paths to one fact cost.
   */
  'board.selection': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({}),
  },

  'board.setSelection': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      projects: arrayOf(
        object({ rootId: str(), segments: pathSegments() }),
        MAX_SELECTED_PROJECTS,
      ),
    }),
  },

  'config.health': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({}),
  },

  'search.quickOpen': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({ query: str() }),
  },

  'board.cardsFor': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      projects: arrayOf(pathSegments(), MAX_SELECTED_PROJECTS),
    }),
  },

  'board.cards': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      project: pathSegments(),
    }),
  },

  /**
   * Move a card to a lane. **The destination is resolved server-side; the client names an id.**
   *
   * §13.7's M2: *"the move-mkdir exception resurrects folders an agent deliberately removed. A lane
   * drag is a move, and the destination lane was a client-supplied string — so a stale board plus a
   * renamed lane materializes a ghost lane. Since folders are the database, that is structural
   * corruption."*
   *
   * Distinct from `entry.rename`, which takes a destination path and is the right shape for Rename
   * and Move in the Files view where the user chose the destination. Here nobody chose a path — a
   * card was dragged onto a lane — and giving the client a path parameter is giving it the chance
   * to name one that should not exist.
   */
  'card.move': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      card: pathSegments(),
      laneId: str(),
      /**
       * §13.8's identity token, as the client was last shown it on the target's row.
       *
       * Required, never optional. An optional token is a control the client can switch off by
       * omission — and the caller most likely to omit it is a stale or hand-rolled one, which is
       * exactly the caller it defends against.
       */
      token: str(),
    }),
  },

  /**
   * **Post a message to a chatroom.** Spec §14, and the one write in this build that is not a
   * temp-and-rename.
   *
   * **There is no `expectedHash`, and its absence is the feature.** §14: *"Appends are exempt from
   * conflict detection (M9 — this matters and is counterintuitive). An append does not depend on
   * prior bytes; that is what makes it an append. Under v1's rule, an agent posting while the phone
   * appends would send the phone's message to a conflict sibling, and the conversation becomes two
   * files with two composers and broken numbering."*
   *
   * **There is no message number either.** *"The next message number is recomputed from the file's
   * current bytes at append time, under the per-inode lock — never from the client's view."* A phone
   * that has been asleep holds a stale conversation; if it proposed a number, two devices posting a
   * minute apart would both propose the same one. The client sends what a person typed and nothing
   * about where it goes in the sequence.
   *
   * `author` is sent rather than derived because §7's viewer identity is a client-side setting —
   * the same name the composer shows. The server writes it verbatim into prose; §8's renderer is
   * what treats it as untrusted at display time.
   */
  'chatroom.append': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      segments: pathSegments(),
      author: str(),
      body: str(),
    }),
  },

  /**
   * **Quick-add: a task born in a lane.** PRD's Tasks tab:
   *
   * > *"every lane carries a quick-add at its bottom. Creation-is-placement embodied: standing in a
   * > project's tasks on the board, a task added at the bottom of a lane is born in that lane's
   * > actual folder — project and status already known from where you're standing, nothing to
   * > choose but the name."*
   *
   * **Separate from `entry.create`, and the reason is the same one `card.move` is separate from
   * `entry.rename`: the client must never name a lane's path.** `entry.create` takes a `parent`,
   * which for this flow the client would have to compose from a lane — and §13.7's M2 is precisely
   * that a client-supplied lane path plus a stale board materialises a ghost folder. Here the
   * client names the id it was given and the server resolves it through the same enumeration the
   * board was drawn from, so an id that no longer enumerates is refused rather than created.
   *
   * **No `kind`.** A card is a markdown file. Offering a directory here would be offering to make
   * something that is not a task in the place tasks live.
   *
   * **No identity token**, for `entry.create`'s reason: a token names a thing that already exists,
   * and a create aims at a name that by definition does not. The exclusive create is the guarantee.
   */
  'card.create': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      project: pathSegments(),
      laneId: str(),
      /** What the person typed. Slugified server-side — see `entry.create` on why only there. */
      name: displayName(),
    }),
  },

  /**
   * New File and New Folder. §13.3's one allowed `mkdir`, §13.6's slugification.
   *
   * **`name` is what the person typed, not a path segment**, and that is why it is `str()` rather
   * than a `pathSegment()`. The server slugifies it and returns the name it actually made, because
   * §13.6 requires the final name be previewable before confirm — a validator that refused the
   * typed name outright would make the preview impossible and push slugification into the client,
   * where it would be a second implementation of a rule that exists to have exactly one.
   *
   * **No identity token.** §13.8's token names an entity that already exists, and a create is aimed
   * at a name that by definition does not. The equivalent guarantee here is the exclusive create
   * itself: `O_CREAT|O_EXCL` and a bare `mkdir` both refuse from the kernel rather than replacing,
   * so a double-tap makes one file and one refusal. The `parent` is a path the client got from the
   * server, and it is verified to exist before anything is written.
   */
  'entry.create': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      parent: pathSegments(),
      name: displayName(),
      kind: oneOf(['file', 'directory'] as const),
    }),
  },

  /**
   * Rename or move a file or folder. §13.6's **exclusive** semantics — the destination is never
   * replaced.
   *
   * One route for both because they are one operation: a rename is a move whose parent does not
   * change, and giving them separate routes would mean two call sites that could drift on which
   * one clobbers.
   */
  'entry.rename': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      from: pathSegments(),
      to: pathSegments(),
      /**
       * §13.8's identity token, as the client was last shown it on the target's row.
       *
       * Required, never optional. An optional token is a control the client can switch off by
       * omission — and the caller most likely to omit it is a stale or hand-rolled one, which is
       * exactly the caller it defends against.
       */
      token: str(),
    }),
  },

  /**
   * Copy a folder — Templates, Duplicate and New Project. §13.7.
   *
   * `plan` reports what the copy would do without writing anything, so the caller can name the
   * count in a confirmation. §13.7: "Confirmation names the count."
   */
  'entry.copy': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      from: pathSegments(),
      to: pathSegments(),
      plan: bool(),
      /**
       * §13.8's identity token, as the client was last shown it on the target's row.
       *
       * Required, never optional. An optional token is a control the client can switch off by
       * omission — and the caller most likely to omit it is a stale or hand-rolled one, which is
       * exactly the caller it defends against.
       */
      token: str(),
    }),
  },

  /**
   * End a conflict. §13.5's Keep Mine / Keep Theirs / Keep Both.
   *
   * `choice` is validated against the three names rather than taken as a string — an unrecognised
   * value must be refused at the boundary, not fall through a switch to whichever branch happens to
   * be last.
   */
  'conflict.resolve': {
    method: 'POST',
    carriedBy: 'both',
    auth: 'token',
    input: object({
      rootId: str(),
      canonical: pathSegments(),
      artifact: pathSegments(),
      choice: oneOf(['mine', 'theirs', 'both'] as const),
      /**
       * §13.8's identity token, as the client was last shown it on the target's row.
       *
       * Required, never optional. An optional token is a control the client can switch off by
       * omission — and the caller most likely to omit it is a stale or hand-rolled one, which is
       * exactly the caller it defends against.
       */
      token: str(),
    }),
  },
})

export type RouteName = keyof typeof ROUTES

/**
 * The routes a given listener carries. A route it does not carry is **absent**, not disabled.
 *
 * Written as an exhaustive switch on `carriedBy` rather than a boolean test, so adding a fourth
 * carriage case is a compile error here instead of silently falling into one of the branches.
 */
export function routeNamesFor(listener: RoutePrivilege): RouteName[] {
  return (Object.keys(ROUTES) as RouteName[]).filter(name => {
    return carriedOn(ROUTES[name].carriedBy, listener)
  })
}

/**
 * Whether a listener carries a route with this carriage.
 *
 * **A function taking `RouteCarriage`, not a switch over the table's values**, and the reason is
 * a real TypeScript behaviour rather than style. There are currently **no `local-only` routes** —
 * the operator's 2026-08-09 ruling moved the last three — so `ROUTES[name].carriedBy` narrows to what
 * the table actually contains, and a `case 'local-only'` written against it is *unreachable code*
 * the compiler rejects. Annotating a `const` does not help: control-flow analysis narrows it back
 * to the initialiser.
 *
 * Deleting the branch would be the wrong fix. The mechanism is intact, and the moment one route is
 * marked privileged again it has to work. A parameter is genuinely of the declared type, so the
 * rule stays exhaustive over the three cases the *type* allows rather than over today's contents —
 * and it becomes directly testable without a route needing to use it.
 */
export function carriedOn(carriage: RouteCarriage, listener: RoutePrivilege): boolean {
  switch (carriage) {
    case 'both': return true
    case 'local-only': return listener === 'local'
    case 'tailnet-only': return listener === 'tailnet'
  }
}

/**
 * Whether a route name requires the token — **default-deny**, per the security review's B1.
 *
 * A name that is not in the table returns `true`. That is not defensive coding: an unrouted request
 * is refused a moment later anyway, and the question here is only which guard chain runs first. If
 * an unknown name could answer "no token needed", then a typo'd or attacker-chosen path would
 * select the weaker chain — the thing this function exists to make impossible.
 */
export function routeRequiresToken(name: string | null): boolean {
  if (name === null) return true
  if (!Object.hasOwn(ROUTES, name)) return true
  return ROUTES[name as RouteName].auth === 'token'
}
