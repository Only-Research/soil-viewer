import { describe, expect, it } from 'vitest'
import { boardContents, type BoardContentSource } from '../../src/core/boards'
import { UNCATEGORIZED_LANE_ID, UNCATEGORIZED_LANE_LABEL } from '../../src/core/grammar'

/**
 * **OPENING A BOARD — columns and cards.** P14 B2.
 *
 * Pure over index rows, so every rule is provable without a fixture tree: what is a column, what is
 * a card, what is neither, and where the loose markdown goes.
 */

const BOARD = { rootId: 'r1', segments: ['02-projects', 'coffee', 'board-tuesday-drops'] }

const dir = (...segments: string[]): BoardContentSource => ({
  rootId: 'r1', segments, kind: 'directory', name: segments[segments.length - 1] ?? '', title: '',
})
const md = (title: string, ...segments: string[]): BoardContentSource => ({
  rootId: 'r1', segments, kind: 'file', name: segments[segments.length - 1] ?? '', title,
})
const other = (...segments: string[]): BoardContentSource => ({
  rootId: 'r1', segments, kind: 'file', name: segments[segments.length - 1] ?? '', title: '',
})

/** A board with two columns and a card in each — the ordinary shape, reused across cases. */
const ORDINARY: BoardContentSource[] = [
  dir(...BOARD.segments),
  dir(...BOARD.segments, 'doing'),
  dir(...BOARD.segments, 'done'),
  md('Roast profile', ...BOARD.segments, 'doing', 'roast.md'),
  md('Label proofs', ...BOARD.segments, 'done', 'labels.md'),
]

describe('boardContents', () => {
  it('a column is a folder, a card is the markdown inside it', () => {
    const columns = boardContents(ORDINARY, BOARD)

    expect(columns.map(column => column.id)).toEqual(['doing', 'done'])
    expect(columns[0]?.name).toBe('Doing')
    expect(columns[0]?.cards.map(card => card.title)).toEqual(['Roast profile'])
    expect(columns[1]?.cards.map(card => card.title)).toEqual(['Label proofs'])
  })

  /**
   * MUTATION: use the display name as the id.
   *
   * A move names its destination by id. A display name has already had its `NN-` prefix stripped and
   * its hyphens turned into spaces, so `01-in-progress` would arrive at the server as
   * "In progress" — a folder that does not exist. The id must be the segment as it is on disk.
   */
  it('the id is the folder on disk, even when the display name differs', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      dir(...BOARD.segments, '01-in-progress'),
    ], BOARD)

    expect(columns[0]?.id, 'the raw segment, for a move to name').toBe('01-in-progress')
    expect(columns[0]?.name, 'the display name, for a person to read').toBe('In progress')
    expect(columns[0]?.segments).toEqual([...BOARD.segments, '01-in-progress'])
  })

  /**
   * **An empty column is still a column.** MUTATION: only create columns when a card is seen.
   *
   * the operator creates these on the fly and fills them afterwards — *"I can name and create these
   * things on the fly."* A column that vanishes until something is put in it is a column they made
   * and the app forgot, and there would be nowhere to drop the first card.
   */
  it('a column with no cards is still shown', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      dir(...BOARD.segments, 'later'),
    ], BOARD)

    expect(columns).toHaveLength(1)
    expect(columns[0]?.id).toBe('later')
    expect(columns[0]?.cards).toEqual([])
  })

  /**
   * **NO NESTED CARDS**, which is the decision reaching disk. MUTATION: accept any depth.
   *
   * *"The column can be the main task or the main subject, and then the tasks in it can be the
   * subtasks."* A markdown file three levels down sits inside a subfolder of a column; drawing it
   * would put a card on the board whose position cannot be expressed by moving it between columns.
   */
  it('markdown deeper than a column is not a card, and its folder is not a column', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      dir(...BOARD.segments, 'doing'),
      dir(...BOARD.segments, 'doing', 'attachments'),
      md('Deep', ...BOARD.segments, 'doing', 'attachments', 'notes.md'),
      md('Shallow', ...BOARD.segments, 'doing', 'roast.md'),
    ], BOARD)

    expect(columns).toHaveLength(1)
    expect(columns[0]?.id).toBe('doing')
    expect(columns[0]?.cards.map(card => card.title)).toEqual(['Shallow'])
  })

  /** MUTATION: drop the `isMarkdown` test. §3: *"only markdown becomes a task card."* */
  it('a non-markdown file in a column is not a card', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      dir(...BOARD.segments, 'doing'),
      other(...BOARD.segments, 'doing', 'logo.png'),
      other(...BOARD.segments, 'doing', 'sheet.xlsx'),
    ], BOARD)

    expect(columns).toHaveLength(1)
    expect(columns[0]?.cards).toEqual([])
  })

  /**
   * **THE JUDGMENT CALL, and it is the operator's to overturn.** MUTATION: drop the loose branch.
   *
   * An agent will eventually write into the board's own folder rather than into a column. Without
   * this the file is invisible — the complete-but-unreachable defect this build has found four
   * times. Reuses the Tasks constants so there is one label for one concept.
   */
  it('loose markdown in the board folder goes to a leftmost Uncategorized', () => {
    const columns = boardContents([
      ...ORDINARY,
      md('Dropped in', ...BOARD.segments, 'from-an-agent.md'),
    ], BOARD)

    expect(columns[0]?.id, 'leftmost').toBe(UNCATEGORIZED_LANE_ID)
    expect(columns[0]?.name).toBe(UNCATEGORIZED_LANE_LABEL)
    expect(columns[0]?.segments, 'it is not a folder, so it has no path').toBeNull()
    expect(columns[0]?.cards.map(card => card.title)).toEqual(['Dropped in'])
    expect(columns.map(column => column.id)).toEqual([UNCATEGORIZED_LANE_ID, 'doing', 'done'])
  })

  /** MUTATION: always add it. Hidden when empty — §3's rule for the Tasks lane, unchanged. */
  it('Uncategorized is absent entirely when nothing is loose', () => {
    const columns = boardContents(ORDINARY, BOARD)
    expect(columns.some(column => column.id === UNCATEGORIZED_LANE_ID)).toBe(false)
  })

  /**
   * **A card whose column was never seen as a row still appears.** MUTATION: skip the card instead.
   *
   * An index is a bag, not an ordered walk. If a card could only be placed after its folder's own
   * row had been read, a card's visibility would depend on iteration order — the least debuggable
   * defect shape there is, and one that would come and go between restarts.
   */
  it('a card places even when its column row comes later, or never', () => {
    const columns = boardContents([
      md('Orphan', ...BOARD.segments, 'doing', 'roast.md'),
      dir(...BOARD.segments),
    ], BOARD)

    expect(columns).toHaveLength(1)
    expect(columns[0]?.id).toBe('doing')
    expect(columns[0]?.segments, 'derived from the card path').toEqual([...BOARD.segments, 'doing'])
    expect(columns[0]?.cards.map(card => card.title)).toEqual(['Orphan'])
  })

  /**
   * MUTATION: compare paths with a prefix test instead of segment by segment.
   *
   * §5 forbids it and states the bug: `/soil/notes` must not match `/soil/notes-old`. A sibling
   * board whose name merely starts the same way would pour its cards into this one.
   */
  it('a sibling board with a longer name does not leak its cards in', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      dir(...BOARD.segments, 'doing'),
      md('Mine', ...BOARD.segments, 'doing', 'roast.md'),
      md('Theirs', '02-projects', 'coffee', 'board-tuesday-drops-old', 'doing', 'other.md'),
    ], BOARD)

    expect(columns[0]?.cards.map(card => card.title)).toEqual(['Mine'])
  })

  it('another root with the same path contributes nothing', () => {
    const columns = boardContents([
      ...ORDINARY,
      { ...md('Elsewhere', ...BOARD.segments, 'doing', 'other.md'), rootId: 'r2' },
    ], BOARD)

    expect(columns[0]?.cards.map(card => card.title)).toEqual(['Roast profile'])
  })

  /**
   * MUTATION: return the columns and cards in walk order.
   *
   * The index fills in whatever order the walk took and refills on a restart. B3 replaces the card
   * order with the operator's remembered arrangement; until then it must at least be the same every
   * time, or the board they arrange by eye rearranges itself the next time they open it.
   */
  /**
   * **THE FIRST VERSION OF THIS TEST PASSED WITHOUT THE SORT**, and the mutation is the only reason
   * that is known.
   *
   * Its fixture listed the two cards in the column as `a.md` then `m.md` — already the answer. So
   * deleting the card sort entirely left it green: it was asserting that a list already in order was
   * in order. **The cards below are now stated in reverse**, so the sort has to do work to pass.
   *
   * Exactly the class of failure the whole sweep was about, committed while writing a test *for*
   * ordering. A green from a fixture that pre-arranges the answer is not evidence.
   *
   * MUTATION: return the cards and columns in walk order.
   */
  it('columns and cards are in a deterministic order, not the order the index filled', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      md('Zebra', ...BOARD.segments, 'zeta', 'z.md'),
      md('Mango', ...BOARD.segments, 'alpha', 'm.md'),
      md('Apple', ...BOARD.segments, 'alpha', 'a.md'),
    ], BOARD)

    expect(columns.map(column => column.id), 'columns sorted').toEqual(['alpha', 'zeta'])
    expect(columns[0]?.cards.map(card => card.title), 'cards sorted, not as listed')
      .toEqual(['Apple', 'Mango'])
  })

  /** A numeric prefix orders columns, exactly as it orders lanes. */
  it('a numeric prefix orders columns before the alphabet does', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      dir(...BOARD.segments, '03-done'),
      dir(...BOARD.segments, '01-doing'),
      dir(...BOARD.segments, '02-review'),
    ], BOARD)

    expect(columns.map(column => column.name)).toEqual(['Doing', 'Review', 'Done'])
  })

  it('an ignored folder is not a column, and its markdown is not a card', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      dir(...BOARD.segments, '.git'),
      md('Hidden', ...BOARD.segments, '.git', 'x.md'),
      dir(...BOARD.segments, 'node_modules'),
    ], BOARD)

    expect(columns).toEqual([])
  })

  /**
   * **`00-context` IS NOT A COLUMN**, and this is what makes their template usable.
   *
   * Their board template is a context folder and nothing else, so without this rule every board
   * scaffolded from it opens showing a column called *Context* holding their context file and their
   * m-thread — a column they did not make. **Their own scaffold skill says a board "scaffolds with NO
   * columns at all"**, so drawing one would put the viewer in contradiction with the thing that
   * creates these folders. Same call they made for the Inbox on 2026-08-21, same reasoning.
   *
   * MUTATION: drop the `isContextName` guard. Must redden on both halves — the column appears, and
   * its two files appear as cards in it.
   */
  it('the context folder is not a column, and its files are not cards', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      dir(...BOARD.segments, '00-context'),
      md('Context', ...BOARD.segments, '00-context', 'context-template.md'),
      md('M-Thread', ...BOARD.segments, '00-context', 'm-thread-template.md'),
    ], BOARD)

    expect(columns, 'a board scaffolded from the template opens empty, by design').toEqual([])
  })

  /** The grammar's one matching rule, so a differently-prefixed context folder is also furniture. */
  it('hides the context folder however it is prefixed', () => {
    const columns = boardContents([
      dir(...BOARD.segments),
      dir(...BOARD.segments, 'context'),
      dir(...BOARD.segments, '01-doing'),
    ], BOARD)

    expect(columns.map(column => column.name)).toEqual(['Doing'])
  })

  it('an empty board is an empty board, not a crash', () => {
    expect(boardContents([dir(...BOARD.segments)], BOARD)).toEqual([])
    expect(boardContents([], BOARD)).toEqual([])
  })
})
