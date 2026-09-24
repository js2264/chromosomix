/**
 * Drive a deck's headings, reads and card in headless Chromium, and write what
 * each looks like (§5.4, §16.3, §16.5, §16.9).
 *
 * Three things a gallery of arrivals cannot show, because each is about what
 * happens *between* two pictures:
 *
 * - the view's heading while the reader zooms: its shape is decided by its
 *   width alone, so the height of the heading and the width of every side
 *   column must come out of three zooms exactly as they went in;
 * - a companion with its chain open reading the window a box drawn on it
 *   frames, for itself, at its own resolution — rather than magnifying the
 *   block it already held — and giving it back;
 * - the Contact maps card listing every map, a row of it dragged onto an
 *   empty cell opening that map there, and a companion's eye closing its cell
 *   and opening it again.
 *
 * It prints each measurement to stdout as well as shooting it, so a heading
 * that grew or a column that narrowed is a line in the log.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-deck-reads.mjs [out-dir]
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
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}

/** The heading's height, the side columns' widths, and the summary line. */
const layout = () =>
  page.evaluate(() => {
    const head = document.querySelector('.deck-lead-head .view-head, .view-head')
    return {
      head: Math.round(head?.getBoundingClientRect().height ?? 0),
      columns: Array.from(document.querySelectorAll('.panel-column:not(.collapsed)')).map((n) =>
        Math.round(n.getBoundingClientRect().width),
      ),
      title: document.querySelector('.region-title')?.textContent ?? '',
      summary: (document.querySelector('.view-head > .match-kind, .view-head > .summary')?.textContent ?? '').slice(0, 90),
    }
  })

/** What the companion's heading says it is reading. */
const companion = () =>
  page.evaluate(() => {
    const cell = document.querySelector('.deck-grid > .deck-panel:not(.is-lead)')
    const name = cell?.querySelector('input.deck-name')
    return {
      read: name?.getAttribute('title') ?? '',
      pill: cell?.querySelector('.deck-place:not(.hidden) .deck-place-label')?.textContent ?? '',
    }
  })

/** Draw a box with the Option key held, from one fraction of a map to another. */
const box = async (selector, from, to) => {
  const target = await page.locator(selector).first().boundingBox()
  if (target === null) throw new Error(`no ${selector}`)
  const at = (f) => [target.x + target.width * f[0], target.y + target.height * f[1]]
  const [x0, y0] = at(from)
  const [x1, y1] = at(to)
  await page.mouse.move(x0, y0)
  await page.keyboard.down('Alt')
  await page.keyboard.down('Shift')
  await page.mouse.down()
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 })
  await page.mouse.move(x1, y1, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await page.keyboard.up('Alt')
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await sleep(4000)
  // Every column open, so the centre is as narrow as a laptop makes it.
  await fold('Show the Annotations panel')
  await fold('Show the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(1500)
  const before = await layout()
  console.log('before zooming:', JSON.stringify(before))
  await shot('h1-heading-columns-open')

  // Three zooms, each a different window with a different summary line.
  for (const title of ['Narrow the range 3×', 'Narrow the range 3×', 'Widen the range 10×']) {
    const button = page.locator(`.view-head .btn-zoom[title^="${title}"]`).first()
    if (await button.count()) {
      await button.click()
      await sleep(3500)
    }
    console.log(`after "${title}":`, JSON.stringify(await layout()))
  }
  const after = await layout()
  console.log(
    'heading kept its height:', after.head === before.head,
    '· columns kept their widths:', JSON.stringify(after.columns) === JSON.stringify(before.columns),
  )
  await shot('h2-heading-after-zooms')

  // The Analysis column folded: a wider centre, and the heading on one line.
  await fold('Fold the Analysis panel')
  await sleep(1500)
  console.log('analysis folded:', JSON.stringify(await layout()))
  await shot('h3-heading-wider')

  // A companion off the deck, a box drawn on it: it reads that window itself.
  await fold('Fold the Annotations panel')
  await fold('Fold the Aesthetics panel')
  await sleep(1200)
  await page.locator('.deck-grid > .deck-panel:not(.is-lead) .deck-lock').first().click()
  await sleep(800)
  console.log('companion unhooked, reading:', JSON.stringify(await companion()))
  const leadTitle = (await layout()).title
  await box('.deck-grid > .deck-panel:not(.is-lead) .heatmap-canvas', [0.3, 0.3], [0.45, 0.45])
  await sleep(5000)
  const own = await companion()
  console.log('after a box on it:', JSON.stringify(own), '· first map still on', (await layout()).title, '(was', leadTitle + ')')
  await shot('w1-companion-own-window')
  await page.locator('.deck-place-widen').first().click()
  await sleep(4000)
  console.log('widened 3×:', JSON.stringify(await companion()))
  await shot('w2-companion-widened')
  await page.locator('.deck-place-clear').first().click()
  await sleep(4000)
  console.log('given back:', JSON.stringify(await companion()))

  // The Contact maps card: every map, each with a grip; the first map's row
  // dropped on an empty cell opens it there.
  await fold('Show the Annotations panel')
  await sleep(800)
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.compare-card .compare-row')).map((row) => {
      const name = row.querySelector('.ann-name')
      return { name: name instanceof HTMLInputElement ? name.value : (name?.textContent ?? ''), grip: row.querySelector('.compare-grip') !== null }
    }),
  )
  console.log('contact maps card rows:', JSON.stringify(rows))
  await page.locator('.deck-grow.is-beside').first().click()
  await sleep(1500)
  await page.evaluate(() => {
    const zone = document.querySelector('.deck-vacant')
    if (zone === null) throw new Error('no empty cell')
    const transfer = new DataTransfer()
    transfer.setData('application/x-metacooler-map', JSON.stringify({ kind: 'lead' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 3, null, { timeout: 120000 }).catch(() => {})
  await sleep(4000)
  const after3 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.compare-card .compare-row .ann-name')).map((n) => (n instanceof HTMLInputElement ? n.value : n.textContent)),
  )
  console.log('card rows after dropping the first map on an empty cell:', JSON.stringify(after3))
  await shot('c1-card-every-map')

  // The eye on a companion's row: its cell closes and the row stays, dimmed;
  // pressed again, the map opens in a cell once more.
  const cardState = () =>
    page.evaluate(() => ({
      cells: document.querySelectorAll('.deck-grid .heatmap-canvas').length,
      rows: Array.from(document.querySelectorAll('.compare-card .compare-deck-row')).map((row) => {
        const name = row.querySelector('.ann-name')
        return {
          name: name instanceof HTMLInputElement ? name.value : (name?.textContent ?? ''),
          eye: row.querySelector('.ann-eye')?.getAttribute('aria-pressed') ?? '',
          parked: row.classList.contains('is-parked'),
        }
      }),
    }))
  await page.locator('.compare-card .compare-deck-row .ann-eye').first().click()
  await sleep(2500)
  console.log('companion hidden by its eye:', JSON.stringify(await cardState()))
  await shot('c2-card-map-hidden')
  await page.locator('.compare-card .compare-deck-row.is-parked .ann-eye').first().click()
  await page.waitForFunction((n) => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= n, 3, { timeout: 60000 }).catch(() => {})
  await sleep(4000)
  console.log('shown again by its eye:', JSON.stringify(await cardState()))
  await shot('c3-card-map-shown')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
