/**
 * The Funnel status watch. Spec §7's *second* Funnel mechanism.
 *
 * The first is a positive identification — refuse any request carrying `Tailscale-Funnel-Request`
 * (see `guards.ts`). This is the other half:
 *
 * > *"Check the Tailscale LocalAPI at startup and every 60s. If the check cannot be completed,
 * > enter a named **'funnel status unknown'** state and refuse tailnet-listener traffic until it
 * > resolves. The endpoint is documented by Tailscale as not-necessarily-stable, so it MUST NOT be
 * > allowed to fail open — a Tailscale upgrade that changes it would otherwise silently turn the
 * > check into a no-op."*
 *
 * **Fail-closed is the entire design, and it is the part most likely to be softened later.** The
 * tempting shape is "if we cannot tell, assume it is fine" — which turns the control into a no-op
 * on exactly the day it matters, and does so silently. So `unknown` refuses, and it refuses
 * *loudly* enough to have its own error code (`FUNNEL_STATUS_UNKNOWN`) rather than being folded
 * into a generic refusal, because "Tailscale changed its API" and "someone enabled Funnel" need
 * different responses from the operator.
 *
 * Why this matters at all: one mistyped `tailscale funnel` command puts the app on the public
 * internet with **zero authentication**. That is not a gradual degradation; it is the whole threat
 * model inverted by a single command.
 *
 * The prober and the clock are injected. Nothing here talks to Tailscale directly, which is what
 * lets every state transition be tested without the daemon installed — including the ones that
 * only happen when it breaks.
 */

export type FunnelStatus =
  /** Confirmed off. The only state in which tailnet traffic is served. */
  | 'off'
  /** Confirmed on. Refuse everything on the tailnet listener. */
  | 'on'
  /** Could not be determined. Refuse, because a control that cannot report is not a control. */
  | 'unknown'

/** Resolves to whether Funnel is enabled. Rejecting or hanging is a legitimate outcome. */
export type FunnelProbe = () => Promise<boolean>

export interface FunnelWatchOptions {
  readonly probe: FunnelProbe
  /** Spec §7: startup and every 60s. */
  readonly intervalMs?: number
  /** How long a probe may take before it counts as unanswerable. */
  readonly timeoutMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly onChange?: (status: FunnelStatus, previous: FunnelStatus) => void
}

export interface FunnelWatch {
  readonly status: () => FunnelStatus
  /** True only when the status is confirmed `off`. Named for the decision, not the state. */
  readonly tailnetTrafficPermitted: () => boolean
  readonly check: () => Promise<FunnelStatus>
  readonly start: () => void
  readonly stop: () => void
}

/**
 * **Funnel is off by CONFIGURATION, asserted — not by measurement.** Ruled 2026-08-13.
 *
 * §7 asked for a second mechanism: poll the Tailscale LocalAPI every 60 s and refuse tailnet traffic
 * while the answer is unknown. **It cannot be built as specified on this machine.** The LocalAPI it
 * assumes is the open-source daemon's local HTTP socket; this Mac runs the macsys build, where
 * `tailscaled` lives inside a system extension and its API is reached through a native credential
 * handshake. There is no `tailscaled.socket` — looked for, not assumed. The only remaining route is
 * executing the Tailscale CLI every 60 s, which would add a process-execution surface to an app that
 * deliberately has none (§10).
 *
 * **Why the poll was dropped rather than bought at that price** — and the reasoning is the operator's,
 * checked rather than accepted:
 *
 * - **Nothing can force Funnel on from outside.** Enabling it needs the `funnel` node attribute in
 *   the tailnet policy — the admin console, behind their login — **and** a deliberate command run on
 *   this Mac as them. There is no remote switch.
 * - **The only scenario the poll would catch is one §1 already accepts as undefendable:** something
 *   already running as the operator. Such a process can read the files directly; it has no need of Funnel.
 *   So the poll would guard a door in a wall that is already down — a control with nothing behind it,
 *   and this build deletes those.
 * - **It is not standard practice.** No Tailscale convention polls for this; the spec invented it out
 *   of caution. Stated plainly because the first answer given to the operator led with implementation
 *   options and buried that fact.
 *
 * **What still carries the weight, and it is a real control rather than a substitute:** the positive
 * identification in `guards.ts` — any request carrying `Tailscale-Funnel-Request` is refused, and
 * Tailscale strips forged copies before setting it. Mutation-swept 2026-08-13: removing that refusal
 * turns **four** tests red, including a real socket test asserting 403.
 *
 * **This function exists so the assertion cannot be misread as a measurement.** The value it replaces
 * was `async () => false`, which is indistinguishable at the call site from a probe that ran and
 * returned "off" — the exact conflation §7 spends a paragraph forbidding. The name says which it is.
 */
export const funnelOffByConfiguration: FunnelProbe = async () => false

export function createFunnelWatch(options: FunnelWatchOptions): FunnelWatch {
  const intervalMs = options.intervalMs ?? 60_000
  const timeoutMs = options.timeoutMs ?? 5_000
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as never) })

  // Starts UNKNOWN, not `off`. Before the first probe completes we genuinely do not know, and the
  // window between process start and first answer is exactly when an optimistic default would be
  // wrong. Tailnet traffic is refused until something affirmatively says otherwise.
  let status: FunnelStatus = 'unknown'
  let timer: unknown = null
  let running = false
  /**
   * Bumped by `stop()`. A probe issued before a stop must not write its answer afterwards.
   *
   * A generation rather than reusing `running`, because `check()` is public and is called directly
   * on a watch that was never `start()`ed — `bootstrap` and every test do exactly that — so
   * `running` is `false` during a perfectly legitimate check and cannot serve as the gate.
   */
  let generation = 0

  const set = (next: FunnelStatus): void => {
    if (next === status) return
    const previous = status
    status = next
    options.onChange?.(next, previous)
  }

  const check = async (): Promise<FunnelStatus> => {
    // The timeout handle is held so it can be cleared when the probe answers in time. The first
    // version did not clear it, which left one pending timer per probe — every 60 seconds, forever.
    // Harmless to correctness (the race was already settled) and a genuine leak: the handles
    // accumulate and each one keeps the event loop alive. Caught because the fake timer registry in
    // the test still had them queued.
    let timeoutHandle: unknown = null
    const mine = generation
    try {
      // A probe that never settles is indistinguishable from one that failed, and is the more
      // likely shape if the daemon is wedged. Without this race, a hung LocalAPI would leave the
      // watch on its last-known status forever — stale, and stale in the fail-open direction if
      // the last answer happened to be `off`.
      const enabled = await Promise.race([
        options.probe(),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimer(() => { reject(new Error('funnel probe timed out')) }, timeoutMs)
        }),
      ])
      // GATED ON THE GENERATION THIS CHECK BELONGS TO — see `generation` above `check`.
      //
      // `set` happens AFTER an await, so between issuing the probe and writing its answer the watch
      // can have been stopped. Ungated, a probe that resolves `false` after `stop()` overwrote the
      // `'unknown'` that `stop()` had just written, and `tailnetTrafficPermitted()` went back to
      // `true` on a stopped watch — the exact opposite of the property `stop()` documents.
      //
      // Live during shutdown, not theoretical: `bootstrap.ts` calls `stop()` and then awaits
      // `close()` on both servers, and `Server.close()` keeps serving in-flight and already-open
      // keep-alive connections while the listener consults the watch on every request.
      if (mine === generation) set(enabled ? 'on' : 'off')
    } catch {
      // Deliberately not inspected. Any failure — rejection, timeout, a changed endpoint shape, a
      // Tailscale upgrade — is the same answer: we cannot tell, so we refuse. Distinguishing them
      // would invite treating some as benign.
      //
      // Gated too, but note the asymmetry is safe either way: this direction only ever writes the
      // REFUSING status, so a late one cannot re-grant permission.
      if (mine === generation) set('unknown')
    } finally {
      if (timeoutHandle !== null) clearTimer(timeoutHandle)
    }
    return status
  }

  const schedule = (): void => {
    if (!running) return
    timer = setTimer(() => { void check().finally(schedule) }, intervalMs)
  }

  return {
    status: () => status,
    tailnetTrafficPermitted: () => status === 'off',
    check,
    start: () => {
      if (running) return
      running = true
      void check().finally(schedule)
    },
    stop: () => {
      running = false
      // Invalidates any probe still in flight, so its answer cannot land after this.
      generation += 1
      if (timer !== null) clearTimer(timer)
      timer = null
      // Stopping does NOT reset to `off`. A stopped watch knows nothing, and anything consulting it
      // afterwards must see that rather than a stale permission.
      set('unknown')
    },
  }
}
