/**
 * Pictures for browse/genome-browser.md: the yeast tracks demo, the 1D browser
 * on chromosome IV with the sequence, the genes, MNase, ATAC-seq, Pol II and
 * RNA-seq tracks, as it opens and with the side panels folded.
 *
 *   node documentation/scripts/screens/browse-genome-browser.cjs [out-dir]   # gb-open, gb-wide
 */

const { start } = require('./browse-lib.cjs')

;(async () => {
  const app = await start(process.argv[2])
  const { page } = app
  try {
    await app.open('?config=/demo/yeast/Yeast_tracks.chromosomix.json')
    await page.mouse.move(5, 450)
    await app.shot('gb-open')
    await app.press('Fold the General panel')
    await app.press('Fold the Aesthetics panel')
    await app.rendered(0)
    await app.shot('gb-wide')
  } finally {
    await app.close()
  }
})()
