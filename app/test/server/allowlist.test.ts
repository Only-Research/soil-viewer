import { describe, expect, it } from 'vitest'

import { buildAllowlist, normaliseHost, readServePort } from '../../src/server/allowlist'
import { checkHost, checkOrigin } from '../../src/server/guards'

/**
 * The Host/Origin allowlist derivation — spec §7.
 *
 * **This file exists because the code it tests used to live in `main.ts`, which ends in
 * `void main()` and therefore cannot be imported without starting a server.** A sixth adversarial
 * round found the consequence: `main.ts` had no test anywhere in the suite, so a fix for a defect
 * its own commit called *"total, silent, and fail-closed"* could be reverted with the entire suite
 * staying green.
 *
 * The tests below deliberately drive the derivation and **the real guards** together. Checking that
 * `buildAllowlist` lowercases would only restate its implementation; checking that what it produces
 * is accepted by `checkHost` and `checkOrigin` is the property that actually matters, and it is the
 * one that broke.
 */

const CONFIG = { host: '127.0.0.1', portLocal: 8765, portTailnet: 8766 }

describe('what is derived is what the guards will accept', () => {
  it('a MagicDNS name typed with capitals still works — the fail-closed defect', () => {
    /**
     * `SOIL_TAILNET_HOST=Mac.Tail1234.ts.net` inserted verbatim made EVERY tailnet request
     * `BAD_HOST` and every origin `FORBIDDEN_ORIGIN`, because the guard compares against a
     * lowercased Host. Silent and total: the phone shows nothing but refusals and §6 forbids the
     * wire carrying a reason. DNS names are case-insensitive, so the capitals are legitimate.
     */
    const { allowedHosts, allowedOrigins } = buildAllowlist({
      ...CONFIG, magicDns: 'Mac.Tail1234.ts.net',
    })
    const hosts = new Set(allowedHosts)
    const origins = new Set(allowedOrigins)

    // Exactly what a browser would send, in the case that was refused.
    expect(
      checkHost({ host: 'Mac.Tail1234.ts.net' }, hosts).ok,
      'the phone must be able to reach the app',
    ).toBe(true)
    expect(
      checkHost({ host: 'mac.tail1234.ts.net' }, hosts).ok,
      'and so must the all-lowercase form',
    ).toBe(true)
    expect(
      checkOrigin({ origin: 'https://mac.tail1234.ts.net', 'sec-fetch-site': 'same-origin' }, origins).ok,
    ).toBe(true)
  })

  it('uses the guard’s OWN normaliser, not `toLowerCase` — the reintroduced hazard', () => {
    /**
     * The first fix for the above used `toLowerCase()`, which `guards.ts` forbids by name: Unicode
     * lowercasing folds characters into ASCII lookalikes. `MAK.ts.net` with a Kelvin sign (U+212A)
     * becomes the genuine `mak.ts.net` under `toLowerCase` and stays `maK.ts.net` under
     * `asciiLowerCase`.
     *
     * Two harms in one line: the configured host can never match (fail-closed again), and a domain
     * the operator does not own is silently trusted for Host and Origin.
     */
    const kelvin = 'MAK.ts.net'
    const normalised = normaliseHost(kelvin)

    expect(normalised, 'the Kelvin sign must survive as itself').toBe('maK.ts.net')
    expect(normalised, 'and must NOT become the real ASCII domain').not.toBe('mak.ts.net')

    const { allowedHosts } = buildAllowlist({ ...CONFIG, magicDns: kelvin })
    expect(
      new Set(allowedHosts).has('mak.ts.net'),
      'a domain nobody owns must not end up on the allowlist',
    ).toBe(false)
  })

  it('an unset MagicDNS name adds nothing — never a wildcard', () => {
    const { allowedHosts, allowedOrigins } = buildAllowlist({ ...CONFIG, magicDns: undefined })

    expect(allowedHosts).toHaveLength(4)
    expect(allowedOrigins).toHaveLength(4)
    expect(
      checkHost({ host: 'anything.ts.net' }, new Set(allowedHosts)).ok,
      'default-deny: guessing a name is how an unverified host ends up trusted',
    ).toBe(false)
  })

  it('the tailnet origin is https only — `serve` terminates TLS', () => {
    const { allowedOrigins } = buildAllowlist({ ...CONFIG, magicDns: 'mac.ts.net' })
    const origins = new Set(allowedOrigins)

    expect(origins.has('https://mac.ts.net')).toBe(true)
    expect(origins.has('http://mac.ts.net'), 'the real path never uses this scheme').toBe(false)
  })

  it('§18.9: a serve on its OWN port is reachable — the port the phone actually sends', () => {
    /**
     * **The third instance of this file's own defect, found 2026-08-13 before P12 wired `serve`.**
     *
     * §18.9 mounts Soil Viewer on its own HTTPS port rather than the tailnet root, because
     * `tailscale serve` already proxies `/` to another service on `127.0.0.1:8787` and taking the root would
     * displace it. A browser reaching `https://name:8443` sends `Host: name:8443` and
     * `Origin: https://name:8443` — with the port, because it is not 443.
     *
     * §7 forbids port defaulting in `checkHost` by name, and `buildAllowlist` emitted the bare name.
     * So every phone request would have been `BAD_HOST`: total, silent, fail-closed, with no reason
     * on the wire because §6 forbids echoing one. Identical in shape to the capitalisation defect
     * two tests above, arriving from a third direction.
     */
    const { allowedHosts, allowedOrigins } = buildAllowlist({
      ...CONFIG, magicDns: 'mac.tail1234.ts.net', servePort: 8443,
    })
    const hosts = new Set(allowedHosts)
    const origins = new Set(allowedOrigins)

    expect(
      checkHost({ host: 'mac.tail1234.ts.net:8443' }, hosts).ok,
      'the phone must be able to reach the app',
    ).toBe(true)
    expect(
      checkOrigin(
        { origin: 'https://mac.tail1234.ts.net:8443', 'sec-fetch-site': 'same-origin' },
        origins,
      ).ok,
    ).toBe(true)
  })

  it('§18.9: the bare name is NOT trusted when we serve on our own port', () => {
    /**
     * Default-deny, and here it is also origin separation. `https://name` (no port) is **an earlier app**,
     * which owns `/` on this tailnet. §18.9 chose a separate port precisely so that *"storage,
     * cookies and service-worker scope stay entirely apart from the other app"* — admitting the
     * bare origin would hand that separation back for a mount Soil Viewer does not have.
     */
    const { allowedHosts, allowedOrigins } = buildAllowlist({
      ...CONFIG, magicDns: 'mac.tail1234.ts.net', servePort: 8443,
    })

    expect(
      checkHost({ host: 'mac.tail1234.ts.net' }, new Set(allowedHosts)).ok,
      'that host is the other app, not this one',
    ).toBe(false)
    expect(
      checkOrigin(
        { origin: 'https://mac.tail1234.ts.net', 'sec-fetch-site': 'same-origin' },
        new Set(allowedOrigins),
      ).ok,
    ).toBe(false)
  })

  it('§18.9: port 443 stays bare, because that is what a browser sends', () => {
    /**
     * The one case where the bare name is correct: a browser omits the default port. Serving on 443
     * and allowlisting `name:443` would fail-closed just as completely as the defect above, in the
     * opposite direction — so this is not symmetry for its own sake.
     */
    const { allowedHosts, allowedOrigins } = buildAllowlist({
      ...CONFIG, magicDns: 'mac.ts.net', servePort: 443,
    })

    expect(checkHost({ host: 'mac.ts.net' }, new Set(allowedHosts)).ok).toBe(true)
    expect(new Set(allowedOrigins).has('https://mac.ts.net')).toBe(true)
    expect(
      new Set(allowedHosts).has('mac.ts.net:443'),
      'no browser sends this, so trusting it widens the list for nothing',
    ).toBe(false)
  })

  it('an unset serve port means 443 — the shape before P12', () => {
    const { allowedHosts } = buildAllowlist({ ...CONFIG, magicDns: 'mac.ts.net' })
    expect(checkHost({ host: 'mac.ts.net' }, new Set(allowedHosts)).ok).toBe(true)
  })

  it('a malformed serve port is REFUSED, never absorbed into 443', () => {
    /**
     * The whole reason this read is not `numberFrom`. Folding `84433` into 443 would put the bare
     * MagicDNS name on the allowlist and make every phone request `BAD_HOST` — silent, total, and
     * with §6 forbidding a reason on the wire. Each of these must be a refusal the operator sees.
     */
    for (const raw of ['84433', '0', '-1', '8443.0', ' 8443', '8443 ', '0x2103', '1e4', '', 'https']) {
      expect(readServePort(raw).ok, `${JSON.stringify(raw)} must be refused`).toBe(false)
    }

    expect(readServePort(undefined), 'unset means 443, which is the shape before P12')
      .toEqual({ ok: true, port: undefined })
    expect(readServePort('8443')).toEqual({ ok: true, port: 8443 })
    expect(readServePort('443')).toEqual({ ok: true, port: 443 })
    expect(readServePort('65535')).toEqual({ ok: true, port: 65535 })
  })

  it('both loopback ports are reachable, on both host spellings', () => {
    const { allowedHosts } = buildAllowlist(CONFIG)
    const hosts = new Set(allowedHosts)

    for (const host of ['127.0.0.1:8765', '127.0.0.1:8766', 'localhost:8765', 'localhost:8766']) {
      expect(checkHost({ host }, hosts).ok, `${host} must be accepted`).toBe(true)
    }
    expect(checkHost({ host: '127.0.0.1:9999' }, hosts).ok, 'but not a port we never bound')
      .toBe(false)
  })
})
