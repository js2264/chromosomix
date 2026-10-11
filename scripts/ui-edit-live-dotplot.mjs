/**
 * The stage's corner dot plot (§27.3), in headless Chromium on the chrXVI–
 * mycoides reassembly with its theoretical genome loaded beside it (see
 * `data/README.md`): the assembly as it is against the theory, in the map's
 * corner; a streak hovered, named in the readout; and then auto mode run — the
 * corner plot redrawn through every step, the fused chromosome's contigs
 * coming into line.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-live-dotplot.mjs [out-dir]     # l01 … l03
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot, text, openStage, openWithDev, settled } = g

await openWithDev(`?config=${g.base}/out/reasm/Dotplot.chromosomix.json`)
await sleep(15000)
await openStage()
await settled()
for (let i = 0; i < 120; i++) {
  await sleep(500)
  if (/streaks? · the edit/.test((await text('.edit-dotplot-caption')) ?? '')) break
}
console.log('corner:', await text('.edit-dotplot-caption'))
await shot('l01-corner')

// A streak under the pointer, named in the readout.
const box = await page.locator('.edit-dotplot-canvas').boundingBox()
let said = ''
for (let t = 0.05; t <= 0.95 && !/anchors/.test(said); t += 0.01) {
  await page.mouse.move(box.x + t * box.width, box.y + t * box.height)
  said = (await text('.edit-readout')) ?? ''
}
console.log('hovered:', said)
await shot('l02-hovered')

// Auto mode: every step redraws the corner.
await page.click('button:has-text("auto")')
await sleep(400)
await page.click('.edit-suggestions-card .edit-acts button')
for (let i = 0; i < 240; i++) {
  await sleep(500)
  const busy = await page.evaluate(() => /weighing|placing/.test(document.querySelector('.edit-suggestions-card .edit-card-head')?.textContent ?? ''))
  if (!busy) break
}
await settled()
await page.mouse.move(10, 10)
await sleep(600)
console.log('after auto:', await text('.edit-dotplot-caption'), '·', (await g.history()).length - 1, 'steps')
await shot('l03-after-auto')
await g.close()
