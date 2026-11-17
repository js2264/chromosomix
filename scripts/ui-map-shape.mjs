/**
 * The shape of the box a map is drawn in (§7.2), on the yeast micro-C demo with
 * its tracks under and beside the map: the square it opens as; ATAC — a track
 * drawn under the map only — grown taller by its far border, the map giving up
 * height and width alike as the square it still is; the right edge dragged out,
 * the map a rectangle that shows more genome across; the bottom edge dragged up
 * with the width held; ⇧ on an edge keeping the shape; a zoom inside the
 * rectangle; the sequence lane, on two edges, grown under a box the reader
 * shaped on both sides, which keeps its size; a double click on a side handle putting that side back to the
 * square's; *Undo every pan and zoom* putting the whole square back; a turned
 * map's band left as it was by the same button; and a deck of two maps, both
 * the same rectangle, zoomed together, and square again on `0`; a phone, which
 * draws its whole width square whatever was kept. The log prints, after each
 * step, the box's size and the window the summary names.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-map-shape.mjs [out-dir]     # ms01 … ms17
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT, { width: 1920, height: 1200 })
const { page } = g

/** The first map's box as drawn, the numbers the panel wrote for it, and the summary's window. */
const state = (label) =>
  page.evaluate((label) => {
    const wrap = document.querySelector('.heatmap-wrap')
    const grid = document.querySelector('.panel-grid')
    const r = wrap?.getBoundingClientRect()
    const vars = ['--map-width', '--map-height']
      .map((name) => [name, grid?.style.getPropertyValue(name) ?? ''])
      .filter(([, value]) => value !== '')
      .map(([name, value]) => `${name}: ${value}`)
      .join(', ')
    // The line under the heading: the smallest element whose text is all of it.
    const summary =
      [...document.querySelectorAll('body *')]
        .filter((node) => /^[\d,]+ × [\d,]+ bins ·/.test(node.textContent?.trim() ?? ''))
        .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0]
        ?.textContent?.trim() ?? ''
    return `${label.padEnd(34)} ${r === undefined ? '?' : `${Math.round(r.width)} × ${Math.round(r.height)}`}  [${vars}]\n${''.padEnd(35)}${summary}`
  }, label)

/** The centre of one of the box's handles on the first map. */
async function grip(edge, index = 0) {
  const box = await page.locator(`.plot-grip-${edge}`).nth(index).boundingBox()
  if (box === null) throw new Error(`no ${edge} handle`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** A drag in steps, with the pointer down the whole way and `shift` held if asked. */
async function drag(from, to, { shift = false, steps = 14 } = {}) {
  await page.mouse.move(from.x, from.y)
  await sleep(150)
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.down()
  for (let k = 1; k <= steps; k++) {
    await page.mouse.move(from.x + ((to.x - from.x) * k) / steps, from.y + ((to.y - from.y) * k) / steps)
    await sleep(30)
  }
  await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
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

/** A shot of the map, its lanes and the summary over them, at the page's own pixels. */
async function figure(name) {
  const grid = await page.locator('.panel-grid').first().boundingBox()
  if (grid === null) return g.shot(name)
  const top = Math.max(0, grid.y - 40)
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: { x: Math.max(0, grid.x - 30), y: top, width: Math.min(1920 - grid.x + 30, grid.width + 140), height: Math.min(1200 - top, grid.height + 60) },
  })
  console.log(`wrote ${name}.png`)
}

const fitButton = () => page.locator('button[title^="Undo every pan and zoom"]').first()

// A fresh browser context, so a fresh reader: no shape kept from an earlier run.
await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await page.waitForFunction(() => document.querySelector('.lane-canvas.lane-bottom:not(.hidden)') !== null, null, { timeout: 120000 })
await sleep(7000)
// The Aesthetics column open, so its Map card's fit button can be pressed.
for (const b of await page.$$('button[title^="Show the Aesthetics panel"]')) {
  if (await b.isVisible()) { await b.click(); await sleep(800); break }
}
await sleep(1500)

console.log(await state('opened'))
await g.shot('ms01-square-as-opened')

// ATAC is drawn under the map only. Its far border, dragged 160 pixels down.
const bottom = await borders('bottom')
console.log(`  bottom lanes' borders at y = ${bottom.map((b) => Math.round(b.y)).join(', ')}`)
const atac = bottom[2]
if (atac !== undefined) await drag(atac, { x: atac.x, y: atac.y + 160 })
await sleep(1500)
console.log(await state('ATAC 160 px taller'))
await g.shot('ms02-atac-taller')

// The right edge, out by 120 pixels: both ends move, so the box widens by 240.
const right = await grip('right')
await drag(right, { x: right.x + 120, y: right.y })
await sleep(1200)
console.log(await state('right edge out 120'))
await g.shot('ms03-right-edge-out')

// The bottom edge, up by 100: the height alone.
const under = await grip('bottom')
await drag(under, { x: under.x, y: under.y - 100 })
await sleep(1200)
console.log(await state('bottom edge up 100'))
await g.shot('ms04-bottom-edge-up')

// ⇧ on the right edge, in by 80: the box keeps its shape.
const right2 = await grip('right')
await drag(right2, { x: right2.x - 80, y: right2.y }, { shift: true })
await sleep(1200)
console.log(await state('⇧ right edge in 80'))
await g.shot('ms05-shift-keeps-shape')

// A zoom inside the rectangle: the window is wider across than down.
const map = await page.locator('.heatmap-canvas').first().boundingBox()
await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2)
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel(0, -240)
  await sleep(350)
}
await sleep(2500)
console.log(await state('zoomed in'))
await g.shot('ms06-zoomed-in-rectangle')

// The sequence lane is under the map *and* beside it, and grows on both.
const bottom2 = await borders('bottom')
const sequence = bottom2[0]
if (sequence !== undefined) await drag(sequence, { x: sequence.x, y: sequence.y + 90 })
await sleep(1500)
console.log(await state('sequence 90 px taller'))
await g.shot('ms07-sequence-taller')

// A double click on a side handle: the width back to the square's.
const right3 = await grip('right')
await page.mouse.move(right3.x, right3.y)
await page.mouse.dblclick(right3.x, right3.y)
await sleep(1500)
console.log(await state('side handle double-clicked'))
await g.shot('ms08-side-double-clicked')

// The width out again, then the button that undoes every pan and zoom.
const right4 = await grip('right')
await drag(right4, { x: right4.x + 140, y: right4.y })
await sleep(1200)
console.log(await state('right edge out 140 again'))
await g.shot('ms09-wide-again')
await fitButton().click()
await sleep(2500)
console.log(await state('Undo every pan and zoom'))
await g.shot('ms10-fit-square-again')
const title = await fitButton().getAttribute('title')
console.log(`  the button says: ${title}`)

// A turned map's band is its own box, and the button leaves it as it was.
const right5 = await grip('right')
await drag(right5, { x: right5.x + 140, y: right5.y })
await sleep(1200)
await page.locator('button[title^="Turn this map"]').first().click()
await sleep(3000)
console.log(await state('turned'))
await fitButton().click()
await sleep(2500)
console.log(await state('turned, then fit'))
await g.shot('ms11-turned-fit')
await page.locator('button[title^="Draw this map square again"]').first().click()
await sleep(3000)
console.log(await state('square again'))
await figure('ms12-square-again-keeps-width')

// A deck of two, in a second tab of this browser, which keeps the shape.
const deck = await page.context().newPage()
await deck.setViewportSize({ width: 1920, height: 1200 })
const deckSizes = async (label) => {
  const sizes = await deck.evaluate(() =>
    [...document.querySelectorAll('.deck-panel .heatmap-wrap')].map((wrap) => {
      const r = wrap.getBoundingClientRect()
      return `${Math.round(r.width)} × ${Math.round(r.height)}`
    }),
  )
  console.log(`${label.padEnd(34)} ${sizes.join(' | ')}`)
}
await deck.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_deck.chromosomix.json`)
await deck.waitForSelector('.deck-panel .heatmap-canvas', { timeout: 120000 })
await sleep(9000)
// The width kept from the single view is wider than a cell, so each map is as
// wide as its cell, and the height nobody set is the square's: a square.
await deckSizes('deck as opened')
await deck.screenshot({ path: `${OUT}/ms13-deck-as-opened.png` })
console.log('wrote ms13-deck-as-opened.png')

// The first map's bottom edge up by 180: both maps the same rectangle.
const deckGrip = await deck.locator('.deck-panel .plot-grip-bottom').first().boundingBox()
if (deckGrip !== null) {
  const from = { x: deckGrip.x + deckGrip.width / 2, y: deckGrip.y + deckGrip.height / 2 }
  await deck.mouse.move(from.x, from.y)
  await sleep(150)
  await deck.mouse.down()
  for (let k = 1; k <= 14; k++) {
    await deck.mouse.move(from.x, from.y - (180 * k) / 14)
    await sleep(30)
  }
  await deck.mouse.up()
}
await sleep(2500)
await deckSizes('deck, bottom edge up 180')
await deck.screenshot({ path: `${OUT}/ms14-deck-same-rectangle.png` })
console.log('wrote ms14-deck-same-rectangle.png')

// A zoom on the first map: the second follows into the same window.
const lead = await deck.locator('.deck-panel .heatmap-canvas').first().boundingBox()
await deck.mouse.move(lead.x + lead.width / 2, lead.y + lead.height / 2)
for (let i = 0; i < 3; i++) {
  await deck.mouse.wheel(0, -240)
  await sleep(350)
}
await deck.mouse.move(lead.x + lead.width / 2, lead.y - 120)
await sleep(3500)
await deckSizes('deck, zoomed in')
await deck.screenshot({ path: `${OUT}/ms15-deck-zoomed.png` })
console.log('wrote ms15-deck-zoomed.png')

// A phone, with the rectangle still kept: the whole width, square.
const phone = await page.context().newPage()
await phone.setViewportSize({ width: 390, height: 844 })
await phone.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await phone.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(8000)
// The Aesthetics column opens over the map on a phone: folded, and the map
// brought up to the top.
for (const b of await phone.$$('button[title^="Fold the Aesthetics panel"]')) {
  if (await b.isVisible()) { await b.click(); await sleep(800); break }
}
await phone.evaluate(() => document.querySelector('.heatmap-wrap')?.scrollIntoView({ block: 'start' }))
await sleep(1200)
const onPhone = await phone.evaluate(() => {
  const r = document.querySelector('.heatmap-wrap')?.getBoundingClientRect()
  return r === undefined ? '?' : `${Math.round(r.width)} × ${Math.round(r.height)}`
})
console.log(`${'phone, rectangle kept'.padEnd(34)} ${onPhone}`)
await phone.screenshot({ path: `${OUT}/ms16-phone-square.png` })
console.log('wrote ms16-phone-square.png')
await phone.close()

// `0` on the deck: every pan and zoom undone, and both maps square again.
await deck.bringToFront()
await deck.mouse.move(20, 600)
await deck.keyboard.press('0')
await sleep(3500)
await deckSizes('deck, 0 pressed')
await deck.screenshot({ path: `${OUT}/ms17-deck-fit-square.png` })
console.log('wrote ms17-deck-fit-square.png')

await g.close()
