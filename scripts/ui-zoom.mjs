/**
 * A map read at the screen's size and sharpened as the reader zooms (§2), and the
 * resolution row that says so (§5.5): chicken chr1 opened at 10 kb, its first
 * picture 785 cells of the 250 kb rung, the row's slider greyed on that rung; a
 * continuous wheel zoom, caught mid-gesture with the block in hand magnified and
 * the spinner turning in the top right corner — nothing frozen; the same zoom
 * landed on the finest rung the file stores, past the 10 kb it was opened at; a
 * drag along the diagonal that reads ahead of its edge; a wide view, and its
 * figure saved as it is on screen; a slot named under the pointer; *Refine on
 * zoom* unticked, the resolution on screen kept as the pick; a finer rung picked
 * on the wide view, drawn coarser with the line saying so; the zoom in
 * that draws it; and the colour range's auto, measured on that view.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-zoom.mjs [out-dir]     # zm01 … zm11, each with a -row close-up
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

// At twice the pixels, as a reader's screen draws it: the row is small type.
const g = await gallery(OUT, { width: 1600, height: 1000, scale: 2 })
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

/** What the line under the heading says, the Export card's, and the resolution row. */
async function lines(label) {
  const said = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.controls-card')].find(
      (node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Export',
    )
    return {
      map: document.querySelector('.view-span')?.parentElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      export: card?.querySelector('.export-note')?.textContent ?? '',
      box: document.querySelector('select.res-pick')?.selectedOptions?.[0]?.textContent ?? '',
      refining: document.querySelector('.crumb-res')?.classList.contains('is-refining') ?? null,
      spinner: document.querySelector('.map-wait:not([hidden])') !== null,
    }
  })
  console.log(`${label}: ${JSON.stringify(said)}`)
}

/** The page, and a close-up of the far end of the crumb bar: the resolution row. */
async function shots(name) {
  await shot(name)
  const bar = await page.evaluate(() => {
    const r = document.querySelector('.crumb-res')?.getBoundingClientRect()
    return r === undefined ? null : { x: r.left, y: r.top, width: r.width, height: r.height }
  })
  if (bar === null) return
  const pad = 10
  await shot(`${name}-row`, {
    clip: {
      x: Math.max(0, bar.x - pad),
      y: Math.max(0, bar.y - pad),
      width: bar.width + 2 * pad,
      height: bar.height + 2 * pad + 26,
    },
  })
}

/**
 * Wheel in at the pointer, a notch at a time, until `done` holds or `most`
 * notches are spent — and the first time the spinner is up between two notches,
 * the picture of it (`spun`).
 */
async function zoomUntil(done, { most = 40, spun = null, out = false } = {}) {
  let shotSpinner = spun === null
  for (let notch = 0; notch < most; notch++) {
    if (await page.evaluate(done)) return true
    await page.mouse.wheel(0, out ? 240 : -200)
    await sleep(170)
    if (!shotSpinner && (await page.evaluate(() => document.querySelector('.map-wait:not([hidden])') !== null))) {
      shotSpinner = true
      await lines('spinner up')
      await shots(spun)
    }
    if (notch % 4 === 3) await sleep(1500)
  }
  await sleep(2500)
  return page.evaluate(done)
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
await shots('zm01-first-picture-250kb')

const box = await page.evaluate(() => {
  const r = document.querySelector('canvas.heatmap-canvas').getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
})
const on = { x: box.x + box.w * 0.42, y: box.y + box.h * 0.42 }
await page.mouse.move(on.x, on.y)
// One notch on a slow line, so the read is still out when the picture is
// taken: the map already magnified and taking the gesture, the spinner in the
// top right corner, left of the key.
const cdp = await page.context().newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 2500, downloadThroughput: -1, uploadThroughput: -1 })
// Notch by notch until a read is due — a block within the read-ahead factor of
// what the screen wants is left alone — and its spinner is up.
console.log('spinner up:', await zoomUntil(() => document.querySelector('.map-wait:not([hidden])') !== null, { most: 12 }))
await lines('mid-zoom, slow line')
await shots('zm02-mid-zoom-spinner')
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
await sleep(3000)

// A steady wheel down to the finest rung the file stores, past the 10 kb it was
// opened at.
console.log('reached 1 kb:', await zoomUntil(() => document.querySelector('select.res-pick')?.selectedOptions?.[0]?.textContent === '1 kb', { most: 60 }))
await sleep(2500)
await lines('zoom landed')
await shots('zm03-zoom-landed-finest')

// A drag along the diagonal, a little at a time.
for (let i = 0; i < 3; i++) {
  await g.drag(on, { x: on.x - 120, y: on.y - 120 }, 10)
}
await sleep(2500)
await lines('after a drag')
await shots('zm04-dragged')

// Back out to a wide view, and save its figure: the picture on screen, as it is.
console.log(
  'wide again:',
  await zoomUntil(
    () => /^(100|250|500) kb$|Mb$/.test(document.querySelector('select.res-pick')?.selectedOptions?.[0]?.textContent ?? ''),
    { most: 40, out: true },
  ),
)
await sleep(2500)
await lines('zoomed back out')
await shots('zm05-zoomed-out')
/** The map's own Export card's line. */
const exportNote = () =>
  [...document.querySelectorAll('.controls-card')]
    .find((node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Export')
    ?.querySelector('.export-note')?.textContent ?? ''
const drawnBefore = await page.evaluate(() => window.__reports.length)
await page.evaluate(() => {
  const card = [...document.querySelectorAll('.controls-card')].find(
    (node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Export',
  )
  card?.querySelector('.export-acts button')?.click()
})
await page.waitForFunction(`/\\.pdf · /.test((${exportNote.toString()})())`, null, { timeout: 60000 })
await sleep(600)
await lines('saved')
console.log(
  'saved:',
  await page.evaluate(() => window.__saved),
  '· maps drawn while saving:',
  await page.evaluate((n) => window.__reports.slice(n).filter((r) => r.maps?.length > 0).length, drawnBefore),
)
await shots('zm06-figure-saved-as-on-screen')

// A slot of the greyed slider, named under the pointer.
const slots = await page.$$('.res-slot')
await slots[Math.floor(slots.length / 2)].hover()
await sleep(300)
console.log('tip:', await page.evaluate(() => document.querySelector('.res-tip')?.textContent))
await shots('zm07-slot-named')
await page.mouse.move(on.x, on.y)

// *Refine on zoom* unticked: the resolution on screen is kept as the pick.
await page.click('.crumb-res .res-refine input')
await sleep(4000)
await lines('unticked')
await shots('zm08-unticked-pick-kept')

// The finest rung picked on the wide view, at 1 kb: drawn coarser,
// and the line says so.
await page.click('.res-slot[aria-label="1 kb"]')
await sleep(8000)
await lines('picked finer')
await shots('zm09-picked-too-fine')

// Zoom in until the window fits it: the pick is what is drawn.
await page.mouse.move(on.x, on.y)
console.log(
  'fits the pick:',
  await zoomUntil(() => !(document.querySelector('.view-span')?.parentElement?.textContent ?? '').includes('too fine'), { most: 40 }),
)
await sleep(6000)
await lines('zoomed to the pick')
await shots('zm10-zoomed-to-pick')

// The colour range's auto, pressed: measured on the view.
await page.click('.clip-auto')
await sleep(1200)
await lines('auto pressed')
await shots('zm11-auto-on-the-view')

await g.close()
