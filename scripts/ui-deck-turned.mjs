/**
 * A deck turned 45° moving as one (§16.4, §17.3), with the network, on the lab's
 * yeast micro-C (A364A): the same mcool twice, IV picked in the chromosome table,
 * zoomed in square, turned, zoomed, double-clicked back to the whole of IV,
 * zoomed again, stepped on to V with `>` and zoomed, back to IV with `<`,
 * squared, zoomed, turned again; then the second map taken off the chain while
 * the first zooms, and put back. The second map used to stop following at the
 * turn (*the same name resolved against different sequences*) and on V (*this
 * band reaches 577.6 kb from the diagonal where the first map reaches 1.6 kb*),
 * and stay where it stopped. The log prints, after each step, where each map's
 * window begins and ends along the diagonal, read off the pointer's readout, and
 * any line under a map's heading saying it is not following.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-deck-turned.mjs [out-dir]     # td01 … td13
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT, { width: 1920, height: 1100 })
const { page } = g
const FILE = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/store/yeast/GSE151553_A364_merged.mcool'

/** Each map's plot, in reading order. */
const plots = () =>
  page.locator('.deck-panel .heatmap-canvas').evaluateAll((all) =>
    all.map((canvas) => {
      const r = canvas.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }),
  )

/** The line under each map's heading where it is not following. */
const notes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.deck-panel')].map(
      (cell) => cell.querySelector('.deck-unlocked:not(.hidden)')?.textContent ?? '',
    ),
  )

/** The column the readout names under the pointer, where it names one. */
async function columnAt(x, y) {
  await page.mouse.move(x, y)
  await sleep(200)
  const text = await page.evaluate(() => document.querySelector('.status-coords')?.textContent ?? '')
  const places = [...text.matchAll(/([IVX]+):([\d,]+)/g)].map((m) => `${m[1]}:${m[2]}`)
  return places.at(-1) ?? '–'
}

/** Where each map's window begins and ends across, near the foot of its plot. */
async function report(label) {
  const out = []
  for (const p of await plots()) {
    const from = await columnAt(p.x + 0.05 * p.w, p.y + p.h * 0.9)
    const to = await columnAt(p.x + 0.95 * p.w, p.y + p.h * 0.9)
    out.push(`${from} … ${to}`)
  }
  console.log(label.padEnd(30), out.join('   |   '))
  for (const [i, note] of (await notes()).entries()) if (note !== '') console.log(`   map ${i + 1}: ${note}`)
}

let step = 0
async function shot(name) {
  await page.mouse.move(20, 1000)
  await sleep(300)
  step++
  const file = `td${String(step).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: `${OUT}/${file}` })
  console.log(`wrote ${file}`)
}

/** Wheel notches over the first map's middle (in: positive), then the reads. */
async function wheel(notches) {
  const [lead] = await plots()
  await page.mouse.move(lead.x + lead.w / 2, lead.y + lead.h / 2)
  for (let i = 0; i < Math.abs(notches); i++) {
    await page.mouse.wheel(0, notches > 0 ? -240 : 240)
    await sleep(300)
  }
  await page.mouse.move(20, 1000)
  await sleep(7000)
}

async function turn() {
  await page.locator('button[title^="Turn this map"], button[title^="Draw this map square"]').first().click()
  await sleep(7000)
}

async function stepTo(direction) {
  await page.locator(`button[aria-label="${direction} sequence"], button[title^="${direction === 'next' ? 'Next' : 'Previous'}"]`).first().click()
  await sleep(9000)
}

/** The second map's chain. */
const chain = () =>
  page
    .locator('.deck-panel')
    .nth(1)
    .locator('button[title^="Following the other maps"], button[title^="Moving on its own"]')
    .first()

await page.goto(`${g.base}/`)
await page.evaluate(() => localStorage.clear())
await page.goto(`${g.base}/#uri=${encodeURIComponent(FILE)}&maps=${encodeURIComponent(FILE)}&view=chromosomes`)
await sleep(8000)
await page.getByText('chrIV', { exact: true }).first().click()
await page.waitForFunction(() => document.querySelectorAll('.deck-panel .heatmap-canvas').length >= 2, null, { timeout: 120000 })
await sleep(9000)
await report('IV opened')
await shot('iv-opened')

await wheel(3)
await report('zoomed in, square')
await shot('iv-zoomed-square')

await turn()
await report('turned')
await shot('iv-turned')

await wheel(2)
await report('turned, zoomed')
await shot('iv-turned-zoomed')

const [lead] = await plots()
await page.mouse.dblclick(lead.x + lead.w / 2, lead.y + lead.h - 20)
await sleep(7000)
await report('double click: the whole of IV')
await shot('iv-double-click')

await wheel(2)
await report('zoomed again')
await shot('iv-zoomed-again')

await stepTo('next')
await report('> to V')
await shot('v-stepped')

await wheel(2)
await report('V zoomed')
await shot('v-zoomed')

await stepTo('previous')
await report('< back to IV')
await shot('iv-stepped-back')

await turn()
await report('square again')
await wheel(3)
await report('square, zoomed')
await shot('iv-square-zoomed')

await turn()
await report('turned again')
await shot('iv-turned-again')

await chain().click()
await sleep(1500)
await wheel(2)
await report('second map off its chain')
await shot('second-map-on-its-own')

await chain().click()
await sleep(7000)
await report('second map back on')
await shot('second-map-back-on')

if (g.errors.length > 0) console.log('page errors:', g.errors)
await g.close()
