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

/**
 * The two listener lines are labelled by what a person does with them, not by the listener's internal
 * name. Until 2026-09-13 the app's line was labelled `tailnet`, and a reader took `tailnet
 * http://127.0.0.1:8766` for the phone address — it is the loopback port that `tailscale serve`
 * fronts, and the phone address is whatever `serve` publishes. Only the `tokens` line is parsed by
 * anything (`test/harness/server.ts`); the labels are free to say the true thing.
 */
export function startupBanner(input: BannerInput): string {
  return (
    'soil-viewer\n' +
    `  app         http://${input.host}:${input.portTailnet}   open this one; tailscale serve fronts it for a phone\n` +
    `  privileged  http://${input.host}:${input.portLocal}   serves no page — 405 in a browser, by design\n` +
    `  build       ${input.buildStamp}\n` +
    `  tokens      ${input.tokenPath}\n`
  )
}
