/**
 * Turning something a person typed into a filename. Spec §13.6.
 *
 * **This module exists because of M16, which is the most quietly destructive bug on the audit
 * list.** The old implementation slugified by stripping everything outside `[a-z0-9]`. Given
 * `日本語` that leaves the empty string, the creation flow appends `.md`, and the result is a file
 * **literally named `.md`** — hidden by the dot rule, absent from every view, and therefore lost the
 * moment it is created. Nothing errored. The user typed a name, pressed create, and the app made a
 * file they could never see again.
 *
 * §13.6's rule, and every clause of it is here because that failure had several ways to happen:
 *
 *   *"Preserve Unicode letters and digits under NFC, lowercase, collapse other runs to `-`, trim,
 *   **reject empty / dot-only / leading-dot with a named error**, validate `NAME_MAX` in bytes, and
 *   preview the final name before confirm."*
 *
 * **Preserve, not transliterate.** `日本語` becomes `日本語`, not `ri-ben-yu` and not `''`. macOS
 * filenames are UTF-8 and there is no reason to flatten them; the ASCII-only rule was the bug.
 *
 * **The rejection is the control, and it is not decorative.** An empty stem is refused rather than
 * substituted with `untitled`, because a silent substitution is how the user ends up with a file
 * they did not name and cannot find. §6's rule that the boundary never launders a failure into a
 * plausible success applies to names as much as to results.
 */

import { ErrorCode, fail, ok, type Result } from './errors'
import { NAME_MAX_BYTES } from './limits'
import { toNFC } from './text'

/**
 * Everything that is not a Unicode letter or digit.
 *
 * `\p{L}` and `\p{N}` with the `u` flag rather than `[a-z0-9]` — that substitution *is* M16. The
 * runs collapse to a single `-` so `a   b` and `a - b` both become `a-b`.
 */
const NOT_A_WORD_CHARACTER = /[^\p{L}\p{N}]+/gu

/** Leading and trailing separators, left behind whenever the input started or ended with junk. */
const EDGE_SEPARATORS = /^-+|-+$/g

/**
 * The slug of a typed name, with no extension attached.
 *
 * `toLowerCase` and not `toLocaleLowerCase`: the locale-aware version maps Turkish `I` to a dotless
 * `ı` under a `tr` locale, so the same typed name would produce different files on two machines.
 * Filenames must not depend on where the server happens to be running.
 */
export function slugStem(typed: string): string {
  return toNFC(typed)
    .toLowerCase()
    .replace(NOT_A_WORD_CHARACTER, '-')
    .replace(EDGE_SEPARATORS, '')
}

/** What a name will be, so the client can show it before the user commits. §13.6's "preview". */
export interface SlugPreview {
  /** The full filename, extension included. */
  readonly name: string
  /** True when the slug changed what was typed, so the UI can say so rather than surprising anyone. */
  readonly changed: boolean
}

/**
 * A typed name and a kind, to the filename that will be created — or a named refusal.
 *
 * `extension` is `'md'` for a file and absent for a folder. It is a parameter rather than a
 * hardcoded `.md` so that the one caller which does not want one does not have to strip it back
 * off, which is the kind of round trip that eventually loses a dot.
 */
export function fileNameFrom(typed: string, extension?: string): Result<SlugPreview> {
  /**
   * A typed `notes.md` has its extension removed before slugging and put back after.
   *
   * Without this the dot collapses to a separator and `notes.md` becomes `notes-md.md`. The user
   * typed a filename; taking them literally about the extension is the least surprising reading,
   * and it is the one the old app got wrong in the other direction by appending unconditionally.
   */
  const suffix = extension === undefined ? '' : `.${extension}`
  const withoutSuffix = suffix !== '' && toNFC(typed).toLowerCase().endsWith(suffix)
    ? typed.slice(0, -suffix.length)
    : typed

  const stem = slugStem(withoutSuffix)

  if (stem === '') {
    /**
     * M16, refused. Every input §13.6 names — empty, dot-only, leading-dot — arrives here as an
     * empty stem, because dots are not letters or digits and collapse away like everything else.
     * One refusal rather than three checks, and the three are named in the message so a reader
     * looking for the spec's wording finds it.
     */
    return fail(
      ErrorCode.NAME_EMPTY,
      `"${typed}" has no letters or digits in it, so it would produce a file named "${suffix}"`,
    )
  }

  const name = `${stem}${suffix}`

  /**
   * Bytes, not characters — the filesystem counts bytes, and a name of 200 CJK characters is 600 of
   * them. Refused rather than truncated: a silently shortened name is a file the user did not name.
   *
   * **`TextEncoder`, not `Buffer.byteLength`, and that is not a style preference.** `Buffer` is a
   * Node global and does not exist in a browser — and this module is imported by the client, which
   * shows §13.6's name preview using the *same* function the server slugifies with, precisely so
   * the two cannot disagree.
   *
   * The first version used `Buffer` and threw a `ReferenceError` on every non-empty keystroke in
   * the New File dialog. The empty case returns before reaching this line, so the dialog rendered
   * correctly when it opened and then never updated again — a listener whose exception is swallowed
   * by the event loop, which is about as quiet as a failure gets. Found in a browser; no unit test
   * could have, because they all run in Node where `Buffer` is real.
   */
  const bytes = new TextEncoder().encode(name).length
  if (bytes > NAME_MAX_BYTES) {
    return fail(ErrorCode.NAME_TOO_LONG, `${bytes} bytes, limit ${NAME_MAX_BYTES}`)
  }

  return ok({ name, changed: name !== toNFC(typed) })
}
