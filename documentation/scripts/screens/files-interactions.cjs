/**
 * The picture of Your files → Interactions (`files/interactions.md`):
 *
 * - **rings-and-arcs** the yeast micro-C cooler on IV:1,000,001-1,400,000 with
 *   the demo's loop calls twice, as the two displays a set of pairs has: the
 *   1,506 loops as UCSC `interact` rows, on the map as rings (*map overlay*),
 *   and the same loops in the `.tsv` the loop caller wrote, under the map as
 *   arcs (*arcs (1D track)*).
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/files-interactions.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/files-interactions'
const YEAST = `${BASE}/demo/yeast`

;(async () => {
  const browser = await launch()
  const w = await newWindow(browser, OUT)
  const { page } = w
  await page.goto(`${BASE}/#uri=${YEAST}/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&balance=true&transform=log10`)
  await w.opened()
  await w.fold('Show the Annotations panel')
  /** A row's settings, opened. */
  const settings = async (row) => {
    if ((await row.locator('select[data-display]').count()) === 0) {
      await row.locator('.ann-more').click()
      await sleep(600)
    }
    return row
  }

  // The caller's table and the same loops as interact rows, dropped on the Tracks card.
  await w.drop('.annotation-card .ann-drop', [`${YEAST}/Yeast_microC_loops.tsv`], 'Load a track')
  await sleep(1500)
  await w.drop('.annotation-card .ann-drop', [`${YEAST}/Yeast_microC_loops.interact`], 'Load a track')
  await w.tracksRead(2)
  await sleep(1000)

  // Each row found by what it says it holds, which does not move when the rows do;
  // each display set outright, though the two files open this way of themselves.
  const rows = page.locator('.annotation-card .ann-row')
  const rings = await settings(rows.filter({ hasText: '1,506 interactions' }).first())
  await rings.locator('select[data-display]').selectOption('overlay')
  const arcs = await settings(rows.filter({ hasText: '1,506 pairs' }).first())
  await arcs.locator('select[data-display]').selectOption('lane')
  // The settings follow the display a moment later; the lane is then given the height to be read.
  await sleep(3000)
  const height = arcs.locator('label:has-text("height") input').first()
  await height.fill('110')
  await height.press('Enter')
  await sleep(800)
  for (const row of await page.$$eval('.annotation-card .ann-row', (all) =>
    all.map((r) => `${r.querySelector('input.ann-name')?.value} · ${r.querySelector('select[data-display]')?.value ?? ''} · ${r.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60)}`),
  ))
    console.log('  row:', row)

  await page.mouse.click(5, 5)
  await w.fold('Fold the Annotations panel')
  await w.fold('Fold the General panel')
  await w.fold('Fold the Aesthetics panel')
  await sleep(2500)
  await w.quiet()
  await sleep(1500)
  // The map and the lane of arcs under it, its name and grip included.
  const clip = await page.evaluate(() => {
    const map = document.querySelector('.heatmap-canvas').getBoundingClientRect()
    const lane = document.querySelector('.lane-canvas.lane-bottom').getBoundingClientRect()
    const left = Math.min(map.left, lane.left) - 16
    const top = map.top - 12
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(Math.max(map.right, lane.right) + 16 - left),
      height: Math.round(lane.bottom + 4 - top),
    }
  })
  await w.shot('rings-and-arcs', { clip })
  await browser.close()
})()
