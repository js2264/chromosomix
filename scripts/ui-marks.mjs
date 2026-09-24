/**
 * Drive the reader's marks across the Manual annotations card and the 3D model
 * in headless Chromium, and write what each step looks like (§8.1, §25.5).
 *
 * Draws a line and a rectangle from the card, drops the demo structure, and
 * colours the model by them: the colour-by menu's order and names, the key
 * that colouring gets — a row per mark — a mark hidden from the key, a mark
 * recoloured from the key (and the card's row taking the same colour), and a
 * mark moved by typing over its row on the card. Prints each check to stdout
 * as well as shooting it, so a key that did not follow the store is a line.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-marks.mjs [out-dir]
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
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: 1 })).newPage()
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
const manual = () => page.locator('.annotation-card').filter({ has: page.locator('.card-head', { hasText: /Manual annotations/i }) }).first()
const form = (title) => manual().locator('.manual-form').filter({ has: page.locator('.manual-form-title', { hasText: new RegExp(`^${title}$`) }) }).first()
/** The key's rows and the card's rows, side by side: names, colours, and which are off. */
const both = () =>
  page.evaluate(() => ({
    key: Array.from(document.querySelectorAll('.deck-structure .structure-key-mark')).map((row) => ({
      name: row.querySelector('.structure-key-name')?.textContent,
      colour: row.querySelector('input')?.value,
      off: row.classList.contains('is-off'),
    })),
    card: Array.from(document.querySelectorAll('.manual-mark')).map((row) => ({
      name: row.querySelector('.manual-where')?.textContent,
      colour: row.querySelector('input[type="color"]')?.value,
    })),
  }))

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
  await fold('Fold the General panel')
  await fold('Show the Annotations panel')
  await sleep(600)

  // Two marks, typed: a line, and a domain on the diagonal.
  await form('Lines').locator('input.input').first().fill('IV:1,200,000')
  await form('Lines').locator('button', { hasText: /^add$/ }).click()
  await form('Rectangles').locator('input.input').first().fill('IV:1,050,000-1,120,000')
  await form('Rectangles').locator('button', { hasText: /^add$/ }).click()
  await sleep(500)

  // The structure, dropped on the Structures card.
  await page.evaluate(async (url) => {
    const card = document.querySelector('.structure-card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await sleep(6000)
  await page.click('.structure-frame').catch(() => {})
  await sleep(1500)

  // The colour-by menu, from the 3D structure card in the Aesthetics column.
  await fold('Show the Aesthetics panel')
  await sleep(800)
  const colourBy = page.locator('.structure-settings .field').filter({ has: page.locator('.field-label', { hasText: /^colour by$/ }) }).first().locator('select')
  const options = await colourBy.locator('option').allTextContents()
  console.log('colour by:', JSON.stringify(options))
  console.log('score column offered:', options.some((o) => /score/i.test(o)))
  await colourBy.selectOption({ label: 'manual annotations' })
  await sleep(2500)
  console.log('key and card:', JSON.stringify(await both()))
  await shot('k1-colour-by-marks-key')

  // The first mark taken off the model's colouring, from its key row.
  await page.locator('.deck-structure .structure-key-mark .structure-key-name').first().click()
  await sleep(1500)
  console.log('first mark hidden:', JSON.stringify(await both()))
  await shot('k2-mark-hidden-from-key')

  // The second recoloured from the key: the card's row takes it too.
  await page.evaluate(() => {
    const swatch = document.querySelectorAll('.deck-structure .structure-key-mark input[type="color"]')[1]
    swatch.value = '#0f8a5f'
    swatch.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(1500)
  console.log('second recoloured on the key:', JSON.stringify(await both()))
  await shot('k3-mark-recoloured-from-key')

  // The line moved by typing over its row on the card.
  await fold('Fold the Aesthetics panel')
  await manual().locator('.manual-where').first().click()
  await sleep(400)
  await shot('k4-row-editing')
  const box = manual().locator('.manual-edit-box').first()
  await box.fill('IV:1,250,000')
  await box.press('Enter')
  await sleep(1500)
  console.log('line moved in its row:', JSON.stringify(await both()))
  await shot('k5-row-moved')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
