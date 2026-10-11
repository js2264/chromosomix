/**
 * The stage's order of things (§27.3, §27.4), in headless Chromium on the yeast
 * micro-C demo: its sidebar as the panels' cards, in their order; a piece of a
 * stitched sequence pressed, then pressed again for its whole sequence — or its
 * name on a bar; ↑ moving it in the order, joining nothing; a sequence's grip
 * dragged down the list; a piece let go between two sequences, a sequence of its
 * own there; and review mode, the suggestions first.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-order.mjs [out-dir]     # o01 … o07
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot, text, openStage, openWithDev, settled, mapBox, at, cellsOf, history } = g

await openWithDev(`?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await sleep(8000)
await openStage()
await settled()
console.log('cards:', await page.evaluate(() => [...document.querySelectorAll('.edit-side-body > *')].map((card) => card.querySelector('.edit-card-head')?.textContent ?? card.className)))
await shot('o01-sidebar')

// IV stitched: 400 kb of it turned, three pieces — its middle one pressed on
// the map, then pressed again: the whole of IV_e1.
let box = await mapBox()
const iv = await cellsOf('IV')
await g.drag(at(box, iv[0] + 400, iv[0] + 400), at(box, iv[0] + 800, iv[0] + 800))
await page.keyboard.press('i')
await sleep(600)
await page.keyboard.press('Escape')
await page.keyboard.press('0')
await sleep(500)
box = await mapBox()
const stitched = await cellsOf('IV_e1')
const middle = at(box, stitched[0] + 600, stitched[0] + 600)
await page.mouse.click(middle.x, middle.y)
await sleep(300)
console.log('pressed:', await text('.edit-card .edit-locus'))
await page.mouse.click(middle.x, middle.y)
await sleep(400)
console.log('pressed again:', await text('.edit-card .edit-locus'), '·', await text('.edit-card .edit-note'))
await shot('o02-whole-sequence')

// ↑: IV_e1 one place earlier, before III — nothing joined.
await page.keyboard.press('ArrowUp')
await sleep(600)
console.log('after ↑:', await page.evaluate(() => [...document.querySelectorAll('.edit-sequence-name')].slice(0, 5).map((node) => node.textContent)))
console.log('history:', await history())
await shot('o03-arrow-up')

// A sequence's grip, held and dragged down the list: the line where it would go.
const grip = await page.evaluate(() => {
  const node = document.querySelector('.edit-sequence-grip[data-sequence="I"]')
  node?.scrollIntoView({ block: 'center' })
  const r = node.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height }
})
await page.mouse.move(grip.x, grip.y)
await page.mouse.down()
for (let k = 1; k <= 8; k++) {
  await page.mouse.move(grip.x, grip.y + (k * grip.h * 3.6) / 8)
  await sleep(40)
}
await shot('o04-grip-held')
await page.mouse.up()
await sleep(500)
console.log('after the grip:', await page.evaluate(() => [...document.querySelectorAll('.edit-sequence-name')].slice(0, 6).map((node) => node.textContent)))

// A piece of IV_e1 held on the top bar and carried to the edge between VII
// and VIII: a sequence of its own there, and ⇧ would join it instead.
box = await mapBox()
const pieceAt = await cellsOf('IV_e1')
const vii = await cellsOf('VII')
const bar = await page.evaluate(() => {
  const r = document.querySelector('.edit-bar-top').getBoundingClientRect()
  return { top: r.top, height: r.height }
})
const barY = bar.top + bar.height - 6
const fromX = at(box, pieceAt[0] + 600, 0).x
await page.mouse.click(fromX, barY)
await sleep(200)
await page.mouse.move(fromX, barY)
await page.mouse.down()
const toX = at(box, vii[1] - 250, 0).x
for (let k = 1; k <= 14; k++) {
  await page.mouse.move(fromX + ((toX - fromX) * k) / 14, barY)
  await sleep(40)
}
console.log('carried:', await text('.edit-readout'))
await shot('o05-between')
await page.mouse.up()
await sleep(700)
console.log('history:', await history())
await shot('o06-own-sequence')

// Review: the suggestions first.
await settled()
await page.click('button:has-text("review")')
await sleep(600)
console.log('cards in review:', await page.evaluate(() => [...document.querySelectorAll('.edit-side-body > *')].map((card) => card.querySelector('.edit-card-head')?.textContent ?? card.className)))
await shot('o07-review')
await g.close()
