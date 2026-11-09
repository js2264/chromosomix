/**
 * The picture of Getting started → What chromosomix is (`start/introduction.md`):
 *
 * - **yeast-microc** the yeast micro-C demo as it opens (IV:1,000,001-1,400,000
 *   at 1 kb, balanced, log10), its loop calls as rings on the map, with the
 *   sequence's GC, the genes, ATAC and its peaks under the map and the
 *   sequence, the genes, Pol II over input and its peaks beside it; the side
 *   panels folded to give the map the window, and the picture clipped to the
 *   map and its lanes (`yeast-microc-window` is the whole window).
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/start-introduction.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/start-introduction'

;(async () => {
  const browser = await launch()
  const w = await newWindow(browser, OUT)
  const { page } = w
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
  await w.opened()
  await w.tracksRead(7)
  await w.fold('Fold the General panel')
  await w.fold('Fold the Aesthetics panel')
  await sleep(2500)
  await w.quiet()
  await sleep(1500)
  // The map and the lanes round it: from the sequence's name over the map to
  // the foot of the lanes under it.
  const clip = await page.evaluate(() => {
    const map = document.querySelector('.heatmap-canvas').getBoundingClientRect()
    const below = document.querySelector('.lane-canvas.lane-bottom').getBoundingClientRect()
    const beside = document.querySelector('.lane-canvas.lane-right').getBoundingClientRect()
    const left = Math.min(map.left, below.left) - 44
    const top = map.top - 14
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(Math.max(map.right, beside.right) + 16 - left),
      height: Math.round(below.bottom + 2 - top),
    }
  })
  await w.shot('yeast-microc', { clip })
  await w.shot('yeast-microc-window')
  await browser.close()
})()
