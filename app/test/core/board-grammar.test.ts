import { describe, expect, it } from 'vitest'
import {
  BOARD_PREFIX,
  boardDisplayName,
  boardPrefixesAgree,
  isArchived,
  isBoardFolder,
  laneDisplayName,
  typedName,
} from '../../src/core/grammar'

/**
 * **WHAT MAKES A FOLDER A BOARD.** P14, spec §3's grammar extended by one rule.
 *
 * the call on recognition: *"they would know because the name would be board-dash-anything…
 * that's probably the safest bet."* A prefix rather than a list, because unlike lanes and inboxes
 * the set is open — they name these themselves and there is no roster to keep.
 *
 * **The whole point of testing this in `core` is that it is the single source.** §3 exists because
 * v1 had three name lists with three different semantics. A `startsWith` written at a call site
 * would be the fourth, would look right, and would be wrong in the two ways below.
 */

describe('isBoardFolder', () => {
  it('matches a board the app made', () => {
    expect(isBoardFolder('board-tuesday-drops')).toBe(true)
  })

  /**
   * **The rule is spelled twice — a constant and an anchored pattern — and this is what stops them
   * drifting.**
   *
   * §5 bans raw `startsWith`, and the lint rule enforcing it says a genuine non-path use is *an
   * escalation, not a local disable*. `url-safety.ts` hit the same wall and answered it with an
   * anchored pattern, so this follows a precedent already argued rather than opening a second one.
   * The cost of that precedent is two spellings of one rule, which is exactly the drift §3 exists to
   * end — so it is asserted rather than trusted.
   *
   * MUTATION: change `BOARD_PREFIX` to `'boards-'` and leave the pattern alone. Reddens here, and
   * `boardDisplayName` would otherwise start slicing one character short in silence.
   */
  it('the constant and the anchored pattern still say the same thing', () => {
    expect(boardPrefixesAgree(), 'BOARD_PREFIX and BOARD_SEGMENT have drifted apart').toBe(true)
  })

  /**
   * **The two cases a bare `startsWith('board-')` fails**, and the reason this goes through
   * `grammarKey` like every other name test in the file.
   *
   * MUTATION: `segment.startsWith(BOARD_PREFIX)`, no normalization. Both of these redden.
   */
  it('matches through the case-fold and the NN- strip, as §3 requires of every name test', () => {
    expect(isBoardFolder('Board-Tuesday-Drops'), 'case-folded').toBe(true)
    expect(isBoardFolder('01-board-tuesday-drops'), 'numeric prefix stripped').toBe(true)
    expect(isBoardFolder('BOARD-notes')).toBe(true)
  })

  /**
   * **`boardroom` is not a board, and this is the case the trailing hyphen exists for.**
   *
   * MUTATION: drop the `-` from `BOARD_PREFIX`. Reads identically to someone skimming, and swallows
   * every folder whose name merely begins that way — `boardroom`, `boarding-passes`, `boards`.
   */
  it('does not match a folder that merely starts with the letters', () => {
    expect(isBoardFolder('boardroom')).toBe(false)
    expect(isBoardFolder('boarding-passes')).toBe(false)
    expect(isBoardFolder('boards')).toBe(false)
    expect(isBoardFolder('board')).toBe(false)
  })

  it('does not match unrelated folders, including the ones that carry cards today', () => {
    expect(isBoardFolder('02-projects')).toBe(false)
    expect(isBoardFolder('tasks')).toBe(false)
    expect(isBoardFolder('01-inbox')).toBe(false)
    expect(isBoardFolder('')).toBe(false)
  })

  /**
   * A board is still a folder, so §3's archive rule covers it with no second statement — *"a match
   * at ANY ancestor level"*. Asserted rather than assumed, because the discovery walk is the thing
   * that has to remember to ask, and this is the pairing that says what it must ask.
   *
   * MUTATION: drop the archive check from the walk. This states the contract the walk owes.
   */
  it('is subject to the archive rule like anything else — the walk owes this', () => {
    expect(isBoardFolder('board-old-launch')).toBe(true)
    expect(isArchived(['archive', 'board-old-launch'])).toBe(true)
    expect(isArchived(['02-projects', 'thing', 'archive', 'board-old-launch'])).toBe(true)
    expect(isArchived(['02-projects', 'thing', 'board-old-launch'])).toBe(false)
  })
})

describe('boardDisplayName', () => {
  /**
   * **It hands back the sentence the operator typed.** They type `Tuesday drops`, the app kebab-cases it
   * into `board-tuesday-drops`, and this is the step that closes the loop.
   *
   * MUTATION: reuse `laneDisplayName`, which title-cases every word. It would show "Tuesday Drops"
   * for a board they named `Tuesday drops` — the round trip visibly not closing.
   */
  it('capitalises the first word only, so their own name comes back', () => {
    expect(boardDisplayName('board-tuesday-drops')).toBe('Tuesday drops')
    expect(boardDisplayName('board-q4-launch-plan')).toBe('Q4 launch plan')
    expect(boardDisplayName('board-notes')).toBe('Notes')
  })

  it('strips a numeric prefix before the board prefix, in that order', () => {
    expect(boardDisplayName('01-board-tuesday-drops')).toBe('Tuesday drops')
  })

  /**
   * MUTATION: drop the `isBoardFolder` guard and slice a fixed six characters unconditionally.
   *
   * Without the guard this returns "ing-notes" for a folder called `meeting-notes` — six letters
   * eaten and the wreckage shown as a title, which reads as a naming mistake by whoever made the
   * folder rather than as a bug here.
   */
  it('returns a non-board its own name rather than eating six characters', () => {
    expect(boardDisplayName('meeting-notes')).toBe('Meeting notes')
    expect(boardDisplayName('tasks')).toBe('Tasks')
  })

  it('survives a board with nothing after the prefix', () => {
    expect(boardDisplayName(`${BOARD_PREFIX}`)).toBe('')
  })
})

/**
 * **EVERY NAME IN BOARDS IS ONE THE OPERATOR TYPED, AND A TEST IS WHAT ESTABLISHED THAT.**
 *
 * `boardContents` first reused `laneDisplayName` for column names, on the reasoning that a column
 * resembles a lane. The test below failed with "In Progress" against an expected "In progress", and
 * the failure was the right one: **a lane comes from a fixed roster the app owns; a column is
 * whatever they typed** — *"I can name and create these things on the fly."*
 *
 * So boards and columns share one rule, `typedName`, and lanes keep theirs.
 */
describe('typedName — the shared rule for names the operator types', () => {
  it('capitalises the first word only, unlike a lane label', () => {
    expect(typedName('in-progress')).toBe('In progress')
    expect(typedName('waiting-on-hallberg')).toBe('Waiting on hallberg')
    expect(typedName('done')).toBe('Done')
  })

  /**
   * MUTATION: point `typedName` at `laneDisplayName`. Reddens here and in `board-contents`.
   *
   * Stated as a contrast rather than in isolation, because the bug is not that either function is
   * wrong — it is that the wrong one gets reached for, which only a side-by-side assertion catches.
   */
  it('differs from laneDisplayName, which title-cases a fixed roster', () => {
    expect(laneDisplayName('03-back-burner'), 'a lane, from the roster').toBe('Back Burner')
    expect(typedName('03-back-burner'), 'the same folder, named by them').toBe('Back burner')
  })

  it('strips a numeric prefix, like every other display name here', () => {
    expect(typedName('01-in-progress')).toBe('In progress')
  })

  it('and a board name is this rule with the prefix taken off first', () => {
    expect(boardDisplayName('board-tuesday-drops')).toBe(typedName('tuesday-drops'))
  })
})
