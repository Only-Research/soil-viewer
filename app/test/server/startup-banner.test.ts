import { describe, expect, it } from 'vitest'

import { createToken } from '../../src/server/guards'
import { startupBanner, type BannerInput } from '../../src/server/startup-banner'

/**
 * The banner is what a LaunchAgent's `StandardOutPath` captures, and until 2026-09-02 it carried
 * both session tokens — into a file at launchd's umask, in the deployment the spec itself prescribes.
 * Spec §7 token property 4 says never to any log. These pin the replacement: the banner names the
 * token file and cannot be handed a token.
 */

const INPUT: BannerInput = {
  host: '127.0.0.1',
  portLocal: 8765,
  portTailnet: 8766,
  buildStamp: '2026-09-02T00:00:00.000Z',
  tokenPath: '/state/tokens',
}

describe('the startup banner', () => {
  it('names both listeners, the build, and where the tokens are', () => {
    const banner = startupBanner(INPUT)
    expect(banner).toContain('http://127.0.0.1:8765')
    expect(banner).toContain('http://127.0.0.1:8766')
    expect(banner).toContain('2026-09-02T00:00:00.000Z')
    expect(banner).toMatch(/^\s*tokens\s+\/state\/tokens\s*$/m)
  })

  it('carries nothing shaped like a token', () => {
    expect(startupBanner(INPUT)).not.toMatch(/[0-9a-f]{32}/)
  })

  it('cannot be handed a token — the input type has no field for one', () => {
    const token = createToken()
    // @ts-expect-error — a token is not a field of BannerInput, and must never become one
    const banner = startupBanner({ ...INPUT, tailnetToken: token })
    expect(banner, 'and handed one as an excess property, it prints none of it').not.toContain(token)
  })
})
