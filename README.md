# Soil Viewer

A local-first workspace over a real folder tree of markdown files — **Files, Tasks, Projects, Inbox, Boards**, five views over one truth.

The folder tree *is* the state. A task's status is the folder it sits in; moving a card moves the file. There is no database, no metadata layer and no hidden state, so anything you do here you could have done in Finder, and anything you do in Finder shows up here.

It runs as a small server on your own machine and is used from a browser — desktop or phone.

## Design commitments

- **Your files come back exactly as you left them.** The editor holds the file's real text and paints formatting over it rather than parsing to a document model and writing back. Enforced in CI on every push to `main` and every pull request: the full corpus round-trips
  **100% byte-identical** through both browser engines, checked against three deliberately lossy
  editors that must each be caught. Documentation-only commits skip CI, so the claim is about
  every change to the code rather than literally every commit.
- **There is no delete.** No menu item, no keystroke and no route removes a file or a folder. The
  row menu offers New file, New folder, Rename, Duplicate, Move, Copy path and Reveal in Finder —
  plus one "New <template>" entry per registered template, and nothing else; removing a folder from the app removes it from a list, not from your disk. Two things
  qualify that, stated here because a safety claim needing a footnote should carry its own: an edit
  that deletes text is still your edit and is still saved — though a save removing most of a file
  raises a dialog naming the byte count first — and resolving an edit conflict does remove the
  original, but only after its bytes are archived, fsynced, **read back and hash-compared**, leaving
  the original untouched if they disagree.
- **The server has no third-party runtime dependencies.** It is Node's standard library and nothing else. The browser bundle is built from source by `npm run build`; its dependencies are build-time only and never reach the server.
- **It touches only the folders you register**, and makes no network calls off your machine.

## Requirements

**macOS, and Node 24 or newer.**

The macOS part is not incidental and is stated here rather than discovered later. "Reveal in Finder"
shells out to `/usr/bin/open` with no fallback and no platform check; the case-sensitivity probe, the
file-flag handling and several containment tests assume an APFS-shaped filesystem; and reaching the
app from a phone assumes Tailscale. Roughly a dozen unit tests fail on Linux for those reasons. It
may well be worth porting — nothing in the architecture prevents it — but today it is a Mac
application and pretending otherwise wastes an evening.

## Running it

```
cd app
npm ci --ignore-scripts --no-offline
npm run build
npm run serve
```

**`cd app` is not optional** — the `package.json` lives there, not at the repository root, so every
command above fails without it.

**`npm install` on its own will fail, and that is deliberate.** `app/.npmrc` sets `offline=true`, so
no npm command reaches a registry by accident — a control added after an agent pulled three packages
unasked. `--no-offline` is how you say you meant it; `--ignore-scripts` is what CI uses and what you
should too. Read the `.npmrc`: it explains itself at length.

Then open **http://127.0.0.1:8766** and register a folder from Settings. That folder, and whatever is
beneath it, is everything the app can see.

**8766, not 8765**, and the reason is the security model rather than an arbitrary choice. The server
runs two listeners and only one of them serves the interface; the other exists to carry privileged
verbs and deliberately serves no page at all. Opening 8765 in a browser returns `405`, correctly.

The server takes its configuration from the environment, all of it optional:

| Variable | Default | What it does |
|---|---|---|
| `SOIL_PORT_LOCAL` | `8765` | The privileged listener. Serves **no interface** — opening it in a browser is a `405`. |
| `SOIL_PORT_TAILNET` | `8766` | **The one that serves the app.** Named for its other job: fronted by `tailscale serve`, it is how your phone reaches it. |
| `SOIL_STATE_DIR` | `~/.soil-viewer` | Where the app keeps its own state. Must sit outside every folder you register. |
| `SOIL_TAILNET_HOST` | unset | Your machine's MagicDNS name. Required to reach the app from another device — unset, every such request is refused as a bad host. |
| `SOIL_TAILNET_SERVE_PORT` | `443` | The public port `tailscale serve` publishes on. A malformed value **refuses to start** rather than defaulting. |
| `SOIL_BROWSE_HOME` | your home directory | The only area a folder may be registered from. Widening this widens everything the app can reach. |
| `SOIL_DIST_DIR` | `../dist` | Where the built client is read from. |

**Two listeners, and the separation is the security model.** Privilege is decided by which listener a request arrived on, never by anything in the request itself. Routes that are not privileged for a listener are absent from it rather than disabled on it.

## Opening it

Once it is built, **double-click `start-soil-viewer.command`** at the repository root. It opens the app
in your browser if it is already running, starts it if it is not, and if it cannot start, prints the
crash log and what the common lines mean. Started this way, the server lives in that Terminal window:
close the window and it stops. From a terminal the same thing is `npm run open`.

macOS may refuse to open a `.command` file downloaded from the internet the first time ("cannot be
opened because it is from an unidentified developer"). Right-click it and choose Open, once.

**On a phone,** over Tailscale, open the app in Safari and use Share → Add to Home Screen. It installs
as a standalone app with its own icon and no browser chrome — the manifest and icons for that are
already in the build.

## Keeping it running at login (optional)

If you want the server there every time you log in — which is what reaching it from a phone assumes —
install it as a login item, once:

```
npm run always-on
```

That writes a user LaunchAgent for this machine (Node's location, this folder, the state directory),
loads it, and waits for the app to answer. From then on it starts at login and comes back if it ever
stops. `npm run always-on:restart` restarts it; `npm run always-on:off` unloads it and moves its file
aside — nothing is deleted. To reach it from your phone, set `SOIL_TAILNET_HOST` before the install
command and publish the port with `tailscale serve`.

One honest consequence, stated here rather than discovered: with FileVault on, the app returns after a
reboot **once you have unlocked the disk**, not after the reboot alone. `app/ops/README.md` has the
rest — where the logs are, why an environment change needs a reload rather than a restart, and the
gotchas.

## Repository layout

```
00-context/
  context.md   what this is, and the folder shapes it recognises
  spec.md      the architecture and security specification
  design.md    the design packet — screens, tokens, type
app/           the application — source, tests, and its own configuration
  ops/         keeping it running at login — the always-on option
start-soil-viewer.command   double-click to open the app, starting it if needed
```

**`spec.md` is the document the source cites.** A `§7` or `§13.5` in a comment means a section of
it, and `design.md` carries the `§4.x` references. A test fails the build if any citation in the
code points at a section neither document defines.

## Tests

All from `app/`. The browser suites need Playwright's engines installed once:

```
npx playwright install --with-deps chromium webkit
```

Then:

```
npm run test        unit
npm run test:e2e    browser, both engines
npm run ci          everything, including the byte-fidelity gate
```

The byte-fidelity gate needs a tree to measure and a sample drawn from it. `npm run ci` does this for
you; to run the gate alone:

```
npm run mock:soil       build the generated tree
npm run harness:corpus  sample it
npm run harness:gate    run the gate
```

The suites run against that **generated fake tree**, never against your own files. It is written
outside the repository — `~/.soil-viewer-mock/<checkout-name>`, one per checkout, so two clones on one
machine cannot rebuild each other's fixture. `SOIL_MOCK_DIR` overrides it.

The byte-fidelity gate is the one worth knowing about. It puts every file in the corpus through the real editor in a real browser and compares bytes, and it runs three known-lossy editors alongside — one that normalises line endings, one that trims trailing whitespace, one that forces a single trailing newline — requiring the comparison to find **exactly** the files each of them damages. An instrument that reports everything as fine is indistinguishable from one that has stopped measuring.

## A note on the comments

The source carries unusually long explanatory comments. They are deliberate: most record *why* a control is shaped the way it is, and many record a specific way an earlier version was wrong. Where a comment claims a control works, there is generally a test that fails if it stops working. They are the most useful thing in the repository and the first thing to read before changing anything.
