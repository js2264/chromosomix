/**
 * Drive the app in headless Chromium and write a gallery of screenshots.
 *
 * What a reviewer wants after a change to the UI: the real page, not a
 * test's idea of it. Opens the yeast demo through the dev server, adds the
 * demo structure beside the map, hovers both ways, colours the model by a
 * track, opens a tracks cell, runs the spatial-tracks task and the reconstruction, and saves one
 * PNG per step. Software WebGL, so it runs in a container with no GPU.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-gallery.mjs [out-dir]
 *
 * Playwright is resolved from the global install when it is not a dev
 * dependency (`npm root -g`); Chromium from PLAYWRIGHT_BROWSERS_PATH.
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
// The first *visible* button with that title: a folded column's button and its
// strip's are two elements, and only one of them can be pressed.
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const readout = () => page.evaluate(() => document.querySelector('.status-readout, .statusbar, footer')?.textContent ?? '')

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(2500)
  await fold('Show the Annotations panel')
  const square = await page.$('button[title*="square" i]')
  if (square) { await square.click(); await sleep(2500) }
  await shot('01-map')
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')

  // The structure, by URL through the Tracks card's box.
  const card = page.locator('.card.annotation-card')
  await card.locator('details.ann-url summary').first().click()
  await card.locator('details.ann-url input').first().fill(`${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await card.locator('details.ann-url button', { hasText: 'add' }).first().click()
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await page.waitForFunction(() => { const n = document.querySelector('.structure-note'); return n === null || n.classList.contains('hidden') }, null, { timeout: 90000 }).catch(() => {})
  await sleep(5000)
  await fold('Fold the Annotations panel')
  await sleep(1000)
  await shot('02-structure')
  await page.click('.structure-frame')
  await sleep(1500)
  await shot('03-structure-framed')

  // Hover a bead: sweep the canvas until the status bar names one.
  const canvas = page.locator('.structure-wrap canvas').first()
  const b = await canvas.boundingBox()
  if (b) {
    let found = false
    for (let j = 3; j < 30 && !found; j += 2) for (let i = 3; i < 30 && !found; i += 2) {
      await page.mouse.move(b.x + (b.width * i) / 32, b.y + (b.height * j) / 32)
      await sleep(40)
      if (/bead \d+ of/.test(await readout())) found = true
    }
    console.log('hovered bead:', found ? (await readout()).slice(0, 60) : 'none found')
    await sleep(600)
    await shot('04-hover-bead')
  }

  // Hover the map: the beads light and the chord joins the two ends.
  const map = await page.locator('.heatmap-canvas').first().boundingBox()
  if (map) {
    await page.mouse.move(map.x + map.width * 0.6, map.y + map.height * 0.35)
    await sleep(700)
    await shot('05-hover-map')
    await page.mouse.move(10, 10)
  }

  // The settings card, in the Aesthetics panel: colour by the first track.
  const row = (label) => page.locator('.structure-settings .field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) }).first()
  await fold('Show the Aesthetics panel')
  await sleep(500)
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('.structure-settings select option')).map((o) => o.value))
  const track = options.find((o) => o.startsWith('track:'))
  if (track) {
    await row('colour by').locator('select').selectOption(track)
    await sleep(4000)
  }
  await shot('06-colour-by-track')

  // Enlarged: the model in a dialog with the settings beside it, then back.
  await page.click('.structure-expand')
  await page.waitForSelector('.modal-structure .structure-wrap', { timeout: 10000 })
  await sleep(2500)
  await shot('06b-structure-enlarged')
  await page.keyboard.press('Escape')
  await sleep(1200)

  // A tracks cell, with two tracks placed on it from the location control.
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
  await sleep(2500)
  await shot('07-tracks-cell')

  // The Analysis panel, and the spatial-tracks task run on the model.
  await fold('Show the Analysis panel')
  await sleep(800)
  const versusRow = page.locator('text=Model versus map').first()
  if (await versusRow.count()) await versusRow.scrollIntoViewIfNeeded()
  await sleep(400)
  await shot('08-analysis-tasks')
  await page.locator('text=Spatial tracks').first().click()
  await sleep(800)
  const select = page.locator('select').filter({ has: page.locator('option', { hasText: 'Yeast_structure' }) }).first()
  if (await select.count()) await select.selectOption({ label: 'Yeast_structure' })
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(() => /Radial position/.test(document.body.textContent ?? ''), null, { timeout: 60000 }).catch(() => console.log('no radial track'))
  await sleep(2500)
  await shot('09-spatial-tracks')

  // A model from the map: the loaded block as drawn, or one sequence where
  // the block has more beads than the tab solves. The drawer floats over the
  // panel, so it is closed first or the row cannot be pressed.
  await page.keyboard.press('Escape')
  await sleep(600)
  await page.locator('text=Model from the map').first().click()
  await sleep(800)
  const refused = /more than the 2,500/.test(await page.evaluate(() => document.body.textContent ?? ''))
  if (refused) {
    const seq = page.locator('select').filter({ has: page.locator('option', { hasText: /^IV$/ }) }).first()
    if (await seq.count()) await seq.selectOption({ label: 'IV' })
    await sleep(500)
  }
  await shot('10-reconstruct-form')
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(() => /Spearman ρ/.test(document.body.textContent ?? ''), null, { timeout: 180000 }).catch(() => console.log('no reconstruction'))
  await sleep(4000)
  await shot('11-reconstructed')
  // The drawer floats over the deck: closed, the cell shows the model it drew.
  await page.keyboard.press('Escape')
  await sleep(1500)
  await shot('11b-reconstructed-cell')

  // The Structures card: both models, the computed one shown in the deck.
  await fold('Fold the Analysis panel')
  await fold('Show the Annotations panel')
  await sleep(600)
  const structures = page.locator('.structure-card').first()
  if (await structures.count()) await structures.scrollIntoViewIfNeeded()
  await sleep(400)
  await shot('12-structures-card')
  // Back to the loaded model from its row, then the cell's own picker.
  const show = structures.locator('.structure-show').first()
  if (await show.count()) { await show.click(); await sleep(3000) }
  await fold('Fold the Annotations panel')
  await sleep(600)
  await shot('13-model-picker')

  // The key as a control: colour by sequence, then a double-click on a name
  // shows that sequence alone. The card is in the Aesthetics panel, shown again.
  await fold('Show the Aesthetics panel')
  await sleep(500)
  await row('colour by').locator('select').selectOption('sequence')
  await sleep(1500)
  const names = page.locator('.structure-key-name')
  if (await names.count() > 2) {
    await names.nth(1).dblclick()
    await sleep(2000)
  }
  await shot('14-key-solo')
  if (await names.count() > 2) {
    await names.nth(1).dblclick()
    await sleep(1200)
  }
  // The centre of rotation and the axes, and the ruler, from the card's toggles.
  await page.click('.structure-settings .structure-toggle[title*="centre and axes"]')
  await page.click('.structure-settings .structure-toggle[title*="ruler"]')
  await sleep(1200)
  await shot('15-centre-axes-ruler')
  // Hover a bead: the maps draw the place as lines across the heatmap.
  const cv = page.locator('.structure-wrap canvas').first()
  const bb = await cv.boundingBox()
  if (bb) {
    let found = false
    for (let j = 3; j < 30 && !found; j += 2) for (let i = 3; i < 30 && !found; i += 2) {
      await page.mouse.move(bb.x + (bb.width * i) / 32, bb.y + (bb.height * j) / 32)
      await sleep(40)
      if (/bead \d+ of/.test(await readout())) found = true
    }
    await sleep(600)
    await shot('16-hover-echo-on-map')
    await page.mouse.move(10, 10)
  }
  // Select mode: two beads become a loop mark, drawn as a chord.
  await page.click('.structure-select')
  await sleep(300)
  if (bb) {
    const hits = []
    for (let j = 2; j < 62 && hits.length < 2; j += 1) for (let i = 2; i < 62 && hits.length < 2; i += 2) {
      await page.mouse.move(bb.x + (bb.width * i) / 64, bb.y + (bb.height * j) / 64)
      await sleep(25)
      const text = await readout()
      if (/bead \d+ of/.test(text) && !hits.some((h) => h.text.slice(0, 30) === text.slice(0, 30))) {
        hits.push({ x: bb.x + (bb.width * i) / 64, y: bb.y + (bb.height * j) / 64, text })
      }
    }
    console.log('select-mode beads:', hits.length)
    for (const hit of hits) { await page.mouse.click(hit.x, hit.y); await sleep(500) }
    await sleep(2000)
  }
  await shot('17-select-loop-mark')
  await page.click('.structure-select')

  // Contacts from the pin: pin a bead, turn the chords on.
  if (bb) {
    let pinned = false
    for (let j = 2; j < 62 && !pinned; j += 2) for (let i = 2; i < 62 && !pinned; i += 2) {
      await page.mouse.move(bb.x + (bb.width * i) / 64, bb.y + (bb.height * j) / 64)
      await sleep(25)
      if (/bead \d+ of/.test(await readout())) { await page.mouse.click(bb.x + (bb.width * i) / 64, bb.y + (bb.height * j) / 64); pinned = true }
    }
    await page.mouse.move(10, 10)
  }
  await page.click('.structure-settings .structure-toggle[title*="contact chords"]')
  await sleep(2500)
  await shot('18-contact-chords')
  await page.click('.structure-settings .structure-toggle[title*="contact chords"]')

  // Compare: the reconstruction against the loaded model, coloured by displacement.
  const compare = row('compare with').locator('select')
  if (await compare.count()) {
    const values = await compare.locator('option').allTextContents()
    const other = values.find((v) => v.startsWith('3D model'))
    if (other) {
      await compare.selectOption({ label: other })
      await sleep(1500)
      await row('colour by').locator('select').selectOption('displacement')
      await sleep(2500)
      await page.click('.structure-frame')
      await sleep(1500)
      await shot('19-compare-models')
    }
  }
} catch (e) {
  console.log('FAILED', String(e).slice(0, 500))
  await shot('99-failure')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 5))
await browser.close()
