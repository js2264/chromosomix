/**
 * The picture of Your files → 3D models (`files/structures.md`):
 *
 * - **model-beside-map** the yeast micro-C cooler on IV:1,000,001-1,400,000
 *   with the demo's model dropped on the Structures card: the card's row
 *   (beads, bead width, sequences), and the model's cell beside the map,
 *   framed on the maps' window and brought a little closer, with the pointer
 *   on a cell of the map's lower triangle 262 kb off the diagonal, which
 *   lights the beads at its two loci and joins them by a chord. The demo's
 *   model is haploid — no phased model is among the data this was made with —
 *   so each locus is lit once.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/files-structures.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/files-structures'
const YEAST = `${BASE}/demo/yeast`

;(async () => {
  const browser = await launch()
  const w = await newWindow(browser, OUT)
  const { page } = w
  await page.goto(`${BASE}/#uri=${YEAST}/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&balance=true&transform=log10`)
  await w.opened()
  await w.fold('Fold the General panel')
  await w.fold('Fold the Aesthetics panel')
  await w.fold('Show the Annotations panel')
  await w.drop('.structure-card', [`${YEAST}/Yeast_structure.g3d.gz`])
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await page
    .waitForFunction(() => {
      const note = document.querySelector('.structure-note')
      return note === null || note.classList.contains('hidden')
    }, null, { timeout: 90000 })
    .catch(() => console.log('  the model is still being read'))
  await sleep(3000)
  await w.quiet()
  console.log('  row:', (await page.locator('.structure-card').innerText()).replace(/\s+/g, ' ').slice(0, 200))
  // The model framed on what the maps show, and brought a little closer.
  await page.click('.structure-frame')
  await sleep(2500)
  const cell = await page.locator('.structure-wrap canvas').first().boundingBox()
  await page.mouse.move(cell.x + cell.width * 0.55, cell.y + cell.height * 0.55)
  for (let k = 0; k < 7; k++) {
    await page.mouse.wheel(0, -120)
    await sleep(250)
  }
  await sleep(1500)
  // A cell of the map off the diagonal — in the lower triangle, where its
  // readout does not cover the hint in the map's top corner: its two loci
  // light on the model, joined by a chord.
  const map = await page.locator('.heatmap-canvas').first().boundingBox()
  await page.mouse.move(map.x + map.width * 0.2, map.y + map.height * 0.84)
  await sleep(1500)
  console.log('  status:', await page.evaluate(() => document.querySelector('.status-readout, .statusbar, footer')?.textContent?.replace(/\s+/g, ' ').slice(0, 160)))
  console.log('  model says:', await page.evaluate(() => document.querySelector('.deck-structure')?.innerText?.replace(/\s+/g, ' ').slice(0, 200)))
  // From the Annotations panel's heading to the foot of the model's cell.
  const clip = await page.evaluate(() => {
    const panel = document.querySelector('.panel-annotations').getBoundingClientRect()
    const card = document.querySelector('.structure-card').getBoundingClientRect()
    const cell = document.querySelector('.deck-structure').getBoundingClientRect()
    const bar = document.querySelector('.deck-bar').getBoundingClientRect()
    const bottom = Math.max(card.bottom, cell.bottom) + 12
    const right = Math.max(cell.right, bar.right) + 12
    return { x: Math.round(panel.left), y: Math.round(panel.top), width: Math.round(right - panel.left), height: Math.round(bottom - panel.top) }
  })
  await w.shot('model-beside-map', { clip }, { keepPointer: true })
  await browser.close()
})()
