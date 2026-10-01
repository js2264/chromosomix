/**
 * The stage's corner dot plot in the hand (§27.3), in headless Chromium on the
 * chrXVI–mycoides reassembly with its theoretical genome loaded beside it (see
 * `data/README.md`, and a session config under `out/reasm/` that holds the
 * map and both FASTAs): the plot at its own size; zoomed by the wheel about a
 * line and moved by a drag, as the dot plot's own view is (§28.2); a contig's
 * name hovered on the map's bar, its lines lit in the plot and the others
 * dimmed; a line hovered in the plot, its contig lit on the map; sized larger
 * by its grip; and the stage opened again in the dark theme, the size kept.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-dotplot.mjs [out-dir]     # o01 … o07
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const CONFIG = process.env.DOTPLOT_CONFIG ?? '/out/reasm/Dotplot.metacooler.json'
const g = await gallery(OUT)
const { page, shot, text, openStage, openWithDev, settled } = g

await openWithDev(`?config=${g.base}${CONFIG}`)
await sleep(15000)

async function stage() {
  await openStage()
  await settled()
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    if (/streaks? · the edit/.test((await text('.edit-dotplot-caption')) ?? '')) break
  }
  await page.mouse.move(10, 10)
  await sleep(300)
}
const plot = () => page.locator('.edit-dotplot-canvas').boundingBox()
const view = () => page.evaluate(() => document.querySelector('.edit-dotplot-canvas')?.dataset.view ?? '')

/**
 * The longest line in the plot, found by a pointer swept across it in the
 * page — the readout names the line under it, its extent first — and its
 * middle on the page, as the plot says where it drew the line lit.
 */
async function longestLine() {
  const best = await page.evaluate(async () => {
    const canvas = document.querySelector('.edit-dotplot-canvas')
    const readout = document.querySelector('.edit-readout')
    const box = canvas.getBoundingClientRect()
    let found = null
    for (let y = 6; y < box.height - 4; y += 3) {
      for (let x = 6; x < box.width - 4; x += 3) {
        canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + x, clientY: box.top + y, bubbles: true }))
        const extent = /^[^:]+:([\d,]+)-([\d,]+) ×/.exec(readout.textContent ?? '')
        if (extent === null) continue
        const length = Number(extent[2].replaceAll(',', '')) - Number(extent[1].replaceAll(',', ''))
        if (found === null || length > found.length) found = { length, x: box.left + x, y: box.top + y, says: readout.textContent }
      }
    }
    if (found !== null) {
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: found.x, clientY: found.y, bubbles: true }))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const ends = (canvas.dataset.lit ?? '').split(' ').map(Number)
      if (ends.length === 4) Object.assign(found, { x: box.left + (ends[0] + ends[2]) / 2, y: box.top + (ends[1] + ends[3]) / 2 })
    }
    canvas.dispatchEvent(new PointerEvent('pointerleave'))
    return found
  })
  console.log('longest line:', best?.says)
  return best
}

await stage()
console.log('corner:', await text('.edit-dotplot-caption'), '·', (await plot()).width, 'px ·', await view())
await shot('o01-corner')

// Zoomed by the wheel about the middle of the longest line.
const line = await longestLine()
await page.mouse.move(line.x, line.y)
for (let k = 0; k < 4; k++) {
  await page.mouse.wheel(0, -200)
  await sleep(60)
}
await sleep(300)
console.log('zoomed:', await view(), '·', await text('.edit-readout'))
await shot('o02-zoomed')

// Moved by a drag, the picture following the hand.
await g.drag({ x: line.x, y: line.y }, { x: line.x - 50, y: line.y + 30 })
await page.mouse.move(line.x - 50, line.y + 30)
await sleep(300)
console.log('moved:', await view(), '·', await text('.edit-readout'))
await shot('o03-moved')

// The whole again, by a double click.
await page.mouse.dblclick(line.x, line.y)

// A contig's name hovered on the top bar: its lines lit in the plot, the others dimmed.
const map = await g.mapBox()
const bar = await page.locator('.edit-bar-top').boundingBox()
const names = await page.evaluate(() =>
  [...document.querySelectorAll('.edit-sequence')].map((button) => ({
    name: button.querySelector('.edit-sequence-name')?.textContent,
    cells: button.dataset.cells?.split(' ').map(Number),
  })),
)
let best = null
for (const { name, cells } of names) {
  if (cells === undefined) continue
  const x = map.left + (((cells[0] + cells[1]) / 2 - map.x0) / (map.x1 - map.x0)) * map.width
  if (x < bar.x + 4 || x > bar.x + bar.width - 4) continue
  await page.mouse.move(x, bar.y + 6)
  await sleep(120)
  const count = Number(await page.evaluate(() => document.querySelector('.edit-dotplot-canvas')?.dataset.focused ?? 0))
  // Not the fused chromosome's, which is most of the plot: one of the contigs that make it.
  if (count > 1 && count < 12 && (best === null || cells[1] - cells[0] > best.width)) best = { name, x, count, width: cells[1] - cells[0] }
}
console.log('name hovered:', best?.name, best?.count, 'lines')
if (best !== null) await page.mouse.move(best.x, bar.y + 6)
await sleep(300)
await shot('o04-name-hovered')

// A line hovered in the plot: its contig lit on the map, on both bars and the diagonal.
const long = await longestLine()
await page.mouse.move(long.x, long.y)
await sleep(300)
console.log('line hovered:', await text('.edit-readout'))
await shot('o05-line-hovered')

// Sized larger by its grip.
const grip = await page.locator('.edit-dotplot-grip').boundingBox()
await g.drag({ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, { x: grip.x - 180, y: grip.y + 180 })
await page.mouse.move(10, 10)
await sleep(300)
console.log('sized:', (await plot()).width, 'px · kept', await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.includes('edit:dotplot-side'))?.[1]))
await shot('o06-sized')

// The stage opened again in the dark: the size the grip gave it kept.
await page.mouse.move(10, 10)
await page.click('.modal-panel .btn-close')
await sleep(600)
await page.emulateMedia({ colorScheme: 'dark' })
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await stage()
console.log('dark:', (await plot()).width, 'px')
const dark = await longestLine()
await page.mouse.move(dark.x, dark.y)
await sleep(300)
console.log('dark, line hovered:', await text('.edit-readout'))
await shot('o07-dark')
await g.close()
