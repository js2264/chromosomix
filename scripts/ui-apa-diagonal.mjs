/**
 * An aggregate peak analysis where its windows meet the diagonal (§18.8), on the yeast demo.
 *
 * The form with its *diagonals left out*; the demo's loops piled up raw — many of them near
 * enough that their windows reach the diagonal, so the lower-left corner is a mean of fewer
 * loops — and over the expected, with the price line saying it reads a band per sequence; then
 * the ATAC peaks on the diagonal, where the first two diagonals are gaps, and with none left out,
 * where the window is whole. Prints each figure's heading and its numbers as it goes, so a run
 * that did not happen is a line in the log.
 *
 *   node scripts/ui-apa-diagonal.mjs gallery     # writes gallery/ad01 … ad07
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
const context = await browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: 1 })
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
/** A choice by the words of its option; a number typed in. */
const pick = async (label, wanted) => {
  const select = field(label).locator('select').first()
  if ((await select.count()) === 0) return console.log('no field', label)
  const options = await select.locator('option').evaluateAll((all) =>
    all.map((one) => ({ value: one.value, text: one.textContent ?? '' })),
  )
  const match = options.find((one) => one.text.includes(wanted) || one.value === wanted)
  if (match === undefined) return console.log('no option', wanted, 'under', label)
  await select.selectOption(match.value)
  await sleep(600)
}
const type = async (label, value) => {
  const input = field(label).locator('input').first()
  if ((await input.count()) === 0) return console.log('no field', label)
  await input.fill(String(value))
  await input.press('Enter')
  await sleep(600)
}
/** Run, and wait for a figure that was not there before — the same headings come back twice. */
const run = async (label) => {
  await page.$$eval('.figure-block', (all) => all.forEach((one) => (one.dataset.before = '1')))
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page
    .waitForSelector('.figure-block:not([data-before])', { timeout: 300000 })
    .catch(() => console.log('no output for', label))
  await sleep(3500)
  const pileup = page
    .locator('.figure-block:not([data-before])')
    .filter({ has: page.locator('.analysis-figure-head', { hasText: /^APA/ }) })
    .first()
  if ((await pileup.count()) === 0) return console.log('no pileup for', label)
  await pileup.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(900)
  console.log(label, '→', (await pileup.innerText()).replace(/\s+/g, ' ').slice(0, 220))
}
const price = async () => {
  const line = page.locator('.analysis-cost, .cost-line, .estimate').first()
  if (await line.count()) console.log('price:', (await line.innerText()).replace(/\s+/g, ' '))
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
  // The deck lays its columns out as it finishes opening, which can be after the map is drawn;
  // so the Analysis column is asked for until its rows can be seen.
  const task = page.locator('.analysis-row-title', { hasText: /^Aggregate peak analysis$/ }).first()
  for (let tries = 0; tries < 6 && !(await task.isVisible()); tries++) {
    await fold('Show the Analysis panel')
    await sleep(1500)
  }
  await task.click()
  await sleep(1500)

  // The loops, off the diagonal, raw.
  await pick('anchors', 'loop set')
  await pick('pairs', 'loops')
  await pick('normalisation', 'none')
  await shot('ad01-form')
  await run('loops, raw')
  await shot('ad02-loops-raw')

  // Over the expected: the price line first, then the run.
  await page.locator('.analysis-form').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await pick('normalisation', 'observed')
  await sleep(800)
  await price()
  await shot('ad03-form-oe')
  await run('loops, over the expected')
  await shot('ad04-loops-oe')
  const oe = page
    .locator('.figure-block:not([data-before])')
    .filter({ has: page.locator('.analysis-figure-head', { hasText: /^APA/ }) })
    .first()
  if (await oe.count()) {
    await oe.locator('.figure-enlarge').first().click()
    await page.waitForSelector('.modal-stage .figure-chart', { timeout: 20000 }).catch(() => {})
    await sleep(2000)
    await shot('ad05-loops-oe-dialog')
    await page.keyboard.press('Escape')
    await sleep(800)
  }

  // On the diagonal, at the ATAC peaks: the first two diagonals left out, then none.
  await page.locator('.analysis-form').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await pick('anchors', 'feature set')
  await pick('features', 'ATAC peaks')
  await pick('normalisation', 'none')
  await run('peaks on the diagonal, two diagonals left out')
  await shot('ad06-diagonal')
  await page.locator('.analysis-form').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await type('diagonals left out', 0)
  await run('peaks on the diagonal, none left out')
  await shot('ad07-diagonal-whole')
} catch (e) {
  console.log('FAILED', String(e).slice(0, 800))
  await shot('ad99-failure')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
