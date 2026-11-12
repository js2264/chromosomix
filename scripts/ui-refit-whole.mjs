/**
 * A double click puts the whole domain back (§2, §7.2), and a second copy of
 * the first map's file follows the deck (§16.4), in headless Chromium on the
 * yeast micro-C demo with *Refine on zoom* on.
 *
 * Opens chrIV whole, zooms in at its start until the zoom reads its own bins,
 * slides along to its end, and double-clicks: the line under the title must
 * name the whole of chrIV again, at the screen's resolution, rather than the
 * ~160 kb block the zoom last read. Then Home and `0` after another zoom, and
 * the same map added to the deck while the first is zoomed in — no "not
 * following" line under it.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-refit-whole.mjs [out-dir]     # rf01 … rf06
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot } = g
const MAP = `${g.base}/demo/yeast/Yeast_microC_G2M_1kb.cool`

/** The line under the title: bins, resolution, window, span. */
const line = () =>
  page.evaluate(() => {
    const head = document.querySelector('.view-head')?.innerText.replace(/\s+/g, ' ') ?? ''
    const at = head.indexOf(' bins ·')
    return at === -1 ? head.slice(0, 160) : head.slice(Math.max(0, head.lastIndexOf(' ', at - 12)), at + 120)
  })

await page.goto(`${g.base}/#uri=${encodeURIComponent(MAP)}&view=region&region=IV`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(6000)
const canvas = page.locator('.heatmap-canvas').first()
const box = await canvas.boundingBox()
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
console.log('opened          ', await line())
await shot('rf01-chrIV-whole')

// In at the start of the chromosome, down to the file's own bins.
const start = { x: box.x + box.width * 0.1, y: box.y + box.height * 0.1 }
await page.mouse.move(start.x, start.y)
for (let k = 0; k < 10; k++) {
  await page.mouse.wheel(0, -240)
  await sleep(120)
}
await sleep(3000)
console.log('zoomed at start ', await line())

// Slide along to the end of it.
await page.keyboard.down('Meta')
for (let k = 0; k < 400; k++) {
  await page.mouse.wheel(600, 600)
  await sleep(30)
}
await page.keyboard.up('Meta')
await sleep(3000)
console.log('slid to the end ', await line())
await shot('rf02-zoomed-at-the-end')

// The double click: the whole chromosome, not the block in hand.
await page.mouse.dblclick(centre.x, centre.y)
await sleep(3000)
console.log('double click    ', await line())
await shot('rf03-double-click-whole-chrIV')

// Zoom again, then `0` from anywhere.
await page.mouse.move(centre.x, centre.y)
for (let k = 0; k < 10; k++) {
  await page.mouse.wheel(0, -240)
  await sleep(120)
}
await sleep(3000)
console.log('zoomed again    ', await line())
await page.mouse.move(box.x - 40, box.y + 10)
await page.keyboard.press('0')
await sleep(3000)
console.log('0               ', await line())
await shot('rf04-zero-whole-chrIV')

// A deck of the same map twice, added while the first is zoomed in.
await page.mouse.move(centre.x, centre.y)
for (let k = 0; k < 10; k++) {
  await page.mouse.wheel(0, -240)
  await sleep(120)
}
await sleep(3000)
console.log('zoomed for deck ', await line())
await page.evaluate((map) => {
  const hash = new URLSearchParams(location.hash.slice(1))
  hash.set('maps', map)
  location.hash = `#${hash.toString()}`
}, MAP)
await sleep(9000)
const notes = await page.evaluate(() =>
  [...document.querySelectorAll('.deck-note.deck-unlocked')].map((n) => n.textContent ?? '').filter((t) => t !== ''),
)
console.log('deck notes      ', notes.length === 0 ? '(none)' : notes)
await shot('rf05-deck-same-map-following')

// Double click in the deck: every map back to the whole chromosome.
const first = await page.locator('.heatmap-canvas').first().boundingBox()
await page.mouse.dblclick(first.x + first.width / 2, first.y + first.height / 2)
await sleep(4000)
console.log('deck dblclick   ', await line())
await shot('rf06-deck-double-click-whole')

console.log(g.errors?.length ? g.errors : 'no page errors')
await g.close?.()
process.exit(0)
