/**
 * The meta-gate's pure logic, extracted so it can be run against MUTATED configs.
 *
 * the security review's gate-1 standard requires the 19 holes found by the re-gate red-team to be encoded as
 * regression fixtures that must stay RED. That is only possible if the gate's checks are
 * callable on a config other than the live one — otherwise "this break is caught" can be
 * asserted only by hand-editing `eslint.config.js`, which no CI run would ever do.
 *
 * So: every check here is a pure function from (config, corpus) to a list of complaints. The
 * live gate runs them against the real config; `meta-gate-regressions.test.ts` runs them against
 * deliberately broken ones and asserts each break is rejected.
 */

export interface Ban {
  /** The config object's `name`. Part of identity: one ban list is applied in several scopes. */
  readonly block: string
  readonly rule: string
  /**
   * The configured severity. Part of a ban's IDENTITY, not preamble — `decompose` used to discard
   * it on its first line (`raw.slice(1)`), and that discard was the bug: flipping every security
   * rule from 'error' to 'warn' left the whole gate green, `eslint .` exiting 0 and CI passing.
   * Failure #1 (silently-off) reachable by a one-word edit. security review, item (a).
   */
  readonly severity: unknown
  /** Stable identity within the block. */
  readonly id: string
  /**
   * The custom message. Identifies WHICH BAN; the resolved scope identifies WHICH BLOCK.
   *
   * KNOWN LIMIT, stated rather than implied: attribution matches this message inside ESLint's
   * RENDERED text, and ESLint decorates before emitting. Uniqueness is asserted over these custom
   * strings, not over the rendered ones, so a ban whose wording is a substring of another ban's
   * *rendered* output could still be credited by it. `messageContainments` closes the custom-text
   * side; the decorated side is closed in practice because every message here ends in a distinct
   * spec citation. This is the residual the red-team named and it is narrower than it was, not
   * gone.
   */
  readonly message: string
  /**
   * The raw tokens that must each be a valid JS identifier, kept separately from `id`.
   *
   * They cannot be recovered from `id`: the object+property form composes to
   * `property:window.document`, which is indistinguishable from a single property literally named
   * "window.document" — and that indistinguishability IS failure #1. `malformedBans` needs the
   * unjoined values to tell the legal case from the impossible one.
   */
  readonly identifiers?: readonly string[]
}

export interface ConfigBlock {
  readonly name?: string
  readonly rules?: Record<string, unknown>
  readonly files?: string[]
  readonly ignores?: string[]
}

export interface Fixture {
  readonly what: string
  readonly filePath: string
  readonly code: string
  /** "<block>::<id>" — the ban this fixture exists to prove. */
  readonly proves: string
}

export interface PassFixture {
  readonly what: string
  readonly filePath: string
  readonly code: string
  /** A security rule that MUST be active at this path, so the fixture is known to be governed. */
  readonly governedBy: string
  /**
   * The construct this fixture exists to prove is safe. Asserted to still be present, because
   * "it lints clean" is also true of an empty file — re-gate hole 9, where every known-good
   * fixture could be replaced with `export const x = 1` and the suite stayed green.
   */
  readonly mustContain: string
}

export const banKey = (block: string, id: string): string => `${block}::${id}`

/** Thrown rather than returned: an enumeration failure must stop the gate, not degrade it. */
export class EnumerationFailure extends Error {}

/**
 * Split one configured restriction rule into its individual bans.
 *
 * Fails closed (security review, amendment C): a shape this does not understand throws, because a
 * restriction rule that silently enumerates nothing is indistinguishable from one that is fully
 * proven — which is how the legacy varargs form passed.
 */
export function decompose(block: string, rule: string, raw: unknown): Ban[] {
  const severity = Array.isArray(raw) ? raw[0] : raw
  const options = Array.isArray(raw) ? raw.slice(1) : []
  const make = (id: string, message: unknown, identifiers?: readonly string[]): Ban => {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new EnumerationFailure(
        `${banKey(block, id)} has no custom message. Every ban carries a message that names it; ` +
        `it is what lets this gate attribute a violation to it.`,
      )
    }
    return identifiers === undefined
      ? { block, rule, id, message, severity }
      : { block, rule, id, message, severity, identifiers }
  }

  // Namespace-tolerant: `@typescript-eslint/no-restricted-imports` takes the identical options
  // shape and is fully ENFORCED, but the old unnamespaced comparison left it invisible to this
  // gate — no fixture demanded, no throw. security review, item (b), first half.
  const bare = rule.replace(/^.*\//, '')

  if (bare === 'no-restricted-imports') {
    const config = options[0]
    if (typeof config !== 'object' || config === null) {
      // The legacy varargs form: ['error', 'some-module', 'another']. It configures real bans
      // this enumerator cannot see — the silent skip amendment C forbids.
      throw new EnumerationFailure(
        `${block}: no-restricted-imports uses the legacy varargs form. Use the object form ` +
        `({ paths, patterns }) with a message per entry, or this gate cannot prove its bans.`,
      )
    }
    const { paths = [], patterns = [] } = config as {
      paths?: Array<{ name: string; message?: string }>
      patterns?: Array<{ group: string[]; message?: string }>
    }
    return [
      ...paths.map(p => make(`import:${p.name}`, p.message)),
      ...patterns.map(p => make(`importPattern:${p.group.join('|')}`, p.message)),
    ]
  }

  if (bare === 'no-restricted-properties') {
    return (options as Array<{ object?: string; property?: string; message?: string }>).map(e => {
      const id = e.object !== undefined
        ? `property:${e.object}.${e.property}`
        : `property:${e.property}`
      const identifiers = [e.object, e.property].filter((v): v is string => v !== undefined)
      return make(id, e.message, identifiers)
    })
  }

  if (bare === 'no-restricted-globals') {
    return (options as Array<{ name: string; message?: string }>)
      .map(e => make(`global:${e.name}`, e.message, [e.name]))
  }

  if (bare === 'no-restricted-syntax') {
    return (options as Array<{ selector: string; message?: string }>)
      .map(e => make(`syntax:${e.selector}`, e.message))
  }

  throw new EnumerationFailure(
    `${block}: restriction rule "${rule}" has no decomposition here. Teach this enumerator how ` +
    `to split it into individual bans before shipping it — an unrecognised restriction rule ` +
    `fails the build rather than passing unproven (security review, amendment C).`,
  )
}

/**
 * Every ban in a config. Discovery is by RULE SHAPE — any `no-restricted-*` rule — not by an
 * allowlist of four rule names, which was re-gate hole 7: the hardcoding had merely moved from
 * block names to rule names, so a fifth restriction rule sat outside the gate entirely.
 */
export function enumerateBans(config: readonly ConfigBlock[]): Ban[] {
  const bans: Ban[] = []
  for (const block of config) {
    for (const [rule, raw] of Object.entries(block.rules ?? {})) {
      // Shape, in any namespace. The security review REJECTED the reviewed-allowlist half of item (b): an
      // ordinary style rule sitting next to a security rule is not a security control, and a gate
      // that fails on it trains people to route around it. The discriminator is the rule's shape,
      // not its neighbourhood.
      //
      // RESIDUAL, recorded so the next reader does not discover it as a hole: a security control
      // that is NOT a `no-restricted-*` rule sits outside this gate by construction. There are
      // none today, and adding one is a config change that goes to the security review.
      if (!/(^|\/)no-restricted-/.test(rule)) continue
      if (block.name === undefined) {
        throw new EnumerationFailure(
          `a config block carrying restriction rule "${rule}" has no \`name\`. The name is this ` +
          `ban's scope identity; an anonymous block cannot be proven.`,
        )
      }
      const decomposed = decompose(block.name, rule, raw)
      if (decomposed.length === 0) {
        throw new EnumerationFailure(
          `${block.name}: "${rule}" is configured but enumerated ZERO bans. A restriction rule ` +
          `that cannot be decomposed fails the build (security review, amendment C).`,
        )
      }
      bans.push(...decomposed)
    }
  }
  return bans
}

/**
 * A message must name exactly one ban.
 *
 * The same ban recurring across scopes is expected: one ban list is deliberately applied in three
 * partitions, so `import:node:fs` exists in two blocks with one wording. The security review's amendment A is
 * this split — the message says WHICH BAN, the resolved config says WHICH SCOPE, and identity is
 * the pair. Two DIFFERENT bans sharing wording is the defect: it lets one be certified by the
 * other's fixture (hole 4, and failure #2 re-achieved by copy-paste).
 */
export function messageAmbiguities(bans: readonly Ban[]): string[] {
  const idsPerMessage = new Map<string, Set<string>>()
  for (const ban of bans) {
    const ids = idsPerMessage.get(ban.message) ?? new Set<string>()
    ids.add(ban.id)
    idsPerMessage.set(ban.message, ids)
  }
  return [...idsPerMessage.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([message, ids]) => `${[...ids].join(' and ')} share the wording "${message.slice(0, 60)}…"`)
}

/**
 * No ban's message may be contained in another's. ESLint appends the custom message verbatim, so
 * a contained message would be credited by the containing ban's violation — the substring family
 * that let `node:http` certify the bare `http` ban.
 */
export function messageContainments(bans: readonly Ban[]): string[] {
  const out: string[] = []
  for (const a of bans) {
    for (const b of bans) {
      if (a.id === b.id) continue // the same ban across scopes; identity is settled by scope
      if (b.message.includes(a.message)) out.push(`${a.id} is contained in ${b.id}`)
    }
  }
  return [...new Set(out)]
}

/** Bans with no fixture that NAMES them. Totality. */
export function unprovenBans(bans: readonly Ban[], corpus: readonly Fixture[]): string[] {
  const declared = new Set(corpus.map(f => f.proves))
  return bans.map(b => banKey(b.block, b.id)).filter(key => !declared.has(key))
}

/** Fixtures naming a ban that does not exist — a typo, or a ban that was removed. */
export function danglingFixtures(bans: readonly Ban[], corpus: readonly Fixture[]): string[] {
  const keys = new Set(bans.map(b => banKey(b.block, b.id)))
  return corpus.filter(f => !keys.has(f.proves)).map(f => `${f.what} -> ${f.proves}`)
}

/**
 * Extensions a block's globs claim but no fixture exercises. The `.tsx` class: a block protecting
 * both extensions but only ever proven on one is enforced in half the places it claims, and the
 * gate said nothing for the whole of Phase 0 and 1.
 */
export function extensionGaps(
  config: readonly ConfigBlock[],
  bans: readonly Ban[],
  corpus: readonly Fixture[],
): string[] {
  const blocks = new Set(bans.map(b => b.block))
  const out: string[] = []
  for (const block of blocks) {
    const declaration = config.find(c => c.name === block)
    const claimed = new Set(
      (declaration?.files ?? [])
        .map(glob => glob.slice(glob.lastIndexOf('.') + 1))
        .filter(ext => ext !== '' && !ext.includes('*') && !ext.includes('/')),
    )
    const covered = new Set(
      corpus
        .filter(f => f.proves.startsWith(`${block}::`))
        .map(f => f.filePath.slice(f.filePath.lastIndexOf('.') + 1)),
    )
    for (const ext of claimed) {
      if (!covered.has(ext)) out.push(`${block} claims .${ext} but no fixture exercises it`)
    }
    if (claimed.size === 0) out.push(`${block} declares no file globs, so its scope is unprovable`)
  }
  return out
}

/** Known-good fixtures that no longer contain the construct they exist to vindicate. */
export function gutted(passCorpus: readonly PassFixture[]): string[] {
  return passCorpus
    .filter(f => !f.code.includes(f.mustContain))
    .map(f => `${f.what} no longer contains ${f.mustContain}`)
}

/**
 * Bans not configured at `error`. Security review, item (a) — the highest-value item on its list.
 *
 * Verified 2026-08-07: flipping the seven security rules from 'error' to 'warn' left the meta-gate
 * 107/107 green, `eslint .` exiting 0, and CI passing, while `node:fs` in the Core reported
 * `errorCount=0`. One character disabled every security control in the build and nothing noticed.
 * Both halves are required — this check, and `--max-warnings 0` on the lint script — because the
 * assertion alone still lets a NEW rule land as a warning, and the flag alone still lets this gate
 * certify a demoted ban.
 */
export function demotedBans(bans: readonly Ban[]): string[] {
  return bans
    .filter(b => b.severity !== 'error' && b.severity !== 2)
    .map(b => `${banKey(b.block, b.id)} is configured at ${JSON.stringify(b.severity)}, not "error"`)
}

/** A valid JS identifier — no dots, no spaces, not empty. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Bans that are malformed in a way that makes them permanently unfirable against real code.
 * the security review's item (h), and its structural answer to the deepest finding.
 *
 * The dead-ban class — syntactically valid, individually proven, matching nothing that could ever
 * exist — is what produced failure #1 and what the red-team resurrected verbatim: `document.write`
 * configured as a PROPERTY NAME, paired with a fixture using `x["document.write"]`, certified green.
 * No number of fixtures detects that, because the fixture is written to match the dead ban.
 *
 * But most of it is checkable as a property of the ban ITSELF. `document.write` contains a dot, is
 * not an identifier, and would have been rejected at Phase 0 — before any fixture existed to
 * launder it.
 *
 * To be precise about what this does NOT do: it does not prove the ban list is complete. Nothing
 * can. It eliminates the dead-ban class structurally instead of by inspection, which is the part
 * that is actually fixable.
 */
export function malformedBans(bans: readonly Ban[]): string[] {
  const out: string[] = []
  for (const ban of bans) {
    const key = banKey(ban.block, ban.id)
    for (const token of ban.identifiers ?? []) {
      if (!IDENTIFIER.test(token)) {
        out.push(`${key} names "${token}", which is not a valid JS identifier — nothing can be called that, so this ban can never fire against real code`)
      }
    }
    if (ban.id.startsWith('import:')) {
      const name = ban.id.slice('import:'.length)
      if (name.trim() === '' || /\s/.test(name)) out.push(`${key} is not a well-formed module specifier`)
    }
  }
  return out
}

/**
 * entry↔scope, extracted so it can be mutation-pinned. security review, item (f), non-negotiable.
 *
 * Flat config REPLACES rather than merges, so a rule's resolved options at a path come from
 * exactly one block. Equality of the resolved message set with a block's declared set therefore
 * identifies the governing block, without reimplementing glob matching. A block shadowed by a
 * later one can never satisfy it.
 *
 * This assertion and `attributionFailure` below carry the entire guarantee of this gate, and until
 * now both lived inline in the test file where either could be DELETED with zero test failures.
 * Three times the thing that failed has been the gate rather than the config. The watcher gets
 * watched.
 */
export function scopeMismatch(
  resolvedMessages: readonly string[],
  declaredMessages: readonly string[],
): string | null {
  const a = [...resolvedMessages].sort()
  const b = [...declaredMessages].sort()
  if (a.length === b.length && a.every((m, i) => m === b[i])) return null
  return `resolved ${a.length} bans, declaring block has ${b.length} — the ban is not live where this fixture claims to prove it`
}

/**
 * entry↔fixture, extracted for the same reason. Returns null when the declared ban genuinely
 * fired, or a reason when it did not.
 */
export function attributionFailure(
  messages: ReadonlyArray<{ ruleId: string | null; message: string; fatal?: boolean | undefined }>,
  ban: Ban,
): string | null {
  const fatal = messages.filter(m => m.fatal === true)
  if (fatal.length > 0) return `fixture does not parse: ${fatal[0]?.message ?? ''}`
  const fired = messages.filter(m => m.ruleId === ban.rule && m.message.includes(ban.message))
  if (fired.length === 0) {
    return `${banKey(ban.block, ban.id)} never fired against its own fixture — the ban matches nothing`
  }
  return null
}
