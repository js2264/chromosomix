/**
 * A suggestion placed finer than the stage's picture (§27.5), in headless
 * Chromium on the demo scrambled where no picture cell has an edge (see
 * `data/README.md`): the picture set to 2,048 cells a side, the suggestions
 * counted on it and then placed again at the 1 kb rung — the list saying
 * *refined at 1 kb* — then taken in auto mode, the history keeping the steps
 * as placed.
 *
 *   npx vite-node scripts/make-scrambled-demo.ts
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-refine.mjs [out-dir]     # f01 … f03
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot, text, openStage, openWithDev, settled, suggestions } = g

await openWithDev(`?config=${g.base}/out/scrambled/Scrambled.metacooler.json`)
await sleep(6000)
await openStage()

await page.selectOption('.edit-cells-select', '2048')
for (let i = 0; i < 240; i++) {
  await sleep(250)
  if (await page.evaluate(() => document.querySelector('.edit-status')?.classList.contains('hidden'))) break
}
await sleep(600)
await settled()
console.log('picture:', await text('.edit-picture-card .edit-note'))
console.log('placed:', await suggestions())
console.log('chips:', await page.evaluate(() => [...document.querySelectorAll('.edit-suggestion')].map((row) => [...row.querySelectorAll('.edit-chip')].map((chip) => chip.textContent).join(' · '))))
await page.evaluate(() => document.querySelector('.edit-suggestions-card')?.scrollIntoView({ block: 'start' }))
await shot('f01-placed')

// Review: the first one framed, its ends where the 1 kb rung put them.
await page.click('.edit-mode-button:has-text("review")').catch(() => page.click('button:has-text("review")'))
await sleep(800)
console.log('review:', await text('.edit-review-words'))
await shot('f02-review')

// Auto: each taken as placed.
await page.click('button:has-text("auto")')
await sleep(300)
await page.click('.edit-suggestions-card .edit-acts button')
for (let i = 0; i < 120; i++) {
  await sleep(250)
  const busy = await page.evaluate(() => /weighing|placing/.test(document.querySelector('.edit-suggestions-card .edit-card-head')?.textContent ?? ''))
  if (!busy) break
}
await settled()
console.log('history:', await g.history())
await page.evaluate(() => document.querySelector('.edit-history')?.scrollIntoView({ block: 'center' }))
await shot('f03-auto')
await page.selectOption('.edit-cells-select', '16384')
await sleep(300)
await g.close()
