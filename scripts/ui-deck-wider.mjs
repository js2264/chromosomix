/**
 * A deck going wider than the place it opened on (§16.3), on the yeast deck —
 * micro-C first, Hi-C beside it, opened on IV:1.0–1.4 Mb: as opened; zoomed in
 * on the first map, both on one window; panned past the region's left edge,
 * both reading what lies beyond it; zoomed out past the region, both following;
 * and `0` (*Undo every pan and zoom*), both on the whole of IV. The Hi-C map
 * used to stay on 1.0–1.4 Mb through the last three. The log prints, after each
 * step, where each map's window begins and ends, read off the pointer's readout
 * at two corners of its plot.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-deck-wider.mjs [out-dir]     # dw01 … dw05
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT, { width: 1920, height: 1200 })
const { page } = g

const shot = async (name) => {
  await page.mouse.move(20, 600)
  await sleep(400)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`wrote ${name}.png`)
}

/** Each map's plot, in reading order. */
const plots = () =>
  page.locator('.deck-panel .heatmap-canvas').evaluateAll((all) =>
    all.map((canvas) => {
      const r = canvas.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }),
  )

/** The column the readout names under the pointer, where it names one. */
async function columnAt(x, y) {
  await page.mouse.move(x, y)
  await sleep(200)
  const text = await page.evaluate(() => document.querySelector('.status-coords')?.textContent ?? '')
  const places = [...text.matchAll(/([IVX]+):([\d,]+)/g)].map((m) => `${m[1]}:${m[2]}`)
  return places.at(-1) ?? '?'
}

/**
 * Where each map's window begins and ends across, read on the diagonal a little
 * in from its plot's corners — where there are contacts to read, which a
 * filtered bin off it has not.
 */
async function windows(label) {
  const out = []
  for (const p of await plots()) {
    const from = await columnAt(p.x + 0.05 * p.w, p.y + 0.05 * p.h)
    const to = await columnAt(p.x + 0.95 * p.w, p.y + 0.95 * p.h)
    out.push(`${from} … ${to}`)
  }
  console.log(label.padEnd(30), out.join('   |   '))
}

async function wheel(notches) {
  const [lead] = await plots()
  await page.mouse.move(lead.x + lead.w / 2, lead.y + lead.h / 2)
  for (let i = 0; i < Math.abs(notches); i++) {
    await page.mouse.wheel(0, notches > 0 ? -240 : 240)
    await sleep(350)
  }
  await page.mouse.move(20, 600)
  await sleep(6000)
}

await page.goto(`${g.base}/`)
await page.evaluate(() => localStorage.removeItem('chromosomix:map-size'))
await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_deck.chromosomix.json`)
await page.waitForFunction(() => document.querySelectorAll('.deck-panel .heatmap-canvas').length >= 2, null, { timeout: 120000 })
await sleep(9000)
await windows('as opened')
await shot('dw01-deck-as-opened')

await wheel(3)
await windows('zoomed in on the first map')
await shot('dw02-zoomed-in')

// Dragged right across most of the plot, three times: the window goes left,
// past 1.0 Mb. A drag stops at the edge of what the first map holds, and the
// next goes on once its read-ahead has landed.
{
  const [lead] = await plots()
  const from = { x: lead.x + lead.w * 0.2, y: lead.y + lead.h * 0.2 }
  for (let drag = 0; drag < 3; drag++) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let k = 1; k <= 14; k++) {
      await page.mouse.move(from.x + (lead.w * 0.6 * k) / 14, from.y + (lead.h * 0.6 * k) / 14)
      await sleep(40)
    }
    await page.mouse.up()
    await page.mouse.move(20, 600)
    await sleep(4000)
  }
  await sleep(2000)
}
await windows('panned past the region’s start')
await shot('dw03-panned-past-the-region')

await wheel(-4)
await windows('zoomed out past the region')
await shot('dw04-zoomed-out-past-the-region')

await page.keyboard.press('0')
await sleep(9000)
await windows('0 pressed')
await shot('dw05-fit-the-view-whole-IV')

await g.close()
