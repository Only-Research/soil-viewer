/**
 * **THE SHARED RESULT SCHEMA.** P5's deferred finding, carried to P6 and closed here.
 *
 * P5's gate found four readers each re-deriving the harness's result shape from whatever the author
 * remembered — structurally identical to the ten scripts that carried private copies of a path,
 * which is the defect that phase opened with. It cost real failures: `analyze.cjs` and `show.cjs`
 * broke when the shape gained an excluded-file case, and `summarize-full.cjs` reported files the
 * instrument *deliberately declined to measure* as failures of the thing being measured.
 *
 * The shape now has one declaration. The `.cjs` modules stay JavaScript — rewriting a working
 * instrument in TypeScript at its own gate is the kind of change that makes a number untrustworthy
 * for a whole phase — but every TypeScript reader is checked against this, so a driver that expects
 * a field the tally does not produce fails to compile instead of reporting a confident wrong number.
 *
 * Ambient rather than emitted: `noEmit` is on, and these declarations exist so the *readers* are
 * constrained, not so the harness gains a build step.
 */

declare module '*/compare.cjs' {
  /** A file that may honestly be scored. */
  export const READABLE: 'readable'
  /** A file §12 requires the editor to refuse: not valid UTF-8, or containing a NUL. */
  export const NOT_EDITABLE: 'not-editable'

  export function isValidUtf8(bytes: Buffer): boolean
  export function classify(bytes: Buffer): typeof READABLE | typeof NOT_EDITABLE

  /**
   * Did the editor return these bytes unchanged? `null` for a file §12 says to refuse — there is no
   * honest answer, and both "pass" and "fail" would be a number put on a measurement never made.
   */
  export function survived(bytes: Buffer, output: unknown): boolean | null

  export interface TallyRecord {
    readonly path: string
    readonly bytes: Buffer
    /** The string the editor produced, or anything else — including `null` — when it did not. */
    readonly output: string | null
  }

  export interface TallyResult {
    readonly total: number
    readonly identical: readonly string[]
    readonly changed: readonly string[]
    /** Excluded by §12 and reported by name. Never counted as a pass or a failure. */
    readonly notEditable: readonly string[]
    readonly errored: readonly string[]
    /** `total` minus the excluded — the denominator the percentage is actually over. */
    readonly roundTrippable: number
    /** `null` when nothing was round-trippable, so an empty run cannot report 100%. */
    readonly percentIdentical: number | null
  }

  export function tally(records: readonly TallyRecord[]): TallyResult
}

declare module '*/corpus.cjs' {
  export const PROBES: string
  export const SAMPLE: string

  export interface CorpusEntry {
    readonly group: 'probe' | 'corpus'
    readonly name: string
    readonly file: string
  }

  export function denominator(): CorpusEntry[]

  /** The denominator as **bytes**. Never a decoded string — see `compare.cjs` for why. */
  export function readAll(): (CorpusEntry & { readonly path: string; readonly bytes: Buffer })[]
}
