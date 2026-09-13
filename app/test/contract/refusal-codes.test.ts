/**
 * A deliberate refusal keeps its code; a crash does not get to borrow one.
 *
 * These tests exist because of a mutation sweep, not because of foresight. The fix that made
 * `dispatch` carry `ErrorCode` to the client (see `RefusalError` in `src/core/errors.ts`) was
 * written and the suite went green — and then six mutations of it ALSO went green. The fix was
 * right and almost none of it was proven:
 *
 *   - reporting every refusal as HTTP 500 — undetected
 *   - collapsing 409/413/403 to 400 — undetected
 *   - **putting the refusal's detail on the wire**, which is a §6 violation and how an absolute
 *     path escapes — undetected
 *   - **treating any thrown object with a `.code` property as a refusal** — undetected, and this
 *     is the dangerous one: every Node filesystem error carries `.code`, so an unbranded check
 *     turns a raw `ENOENT` into a typed refusal and puts `ENOENT` on the wire as though the
 *     server meant it
 *   - accepting an unrecognised code string — undetected
 *
 * The original tests asserted "not 200". That is enough to notice the feature exists and not
 * enough to notice it is wrong in five different ways.
 */

import { describe, expect, it } from 'vitest'

import { createRouter, type Handlers } from '../../src/contract/router'
import { ROUTES, type RouteName } from '../../src/contract/routes'
import { TransportErrorCode } from '../../src/contract/wire'
import { ErrorCode, RefusalError } from '../../src/core/errors'

/** A detail of exactly the kind §6 bars from the wire: it names a real absolute path. */
const LEAKY_DETAIL = '/Users/somebody/Documents/private-notes/thing.md could not be written'

function routerThrowing(thrown: unknown) {
  const handlers = Object.fromEntries(
    (Object.keys(ROUTES) as RouteName[]).map(name => [name, () => { throw thrown }]),
  ) as unknown as Handlers
  return createRouter('local', handlers)
}

const dispatchThrowing = async (thrown: unknown) =>
  routerThrowing(thrown).dispatch('folders.list', 'POST', {})

/** Narrows the response to its error half, failing loudly rather than returning undefined. */
function errorOf(response: { ok: boolean } & Record<string, unknown>) {
  expect(response.ok).toBe(false)
  return (response as unknown as { error: { code: string; message: string } }).error
}

describe('a deliberate refusal reaches the client as itself', () => {
  it('carries the Core code rather than INTERNAL', async () => {
    const outcome = await dispatchThrowing(
      new RefusalError(ErrorCode.CONFLICT_DETECTED, LEAKY_DETAIL))
    expect(errorOf(outcome.response).code).toBe(ErrorCode.CONFLICT_DETECTED)
  })

  it.each([
    [ErrorCode.CONFLICT_DETECTED, 409],
    [ErrorCode.TRUNCATION_BLOCKED, 409],
    [ErrorCode.STALE_TARGET, 409],
    [ErrorCode.IDENTITY_CHANGED, 409],
    [ErrorCode.PARENT_MISSING, 409],
    [ErrorCode.TOO_LARGE, 413],
    [ErrorCode.PERMISSION_DENIED, 403],
    [ErrorCode.FILE_IMMUTABLE, 403],
    [ErrorCode.DISK_FULL, 507],
    [ErrorCode.LOG_FULL, 507],
    [ErrorCode.IO_FAILED, 500],
    // The default: a refusal is the server declining, not the server failing.
    [ErrorCode.INVALID_ROOT, 400],
    [ErrorCode.NOT_MARKDOWN, 400],
    [ErrorCode.NAME_TOO_LONG, 400],
  ])('%s answers %i', async (code, status) => {
    const outcome = await dispatchThrowing(new RefusalError(code, 'detail'))
    expect(outcome.status).toBe(status)
  })

  it('EVERY code has a sentence of its own — an unmapped one is not a caught omission', async () => {
    /**
     * **The list above is hand-written, so a new code gets no coverage by default** — and an
     * unmapped code does not fail, it falls back to `MESSAGES[INTERNAL]`: *"The operation could not
     * be completed."* That is precisely the flattening defect found on 2026-08-08, where every
     * refusal reached the client as one useless sentence — reappearing, quietly, for every code
     * added after it was fixed.
     *
     * Found at Phase 4's gate when `STALE_TARGET` was added and nothing failed. This makes the
     * omission structural: adding a code to the enum without deciding what it says turns this red.
     */
    const generic = 'The operation could not be completed.'
    const unmapped: string[] = []
    for (const code of Object.values(ErrorCode)) {
      const outcome = await dispatchThrowing(new RefusalError(code, 'detail'))
      const message = errorOf(outcome.response).message
      if (message === generic || message === 'Error.') unmapped.push(code)
    }
    expect(unmapped, `codes with no sentence of their own: ${unmapped.join(', ')}`).toEqual([])
  })

  it('sends a fixed sentence, never the refusal detail — §6', async () => {
    const outcome = await dispatchThrowing(
      new RefusalError(ErrorCode.PERMISSION_DENIED, LEAKY_DETAIL))
    const error = errorOf(outcome.response)
    expect(error.message).not.toContain('/Users/somebody')
    expect(error.message).not.toContain('private-notes')
    expect(JSON.stringify(outcome.response)).not.toContain('/Users/somebody')
    expect(error.message).toBe('The file could not be read or written — check its permissions.')
  })

  it('still hands the whole exception to the caller for the local log', async () => {
    const thrown = new RefusalError(ErrorCode.DISK_FULL, LEAKY_DETAIL)
    const outcome = await dispatchThrowing(thrown)
    expect(outcome.thrown).toBe(thrown)
    expect(String((outcome.thrown as Error).message)).toContain('/Users/somebody')
  })

  it('a code with no sentence in the table still keeps its code', async () => {
    // The fallback must be a vague message, never a wrong one and never back to INTERNAL.
    const outcome = await dispatchThrowing(new RefusalError(ErrorCode.PATH_NUL, 'detail'))
    expect(errorOf(outcome.response).code).toBe(ErrorCode.PATH_NUL)
    expect(outcome.status).toBe(400)
  })
})

describe('a crash does not get to borrow a refusal code', () => {
  it('a plain Error becomes INTERNAL', async () => {
    const outcome = await dispatchThrowing(new Error('something broke'))
    expect(errorOf(outcome.response).code).toBe(TransportErrorCode.INTERNAL)
    expect(outcome.status).toBe(500)
  })

  it('THE ONE THAT MATTERS: a Node filesystem error is not a refusal', async () => {
    // Every `fs` rejection carries `.code`. If the brand check were a `.code` property test — the
    // obvious way to write it, and the mutation that went green — a raw ENOENT escaping any
    // handler would reach the client looking like a decision the server made, with the errno as
    // its machine code and whatever the OS wrote in `.message` beside it.
    const errno = Object.assign(new Error('ENOENT: no such file or directory, open \'/etc/shadow\''), {
      code: 'ENOENT', errno: -2, path: '/etc/shadow', syscall: 'open',
    })
    const outcome = await dispatchThrowing(errno)
    expect(errorOf(outcome.response).code).toBe(TransportErrorCode.INTERNAL)
    expect(JSON.stringify(outcome.response)).not.toContain('/etc/shadow')
    expect(JSON.stringify(outcome.response)).not.toContain('ENOENT')
  })

  it('an fs-shaped error whose code happens to match a Core code is still not a refusal', async () => {
    // Not hypothetical in spirit: the two namespaces are independent, and nothing stops a library
    // from throwing `{ code: 'IO_FAILED' }`. Only the brand decides.
    const outcome = await dispatchThrowing(Object.assign(new Error('x'), { code: 'IO_FAILED' }))
    expect(errorOf(outcome.response).code).toBe(TransportErrorCode.INTERNAL)
  })

  it('a branded value carrying a code that is not a Core code is refused as INTERNAL', async () => {
    const forged = Object.assign(new Error('x'), {
      [Symbol.for('soil-viewer.refusal-code')]: 'NOT_A_REAL_CODE',
    })
    const outcome = await dispatchThrowing(forged)
    expect(errorOf(outcome.response).code).toBe(TransportErrorCode.INTERNAL)
    expect(JSON.stringify(outcome.response)).not.toContain('NOT_A_REAL_CODE')
  })

  it.each([null, undefined, 'a string', 42])('a thrown %s becomes INTERNAL', async (thrown) => {
    const outcome = await dispatchThrowing(thrown)
    expect(errorOf(outcome.response).code).toBe(TransportErrorCode.INTERNAL)
  })
})
