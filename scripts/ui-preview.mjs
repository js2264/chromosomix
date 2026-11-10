/**
 * A chromosome drawn first from a coarser rung, live while its own block reads
 * (§7.2): chicken chr1 at 25 kb, its 500 kb preview on screen at once with the
 * spinner in its corner and the Export card held, the preview zoomed and
 * dragged by the reader while the block is still reading, and the block landing
 * on that window rather than refitted; then chr2, left alone, whose block lands
 * fitted as it always did.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-preview.mjs [out-dir]     # pv01 … pv06
 *
 * GALLERY_DATA names a folder served with byte ranges and CORS holding
 * `G2_4DNFIRKUYKP4.hic`, 940 MB, of which the walk reads a few dozen. It is no
 * longer on the lab's bucket, so there is no default. Served from this machine
 * the block lands before anyone could move its preview: serve it on a line
 * (a delay before each response and a capped rate, as a bucket answers) so the
 * preview stays up long enough to be moved; §7.2 quotes 40 ms and 25 MiB/s.
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const DATA = process.env.GALLERY_DATA
if (DATA === undefined) {
  console.error(
    'G2_4DNFIRKUYKP4.hic is no longer on the lab’s bucket: serve a folder holding it with byte ranges and ' +
      'CORS, on a line slow enough for its preview to be moved, and name its address in GALLERY_DATA',
  )
  process.exit(1)
}
const URI = `${DATA}/G2_4DNFIRKUYKP4.hic::/resolutions/25000`

const g = await gallery(OUT, { width: 1600, height: 1000 })
const { page, shot } = g
await page.addInitScript(() => {
  window.__reports = []
  window.addEventListener('chromosomix:rendered', (event) => window.__reports.push(event.detail))
})

/** The hash of a region view of `region` in the file. */
const regionHash = (region) => `uri=${encodeURIComponent(URI)}&view=region&region=${encodeURIComponent(region)}`

/**
 * Go to a region and wait for its first picture, which is the preview: a
 * title, and no veil over the map. The number of finished-picture reports
 * before it, so the block's own can be told apart.
 */
async function toPreview(region) {
  const reports = await page.evaluate(() => window.__reports.length)
  await page.evaluate((hash) => {
    window.__before = document.querySelector('.region-title')
    location.hash = hash
  }, regionHash(region))
  await page.waitForFunction(
    () => {
      const title = document.querySelector('.region-title')
      const overlays = [...document.querySelectorAll('.panel-overlay')]
      return title !== null && title !== window.__before && overlays.length > 0 && overlays.every((o) => o.classList.contains('hidden'))
    },
    null,
    { timeout: 120000, polling: 'raf' },
  )
  return reports
}

/** Wait for the block's finished picture, reported after `reports`. */
async function toBlock(reports) {
  await page.waitForFunction((n) => window.__reports.slice(n).some((r) => r.maps?.length > 0), reports, {
    timeout: 180000,
  })
  await sleep(400)
}

/** What the map says it is, and its Export card's line and two buttons (save, copy). */
async function state(label) {
  const said = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.controls-card')].find(
      (node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Export',
    )
    return {
      key: document.querySelector('.map-key-note')?.textContent ?? '',
      view: document.querySelector('.view-span')?.textContent ?? '',
      frozen: document.querySelector('canvas.is-frozen') !== null,
      exportNote: card?.querySelector('.export-note')?.textContent ?? '',
      exportHeld: [...(card?.querySelectorAll('.export-acts button') ?? [])].map((b) => b.disabled),
    }
  })
  console.log(`${label}: ${JSON.stringify(said)}`)
}

/** The map canvas's box, for gestures over it. */
async function plot() {
  return page.evaluate(() => {
    const r = document.querySelector('canvas.heatmap-canvas').getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })
}

await page.goto(`${g.base}/#uri=${encodeURIComponent(URI)}&view=contigs`)
await page.waitForFunction(() => document.body.textContent.includes('59.83 Mb'), null, { timeout: 180000 })
// The open's own reads, and the census and circularity check behind it.
await sleep(4000)

// chr1: the preview, moved while its block reads.
const t0 = Date.now()
let reports = await toPreview('1')
console.log(`chr1 preview on screen at ${((Date.now() - t0) / 1000).toFixed(2)} s`)
await state('preview')
await shot('pv01-preview-live')
const box = await plot()
// A third of the way along the chromosome, on the diagonal: wheel in, then drag.
const on = { x: box.x + box.width * 0.36, y: box.y + box.height * 0.36 }
await page.mouse.move(on.x, on.y)
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -240)
  await sleep(60)
}
await sleep(250)
await state('preview zoomed')
await shot('pv02-preview-zoomed')
await g.drag(on, { x: on.x - 90, y: on.y - 90 }, 8)
await state('preview dragged')
await shot('pv03-preview-dragged')
const moved = Date.now()
await toBlock(reports)
console.log(`chr1 block in at ${((Date.now() - t0) / 1000).toFixed(2)} s, ${((Date.now() - moved) / 1000).toFixed(2)} s after the last gesture`)
await state('block landed')
await shot('pv04-block-landed-in-place')

// chr2, left alone: the block lands fitted.
reports = await toPreview('2')
await state('chr2 preview')
await shot('pv05-preview-unmoved')
await toBlock(reports)
await state('chr2 block')
await shot('pv06-block-landed-fitted')

await g.close()
