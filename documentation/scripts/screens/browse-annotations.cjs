/**
 * Pictures for browse/annotations.md: the yeast Micro-C demo with the
 * Annotations panel open beside the map and four marks typed into the Manual
 * annotations card — a vertical line, a horizontal line, an arrowhead on one
 * of the demo's loops off the diagonal and a rectangle on a domain on it — each
 * drawn on the map and listed on the card.
 *
 *   node documentation/scripts/screens/browse-annotations.cjs [out-dir]   # an-marks
 */

const { sleep, start } = require('./browse-lib.cjs')

;(async () => {
  const app = await start(process.argv[2])
  const { page } = app
  try {
    await app.open('?config=/demo/yeast/Yeast_microC.chromosomix.json')
    await app.press('Fold the General panel')
    await app.press('Show the Annotations panel')
    await app.press('Fold the Aesthetics panel')
    await app.rendered(0)

    const manual = page
      .locator('.annotation-card')
      .filter({ has: page.locator('.card-head', { hasText: /Manual annotations/i }) })
      .first()
    const form = (title) =>
      manual.locator('.manual-form').filter({ has: page.locator('.manual-form-title', { hasText: new RegExp(`^${title}$`) }) }).first()
    await form('Lines').locator('input.input').first().fill('IV:1,200,000')
    await form('Lines').locator('button', { hasText: /^add$/ }).click()
    await form('Lines').locator('select').selectOption('horizontal')
    await form('Lines').locator('input.input').first().fill('IV:1,330,000')
    await form('Lines').locator('button', { hasText: /^add$/ }).click()
    await form('Arrowheads').locator('input.input').nth(0).fill('IV:1,128,500')
    await form('Arrowheads').locator('input.input').nth(1).fill('IV:1,241,500')
    await form('Arrowheads').locator('button', { hasText: /^add$/ }).click()
    await form('Rectangles').locator('input.input').first().fill('IV:1,040,000-1,110,000')
    await form('Rectangles').locator('button', { hasText: /^add$/ }).click()
    await sleep(1500)
    // The card from its heading down to its list of marks.
    await manual.evaluate((card) => card.scrollIntoView({ block: 'start' }))
    await sleep(400)
    console.log(
      'marks:',
      await page.evaluate(() => [...document.querySelectorAll('.manual-mark .manual-where')].map((n) => n.textContent)),
    )
    // The pointer off the picture, so that no guide line or hover card sits over the marks.
    await page.mouse.move(8, 892)
    await sleep(800)
    await app.shot('an-marks')
  } finally {
    await app.close()
  }
})()
