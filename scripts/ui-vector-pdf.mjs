/**
 * The app's PDFs as drawings (§7.2, §16.5, §25.7), in headless Chromium on the
 * yeast micro-C demo: the Export card with PDF chosen — `PDF (vector)`, and no
 * resolution beside it, since a page of paths has none — then the map's PDF,
 * the deck's once a structure has made one, and the model's own from its 3D
 * card, each kept whole through a stand-in save dialog and written out next to
 * the shots.
 *
 * Each PDF is then rendered with `pdftoppm` (poppler) into a picture of its
 * first page, and its images are counted with `pdfimages -list`: a map's PDF
 * holds **one** image, the map's cells, and everything else — the axes, the
 * ticks, the lanes, the caption — is paths and text; the deck's holds one per
 * map; the model's holds none. The counts are printed, so a figure that went
 * back to being a screenshot in a page is a line in the log.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-vector-pdf.mjs [out-dir]     # v01 … v07, v-map.pdf, v-deck.pdf, v-model.pdf
 */

import { createRequire } from 'node:module'
import { execFileSync, execSync } from 'node:child_process'
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
// The stand-in dialog, which keeps every file's bytes whole — a PDF as well as
// a picture — so the file itself can be written out and looked at.
await context.addInitScript(() => {
  window.__saves = []
  window.showSaveFilePicker = async (options) => {
    const record = { suggested: options.suggestedName, bytes: 0, data: null }
    window.__saves.push(record)
    return {
      name: options.suggestedName,
      createWritable: async () => ({
        write: async (blob) => {
          record.data = await new Promise((resolve) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result)
            reader.readAsDataURL(blob)
          })
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name, options = {}) => { await page.screenshot({ path: `${OUT}/${name}.png`, ...options }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const exportCard = () => page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()

/** Wait for the `count`th save, then write its bytes to `name` and describe the PDF. */
async function keep(count, name) {
  await page.waitForFunction((n) => window.__saves.length >= n && window.__saves[n - 1].bytes > 0, count, { timeout: 120000 }).catch(() => {})
  const save = await page.evaluate((n) => window.__saves[n - 1] ?? null, count)
  if (save === null || typeof save.data !== 'string') {
    console.log(`${name}: nothing was saved`)
    return
  }
  const base64 = save.data.slice(save.data.indexOf(',') + 1)
  const path = join(OUT, name)
  writeFileSync(path, Buffer.from(base64, 'base64'))
  console.log(`${name}: suggested ${save.suggested}, ${save.bytes.toLocaleString('en-US')} bytes`)
  describePdf(path, name.replace(/\.pdf$/, ''))
}

/** Render the first page and count the images, where poppler is installed. */
function describePdf(path, stem) {
  try {
    const images = execFileSync('pdfimages', ['-list', path]).toString().trim().split('\n').slice(2)
    console.log(`  images in ${stem}.pdf: ${images.length}`)
    for (const line of images) console.log(`    ${line.replace(/\s+/g, ' ').trim()}`)
    const text = execFileSync('pdftotext', ['-layout', path, '-']).toString().replace(/\s+/g, ' ').trim()
    console.log(`  its text: ${text.slice(0, 240)}${text.length > 240 ? '…' : ''}`)
    execFileSync('pdftoppm', ['-png', '-r', '110', '-singlefile', path, join(OUT, `${stem}-page`)])
    console.log(`  wrote ${stem}-page.png`)
  } catch (error) {
    console.log(`  (poppler not available to read ${stem}.pdf: ${String(error).split('\n')[0]})`)
  }
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(6000)
  await fold('Fold the General panel')

  // The Export card, PNG then PDF: the resolution goes with PNG.
  const card = exportCard()
  await card.scrollIntoViewIfNeeded()
  const clip = async () => {
    const box = await card.boundingBox()
    return box === null ? undefined : { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 }
  }
  await shot('v01-export-card-png', { clip: await clip() })
  await card.locator('.select-format').selectOption('pdf')
  await sleep(400)
  const formats = await card.locator('.select-format option').allTextContents()
  const dpiHidden = await card.locator('.select-dpi').evaluate((node) => node.hidden || getComputedStyle(node).display === 'none').catch(() => 'no select')
  console.log('formats offered:', formats.join(' · '), '· resolution hidden with PDF:', dpiHidden)
  await shot('v02-export-card-pdf', { clip: await clip() })

  // The map's PDF.
  await card.locator('.export-acts button').first().click()
  await keep(1, 'v-map.pdf')
  await shot('v03-map-saved')

  // A structure dropped: a deck, and the deck's PDF from the same card.
  await page.evaluate(async (url) => {
    const target = document.querySelector('.structure-card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await sleep(8000)
  await shot('v04-deck')
  await exportCard().locator('.select-format').selectOption('pdf')
  await sleep(300)
  await exportCard().locator('.export-acts button').first().click()
  await keep(2, 'v-deck.pdf')

  // The model's own PDF, from its 3D card.
  const model = page.locator('.structure-settings').first()
  await model.scrollIntoViewIfNeeded()
  await model.locator('.select-format').selectOption('pdf')
  await sleep(400)
  const modelDpiHidden = await model.locator('.select-dpi').evaluate((node) => node.hidden).catch(() => 'no select')
  console.log('3D card: resolution hidden with PDF:', modelDpiHidden)
  const modelBox = await model.boundingBox()
  if (modelBox !== null) await shot('v05-model-export-row', { clip: { x: modelBox.x - 8, y: Math.max(0, modelBox.y + modelBox.height - 260), width: modelBox.width + 16, height: 268 } })
  await model.locator('.export-acts button').first().click()
  await keep(3, 'v-model.pdf')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
