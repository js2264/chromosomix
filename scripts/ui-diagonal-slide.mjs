/**
 * A sideways scroll over the session's map (§7.2), in headless Chromium on the
 * yeast micro-C demo: zoomed onto the diagonal, then two fingers' worth of
 * sideways wheel — the map slides along its diagonal, rows and columns
 * together, the diagonal staying where it is on the screen.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-diagonal-slide.mjs [out-dir]     # w01 … w02
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot, text } = g

await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.metacooler.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(8000)
const box = await page.locator('.heatmap-canvas').first().boundingBox()
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
await page.mouse.move(centre.x, centre.y)
for (let k = 0; k < 4; k++) {
  await page.mouse.wheel(0, -240)
  await sleep(120)
}
await sleep(2500)
console.log('before:', (await text('.crumb-region, .region-input, .crumb'))?.trim())
await shot('w01-before')
for (let k = 0; k < 12; k++) {
  await page.mouse.wheel(60, 0)
  await sleep(40)
}
await sleep(2500)
console.log('after:', (await text('.crumb-region, .region-input, .crumb'))?.trim())
await shot('w02-slid')
await g.close()
