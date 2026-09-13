/**
 * **NUMBERS BOTH SIDES NEED, IN A FILE THAT TOUCHES NOTHING.** The security review, P11 C5.
 *
 * Two constants used to live beside the code that acts on them — `NAME_MAX_BYTES` in `fs/write.ts`,
 * `MAX_EDITABLE_BYTES` in `fs/document.ts` — which is where a value belongs right up until the
 * *browser* needs it. Both of those modules import `node:fs`, `node:path` and `node:crypto`, so the
 * client asking for one number put a server-only module on its import graph.
 *
 * **It was harmless, and harmless by luck rather than by design.** Rollup can prove a bare `const`
 * side-effect-free and drop the rest, so nothing shipped. The security review measured what happens when the same
 * import is a *called function* instead: the bundle carries an empty object where the builtin was,
 * and the failure is a `TypeError` **when the binding is used** — conditional on a code path, which
 * is worse than a loud failure at load.
 *
 * So the numbers move somewhere with no imports at all. This file cannot pull anything into a
 * bundle because there is nothing in it to pull, and *"no server module reaches the browser"*
 * becomes a bar the build can hold to with no exception list — which record item 47 is about.
 *
 * **The rules that use these numbers stay where they are.** Only the values moved.
 */

/**
 * The longest a single path segment may be, in bytes.
 *
 * 255 is the ceiling on APFS and HFS+ and is enforced **in bytes rather than characters**, because
 * a name of 200 emoji is well past it. `fs/write.ts` needs it because a name near the limit produces
 * a temp path that cannot be created — and in the old app that overflow hit the *conflict* file,
 * where the consequence was `ENAMETOOLONG` and **the edit it existed to rescue was gone**.
 *
 * The client needs it to say so before a name is typed rather than after it is refused.
 */
export const NAME_MAX_BYTES = 255

/**
 * The largest file the editor will open, in bytes.
 *
 * Distinct from `MAX_READ_BYTES` (25 MB, §4), which bounds *any* read: a 10 MB file is readable for
 * indexing and is not editable. The client needs this to explain a file it will not open without
 * asking the server first.
 */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024
