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
// No save dialog: a headless browser cancels one the moment it opens, and every
// export asks it first (`ui/export.ts`). Without it the export is the plain
// download this script waits for, which is what a browser with no dialog does.
await context.addInitScript(() => { window.showSaveFilePicker = undefined })
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
/**
 * Scroll the drawer to a figure, its head at the top.
 *
 * The task's form stands above its results in the drawer, and on most tasks it
 * is tall enough that a shot taken where the drawer opens is a shot of the form
 * with the figure's first gridline under it.
 */
const toFigure = async (block = page.locator('.figure-block').first()) => {
  if ((await block.count()) === 0) return
  await block.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(600)
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
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
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
  await toFigure()
  await shot('01-curve')

  // The slim strip: the mark, and the picture it makes.
  const strip = page.locator('.figure-strip').first()
  await strip.locator('select').first().selectOption('points')
  await sleep(1800)
  await toFigure()
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
  // An on/off button now, pressed only while it says off (`figures/settings.ts`).
  const smoothButton = smooth.locator('button[aria-pressed="false"]')
  if (await smoothButton.count()) await smoothButton.click()
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

  // And back to the task's own figure: `reset`, in the lowercase every verb
  // on a button wears (`figures/settings.ts`).
  await page.locator('.modal-stage button', { hasText: /^reset$/i }).first().click()
  await sleep(1800)
  await shot('07-curve-reset')
  await page.keyboard.press('Escape')
  await sleep(1200)
  await toFigure()
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

  // The matrix the same run produced. A heatmap now, not a raster: the cells
  // are hoverable, the colour bar clips, and the box below drags a window —
  // which is why it is found by its chart and no longer by a canvas.
  const matrix = page.locator('.figure-block').filter({ has: page.locator('.figure-chart') }).last()
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
    // ⌘-drag a box over the picture, which sets both axis windows; then a
    // double click, which puts them back where the controls last had them.
    const stage = page.locator('.modal-stage .figure-chart').first()
    const box = await stage.boundingBox()
    if (box) {
      await page.keyboard.down('Meta')
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.62, { steps: 12 })
      await page.mouse.up()
      await page.keyboard.up('Meta')
      await sleep(1800)
      await shot('17b-matrix-marquee')
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
      await sleep(1800)
      await shot('17c-matrix-home')
    }
    await page.keyboard.press('Escape')
    await sleep(1000)
  }
  await shot('18-drawer')

  // ---- the two figures that carry an aggregate --------------------------
  //
  // A pileup with a track aggregate along each edge (§18.8), and a metaplot's
  // per-feature heatmap. Neither is reachable without filling a form in, and
  // both are where a band drawn to the wrong ruler or a picture squeezed into
  // a ribbon shows up — which no assertion about the numbers can see.
  const pick = async (label, wanted) => {
    const control = page
      .locator('.analysis-form .field')
      // Case-blind: the form's labels are lowercase now (`anchors`,
      // `normalisation`), and an exact match on `Anchors` set nothing at all —
      // silently, so the APA ran with every default this script meant to change.
      .filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) })
      .first()
    if ((await control.count()) === 0) return false
    const select = control.locator('select').first()
    if (await select.count()) {
      const options = await select.locator('option').evaluateAll((all) =>
        all.map((one) => ({ value: one.value, text: one.textContent ?? '' })),
      )
      const match = options.find((one) => one.text.includes(wanted) || one.value.includes(wanted))
      if (match === undefined) return false
      await select.selectOption(match.value)
      await sleep(500)
      return true
    }
    // A `multiple` entry parameter is a list of checkboxes, not a select.
    const row = control.locator('label', { hasText: wanted }).first()
    if ((await row.count()) === 0) return false
    await row.locator('input[type="checkbox"]').check()
    await sleep(500)
    return true
  }

  /**
   * What the drawer is showing, as the list of figure titles.
   *
   * The wait after a Run is that this **changes**. Waiting for a chart to exist
   * returns immediately — the drawer still holds the last task's — and waiting
   * for the form to go away never returns at all, since the form is a slot that
   * is emptied and refilled rather than removed.
   */
  const shown = () =>
    page.$$eval('.analysis-figure-head', (all) => all.map((one) => one.textContent).join('|'))
  const ran = async (label, before) => {
    await page
      .waitForFunction(
        (was) =>
          [...document.querySelectorAll('.analysis-figure-head')]
            .map((one) => one.textContent)
            .join('|') !== was,
        before,
        { timeout: 300000 },
      )
      .catch(() => console.log('no output for', label))
    await sleep(4000)
  }

  await page.keyboard.press('Escape')
  await sleep(600)
  await page.locator('text=Aggregate peak analysis').first().click()
  await sleep(1200)
  await pick('Anchors', 'loop')
  await pick('Pairs', 'loops')
  await pick('Track aggregates', 'ATAC')
  // The raw pileup, with no shifted controls: the picture is the same figure and
  // the run is a sixth of the windows, which is the difference between a gallery
  // that finishes and one that times out.
  await pick('Normalisation', 'none')
  const controls = page
    .locator('.analysis-form .field')
    .filter({ has: page.locator('.field-label', { hasText: /^controls per pair$/i }) })
    .first()
  if (await controls.count()) {
    await controls.locator('input[type="number"], input').first().fill('0')
    await controls.locator('input[type="number"], input').first().press('Enter')
    await sleep(500)
  }
  await shot('19-apa-form')
  const beforeApa = await shown()
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await ran('APA', beforeApa)
  // **The pileup**, by name: the same run also returns a loop spectrum and a
  // table of anchors, so the last chart on the page is a scatter of scores.
  const pileup = page
    .locator('.figure-block')
    .filter({ has: page.locator('.analysis-figure-head', { hasText: /APA/ }) })
    .first()
  if (await pileup.count()) {
    await pileup.scrollIntoViewIfNeeded()
    await sleep(800)
  }
  await shot('20-apa-margins')
  if (await pileup.count()) {
    await pileup.locator('.figure-enlarge').first().click()
    await page.waitForSelector('.modal-stage .figure-chart svg', { timeout: 20000 })
    await sleep(2000)
    await shot('21-apa-dialog')
    await page.keyboard.press('Escape')
    await sleep(1000)
  }

  await page.keyboard.press('Escape')
  await sleep(600)
  await page.locator('text=Metaplot over a feature set').first().click()
  await sleep(1200)
  await pick('Features', 'ATAC peaks')
  await pick('Tracks', 'ATAC')
  // An on/off button, like every switch in a task's form (`ui/ParamForm.ts`),
  // pressed only while it says off.
  const heatmap = page
    .locator('.analysis-form .field')
    .filter({ has: page.locator('.field-label', { hasText: /heatmap/i }) })
    .first()
    .locator('button[aria-pressed="false"]')
  if (await heatmap.count()) await heatmap.click()
  await sleep(500)
  await shot('22-metaplot-form')
  const beforeMeta = await shown()
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await ran('metaplot', beforeMeta)
  await toFigure()
  await shot('23-metaplot')
  const heat = page
    .locator('.figure-block')
    .filter({ has: page.locator('.analysis-figure-head', { hasText: /per feature/ }) })
    .first()
  if (await heat.count()) {
    await heat.scrollIntoViewIfNeeded()
    await sleep(800)
    await shot('24-metaplot-heatmap')
    await heat.locator('.figure-enlarge').first().click()
    await page.waitForSelector('.modal-stage', { timeout: 20000 })
    await sleep(2000)
    await shot('25-metaplot-heatmap-dialog')
    await page.keyboard.press('Escape')
    await sleep(800)
  }
} catch (e) {
  console.log('FAILED', String(e).slice(0, 800))
  await shot('99-failure')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
