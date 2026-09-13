/**
 * The composition root. The one place that knows how the pieces fit together.
 *
 * **This file is what the P3 review's two "recorded, not fixed" items were waiting for.** Until it
 * existed, the asset map, the root registry and the services were imported by nothing — so
 * build-plan §3's acceptance condition ("no client route resolves a URL to a disk path") was proven
 * at module level with no route to prove it on, and R2's fix (a root may not contain the app's log
 * storage) was unreachable because nothing passed the log's path to the registrar.
 *
 * Everything below is wiring, and wiring is where this build's failures have lived: a control that
 * is correct in isolation and never reached, or reachable and never given what it needs. Two of
 * those were caught in P2 by making the type require them — the tailnet listener cannot be built
 * without a Funnel watch, and the token is shape-checked before it is compared. This file is the
 * caller those types were protecting against.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY:
 *   1. Mint the token first, so nothing can start with an empty one.
 *   2. Open the logs before anything can need to write to them.
 *   3. Load `dist/` and fail hard if it is missing — a server with no client is not a degraded
 *      server, it is a blank page.
 *   4. Build the registry with the log's path reserved, so R2 holds from the first registration.
 *   5. Start the Funnel watch and await its first answer before the tailnet listener accepts
 *      anything. It starts `unknown`, which refuses — so this is about not serving 503s for the
 *      first second, not about safety.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { browseRoots, realPathOf, type BrowseScope } from '../core/fs/browse'
import { ok, type Result } from '../core/errors'
import { splitSegments } from '../core/paths'

/**
 * §11's browsable area. `/Volumes` is macOS's mount point and the app is macOS-only per §2 — named
 * as a constant rather than discovered, so there is no code path that could widen it.
 *
 * ## The environment override, and why it is not a hole
 *
 * `SOIL_BROWSE_HOME` exists so the end-to-end suite can drive Settings → Folders against a sandbox
 * tree. Without it the only browsable area is the operator's **real home directory**, and the standing
 * rule on this build is that tests run against a mock — *"we can use real files that are not my
 * actual files… this is why we have a fake soil."* An e2e that browsed `$HOME` would be reading the
 * real tree to prove a screen works, which is the trade this project does not make.
 *
 * It is not a privilege escalation: **it is read by the server process from its own environment**,
 * and anyone who can set that process's environment can already run arbitrary code as it. It
 * widens nothing that was not already reachable by whoever starts the server. It is not a request
 * field, not a config key, and not settable by any client — those would each be a real hole, and
 * none of them is this.
 *
 * Both halves move together on purpose. An override that changed `home` and left `volumes` at
 * `/Volumes` would leave a test able to enumerate real mounted disks while believing it was
 * sandboxed — the shape of a control that looks applied and is half-applied.
 */
export function browseScopeFor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BrowseScope {
  const override = env['SOIL_BROWSE_HOME']
  if (override === undefined || override === '') return { home: homedir(), volumes: '/Volumes' }

  const volumes = env['SOIL_BROWSE_VOLUMES'] ?? override
  for (const candidate of [override, volumes]) {
    const fault = scopeRootFault(candidate)
    // Thrown at startup, not returned. A misconfigured security boundary must stop the process,
    // because the two ways it fails silently are both worse than not booting: `/` opens the whole
    // disk, and a relative value refuses every browse with `PATH_ESCAPES_ROOT` and no explanation.
    if (fault !== null) {
      throw new Error(`SOIL_BROWSE_HOME/VOLUMES is unusable: ${candidate} — ${fault}`)
    }
  }
  return { home: override, volumes }
}

/**
 * Why a browse-scope root is unusable, or `null`. The security review's C3, 2026-08-09.
 *
 * **`/` is the one that matters, and it is the same trap `registerRoot` already guards.** The scope
 * check asks `isWithin(splitSegments(root), splitSegments(candidate))`, and `splitSegments('/')` is
 * `[]` — so every path on the disk is vacuously "within" it. Measured: with `SOIL_BROWSE_HOME=/`,
 * browsing `/etc` listed 19 directories. `registerRoot` refuses `/` for exactly this reason, in a
 * comment that spells the vacuity out; the rule was written once and applied in one place.
 *
 * A relative value is the quieter failure: it disables browsing entirely, because nothing resolves
 * under it, and says nothing about why. The likely source of both is not an attacker — it is a test
 * variable leaking out of a shell profile or a launch plist into a real run.
 */
function scopeRootFault(candidate: string): string | null {
  if (!isAbsolute(candidate)) return 'not an absolute path'
  if (resolve(candidate) !== candidate) return 'contains . or .. segments'
  if (splitSegments(candidate).length === 0) return 'the filesystem root makes the whole disk browsable'
  return null
}
import { IndexStore } from '../core/index-store'
import { openAppendLog } from '../core/fs/append-log'
import { writeTokenFile } from '../core/fs/token-file'
import { loadDist } from '../core/fs/dist-loader'
import { createAssetMap } from './asset-map'
import { createLiveUpdates } from './live-updates'
import { loadConfigService, restoreRegisteredRoots } from './config-service'
import { createFunnelWatch, type FunnelProbe } from './funnel-watch'
import { createToken } from './guards'
import { MAX_LOG_BYTES, RATE_LIMIT_GLOBAL_BURST, RATE_LIMIT_GLOBAL_PER_SECOND } from './limits'
import { createListener } from './listener'
import { createLocalLog } from './local-log'
import { createMutationLog } from './mutation-log'
import { createRateLimiter } from './rate-limit'
import { createRootRegistry } from './root-registry'
import { createServices } from './services'
import { createSessionStore, type SessionStore } from './session'
import { createStreamRegistry } from './stream'
import type { GuardConfig } from './guards'
import type { Handler, Handlers } from '../contract/router'
import type { Server } from 'node:http'

export interface BootstrapOptions {
  /**
   * **Test-only override for the rate limiter, absent in every shipped path.** See the note on
   * `limiter` below, and `test/e2e/limits.ts` for why the suite needs one and what it costs.
   */
  readonly rateLimit?: { readonly ratePerSecond: number; readonly burst: number }
  /** Where the app keeps its own state. Must be outside every folder the operator registers. */
  readonly stateDir: string
  /** The built client. */
  readonly distDir: string
  /** Hostnames this server answers to. Derived at startup, never from a request — spec §7. */
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  /**
   * How to ask Tailscale whether Funnel is on. Injected so a machine without Tailscale can still
   * start — and so the "cannot tell" path is reachable in a test.
   */
  readonly funnelProbe: FunnelProbe
  /**
   * §11's browsable area — the only part of the disk the folder picker may enumerate **and the only
   * part registration may be pointed at** (the security review's C2, 2026-08-09).
   *
   * **Passed in, not read from the environment here.** `browseScopeFor()` still exists and
   * `main.ts` calls it; what changed is that bootstrap no longer reaches for `process.env` itself.
   * A security boundary should be visible at the call site that sets it — and the practical form of
   * that: the mock-soil harness boots this server against a temp sandbox, and with the scope hidden
   * inside bootstrap it had no way to say so except by mutating global process state.
   *
   * Required rather than defaulted, for the reason `reservedPaths` gives: an optional boundary is
   * one a caller forgets, and a forgotten one here silently means the user's real home directory.
   */
  readonly browseScope: BrowseScope
  /**
   * The clock the session store reclaims by. Injected so the idle window is testable without
   * waiting it out — a test that sleeps for the real window is a test that gets deleted.
   */
  readonly now?: () => number
}

export interface Bootstrapped {
  readonly local: Server
  readonly tailnet: Server
  /**
   * The per-request tokens — **one per listener**, never one shared. The security review's B2.
   *
   * Never logged. **Persisted to `tokenPath` at `0600`** since 2026-09-02, when printing them to
   * stdout was found to land them in the file the spec's own LaunchAgent recipe captures. The
   * client obtains its own through `POST /api/session.start`; these are returned so tests can assert
   * the two are not interchangeable and the harness can authenticate in-process. The entry point
   * prints `tokenPath` and never a token.
   */
  readonly tailnetToken: string
  readonly localToken: string
  /** Where the two tokens are written, one per line, `0600`, in the state directory. */
  readonly tokenPath: string
  readonly buildStamp: string
  readonly shutdown: () => Promise<void>
}

export async function bootstrap(options: BootstrapOptions): Promise<Result<Bootstrapped>> {
  /**
   * 1. THE TOKENS — one PER LISTENER, not one shared. The security review's B2, 2026-08-07.
   *
   * This was a single `guards` object passed to both `createListener` calls, so one token
   * authenticated on both — including the local listener, which carries `folders.register`, spec
   * §11's *"most powerful thing the app does — it's what decides how much of your disk is in play."*
   *
   * Not a live escalation while nothing hands the token out: the local listener is loopback-bound
   * and never a `serve` target. But **both listeners bind `127.0.0.1`**, so the moment the session
   * route exists, a loopback process could bootstrap on the tailnet listener and present the result
   * to the privileged one. The credential carried no privilege distinction at all, and the only
   * thing separating the two levels was the bind.
   *
   * This build's stated principle is that privilege is structural. Two tokens cost two lines.
   */
  const tailnetToken = createToken()
  const localToken = createToken()

  // 2. The logs. Both live in the state directory, which is asserted below to be outside every
  //    registered root — by the registrar, on every registration, rather than once here.
  const mutationPath = join(options.stateDir, 'mutations.log')
  const localPath = join(options.stateDir, 'local.log')

  const mutationSink = await openAppendLog(mutationPath, [], { maxBytes: MAX_LOG_BYTES })
  if (!mutationSink.ok) return mutationSink
  const localSink = await openAppendLog(localPath, [], { maxBytes: MAX_LOG_BYTES })
  if (!localSink.ok) return localSink

  const mutationLog = createMutationLog(mutationSink.value)
  const localLog = createLocalLog(localSink.value)

  // 2b. The token file — spec §7 properties 3 and 4. `token-file.ts` says why it is a file at all.
  const tokenPath = join(options.stateDir, 'tokens')
  const tokensWritten = await writeTokenFile(tokenPath, [
    `tailnet ${tailnetToken}`,
    `local   ${localToken}`,
  ])
  if (!tokensWritten.ok) return tokensWritten

  // 3. The client. A missing or unstamped build is a hard failure: a server with no client is not
  //    a degraded server, it is a blank page — and a blank page is this build's signature failure.
  const loaded = await loadDist(options.distDir)
  if (!loaded.ok) return loaded
  const assets = createAssetMap(loaded.value.assets)

  // 4. The registry, with BOTH log paths reserved. This is R2: a root that contains or sits inside
  //    the app's own state is refused at registration, because `openAppendLog` checks only once and
  //    a folder registered afterwards would otherwise put the log inside a root forever.
  const registryPath = join(options.stateDir, 'registry.json')
  const uiStatePath = join(options.stateDir, 'ui-state.json')

  // **Both config files are reserved alongside the logs.** R2 says a root may not contain the app's
  // own state, and it says it about whatever the app writes — not about the two files that happened
  // to exist when the rule was written. A registry file inside a registered root would be indexed,
  // watched, and editable in the app that depends on it.
  const browseScope = options.browseScope
  const registry = createRootRegistry({
    reservedPaths: [mutationPath, localPath, registryPath, uiStatePath, tokenPath],
    // The same two areas the folder picker offers. The security review's C2: registration decides how much of the
    // disk is in play, and until P7 nothing bounded it — computed once here so the verb and the
    // browser cannot drift onto different answers.
    browsableRoots: browseRoots(browseScope),
    // Resolved once at startup rather than per registration: the areas do not move while the
    // process runs, and a syscall per attempt would be work on a path that must fail closed.
    browsableRootsResolved: await Promise.all(browseRoots(browseScope).map(realPathOf)),
  })
  const index = new IndexStore()
  /**
   * Where the app keeps its own working files. Spec §13.7 and §13.5.
   *
   * `~/Library/Application Support/SoilViewer` is the standard location for a Mac app's working
   * data — same volume as the user's home directory, outside anything they would register, and not
   * a novel choice anyone has to reason about later. The operator was consulted on 2026-08-08; the
   * placement is the builder's call and the only question genuinely open — whether to keep
   * working folders on external drives — is handled by `staging.ts` resolving a scratch area per
   * volume rather than by this path.
   *
   * Both are validated against the registered roots on every use, not just here: a folder
   * registered later can swallow a location that was fine at startup.
   */
  const appStorage = join(homedir(), 'Library', 'Application Support', 'SoilViewer')

  /**
   * 4b. THE APP'S MEMORY OF ITSELF, and the folders from the last run.
   *
   * Until 2026-08-08 the registry lived in a `Map` and nothing read or wrote a config file: add a
   * folder, stop the app, it is forgotten. `config-store.ts` had been complete and imported by
   * nothing since P4 opened.
   *
   * **Damage does not stop startup.** §13.8 requires a config that fails to parse be *preserved and
   * surfaced*; an app that refuses to open cannot surface anything. It comes up with no folders,
   * every write to the damaged file refused so the bytes survive, and the reason in the local log
   * until there is a screen to put it on.
   */
  const config = await loadConfigService({ registryPath, uiStatePath })
  for (const [file, damage] of [
    ['registry', config.registryDamage], ['ui-state', config.uiStateDamage],
  ] as const) {
    if (damage === null) continue
    void localLog.write({
      timestamp: new Date().toISOString(), level: 'error',
      at: `config:${file}`,
      detail: `${damage} — the file has NOT been overwritten and is at ${
        file === 'registry' ? registryPath : uiStatePath}`,
    })
  }

  /**
   * 4c. LIVE UPDATES — the watcher, the reconciler and the broadcast, connected.
   *
   * All three were complete, tested, mutation-swept and **called by no production module**. The
   * stream registry is built below, so `broadcast` is reached through a closure rather than by
   * moving the registry's construction up: the registry needs `localLog`, which needs to exist
   * before it, and the ordering at the top of this file is not decoration.
   */
  let streamsRef: ReturnType<typeof createStreamRegistry> | null = null
  const live = createLiveUpdates({
    index,
    broadcast: event => { streamsRef?.broadcast(event) },
    onProblem: (at, detail) => {
      void localLog.write({ timestamp: new Date().toISOString(), level: 'warn', at, detail })
    },
  })

  const services = createServices(
    registry,
    index,
    {
      stagingRoot: join(appStorage, 'scratch'),
      archiveRoot: join(appStorage, 'archive'),
      /**
       * §11's browsable area, resolved here because this is the layer that is allowed to read the
       * environment. `/Volumes` is macOS's mount point and the app is macOS-only per §2 — named as
       * a constant rather than discovered, so there is no code path that could widen it.
       */
      browseScope,
    },
    config,
    (at, detail) => {
      void localLog.write({ timestamp: new Date().toISOString(), level: 'warn', at, detail })
    },
    live,
  )

  /**
   * The folders the operator registered last time, back — and indexed, so the read routes answer for
   * them rather than answering `[]` out of an empty index.
   *
   * A folder that fails to restore is reported and **left in the file**: an unplugged drive must
   * not permanently erase the fact that it was registered. Restoring blocks startup for the length
   * of the walk, which is the same known limit `folders.register` carries and lands with the same
   * surface (§5's streaming index, P4 item 8).
   */
  const restore = await restoreRegisteredRoots(config, registry, index)
  // Watched from the moment they are back. A restored folder that is not watched is one whose
  // changes never reach the phone until it is deregistered and added again.
  for (const root of registry.list()) live.watch(root)
  for (const failure of restore.failed) {
    void localLog.write({
      timestamp: new Date().toISOString(), level: 'warn', at: 'config:restore',
      detail: `folder "${failure.id}" could not be restored and was KEPT in the registry: ${failure.reason}`,
    })
  }
  if (restore.layoutNotUpdated !== undefined) {
    void localLog.write({
      timestamp: new Date().toISOString(), level: 'warn', at: 'config:layout',
      detail: `the saved layout could not be brought up to date: ${restore.layoutNotUpdated}`,
    })
  }

  /**
   * Handlers, built per listener so each session route is bound to **its own** token and store.
   *
   * The previous line here was `const handlers = services as unknown as Handlers`, and the security review flagged
   * it while ruling on B1: a double cast erases the totality check that `router.ts` and `routes.ts`
   * both advertise — *"a route declared here without a handler is a compile error."* With the cast,
   * adding a route to the table and no handler compiled fine and threw at dispatch.
   *
   * That guarantee is load-bearing for B1, so it is restored the narrow way: the **object literal**
   * is checked against `Handlers` (total over `RouteName`, so a missing key is a compile error), and
   * only each individual value is cast — because `Handler` takes `never` and the service functions
   * take their own input types, which is the mismatch the original cast was papering over.
   */
  const asHandler = <T>(fn: (input: T) => unknown): Handler => fn as Handler

  const handlersFor = (sessionStore: SessionStore): Handlers => ({
    'session.start': asHandler(() => {
      const started = sessionStore.start()
      if (!started.ok) {
        // Thrown, so the router answers 500 and the local log records it. The reason carries
        // NEITHER credential — `local-log.ts` emits an Error's message and stack verbatim, and §7
        // token property 4 is a MUST. B4.
        throw new Error(`session could not be started: ${started.reason}`)
      }
      return started.session
    }),
    'folders.list': asHandler(services['folders.list']),
    'tree.children': asHandler(services['tree.children']),
    'tree.entry': asHandler(services['tree.entry']),
    'tree.count': asHandler(services['tree.count']),
    'folders.register': asHandler(services['folders.register']),
    'folders.deregister': asHandler(services['folders.deregister']),
    // Phase 8's templates. Three registry verbs and no fourth: scaffolding from a template is an
    // ordinary `entry.copy`, because a template IS a pointer to a folder. See `contract/routes.ts`.
    'templates.list': asHandler(services['templates.list']),
    'templates.register': asHandler(services['templates.register']),
    'templates.deregister': asHandler(services['templates.deregister']),
    // Phase 4's write routes. **Carried on both listeners since 2026-08-09** — the ruling,
    // and before it they were `local-only`, which meant reachable by nothing at all: the client is
    // served only by the tailnet listener. See the note above the routes in `contract/routes.ts`.
    'board.lanes': asHandler(services['board.lanes']),
    'board.selection': asHandler(services['board.selection']),
    'board.setSelection': asHandler(services['board.setSelection']),
    'config.health': asHandler(services['config.health']),
    'search.quickOpen': asHandler(services['search.quickOpen']),
    'board.columns': asHandler(services['board.columns']),
    'board.cardsFor': asHandler(services['board.cardsFor']),
    'inbox.list': asHandler(services['inbox.list']),
    'boards.list': asHandler(services['boards.list']),
    'boards.open': asHandler(services['boards.open']),
    'boards.setOrder': asHandler(services['boards.setOrder']),
    'boards.setColumnOrder': asHandler(services['boards.setColumnOrder']),
    'projects.list': asHandler(services['projects.list']),
    'projects.board': asHandler(services['projects.board']),
    'projects.setColumns': asHandler(services['projects.setColumns']),
    'projects.place': asHandler(services['projects.place']),
    'projects.stage': asHandler(services['projects.stage']),
    'projects.unstage': asHandler(services['projects.unstage']),
    'board.cards': asHandler(services['board.cards']),
    'card.move': asHandler(services['card.move']),
    'card.create': asHandler(services['card.create']),
    'chatroom.append': asHandler(services['chatroom.append']),
    'file.reveal': asHandler(services['file.reveal']),
    'file.load': asHandler(services['file.load']),
    'file.save': asHandler(services['file.save']),
    // P7's registration and creation verbs. `both`, like everything else — registering a handler
    // here has never been what decides reachability; the carriage in `routes.ts` is.
    'folders.browse': asHandler(services['folders.browse']),
    'entry.create': asHandler(services['entry.create']),
    'entry.rename': asHandler(services['entry.rename']),
    'entry.copy': asHandler(services['entry.copy']),
    'conflict.resolve': asHandler(services['conflict.resolve']),
  })

  // Spread rather than passed directly: `exactOptionalPropertyTypes` distinguishes "absent" from
  // "present and undefined", and the store's default clock is what should apply when it is absent.
  const clock = options.now === undefined ? {} : { now: options.now }
  const tailnetSessions = createSessionStore({ token: tailnetToken, ...clock })
  const localSessions = createSessionStore({ token: localToken, ...clock })

  // 5. Funnel. Started and awaited before the tailnet listener serves, so the first request does
  //    not meet a 503 that only means "we have not asked yet".
  const funnelWatch = createFunnelWatch({ probe: options.funnelProbe })
  funnelWatch.start()
  await funnelWatch.check()

  /**
   * 6. The live-update registry — on the TAILNET listener only, because that is the only listener
   *    that serves a client and therefore the only one anything could open a stream from.
   *
   *    A dropped or discarded event goes to the local log rather than vanishing. The security review's S5: the
   *    drop itself is correct, but an event disappearing without a trace is R3's lesson (a 500 that
   *    left no record anywhere) reappearing in the event channel.
   */
  const streams = createStreamRegistry({
    allowedOrigins: new Set(options.allowedOrigins),
    onDropped: (reason, detail) => {
      void localLog.write({
        timestamp: new Date().toISOString(), level: 'warn', at: `stream:${reason}`, detail,
      })
    },
  })
  // Closing the loop opened at step 4c. Assigned rather than passed because the watcher had to
  // exist before the services that start it, and the registry has to exist after the log.
  streamsRef = streams

  const guardsFor = (token: string): GuardConfig => ({
    allowedHosts: new Set(options.allowedHosts),
    allowedOrigins: new Set(options.allowedOrigins),
    token,
  })

  /**
   * **The shipped numbers, unless a caller passes others.** Ruled 2026-08-14.
   *
   * The only caller that passes any is `main.ts`, reading two environment variables the **e2e
   * harness** sets — see `test/e2e/limits.ts` for why the suite needs its own, and for the cost of
   * that decision stated plainly. Absent those variables this is exactly what it was: an option with
   * a default, not a new configuration surface, and nothing a person installs can reach it.
   */
  const limiter = (): ReturnType<typeof createRateLimiter> => createRateLimiter({
    ratePerSecond: options.rateLimit?.ratePerSecond ?? RATE_LIMIT_GLOBAL_PER_SECOND,
    burst: options.rateLimit?.burst ?? RATE_LIMIT_GLOBAL_BURST,
    now: () => Date.now(),
  })

  // The LOCAL listener serves no UI — the client is reached
  // through the tailnet listener, which is the sole `serve` target. Privilege is decided by which
  // listener accepted the connection, and `createRouter('local')` is the only one holding those
  // handlers at all.
  const local = createListener({
    privilege: 'local', handlers: handlersFor(localSessions), guards: guardsFor(localToken),
    rateLimiter: limiter(), mutationLog, localLog, sessions: localSessions,
  })

  const tailnet = createListener({
    privilege: 'tailnet', handlers: handlersFor(tailnetSessions), guards: guardsFor(tailnetToken),
    rateLimiter: limiter(), mutationLog, localLog, sessions: tailnetSessions,
    funnelWatch, assets, streams,
    /**
     * §9's byte endpoint, on the **tailnet** listener only.
     *
     * Not a privilege decision — it is where the client is. The local listener serves no UI, so
     * nothing there would ever build an `<img>`; giving it the route would add a second door to the
     * same bytes with no caller. `tailnetSessions` is passed rather than a shared store because
     * tickets are per-listener (the security review's B2), and a route verifying against the wrong store would
     * accept a credential minted for a different door.
     */
    fileRoute: {
      sessions: tailnetSessions,
      rootFor: id => registry.get(id) ?? null,
    },
  })

  const shutdown = async (): Promise<void> => {
    funnelWatch.stop()
    // Before the streams: a watcher that fires during teardown would reconcile against an index
    // nobody will read and broadcast to sinks that are closing.
    live.stop()
    // Before closing the servers: the registry holds a heartbeat timer while any stream is open, and
    // a live timer keeps the process alive after `close()` has resolved.
    streams.stop()
    await Promise.all([
      new Promise<void>(resolve => { local.close(() => resolve()) }),
      new Promise<void>(resolve => { tailnet.close(() => resolve()) }),
    ])
  }

  /*
   * REMOVED 2026-08-07: a `buildStamp === ''` check used to sit here, and it was unreachable.
   *
   * `loadDist` already refuses an empty or unreplaced stamp and returns before producing a value at
   * all, so this branch could not fire. It was also in the wrong place to fire *from*: it ran after
   * the Funnel watch had scheduled a non-`unref`'d 60-second timer and after both listeners and both
   * log handles existed, so a failure here would have returned an error while leaving a live timer
   * holding the process open — with `main.ts` having already decided to exit.
   *
   * The rule this violated is stated in this file's own header: order matters, and the `dist/` load
   * is step 3. A check belongs beside the thing it checks, not at the end where its failure path is
   * a different failure.
   */

  return ok({
    local, tailnet, tailnetToken, localToken, tokenPath, buildStamp: loaded.value.buildStamp, shutdown,
  })
}
