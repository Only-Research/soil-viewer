import { describe, expect, it } from 'vitest'

import { createTokenMinter, type EntityIdentity } from '../../src/core/entity-token'

/** A fixed salt, so a test can assert an exact digest. Never a production shape — see the module. */
const SALT = Buffer.alloc(32, 7)

const identity = (dev: bigint, ino: bigint): EntityIdentity => ({ dev, ino })

const ENTITY = identity(16777232n, 26687993n)

describe('the token itself', () => {
  it('is stable for one entity within a process', () => {
    const minter = createTokenMinter(SALT)
    expect(minter.mint(ENTITY)).toBe(minter.mint(ENTITY))
  })

  it('changes when the inode changes — the replacement this control exists to catch', () => {
    const minter = createTokenMinter(SALT)
    // The measured case: unlink and recreate at the same path yields ino + 1 on APFS.
    expect(minter.mint(identity(16777232n, 26687994n))).not.toBe(minter.mint(ENTITY))
  })

  it('changes when the device changes — the same inode number on two volumes is two files', () => {
    const minter = createTokenMinter(SALT)
    expect(minter.mint(identity(16777233n, 26687993n))).not.toBe(minter.mint(ENTITY))
  })

  /**
   * The delimiter test, and it is the one that would catch a plausible refactor.
   *
   * `dev=1, ino=23` and `dev=12, ino=3` concatenate to the same string. Anyone "simplifying" the
   * digest input to `${dev}${ino}` passes every other test in this file and merges two entities
   * into one token — which means a rename aimed at one is accepted against the other, the exact
   * harm §13.8 names.
   */
  it('does not confuse (1, 23) with (12, 3)', () => {
    const minter = createTokenMinter(SALT)
    expect(minter.mint(identity(1n, 23n))).not.toBe(minter.mint(identity(12n, 3n)))
  })

  it('is salted — two processes do not mint the same token for the same file', () => {
    const a = createTokenMinter(Buffer.alloc(32, 1))
    const b = createTokenMinter(Buffer.alloc(32, 2))
    expect(a.mint(ENTITY)).not.toBe(b.mint(ENTITY))
  })

  it('generates its own salt when none is given, rather than falling back to a fixed one', () => {
    expect(createTokenMinter().mint(ENTITY)).not.toBe(createTokenMinter().mint(ENTITY))
  })
})

describe('what reaches the client', () => {
  it('carries no trace of the inode or device number', () => {
    const token = createTokenMinter(SALT).mint(ENTITY)
    expect(token).not.toContain('26687993')
    expect(token).not.toContain('16777232')
  })

  it('is base64url, so it survives a JSON body and a URL without escaping', () => {
    const minter = createTokenMinter(SALT)
    // Many identities rather than one: `+` and `/` appear in roughly 1 in 20 base64 characters, so
    // a single sample is a coin flip rather than a check.
    for (let ino = 0n; ino < 200n; ino += 1n) {
      expect(minter.mint(identity(16777232n, ino))).toMatch(/^[A-Za-z0-9_-]{22}$/)
    }
  })

  /**
   * A golden vector, pinning salt, version tag, field order, delimiter and truncation length at
   * once. It fails on any change to what the token covers — which is the point: §13.8's token is a
   * contract between a painted screen and a mutation, and changing it silently would validate a new
   * digest against an old view. A deliberate change updates this line and bumps `TOKEN_VERSION`.
   */
  it('is exactly this digest for this salt and this entity', () => {
    // Recomputed independently from the module's stated rule — sha256(salt || "v1|<dev>|<ino>"),
    // base64url, first 22 characters — rather than pasted from what the code returned. A golden
    // vector copied out of the code under test pins the bug along with the behaviour.
    expect(createTokenMinter(SALT).mint(ENTITY)).toBe('nndFtGOA4bjjTasVpUfzBe')
  })
})

describe('matches', () => {
  it('accepts the identity the token was minted from', () => {
    const minter = createTokenMinter(SALT)
    expect(minter.matches(minter.mint(ENTITY), ENTITY)).toBe(true)
  })

  it('refuses an entity that was replaced under the same path', () => {
    const minter = createTokenMinter(SALT)
    const shown = minter.mint(ENTITY)
    const nowThere = identity(16777232n, 26687994n)
    expect(minter.matches(shown, nowThere)).toBe(false)
  })

  it('refuses a token from another process', () => {
    const shown = createTokenMinter(Buffer.alloc(32, 1)).mint(ENTITY)
    expect(createTokenMinter(Buffer.alloc(32, 2)).matches(shown, ENTITY)).toBe(false)
  })

  it('refuses empty, garbage and a truncated prefix of a real token', () => {
    const minter = createTokenMinter(SALT)
    const real = minter.mint(ENTITY)
    expect(minter.matches('', ENTITY)).toBe(false)
    expect(minter.matches('not-a-token', ENTITY)).toBe(false)
    expect(minter.matches(real.slice(0, -1), ENTITY)).toBe(false)
    expect(minter.matches(`${real}x`, ENTITY)).toBe(false)
  })
})
