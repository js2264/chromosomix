/**
 * A scaled-region metaplot's abscissa (§18.8), on the yeast demo's genes under its ATAC track.
 *
 * The run at a 5 kb flank, 50 bp columns and 200 body columns — the drawer's curve, `Start` and
 * `End` at the body's edges, kilobases out from them along the flanks and per cent of the way
 * through the body between; the per-feature heatmap under it with the same landmarks; the figure
 * enlarged, where a wider plot takes finer steps; a wheel into the body, the steps finer again; the
 * pointer over the body, the crosshair and the tooltip spelling where it is the way the ticks do;
 * no flank at all, the axis Start to End; a body of ten columns between two long flanks, Start and
 * End still both named; and a reference-point run beside them, its axis in base pairs as before.
 * The curve's PNG export, the same ticks as on screen, is saved beside the shots as ms01b. Prints every tick label on each curve's
 * abscissa.
 *
 *   node scripts/ui-metaplot-scaled.mjs gallery     # writes gallery/ms01 … ms08, ms01b
 */

import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
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
// download this script waits for.
await context.addInitScript(() => {
  window.showSaveFilePicker = undefined
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
const field = (label) =>
  page
    .locator('.analysis-form .field')
    .filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) })
    .first()
/** A choice by the words of its option, or a box in a list of them ticked. */
const pick = async (label, wanted) => {
  const control = field(label)
  if ((await control.count()) === 0) return console.log('no field', label)
  const select = control.locator('select').first()
  if (await select.count()) {
    const options = await select.locator('option').evaluateAll((all) =>
      all.map((one) => ({ value: one.value, text: one.textContent ?? '' })),
    )
    const match = options.find((one) => one.text.includes(wanted) || one.value === wanted)
    if (match === undefined) return console.log('no option', wanted, 'under', label)
    await select.selectOption(match.value)
    await sleep(600)
    return
  }
  const row = control.locator('label', { hasText: wanted }).first()
  if ((await row.count()) === 0) return console.log('no box', wanted, 'under', label)
  await row.locator('input[type="checkbox"]').check()
  await sleep(500)
}
const type = async (label, value) => {
  const input = field(label).locator('input').first()
  if ((await input.count()) === 0) return console.log('no field', label)
  await input.fill(String(value))
  await input.press('Enter')
  await sleep(600)
}
/** An on/off button, pressed only while it is not already where it is wanted. */
const toggle = async (label, on) => {
  const button = field(label).locator(`button[aria-pressed="${on ? 'false' : 'true'}"]`)
  if (await button.count()) await button.first().click()
  await sleep(400)
}
const curveBlock = () =>
  page
    .locator('.figure-block:not([data-before])')
    .filter({ has: page.locator('.analysis-figure-head', { hasText: /^Metaplot/ }) })
    .first()
/** Every label along a chart's abscissa, left to right: the SVG's texts on its bottom row. */
const abscissa = async (scope) =>
  scope.evaluate((root) => {
    const svg = root.querySelector('.figure-chart svg')
    if (svg === null) return []
    const texts = [...svg.querySelectorAll('text')].map((one) => {
      const box = one.getBoundingClientRect()
      return { text: one.textContent ?? '', x: box.left + box.width / 2, y: box.top, h: box.height }
    })
    const named = texts.filter((one) => /^Position|^Distance/.test(one.text))
    if (named.length === 0) return []
    const nameY = named[0].y
    // The tick labels are the row just above the axis's name.
    const row = texts.filter((one) => one.text !== '' && one.y < nameY - 2 && one.y > nameY - 3 * named[0].h)
    return row.sort((a, b) => a.x - b.x).map((one) => one.text)
  })
/** Run, and wait for a figure that was not there before — the same headings come back twice. */
const run = async (label) => {
  await page.$$eval('.figure-block', (all) => all.forEach((one) => (one.dataset.before = '1')))
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page
    .waitForSelector('.figure-block:not([data-before]) .figure-chart svg', { timeout: 300000 })
    .catch(() => console.log('no output for', label))
  await sleep(3500)
  const block = curveBlock()
  if ((await block.count()) === 0) return console.log('no metaplot for', label)
  await block.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(900)
  console.log(label, '→ abscissa:', (await abscissa(block)).join(' | '))
  const notes = page.locator('.analysis-notes:not(.hidden)')
  if (await notes.count()) console.log('  notes:', (await notes.first().innerText()).replace(/\s+/g, ' '))
}
/** The form back at its top. */
const top = async () => {
  await page.locator('.analysis-form').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(400)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(5000)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  const task = page.locator('.analysis-row-title', { hasText: /^Metaplot over a feature set$/ }).first()
  for (let tries = 0; tries < 6 && !(await task.isVisible()); tries++) {
    await fold('Show the Analysis panel')
    await sleep(1500)
  }
  // The row is enabled once a feature set has loaded: the demo's genes are a 9.5 MB GTF.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.analysis-row-title')].some(
        (one) =>
          one.textContent === 'Metaplot over a feature set' &&
          one.closest('.analysis-row') !== null &&
          !one.closest('.analysis-row').classList.contains('is-waiting') &&
          one.closest('.analysis-row').getAttribute('aria-disabled') !== 'true',
      ),
    null,
    { timeout: 180000 },
  )
  await task.click()
  await sleep(1500)

  // ATAC, the box the form ticks first: its peaks at promoters and terminators
  // are where Start and End should be read off.
  await pick('tracks', 'ATAC')
  await pick('features', 'genes')
  await pick('mode', 'scaled')
  await type('flank', 5000)
  await type('resolution', 50)
  await type('body columns', 200)
  await toggle('per-feature heatmap', true)
  await top()
  await run('genes, scaled, 5 kb flank, 200 body columns')
  await shot('ms01-scaled-curve')

  // The PNG the curve exports: the figure's box on screen redrawn at the export's
  // resolution, so the ticks the reader sees.
  const png = page.waitForEvent('download', { timeout: 30000 })
  await curveBlock().locator('.analysis-figure-head button', { hasText: /^PNG$/ }).first().click()
  const saved = await png.catch(() => null)
  if (saved === null) console.log('no PNG download')
  else {
    await saved.saveAs(`${OUT}/ms01b-scaled-export.png`)
    console.log('shot ms01b-scaled-export (the downloaded PNG)')
  }

  const heat = page
    .locator('.figure-block:not([data-before])')
    .filter({ has: page.locator('.analysis-figure-head', { hasText: /per feature/ }) })
    .first()
  if (await heat.count()) {
    await heat.evaluate((node) => node.scrollIntoView({ block: 'end' }))
    await sleep(900)
    await shot('ms02-scaled-heatmap')
  }

  // Enlarged: the same figure at the window's width takes finer steps.
  const block = curveBlock()
  await block.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(500)
  await block.locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage .figure-chart svg', { timeout: 20000 })
  await sleep(2000)
  const stage = page.locator('.modal-stage').first()
  console.log('dialog → abscissa:', (await abscissa(stage)).join(' | '))
  await shot('ms03-scaled-dialog')

  // A wheel into the body: the window narrows and the steps follow it.
  const chart = stage.locator('.figure-chart').first()
  const box = await chart.boundingBox()
  if (box !== null) {
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -240)
      await sleep(250)
    }
    await sleep(1500)
    console.log('zoomed → abscissa:', (await abscissa(stage)).join(' | '))
    await shot('ms04-scaled-zoomed')
    await page.locator('.modal-stage button', { hasText: /^reset$/i }).first().click()
    await sleep(1500)
    // The pointer over the body: the crosshair's number and the tooltip's head.
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.45)
    await sleep(1200)
    const tip = await page.evaluate(() => {
      const one = [...document.querySelectorAll('.figure-tooltip, .echarts-tooltip, div[class*="tooltip"]')].find(
        (node) => node.offsetParent !== null,
      )
      return one === undefined ? '' : one.textContent
    })
    console.log('pointer → tooltip:', (tip ?? '').replace(/\s+/g, ' ').slice(0, 160))
    await shot('ms05-scaled-pointer')
  }
  await page.keyboard.press('Escape')
  await sleep(1000)

  // No flank at all: the axis runs Start to End.
  await top()
  await type('flank', 0)
  await top()
  await run('genes, scaled, no flank')
  await shot('ms06-scaled-no-flank')

  // Ten body columns between two 5 kb flanks: Start and End a few pixels apart.
  await top()
  await type('flank', 5000)
  await type('body columns', 10)
  await top()
  await run('genes, scaled, 10 body columns')
  await shot('ms07-scaled-thin-body')

  // A reference point, for comparison: base pairs from the anchor, as before.
  await top()
  await pick('mode', 'reference')
  await type('flank', 2000)
  await top()
  await run('genes, reference point at the start, 2 kb')
  await shot('ms08-reference-point')
} catch (e) {
  console.log('FAILED', String(e).slice(0, 800))
  await shot('ms99-failure')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
