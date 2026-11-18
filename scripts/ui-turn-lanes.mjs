/**
 * Which way the tracks grow under a turned map (§17.4), on the yeast micro-C
 * demo: ATAC moved from under the map to its left by its own menu — a lane
 * arriving beside the map turns to grow away from it there, as a computed track
 * does — and the map square; turned 45°, every track below the band growing up
 * towards it, ATAC with them; and square again, ATAC back on the left growing
 * the way it did.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-turn-lanes.mjs [out-dir]     # tl01 … tl03
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT, { width: 1920, height: 1200 })
const { page } = g

/** The map, its tracks and the stacks round it. */
async function figure(name) {
  const grid = await page.locator('.panel-grid').first().boundingBox()
  await page.mouse.move(10, 600)
  await sleep(300)
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x: Math.max(0, grid.x - 20),
      y: Math.max(0, grid.y - 20),
      width: Math.min(1920 - grid.x + 20, grid.width + 40),
      height: Math.min(1200 - grid.y + 20, grid.height + 40),
    },
  })
  console.log(`wrote ${name}.png`)
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

await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await page.waitForFunction(() => document.querySelector('.lane-canvas.lane-bottom:not(.hidden)') !== null, null, { timeout: 120000 })
await sleep(8000)

// ATAC is the third lane under the map: its menu's *left of the map*.
const under = await borders('bottom')
if (under.length < 3) throw new Error(`expected ATAC third under the map, found ${under.length} lanes`)
await page.mouse.click(under[1].x, (under[1].y + under[2].y) / 2, { button: 'right' })
await sleep(500)
await page.getByRole('menuitem', { name: /left of the map/ }).first().click()
await sleep(2500)
await figure('tl01-atac-left-square')

await page.locator('button[title^="Turn this map"]').first().click()
await sleep(5000)
await figure('tl02-turned-every-track-towards-the-band')
// The lane menu on a track under the band: its flip greyed, and why.
const below = await page.locator('.lane-canvas.lane-bottom:not(.hidden)').first().boundingBox()
const lanes = await borders('bottom')
await page.mouse.click(below.x + below.width * 0.5, (lanes[1].y + lanes[2].y) / 2, { button: 'right' })
await sleep(500)
const flip = page.getByRole('menuitem', { name: /Grow away from the map/ }).first()
console.log(
  `  the menu's flip under the band: ${(await flip.textContent())?.trim()} · disabled ${await flip.isDisabled()}`,
)
await page.keyboard.press('Escape')
await sleep(300)

await page.locator('button[title*="square" i]').first().click()
await sleep(5000)
await figure('tl03-square-again-atac-as-it-was')
await g.close()
