/**
 * How the harness decides whether a file survived. **The one place that decides it.**
 *
 * ---
 *
 * ## What was wrong, precisely — and it is not what the build plan says
 *
 * The build plan justifies byte comparison by saying the decoded read *"would score 100% on a build
 * that silently normalized line endings."* **That is false.** `readFileSync(f, 'utf8')` on a CRLF
 * file yields a string containing `\r\n`; if the editor writes back `\n` the strings differ and the
 * file is correctly failed. More generally UTF-8 is **injective on valid input**, so for any file
 * whose bytes are valid UTF-8, equal decoded strings imply equal bytes. The old comparison was
 * sound for every such file.
 *
 * **The hole is exactly one case, and it lands on the acceptance condition's special case.**
 * Invalid UTF-8 decodes to U+FFFD, and *different* invalid byte sequences decode to the *same*
 * replacement characters — so they compare equal while the bytes differ. The real tree contains two
 * such files. §12 requires a compliant build to **refuse** them rather than round-trip them, and
 * P6's gate says those two "pass by being correctly refused". A decoded comparison cannot tell
 * "correctly refused" from "mangled and re-encoded", which is the one distinction those two files
 * exist to test.
 *
 * ## And a deeper one the plan does not mention at all
 *
 * The driver hands the editor a **string** — `window.RT.run(${JSON.stringify(input)})`. So the
 * lossy decode happens *before the editor is involved*. For an invalid-UTF-8 file the harness is
 * not measuring the editor at all; it is measuring its own decoder, and whatever it reports is
 * about the harness. **Those files therefore cannot be scored as round-trip passes or failures.**
 * They are a third outcome, named and counted separately, which is also what §12 asks the app to
 * do with them.
 *
 * A harness that quietly folded them into either column would be reporting a number about a
 * measurement it did not make.
 */

/** What a file's bytes are, before anything is run against them. */
const READABLE = 'readable'          // passes §12's gate; the editor can be given it and judged
const NOT_EDITABLE = 'not-editable'  // §12 says refuse; this driver cannot round-trip it at all

/**
 * True when these bytes survive a UTF-8 decode and re-encode unchanged.
 *
 * The check is the round trip itself rather than a hand-written validator: whatever Node's decoder
 * does is what the harness will do to this file, so asking the decoder is asking the right thing.
 */
function isValidUtf8(bytes) {
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
}

/**
 * Classify a file's bytes against **§12's editability gate, both halves of it**.
 *
 * *"A `.md` file is editable only if its bytes decode as valid UTF-8 **with no NUL**. Failing either
 * opens the non-editing pane with a reason."*
 *
 * **This checked only the UTF-8 half until the corpus caught it.** A NUL-bearing file is perfectly
 * valid UTF-8 — NUL is a legal code point — so it sailed into the round-trip denominator, where a
 * compliant editor *refusing it* would have been scored as a failure to round-trip. The harness
 * would have marked correct behaviour wrong, on one of the two files §12 was written for.
 *
 * Found by adding the two byte-level probes and printing the denominator: the invalid-UTF-8 file
 * was excluded and the NUL file was not. **A unit test of the classifier could not have found it** —
 * the classifier did exactly what it said. It took building the corpus the classifier is for.
 */
function classify(bytes) {
  if (!isValidUtf8(bytes)) return NOT_EDITABLE
  if (bytes.includes(0)) return NOT_EDITABLE
  return READABLE
}

/**
 * Did the editor return these bytes unchanged?
 *
 * `output` is the string the editor produced. It is **re-encoded to UTF-8 and compared as bytes**,
 * never compared as a string — see the header for the one case where those differ, and for why that
 * case is the whole point.
 *
 * Returns `null` for a file §12 says to refuse: there is no honest answer. For invalid UTF-8 the
 * input the editor received was already not this file; for a NUL-bearing one a compliant editor
 * declines to open it at all, so "did it round-trip" is a question about something that correctly
 * never happened.
 */
function survived(bytes, output) {
  if (classify(bytes) === NOT_EDITABLE) return null
  if (typeof output !== 'string') return false
  return Buffer.from(output, 'utf8').equals(bytes)
}

/**
 * The denominator, stated as code so it cannot drift from the number quoted beside it.
 *
 * `records` are `{ path, bytes, output }`. Everything is counted into exactly one bucket, and the
 * buckets are asserted to sum to the total — because a file silently belonging to none of them is
 * how a percentage grows without anything improving.
 */
function tally(records) {
  const identical = []
  const changed = []
  const notEditable = []
  const errored = []

  for (const record of records) {
    if (classify(record.bytes) === NOT_EDITABLE) { notEditable.push(record.path); continue }
    if (typeof record.output !== 'string') { errored.push(record.path); continue }
    if (survived(record.bytes, record.output)) identical.push(record.path)
    else changed.push(record.path)
  }

  const total = records.length
  const counted = identical.length + changed.length + notEditable.length + errored.length
  if (counted !== total) {
    /**
     * Loud, not a log line. A miscount here is a wrong number in the one report this build treats
     * as authoritative — and the direction that mistake moves the percentage is **up**.
     *
     * **UNREACHABLE BY CONSTRUCTION today, and recorded as such rather than counted as coverage.**
     * Every record above hits a `continue` or one of the two terminal branches, so nothing can fall
     * through all four buckets. It is insurance against a future edit that adds a bucket and
     * forgets it. The same status as the short-write assertions in `conflict.ts` and
     * `config-store.ts`: believed correct, not known to fire, and said out loud rather than left
     * for a later reader to cite as proof of something.
     */
    throw new Error(`denominator does not close: ${counted} counted, ${total} records`)
  }

  return {
    total,
    identical,
    changed,
    notEditable,
    errored,
    /**
     * **The published figure, and its denominator excludes what §12 says to refuse.**
     *
     * Those files are not failures — refusing them is the required behaviour — and they are not
     * passes, because the editor was never honestly given them. Counting them either way puts a
     * number on a measurement that was not made, **and the direction that mistake usually moves the
     * percentage is up.** They are reported alongside, by name.
     */
    roundTrippable: total - notEditable.length,
    percentIdentical: total - notEditable.length === 0
      ? null
      : (100 * identical.length) / (total - notEditable.length),
  }
}

module.exports = { READABLE, NOT_EDITABLE, isValidUtf8, classify, survived, tally }
