/**
 * Press the app's export buttons in headless Chromium, with the save dialog
 * stubbed, and write what each one asked it (§26.6).
 *
 * A headless browser has no *Save as* to show — it cancels one the moment it
 * is asked — so the page is given a stand-in that answers with a name the
 * "reader" typed and records what it was asked: the suggested name, the
 * folder it opened in, the type filter, and how many bytes were then written.
 * That is the contract `ui/export.ts` keeps with the real dialog, and it is
 * printed to stdout as well as shot, so an export that skipped the dialog, or
 * asked it after the moment a browser would still open one, is a line here.
 *
 * Presses the map's Export card, the Manual annotations card's save (after
 * typing a line), the deck's own save once a structure has made a deck, and
 * the Export card again with the deck up — which must write the deck's figure;
 * then, with the model zoomed past its cell, the deck's figure as a small PNG,
 * which it writes out as `x4-deck-figure.png` so the figure itself — the model
 * framed by its cell's edge (§25.7) — can be looked at; then, in a page with no
 * dialog at all, the map's save once more, which must arrive as the plain
 * download it always was.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-saves.mjs [out-dir]
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
// The stand-in dialog: "the reader" renames each file `chosen-<n>.<ext>`.
await context.addInitScript(() => {
  window.__saves = []
  window.showSaveFilePicker = async (options) => {
    const extension = /\.[A-Za-z0-9]+$/.exec(options.suggestedName)?.[0] ?? ''
    const record = { ...options, chosen: `chosen-${window.__saves.length + 1}${extension}`, bytes: 0 }
    window.__saves.push(record)
    return {
      name: record.chosen,
      createWritable: async () => ({
        write: async (blob) => {
          // A picture is kept whole, so the figure itself can be looked at.
          if (blob.type === 'image/png') {
            record.data = await new Promise((resolve) => {
              const reader = new FileReader()
              reader.onload = () => resolve(reader.result)
              reader.readAsDataURL(blob)
            })
          }
          record.bytes = blob.size
        },
        close: async () => {},
      }),
    }
  }
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
let downloads = 0
page.on('download', () => { downloads++ })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
/** The last save the stand-in dialog saw, once its bytes have been written. */
const lastSave = async (count) => {
  await page.waitForFunction((n) => window.__saves.length >= n && window.__saves[n - 1].bytes > 0, count, { timeout: 60000 }).catch(() => {})
  return page.evaluate(() => {
    const save = window.__saves.at(-1)
    return save === undefined ? null : { suggested: save.suggestedName, startIn: save.startIn, types: save.types, chosen: save.chosen, bytes: save.bytes }
  })
}
/** The Export card's save button, in the Aesthetics column. */
const exportCard = () => page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()
const exportSave = () => exportCard().locator('.export-acts button').first()

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
  await fold('Fold the General panel')

  // The map's figure, from its Export card.
  await exportSave().click()
  console.log('map figure:', JSON.stringify(await lastSave(1)))
  await sleep(500)
  const note = await exportCard().locator('.export-note').textContent()
  console.log('Export card says:', note)
  await shot('x1-map-saved-as-chosen')

  // A line typed on the Manual annotations card, then its marks saved as BED.
  await fold('Show the Annotations panel')
  await sleep(600)
  const manual = page.locator('.annotation-card').filter({ has: page.locator('.card-head', { hasText: /Manual annotations/i }) }).first()
  await manual.locator('input[placeholder="I:120,000"]').fill('IV:1,200,000')
  await manual.locator('.manual-form').first().locator('button', { hasText: /^add$/ }).click()
  await sleep(500)
  await manual.locator('.manual-export .export-acts button').first().click()
  console.log('marks:', JSON.stringify(await lastSave(2)))
  await sleep(500)
  console.log('Manual card says:', await manual.locator('.export-note').textContent())
  await manual.scrollIntoViewIfNeeded()
  await shot('x2-marks-saved-as-chosen')

  // A structure dropped: a deck. The bar's save, then the Export card's.
  await page.evaluate(async (url) => {
    const card = document.querySelector('.structure-card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await sleep(6000)
  await fold('Fold the Annotations panel')
  await page.locator('.deck-save').first().click()
  console.log('deck, from its bar:', JSON.stringify(await lastSave(3)))
  await exportSave().click()
  const fromCard = await lastSave(4)
  console.log('deck, from the Export card:', JSON.stringify(fromCard), '· the deck’s figure:', /^deck-/.test(fromCard?.suggested ?? ''))
  await sleep(500)
  await shot('x3-deck-saved-from-card')

  // The deck's figure itself, with the model zoomed past its cell — the case
  // an export must frame (§25.7). Saved as a small PNG so it can be looked at,
  // and written out whole.
  const model = await page.locator('.deck-structure canvas').first().boundingBox()
  if (model !== null) {
    await page.mouse.move(model.x + model.width / 2, model.y + model.height / 2)
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -240); await sleep(150) }
    await page.mouse.move(5, 5)
    await sleep(1200)
  }
  await exportCard().locator('select').filter({ has: page.locator('option[value="96"]') }).first().selectOption('96')
  await exportCard().locator('select').filter({ has: page.locator('option[value="png"]') }).first().selectOption('png')
  await sleep(300)
  await exportSave().click()
  const figure = await lastSave(5)
  console.log('deck figure:', JSON.stringify(figure))
  const data = await page.evaluate(() => window.__saves.at(-1)?.data ?? null)
  if (typeof data === 'string' && data.startsWith('data:image/png;base64,')) {
    writeFileSync(`${OUT}/x4-deck-figure.png`, Buffer.from(data.slice('data:image/png;base64,'.length), 'base64'))
    console.log('wrote x4-deck-figure')
  } else {
    console.log('no picture came back from the deck’s save')
  }

  console.log('plain downloads (should be none):', downloads)

  // And a browser with no save dialog — Firefox, Safari: the plain download,
  // under the name the app suggested.
  const bare = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
  await bare.addInitScript(() => { window.showSaveFilePicker = undefined })
  const plain = await bare.newPage()
  await plain.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await plain.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
  const arriving = plain.waitForEvent('download', { timeout: 60000 })
  await plain.locator('.controls-card').filter({ has: plain.locator('.controls-title', { hasText: /^Export$/ }) }).first().locator('.export-acts button').first().click()
  const download = await arriving
  console.log('with no dialog, a plain download:', download.suggestedFilename())
  await bare.close()
  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
