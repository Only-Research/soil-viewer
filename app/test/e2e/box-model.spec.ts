import { expect, test, type Page } from '@playwright/test'

/**
 * **NOTHING OVERFLOWS THE BOX IT IS INSIDE.**
 *
 * the operator found this from the outside, on 2026-08-12, looking at Projects → + Plan:
 *
 * > *"the boxes are kind of off center, right? Like there's padding to the left side but there's no
 * > padding to the right side of those boxes."*
 *
 * They were describing the default CSS box model. `box-sizing: border-box` was set **nowhere in the
 * application** — no reset, nothing in either stylesheet — so `width: 100%` sized the *content* box
 * and every element carrying padding hung past its container by exactly that padding plus its
 * borders. Measured before the fix, against the modal's content box:
 *
 *     .modal-input      left 0px    right −21.2px     (0.6rem × 2 + 2px)
 *     .modal-textarea   left 0px    right −18px       (8px × 2 + 2px)
 *
 * The arithmetic landing exactly on the padding is what identified it as the box model rather than
 * a spacing mistake in either rule.
 *
 * ## Why this test exists as well as the one in `design-tokens.test.ts`
 *
 * That one greps the stylesheet for the universal rule, which catches it being **deleted**. This one
 * measures real geometry in a real engine, which catches it being **present and overridden** — a
 * later `box-sizing: content-box` on a component, or a rule with higher specificity. The text
 * assertion cannot see that at all, and the design pass the operator has scheduled is exactly when a
 * component-level override gets added by someone solving a local problem.
 *
 * ## Why the assertion is symmetry, not a number
 *
 * `expect(gapRight).toBe(20)` would pin the modal's padding, so changing `1.25rem` to `1rem` during
 * the design pass would redden a test about the box model. What is actually being asserted is that
 * **the two sides agree** — which is the thing a reader sees, is invariant under any padding value,
 * and is precisely what was false.
 */

/** Both gaps between a field's border box and its modal's content box, in CSS pixels. */
async function gaps(page: Page, selector: string): Promise<{ left: number; right: number }> {
  return page.evaluate(sel => {
    const modal = document.querySelector('.modal')
    if (modal === null) throw new Error('no modal on screen')
    const field = modal.querySelector(sel)
    if (field === null) throw new Error(`no ${sel} in the modal`)

    const style = getComputedStyle(modal)
    const outer = modal.getBoundingClientRect()
    const box = field.getBoundingClientRect()
    const contentLeft = outer.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)
    const contentRight = outer.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)

    return {
      left: Math.round((box.left - contentLeft) * 10) / 10,
      right: Math.round((contentRight - box.right) * 10) / 10,
    }
  }, selector)
}

test.describe('the box model', () => {
  test('a full-width field sits inside its modal, on both sides', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()

    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    /**
     * Polled: the board is filled by a round trip, and reading its buttons straight after the click
     * asks before `projects.list` has answered. The quick-add suite records the same race in two
     * engines — this file is not going to re-learn it.
     */
    const plan = page.locator('button:visible', { hasText: /^\+ Plan$/ }).first()
    await expect(plan).toBeVisible()
    await plan.click()
    await expect(page.locator('.modal')).toBeVisible()

    for (const field of ['.modal-input', '.modal-textarea']) {
      const gap = await gaps(page, field)
      /**
       * **Never negative.** A negative right gap is the bug itself: the field extending past the
       * modal's padding and, at −21.2px, past its border as well.
       */
      expect(gap.right, `${field} hangs past the modal's right edge`).toBeGreaterThanOrEqual(0)
      expect(gap.left, `${field} hangs past the modal's left edge`).toBeGreaterThanOrEqual(0)
      // And the two sides agree, which is what "off centre" meant. Sub-pixel tolerance only.
      expect(Math.abs(gap.left - gap.right), `${field} is not centred: ${gap.left} vs ${gap.right}`)
        .toBeLessThan(1)
    }
  })

  /**
   * The rule is universal, so it is worth one assertion that it actually applies to an ordinary
   * element rather than only to the two that were measured. A component-level `content-box` on
   * something else would pass the case above and still be the same defect somewhere new.
   */
  test('applies to elements generally, not only to the two that were found', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#app')).toBeAttached()

    const offenders = await page.evaluate(() => {
      const bad: string[] = []
      for (const node of document.querySelectorAll('*')) {
        if (getComputedStyle(node).boxSizing !== 'border-box') {
          bad.push(node.className === '' ? node.tagName : String(node.className))
        }
      }
      return [...new Set(bad)]
    })
    expect(offenders, 'these elements are still sizing on the content box').toEqual([])
  })
})
