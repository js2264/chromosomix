/**
 * An aggregate peak analysis's form and its runs (§18.2, §18.8), on the yeast demo.
 *
 * The form as it opens — observed / expected, two diagonals left out, the nearest loop at five bins,
 * a track ticked, and no Control or Ranking card, since neither applies to a loop set over
 * the expected — and the run it makes; the nearest loop at coolpuppy's own floor, with the note that
 * says how many loops that leaves out; the Control card coming back for the distance-matched
 * control; every loop piled up raw, many near enough that their windows reach the diagonal; the
 * Ranking card coming back for a feature set; the ATAC peaks on the diagonal with the first two
 * diagonals as gaps and then whole; and every track unticked, which stays unticked through a run.
 * Prints each figure's heading, its numbers and the run's notes as it goes, so a run that did not
 * happen is a line in the log.
 *
 *   node scripts/ui-apa-diagonal.mjs gallery     # writes gallery/ad01 … ad09
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
  const notes = page.locator('.analysis-notes:not(.hidden)')
  if (await notes.count()) console.log('  notes:', (await notes.first().innerText()).replace(/\s+/g, ' '))
}
const price = async () => {
  const line = page.locator('.analysis-cost, .cost-line, .estimate').first()
  if (await line.count()) console.log('price:', (await line.innerText()).replace(/\s+/g, ' '))
}
/** The form back at its top. */
const top = async () => {
  await page.locator('.analysis-form').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(400)
}
/** A field brought to the middle of the screen. */
const into = async (label) => {
  const one = field(label)
  if ((await one.count()) === 0) return console.log('no field', label)
  await one.evaluate((node) => node.scrollIntoView({ block: 'center' }))
  await sleep(600)
}
/** Each track aggregate's box, ticked or not. */
const ticks = async () =>
  field('track aggregates')
    .locator('.param-check')
    .evaluateAll((rows) => rows.map((row) => `${row.textContent}: ${row.querySelector('input')?.checked ? 'ticked' : 'unticked'}`))
/** What the defaults read, and which cards are drawn. */
const say = async () => {
  const chosen = async (label) => {
    const select = field(label).locator('select').first()
    return (await select.count()) === 0
      ? '(not shown)'
      : select.evaluate((node) => node.options[node.selectedIndex]?.textContent ?? '')
  }
  const typed = async (label) => {
    const input = field(label).locator('input').first()
    return (await input.count()) === 0 ? '(not shown)' : input.inputValue()
  }
  console.log(
    'form:',
    JSON.stringify({
      anchors: await chosen('anchors'),
      normalisation: await chosen('normalisation'),
      'diagonals left out': await typed('diagonals left out'),
      'nearest loop': await typed('nearest loop'),
      tracks: await ticks(),
    }),
  )
  const cards = await page
    .locator('.analysis-form .param-group:not(.hidden)')
    .evaluateAll((all) => all.map((one) => one.querySelector('.controls-title')?.textContent ?? '(untitled)'))
  console.log('cards:', cards.join(' | '))
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

  // The form as it opens: what each default reads, and which cards are drawn.
  await say()
  await price()
  await shot('ad01-form')
  // The Separation card, where the nearest loop is.
  await into('nearest loop')
  await shot('ad01b-nearest-loop')
  await run('loops, at the defaults')
  await shot('ad02-loops-defaults')

  // coolpuppy's own floor, twice the half-width and two: the note says what it left out.
  await top()
  await type('nearest loop', 44)
  await run('loops, nearest loop at coolpuppy’s floor')
  const said = page.locator('.analysis-notes:not(.hidden)').first()
  if (await said.count()) {
    await said.evaluate((node) => node.scrollIntoView({ block: 'center' }))
    await sleep(600)
  }
  await shot('ad03-coolpuppy-floor-note')

  // The distance-matched control brings its card back.
  await top()
  await pick('normalisation', 'distance-matched')
  await say()
  await into('controls per pair')
  await shot('ad04-form-matched')

  // Every loop, raw: the windows that reach the diagonal, and gaps cut in them.
  await top()
  await pick('normalisation', 'none')
  await type('nearest loop', 0)
  await run('loops, raw, every loop')
  await shot('ad05-loops-every-raw')

  // A feature set brings the Ranking card back; on the diagonal, two diagonals left out, then none.
  await top()
  await pick('anchors', 'feature set')
  await pick('features', 'ATAC peaks')
  await say()
  await into('rank by')
  await shot('ad06-form-features')
  await run('peaks on the diagonal, two diagonals left out')
  await shot('ad07-diagonal')
  await top()
  await type('diagonals left out', 0)
  await run('peaks on the diagonal, none left out')
  await shot('ad08-diagonal-whole')

  // Every track unticked, and a run: the list stays empty.
  await top()
  const boxes = field('track aggregates').locator('input[type=checkbox]')
  for (let i = 0; i < (await boxes.count()); i++) {
    if (await boxes.nth(i).isChecked()) await boxes.nth(i).uncheck()
  }
  await sleep(600)
  console.log('tracks before the run:', await ticks())
  await run('peaks on the diagonal, no track')
  console.log('tracks after the run:', await ticks())
  await into('track aggregates')
  await shot('ad09-tracks-unticked-after-run')
} catch (e) {
  console.log('FAILED', String(e).slice(0, 800))
  await shot('ad99-failure')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
