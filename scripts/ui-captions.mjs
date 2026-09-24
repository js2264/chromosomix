/**
 * Save figures in headless Chromium with the Export card's *track captions*
 * switch on and off, and write the figures themselves next to the shots (§7.2).
 *
 * The save dialog is stubbed, as `ui-saves.mjs` does it, but this stand-in
 * keeps the bytes: what is being checked is the saved picture, not the dialog.
 * Saves the map's figure captioned and bare, then makes a deck — the demo
 * structure dropped, a tracks cell added with two tracks placed on it — and
 * saves the deck's figure both ways, since its tracks cell is drawn by the 1D
 * browser's own figure pass and not the map's. Shoots the Export card with the
 * switch, and prints the switch's state before and after each save, so a save
 * that ignored it is a line here as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-captions.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
const context = await browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: 1 })
// The stand-in dialog: answers with the suggested name and keeps what is written.
await context.addInitScript(() => {
  window.__files = []
  window.showSaveFilePicker = async (options) => ({
    name: options.suggestedName,
    createWritable: async () => ({
      write: async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        window.__files.push({ name: options.suggestedName, b64: btoa(s) })
      },
      close: async () => {},
    }),
  })
})
const page = await context.newPage()
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
const exportCard = () => page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()
const captions = () => exportCard().locator('.field-check input[type="checkbox"]')
/** Press the Export card's save and write the figure it saved to `<name>.png`. */
const saveAs = async (name) => {
  const before = await page.evaluate(() => window.__files.length)
  await exportCard().locator('.export-acts button').first().click()
  await page.waitForFunction((n) => window.__files.length > n, before, { timeout: 120000 })
  const file = await page.evaluate(() => window.__files.at(-1))
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(file.b64, 'base64'))
  console.log('saved', name, `(${file.name}, captions ${(await captions().isChecked()) ? 'on' : 'off'})`)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
  await fold('Fold the General panel')
  await exportCard().locator('select.select-dpi').selectOption('300')
  await exportCard().locator('select.select-format').selectOption('png')
  console.log('switch on by default:', await captions().isChecked())
  await exportCard().screenshot({ path: `${OUT}/t1-export-card-switch.png` })
  console.log('shot t1-export-card-switch')

  // The map's figure, captioned and bare.
  await saveAs('t2-map-figure-captioned')
  await captions().uncheck()
  await saveAs('t3-map-figure-bare')
  await captions().check()

  // A deck: the demo structure, and a tracks cell with two tracks on it.
  await page.evaluate(async (url) => {
    const card = document.querySelector('.structure-card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await sleep(6000)
  await page.click('.deck-add-toggle')
  await page.click('.deck-add-tracks')
  await page.waitForSelector('.deck-tracks', { timeout: 20000 })
  await fold('Show the Annotations panel')
  for (const id of ['demo-atac', 'demo-pol2']) {
    const more = await page.$(`.ann-row[data-id="${id}"] .ann-more`)
    if (more) { await more.click(); await sleep(300) }
  }
  await page.evaluate(() => {
    let n = 0
    for (const row of document.querySelectorAll('.annotation-card .ann-place-map')) {
      if (row.querySelector('.ann-place-name')?.textContent !== 'tracks') continue
      const bottom = Array.from(row.querySelectorAll('button.ann-place')).find((x) => x.textContent === 'bottom')
      if (bottom && !bottom.disabled && bottom.getAttribute('aria-pressed') !== 'true' && n < 2) { bottom.click(); n++ }
    }
  })
  await sleep(2000)
  await fold('Fold the Annotations panel')
  await sleep(3000)
  await shot('t4-deck-on-screen')
  await saveAs('t5-deck-figure-captioned')
  await captions().uncheck()
  await saveAs('t6-deck-figure-bare')
  await captions().check()
  await sleep(800)
  // The screen after two figure passes: its captions where they were.
  await shot('t7-deck-on-screen-after')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
