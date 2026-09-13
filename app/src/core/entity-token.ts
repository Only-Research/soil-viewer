/**
 * §13.8's identity token — *"is the thing you are about to act on still the thing you were shown?"*
 *
 * Spec §13.8: **"Every mutation carries the identity token the client was last shown. The server
 * re-verifies and refuses with `stale-target`."** The failure it names is specific and it is not
 * about content:
 *
 *   *"a row action against a path an agent just replaced renames the **wrong file**, while obeying
 *   every other rule."*
 *
 * That is the whole job. A path is not an identity (§4); a screen showing `notes.md` is showing a
 * *path*, and between the paint and the tap an agent can put a different file there. Every other
 * control in the write path — containment, exclusivity, the locks — operates correctly on whatever
 * is at the path *now*. This one asks whether *now* is still *then*.
 *
 * ---
 *
 * ## What composes the token, and what deliberately does not
 *
 * **`(dev, ino)`. Nothing else.** Not size, not mtime, not a content hash.
 *
 * The reasoning is §13.4's, applied to a different question. Conflict detection for a *save* is
 * settled on the content hash because a save depends on prior bytes. **A rename does not.** If an
 * agent appends a line to the file the user is renaming, the rename still acts on exactly the file
 * the user pointed at — refusing it would be a false positive, and §13.4 is explicit that on this
 * tree "false positives are equally harmful". If an agent *replaces* the file, the inode changes and
 * the rename would act on something the user never saw. So the token draws the line exactly where
 * the harm is.
 *
 * `kind` was considered and left out as redundant by construction — see the measurement below.
 *
 * ## Measured on this machine, 2026-08-09, because the design rests on it
 *
 * The token is only sound if a freed inode number is never handed to a later file. Probed on APFS
 * rather than assumed, per this build's rule that an environment claim is a fact with an expiry
 * date:
 *
 * - **Create, unlink, create again at the same path → a different inode.** 26687993 then 26687994.
 * - **200 create/unlink rounds over 5 recycled paths → 200 distinct inodes, zero collisions.**
 *   Numbers increase monotonically; APFS does not reuse them.
 * - **A file replaced by a *directory* at the same path → a different inode** (26688195 → 26688196).
 *   This is why `kind` adds nothing: the kind cannot change without the inode changing first.
 * - **Our own atomic write changes the inode** (26688197 → 26688198), because temp + `rename(2)`
 *   makes the path point at the temp's inode. That one has a consequence — see below.
 *
 * *If this app is ever run on a filesystem that recycles inode numbers, this module's premise is
 * void and the token needs a generation counter. Stated so the assumption is findable.*
 *
 * ## THE CONSEQUENCE OF THE LAST MEASUREMENT, and it is load-bearing
 *
 * **Our own `file.save` changes the inode, and the watcher deliberately hides that from the
 * client.** `noteOwnWrite` records what the app just wrote so the resulting `fs.watch` event is
 * recognised as an echo and dropped (§5) — the premise being that the client caused the change and
 * does not need telling.
 *
 * §13.8 turns that premise into an obligation. If the event is suppressed, **the response must
 * carry the new token**, or the client holds a stale one for a change it made itself, and the next
 * rename of a file the user just edited is refused for no reason. The refusal would be honest —
 * the view *is* stale — and it would still be a bug, because we are the ones who made it stale and
 * then declined to say so.
 *
 * So: every mutation that changes an entity returns the entity's new token. The echo dedup and this
 * module are two halves of one contract rather than two features in tension.
 *
 * ## Why it is a digest and not the numbers
 *
 * `contract/wire.ts` decided that `dev` and `ino` do not cross the boundary at all, on the grounds
 * that **"not sending it is stronger than sending it safely"** — a field that does not exist cannot
 * be truncated, logged, or become a handle the client starts depending on. A digest keeps every
 * word of that: the client gets an opaque string it can only echo back, the detection is identical,
 * and there is no inode on the wire.
 *
 * The per-process salt makes that true in fact rather than in encoding — without it the digest is a
 * reversible lookup for anyone who can guess an inode number, which on a local filesystem is not a
 * hard guess. It costs one `randomBytes(32)` at startup. Tokens do not survive a restart, which is
 * correct anyway: a restarted server means a reconnected client and a refetched tree.
 *
 * ## Why the comparison is not timing-safe, stated so it is not read as an oversight
 *
 * `session.ts` and `guards.ts` both use `timingSafeEqual`, and this module does not. **The token is
 * not a credential.** It grants nothing: every route carrying one is already behind the CSRF gate
 * and the per-request bearer token. (This paragraph used to add "and the local-only listener" as a
 * third layer; as of 2026-08-09 no route is `local-only`, so that clause is struck rather than left
 * to overstate what stands behind this. The argument does not depend on it.) Guessing a token does
 * not authorise an operation, it merely fails to *prevent* one the caller could already perform.
 * There
 * is no secret here to leak through a comparison, and using the cryptographic primitive anyway
 * would suggest there is.
 */

import { createHash, randomBytes } from 'node:crypto'

/**
 * What the token is computed over. Both fields are BigInt because that is how the index holds them
 * — inode numbers exceed 2^53 and a Number would silently round.
 */
export interface EntityIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

/**
 * 22 base64url characters — **132 bits** of the digest, since each character carries six.
 *
 * Stated as a character count rather than derived from a byte count, because the truncation happens
 * on the encoded string and the two do not divide evenly: `Math.ceil(16 * 8 / 6)` is 22, which is
 * 132 bits and not the 128 that expression implies. A comment that says 128 while the code produces
 * 132 is this build's most-recorded defect shape in miniature.
 *
 * Truncation is safe *here* in a way it would not be for a credential: a collision does not grant
 * anything, it fails to catch one specific replacement. At 132 bits that is not a failure mode
 * worth carrying weight for, and a full 43-character digest on every row of a 10,000-file tree is
 * 210 KB of payload to prevent an event that will not occur.
 */
const TOKEN_CHARS = 22

/**
 * Versioned, so that a future change to what the token covers cannot silently validate against a
 * token minted under the old rule. A `v2` digest never equals a `v1` digest for the same entity.
 */
const TOKEN_VERSION = 'v1'

export interface TokenMinter {
  /** The token for an entity, as the client will be shown it. */
  mint: (identity: EntityIdentity) => string
  /**
   * Whether a token the client sent still describes this entity.
   *
   * Takes the *claimed* token first and the *observed* identity second, in that order, because
   * every call site reads "does what they sent still match what is there".
   */
  matches: (claimed: string, observed: EntityIdentity) => boolean
}

/**
 * One minter per process.
 *
 * The salt is injectable for tests and for nothing else — a caller supplying a fixed salt in
 * production would make tokens predictable across restarts, which is the one property the salt
 * exists to remove. There is no default-salt escape hatch: omitting it generates a fresh one.
 */
export function createTokenMinter(salt: Buffer = randomBytes(32)): TokenMinter {
  const mint = (identity: EntityIdentity): string =>
    createHash('sha256')
      .update(salt)
      // Length-delimited rather than concatenated. `dev=1,ino=23` and `dev=12,ino=3` are different
      // entities and must not produce one digest — a separator that can appear in the data is not a
      // separator. Decimal digits cannot contain `|`, so this one holds.
      .update(`${TOKEN_VERSION}|${identity.dev.toString()}|${identity.ino.toString()}`)
      .digest('base64url')
      .slice(0, TOKEN_CHARS)

  return {
    mint,
    matches: (claimed, observed) => claimed === mint(observed),
  }
}
