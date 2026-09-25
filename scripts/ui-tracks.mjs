/**
 * Drive the Tracks card and the lanes in headless Chromium and write what each
 * state looks like (§5.8, §8.1, §8.6, §8.8, §8.15, §18.5).
 *
 * The parts a gallery of arrivals passes by: the Annotations column's order and
 * its two folded cards, two tracks ticked and set together from the batch box —
 * the `points` style among the settings it carries — a task's synthetic track
 * as a row of the Tracks card with its `*` and its exports, the crosshair turned
 * off and on over a lane, the pointer over the map drawn beside it (a
 * screenshot has no cursor in it), a typed locus with no ring round the map, the
 * 1D browser drawing points, a map opened on a throttled line drawing before its
 * tracks with their room kept, and a circle framed on `ori` rather than slid
 * round. Prints what it found at each step, so a card that did not change is a
 * line in the log as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-tracks.mjs [out-dir]
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
const CONFIG = `${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`
const COOL = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page = null
async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const next = await context.newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const shotOf = async (selector, name) => {
  const node = page.locator(selector).first()
  await node.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const mapDrawn = () =>
  page.waitForFunction(
    () => document.querySelector('.heatmap-canvas') !== null && document.querySelector('.panel-overlay')?.classList.contains('hidden'),
    null,
    { timeout: 180000 },
  )
const allReady = (n) =>
  page.waitForFunction((n) => document.querySelectorAll('.annotation-card .ann-row.ann-ready').length >= n, n, { timeout: 180000 })
const rowNames = () => page.$$eval('.annotation-card .ann-row .ann-name', (nodes) => nodes.map((n) => n.value))
const tick = async (label) => {
  const names = await rowNames()
  const at = names.indexOf(label)
  if (at < 0) throw new Error(`no row called ${label}`)
  await (await page.$$('.annotation-card .ann-tick'))[at].click()
  await sleep(400)
}
const batchField = (label) =>
  page.locator('.ann-batch .field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) }).first()
const headings = () =>
  page.$$eval('.panel-column .card-head', (heads) =>
    heads.filter((h) => h.offsetParent !== null).map((h) => `${h.textContent.trim()}${h.parentElement.classList.contains('is-folded') ? ' (folded)' : ''}`),
  )

try {
  // -------------------------------------------------------------------------
  // The yeast session: the column, the batch box, points, a synthetic track.
  // -------------------------------------------------------------------------
  page = await fresh()
  await page.goto(CONFIG)
  await mapDrawn()
  await allReady(7)
  await sleep(1500)
  await fold('Show the Annotations panel')
  await sleep(800)
  console.log('columns:', JSON.stringify(await headings()))
  await page.evaluate(() => {
    const column = document.querySelector('.bookmarks-card, .annotation-card')?.closest('.panel-column-body')
    column?.scrollTo({ top: column.scrollHeight })
  })
  await sleep(400)
  await shot('tr01-annotations-column-foot')
  await page.evaluate(() => document.querySelector('.annotation-card')?.closest('.panel-column-body')?.scrollTo({ top: 0 }))

  await tick('ATAC')
  await tick('Pol II / input')
  await page.locator('.ann-batch').first().scrollIntoViewIfNeeded()
  await sleep(300)
  await shotOf('.annotation-card', 'tr02-batch-box')

  // Points for both, on their own ranges: the picture first, then one pair of
  // limits for the two, which the box then shows as theirs.
  await batchField('style').locator('select').selectOption('points')
  await sleep(300)
  await page.mouse.move(5, 5)
  await sleep(1200)
  await shot('tr03-points-beside-the-map')
  const [low, high] = await page.$$('.ann-batch .ann-limits input')
  await low.fill('0')
  await high.fill('15')
  await high.press('Enter')
  await sleep(1500)
  console.log('after the batch:', JSON.stringify(await page.$$eval('.ann-batch .clip-note', (n) => n.map((x) => x.textContent))))
  await shotOf('.annotation-card', 'tr04-batch-set')

  // A synthetic track: diamond insulation, run from the Analysis panel.
  await page.locator('.ann-batch button', { hasText: /^clear$/ }).first().click()
  await sleep(300)
  await fold('Show the Analysis panel')
  await page.locator('text=Diamond insulation').first().click()
  await sleep(800)
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.ann-row.is-synthetic').length > 0, null, { timeout: 120000 })
  await sleep(1500)
  console.log('drawer says:', await page.evaluate(() => document.querySelector('.analysis-elsewhere')?.textContent ?? ''))
  await shot('tr05-task-ran')
  await page.keyboard.press('Escape')
  await sleep(600)
  await fold('Fold the Analysis panel')
  const synthetic = page.locator('.ann-row.is-synthetic').first()
  await synthetic.scrollIntoViewIfNeeded()
  await synthetic.locator('.ann-more').click()
  await sleep(600)
  await page.locator('.ann-row.is-synthetic').first().scrollIntoViewIfNeeded()
  await shotOf('.ann-row.is-synthetic', 'tr06-synthetic-row')
  await shot('tr07-synthetic-beside-the-map')

  // The crosshair over a lane: off, then on.
  const lane = await page.locator('.lane-canvas:not(.hidden)').first().boundingBox()
  const map = await page.locator('.heatmap-canvas').first().boundingBox()
  await page.keyboard.press('x')
  await sleep(400)
  // Over the middle of the Pol II lane, clear of any lane's border, whose
  // resize rule would be drawn there as well.
  await page.mouse.move(lane.x + lane.width * 0.72, lane.y + lane.height * 0.4)
  await sleep(600)
  console.log('crosshair off, lane guided:', await page.evaluate(() => document.querySelector('.lane-canvas:not(.hidden)')?.classList.contains('is-guided')))
  await page.screenshot({ path: `${OUT}/tr08-crosshair-off-over-a-lane.png`, clip: { x: map.x - 40, y: map.y - 10, width: map.width + 380, height: map.height + 260 } })
  await page.keyboard.press('x')
  await sleep(400)
  await page.mouse.move(lane.x + lane.width * 0.72 + 1, lane.y + lane.height * 0.4)
  await sleep(600)
  console.log('crosshair on, lane guided:', await page.evaluate(() => document.querySelector('.lane-canvas:not(.hidden)')?.classList.contains('is-guided')))
  await page.screenshot({ path: `${OUT}/tr09-crosshair-on-over-a-lane.png`, clip: { x: map.x - 40, y: map.y - 10, width: map.width + 380, height: map.height + 260 } })

  // The pointer over the map. A screenshot carries no cursor, so the one the
  // stylesheet gives the guided map is drawn where the hand is, at its own
  // size and again at four times it.
  const px = map.x + map.width * 0.52
  const py = map.y + map.height * 0.52
  await page.mouse.move(px, py)
  await sleep(600)
  await page.evaluate(({ px, py, inset }) => {
    const canvas = document.querySelector('.heatmap-canvas')
    const cursor = getComputedStyle(canvas).cursor
    const url = /url\("?(.*?)"?\)/.exec(cursor)?.[1] ?? ''
    for (const [scale, left, top] of [[1, px - 20, py - 20], [4, inset.x, inset.y]]) {
      const img = document.createElement('img')
      img.src = url
      img.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${40 * scale}px;height:${40 * scale}px;z-index:99999;pointer-events:none;${scale > 1 ? 'background:rgba(255,255,255,.35);outline:1px dashed #888;' : ''}`
      img.className = 'gallery-cursor'
      document.body.append(img)
    }
    console.log('cursor', cursor.slice(0, 60))
  }, { px, py, inset: { x: map.x + 16, y: map.y + map.height - 176 } })
  await sleep(400)
  await page.screenshot({ path: `${OUT}/tr10-pointer-over-the-map.png`, clip: { x: map.x - 10, y: map.y - 10, width: map.width + 20, height: map.height + 20 } })
  await page.evaluate(() => { for (const img of document.querySelectorAll('.gallery-cursor')) img.remove() })

  // A typed locus and Enter: the map takes the focus, and draws no ring.
  const box = page.locator('input.search, .search-box input').first()
  await box.click()
  await box.fill('IV:1,150,000-1,250,000')
  await box.press('Enter')
  await mapDrawn()
  await sleep(2500)
  console.log('focused after Enter:', await page.evaluate(() => document.activeElement?.className ?? ''))
  await shot('tr11-typed-locus-no-ring')

  // The 1D browser over the same tracks — `V` puts the map away — points and all.
  await page.mouse.move(5, 5)
  await page.keyboard.press('v')
  await page.waitForSelector('.browser-canvas', { timeout: 60000 })
  await sleep(5000)
  await page.mouse.move(5, 5)
  await shot('tr12-browser-points')

  // -------------------------------------------------------------------------
  // The same session on a throttled line: the map first, its tracks' room kept.
  // -------------------------------------------------------------------------
  page = await fresh()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 25, downloadThroughput: 3 * 1024 * 1024, uploadThroughput: 3 * 1024 * 1024 })
  const t0 = Date.now()
  await page.goto(CONFIG)
  await mapDrawn()
  await sleep(300)
  const drawnAt = (Date.now() - t0) / 1000
  const beforeBox = await page.locator('.heatmap-canvas').first().boundingBox()
  const reading = await page.$$eval('.annotation-card .ann-row.ann-loading', (rows) => rows.length)
  console.log(`throttled: map drawn at ${drawnAt.toFixed(1)} s with ${reading} tracks still reading, box ${JSON.stringify(beforeBox)}`)
  await shot('tr13-map-first-tracks-reading')
  await allReady(7)
  await sleep(1500)
  const afterBox = await page.locator('.heatmap-canvas').first().boundingBox()
  console.log(`throttled: every track in at ${((Date.now() - t0) / 1000).toFixed(1)} s, box ${JSON.stringify(afterBox)}`)
  await shot('tr14-map-first-tracks-in')

  // -------------------------------------------------------------------------
  // A circle: framed on ori, zoomed on the join; a pan stops at the frame.
  // -------------------------------------------------------------------------
  page = await fresh()
  await page.goto(`${BASE}/#uri=${encodeURIComponent(COOL)}&view=region&region=I`)
  await mapDrawn()
  await sleep(1500)
  await page.locator('.crumb', { hasText: 'Chromosomes' }).first().click()
  await sleep(2000)
  await page.locator('input.tcheck[title^="Read I as a circle"]').first().click()
  await sleep(500)
  await page.goBack()
  await mapDrawn()
  await sleep(1500)
  const word = (text) => page.locator('button').filter({ has: page.locator(`.btn-word-text:text-is("${text}")`) }).first()
  const window = () => page.evaluate(() => (document.body.innerText.match(/effective resolution[^\n]*/) ?? [''])[0])
  const circle = await page.locator('.heatmap-canvas').first().boundingBox()
  await page.mouse.move(circle.x + circle.width * 0.9, circle.y + circle.height * 0.9)
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -300); await sleep(150) }
  await sleep(800)
  for (let k = 0; k < 8; k++) {
    const cx = circle.x + circle.width / 2
    const cy = circle.y + circle.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx - 300, cy - 300, { steps: 10 })
    await page.mouse.up()
    await sleep(900)
  }
  console.log('a pan past the end of the circle:', await window())
  await shot('tr15-circle-pan-stops-at-the-end')
  await word('ori').click()
  await mapDrawn()
  await sleep(1500)
  console.log('ori:', await window())
  await shot('tr16-circle-ori')
  const framed = await page.locator('.heatmap-canvas').first().boundingBox()
  await page.mouse.move(framed.x + framed.width / 2, framed.y + framed.height / 2)
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -300); await sleep(150) }
  await sleep(1500)
  await page.mouse.move(5, 5)
  console.log('zoomed on the join:', await window())
  await shot('tr17-circle-join')
} catch (err) {
  console.error('FAILED', err)
  if (page !== null) await page.screenshot({ path: `${OUT}/tr-failed.png` }).catch(() => {})
}

console.log('errors:', errors.length === 0 ? 'none' : errors.slice(0, 10))
await browser.close()
