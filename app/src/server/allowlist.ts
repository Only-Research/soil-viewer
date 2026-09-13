/**
 * Deriving the Host and Origin allowlists from the bind configuration. Spec §7.
 *
 * **This lives here because `main.ts` ends in `void main()`** — it starts a server the moment it is
 * imported, so nothing in it can be unit tested, and a sixth review round found the consequence:
 * `main.ts` has no test anywhere in the suite, and a fix for a defect described in its own commit as
 * *"total, silent, and fail-closed"* was undefended by construction. Reverting the fix left the whole
 * suite green.
 *
 * `main.ts`'s own header already stated the rule this broke: *"Everything policy-shaped lives one
 * file over, so the decisions are testable without a process."* Building an allowlist is
 * policy-shaped. It was in the entry point anyway.
 */

import { asciiLowerCase } from './guards'

export interface BindConfig {
  readonly host: string
  readonly portLocal: number
  readonly portTailnet: number
  /** The MagicDNS name, as typed by a person. `undefined` when unset. */
  readonly magicDns?: string | undefined
  /**
   * The **public** HTTPS port `tailscale serve` publishes on — not the loopback port it targets.
   * Defaults to 443. See `serveAuthority` for why this exists and what it fixes.
   */
  readonly servePort?: number | undefined
}

/** The default HTTPS port. A browser omits it from `Host` and `Origin`, so the allowlist must too. */
const DEFAULT_HTTPS_PORT = 443

/**
 * The authority a browser will actually send when it reaches the app over the tailnet.
 *
 * **This is the third instance of this file's own defect and it was found before `serve` was ever
 * wired, on 2026-08-13.** §18.9 mounts Soil Viewer on its **own** HTTPS port rather than the tailnet
 * root, because `tailscale serve` already proxies `/` to another service on `127.0.0.1:8787` and taking the root
 * would displace an app the operator uses. A browser at `https://name:8443` sends `Host: name:8443` —
 * **with** the port, because it is not the default.
 *
 * `checkHost` is exact set membership on the ASCII-lowercased raw header, and §7 forbids port
 * defaulting **by name** ("no trailing-dot strip, no IDNA, no port defaulting"). So a bare `name` on
 * the allowlist could never match `name:8443`, and **every request from the phone would have been
 * `BAD_HOST`** — total, silent, fail-closed, with no reason on the wire because §6 forbids echoing
 * one. Precisely the failure the two tests above already record, arriving from a third direction.
 *
 * **443 stays bare**, because a browser omits the default port; allowlisting `name:443` would
 * fail-closed just as completely, in the opposite direction.
 *
 * **And the bare name is deliberately NOT admitted alongside a custom port.** `https://name` is that other service
 * — a different app on the same hostname. §18.9 chose a separate port so that *"storage, cookies and
 * service-worker scope stay entirely apart from the other app"*; trusting its origin for a mount
 * Soil Viewer does not have would hand that separation back.
 */
export function serveAuthority(magicDns: string, servePort: number): string {
  return servePort === DEFAULT_HTTPS_PORT ? magicDns : `${magicDns}:${servePort}`
}

/**
 * Reads `SOIL_TAILNET_SERVE_PORT` into either a usable port or an explicit refusal.
 *
 * **This is policy-shaped, so it lives here and not in `main.ts`** — that file ends in `void main()`
 * and cannot be imported without starting a server, which is how the capitalisation defect above went
 * undefended by construction. A refusal nothing can test is a refusal nobody can rely on.
 *
 * **Unset means 443** — the shape before P12, and the correct default.
 *
 * **A malformed value is refused, never absorbed.** The sibling `numberFrom` in `main.ts` folds junk
 * into a sane default, which is right for a loopback port nobody types by hand. It is wrong here: a
 * typo'd `84433` would quietly become 443, the allowlist would carry the bare MagicDNS name, and
 * every request from the phone would be `BAD_HOST` with nothing on the wire to say why. An operator
 * who set this variable meant something by it.
 */
export type ServePortRead =
  | { readonly ok: true; readonly port: number | undefined }
  | { readonly ok: false; readonly raw: string }

export function readServePort(raw: string | undefined): ServePortRead {
  if (raw === undefined) return { ok: true, port: undefined }
  if (!/^[0-9]+$/.test(raw)) return { ok: false, raw }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 && value < 65_536
    ? { ok: true, port: value }
    : { ok: false, raw }
}

export interface Allowlist {
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
}

/**
 * Normalises a host exactly the way the guard that will compare it does.
 *
 * **`asciiLowerCase`, never `toLowerCase`, and the difference is the entire point of this function
 * existing.** Two rounds hit it from opposite sides:
 *
 * - Inserted verbatim, `SOIL_TAILNET_HOST=Mac.tail1234.ts.net` made **every** tailnet request
 *   `BAD_HOST` and every origin `FORBIDDEN_ORIGIN` — total, silent, fail-closed, with no reason on
 *   the wire because §6 forbids echoing one. DNS names are case-insensitive; that capitalisation is
 *   entirely legitimate to type.
 * - Then the fix used `toLowerCase`, which `guards.ts` explicitly forbids: Unicode lowercasing folds
 *   characters into ASCII lookalikes, so `MAK.ts.net` carrying a Kelvin sign (U+212A) becomes the
 *   real `mak.ts.net` under `toLowerCase` and stays `maK.ts.net` under the guard's normaliser. That
 *   both breaks the configured host *and* inserts a domain the operator does not own.
 *
 * Both sides now run the same function, which is the only arrangement that cannot drift.
 */
export function normaliseHost(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : asciiLowerCase(raw)
}

/**
 * Builds both allowlists.
 *
 * The MagicDNS name is added only when supplied. **An unset variable must not become a wildcard:**
 * this is a default-deny list, and the failure mode of guessing is a name nobody verified ending up
 * trusted. Spec §7 — derived at startup from the actual bind config, "never from a request, and
 * never widened at runtime."
 *
 * The tailnet name gets `https://` and only that. `tailscale serve` terminates TLS, so the browser's
 * origin is always the secure one; admitting `http://` as well would trust a scheme the real path
 * never uses.
 */
export function buildAllowlist(config: BindConfig): Allowlist {
  const magicDns = normaliseHost(config.magicDns)
  const { host, portLocal, portTailnet } = config
  const authority = magicDns === undefined
    ? undefined
    : serveAuthority(magicDns, config.servePort ?? DEFAULT_HTTPS_PORT)

  return {
    allowedHosts: [
      `${host}:${portLocal}`, `${host}:${portTailnet}`,
      `localhost:${portLocal}`, `localhost:${portTailnet}`,
      ...(authority === undefined ? [] : [authority]),
    ],
    allowedOrigins: [
      `http://${host}:${portLocal}`, `http://${host}:${portTailnet}`,
      `http://localhost:${portLocal}`, `http://localhost:${portTailnet}`,
      ...(authority === undefined ? [] : [`https://${authority}`]),
    ],
  }
}
