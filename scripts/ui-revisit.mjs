/**
 * A place visited again, drawn from memory (§2, §12): on the lab's mouse
 * progenitors map at 10 kb, chr1, chr2, chr1 again, a window of chr1 and chr1
 * again — and the same walk on a chicken `.hic` — each step timed from the hash
 * to the picture on screen and its requests counted, with the status bar's
 * *read* panel opened on a revisit, where the last view must say it cost
 * nothing. The table it prints is the one §12 quotes.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-revisit.mjs [out-dir]     # rv01 … rv11
 *
 * GALLERY_DATA names a folder served with byte ranges and CORS holding
 * `progenitors.mcool` and `G2_4DNFIRKUYKP4.hic` — 689 MB and 940 MB, the first
 * reads a few dozen of it. Both were on the lab's bucket and are no longer, so
 * there is no default: §12's table was measured on these two.
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const DATA = process.env.GALLERY_DATA
if (DATA === undefined) {
  console.error(
    'progenitors.mcool and G2_4DNFIRKUYKP4.hic are no longer on the lab’s bucket: serve a folder holding them ' +
      'with byte ranges and CORS and name its address in GALLERY_DATA',
  )
  process.exit(1)
}
const MAPS = [
  {
    uri: `${DATA}/progenitors.mcool::/resolutions/10000`,
    // A row of the Chromosomes table, to know the open has landed.
    landed: 'chr19',
    walk: ['chr1', 'chr2', 'chr1', 'chr1:27050000-93100000', 'chr1'],
  },
  {
    uri: `${DATA}/G2_4DNFIRKUYKP4.hic::/resolutions/10000`,
    landed: '59.83 Mb',
    walk: ['1', '2', '1', '1:27050000-93100000', '1'],
  },
]

const g = await gallery(OUT, { width: 1600, height: 1000 })
const { page, shot } = g
const host = new URL(DATA).host
let requests = 0
page.context().on('requestfinished', (request) => {
  if (new URL(request.url()).host === host) requests++
})

/** Go to a region and wait until its picture is on screen; the time it took. */
function visit(uri, region) {
  return page.evaluate(
    ({ hash }) =>
      new Promise((resolve, reject) => {
        const before = document.querySelector('.region-title')
        const t0 = performance.now()
        location.hash = hash
        const tick = () => {
          const title = document.querySelector('.region-title')
          const overlays = [...document.querySelectorAll('.panel-overlay')]
          const busy = overlays.some((overlay) => !overlay.classList.contains('hidden'))
          if (title !== null && title !== before && overlays.length > 0 && !busy) {
            // Two frames more, so the paint the block asked for is in.
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)))
          } else if (performance.now() - t0 > 180000) reject(new Error(`no picture of ${hash}`))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    { hash: `uri=${encodeURIComponent(uri)}&view=region&region=${encodeURIComponent(region)}` },
  )
}

const rows = []
let n = 0
for (const map of MAPS) {
  await page.goto(`${g.base}/#uri=${encodeURIComponent(map.uri)}&view=contigs`)
  await page.waitForFunction((text) => document.body.textContent.includes(text), map.landed, { timeout: 180000 })
  // The open's own reads, and the census and circularity check behind it.
  await sleep(4000)
  const seen = new Set()
  for (const region of map.walk) {
    const before = requests
    const ms = await visit(map.uri, region)
    // The trailing reads a view makes once it is up, counted with it.
    await sleep(1500)
    const again = seen.has(region)
    seen.add(region)
    // The status bar's own figure, so what the kept answers cost is in the table.
    const memory = await page.evaluate(
      () =>
        [...document.querySelectorAll('.status-item')]
          .find((item) => item.querySelector('.status-key')?.textContent?.toLowerCase() === 'memory')
          ?.querySelector('.status-value')?.textContent ?? '',
    )
    rows.push({ map: map.uri.split('::')[0].split('/').pop(), region, again, ms: Math.round(ms), requests: requests - before, memory })
    n++
    const label = `${region.replace(/[^A-Za-z0-9]+/g, '-')}${again ? '-again' : ''}`
    await shot(`rv${String(n).padStart(2, '0')}-${label}`)
    if (again && region === map.walk[0] && !rows.some((row) => row.panel === true)) {
      // The read panel, which opens on hover and must say the revisit cost
      // nothing — the worker counts only what it is asked.
      await page.hover('[aria-describedby="status-read-pop"]')
      await sleep(600)
      const said = await g.text('#status-read-pop')
      console.log(`read panel on a revisit: ${said}`)
      rows[rows.length - 1].panel = true
      n++
      await shot(`rv${String(n).padStart(2, '0')}-read-panel`)
      await page.mouse.move(5, 5)
    }
  }
}

console.log('\nmap                    region                          ms  requests  memory')
for (const row of rows) {
  console.log(
    `${row.map.padEnd(22)} ${`${row.region}${row.again ? ' (again)' : ''}`.padEnd(28)} ${String(row.ms).padStart(6)}  ${String(row.requests).padStart(8)}  ${row.memory}`,
  )
}
await g.close()
