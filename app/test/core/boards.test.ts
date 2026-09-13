import { describe, expect, it } from 'vitest'
import { boardsIn, type BoardSource } from '../../src/core/boards'

/**
 * **DISCOVERY — every board, and nothing that is not one.** P14 B1.
 *
 * Pure over index rows, so every rule is provable without a fixture tree. The paths are shapes from
 * the real soil, following `grammar.test.ts`'s convention of testing against trees that exist.
 */

const dir = (rootId: string, ...segments: string[]): BoardSource =>
  ({ rootId, segments, kind: 'directory' })
const file = (rootId: string, ...segments: string[]): BoardSource =>
  ({ rootId, segments, kind: 'file' })
const link = (rootId: string, ...segments: string[]): BoardSource =>
  ({ rootId, segments, kind: 'symlink' })

describe('boardsIn', () => {
  it('finds a board wherever it sits, and names it as the operator typed it', () => {
    const boards = boardsIn([
      dir('r1', '02-projects', 'coffee', 'board-tuesday-drops'),
    ])

    expect(boards).toHaveLength(1)
    expect(boards[0]?.name).toBe('Tuesday drops')
    expect(boards[0]?.segments).toEqual(['02-projects', 'coffee', 'board-tuesday-drops'])
    expect(boards[0]?.where, 'so two boards of the same name can be told apart')
      .toBe('02-projects/coffee')
  })

  /**
   * MUTATION: drop the `kind !== 'directory'` guard.
   *
   * A markdown file called `board-notes.md` is not a board. It would otherwise appear as one and
   * open into a board with no columns — an entry that cannot do what the list promises, which is the
   * failure `search.quickOpen` already refuses folders for.
   */
  it('a FILE named like a board is not a board', () => {
    expect(boardsIn([file('r1', 'board-notes.md')])).toHaveLength(0)
    expect(boardsIn([file('r1', 'board-notes')])).toHaveLength(0)
  })

  /**
   * **A SYMLINK named like a board is not a board, and the compiler is what raised this.**
   *
   * The first draft typed `kind` as `'file' | 'directory'` and `tsc` refused it — the index holds a
   * third kind. It was a type error carrying a real question: a symlink is the thing that looks
   * like a directory and is not, which is why §4 refuses them at every level of the walk. Listing
   * one as a board would put a door on the screen leading outside every containment rule the app
   * has.
   *
   * The `kind === 'directory'` test already excluded it. This says so on purpose rather than by
   * accident, and would redden if the check ever became `kind !== 'file'`.
   */
  it('a SYMLINK named like a board is not a board', () => {
    expect(boardsIn([link('r1', 'board-elsewhere')])).toHaveLength(0)
    expect(boardsIn([link('r1', '02-projects', 'x', 'board-elsewhere')])).toHaveLength(0)
  })

  /**
   * MUTATION: drop the `isArchived` check.
   *
   * §3: *"a match at ANY ancestor level"*. Archiving a board is how it retires — the only sanctioned
   * retire path, since nothing deletes — so a board that keeps appearing after being archived means
   * there is no way to get it off the list at all.
   */
  it('an archived board does not appear, at any ancestor depth', () => {
    expect(boardsIn([dir('r1', 'archive', 'board-old-launch')])).toHaveLength(0)
    expect(boardsIn([dir('r1', '02-projects', 'x', 'archive', 'board-old')])).toHaveLength(0)
    expect(boardsIn([dir('r1', '02-projects', 'x', '_archive', 'board-old')])).toHaveLength(0)
    expect(boardsIn([dir('r1', '02-projects', 'x', 'board-live')]), 'and a live one still does')
      .toHaveLength(1)
  })

  /** MUTATION: drop the `isIgnoredPath` check. Covers dot-dirs and `node_modules`, which archive does not. */
  it('an ignored path does not appear, which archive alone would not cover', () => {
    expect(boardsIn([dir('r1', '.git', 'board-x')])).toHaveLength(0)
    expect(boardsIn([dir('r1', 'node_modules', 'board-x')])).toHaveLength(0)
  })

  /**
   * MUTATION: drop the ancestor check.
   *
   * **Boards do not nest.** A `board-` folder inside a board is a column that happens to be named
   * that way. Without this, opening the outer board would show a column that is also listed as a
   * top-level board, and moving a card in one would silently be moving it in the other.
   */
  it('a board inside a board is a column, not a second board', () => {
    const boards = boardsIn([
      dir('r1', 'board-outer'),
      dir('r1', 'board-outer', 'board-inner'),
      dir('r1', 'board-outer', 'board-inner', 'board-deeper'),
    ])

    expect(boards).toHaveLength(1)
    expect(boards[0]?.segments).toEqual(['board-outer'])
  })

  it('ignores everything that is not a board', () => {
    const boards = boardsIn([
      dir('r1', '02-projects'),
      dir('r1', '02-projects', 'coffee'),
      dir('r1', '02-projects', 'coffee', '02-work', 'tasks'),
      dir('r1', '01-inbox'),
      dir('r1', 'boardroom'),
      file('r1', '02-projects', 'coffee', 'notes.md'),
    ])

    expect(boards).toEqual([])
  })

  /**
   * MUTATION: return `found` unsorted, in walk order.
   *
   * The index fills in whatever order the walk happened to take, and it refills on a restart. A
   * board list that reshuffles itself between visits is one that has to be re-read every time, which
   * is the specific complaint the operator made about the Inbox on 2026-08-18.
   */
  it('is ordered by name, not by the order the index happened to fill', () => {
    const boards = boardsIn([
      dir('r1', 'board-zebra'),
      dir('r1', 'board-apple'),
      dir('r2', 'board-mango'),
    ])

    expect(boards.map(board => board.name)).toEqual(['Apple', 'Mango', 'Zebra'])
  })

  /** Two boards of the same name are told apart by where they live, and the order is still stable. */
  it('two boards with the same name are ordered by where they live', () => {
    const boards = boardsIn([
      dir('r1', 'zed-project', 'board-notes'),
      dir('r1', 'alpha-project', 'board-notes'),
    ])

    expect(boards.map(board => board.where)).toEqual(['alpha-project', 'zed-project'])
  })

  it('a board at the root of a registered folder has no where, and does not crash', () => {
    const boards = boardsIn([dir('r1', 'board-loose')])
    expect(boards).toHaveLength(1)
    expect(boards[0]?.where).toBe('')
  })

  /**
   * **A REGISTERED TEMPLATE IS NOT A BOARD.**
   *
   * the operator's board template is a folder called `board-template`, which answers the grammar's
   * question perfectly — so without this it appears in the list as a board called *Template*, among
   * the real ones, offering to be opened and filled in. A template is a shape, not a thing.
   */
  describe('the template exclusion', () => {
    const TEMPLATE = ['00-context', 'templates', 'work-templates', 'board-template']
    const registered = (rootId: string, segments: readonly string[], caseInsensitive = false) =>
      [{ rootId, segments: [...segments], caseInsensitive }]

    it('leaves a registered template out of the list', () => {
      const boards = boardsIn(
        [dir('r1', ...TEMPLATE), dir('r1', 'board-real')],
        registered('r1', TEMPLATE),
      )
      expect(boards.map(board => board.name)).toEqual(['Real'])
    })

    /**
     * MUTATION: exclude by the folder's NAME rather than its path — every board called
     * `board-template` anywhere would vanish, including one they made on purpose. Must redden.
     */
    it('excludes that folder, not every folder sharing its name', () => {
      const boards = boardsIn(
        [dir('r1', ...TEMPLATE), dir('r1', 'clients', 'board-template')],
        registered('r1', TEMPLATE),
      )
      expect(boards.map(board => board.where), 'the one they made themselves is still their')
        .toEqual(['clients'])
    })

    /**
     * MUTATION: compare the paths with `===` instead of `comparisonKey`. Must redden — the same
     * folder spelled two ways is one folder, and on their Mac the spellings are interchangeable.
     */
    it('matches through the comparison key on a case-insensitive volume', () => {
      const boards = boardsIn(
        [dir('r1', 'canon', 'Board-Template')],
        registered('r1', ['canon', 'board-template'], true),
      )
      expect(boards).toEqual([])
    })

    it('a case-sensitive volume tells the two spellings apart', () => {
      const boards = boardsIn(
        [dir('r1', 'canon', 'Board-Template')],
        registered('r1', ['canon', 'board-template'], false),
      )
      expect(boards, 'here they really are two different folders').toHaveLength(1)
    })

    /**
     * MUTATION: drop the `rootId` check. Must redden — two registered folders can hold the same
     * relative path, and a template in one would silently hide a real board in the other.
     */
    it('a template in another registered folder hides nothing here', () => {
      const boards = boardsIn(
        [dir('r2', ...TEMPLATE)],
        registered('r1', TEMPLATE),
      )
      expect(boards).toHaveLength(1)
    })

    it('lists everything when nothing is registered, which is the state it shipped in', () => {
      expect(boardsIn([dir('r1', ...TEMPLATE)])).toHaveLength(1)
    })
  })
})
