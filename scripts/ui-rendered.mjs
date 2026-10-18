/**
 * The page's report of a finished picture (§12, `perf/rendered.ts`): each step
 * waits for the `chromosomix:rendered` the app makes, takes its screenshot the
 * moment it arrives, and prints what it said — so every picture here is one
 * the app called finished, and a lane still reading or a map still veiled in
 * any of them is the report being wrong.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-rendered.mjs [out-dir]     # rd01 … rd09
 *
 * The steps: the landing page; the yeast demo with its seven tracks; its whole
 * chromosome IV, wider than the map and still read at 1 kb; the whole genome,
 * which waits for its button; a sequence the file has not got; the yeast deck
 * of two maps; the 1D browser; a workspace naming the yeast `.hic` at 4 kb,
 * dropped, and then the file and a bigWig dropped on the page it asks for them
 * on; and the lab's chicken `.hic` with a bigWig from its bucket, at 25 kb.
 * Where the page needs a proxy to reach the bucket, HTTPS_PROXY is handed to
 * Chromium.
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
function playwright() {
  try {
    return require('playwright')
  } catch {
    return require(join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
}

const OUT = process.argv[2] ?? 'gallery'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const YEAST = join(ROOT, 'demo', 'yeast')
const BUCKET = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/chicken'
mkdirSync(OUT, { recursive: true })

const { chromium } = playwright()
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const proxy = process.env.HTTPS_PROXY
const browser = await chromium.launch({
  ...(browsers !== undefined && existsSync(join(browsers, 'chromium')) ? { executablePath: join(browsers, 'chromium') } : {}),
  args: [
    '--no-sandbox',
    ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=127.0.0.1;localhost'] : []),
  ],
})

/**
 * A fresh window whose every report is kept here rather than in the page, so a
 * reload — the dev server's own, the first time it bundles a dependency — loses
 * none of them.
 */
async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const reports = []
  await context.exposeBinding('__rendered', (_source, report) => reports.push(report))
  await context.addInitScript(() => {
    window.addEventListener('chromosomix:rendered', (event) => window.__rendered(event.detail))
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.log(`  page error: ${error}`))
  page.reports = reports
  return page
}

const seen = (page) => page.reports.length

/**
 * The first report after `after` reports that `wanted` accepts, with how long
 * after `from` (the page's clock) its picture was finished.
 */
async function reported(page, after, wanted = () => true, timeout = 180_000) {
  const started = Date.now()
  for (;;) {
    const reports = page.reports
    const hit = reports.slice(after).find(wanted)
    if (hit !== undefined) return hit
    if (Date.now() - started > timeout) throw new Error(`no report in ${timeout / 1000} s; had ${JSON.stringify(reports.slice(after))}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const rows = []
let n = 0
async function step(page, name, report, since) {
  n += 1
  const file = `rd${String(n).padStart(2, '0')}-${name}`
  await page.screenshot({ path: join(OUT, `${file}.png`) })
  const maps = report.maps.map((map) => `${map.title} @ ${map.resolution} bp${map.binsPerCell > 1 ? ` (${map.binsize} × ${map.binsPerCell})` : ''}`)
  rows.push({ file, seq: report.seq, status: report.status, ms: since === undefined ? '' : Math.round(report.at - since), maps: maps.join('; '), lanes: report.lanes, note: report.note ?? '' })
  console.log(`wrote ${file}.png: #${report.seq} ${report.status}${report.note ? ` (${report.note})` : ''} · ${maps.join('; ') || 'no map'} · ${report.lanes} lanes`)
}

/** Where the page's clock stands, to time a picture from. */
const now = (page) => page.evaluate(() => performance.now())

/** Drop files on the landing page, as a reader drags them there (`ui-csp.mjs`'s way). */
async function drop(page, paths) {
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    input.id = 'ui-rendered-files'
    document.body.append(input)
  })
  await page.setInputFiles('#ui-rendered-files', paths)
  return page.evaluate(() => {
    const input = document.getElementById('ui-rendered-files')
    const transfer = new DataTransfer()
    for (const file of input.files) transfer.items.add(file)
    // The one on screen: the page asking for a file has a picker of its own.
    const zone = [...document.querySelectorAll('.dropzone')].find((one) => one.offsetParent !== null) ?? document.querySelector('.dropzone')
    const from = performance.now()
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    input.remove()
    return from
  })
}

const region = (report) => report.status !== 'drawn' || /view=region/.test(report.state)

try {
  // The landing page: the first report the page makes, from its navigation start.
  let page = await fresh()
  await page.goto(BASE)
  await step(page, 'landing', await reported(page, 0), 0)

  // The yeast demo and its seven tracks, from the link.
  page = await fresh()
  await page.goto(`${BASE}/?config=${encodeURIComponent(`${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)}`)
  const demo = await reported(page, 0, (report) => report.maps.length > 0)
  await step(page, 'yeast-demo', demo, 0)

  // The whole of chromosome IV at 1 kb is wider than the map, and still read at 1 kb.
  let before = await seen(page)
  let from = await now(page)
  await page.evaluate(() => {
    const state = new URLSearchParams(location.hash.slice(1))
    state.set('region', 'IV')
    state.delete('focus')
    location.hash = state.toString()
  })
  await step(page, 'yeast-chromosome', await reported(page, before, region), from)

  // The whole genome, which a file this size either draws or gates.
  before = await seen(page)
  from = await now(page)
  await page.evaluate(() => {
    const state = new URLSearchParams(location.hash.slice(1))
    location.hash = `uri=${encodeURIComponent(state.get('uri'))}&view=whole`
  })
  await step(page, 'yeast-whole', await reported(page, before, (report) => /view=whole/.test(report.state)), from)

  // A sequence this file has not got.
  before = await seen(page)
  from = await now(page)
  await page.evaluate(() => {
    const state = new URLSearchParams(location.hash.slice(1))
    location.hash = `uri=${encodeURIComponent(state.get('uri'))}&view=region&region=XVII`
  })
  await step(page, 'yeast-refused', await reported(page, before, (report) => report.status === 'error'), from)

  // A deck of two maps: one report, when both are drawn.
  page = await fresh()
  await page.goto(`${BASE}/?config=${encodeURIComponent(`${BASE}/demo/yeast/Yeast_deck.chromosomix.json`)}`)
  await step(page, 'yeast-deck', await reported(page, 0, (report) => report.maps.length > 1), 0)

  // The 1D browser and its tracks.
  page = await fresh()
  await page.goto(`${BASE}/?config=${encodeURIComponent(`${BASE}/demo/yeast/Yeast_tracks.chromosomix.json`)}`)
  await step(page, 'yeast-browser', await reported(page, 0, (report) => report.lanes > 0 && /view=browser/.test(report.state)), 0)

  // From disk: a workspace naming the yeast `.hic` at 4 kb, which asks for the
  // file; then the file and a bigWig, dropped on the page that asks.
  page = await fresh()
  await page.goto(BASE)
  await reported(page, 0)
  const workspace = join(OUT, 'yeast-hic-4kb.chromosomix.json')
  writeFileSync(
    workspace,
    JSON.stringify({
      kind: 'chromosomix.workspace',
      version: 1,
      active: 0,
      tabs: [{ version: 1, state: { uri: 'Yeast_hic.hic::/resolutions/4000', view: 'region', region: 'IV:1000000-1400000', transform: 'log10' }, tracks: [] }],
    }),
  )
  before = await seen(page)
  await drop(page, [workspace])
  await reported(page, before)
  before = await seen(page)
  from = await drop(page, [join(YEAST, 'Yeast_hic.hic'), join(YEAST, 'Yeast_ATAC.bw')])
  await step(page, 'yeast-hic-dropped', await reported(page, before, (report) => report.maps.length > 0 && report.lanes > 0), from)

  // The chicken `.hic` from the bucket at 25 kb, with its insulation, named in a link.
  page = await fresh()
  await page.goto(BASE)
  await reported(page, 0)
  before = await seen(page)
  from = await now(page)
  const session = {
    kind: 'chromosomix.workspace',
    version: 1,
    active: 0,
    tabs: [
      {
        version: 1,
        state: { uri: `${BUCKET}/G2_4DNFIRKUYKP4.hic::/resolutions/25000`, view: 'region', region: '1:20000000-30000000', balance: false, transform: 'log10' },
        tracks: [
          {
            id: 'g2-insulation',
            card: 'linear',
            kind: 'track',
            label: 'G2 insulation',
            source: { kind: 'remote', name: 'G2_4DNFI1PRBI5L_diamond.bw', url: `${BUCKET}/G2_4DNFI1PRBI5L_diamond.bw` },
            visible: true,
            placement: { bottom: true, right: true },
            style: { colour: '#d55e00', size: 72, mode: 'area', limits: { auto: true, min: 0, max: 1 }, group: '', shape: 'element', radius: 7, opacity: 1, flip: false },
          },
        ],
      },
    ],
  }
  await page.evaluate((text) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], 'chicken.chromosomix.json', { type: 'application/json' }))
    const zone = document.querySelector('.dropzone')
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  }, JSON.stringify(session))
  await step(page, 'chicken-hic-remote', await reported(page, before, (report) => report.maps.length > 0 && report.lanes > 0), from)
} finally {
  console.log('\nfile                          seq  status  ms      maps                                         lanes')
  for (const row of rows) {
    console.log(`${row.file.padEnd(29)} ${String(row.seq).padStart(3)}  ${row.status.padEnd(6)}  ${String(row.ms).padStart(6)}  ${row.maps.slice(0, 44).padEnd(44)} ${row.lanes}`)
  }
  await browser.close()
}
