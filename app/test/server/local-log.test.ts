import { describe, expect, it } from 'vitest'

import { ErrorCode, fail, ok, type Result } from '../../src/core/errors'
import type { AppendLog } from '../../src/core/fs/append-log'
import { createLocalLog } from '../../src/server/local-log'

/**
 * The local log is where the reason for every other failure lives, and until 2026-09-02 its own
 * failure went nowhere: every caller discards its Result — correctly, diagnostics must not fail a
 * request — so a sink that refused produced silence. Once the sink gained a size cap, silence became
 * a state the app reaches by design. A refused entry now also goes to a last resort, stderr by
 * default, which is what a LaunchAgent captures.
 */

function sinkThat(result: Result<void>): AppendLog & { readonly lines: string[] } {
  const lines: string[] = []
  return {
    path: '/nowhere/local.log',
    lines,
    append: async line => { lines.push(line); return result },
  }
}

const ENTRY = { timestamp: '2026-09-02T00:00:00.000Z', level: 'warn', at: 'guards', detail: 'why' } as const

describe('the local log', () => {
  it('writes one JSON line per entry to its sink', async () => {
    const sink = sinkThat(ok(undefined))
    const log = createLocalLog(sink, () => ENTRY.timestamp, () => { throw new Error('must not fire') })

    const written = await log.write(ENTRY)

    expect(written.ok).toBe(true)
    expect(sink.lines).toHaveLength(1)
    expect(JSON.parse(sink.lines[0] ?? '')).toEqual(ENTRY)
  })

  it('sends a refused entry to the last resort — and still reports the failure to the caller', async () => {
    const sink = sinkThat(fail(ErrorCode.LOG_FULL, '/state/local.log has reached its cap'))
    const landed: string[] = []
    const log = createLocalLog(sink, () => 'now', line => { landed.push(line) })

    const written = await log.write({ ...ENTRY, level: 'error', at: 'route:file.save', detail: 'a path would go here' })

    expect(written.ok, 'the caller is still told').toBe(false)
    expect(landed).toHaveLength(1)
    expect(landed[0]).toContain('LOG_FULL')
    expect(landed[0]).toContain('has reached its cap')
    expect(landed[0]).toContain('error at route:file.save')
    expect(landed[0], 'the detail stays out of a file that is not 0600').not.toContain('a path would go here')
    expect(landed[0]?.endsWith('\n'), 'one line, terminated').toBe(true)
  })

  it('leaves the last resort alone when the sink accepts', async () => {
    const sink = sinkThat(ok(undefined))
    const landed: string[] = []
    const log = createLocalLog(sink, () => 'now', line => { landed.push(line) })

    await log.recordException('listener', new Error('boom'))

    expect(landed).toHaveLength(0)
    expect(sink.lines[0]).toContain('boom')
  })

  it('the exception recorder goes through the same last resort', async () => {
    const sink = sinkThat(fail(ErrorCode.IO_FAILED, 'EIO'))
    const landed: string[] = []
    const log = createLocalLog(sink, () => 'now', line => { landed.push(line) })

    const written = await log.recordException('listener', new Error('boom'))

    expect(written.ok).toBe(false)
    expect(landed).toHaveLength(1)
    expect(landed[0]).toContain('IO_FAILED')
    expect(landed[0], 'the stack trace is detail, and detail stays out').not.toContain('boom')
  })
})
