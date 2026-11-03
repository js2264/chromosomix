/**
 * The pictures of Getting started → A tour of the window (`start/window.md`):
 *
 * - **window** the yeast micro-C demo as it opens, the whole window: the
 *   header, the tab, the trail with the resolution and contacts at its end, the
 *   heading over the map, the map with its tracks under it and beside it, the
 *   General panel on the left and the Aesthetics panel on the right unfolded
 *   (Annotations and Analysis folded to their strips, as on a first visit),
 *   and the status bar;
 * - **deck** the yeast deck demo — the micro-C cooler beside a Hi-C `.hic` —
 *   with the demo's model dropped on the Structures card, set three across and
 *   shown on the whole of chromosome IV from the trail: two maps and the model,
 *   chromosome IV lit in it and the rest ghosted, under the deck's bar.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/start-window.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/start-window'
const YEAST = `${BASE}/demo/yeast`

;(async () => {
  const browser = await launch()

  {
    const w = await newWindow(browser, OUT)
    const { page } = w
    await page.goto(`${BASE}/?config=${YEAST}/Yeast_microC.chromosomix.json`)
    await w.opened()
    await w.tracksRead(7)
    await w.quiet()
    await sleep(2500)
    await w.shot('window')
    await w.context.close()
  }

  {
    const w = await newWindow(browser, OUT)
    const { page } = w
    await page.goto(`${BASE}/?config=${YEAST}/Yeast_deck.chromosomix.json`)
    await w.opened()
    await w.tracksRead(2)
    await w.fold('Show the Annotations panel')
    await w.drop('.structure-card', [`${YEAST}/Yeast_structure.g3d.gz`])
    await page.waitForSelector('.deck-structure', { timeout: 60000 })
    await page
      .waitForFunction(() => {
        const note = document.querySelector('.structure-note')
        return note === null || note.classList.contains('hidden')
      }, null, { timeout: 90000 })
      .catch(() => console.log('  the model is still being read'))
    await sleep(2500)
    await w.fold('Fold the Annotations panel')
    await w.fold('Fold the General panel')
    await w.fold('Fold the Aesthetics panel')
    await page.selectOption('.deck-bar select', { label: '3 across' })
    await sleep(2000)
    // The whole of IV, from the trail: the model lights the chromosome the maps show.
    await page.locator('.crumb', { hasText: /^IV$/ }).first().click()
    await sleep(4000)
    await w.quiet()
    await sleep(2500)
    console.log('  cells:', await page.$$eval('.deck-head', (heads) => heads.map((h) => h.textContent?.replace(/\s+/g, ' ').trim().slice(0, 40))))
    // From the heading to the foot of the cells.
    const clip = await page.evaluate(() => {
      const view = document.querySelector('.deck-bar').parentElement.getBoundingClientRect()
      const bar = document.querySelector('.deck-bar').getBoundingClientRect()
      const cell = document.querySelector('.deck-structure').getBoundingClientRect()
      const lanes = [...document.querySelectorAll('.lane-canvas.lane-bottom')].map((n) => n.getBoundingClientRect().bottom)
      const top = view.top - 6
      const bottom = Math.max(cell.bottom, ...lanes) + 8
      return { x: Math.round(bar.left - 10), y: Math.round(top), width: Math.round(bar.width + 26), height: Math.round(bottom - top) }
    })
    await w.shot('deck', { clip })
    await w.shot('deck-window')
    await w.context.close()
  }

  await browser.close()
})()
