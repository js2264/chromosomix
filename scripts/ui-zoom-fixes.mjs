/**
 * Refine on zoom's follow-ups, on the lab's real files over the network
 * (§2, §7.1, §8.9, §12, §17), in headless Chromium:
 *
 * - **E. coli micro-C** (`Ecoli_microC.mcool`, opened at 200 bp, stored down to
 *   10 bp and balanced from 100 bp): the whole genome zoomed until the block
 *   on screen is the open rung's own, the key and the line above the map naming
 *   the same 200 bp (it said `1.2 kb`); then on in, coming to rest at 100 bp,
 *   balanced, where the 10 bp rung's refusal used to take the map's place.
 * - **K562** (4DN's `.mcool` at 10 kb): the whole genome zoomed into chr7, the
 *   lock let go, the map dragged off its diagonal — the compartments drawn on a
 *   range measured on what is in view — and dragged back onto the line.
 * - **chr7 turned**, zoomed and panned with *Refine on zoom* on, every read
 *   printed: each one around the view it is for.
 * - **The status bar** through a zoom: *read* and *memory* moving as the
 *   blocks land, and each one's panel hovered.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-zoom-fixes.mjs [out-dir]     # zf01 … zf10
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const ECOLI = 'https://rsglab-data.s3.amazonaws.com/public/Ecoli_microC.mcool'
const K562 = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/store/k562/4DNFI18UHVRO.mcool::resolutions/10000'

const g = await gallery(OUT, { width: 1600, height: 1000, scale: 2 })
const { page, shot } = g
await page.addInitScript(() => {
  window.__reads = []
  const post = Worker.prototype.postMessage
  Worker.prototype.postMessage = function (message, ...rest) {
    const asked = message?.request ?? message
    if (asked?.kind === 'matrix') {
      window.__reads.push({ rows: asked.rows, cols: asked.cols ?? asked.rows, rung: asked.rung ?? 'open' })
    }
    return post.call(this, message, ...rest)
  }
})

/** The line above the map, the key's resolution, and the status bar. */
const said = () =>
  page.evaluate(() => {
    const line = document.querySelector('.view-span')?.parentElement?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const items = [...document.querySelectorAll('.app-foot .status-item')].map(
      (node) => `${node.querySelector('.status-key')?.textContent} ${node.querySelector('.status-value')?.textContent}`,
    )
    return {
      line: /effective resolution: [^·]+· (.*)/.exec(line)?.[0] ?? line.slice(0, 120),
      key: document.querySelector('.map-key .map-key-note')?.textContent ?? '',
      refused: document.querySelector('.inline-error, .problem:not(.hidden)')?.textContent?.slice(0, 90) ?? null,
      bar: items.filter((item) => /^(read|memory)/.test(item)).join(' | '),
    }
  })
const log = async (label) => console.log(label.padEnd(26), JSON.stringify(await said()))
const plot = () =>
  page.evaluate(() => {
    const r = document.querySelector('canvas.heatmap-canvas').getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
const reads = () => page.evaluate(() => window.__reads.splice(0))

/** Wheel in at `at`, a notch at a time, until the key names `until` or `most` notches are spent. */
async function zoomTo(at, until, most = 40) {
  await page.mouse.move(at.x, at.y)
  for (let notch = 0; notch < most; notch++) {
    if ((await said()).key === until) return true
    await page.mouse.wheel(0, -160)
    await sleep(notch % 3 === 2 ? 1800 : 200)
  }
  return (await said()).key === until
}

async function drag(from, by, steps = 24) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(from.x + (by.x * step) / steps, from.y + (by.y * step) / steps)
    await sleep(20)
  }
  await page.mouse.up()
}

try {
  // E. coli: the open rung, keyed as the line above it says.
  await page.goto(`${g.base}/#uri=${encodeURIComponent(ECOLI)}&view=whole`)
  await page.waitForSelector('canvas.heatmap-canvas', { timeout: 180000 })
  await sleep(4000)
  await log('E. coli, whole genome')
  await shot('zf01-ecoli-whole-genome')
  let box = await plot()
  const aim = { x: box.x + box.w * 0.45, y: box.y + box.h * 0.45 }
  console.log('reached 200 bp:', await zoomTo(aim, '200 bp'))
  await sleep(2500)
  await log('E. coli, at its open rung')
  await shot('zf02-ecoli-200bp-key-and-line-agree')
  console.log('reached 100 bp:', await zoomTo(aim, '100 bp'))
  for (let notch = 0; notch < 8; notch++) {
    await page.mouse.wheel(0, -160)
    await sleep(400)
  }
  await sleep(4000)
  await log('E. coli, zoomed to the end')
  console.log('  reads of the 10 bp rung:', (await reads()).filter((read) => read.rung === '10').length)
  await shot('zf03-ecoli-rests-at-100bp-balanced')

  // K562: off the diagonal, and back.
  await page.goto(`${g.base}/#uri=${encodeURIComponent(K562)}&view=whole`)
  await page.waitForSelector('canvas.heatmap-canvas', { timeout: 180000 })
  await sleep(5000)
  box = await plot()
  // chr7, a little over 40% of the way down the genome.
  console.log('reached 25 kb:', await zoomTo({ x: box.x + box.w * 0.43, y: box.y + box.h * 0.43 }, '25 kb'))
  await sleep(3000)
  await log('K562 chr7, held')
  await shot('zf04-k562-chr7-on-the-diagonal')
  const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
  await page.mouse.move(centre.x, centre.y)
  await page.keyboard.press('Space')
  await sleep(500)
  for (let k = 0; k < 3; k++) {
    await drag(centre, { x: -260, y: 0 })
    await sleep(1500)
  }
  await sleep(3000)
  await log('K562, off the diagonal')
  await shot('zf05-k562-off-the-diagonal-range-follows')
  for (let k = 0; k < 3; k++) {
    await drag(centre, { x: 260, y: 0 })
    await sleep(1500)
  }
  await page.keyboard.press('Space')
  await sleep(3500)
  await log('K562, back on the line')
  await shot('zf06-k562-back-on-the-diagonal')

  // chr7 turned: every read around the view it is for.
  await page.goto(`${g.base}/#uri=${encodeURIComponent(K562)}&view=region&region=chr7`)
  await page.waitForSelector('canvas.heatmap-canvas', { timeout: 180000 })
  await sleep(5000)
  await page.locator('button[aria-label^="Turn this map 45"]').first().click()
  await sleep(4000)
  await reads()
  box = await plot()
  const under = { x: box.x + box.w * 0.5, y: box.y + box.h * 0.8 }
  await page.mouse.move(under.x, under.y)
  for (let notch = 0; notch < 10; notch++) {
    await page.mouse.wheel(0, -150)
    await sleep(120)
  }
  await sleep(3500)
  await log('chr7 turned, zoomed')
  await shot('zf07-chr7-turned-zoomed')
  for (let k = 0; k < 3; k++) {
    await drag(under, { x: -240, y: 0 })
    await sleep(1200)
  }
  await sleep(3500)
  await log('chr7 turned, panned')
  await shot('zf08-chr7-turned-panned')
  for (const read of await reads()) console.log('  read', JSON.stringify(read))

  // The status bar's two panels.
  await page.hover('.app-foot .status-item:has(#status-read-pop)')
  await sleep(400)
  await shot('zf09-status-read-panel')
  await page.hover('.app-foot .status-item:has(#status-memory-pop)')
  await sleep(1200)
  await shot('zf10-status-memory-panel')
} finally {
  if (g.errors.length > 0) console.log('page errors:', g.errors)
  await g.close()
}
