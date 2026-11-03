/**
 * Pictures for browse/contact-maps.md, from links to the yeast Micro-C demo on
 * the lab's bucket: the balanced map of chromosome IV with the Map card open
 * beside it in the Aesthetics panel; then the window IV:1.0–1.4 Mb, balanced,
 * with the pointer on a cell off the diagonal and the card that reads it.
 *
 * Not under O/E: there the card prints the drawn ratio as the balanced value
 * ("balanced 1.95" for an O/E of 1.95×, src/ui/MapReadout.ts), so a picture of
 * it would show the readout saying something false.
 *
 *   node documentation/scripts/screens/browse-contact-maps.cjs [out-dir]   # cm-card, cm-hover
 */

const { BUCKET, sleep, start } = require('./browse-lib.cjs')

const MAP = `${BUCKET}/yeast/Yeast_microC_G2M_1kb.cool`

;(async () => {
  const app = await start(process.argv[2])
  const { page } = app
  try {
    await app.open(`#uri=${MAP}&view=region&region=IV&balance=true&transform=log10`)
    await app.press('Fold the General panel')
    await app.rendered(0)
    await page.mouse.move(8, 892)
    await sleep(600)
    await app.shot('cm-card')

    // A cell off the diagonal pointed at: the demo's loop between 1,128 kb and 1,241 kb.
    await app.open(`#uri=${MAP}&view=region&region=IV:1000000-1400000&balance=true&transform=log10`)
    const box = await page.locator('.heatmap-canvas').first().boundingBox()
    const at = (bp) => (bp - 1_000_000) / 400_000
    await page.mouse.move(box.x + box.width * at(1_241_500), box.y + box.height * at(1_128_500))
    await sleep(900)
    console.log('reading:', await page.evaluate(() => document.querySelector('.status-coords')?.textContent))
    await app.shot('cm-hover')
  } finally {
    await app.close()
  }
})()
