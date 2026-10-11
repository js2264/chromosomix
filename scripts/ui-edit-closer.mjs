/**
 * The stage closer than its picture's cell (§27.9), in headless Chromium on
 * the long-read yeast assembly: the picture set to 2,048 cells a side on its
 * card — the 10 kb rung — a contig framed, its cells enlarged, and then the
 * window on screen read again from a finer rung through the edit.
 *
 * Reads `data/` (see `data/README.md`) through a session config under `out/`:
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-closer.mjs [out-dir]     # c01 … c03
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const CONFIG = process.env.REASSEMBLY_CONFIG ?? '/out/reasm/Reassembly.chromosomix.json'
const g = await gallery(OUT)
const { page, shot, text, openStage, openWithDev } = g

await openWithDev(`?config=${g.base}${CONFIG}`)
await sleep(9000)
await openStage()

// A coarser picture, chosen on its card: read again from the rung that fits.
await page.selectOption('.edit-cells-select', '2048')
for (let i = 0; i < 240; i++) {
  await sleep(250)
  if (await page.evaluate(() => document.querySelector('.edit-status')?.classList.contains('hidden'))) break
}
await sleep(600)
console.log('picture:', await text('.edit-picture-card .edit-note'))
await page.evaluate(() => document.querySelector('.edit-cells')?.scrollIntoView({ block: 'center' }))
await shot('c01-coarser')

// contig_34 framed from the list: its 10 kb cells enlarged, at once…
await page.evaluate(() => {
  for (const button of document.querySelectorAll('.edit-sequence')) {
    if (button.querySelector('.edit-sequence-name')?.textContent === 'contig_34') button.click()
  }
})
await sleep(60)
await page.keyboard.press('Escape')
await shot('c02-enlarged')
// …and then read again, finer, for the window on screen.
for (let i = 0; i < 60; i++) {
  await sleep(250)
  if (await page.evaluate(() => document.querySelector('.edit-window-note') !== null)) break
}
await sleep(500)
console.log('closer:', await text('.edit-window-note'))
await shot('c03-closer')
await page.selectOption('.edit-cells-select', '16384')
await sleep(300)
await g.close()
