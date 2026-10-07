/**
 * Drive the deck's first cell as a cell like the others, and a structure file
 * dropped on an empty window, in headless Chromium (§16.9, §25.3).
 *
 * Three things no other gallery passes through:
 *
 * - a lone bed3d dropped on the landing page, which must open as its model —
 *   alone, filling the view, the empty 1D browser it names hidden behind it —
 *   and the deck's bar putting the browser back, its grip moving it, its ×
 *   hiding it again;
 * - the yeast deck's first map moved by its grip to the other cell, hidden by
 *   the × on its heading — the other map then following the locus box alone,
 *   the star on it, the first map's row on the Contact maps card dimmed with
 *   its eye dark — and put back by that eye where it stood;
 * - a workspace whose first map stands second, opened from its address — the
 *   road a published figure and a `?config=` link take, which resolves the
 *   workspace's names on the way in and used to lose the first map's place.
 *
 * It prints the grid's order, the hash and the card's eyes at each step, so a
 * cell that did not move, or a lead that came back in the wrong place, is a
 * line in the log as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-deck-lead.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
function playwright() {
  try {
    return require('playwright')
  } catch {
    const root = execSync('npm root -g').toString().trim()
    return require(join(root, 'playwright'))
  }
}
const { chromium } = playwright()

const OUT = process.argv[2] ?? 'gallery'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const fresh = async () => {
  const next = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
let page = await fresh()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const shotOf = async (selector, name, pad = 6) => {
  const box = await page.locator(selector).first().boundingBox()
  if (box === null) { console.log('nothing to shoot for', name); return }
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad } })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}

/** The grid as a reader sees it, in reading order; a hidden lead in brackets. */
const grid = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.deck-grid > .deck-panel')).map((cell) => {
      const name = cell.querySelector('.deck-name')
      const text = (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim()
      const kind = cell.classList.contains('deck-structure') ? '3d' : cell.classList.contains('deck-tracks') ? 'tracks' : 'map'
      const label = `${cell.classList.contains('is-lead') ? 'lead ' : ''}${kind} ${text}`
      return cell.classList.contains('is-parked') ? `[${label}, hidden]` : label
    }),
  )
const bar = () => page.evaluate(() => Array.from(document.querySelectorAll('.deck-bar .btn')).map((b) => b.textContent?.trim()).filter(Boolean))
const hash = () => page.evaluate(() => decodeURIComponent(location.hash).replace(/https?:\/\/[^/|&]+/g, ''))
const leadGrip = () => page.locator('.deck-panel.is-lead .deck-head-lead .deck-grip')

try {
  // -------------------------------------------------------------------------
  // A lone bed3d on the landing page: the model, alone.
  // -------------------------------------------------------------------------
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120000 })
  await page.waitForSelector('.dropzone')
  await page.evaluate(async () => {
    // The demo's model written out as a bed3d — the same beads with their ends
    // — which is the file a reader drops (`g3dtools` writes one; so does this
    // app's own Structures card).
    const bytes = await (await fetch('/demo/yeast/Yeast_structure.g3d.gz')).arrayBuffer()
    const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    const bed3d = text
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => {
        const [chrom, start, x, y, z] = line.split(/\s+/)
        return [chrom, start, String(Number(start) + 5000), x, y, z].join('\t')
      })
      .join('\n')
    const transfer = new DataTransfer()
    transfer.items.add(new File([bed3d], 'Yeast_structure.bed3d'))
    const zone = document.querySelector('.dropzone')
    for (const kind of ['dragenter', 'dragover', 'drop']) zone?.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await page.waitForSelector('.deck-structure canvas', { timeout: 120000 })
  await sleep(5000)
  console.log('lone bed3d:', JSON.stringify(await grid()), '· bar:', JSON.stringify(await bar()), '· hash:', await hash())
  await shot('l1-lone-structure')

  await page.getByRole('button', { name: 'show the 1D browser' }).click()
  await sleep(2500)
  console.log('browser shown:', JSON.stringify(await grid()))
  await shot('l2-browser-beside-the-model')
  await shotOf('.deck-panel.is-lead .deck-head-lead', 'l3-first-cell-heading')

  await leadGrip().dragTo(page.locator('.deck-grid > .deck-structure').first())
  await sleep(2500)
  console.log('browser moved by its grip:', JSON.stringify(await grid()))
  await shot('l4-browser-moved')

  await page.locator('.deck-panel.is-lead .deck-head-lead .btn-close').click()
  await sleep(2000)
  console.log('browser hidden by its ×:', JSON.stringify(await grid()), '· bar:', JSON.stringify(await bar()))

  // -------------------------------------------------------------------------
  // The yeast deck: the first map moved, hidden, and put back by its eye.
  // -------------------------------------------------------------------------
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await sleep(5000)
  await fold('Show the Annotations panel')
  await sleep(1500)
  const eyes = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.compare-card .compare-row')).map((row) => {
        const name = row.querySelector('.ann-name')
        const eye = row.querySelector('.ann-eye')
        return `${name instanceof HTMLInputElement ? name.value : name?.textContent} eye=${eye?.getAttribute('aria-pressed')}${row.classList.contains('is-parked') ? ' dimmed' : ''}`
      }),
    )
  const star = () =>
    page.evaluate(() => {
      const on = document.querySelector('.deck-grid .deck-star.is-on')
      const cell = on?.closest('.deck-panel')
      const name = cell?.querySelector('.deck-name')
      return name instanceof HTMLInputElement ? name.value : (name?.textContent ?? 'none on screen')
    })
  console.log('deck:', JSON.stringify(await grid()), '· card:', JSON.stringify(await eyes()))
  await shot('m1-deck-first-cell-has-a-grip')

  await leadGrip().dragTo(page.locator('.deck-grid > .deck-panel:not(.is-lead)').first())
  await sleep(3000)
  console.log('first map moved:', JSON.stringify(await grid()), '· hash:', await hash())
  await shot('m2-first-map-moved')

  await page.locator('.deck-panel.is-lead .deck-head-lead .btn-close').click()
  await sleep(3000)
  console.log('first map hidden:', JSON.stringify(await grid()), '· star on:', await star(), '· card:', JSON.stringify(await eyes()), '· bar:', JSON.stringify(await bar()))
  await shot('m3-first-map-hidden')

  // The locus box above the grid still steers the deck: the map on screen
  // follows the hidden one.
  const locus = page.locator('.deck-lead-head input.search, .deck-lead-head .search-box input').first()
  await locus.click()
  await locus.fill('IV:1,150,000-1,350,000')
  await locus.press('Enter')
  await sleep(6000)
  const title = await page.evaluate(() => document.querySelector('.region-title')?.textContent ?? '')
  console.log('locus typed with the first map hidden — heading now:', title)
  await shot('m4-hidden-first-map-still-steers')

  await page.locator('.compare-card .compare-row:not(.compare-deck-row) .ann-eye').first().click()
  await sleep(4000)
  console.log('first map shown by its eye:', JSON.stringify(await grid()), '· card:', JSON.stringify(await eyes()))
  await shot('m5-first-map-back-where-it-stood')

  // -------------------------------------------------------------------------
  // The same deck saved with its first map second, opened from its address.
  // -------------------------------------------------------------------------
  // Served by the route rather than written to disk, beside the files it names
  // so its relative names resolve as a published workspace's do (§21.1).
  const placed = JSON.parse(readFileSync('demo/yeast/Yeast_deck.metacooler.json', 'utf8'))
  placed.tabs[0].deck = { ...placed.tabs[0].deck, lead: { at: 1, hidden: false } }
  page = await fresh()
  // Matched on the path: a glob would match the page's own address too, which
  // carries this URL in its query string.
  await page.route(
    (url) => url.pathname === '/demo/yeast/Yeast_deck_placed.metacooler.json',
    (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(placed) }),
  )
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck_placed.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await sleep(5000)
  console.log('workspace opened from its address, first map saved second:', JSON.stringify(await grid()))
  await shot('m6-workspace-first-map-second')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
