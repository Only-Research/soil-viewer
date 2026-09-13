import { expect, test } from '@playwright/test'

import { openRoot } from './tree-nav'

/**
 * **THE FONT HAS TO ACTUALLY ARRIVE.**
 *
 * the operator brought Open Sans into the repo on 2026-08-23 after comparing the editor against Typora's
 * GitHub theme, which asks for it. Matching the sizes exactly had not closed the gap they were pointing
 * at, so the typeface was the remaining variable.
 *
 * **A webfont fails silently, and that is the whole reason this file exists.** Every failure mode
 * ends the same way — the request 200s or is refused, nothing throws, the stylesheet still *says*
 * `font-family: "Open Sans"`, and the text renders in the fallback face looking exactly as it did
 * before. Asserting the computed `font-family` proves nothing at all: it reports what was **asked
 * for**, not what was **used**.
 *
 * **`font-src` is the failure this actually guards.** The policy is `default-src 'none'`, so a font
 * linked from Google is blocked outright — self-hosting is the only thing that loads, and it is what
 * makes the editor look the same on their phone and offline.
 *
 * **The content type is NOT, and that was measured.** `.ttf` was missing from the server's table and
 * the first version of this comment said `nosniff` would make the browser refuse it. Removing the
 * mapping and re-running proved otherwise: **both engines load the font served as
 * `application/octet-stream`.** The mapping was kept because it is correct, not because this test
 * would catch its absence — it would not.
 *
 * `document.fonts.load` is the question worth asking: **fetch this face and tell me it is usable.**
 */
test('the editor really renders in Open Sans, not merely asks for it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()

  const tree = await openRoot(page)
  await tree.getByText('readme', { exact: true }).first().click()
  await expect(page.locator('.cm-content')).toBeVisible()

  /**
   * **Each face is asked for explicitly, and the first version was not.**
   *
   * A browser fetches a face only when something on screen needs a glyph from it, so `fonts.ready`
   * resolves once the faces *this page happens to use* have arrived. The italic then read as
   * missing — correctly — because the document opened has no emphasis in it. That is the page's
   * content being reported, not the font's availability.
   *
   * `fonts.load` asks the real question: fetch this face and tell me whether it is usable. It is the
   * only form that proves the file is served, allowed by the policy, and parses.
   */
  const loaded = await page.evaluate(async () => {
    const faces = ['400 16px "Open Sans"', '600 16px "Open Sans"', 'italic 400 16px "Open Sans"']
    const arrived = await Promise.all(faces.map(async face => {
      const got = await document.fonts.load(face)
      return got.length > 0
    }))
    return {
      regular: arrived[0],
      semibold: arrived[1],
      italic: arrived[2],
      asked: getComputedStyle(document.querySelector('.cm-content') as Element).fontFamily,
    }
  })

  expect(loaded.regular, 'body weight must be available to draw with').toBe(true)
  expect(loaded.semibold, 'headings and bold need 600').toBe(true)
  expect(loaded.italic, 'emphasis needs the italic file, not a synthesised slant').toBe(true)
  // The ask, checked second and only after the arrival — on its own this line is the useless half.
  expect(loaded.asked).toContain('Open Sans')
})

/**
 * **And the rest of the app is NOT changed.** The tree, boards and chrome were styled against the
 * system face and the operator approved them that way; changing every surface at once would answer a
 * question nobody asked. Scoping is easy to lose in a later refactor and invisible on a machine
 * where both faces are installed, so it is pinned.
 *
 * MUTATION: point `--font-system` at Open Sans too. Must redden.
 */
test('the font is scoped to the editor and does not spread to the chrome', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()

  const chrome = await page.locator('.tabs').evaluate(node => getComputedStyle(node).fontFamily)
  expect(chrome, 'the chrome keeps the system face').not.toContain('Open Sans')
})

/**
 * **THE CODE FACE MUST ACTUALLY BE MONOSPACED, and for months it was not.**
 *
 * Found 2026-08-26 by looking at a screenshot while chasing the operator's *"the code block looks
 * shitty"*. The token read `"SF Mono", "JetBrains Mono", "Fira Code"` — **with no generic fallback**
 * — and every name in it is a miss on this machine: SF Mono is a system-restricted face that is not
 * exposed to web content under that name, and the other two are developer installs. With nothing at
 * the end of the stack the browser fell all the way through to the document's default serif.
 *
 * Measured before the fix: five `i` glyphs came to 21.9px and five `M` glyphs to 71.4px. After:
 * 48.1px and 48.1px.
 *
 * **Sixteen surfaces read that token**, so this was never only the code block. The tables that were
 * supposed to line up by character width never could — no amount of `tabular-nums` rescues a
 * proportional face — and that is most of what "the tables look wrong" was.
 *
 * **This asserts the OUTCOME, not the request.** `getComputedStyle().fontFamily` reports what was
 * asked for and would have passed happily throughout the entire period the app was rendering code
 * in a serif. The only honest question is whether two different characters occupy the same width.
 *
 * MUTATION: drop `monospace` from the end of `--font-mono`. Must redden.
 */
test('the code face is really monospaced, not merely asked to be', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#app')).toBeAttached()

  const measured = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.fontFamily = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-mono')
    probe.style.position = 'absolute'
    probe.style.whiteSpace = 'pre'
    document.body.appendChild(probe)
    probe.textContent = 'iiiiiiiiii'
    const narrow = probe.getBoundingClientRect().width
    probe.textContent = 'MMMMMMMMMM'
    const wide = probe.getBoundingClientRect().width
    probe.remove()
    return { narrow, wide }
  })

  expect(measured.narrow, 'the probe rendered something').toBeGreaterThan(0)
  expect(
    Math.abs(measured.narrow - measured.wide),
    `ten "i" measured ${measured.narrow}px and ten "M" measured ${measured.wide}px — `
    + 'a monospaced face gives the same number twice',
  ).toBeLessThan(1)
})
