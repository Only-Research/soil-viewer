/**
 * The startup banner. **Its input type has no field for a token, and that is the control.**
 *
 * `main.ts` printed both per-listener tokens here, "for a human wiring something up by hand" — and
 * spec §7's own LaunchAgent recipe redirects stdout to a file, at launchd's umask. Token property 4
 * says never to any log. The deployment the spec prescribes wrote both tokens to one. Found
 * 2026-09-02 by the security reviewer.
 *
 * Now the banner prints where the tokens are (`token-file.ts`: `0600`, in the state directory) and
 * never what they are. Lives one file over from `main.ts` for the reason `allowlist.ts` gives: that
 * file ends in `void main()` and cannot be imported by a test without starting a server, so a
 * decision made in it is testable only from here.
 */

export interface BannerInput {
  readonly host: string
  readonly portLocal: number
  readonly portTailnet: number
  readonly buildStamp: string
  /** The path, never the contents. */
  readonly tokenPath: string
}

export function startupBanner(input: BannerInput): string {
  return (
    'soil-viewer\n' +
    `  local   http://${input.host}:${input.portLocal}\n` +
    `  tailnet http://${input.host}:${input.portTailnet}\n` +
    `  build   ${input.buildStamp}\n` +
    `  tokens  ${input.tokenPath}\n`
  )
}
