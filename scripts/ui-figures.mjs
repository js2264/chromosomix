/**
 * Drive the analysis drawer and photograph every kind of figure.
 *
 * `ui-gallery.mjs` drives the map, the deck and the 3D cell; this drives the
 * one part of the app that `ui-gallery` only passes through — the figures a
 * task returns (§18.13) — because that is where a squashed plot, a legend over
 * the data or a dialog that opens on the wrong control shows up, and none of
 * those is something a test can see.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-figures.mjs [out-dir]
 *
 * Two tasks cover all three shapes on the yeast demo: *Contact probability
 * P(s)* is a curve, and *Cis and trans per sequence* returns both a table and a
 * matrix.
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

const OUT = process.argv[2] ?? 'gallery-figures'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium'))
    ? join(browsers, 'chromium')
    : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({
  viewport: { width: 1920, height: 1100 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
/** Run the named task and wait for a figure to land. */
const run = async (title, wait) => {
  // The result drawer floats over the task list, so it is closed first or the
  // row cannot be pressed.
  await page.keyboard.press('Escape')
  await sleep(600)
  await page.locator(`text=${title}`).first().click()
  await sleep(900)
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(wait, null, { timeout: 120000 }).catch(() => console.log('no output for', title))
  await sleep(2500)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(2500)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(800)

  // ---- a curve -----------------------------------------------------------
  await run('Contact probability P(s)', () => document.querySelector('.figure-chart svg') !== null)
  await shot('01-curve')

  // The slim strip: the mark, and the picture it makes.
  const strip = page.locator('.figure-strip').first()
  await strip.locator('select').first().selectOption('points')
  await sleep(1800)
  await shot('02-curve-points')
  await strip.locator('select').first().selectOption('line')
  await sleep(1500)

  // The dialog: the figure at the size of the window, every control beside it.
  await page.locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage .figure-chart svg', { timeout: 20000 })
  await sleep(2000)
  await shot('03-curve-dialog')

  // A few of the controls, so the pictures show what they do.
  const field = (label) =>
    page
      .locator('.modal-stage .field')
      .filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) })
      .first()
  await field('mark').locator('select').selectOption('area')
  await sleep(1500)
  const smooth = page.locator('.modal-stage .figure-check', { hasText: 'smooth' }).first()
  if (await smooth.count()) await smooth.locator('input').check()
  await sleep(1500)
  await shot('04-curve-area-smooth')

  await field('legend').locator('select').selectOption('bottom')
  await field('title').locator('input').fill('Contact probability, yeast Micro-C')
  await field('title').locator('input').press('Enter')
  await sleep(1800)
  await shot('05-curve-title-legend')

  // A series hidden and one recoloured, from the series card.
  const rows = page.locator('.modal-stage .figure-series-row')
  if ((await rows.count()) > 1) {
    await rows.nth(1).locator('button').click()
    await sleep(1500)
  }
  await shot('06-curve-series')

  // And back to the task's own figure.
  await page.locator('.modal-stage button', { hasText: /^Reset$/ }).first().click()
  await sleep(1800)
  await shot('07-curve-reset')
  await page.keyboard.press('Escape')
  await sleep(1200)
  await shot('08-curve-back-in-drawer')

  // The two marks that summarise a sample rather than plot it.
  await page.locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage .figure-chart svg', { timeout: 20000 })
  await sleep(1200)
  await field('mark').locator('select').selectOption('box')
  await sleep(2000)
  await shot('08b-curve-box')
  await field('mark').locator('select').selectOption('violin')
  await sleep(2500)
  await shot('08c-curve-violin')
  await field('mark').locator('select').selectOption('line')
  await sleep(1500)
  await page.keyboard.press('Escape')
  await sleep(1000)

  // The export, end to end: the PDF a reader presses for has to be a drawing.
  const pdf = page.waitForEvent('download', { timeout: 30000 })
  await page.locator('.analysis-figure-head button', { hasText: 'PDF' }).first().click()
  const file = await (await pdf).path()
  const bytes = readFileSync(file)
  const text = bytes.toString('latin1')
  console.log(
    'pdf:',
    `${(bytes.length / 1024).toFixed(0)} kB`,
    text.startsWith('%PDF') ? 'header ok' : 'NOT A PDF',
    text.includes('/Subtype /Image') ? 'CARRIES A RASTER' : 'no raster',
    text.includes('/Helvetica') ? 'has type' : 'NO FONT',
  )

  // ---- a table and a matrix ---------------------------------------------
  await run('Cis and trans per sequence', () => document.querySelector('.analysis-figure-scroll table') !== null)
  await shot('09-table')

  const filter = page.locator('.figure-strip input[type="search"]').first()
  if (await filter.count()) {
    await filter.fill('I')
    await filter.press('Enter')
    await sleep(900)
    await shot('10-table-filtered')
    await filter.fill('')
    await filter.press('Enter')
    await sleep(600)
  }

  // A column head sorts.
  const head = page.locator('.figure-th').nth(1)
  if (await head.count()) {
    await head.click()
    await sleep(700)
    await shot('11-table-sorted')
  }

  // The table's own dialog, and one column drawn as a distribution.
  const tableBlock = page.locator('.figure-block').filter({ has: page.locator('.analysis-figure-scroll') }).first()
  await tableBlock.locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage .figure-settings', { timeout: 20000 })
  await sleep(1200)
  await shot('12-table-dialog')
  const plot = page
    .locator('.modal-stage .field')
    .filter({ has: page.locator('.field-label', { hasText: /^plot$/ }) })
    .first()
  if (await plot.count()) {
    const values = await plot.locator('option').evaluateAll((o) => o.map((x) => x.value))
    const column = values.find((v) => v !== 'table')
    if (column) {
      await plot.locator('select').selectOption(column)
      await sleep(2000)
      await shot('13-table-as-histogram')
      const against = page
        .locator('.modal-stage .field')
        .filter({ has: page.locator('.field-label', { hasText: /^against$/ }) })
        .first()
      if (await against.count()) {
        const others = await against.locator('option').evaluateAll((o) => o.map((x) => x.value))
        const second = others.find((v) => v !== '—' && v !== column)
        if (second) {
          await against.locator('select').selectOption(second)
          await sleep(2000)
          await shot('14-table-as-scatter')
        }
      }
    }
  }
  await page.keyboard.press('Escape')
  await sleep(1000)

  // The matrix the same run produced: the old rasteriser, the new dialog.
  const matrix = page.locator('.figure-block').filter({ has: page.locator('canvas') }).first()
  if (await matrix.count()) {
    await matrix.scrollIntoViewIfNeeded()
    await sleep(600)
    await shot('15-matrix')
    await matrix.locator('.figure-enlarge').first().click()
    await page.waitForSelector('.modal-stage .figure-settings', { timeout: 20000 })
    await sleep(1500)
    await shot('16-matrix-dialog')
    const map = page
      .locator('.modal-stage .field')
      .filter({ has: page.locator('.field-label', { hasText: /^colormap$/ }) })
      .first()
    if (await map.count()) {
      await map.locator('select').selectOption('viridis')
      await sleep(1500)
      await shot('17-matrix-colormap')
    }
    await page.keyboard.press('Escape')
    await sleep(1000)
  }
  await shot('18-drawer')
} catch (e) {
  console.log('FAILED', String(e).slice(0, 800))
  await shot('99-failure')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
