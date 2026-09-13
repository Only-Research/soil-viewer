/**
 * The executable entry point. Boots the server and binds both listeners.
 *
 * Thin on purpose: `bootstrap.ts` is the composition root and this is the only thing that reads the
 * environment, picks ports and calls `listen`. Everything policy-shaped lives one file over, so the
 * decisions are testable without a process.
 *
 * Spec §2: the shipped product runs **the built bundle plus this zero-dependency Node server**,
 * never the Vite dev server. That distinction is why this file exists now rather than at P12 — the
 * e2e tests were pointed at the dev server, which is a thing no user ever executes.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { ensureDirectory } from '../core/fs/append-log'
import { browseScopeFor, bootstrap } from './bootstrap'
import { buildAllowlist, readServePort } from './allowlist'
import { readRateLimitOverride } from './limits'
import { funnelOffByConfiguration } from './funnel-watch'
import { startupBanner } from './startup-banner'

/** Spec §7: loopback only. `tailscale serve` is the sole tailnet path, and it targets PORT_TAILNET. */
const HOST = '127.0.0.1'

const numberFrom = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  // Same reasoning as the Content-Length parser: `Number()` accepts '1e9', ' 80 ' and '0x50'.
  if (!/^[0-9]+$/.test(raw)) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 && value < 65_536 ? value : fallback
}

async function main(): Promise<void> {
  const portLocal = numberFrom(process.env['SOIL_PORT_LOCAL'], 8765)
  const portTailnet = numberFrom(process.env['SOIL_PORT_TAILNET'], 8766)

  /**
   * The **public** port `tailscale serve` publishes on — §18.9's "its own HTTPS port". The read and
   * its refusal live in `allowlist.ts`, where they can be tested without starting a process.
   */
  /**
   * **The e2e harness's rate limit, and nothing else's.** Ruled 2026-08-14.
   *
   * Both variables must be present and both must be usable, or the server **refuses to start**. A
   * half-applied override is the shape this build refuses everywhere: a server that quietly ran with
   * one of the two numbers changed would be measuring something nobody chose, and the suite would
   * report on it as though it were the product.
   *
   * `test/e2e/limits.ts` holds the values and the argument for them, including what running the
   * browser tests above the shipped size costs. Absent these variables — which is every install,
   * every `npm run serve`, and the LaunchAgent — the shipped constants stand untouched.
   */
  const rateLimitOverride = readRateLimitOverride(process.env)
  if (!rateLimitOverride.ok) {
    process.stderr.write(`soil-viewer: ${rateLimitOverride.detail}\n`)
    process.exitCode = 1
    return
  }

  const servePortRead = readServePort(process.env['SOIL_TAILNET_SERVE_PORT'])
  if (!servePortRead.ok) {
    process.stderr.write(
      `soil-viewer: SOIL_TAILNET_SERVE_PORT is not a usable port: ${JSON.stringify(servePortRead.raw)}\n`,
    )
    process.exitCode = 1
    return
  }

  const stateDir = process.env['SOIL_STATE_DIR'] ?? join(homedir(), '.soil-viewer')

  /**
   * ONE level up, not two. This bundle is emitted to `app/dist-server/main.js` and the client to
   * `app/dist/`, so the sibling is `../dist`.
   *
   * It read `'..', '..', 'dist'` until the e2e harness ran `npm run serve` with no environment set,
   * which is the way a user runs it — and it resolved to `apps/soil-viewer/dist`, a directory that
   * has never existed. So the plain `npm run serve` path was broken, and it looked verified because
   * every check of it had passed `SOIL_DIST_DIR` explicitly. The default was the one configuration
   * nothing exercised, which is exactly the configuration a user gets.
   *
   * `loadDist` hard-fails on a missing directory rather than serving nothing, so this surfaced as a
   * clear refusal to start instead of an app with no client. That part worked as designed.
   */
  const distDir = process.env['SOIL_DIST_DIR'] ?? join(import.meta.dirname, '..', 'dist')

  // Through the sanctioned fs module, not `node:fs` directly — the import ban caught this entry
  // point reaching for it, and "it is only mkdir" is how the second filesystem call ends up
  // somewhere else.
  const prepared = await ensureDirectory(stateDir)
  if (!prepared.ok) {
    process.stderr.write(`soil-viewer cannot use its state directory: ${prepared.detail ?? prepared.code}\n`)
    process.exitCode = 1
    return
  }

  /**
   * The allowlist, derived at startup from the actual bind config — spec §7, "never from a request,
   * and never widened at runtime."
   *
   * The derivation itself lives in `allowlist.ts`, because this file ends in `void main()` and so
   * cannot be imported by a test without starting a server. That is not tidiness: a sixth review
   * round found that the normalisation fix living here had no proof clause anywhere in the suite,
   * and reverting it left everything green. This file's own header states the rule —
   * *"everything policy-shaped lives one file over, so the decisions are testable without a
   * process"* — and an allowlist is policy-shaped.
   */
  const { allowedHosts, allowedOrigins } = buildAllowlist({
    host: HOST,
    portLocal,
    portTailnet,
    magicDns: process.env['SOIL_TAILNET_HOST'],
    servePort: servePortRead.port,
  })

  const started = await bootstrap({
    // The one place the environment decides the browsable area. See `browseScopeFor`.
    browseScope: browseScopeFor(),
    stateDir,
    distDir,
    allowedHosts,
    allowedOrigins,
    /**
     * **Funnel is asserted off by configuration, and the 60-second poll was CUT** — the operator's
     * ruling, 2026-08-13, after the LocalAPI §7 assumed was found not to exist on this Tailscale
     * build. The full reasoning, including why the remaining control is sufficient, is on
     * `funnelOffByConfiguration` itself; the name is deliberately one that cannot be read as a
     * measurement.
     */
    funnelProbe: funnelOffByConfiguration,
    ...(rateLimitOverride.value === null ? {} : { rateLimit: rateLimitOverride.value }),
  })

  if (!started.ok) {
    // Fail loudly and exit non-zero. A server that starts without its client, or without a place to
    // write its logs, is not a degraded server — it is a blank page with no record of why.
    process.stderr.write(`soil-viewer failed to start: ${started.code} ${started.detail ?? ''}\n`)
    process.exitCode = 1
    return
  }

  started.value.local.listen(portLocal, HOST)
  started.value.tailnet.listen(portTailnet, HOST)

  /**
   * The tokens' PATH goes to stdout once, at startup — never a token (§7 property 4). Until
   * 2026-09-02 both tokens were printed here "for a human wiring something up by hand", and the
   * spec's own LaunchAgent recipe redirects stdout to a file at launchd's umask: the prescribed
   * deployment wrote both tokens into a world-readable log. They now live at `tokenPath`, `0600`,
   * and the banner — `startup-banner.ts`, testable because this file is not — says where.
   *
   * **The client no longer needs this line.** It obtains its own credentials from
   * `POST /api/session.start`, which is what makes them re-fetchable without a page reload — the
   * property that stops a Mac restart bricking an installed iOS web app that is resumed and never
   * relaunched. The path is printed for a human wiring something up by hand.
   *
   * Two of them, one per listener (the security review's B2). The local one authenticates on the listener that
   * serves no client; the tailnet one does. `folders.register` is carried by BOTH — the sentence
   * here claimed a separation that the route table does not have. What actually keeps the local
   * token unobtainable is that `session.start` is tailnet-only. The point.
   */
  process.stdout.write(startupBanner({
    host: HOST,
    portLocal,
    portTailnet,
    buildStamp: started.value.buildStamp,
    tokenPath: started.value.tokenPath,
  }))

  const stop = (): void => { void started.value.shutdown().then(() => process.exit(0)) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

void main()
