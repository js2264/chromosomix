/**
 * The pieces bars as handles (§27.3, §27.4), in headless Chromium on the yeast
 * micro-C demo: the readout over a piece of the top bar, a sequence pressed and
 * dragged along the bar onto another's end with ⇧ held, the map rearranged
 * under the hand, the drop and the join it made — without ⇧ it would go between
 * the two, joining nothing — and a piece of the left bar turned by a double
 * click.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-bar.mjs [out-dir]     # b01 … b04
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot, text, history, mapBox, cellsOf, openStage, openWithDev } = g

await openWithDev(`?config=${g.base}/demo/yeast/Yeast_microC.metacooler.json`)
await sleep(8000)
await openStage()

/** Where a unit of the edited axis is on one of the bars, on the page. */
async function onBar(side, unit) {
  const box = await mapBox()
  const bar = await page.evaluate((s) => {
    const r = document.querySelector(`.edit-bar-${s}`).getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }, side)
  return side === 'top'
    ? { x: box.left + ((unit - box.x0) / (box.x1 - box.x0)) * box.width, y: bar.top + bar.height / 2 }
    : { x: bar.left + bar.width / 2, y: box.top + ((unit - box.y0) / (box.y1 - box.y0)) * box.height }
}

// Over IV on the top bar: the piece, and what the bar does with it.
const iv = await cellsOf('IV')
const ix = await cellsOf('IX')
const middle = await onBar('top', (iv[0] + iv[1]) / 2)
await page.mouse.move(middle.x, middle.y)
await sleep(300)
console.log('over IV on the bar:', await text('.edit-readout'))
await shot('b01-bar-hover')

// Pressed and dragged along the bar to IX's end with ⇧ held — measured, as a
// drop is, on the axis without IV — which joins the two: the map rearranged
// under the hand.
await page.mouse.down()
await page.keyboard.down('Shift')
const to = await onBar('top', ix[1] - (iv[1] - iv[0]) / 2)
for (let k = 1; k <= 16; k++) {
  await page.mouse.move(middle.x + ((to.x - middle.x) * k) / 16, middle.y)
  await sleep(40)
}
await sleep(300)
console.log('while dragging on the bar:', await text('.edit-readout'))
await shot('b02-bar-dragging')
await page.mouse.up()
await page.keyboard.up('Shift')
await sleep(1200)
console.log('after the drop:', await history())
await shot('b03-bar-dropped')

// A double click on V on the left bar turns it.
const v = await cellsOf('V')
const onV = await onBar('left', (v[0] + v[1]) / 2)
await page.mouse.dblclick(onV.x, onV.y)
await sleep(1200)
console.log('after the double click:', await history())
await page.mouse.move(onV.x, onV.y)
await sleep(300)
console.log('over V on the bar:', await text('.edit-readout'))
await shot('b04-bar-turned')
await g.close()
