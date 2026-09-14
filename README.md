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

**On a phone** it is the same server reached over Tailscale, which takes a setup of its own — the
section "Reaching it from your phone" below has all of it. Nothing about the Mac-only path needs it.

## Keeping it running at login (optional)

If you want the server there every time you log in — which is what reaching it from a phone assumes —
install it as a login item, once:

```
npm run always-on
```

That writes a user LaunchAgent for this machine (Node's location, this folder, the state directory),
loads it, and waits for the app to answer. From then on it starts at login and comes back if it ever
stops. `npm run always-on:restart` restarts it; `npm run always-on:off` unloads it and moves its file
aside — nothing is deleted. If the phone is part of the plan, read the next section **before** running
the install command: the Mac's Tailscale name has to be in the environment at install time.

One honest consequence, stated here rather than discovered: with FileVault on, the app returns after a
reboot **once you have unlocked the disk**, not after the reboot alone. `app/ops/README.md` has the
rest — where the logs are, why an environment change needs a reload rather than a restart, and the
gotchas.

## Reaching it from your phone (optional) — the Tailscale setup

You do not need any of this to use the app on your Mac. It is for reaching the same server from your
phone, and it is written so you can hand it whole to whoever — or whatever — sets your machine up.

The app never speaks HTTPS itself. It listens on the Mac's own loopback address, in plain HTTP, and
nothing else. **Tailscale provides the HTTPS**, and the phone needs HTTPS: iPhone Safari treats a
plain-http page as insecure and withholds the clipboard, the service worker and a real Add to Home
Screen. Tailnet traffic is encrypted either way — HTTPS here is about the phone browser's rules, not
secrecy.

**Before anything, three things have to be true:**

1. **Tailscale is installed and signed in on both the Mac and the phone**, on the same tailnet.
2. **HTTPS Certificates are enabled for your tailnet.** This is a switch in the Tailscale admin console,
   under DNS, and it is **off by default**; MagicDNS has to be on for it. Check from the Mac with
   `tailscale status --json` — if `"CertDomains"` is `null`, it is not enabled, and `tailscale serve`
   publishes nothing until it is.
3. **You know your Mac's MagicDNS name** — `your-mac.your-tailnet.ts.net`, lowercase, shown by
   `tailscale status` and in the admin console. The app refuses any request not addressed to exactly
   this name.

On a Mac where `tailscale` is not on the PATH, the command lives inside the app:
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

**Publish the port — once; it persists:**

```
tailscale serve --bg 8766
```

That publishes `https://your-mac.your-tailnet.ts.net` (port 443) to your tailnet only and forwards it
to the app on 8766; Tailscale terminates the HTTPS with a certificate it issues for your Mac.
`tailscale serve status` shows it. The configuration lives in Tailscale's own state, not in this
repository — it survives reboots, and nothing here re-creates it if it is removed. Two things to know:

- **Never run `tailscale serve reset`.** It removes every published service on the machine, not just
  this one. To remove only this: `tailscale serve --https=443 off`.
- **This is `serve`, not `funnel`.** `serve` is tailnet-only. `funnel` would put the app on the public
  internet; the app is not built for that and must never be exposed that way.

**If port 443 is already in use on your Mac** — another `serve` mount, say — pick another port and
carry it into the next step:

```
tailscale serve --bg --https=8443 8766
```

The phone address then carries the port: `https://your-mac.your-tailnet.ts.net:8443`.

**Tell the app its name.** The server refuses any request whose Host is not one it knows — that is
the security model, not a setting to loosen — so it has to be told the MagicDNS name, and the port if
you changed it. Both have to be in the environment when the server starts, which for always-on means
at install time:

```
SOIL_TAILNET_HOST=your-mac.your-tailnet.ts.net npm run always-on
```

With a non-default port, add `SOIL_TAILNET_SERVE_PORT=8443` in front of the same command. Running by
hand instead, the same variables go in front of `npm run serve`. **The name and port must match what
`serve` publishes, exactly.** A mismatch is refused as a bad host, and `~/.soil-viewer/local.log`
says so. To change either later: `npm run always-on:off`, then `npm run always-on` again — a restart
keeps the old environment, only a reload takes the new one.

**On the phone:** open `https://your-mac.your-tailnet.ts.net` (with the port, if you set one) in
Safari, then Share → Add to Home Screen. It installs as a standalone app with its own icon and no
browser chrome — the manifest and icons for that are already in the build. Installing it is not
cosmetic: a plain Safari tab on a phone loses its unsaved-edit buffer after seven idle days; a Home
Screen install keeps it.

**What this does and does not change.** Only devices on your tailnet can reach it. The app still sees
only the folders you registered. The startup banner's `app` line — `http://127.0.0.1:8766` — is the
local port that `serve` fronts, not the phone address. The Mac has to be awake: asleep, the phone gets
nothing (screen lock is fine, sleep is not). With FileVault on, after a reboot the app returns once you
have unlocked the disk.

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
