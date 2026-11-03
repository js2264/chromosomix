/**
 * Pictures for browse/navigating.md: the yeast Micro-C demo on a window of
 * chromosome IV with the pointer over the map — the hint under the key saying
 * what a drag will do, read as a Mac reads it (⌥) — and the locus box with the
 * genes it found for a name typed into it.
 *
 *   node documentation/scripts/screens/browse-navigating.cjs [out-dir]   # nav-hint, nav-genes
 */

const { sleep, start } = require('./browse-lib.cjs')

;(async () => {
  const app = await start(process.argv[2], { mac: true })
  const { page } = app
  try {
    await app.open('?config=/demo/yeast/Yeast_microC.chromosomix.json')
    await app.press('Fold the General panel')
    await app.rendered(0)
    const map = await page.locator('.heatmap-canvas').first().boundingBox()
    // A cell with a value under the pointer, not one of the rows balancing left out.
    for (const [fx, fy] of [[0.7, 0.42], [0.66, 0.38], [0.74, 0.47], [0.6, 0.33], [0.78, 0.52]]) {
      await page.mouse.move(map.x + map.width * fx, map.y + map.height * fy)
      await sleep(500)
      const reading = await page.evaluate(() => document.querySelector('.status-coords')?.textContent ?? '')
      console.log('reading:', reading)
      if (!/NaN/.test(reading)) break
    }
    await sleep(600)
    console.log('hint:', await page.evaluate(() => [...(document.querySelector('.map-hint')?.children ?? [])].map((n) => n.textContent)))
    await app.shot('nav-hint')

    // The locus box: a gene's name typed, its matches listed under it.
    await page.mouse.move(5, 450)
    await page.click('input.input-region')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('RAD5', { delay: 80 })
    await page.waitForSelector('.search-hits:not(.hidden) .search-hit', { timeout: 30000 })
    await sleep(800)
    console.log('hits:', await page.evaluate(() => [...document.querySelectorAll('.search-hits .search-hit')].map((n) => n.textContent)))
    await app.shot('nav-genes')
  } finally {
    await app.close()
  }
})()
