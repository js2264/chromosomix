/**
 * A track's location, the way its lanes grow, Space, and the File card, in
 * headless Chromium (§8.1, §8.9, §7.2, §16.5, §16.9).
 *
 * On the micro-C demo, one map:
 *
 * - the ATAC row's settings, with `location` as four marks beside its label;
 * - ATAC moved to the left of the map by those marks — growing *away* from it;
 * - the map panned off its diagonal, and Space putting it back.
 *
 * On the yeast deck, two maps:
 *
 * - the same settings with a line per map, its name and its four marks;
 * - the General column's File card before and after the star moves to Hi-C;
 * - a row of the Tracks card dragged — a real drag — onto the `+` below, and
 *   onto an empty cell: each opens the 1D browser of that track;
 * - a row of the Structures card dragged onto the `+` beside.
 *
 * It prints what each step left behind: which marks are lit, which file the
 * card describes, where the view is, what the grid holds.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-track-location.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
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
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const rowOf = (id) => page.locator(`.annotation-card .ann-row[data-id="${id}"]`)
/** Open a track row's settings, and bring it into view. */
const openRow = async (id) => {
  const row = rowOf(id)
  await row.scrollIntoViewIfNeeded()
  if ((await row.locator('.ann-field-places').count()) === 0) await row.locator('.ann-more').click()
  await sleep(600)
  await row.scrollIntoViewIfNeeded()
  return row
}
/** Which marks are lit on each line of a row's location, as `name: top right …`. */
const lit = (id) =>
  page.evaluate((id) => {
    const field = document.querySelector(`.annotation-card .ann-row[data-id="${id}"] .ann-field-places`)
    if (field === null) return 'no location field'
    const lines = field.querySelectorAll('.ann-place-map')
    const read = (host) =>
      Array.from(host.querySelectorAll('.ann-place'))
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.dataset.edge)
        .join(' ')
    if (lines.length === 0) return read(field) || 'nowhere'
    return Array.from(lines).map((line) => `${line.querySelector('.ann-place-name')?.textContent}: ${read(line) || 'nowhere'}`)
  }, id)
const fileCard = () =>
  page.evaluate(() => {
    const host = document.querySelector('.file-host')
    const line = host?.querySelector('.file-card-for')?.textContent ?? '(no line)'
    const rows = Array.from(host?.querySelectorAll('.kv .k') ?? []).map((k) => [k.textContent, k.nextElementSibling?.textContent])
    const pick = Object.fromEntries(rows.filter(([k]) => ['uri', 'layout', 'bin size', 'format'].includes(k)))
    return { line, ...pick }
  })
const grid = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.deck-grid > .deck-panel')).map((cell) => {
      const name = cell.querySelector('.deck-name')
      const text = (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim()
      const kind = cell.classList.contains('deck-structure')
        ? '3d'
        : cell.classList.contains('deck-tracks')
          ? 'tracks'
          : cell.classList.contains('is-vacant')
            ? 'empty'
            : 'map'
      return `${kind} ${text}`.trim()
    }),
  )
const region = () => page.evaluate(() => document.querySelector('.region-title')?.textContent ?? '')

try {
  // -------------------------------------------------------------------------
  // One map.
  // -------------------------------------------------------------------------
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.lane-canvas:not(.hidden)').length > 0, null, { timeout: 120000 })
  await sleep(6000)
  await fold('Show the Annotations panel')
  const atac = await openRow('demo-atac')
  console.log('ATAC on one map:', JSON.stringify(await lit('demo-atac')))
  await atac.locator('.ann-field-places').screenshot({ path: `${OUT}/tl1-location-one-map.png` })
  console.log('shot tl1-location-one-map')
  await atac.screenshot({ path: `${OUT}/tl2-atac-settings-one-map.png` })
  console.log('shot tl2-atac-settings-one-map')

  // To the left of the map, and off its bottom.
  await atac.locator('.ann-field-places [data-edge="left"]').click()
  await sleep(500)
  await atac.locator('.ann-field-places [data-edge="bottom"]').click()
  await sleep(500)
  console.log('ATAC moved by the marks:', JSON.stringify(await lit('demo-atac')))
  await atac.locator('.ann-field-places').screenshot({ path: `${OUT}/tl3-location-left.png` })
  console.log('shot tl3-location-left')
  await fold('Fold the Annotations panel')
  await sleep(3000)
  const map = await page.locator('.heatmap-canvas').first().boundingBox()
  const left = await page.locator('.lane-canvas.lane-left:not(.hidden)').first().boundingBox()
  if (left !== null) {
    await page.screenshot({
      path: `${OUT}/tl4-atac-left-grows-away.png`,
      clip: { x: Math.max(0, left.x - 20), y: map.y - 20, width: map.x + map.width * 0.45 - left.x + 20, height: map.height * 0.6 },
    })
    console.log('shot tl4-atac-left-grows-away')
  }

  // Space: off the diagonal by a drag, and back by the key. Zoomed in first,
  // since a map fitted to its block has nowhere to be panned to.
  const [cx, cy] = [map.x + map.width * 0.5, map.y + map.height * 0.5]
  await page.mouse.move(cx, cy)
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -240); await sleep(300) }
  await sleep(2500)
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) { await page.mouse.move(cx - i * 16, cy); await sleep(20) }
  await page.mouse.up()
  await sleep(3000)
  console.log('panned off the diagonal:', await region())
  await shotOf('.heatmap-canvas', 'tl5-panned-off-the-diagonal', 30)
  await page.keyboard.press('Space')
  await sleep(3000)
  console.log('after Space:', await region())
  await shotOf('.heatmap-canvas', 'tl6-space-put-it-back', 30)
  const hint = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('title') ?? '').startsWith('Lock the view on the diagonal'))
    return button?.getAttribute('title')?.slice(0, 40) ?? 'no button'
  })
  console.log('the button says:', hint)
  // Let go again: the lock is the browser's, and the deck below is read free.
  await page.keyboard.press('Space')
  await sleep(500)

  // -------------------------------------------------------------------------
  // The deck.
  // -------------------------------------------------------------------------
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.chromosomix.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await sleep(6000)
  await fold('Show the Annotations panel')
  const deckAtac = await openRow('demo-atac')
  console.log('ATAC in the deck:', JSON.stringify(await lit('demo-atac')))
  await deckAtac.locator('.ann-field-places').screenshot({ path: `${OUT}/tl7-location-in-a-deck.png` })
  console.log('shot tl7-location-in-a-deck')
  await deckAtac.screenshot({ path: `${OUT}/tl8-atac-settings-in-a-deck.png` })
  console.log('shot tl8-atac-settings-in-a-deck')
  // …and on Hi-C's left, from its own line.
  await deckAtac.locator('.ann-place-map').nth(1).locator('[data-edge="left"]').click()
  await sleep(2500)
  console.log('ATAC also on the left of Hi-C:', JSON.stringify(await lit('demo-atac')))
  await fold('Fold the Annotations panel')
  await sleep(2500)
  await shot('tl9-atac-left-of-hic')

  // The File card, and the star.
  console.log('File card, first map starred:', JSON.stringify(await fileCard()))
  await shotOf('.file-host', 'tl10-file-card-first-map')
  await page.locator('.deck-grid > .deck-panel').nth(1).locator('.deck-star').click()
  await sleep(4000)
  console.log('File card, Hi-C starred:', JSON.stringify(await fileCard()))
  await shotOf('.file-host', 'tl11-file-card-hic-starred')
  await page.locator('.deck-grid > .deck-panel').nth(1).locator('.deck-star').click()
  await sleep(1500)
  console.log('File card, no star:', JSON.stringify(await fileCard()))

  // A Tracks card row, dragged for real, onto the `+` below.
  await fold('Show the Annotations panel')
  const grip = rowOf('demo-genes').locator('.ann-grip')
  await grip.scrollIntoViewIfNeeded()
  await grip.dragTo(page.locator('.deck-grow.is-below'))
  await sleep(4000)
  console.log('genes row dropped on the + below:', JSON.stringify(await grid()))
  await fold('Fold the Annotations panel')
  await sleep(1500)
  // The new row is under the maps: brought up so the track in it is seen.
  await page.locator('.deck-grid > .deck-tracks').first().evaluate((node) => node.scrollIntoView({ block: 'end' }))
  await sleep(2500)
  await shot('tl12-track-row-on-the-plus')

  // …and onto an empty cell of the row that press opened.
  await page.evaluate(() => document.querySelector('.deck-grid')?.scrollIntoView({ block: 'start' }))
  await sleep(800)
  await fold('Show the Annotations panel')
  const atacGrip = rowOf('demo-atac').locator('.ann-grip')
  await atacGrip.scrollIntoViewIfNeeded()
  // Aimed at the top of the cell, which is on screen; its middle may not be.
  await atacGrip.dragTo(page.locator('.deck-grid > .is-vacant .deck-vacant').first(), { targetPosition: { x: 60, y: 40 } })
  await sleep(4000)
  console.log('ATAC row dropped on an empty cell:', JSON.stringify(await grid()))
  await fold('Fold the Annotations panel')
  await sleep(1500)
  await page.locator('.deck-grid > .deck-tracks').last().evaluate((node) => node.scrollIntoView({ block: 'end' }))
  await sleep(2500)
  await shot('tl13-track-row-on-an-empty-cell')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
