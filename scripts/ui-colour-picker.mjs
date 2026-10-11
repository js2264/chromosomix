/**
 * The app's colour picker (§26.6), in headless Chromium on the yeast micro-C
 * demo: a track's swatch opened, a drag across the square held mid-way with
 * the lane recoloured under it, the picker still open after the release, a hex
 * typed, the next swatch offering what was just picked, a lane's own swatch
 * under the map, and the dark theme.
 *
 * The log prints, after each gesture, whether the picker is open and what the
 * swatch now holds — which is how "a drag does not close it" is checked.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-colour-picker.mjs [out-dir]     # cp01 … cp08
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page } = g

const state = async (what) => {
  const row = await page.evaluate(() => ({
    open: document.querySelector('.cpick') !== null,
    hex: document.querySelector('.cpick-hex')?.value ?? null,
    swatches: [...document.querySelectorAll('input[type=color].ann-swatch')].map((i) => `${i.title.replace('Colour for ', '')} ${i.value}`),
    recent: [...document.querySelectorAll('.cpick-chip')].map((c) => c.dataset.colour),
  }))
  console.log(what.padEnd(16), JSON.stringify(row))
}

/** The picker and the card it came from, cropped. */
const crop = async (name) => {
  const box = await page.evaluate(() => {
    const pick = document.querySelector('.cpick')?.getBoundingClientRect()
    const card = document.querySelector('.ann-swatch')?.closest('.card')?.getBoundingClientRect()
    const boxes = [pick, card].filter(Boolean)
    const left = Math.min(...boxes.map((b) => b.left)) - 16
    const top = Math.min(...boxes.map((b) => b.top)) - 16
    const right = Math.max(...boxes.map((b) => b.right)) + 16
    const bottom = Math.max(...boxes.map((b) => b.bottom)) + 16
    return { x: Math.max(0, left), y: Math.max(0, top), width: right - left, height: Math.min(bottom, 1000) - top }
  })
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: box })
  console.log(`wrote ${name}.png`)
}

const swatch = (label) => page.locator(`.ann-swatch[title="Colour for ${label}"]`).first()

await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(9000)
await page.locator('button[title^="Show the Annotations panel"]').first().click()
await sleep(1200)

// Opened: the square, the hue, the hex and an empty recent row.
await swatch('ATAC').click()
await sleep(400)
await state('opened')
await crop('cp01-opened-hex-first')

// A drag across the square, held mid-way: the lane is already in the colour.
const field = await page.locator('.cpick-field').boundingBox()
await page.mouse.move(field.x + field.width * 0.2, field.y + field.height * 0.2)
await page.mouse.down()
for (let k = 1; k <= 16; k++) {
  await page.mouse.move(field.x + field.width * (0.2 + k * 0.045), field.y + field.height * (0.2 + k * 0.025))
  await sleep(40)
}
await sleep(1200)
await state('mid-drag')
await g.shot('cp02-mid-drag-lane-recoloured')
// …and the hue bar, dragged on from there.
const hue = await page.locator('.cpick-hue').boundingBox()
await page.mouse.up()
await page.mouse.move(hue.x + hue.width * 0.1, hue.y + hue.height / 2)
await page.mouse.down()
for (let k = 1; k <= 10; k++) {
  await page.mouse.move(hue.x + hue.width * (0.1 + k * 0.03), hue.y + hue.height / 2)
  await sleep(40)
}
await page.mouse.up()
await sleep(800)
await state('released')
await crop('cp03-still-open-after-drags')

// A hex typed, and Enter.
await page.locator('.cpick-hex').fill('e69f00')
await sleep(500)
await state('typed')
await crop('cp04-hex-typed')
await page.keyboard.press('Enter')
await sleep(800)
await state('enter')

// The other track: what was picked is offered.
await swatch('Pol II / input').click()
await sleep(400)
await state('second swatch')
await crop('cp05-recent-colours')
await page.locator('.cpick-chip').first().click()
await sleep(800)
await state('chip clicked')
await crop('cp06-recent-chip-applied')
await page.keyboard.press('Escape')
await sleep(300)

// The swatch before a lane's name, under the map, opens the same picker.
await page.locator('.lane-swatch[title="Colour for ATAC"]').first().click()
await sleep(400)
await state('lane swatch')
await g.shot('cp07-lane-label-swatch')
await page.keyboard.press('Escape')
await sleep(300)

// Dark.
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await sleep(600)
await swatch('ATAC').click()
await sleep(400)
await crop('cp08-dark')
await state('dark')

if (g.errors?.length) console.log('page errors', g.errors)
await g.browser.close()
