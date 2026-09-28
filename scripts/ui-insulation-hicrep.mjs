/**
 * Diamond insulation and Reproducibility on the yeast deck, in headless Chromium
 * (§18.1, §18.8). First the Analysis column as the deck opens, with
 * *Reproducibility* ready — it stood greyed there, asking for the second map
 * beside the first, until another task had run — and then that task **first**,
 * on the fresh deck, since a run made after insulation's would find the other
 * map whether or not a first one could. Each form as the reader meets it —
 * HiCRep's furthest separation, and insulation's *Boundaries* section holding
 * the coverage the calls are read over — and what each run returns: HiCRep's
 * coefficient matrix, its table per sequence and its correlation by separation
 * between the cooler and the `.hic` beside it, and the insulation lane with its
 * boundaries and domains on the map. Prints each run's notes and HiCRep's
 * per-sequence rows, so a run that said something unexpected is a line in the
 * log as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-insulation-hicrep.mjs [out-dir]
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
const shotOf = async (selector, name) => {
  await page.locator(selector).first().screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const figureTitles = () => page.$$eval('.analysis-figure-head', (all) => all.map((one) => one.textContent.trim()).join(' | '))
const notes = () => page.$$eval('.analysis-drawer .analysis-note, .analysis-drawer .note', (all) => all.map((n) => n.textContent.trim()))
const open = async (title) => {
  await page.keyboard.press('Escape')
  await sleep(600)
  await page.locator(`text=${title}`).first().click()
  await sleep(1000)
}
const run = async (wait) => {
  const before = await figureTitles()
  // `run` on one map, `run on ★` in a deck (the star is an icon, so the text
  // ends at `on`) — and never `run on all N maps`, which is the batch.
  await page.locator('.analysis-drawer button', { hasText: /^run(\s+on)?\s*$/i }).first().click()
  await page
    .waitForFunction(wait, before, { timeout: 240000 })
    .catch(() => console.log('no output within four minutes'))
  await sleep(2500)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.metacooler.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelectorAll('.heatmap-canvas').length >= 2,
    null,
    { timeout: 180000 },
  )
  await sleep(3000)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(800)

  // ---- the column as the deck opens ----------------------------------------
  const reproducibility = page.locator('.analysis-row', {
    has: page.locator('.analysis-row-title', { hasText: /^Reproducibility$/ }),
  })
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.analysis-row')].some(
          (row) =>
            row.querySelector('.analysis-row-title')?.textContent === 'Reproducibility' &&
            !row.classList.contains('is-waiting'),
        ),
      null,
      { timeout: 60000 },
    )
    .catch(() => console.log('Reproducibility still waiting after a minute'))
  console.log(
    'Reproducibility row:',
    JSON.stringify(
      await reproducibility.first().evaluate((row) => ({
        waiting: row.classList.contains('is-waiting'),
        needs: row.nextElementSibling?.classList.contains('hidden') === false ? row.nextElementSibling.textContent : '',
      })),
    ),
  )
  await reproducibility.first().scrollIntoViewIfNeeded()
  await sleep(600)
  await shot('ih00-analysis-reproducibility-ready')

  // ---- reproducibility, first on a fresh deck --------------------------------
  await open('"Reproducibility"')
  await shot('ih01-hicrep-form')
  await shotOf('.analysis-form', 'ih02-hicrep-form-alone')
  console.log(
    'hicrep form fields:',
    JSON.stringify(await page.$$eval('.analysis-form .field', (all) => all.map((f) => f.textContent.trim().replace(/\s+/g, ' ').slice(0, 160)))),
  )
  await run((before) => {
    const now = [...document.querySelectorAll('.analysis-figure-head')].map((one) => one.textContent.trim()).join(' | ')
    return now !== before && now.includes('Stratum')
  })
  console.log('hicrep figures:', await figureTitles())
  console.log('hicrep notes:', JSON.stringify(await notes()))
  console.log(
    'hicrep tables:',
    JSON.stringify(
      await page.$$eval('.analysis-figure-scroll table', (tables) =>
        tables.map((t) => [...t.querySelectorAll('tr')].slice(0, 6).map((r) => r.textContent.trim().replace(/\s+/g, ' '))),
      ),
    ),
  )
  await shot('ih03-hicrep-ran')
  const drawer = page.locator('.analysis-drawer').first()
  for (let i = 0; i < 3; i++) {
    await drawer.evaluate((node, i) => {
      const scroller = node.querySelector('.analysis-drawer-body') ?? node
      scroller.scrollTo({ top: (scroller.scrollHeight / 3) * i })
    }, i)
    await sleep(800)
    await shotOf('.analysis-drawer', `ih${String(4 + i).padStart(2, '0')}-hicrep-drawer-${i + 1}`)
  }

  // ---- diamond insulation -------------------------------------------------
  await open('Diamond insulation')
  await shot('ih07-insulation-form')
  await shotOf('.analysis-form', 'ih08-insulation-form-alone')
  console.log(
    'insulation form sections:',
    JSON.stringify(await page.$$eval('.analysis-form .controls-title', (all) => all.map((n) => n.textContent))),
  )
  console.log(
    'insulation form fields:',
    JSON.stringify(await page.$$eval('.analysis-form .field', (all) => all.map((f) => f.textContent.trim().replace(/\s+/g, ' ').slice(0, 90)))),
  )
  await run(() => document.querySelectorAll('.ann-row.is-synthetic').length > 0)
  console.log('insulation notes:', JSON.stringify(await notes()))
  await shot('ih09-insulation-ran')
  await page.keyboard.press('Escape')
  await sleep(1200)
  await shot('ih10-insulation-on-the-map')
} finally {
  if (errors.length > 0) console.log('page errors:', JSON.stringify(errors.slice(0, 10)))
  await browser.close()
}
