/**
 * A map read at the screen's size and sharpened as the reader zooms (§2): chicken
 * chr1 opened at 10 kb, its first picture 785 cells of the 250 kb rung; a
 * continuous wheel zoom, caught mid-gesture with the block in hand magnified and
 * the spinner turning — nothing frozen; the same zoom once it has landed on the
 * file's own bins; a drag along the diagonal that reads ahead of its edge; and a
 * figure saved from a wide view, the Export card reading the framed window at
 * 10 kb before it draws.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-zoom.mjs [out-dir]     # zm01 … zm07
 *
 * GALLERY_DATA names a folder served with byte ranges and CORS holding
 * `G2_4DNFIRKUYKP4.hic` (940 MB, of which the walk reads a few dozen). It is no
 * longer on the lab's bucket, so there is no default. Serve it on a line — a
 * delay before each response and a capped rate, as a bucket answers; §12 quotes
 * 40 ms and 25 MiB/s — so the reads take the time they take for a reader.
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const DATA = process.env.GALLERY_DATA
if (DATA === undefined) {
  console.error(
    'G2_4DNFIRKUYKP4.hic is no longer on the lab’s bucket: serve a folder holding it with byte ranges and ' +
      'CORS, on a line like a bucket’s, and name its address in GALLERY_DATA',
  )
  process.exit(1)
}
const URI = `${DATA}/G2_4DNFIRKUYKP4.hic::/resolutions/10000`

const g = await gallery(OUT, { width: 1600, height: 1000 })
const { page, shot } = g
await page.addInitScript(() => {
  window.__reports = []
  window.addEventListener('chromosomix:rendered', (event) => window.__reports.push(event.detail))
  // The save dialog, answered with the name it was asked for, as a reader would.
  window.__saved = []
  window.showSaveFilePicker = async (options) => {
    window.__saved.push(options.suggestedName)
    return { name: options.suggestedName, createWritable: async () => ({ write: async () => {}, close: async () => {} }) }
  }
})

/** What the line under the heading says, and the Export card's. */
async function lines(label) {
  const said = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.controls-card')].find(
      (node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Export',
    )
    return {
      map: document.querySelector('.view-span')?.parentElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      export: card?.querySelector('.export-note')?.textContent ?? '',
      frozen: document.querySelector('canvas.is-frozen') !== null,
    }
  })
  console.log(`${label}: ${JSON.stringify(said)}`)
}

await page.goto(`${g.base}/#uri=${encodeURIComponent(URI)}&view=contigs`)
await page.waitForFunction(() => document.body.textContent.includes('196.20 Mb'), null, { timeout: 180000 })
await sleep(4000)

const t0 = Date.now()
const before = await page.evaluate(() => window.__reports.length)
await page.evaluate((hash) => {
  location.hash = hash
}, `uri=${encodeURIComponent(URI)}&view=region&region=1`)
await page.waitForFunction((n) => window.__reports.slice(n).some((r) => r.maps?.length > 0), before, {
  timeout: 180000,
})
console.log(`chr1 on screen at ${((Date.now() - t0) / 1000).toFixed(2)} s`)
await sleep(600)
await lines('first picture')
await shot('zm01-first-picture-250kb')

const box = await page.evaluate(() => {
  const r = document.querySelector('canvas.heatmap-canvas').getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
})
const on = { x: box.x + box.w * 0.42, y: box.y + box.h * 0.42 }
await page.mouse.move(on.x, on.y)
// A steady wheel: ten notches, then a picture with the next read still going.
for (let i = 0; i < 10; i++) {
  await page.mouse.wheel(0, -200)
  await sleep(110)
}
await lines('mid-zoom')
await shot('zm02-mid-zoom-live')
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -200)
  await sleep(110)
}
await sleep(2500)
await lines('zoom landed')
await shot('zm03-zoom-landed-10kb')

// A drag along the diagonal, a little at a time.
for (let i = 0; i < 3; i++) {
  await g.drag(on, { x: on.x - 120, y: on.y - 120 }, 10)
}
await sleep(2500)
await lines('after a drag')
await shot('zm04-dragged')

// Back out to a wide view, and save its figure: the card reads the framed
// window at 10 kb first.
for (let i = 0; i < 9; i++) {
  await page.mouse.wheel(0, 240)
  await sleep(110)
}
await sleep(2500)
await lines('zoomed back out')
await shot('zm05-zoomed-out')
/** The map's own Export card's line. */
const exportNote = () =>
  [...document.querySelectorAll('.controls-card')]
    .find((node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Export')
    ?.querySelector('.export-note')?.textContent ?? ''
await page.evaluate((read) => {
  const note = new Function(`return (${read})()`)
  window.__notes = []
  const card = [...document.querySelectorAll('.controls-card')].find(
    (node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Export',
  )
  new MutationObserver(() => window.__notes.push(note())).observe(card, { subtree: true, characterData: true, childList: true })
  card?.querySelector('.export-acts button')?.click()
}, exportNote.toString())
await page.waitForFunction(`/reading the map/.test((${exportNote.toString()})())`, null, { timeout: 20000 })
// The picture first: the read takes about half a second on the line.
await shot('zm06-figure-reading')
await lines('saving')
await page.waitForFunction(`/\\.pdf · /.test((${exportNote.toString()})())`, null, { timeout: 180000 })
console.log('the card said:', await page.evaluate(() => window.__notes))
await sleep(600)
await lines('saved')
console.log('saved:', await page.evaluate(() => window.__saved))
await shot('zm07-figure-saved-map-sharper')

await g.close()
