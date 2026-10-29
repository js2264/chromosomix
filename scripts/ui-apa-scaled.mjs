/**
 * An aggregate peak analysis on the diagonal, scaled, over the expected (§18.2, §18.8), on the yeast
 * demo's genes.
 *
 * The form in the fixed mode, *anchor on* the row below *mode*; scaled, the row gone and the grid and
 * flank in its place, observed / expected no longer refused; its run, every window stretched evenly
 * and the grid's diagonal left as gaps where the two diagonals left out reach, the axis one straight
 * line from −0.5 to 1.5; the same pairs scaled over the expected still refused, with the reason; and
 * the distance-matched control, pinned as before, for the picture beside it. Prints the form's rows in
 * order, each figure's heading and numbers, the price and the notes.
 *
 *   node scripts/ui-apa-scaled.mjs gallery     # writes gallery/as01 … as05
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

/** The form's rows, in order, as a reader sees them. */
const rows = async () =>
  page
    .locator('.analysis-form .field:visible .field-label')
    .evaluateAll((all) => all.map((one) => one.textContent?.trim() ?? ''))
const refusal = async () => {
  const line = page.locator('.analysis-refusal, .refusal, .estimate-refusal').first()
  return (await line.count()) && (await line.isVisible()) ? (await line.innerText()).replace(/\s+/g, ' ') : '(none)'
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
  const task = page.locator('.analysis-row-title', { hasText: /^Aggregate peak analysis$/ }).first()
  for (let tries = 0; tries < 6 && !(await task.isVisible()); tries++) {
    await fold('Show the Analysis panel')
    await sleep(1500)
  }
  // The row is enabled once a feature set has loaded: the demo's genes are a 9.5 MB GTF.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.analysis-row-title')].some(
        (one) => one.textContent === 'Aggregate peak analysis' && !one.closest('button')?.disabled,
      ),
    null,
    { timeout: 180000 },
  )
  await task.click()
  await sleep(1500)

  // A feature set in the fixed mode: anchor on is the row below mode.
  await pick('anchors', 'feature set')
  await pick('features', 'genes')
  await pick('mode', 'fixed')
  await top()
  console.log('fixed, rows:', (await rows()).join(' / '))
  await shot('as01-fixed-anchor-on-below-mode')

  // Scaled: anchor on goes, the grid and flank come; observed / expected is taken.
  await pick('mode', 'scaled')
  await pick('normalisation', 'observed / expected')
  await top()
  console.log('scaled, rows:', (await rows()).join(' / '))
  console.log('refusal:', await refusal())
  await price()
  await shot('as02-scaled-oe-form')

  await run('genes, scaled, over the expected')
  await shot('as03-scaled-oe-run')

  // Pairs scaled over the expected: still refused, and the form says why.
  await top()
  await pick('anchors', 'consecutive')
  await top()
  console.log('consecutive, scaled, O/E, refusal:', await refusal())
  const said = page.getByText(/feature set on the diagonal/).first()
  if (await said.count()) {
    await said.evaluate((node) => node.scrollIntoView({ block: 'center' }))
    await sleep(600)
  }
  await shot('as04-scaled-pairs-oe-refused')

  // The distance-matched control on the same genes: pinned, as before.
  await top()
  await pick('anchors', 'feature set')
  await pick('features', 'genes')
  await pick('normalisation', 'distance-matched')
  await run('genes, scaled, distance-matched')
  await shot('as05-scaled-matched-run')
} catch (e) {
  console.log('FAILED', String(e).slice(0, 800))
  await shot('as99-failure')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
