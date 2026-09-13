import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { browseScopeFor } from '../../src/server/bootstrap'

/**
 * **C3 — THE BROWSE-SCOPE OVERRIDE IS VALIDATED AT STARTUP.** The security review's P7 review, 2026-08-09.
 *
 * `SOIL_BROWSE_HOME` exists so the end-to-end suite can drive the folder picker against a sandbox
 * rather than the user's real home directory — the standing rule on this build is that tests run
 * against a mock. It is not a privilege escalation: it is read by the server from its own
 * environment, and anyone who can set that can already run code as that process. The security review accepted
 * that argument and then measured what the value actually does, which is the part the argument did
 * not cover:
 *
 *     browseScopeFor({SOIL_BROWSE_HOME:'/'})  =>  {"home":"/","volumes":"/"}
 *     browse('/etc') under that scope         =>  LISTED 19 dirs
 *     browseScopeFor({SOIL_BROWSE_HOME:'relative/path'})  =>  every browse PATH_ESCAPES_ROOT
 *
 * `splitSegments('/')` is `[]`, and `isWithin([], anything)` is vacuously true — so `/` makes the
 * whole disk browsable. `registerRoot` refuses `/` for precisely this reason, in a comment that
 * spells the vacuity out; the rule was written once and applied in one place. A relative value is
 * the quieter failure: browsing breaks entirely and nothing says why.
 *
 * The realistic source of both is not an attacker. It is a test variable leaking out of a shell
 * profile or a launch plist into a real run.
 */
describe('C3 — the browse-scope override refuses what it cannot mean', () => {
  it('defaults to the real home and /Volumes when unset', () => {
    expect(browseScopeFor({})).toEqual({ home: homedir(), volumes: '/Volumes' })
    expect(browseScopeFor({ SOIL_BROWSE_HOME: '' })).toEqual({ home: homedir(), volumes: '/Volumes' })
  })

  it('accepts an absolute sandbox path, moving both halves together', () => {
    // Both halves move on purpose: an override that changed `home` and left `volumes` at
    // `/Volumes` would leave a test able to enumerate real mounted disks while believing it was
    // sandboxed — a control that looks applied and is half-applied.
    expect(browseScopeFor({ SOIL_BROWSE_HOME: '/tmp/sandbox' }))
      .toEqual({ home: '/tmp/sandbox', volumes: '/tmp/sandbox' })
    expect(browseScopeFor({ SOIL_BROWSE_HOME: '/tmp/a', SOIL_BROWSE_VOLUMES: '/tmp/b' }))
      .toEqual({ home: '/tmp/a', volumes: '/tmp/b' })
  })

  /**
   * **Thrown, not returned.** A misconfigured security boundary must stop the process: both silent
   * failures are worse than not booting. `/` opens the whole disk while looking configured, and a
   * relative value refuses every browse with no explanation anywhere.
   */
  it('refuses the filesystem root, which would make the whole disk browsable', () => {
    expect(() => browseScopeFor({ SOIL_BROWSE_HOME: '/' })).toThrow(/whole disk/)
    expect(() => browseScopeFor({ SOIL_BROWSE_HOME: '/tmp/ok', SOIL_BROWSE_VOLUMES: '/' }))
      .toThrow(/whole disk/)
  })

  it('refuses a relative path rather than silently disabling browsing', () => {
    expect(() => browseScopeFor({ SOIL_BROWSE_HOME: 'relative/path' })).toThrow(/absolute/)
  })

  it('refuses dot segments, the same rule browse itself applies to a request', () => {
    expect(() => browseScopeFor({ SOIL_BROWSE_HOME: '/tmp/../etc' })).toThrow(/\.\./)
  })
})
