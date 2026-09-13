import { describe, expect, it } from 'vitest'

import { originLabel } from '../../src/client/board/board-view'

/**
 * **THE BACK CONTROL NAMES WHERE YOU CAME FROM, IN WORDS A PERSON WOULD USE.**
 *
 * The packet's rule is `‹ Urgent`, not `‹ Back` — a control you can aim at rather than one you have
 * to remember. The first build read `‹ tasks`, straight off the folder, which is the plumbing.
 *
 * The soil's grammar prefixes status folders with a number to fix their order on disk. That prefix
 * is filing, not a name.
 */
describe('the origin label', () => {
  it('drops the grammar prefix and capitalises', () => {
    expect(originLabel('01-urgent')).toBe('Urgent')
    expect(originLabel('02-next')).toBe('Next')
  })

  it('turns separators into spaces', () => {
    expect(originLabel('03-back-burner')).toBe('Back burner')
    expect(originLabel('99-inbox_main')).toBe('Inbox main')
  })

  it('leaves an unprefixed folder alone but for the capital', () => {
    expect(originLabel('tasks')).toBe('Tasks')
  })

  /**
   * **A folder whose whole name is a number keeps it.** `2024` is a real folder name, and stripping
   * it would produce an empty label — a back control with nothing on it. Falling back to the raw
   * name is the honest answer: it is what the folder is called.
   */
  it('keeps a name that is only digits, rather than emptying it', () => {
    expect(originLabel('2024')).toBe('2024')
    expect(originLabel('01-')).toBe('01-')
  })

  it('is display only — it never round-trips to an address', () => {
    // Stated as a test because the danger is not that it is wrong, it is that it gets reused. A lane
    // is an opaque id (§5); this string is not one and must never be treated as one.
    expect(originLabel('01-urgent')).not.toBe('01-urgent')
  })
})
