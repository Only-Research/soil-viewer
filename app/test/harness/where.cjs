/**
 * Where the harness keeps its things. Defined ONCE.
 *
 * **The dead-path repair, and the shape of the original defect is worth keeping.** Ten scripts each
 * carried this line:
 *
 *     const S = '/private/tmp/claude-501/.../a1137f5e-.../scratchpad'
 *
 * — a session scratch directory that no longer exists. The artefacts it pointed at (`manifest.json`,
 * `results.json`, `report.json`, `full-tree.json`, `survivors.json`, `tree-records.json`, plus
 * `corpus/` and `probes/`) were later copied into the harness directory itself and **the readers
 * were never repointed**. So the whole instrument was reading from nowhere, and only
 * `lossless-check.cjs` looked broken — because its file, `mech-census.json`, was the one that never
 * got copied at all. Nine scripts failing silently and one failing loudly is how a broken instrument
 * passes for a working one.
 *
 * It resolves from this file's own location, so moving the harness moves its data with it and there
 * is no string for a future copy to agree with today and disagree with later.
 */
const path = require('node:path')

/** The harness directory — where the corpus, the probes and every artefact live. */
const S = __dirname

module.exports = {
  S,
  /** Join onto the harness directory. The only way these scripts should build a path. */
  at: (...parts) => path.join(S, ...parts),
}
