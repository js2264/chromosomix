/**
 * How to zoom into a region, said in the corner while the pointer is over the
 * picture (§7.2), in headless Chromium on the yeast micro-C demo: under the key
 * on the map, in the corner when the legend is off, one line under the diagonal
 * lock, a stretch on a turned map, nothing when the pointer is elsewhere, under
 * the ruler in the 1D browser, and the dark theme. The log prints the hint's
 * words and whether it is showing after each step.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-reframe-hint.mjs [out-dir]     # rh01 … rh08
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page } = g

/** A close-up of the map's corner, or of the browser's, at the page's own pixels. */
async function corner(name, selector, width = 520, height = 260) {
  const box = await page.locator(selector).first().boundingBox()
  if (box === null) return console.log('  (nothing at', selector, ')')
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: { x: Math.max(0, box.x + box.width - width), y: Math.max(0, box.y - 10), width, height },
  })
  console.log(`wrote ${name}.png`)
}

/** The hint's lines, and whether it is drawn (its opacity). */
const hint = (selector) =>
  page.evaluate((selector) => {
    const node = document.querySelector(selector)
    if (node === null) return 'none'
    const shown = Number(getComputedStyle(node).opacity) > 0.5 && getComputedStyle(node).display !== 'none'
    return `${shown ? 'shown' : 'hidden'}: ${[...node.children].map((line) => line.textContent).join(' | ')}`
  }, selector)

async function palette(words) {
  await page.keyboard.press('Control+p')
  await sleep(400)
  await page.keyboard.type(words)
  await sleep(400)
  await page.keyboard.press('Enter')
  await sleep(900)
}

await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(8000)
const map = await page.locator('.heatmap-canvas').first().boundingBox()
const over = { x: map.x + map.width * 0.45, y: map.y + map.height * 0.55 }

// The pointer elsewhere: nothing in the corner but the key.
await page.mouse.move(20, 600)
await sleep(400)
console.log('pointer away  ', await hint('.map-hint'))
await corner('rh01-map-pointer-away', '.heatmap-canvas')

// Over the map: two lines under the key.
await page.mouse.move(over.x, over.y)
await sleep(500)
console.log('over the map  ', await hint('.map-hint'))
await g.shot('rh02-map-hovered')
await corner('rh02b-map-hovered-corner', '.heatmap-canvas')

// The legend off: the hint moves up into the corner.
await palette('legend')
await page.mouse.move(over.x + 2, over.y)
await sleep(500)
console.log('legend off    ', await hint('.map-hint'))
await corner('rh03-map-legend-off', '.heatmap-canvas')
await palette('legend')

// The diagonal lock: Option alone draws on the diagonal, so one line.
await page.keyboard.press('Space')
await page.mouse.move(over.x, over.y + 2)
await sleep(800)
console.log('locked        ', await hint('.map-hint'))
await corner('rh04-map-locked', '.heatmap-canvas')
await page.keyboard.press('Space')
await sleep(400)

// A turned map: the box is a stretch of the genome.
const turn = page.locator('button[title^="Turn this map"]').first()
await turn.click()
await sleep(4000)
const band = await page.locator('.heatmap-canvas').first().boundingBox()
await page.mouse.move(band.x + band.width * 0.5, band.y + band.height * 0.7)
await sleep(600)
console.log('turned        ', await hint('.map-hint'))
await corner('rh05-map-turned', '.heatmap-canvas')
await page.locator('button[title^="Draw this map square again"]').first().click()
await sleep(4000)

// The 1D browser: under the ruler.
await page.keyboard.press('v')
await page.waitForSelector('.browser-canvas', { timeout: 60000 })
await sleep(5000)
const tracks = await page.locator('.browser-canvas').first().boundingBox()
await page.mouse.move(20, 600)
await sleep(300)
console.log('browser, away ', await hint('.browser-hint'))
await page.mouse.move(tracks.x + tracks.width * 0.4, tracks.y + 160)
await sleep(500)
console.log('browser, over ', await hint('.browser-hint'))
await g.shot('rh06-browser-hovered')
await corner('rh06b-browser-hovered-corner', '.browser-canvas', 560, 220)
await page.keyboard.press('v')
await page.waitForSelector('.heatmap-canvas', { timeout: 60000 })
await sleep(4000)

// The dark theme: the page's own text colour, with its own halo. The focus
// let go of first: the turn's button kept it, and a key pressed at a button
// is that button's.
await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
await page.keyboard.press('t')
await sleep(800)
console.log('theme         ', await page.evaluate(() => document.documentElement.dataset.theme ?? 'system'))
const dark = await page.locator('.heatmap-canvas').first().boundingBox()
await page.mouse.move(dark.x + dark.width * 0.45, dark.y + dark.height * 0.55)
await sleep(600)
console.log('dark theme    ', await hint('.map-hint'))
// The whole window: the picture stays paper in the dark theme, so the hint keeps
// the picture's own dark ink and light halo while the columns round it go dark.
await g.shot('rh07-map-dark')
await palette('legend')
await page.mouse.move(dark.x + dark.width * 0.46, dark.y + dark.height * 0.55)
await sleep(500)
await corner('rh08-map-dark-legend-off', '.heatmap-canvas')
await palette('legend')
await g.close()
