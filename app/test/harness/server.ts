/**
 * Starts the real product for the chain test, and captures the one credential nothing else can give.
 *
 * ## Why this exists instead of a `webServer` entry
 *
 * `file.load` and `file.save` are **local-only** (spec §7 as it stands — the routes file records
 * this as a holding position, since the phone is eventually meant to reach editing). The local
 * listener has its own token, separate from the tailnet one, and **`session.start` is tailnet-only**,
 * so there is no request that obtains the local token. It is written to a `0600` file in the state
 * directory at startup, and the banner prints that file's path — never a token, because §7's token
 * property 4 is a MUST and the LaunchAgent recipe captures the banner to a file (2026-09-02).
 *
 * That is a deliberate design and the test has to live with it rather than around it. Playwright's
 * `webServer` gives no access to a server's stdout, so the chain test starts the process itself,
 * reads the path off the banner, and reads the file.
 *
 * **What was NOT done, and why it is worth saying:** the easy alternative is an environment variable
 * that fixes the token, or a route that hands it out. Either would put a hole in the credential
 * separation the security review's B2 exists to create, in production code, to make a test easier. The test is the
 * thing that should bend.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PORT_LOCAL, PORT_TAILNET } from './ports'

export interface RunningServer {
  readonly localToken: string
  readonly tailnetToken: string
  readonly stop: () => void
}

/** Matches the banner line that names the token FILE. The tokens themselves are never printed. */
const TOKEN_PATH = /^\s*tokens\s+(\S+)\s*$/m
/** The file's two lines. Anchored, so a token cannot be read out of prose. */
const TAILNET_TOKEN = /^tailnet\s+([0-9a-f]{32})$/m
const LOCAL_TOKEN = /^local\s+([0-9a-f]{32})$/m

export async function startProductServer(): Promise<RunningServer> {
  /**
   * **No build here.** It happens once in `test/harness/global-setup.ts`, before any test runs, and
   * emits to `dist-e2e/` and `dist-server-e2e/` rather than to the bundle the installed server
   * loads. Both halves of that matter, and the second is the one that took a mutation to find — see
   * that file for why a per-call build made the isolation guard pass by accident of scheduling.
   */
  /**
   * A fresh state directory. Unset, `main.ts` defaults to `~/.soil-viewer` — so this run would write
   * its mutation log into the real installation's state, and the chain test *registers folders*,
   * which would leave temp paths registered in the user's actual app.
   */
  const stateDir = mkdtempSync(join(tmpdir(), 'soil-viewer-chain-state-'))

  /**
   * The suite's own server bundle, serving the suite's own client — the pair `build:e2e` just
   * emitted. `SOIL_DIST_DIR` must be set with it: `main.ts` defaults the client directory to the
   * sibling of wherever the server bundle sits, which for `dist-server-e2e/` would be `dist-e2e/`
   * anyway — but defaulting to the right answer by coincidence is how the wrong one arrives after a
   * later edit. Stated, so it cannot drift.
   */
  const child: ChildProcess = spawn('node', ['dist-server-e2e/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SOIL_DIST_DIR: 'dist-e2e',
      SOIL_PORT_LOCAL: String(PORT_LOCAL),
      SOIL_PORT_TAILNET: String(PORT_TAILNET),
      SOIL_STATE_DIR: stateDir,
      /**
       * The browsable area is the temp directory, not `$HOME`. The chain specs register roots they
       * create under `tmpdir()`, and the product's default scope is the home directory and
       * `/Volumes` — so with `TMPDIR` at the macOS default (`/var/folders/…`, which resolves to
       * `/private/var`) every registration was refused `PATH_ESCAPES_ROOT`, correctly. Found
       * 2026-09-03, the first time the gate ran from a shell whose `TMPDIR` was not under the home
       * directory. The same sandboxing the bootstrap test has always done — never `$HOME`.
       *
       * Unresolved on purpose: the specs pass unresolved strings, and the registrar applies the
       * string bound before the resolved one.
       */
      SOIL_BROWSE_HOME: tmpdir(),
      SOIL_BROWSE_VOLUMES: tmpdir(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stop = (): void => {
    child.kill('SIGTERM')
    rmSync(stateDir, { recursive: true, force: true })
  }

  return await new Promise<RunningServer>((resolve, reject) => {
    let output = ''
    let settled = false

    const fail = (reason: string): void => {
      if (settled) return
      settled = true
      stop()
      reject(new Error(`${reason}\n--- server output ---\n${output}`))
    }

    const timer = setTimeout(() => { fail('the server did not print its token file path within 60s') }, 60_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const named = TOKEN_PATH.exec(output)
      if (named === null || settled) return
      // The banner names the file; the file holds the tokens. Read it the way a human would. The
      // file is complete before the banner prints — bootstrap renames it into place first.
      const tokenPath = named[1] as string
      let file: string
      try {
        file = readFileSync(tokenPath, 'utf8')
      } catch (error) {
        fail(`the token file at ${tokenPath} could not be read: ${String(error)}`)
        return
      }
      const tailnet = TAILNET_TOKEN.exec(file)
      const local = LOCAL_TOKEN.exec(file)
      if (tailnet === null || local === null) {
        fail(`the token file at ${tokenPath} did not carry both tokens`)
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ localToken: local[1] as string, tailnetToken: tailnet[1] as string, stop })
    })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('exit', code => { fail(`the server exited with code ${String(code)} before starting`) })
    child.on('error', error => { fail(`the server could not be spawned: ${error.message}`) })
  })
}
