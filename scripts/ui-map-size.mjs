/**
 * The size of a square map (§7.2), on the yeast micro-C demo with its tracks
 * under and beside the map: the square it opens as; ATAC — a track drawn under
 * the map only — grown taller by its far border, the square giving up both of
 * its sides; the bottom edge dragged up and the right edge dragged out, making
 * the map smaller and then bigger and leaving it square each time; and *Undo
 * every pan and zoom*, which puts back the size the map opens at. The log prints, after
 * each step, the box as drawn and the side the panel wrote for it.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-map-size.mjs [out-dir]     # sz01 … sz05
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT, { width: 1920, height: 1200 })
const { page } = g

/** The first map's box as drawn, and the side the panel wrote for it. */
const state = (label) =>
  page.evaluate((label) => {
    const wrap = document.querySelector('.heatmap-wrap')
    const grid = document.querySelector('.panel-grid')
    const r = wrap?.getBoundingClientRect()
    const side = grid?.style.getPropertyValue('--map-size') ?? ''
    const box = r === undefined ? '?' : `${Math.round(r.width)} × ${Math.round(r.height)}`
    return `${label.padEnd(30)} ${box}  [--map-size: ${side || 'unset'}]`
  }, label)

/** The centre of one of the box's handles on the first map. */
async function grip(edge) {
  const box = await page.locator(`.plot-grip-${edge}`).first().boundingBox()
  if (box === null) throw new Error(`no ${edge} handle`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** A drag in steps, with the pointer down the whole way. */
async function drag(from, to, steps = 14) {
  await page.mouse.move(from.x, from.y)
  await sleep(150)
  await page.mouse.down()
  for (let k = 1; k <= steps; k++) {
    await page.mouse.move(from.x + ((to.x - from.x) * k) / steps, from.y + ((to.y - from.y) * k) / steps)
    await sleep(30)
  }
  await page.mouse.up()
  await sleep(900)
}

/**
 * The far borders of the lanes on one edge, top to bottom, found the way a hand
 * finds them: by moving down the stack until the pointer becomes the resize
 * arrow the canvas puts up over a border.
 */
async function borders(edge) {
  const canvas = page.locator(`.lane-canvas.lane-${edge}:not(.hidden)`).first()
  const box = await canvas.boundingBox()
  if (box === null) return []
  const found = []
  const x = box.x + box.width * 0.6
  for (let y = Math.ceil(box.y); y < box.y + box.height; y += 1) {
    await page.mouse.move(x, y)
    const on = await canvas.evaluate((node) => node.classList.contains('is-resize-across'))
    if (on && (found.length === 0 || y - found[found.length - 1].y > 12)) found.push({ x, y })
  }
  return found
}

const fitButton = () => page.locator('button[title^="Undo every pan and zoom"]').first()

// A fresh browser context, so a fresh reader: no size kept from an earlier run.
await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await page.waitForFunction(() => document.querySelector('.lane-canvas.lane-bottom:not(.hidden)') !== null, null, { timeout: 120000 })
await sleep(7000)
// The Aesthetics column open, so its Map card's fit button can be pressed.
for (const b of await page.$$('button[title^="Show the Aesthetics panel"]')) {
  if (await b.isVisible()) {
    await b.click()
    await sleep(800)
    break
  }
}
await sleep(1500)

console.log(await state('opened'))
await g.shot('sz01-square-as-opened')

// ATAC is drawn under the map only. Its far border, dragged 160 pixels down.
const bottom = await borders('bottom')
console.log(`  bottom lanes' borders at y = ${bottom.map((b) => Math.round(b.y)).join(', ')}`)
const atac = bottom[2]
if (atac !== undefined) await drag(atac, { x: atac.x, y: atac.y + 160 })
await sleep(1500)
console.log(await state('ATAC 160 px taller'))
await g.shot('sz02-atac-taller-square-smaller')

// The bottom edge, up by 120: the square is smaller, and still a square.
const under = await grip('bottom')
await drag(under, { x: under.x, y: under.y - 120 })
await sleep(1200)
console.log(await state('bottom edge up 120'))
await g.shot('sz03-bottom-edge-up-smaller')

// The right edge, out by 40 pixels: both ends move, so the square grows by 80 —
// back towards the room there is, which is as large as it can be.
const right = await grip('right')
await drag(right, { x: right.x + 40, y: right.y })
await sleep(1200)
console.log(await state('right edge out 40'))
await g.shot('sz04-right-edge-out-bigger')

// The button that undoes every pan and zoom: the size the map opens at.
await fitButton().click()
await sleep(2500)
console.log(await state('Undo every pan and zoom'))
await g.shot('sz05-fit-default-size')
console.log(`  the button says: ${await fitButton().getAttribute('title')}`)

await g.close()
