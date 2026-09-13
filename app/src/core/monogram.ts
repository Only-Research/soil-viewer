/**
 * **Monograms — the tinted initials that give a list its left column.** Packet §4.7.
 *
 * the operator asked the Inbox to feel *"almost like an email like Gmail mobile app"*, and the mark at
 * the start of a row is most of what makes such a list scannable.
 *
 * **The hash is the chatroom's**, deliberately. `colourFor` in `chatroom-view.ts` already assigns a
 * stable colour to a name, and inventing a second rule would mean two things in this app that look
 * like they agree until the day they do not. Same shape, same folding, different palette.
 *
 * Framework-free and in Core so the rules below can be tested without a browser — the initials from
 * a numbered folder, from a single word, from a name that is only punctuation.
 */

/** How many `--mono-bg-N` / `--mono-fg-N` pairs the stylesheet defines. */
export const MONOGRAM_SLOTS = 4

export interface Monogram {
  /** One or two characters, upper-cased. Never empty — see `FALLBACK`. */
  readonly initials: string
  /** 1…`MONOGRAM_SLOTS`, naming a token pair. */
  readonly slot: number
}

/**
 * What a name with no letters in it gets.
 *
 * A folder can legitimately be called `01-` or `—`. Returning an empty string would draw a coloured
 * circle with nothing in it, which reads as a rendering fault rather than as a name.
 */
const FALLBACK = '·'

/**
 * **The grammar prefix is dropped before the initials are taken.**
 *
 * The soil numbers its folders — `01-inbox`, `02-work`, `99-inbox-main` — and initials taken from
 * the raw string would be `01`, `02`, `99`: the ordering, which is the one part of the name that
 * says nothing about what is inside. `boardView`'s lane naming strips the same prefix for the same
 * reason.
 *
 * Only a leading run of digits followed by a separator. A folder genuinely called `2026` keeps its
 * name, because there is no separator and nothing to suggest the digits are a prefix.
 */
const GRAMMAR_PREFIX = /^\d+[-_. ]+/

/** Words are split on the separators the soil actually uses, not on whitespace alone. */
const SEPARATORS = /[-_. ]+/

export function monogramFor(label: string): Monogram {
  const stem = label.trim().replace(GRAMMAR_PREFIX, '')
  const words = stem.split(SEPARATORS).filter(word => word.length > 0)

  /**
   * **Two initials from two words, two characters from one.**
   *
   * `cider-line` gives `CL`; `orchard` gives `OR`. A single letter in a 34px circle looks like a
   * mistake at the sizes §4.7 uses, and the second character of a word is free information.
   *
   * Taken with the spread rather than by index, so an astral character — an emoji folder name is
   * legal on this filesystem — counts as one character instead of half of a surrogate pair.
   */
  const first = words[0] ?? ''
  const second = words[1]
  const letters = second === undefined
    ? [...first].slice(0, 2)
    : [[...first][0] ?? '', [...second][0] ?? '']

  const initials = letters.join('').toUpperCase()

  /**
   * **Hashed on the stem, not on the initials.** Two different folders that share initials — say
   * `cider-line` and `crop-log`, both `CL` — must not collapse into one colour as well, or the
   * mark stops distinguishing them at exactly the moment it is needed.
   *
   * Case-folded so a rename that only changes capitalisation does not change the colour.
   */
  const identity = stem.toLowerCase()
  let hash = 0
  for (const character of identity) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 100_000

  return {
    initials: initials === '' ? FALLBACK : initials,
    slot: (hash % MONOGRAM_SLOTS) + 1,
  }
}
