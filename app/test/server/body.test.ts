import { describe, expect, it } from 'vitest'

import { declaredLength, readJsonBody } from '../../src/server/body'
import {
  DOCUMENT_BODY_ROUTES, MAX_BODY_BYTES, MAX_EDITABLE_BYTES, MAX_WRITE_BODY_BYTES, bodyCapFor,
} from '../../src/server/limits'
import { TransportErrorCode } from '../../src/contract/wire'

/** Turns fixed chunks into the async iterable a socket would produce. */
async function* stream(...chunks: Array<string | Buffer>): AsyncIterable<Buffer> {
  for (const chunk of chunks) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
}

/** A body that never stops. Used to prove the cap fires DURING the read, not after it. */
async function* endless(chunkSize: number): AsyncIterable<Buffer> {
  for (;;) yield Buffer.alloc(chunkSize, 0x61)
}

describe('Content-Length parsing', () => {
  it('accepts a plain run of digits, and absent', () => {
    expect(declaredLength('120')).toBe(120)
    expect(declaredLength('0')).toBe(0)
    expect(declaredLength(undefined)).toBeUndefined()
  })

  it('refuses everything Number() would have accepted', () => {
    // Each of these coerces to a number and would have passed a `Number(raw)` check. A header
    // parser that disagrees with the framing layer about a length is the basis of smuggling.
    for (const bad of ['1e9', ' 12 ', '0x10', '+5', '12.0', '-1', '', 'twelve']) {
      expect(declaredLength(bad), `"${bad}" must be refused`).toBeNull()
    }
  })

  it('refuses a repeated Content-Length rather than picking one', () => {
    expect(declaredLength(['10', '20'])).toBeNull()
  })
})

describe('the cap is enforced while streaming', () => {
  it('stops an endless body instead of absorbing it', async () => {
    // The assertion that matters: this returns rather than running forever or exhausting memory.
    const result = await readJsonBody(endless(64 * 1024), { maxBytes: MAX_BODY_BYTES })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(TransportErrorCode.PAYLOAD_TOO_LARGE)
  })

  it('refuses a body one byte over the cap, and accepts one exactly at it', async () => {
    const atCap = `"${'a'.repeat(98)}"` // 100 bytes of JSON
    expect((await readJsonBody(stream(atCap), { maxBytes: 100 })).ok).toBe(true)
    expect((await readJsonBody(stream(`${atCap} `), { maxBytes: 100 })).ok).toBe(false)
  })

  it('counts across chunks, not per chunk', async () => {
    const result = await readJsonBody(stream('a'.repeat(60), 'b'.repeat(60)), { maxBytes: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(TransportErrorCode.PAYLOAD_TOO_LARGE)
  })
})

describe('Content-Length is used to refuse early, never to trust', () => {
  it('refuses before reading when the declared length is over the cap', async () => {
    let pulled = 0
    async function* counted(): AsyncIterable<Buffer> {
      pulled++
      yield Buffer.from('{}')
    }
    const result = await readJsonBody(counted(), { maxBytes: 100, contentLength: '10000' })
    expect(result.ok).toBe(false)
    expect(pulled, 'not a single chunk should have been pulled').toBe(0)
  })

  it('still enforces the streaming cap when the declared length LIES', async () => {
    // The important case. A small declared length must not license reading an unbounded body.
    const result = await readJsonBody(endless(16 * 1024), { maxBytes: 64 * 1024, contentLength: '2' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(TransportErrorCode.PAYLOAD_TOO_LARGE)
  })

  it('refuses a body SHORTER than it promised — truncation is not an empty document', async () => {
    const result = await readJsonBody(stream('{"a":1}'), { maxBytes: 100, contentLength: '99' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('did not match')
  })
})

describe('parsing', () => {
  it('parses a well-formed body', async () => {
    const result = await readJsonBody(stream('{"rootId":"soil","segments":[]}'), { maxBytes: 100 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ rootId: 'soil', segments: [] })
  })

  it('refuses an empty body rather than inventing {}', async () => {
    // Inventing an object would let a bodyless request satisfy a schema that accepts `{}`.
    const result = await readJsonBody(stream(), { maxBytes: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('empty body')
  })

  it('refuses invalid JSON as a typed refusal, never a throw', async () => {
    const result = await readJsonBody(stream('{"a":'), { maxBytes: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(TransportErrorCode.BAD_REQUEST)
  })

  it('does not echo the offending input in the reason', async () => {
    // JSON.parse's own message quotes the input; spec §6 bars verbatim client strings.
    const secret = '/Users/hallberg/private'
    const result = await readJsonBody(stream(`{"x": ${secret}`), { maxBytes: 200 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(JSON.stringify(result)).not.toContain('hallberg')
  })

  it('refuses invalid UTF-8 rather than accepting silent replacement characters', async () => {
    // Buffer.toString('utf8') substitutes U+FFFD instead of throwing, so a malformed body would
    // otherwise parse into plausible nonsense — and the replacement survives inside a string value.
    const invalid = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])
    const result = await readJsonBody(stream(invalid), { maxBytes: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('UTF-8')
  })

  it('preserves a legitimate multi-byte character', async () => {
    // The converse — the UTF-8 check must not reject real content. The user's tree is full of it.
    const result = await readJsonBody(stream('{"title":"café — 日本語"}'), { maxBytes: 200 })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.value as { title: string }).title).toBe('café — 日本語')
  })

  /**
   * **A DOCUMENT MAY CONTAIN U+FFFD, AND MUST STILL BE SAVEABLE.**
   *
   * The check above tests that a body which *lost* bytes to substitution is refused. This is the
   * other half, and its absence was a data-loss bug: the original implementation asked whether the
   * decoded text *contains* the replacement character, which is an ordinary valid code point that
   * real documents hold — mojibake from an older import, a note about Unicode, anything pasted from
   * a tool that had already dropped bytes.
   *
   * Such a file **loaded** (its bytes round-trip, so `editabilityRefusal` correctly judged it
   * editable) and could then never be saved: every autosave refused `BAD_REQUEST`, forever, for as
   * long as the document was open. `chatroom.append` was affected identically.
   *
   * The distinguishing rule is a round trip, not a search — and it is the same rule the load gate
   * already used, which is why one gate admitted what the other refused.
   */
  it('ACCEPTS a document that legitimately contains the replacement character', async () => {
    const body = JSON.stringify({ content: 'a note about \uFFFD and what it means' })
    const result = await readJsonBody(stream(body), { maxBytes: 400 })

    expect(result.ok, 'U+FFFD is a valid code point — refusing it makes the file unsavable').toBe(true)
    if (result.ok) {
      expect((result.value as { content: string }).content).toContain('\uFFFD')
    }
  })

  it('returns the raw parsed value — validation is a separate, later step', async () => {
    // The body reader must NOT validate. Two layers doing the same job is how one of them gets
    // weakened later on the grounds that the other covers it.
    const result = await readJsonBody(stream('{"unknown":true,"__proto__":{}}'), { maxBytes: 200 })
    expect(result.ok).toBe(true)
  })
})

describe('the write-route headroom — FT-3', () => {
  it('leaves room for the envelope above the editable content cap', () => {
    // Spec §6: the write body limit "MUST NOT be lower" than MAX_EDITABLE_BYTES + 64 KiB, because
    // otherwise a file at the editable limit is accepted by the editor and refused on save — the
    // user's work taken and then lost.
    expect(MAX_WRITE_BODY_BYTES).toBeGreaterThan(MAX_EDITABLE_BYTES)
    // Twice the content for JSON's two-byte escapes, plus 64 KiB for the envelope. The spec's
    // `+ 64 KiB` is a floor — "MUST NOT be lower" — and on its own it covered a document at the cap
    // only when its lines averaged 32 bytes or more. See `limits.ts` for the derivation.
    expect(MAX_WRITE_BODY_BYTES).toBe(MAX_EDITABLE_BYTES * 2 + 64 * 1024)
  })

  it('is larger than the ordinary body cap, so the general limit cannot govern a save', () => {
    expect(MAX_WRITE_BODY_BYTES).toBeGreaterThan(MAX_BODY_BYTES)
  })

  it('accepts a body at the editable size under the write cap', async () => {
    // Proves the two constants actually work together rather than merely comparing well.
    const content = 'a'.repeat(MAX_EDITABLE_BYTES)
    const body = JSON.stringify({ content })
    expect(body.length).toBeGreaterThan(MAX_EDITABLE_BYTES)
    const result = await readJsonBody(stream(body), { maxBytes: MAX_WRITE_BODY_BYTES })
    expect(result.ok, 'a maximum-size edit must be savable').toBe(true)
  })

  /**
   * **THE HEADROOM WAS SIZED FOR THE ENVELOPE AND NOT FOR THE ESCAPING.** Found 2026-09-02 by the
   * correctness reviewer; this test stayed red until the constant changed.
   *
   * The content travels as a JSON string, and JSON doubles a newline, a quote, a backslash, a tab
   * and a carriage return: a newline becomes the two bytes backslash and `n`. So a document at the
   * editable cap whose lines averaged under 32 bytes encoded to more than
   * `MAX_EDITABLE_BYTES + 64 KiB` and was **editable and unsavable** — FT-3 a third time, from a
   * third direction. A 2 MiB list of short lines is an ordinary markdown file.
   */
  it('accepts a NEWLINE-DENSE body at the editable size — the case 64 KiB could not cover', async () => {
    const content = '\n'.repeat(MAX_EDITABLE_BYTES)
    const body = JSON.stringify({ content })
    expect(body.length, 'every newline doubled').toBeGreaterThan(MAX_EDITABLE_BYTES * 2)
    const result = await readJsonBody(stream(body), { maxBytes: MAX_WRITE_BODY_BYTES })
    expect(result.ok, 'a maximum-size edit of short lines must be savable').toBe(true)
  })

  it('accepts the worst two-byte escape mix at the editable size', async () => {
    // Every character JSON escapes to exactly two bytes, in rotation — the true worst case for text.
    const cycle = '\n"\\\t\r'
    const content = cycle.repeat(Math.ceil(MAX_EDITABLE_BYTES / cycle.length)).slice(0, MAX_EDITABLE_BYTES)
    const body = JSON.stringify({ content })
    const result = await readJsonBody(stream(body), { maxBytes: MAX_WRITE_BODY_BYTES })
    expect(result.ok, 'two bytes per character is the bound the cap is derived from').toBe(true)
  })

  /**
   * **The residual, stated rather than hidden.** Control characters other than the five above
   * escape to SIX bytes — U+0001 becomes the six characters of its escape. A document at the cap
   * that is more than about a fifth of them still exceeds the body limit. It is not text by any
   * reading — `editabilityRefusal` admits it only because spec FT-2 names NUL alone — and covering
   * it would mean a 12 MiB body held per connection, 256 connections deep. This test pins the
   * boundary so moving it is a decision.
   */
  it('RESIDUAL: a document one-quarter raw control characters is still over the cap', async () => {
    const quarter = Math.floor(MAX_EDITABLE_BYTES / 4)
    const content = String.fromCharCode(1).repeat(quarter) + 'a'.repeat(MAX_EDITABLE_BYTES - quarter)
    const body = JSON.stringify({ content })
    const result = await readJsonBody(stream(body), { maxBytes: MAX_WRITE_BODY_BYTES })
    expect(result.ok, 'documented boundary — see the comment above this test').toBe(false)
  })

  /**
   * **EVERY TEST ABOVE PASSED WHILE `MAX_WRITE_BODY_BYTES` WAS USED NOWHERE.**
   *
   * Found 2026-08-09 by the end-to-end chain test on its first complete run: a file under the
   * editable cap loaded fine and its save came back `PAYLOAD_TOO_LARGE`, because the listener read
   * every body at `MAX_BODY_BYTES` — 1 MB. Every file between 1 MB and 2 MiB was **editable and
   * unsavable**: FT-3 exactly, the failure the constant was written to prevent, with a comment above
   * it describing the rule it was not enforcing.
   *
   * The three tests above assert that the number is well-formed and that `readJsonBody` honours it
   * **when handed it directly**. None of them asks who hands it over. That is a control correct in
   * isolation and never reached — and the tests around it were shaped so they could not tell.
   *
   * These ask the question the others left out: **which cap does a route get?**
   */
  it('THE SAVE ROUTE GETS THE WRITE CAP — the question the tests above never asked', () => {
    expect(bodyCapFor('file.save')).toBe(MAX_WRITE_BODY_BYTES)
  })

  it('every other route gets the ordinary cap', () => {
    for (const route of ['file.load', 'folders.register', 'tree.children', 'session.start', 'board.lanes']) {
      expect(bodyCapFor(route), route).toBe(MAX_BODY_BYTES)
    }
  })

  it('a route nobody has heard of gets the SMALLER cap, not the larger one', () => {
    // The safe direction. A typo in the route name must shrink what the server will read, never
    // grow it — a default that widens a limit is how a limit stops existing.
    expect(bodyCapFor('file.sav')).toBe(MAX_BODY_BYTES)
    expect(bodyCapFor('')).toBe(MAX_BODY_BYTES)
  })

  it('the document-body set names the routes that carry a document, and only those', () => {
    // Greppable and deliberate: a route that starts carrying a document has to be added here on
    // purpose rather than qualifying by the shape of its input.
    expect([...DOCUMENT_BODY_ROUTES]).toEqual(['file.save'])
  })
})
