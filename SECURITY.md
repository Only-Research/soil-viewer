# Security

## Reporting

Please report suspected vulnerabilities through **GitHub's private vulnerability reporting** on this
repository (Security → Report a vulnerability). That keeps the report private until there is a fix.

Please do not open a public issue for a suspected vulnerability.

## What this software does, so a report can be judged against it

It runs an HTTP server on your own machine and reads and writes the real files in folders you
register. Two listeners:

| | |
|---|---|
| **loopback, 8765** | Serves no interface. Carries verbs, not pages. |
| **8766** | Serves the application. Intended to be fronted by `tailscale serve` so your own other devices can reach it. |

**Privilege is decided by which listener a request arrived on, never by anything in the request.** A
route not carried by a listener is absent from its table rather than refused at runtime — there is no
check to forget.

## Threat model, stated honestly

`00-context/spec.md` §1 is the full version. The parts most likely to matter to a reporter:

- **Any device on your tailnet is trusted.** There is no device pairing and no per-device credential.
  This is a deliberate, recorded decision, not an oversight — but it means "an attacker already on
  the tailnet" is inside the model rather than outside it.
- **The area a folder may be registered from is your home directory and `/Volumes`.** That bound is
  real, and it is worth being clear that a home directory contains `~/.ssh` and similar. The bound
  stops the app being pointed at `/etc`; it does not make registration harmless.
- **The byte-serving endpoint serves any file type** in a registered folder, not only markdown.
- **Local read access is conceded.** Anything that can read your disk can read the app's state.

## Where the interesting surfaces are

If you are looking, these are where the effort has gone and where a finding would be most valuable:

- **Path containment** — `app/src/core/fs/containment.ts` and `app/src/core/paths.ts`. Every segment
  is `lstat`ed, symlinked segments are refused rather than resolved, `O_NOFOLLOW` on every open, and
  `(dev, ino)` re-verified on the descriptor.
- **CSRF** — `app/src/server/guards.ts`. A content-type check makes every cross-origin request
  non-simple, the preflight meets a method check, and `Origin` is default-denied against an allowlist
  derived at startup.
- **Registration** — `app/src/server/root-registry.ts`. The bound is applied to the string before any
  syscall and to the resolved path after.
- **The renderer** — `app/src/client/render/` and `url-safety.ts`. No code path produces a string of
  HTML; the `document` global is reachable from one file.

## Known and accepted

- **Each log has a 1 GiB cap, and at the cap the app stops rather than rotates.** Every request is
  recorded, so a full mutation log fails reads and writes alike until the operator moves the file
  aside and restarts. That is chosen: rotation would let a flood push the records from before it off
  the end. A sustained flood from the tailnet can therefore stop the app, by design; it cannot fill
  the disk or erase the trail.
- **The write body cap covers JSON escaping at 2×.** A document at the 2 MiB editable cap that is
  more than about a fifth raw control characters (other than tab, newline and carriage return) is
  refused at save. It is not text by any reading; covering it would hold 12 MiB per connection.
- **The two session tokens live in `tokens` in the state directory, `0600`.** Anything running as
  you can read them — the same concession as everything else in that directory.
