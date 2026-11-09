/**
 * Pictures for browse/turn.md: the yeast Micro-C demo on IV:1.0–1.4 Mb, turned
 * by 45° from the Map card's turn button, with the demo's tracks lined up under
 * it — the sequence's GC, the genes, ATAC-seq and its peaks.
 *
 *   node documentation/scripts/screens/browse-turn.cjs [out-dir]   # tn-turned
 */

const { sleep, start } = require('./browse-lib.cjs')

;(async () => {
  const app = await start(process.argv[2])
  const { page } = app
  try {
    await app.open('?config=/demo/yeast/Yeast_microC.chromosomix.json')
    await app.press('Fold the General panel')
    await app.redraw(() => page.locator('button[title^="Turn this map"]').first().click())
    await app.until(() => document.querySelector('button[title^="Draw this map square again"]') !== null)
    await page.mouse.move(8, 892)
    await sleep(800)
    await app.shot('tn-turned')
  } finally {
    await app.close()
  }
})()
