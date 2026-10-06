/**
 * The diagonal lock (§7.2, §8.9), in headless Chromium on the yeast micro-C
 * demo. Zoomed in, a sideways scroll is the columns alone; Space locks the view
 * onto the diagonal and lights the toggle beside the turn; then a sideways
 * scroll slides down the diagonal, a drag straight across the map moves it
 * along the line, an Option-drag draws its box on the diagonal, a step to the
 * next sequence stays locked, and a second Space lets go.
 *
 * The line under the title names the window on screen: one locus when the view
 * is on the diagonal, `rows × columns` when it is not — which is what the log
 * prints after every gesture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-diagonal-slide.mjs [out-dir]     # w01 … w08
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot } = g

/** The window the line under the title names, and whether the toggle is lit. */
const state = () =>
  page.evaluate(() => {
    const head = document.querySelector('.view-head')?.innerText.replace(/\s+/g, ' ') ?? ''
    const window = (head.split('effective resolution: ')[1] ?? '').split(' · ').slice(1).join(' · ')
    const toggle = [...document.querySelectorAll('button')].find((b) => (b.title ?? '').startsWith('Lock the view on the diagonal'))
    return `${window || '?'} · lock ${toggle?.getAttribute('aria-pressed') ?? 'none'}`
  })

await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.metacooler.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(8000)
const box = await page.locator('.heatmap-canvas').first().boundingBox()
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
await page.mouse.move(centre.x, centre.y)
for (let k = 0; k < 4; k++) {
  await page.mouse.wheel(0, -240)
  await sleep(120)
}
await sleep(2500)
console.log('zoomed in      ', await state())
await shot('w01-before')

// Unlocked: two fingers sideways are the columns alone, and the view leaves the line.
for (let k = 0; k < 12; k++) {
  await page.mouse.wheel(60, 0)
  await sleep(40)
}
await sleep(2500)
console.log('sideways, free ', await state())
await shot('w02-unlocked-columns-alone')

// Space: onto the diagonal, and held.
await page.keyboard.press('Space')
await sleep(2500)
console.log('Space          ', await state())
await shot('w03-locked')

for (let k = 0; k < 12; k++) {
  await page.mouse.wheel(60, 0)
  await sleep(40)
}
await sleep(2500)
console.log('sideways, held ', await state())
await shot('w04-locked-slid-down-the-diagonal')

// A drag straight left, across the line: the part of it along the diagonal.
await page.mouse.move(centre.x, centre.y)
await page.mouse.down()
for (let k = 1; k <= 12; k++) {
  await page.mouse.move(centre.x - k * 20, centre.y)
  await sleep(25)
}
await page.mouse.up()
await sleep(2500)
console.log('drag left, held', await state())
await shot('w05-locked-drag-along')

// An Option-drag off the line: its box is drawn on the diagonal, as with Shift.
await page.keyboard.down('Alt')
await page.mouse.move(centre.x - 150, centre.y + 40)
await page.mouse.down()
for (let k = 1; k <= 12; k++) {
  await page.mouse.move(centre.x - 150 + k * 14, centre.y + 40 + k * 4)
  await sleep(25)
}
await sleep(400)
await shot('w06-locked-option-drag-box-on-the-diagonal')
await page.keyboard.press('Escape')
await page.mouse.up()
await page.keyboard.up('Alt')
await sleep(800)

// The next sequence: a new map, still held.
await page.keyboard.press('Shift+Period')
await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get('region') === 'V', null, { timeout: 60000 })
await sleep(6000)
await page.mouse.move(centre.x, centre.y)
for (let k = 0; k < 3; k++) {
  await page.mouse.wheel(0, -240)
  await sleep(120)
}
await sleep(2000)
for (let k = 0; k < 8; k++) {
  await page.mouse.wheel(60, 0)
  await sleep(40)
}
await sleep(2500)
console.log('V, zoom + slide', await state())
await shot('w07-next-sequence-still-locked')

// Space again: let go, and a drag goes where the hand does.
await page.keyboard.press('Space')
await sleep(800)
await page.mouse.move(centre.x, centre.y)
await page.mouse.down()
for (let k = 1; k <= 12; k++) {
  await page.mouse.move(centre.x - k * 20, centre.y)
  await sleep(25)
}
await page.mouse.up()
await sleep(2500)
console.log('let go, drag   ', await state())
await shot('w08-let-go-drag-leaves-the-line')
await g.close()
