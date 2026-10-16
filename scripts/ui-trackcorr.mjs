/**
 * Track correlation on the yeast demo (§18.8): the form, every track it offers ticked, with the
 * line beside Run saying each track is read at its own resolution a megabase at a time; then the
 * result at 100 bp windows, and again at 10 kb, where a window's value used to come from a zoom
 * level. Then the tracks demo's five bigWigs at 100 bp, where a window any of them lacks is left
 * out of every pair, as deepTools leaves it out, and the run says how many. Prints the price line
 * and each result's numbers and notes, so a run that did not happen is a line in the log.
 *
 *   node scripts/ui-trackcorr.mjs gallery     # writes gallery/tc01 … tc04
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
const errors = []
// A page of its own context: a second workspace opened in the same one is offered beside the
// first rather than opened in its place.
const fresh = async () => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: 1 })
  const one = await context.newPage()
  one.on('pageerror', (e) => errors.push(String(e)))
  one.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return one
}
let page = await fresh()
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
const run = async (label) => {
  await page.$$eval('.figure-block', (all) => all.forEach((one) => (one.dataset.before = '1')))
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page
    .waitForSelector('.figure-block:not([data-before])', { timeout: 300000 })
    .catch(() => console.log('no output for', label))
  await sleep(3000)
  const block = page.locator('.figure-block:not([data-before])').first()
  if ((await block.count()) === 0) return
  await block.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(800)
  console.log(label, '→', (await block.innerText()).replace(/\s+/g, ' ').slice(0, 260))
  for (const note of await page.locator('.analysis-notes li, .analysis-note').allInnerTexts()) {
    console.log('  note:', note.replace(/\s+/g, ' '))
  }
}
// The task's row in the Analysis panel, once it can be opened: a task waiting for its inputs
// is drawn disabled until the second track has loaded.
const openTask = async () => {
  const task = page.locator('.analysis-row-title', { hasText: /^Track correlation$/ }).first()
  for (let tries = 0; tries < 6 && !(await task.isVisible()); tries++) {
    await fold('Show the Analysis panel')
    await sleep(1500)
  }
  await page.waitForFunction(
    () => {
      const title = [...document.querySelectorAll('.analysis-row-title')].find(
        (node) => node.textContent === 'Track correlation',
      )
      const row = title?.closest('button, [role="button"], .analysis-row')
      return row !== undefined && row !== null && !row.matches(':disabled, [aria-disabled="true"]')
    },
    null,
    { timeout: 180000 },
  )
  await task.click()
  await sleep(1500)
}
const tickEvery = async () => {
  const boxes = field('tracks').locator('input[type="checkbox"]')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check()
  await sleep(800)
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
  await openTask()

  // Every track the form offers.
  await tickEvery()
  const price = page.locator('.analysis-cost, .cost-line, .estimate').first()
  if (await price.count()) console.log('price:', (await price.innerText()).replace(/\s+/g, ' '))
  await shot('tc01-form')
  await run('100 bp windows')
  await shot('tc02-result-100bp')

  await page.locator('.analysis-form').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  const window = field('window').locator('input').first()
  await window.fill('10000')
  await window.press('Enter')
  await sleep(600)
  await run('10 kb windows')
  await shot('tc03-result-10kb')

  // The tracks demo: five bigWigs, the two strands of RNA-seq among them, which have no value
  // where no read fell. A window any of the five lacks is left out of every pair.
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_tracks.chromosomix.json`)
  await sleep(5000)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await openTask()
  await tickEvery()
  await run('five tracks, 100 bp windows')
  // From the run's notes down, so the sentence saying how many windows were left out is in the
  // picture with the figure under it.
  await page.locator('.analysis-notes').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(600)
  await shot('tc04-five-tracks-100bp')
} catch (e) {
  console.log('FAILED', String(e).slice(0, 800))
  await shot('tc99-failure')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
