/**
 * The map's look, and what leaves the app (§7.1, §7.2).
 *
 * The key in the map's corner with its short ramp between the two numbers — on
 * the yeast demo, on two maps split across the diagonal (two keys) and on their
 * ratio (a diverging ramp); the lines between chromosomes on the whole genome
 * with the dividers on, at a 2× screen's density, where they had been half a
 * pixel. Then the dark theme: the app as it looks there, and what it exports —
 * the map's PNG and PDF (the PDF rendered with poppler's `pdftoppm`), and a
 * task's figure, enlarged into the stage dialog where it follows the theme and
 * then saved as a PNG — every one of which must be on white.
 *
 * Every picture the app wrote is written beside the shots, under `files/`.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-map-look.mjs [out-dir]
 *
 * `GALLERY_ONLY=key`, `dividers` or `dark` runs one part.
 */

import { createRequire } from 'node:module'
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
const ONLY = process.env.GALLERY_ONLY ?? ''
const FILES = join(OUT, 'files')
mkdirSync(FILES, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const COOL = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`
const DEMO = `${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A page in its own context: a theme, a density, and no save dialog, so an export is a download. */
async function pageOf({ theme = 'light', scale = 1 } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: scale,
    acceptDownloads: true,
  })
  await context.addInitScript((theme) => {
    window.showSaveFilePicker = undefined
    if (theme !== 'light') localStorage.setItem('chromosomix:theme', theme)
  }, theme)
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  const shot = async (name, options = {}) => {
    await page.screenshot({ path: `${OUT}/${name}.png`, ...options })
    console.log('shot', name)
  }
  /** A close-up round one element. */
  const shotOf = async (name, locator, pad = 10) => {
    const box = await locator.boundingBox()
    if (box === null) return console.log('  (nothing to shoot for', name, ')')
    await shot(name, {
      clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad },
    })
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
  const settled = async (timeout = 180000) => {
    await sleep(1500)
    await page.waitForFunction(
      () => [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
      null,
      { timeout },
    )
    await sleep(1200)
  }
  const open = async (url) => {
    await page.goto(url)
    await page.waitForFunction(
      () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
      null,
      { timeout: 180000 },
    )
    await settled()
  }
  /** Press a button and keep the file it downloads. */
  const download = async (name, press) => {
    const arriving = page.waitForEvent('download', { timeout: 120000 })
    await press()
    const file = await arriving
    const path = join(FILES, name)
    copyFileSync(await file.path(), path)
    console.log('saved', name, `(${file.suggestedFilename()})`)
    return path
  }
  return { page, shot, shotOf, fold, settled, open, download, close: () => context.close() }
}

const exportCard = (page) =>
  page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()

try {
  if (ONLY === '' || ONLY === 'key') {
    const { page, shot, shotOf, fold, settled, open, close } = await pageOf()
    await open(DEMO)
    await fold('Fold the General panel')
    await shot('lk01-map-and-key')
    await shotOf('lk02-key', page.locator('.map-key').first())
    console.log('key:', await page.locator('.map-key').first().textContent())

    await open(`${BASE}/#uri=${COOL}&uri2=${COOL}&view=region&region=IV:1000000-1400000`)
    await shotOf('lk03-two-keys', page.locator('.map-key-slot').first(), 6)
    const compare = page
      .locator('.field')
      .filter({ has: page.locator('.field-label', { hasText: /^compare$/ }) })
      .locator('select')
      .first()
    await compare.selectOption('ratio')
    await settled()
    await shotOf('lk04-ratio-key', page.locator('.map-key').first())
    await close()
  }

  if (ONLY === '' || ONLY === 'dividers') {
    const { page, shot, settled, close } = await pageOf({ scale: 2 })
    await page.goto(`${BASE}/#uri=${COOL}&view=whole`)
    await page.waitForSelector('button:has-text("compute whole genome")', { timeout: 120000 })
    await page.click('button:has-text("compute whole genome")')
    await settled()
    await page.keyboard.press('d')
    await sleep(1500)
    const box = await page.evaluate(() => {
      const canvas = [...document.querySelectorAll('.heatmap-canvas')].find((c) => c.getBoundingClientRect().width > 0)
      const r = canvas.getBoundingClientRect()
      return { x: r.x, y: r.y }
    })
    await shot('lk05-dividers-2x', { clip: { x: box.x + 40, y: box.y + 20, width: 380, height: 380 } })
    await close()
  }

  if (ONLY === '' || ONLY === 'dark') {
    const { page, shot, fold, settled, open, download, close } = await pageOf({ theme: 'dark' })
    await open(DEMO)
    await fold('Fold the General panel')
    // The fold resizes the map, which is redrawn a moment later.
    await sleep(3500)
    await shot('lk06-dark-app')

    // The map's PNG and PDF, from the Export card.
    const card = exportCard(page)
    await card.locator('select.select-format').selectOption('png')
    await card.locator('select.select-dpi').selectOption('96').catch(() => {})
    await download('lk07-map-dark.png', () => card.locator('.export-acts button').first().click())
    await card.locator('select.select-format').selectOption('pdf')
    const pdf = await download('lk08-map-dark.pdf', () => card.locator('.export-acts button').first().click())
    try {
      execFileSync('pdftoppm', ['-png', '-r', '72', '-singlefile', pdf, join(FILES, 'lk08-map-dark-page')])
      console.log('rendered lk08-map-dark-page.png')
    } catch (err) {
      console.log('(no pdftoppm:', String(err).split('\n')[0], ')')
    }

    // A task's figure: enlarged into the stage, where it follows the theme on
    // screen, and then saved — on white.
    await fold('Show the Analysis panel')
    await page.locator('text=Contact probability P(s)').first().click()
    await sleep(900)
    await page.locator('button', { hasText: /^run$/i }).first().click()
    await page.waitForFunction(() => document.querySelector('.figure-chart svg') !== null, null, { timeout: 120000 })
    await sleep(2500)
    await page.locator('.figure-enlarge').first().click()
    await page.waitForSelector('.modal-stage .figure-chart svg', { timeout: 20000 })
    await sleep(2000)
    await shot('lk09-dark-figure-enlarged')
    await page.keyboard.press('Escape')
    await sleep(800)
    await download('lk10-figure-dark.png', () =>
      page.locator('.analysis-figure-head button', { hasText: 'PNG' }).first().click(),
    )
    await settled()
    await close()
  }
} finally {
  if (errors.length > 0) console.log('page errors:', errors)
  await browser.close()
}
