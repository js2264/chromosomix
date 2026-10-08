/**
 * The 3D model coloured by a track (§25.5): white to the track’s colour, and
 * the key’s two ends typed into, as a lane’s are. Writes sc01 … sc05.
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
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(2500)
  await fold('Show the Annotations panel')
  const square = await page.$('button[title*="square" i]')
  if (square) { await square.click(); await sleep(2500) }
  await shot('01-map')
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')

  // The structure, **dropped on the Structures card**, which is the route the
  // card's own sentence names and — since there is no box to paste a URL into
  // on any card (§5.11) — the only one a script can drive: the click road opens
  // the browser's file picker, which is not the page's to answer.
  await page.evaluate(async (url) => {
    const card = document.querySelector('.structure-card')
    if (card === null) throw new Error('no Structures card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const file = new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await page.waitForFunction(() => { const n = document.querySelector('.structure-note'); return n === null || n.classList.contains('hidden') }, null, { timeout: 90000 }).catch(() => {})
  await sleep(5000)
  await fold('Fold the Annotations panel')
  await sleep(1000)

  const row = (label) => page.locator('.structure-settings .field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) }).first()
  await fold('Show the Aesthetics panel')
  await sleep(500)
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('.structure-settings select option')).map((o) => [o.value, o.textContent]))
  console.log('colourings:', options.filter(([v]) => v.startsWith('track:')).map(([, t]) => t).join(' | '))
  const track = options.map(([v]) => v).find((o) => o.startsWith('track:'))
  await row('colour by').locator('select').selectOption(track)
  await sleep(4000)
  const key = page.locator('.deck-structure .structure-key')
  await shot('sc01-track-own-ramp')
  const scales = await row('colour scale').locator('select option').allTextContents()
  console.log('colour scales offered:', scales.slice(0, 4).join(' | '), '…')
  await row('colour scale').locator('select').selectOption('track')
  await sleep(2000)
  await shot('sc02-white-to-track-colour')
  await key.screenshot({ path: `${OUT}/sc02b-key.png` })
  console.log('key:', await key.textContent())
  // The top end typed into.
  const ends = key.locator('.structure-key-limit')
  await ends.nth(1).click()
  await sleep(300)
  await key.screenshot({ path: `${OUT}/sc03-key-editing.png` })
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('2')
  await page.keyboard.press('Enter')
  await sleep(2500)
  console.log('key after typing 2:', await key.textContent())
  await shot('sc04-top-typed-2')
  // A refusal: a bottom above the top.
  await key.locator('.structure-key-limit').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('9')
  await page.keyboard.press('Enter')
  await sleep(150)
  await key.screenshot({ path: `${OUT}/sc04b-refused.png` })
  await page.keyboard.press('Escape')
  await sleep(500)
  await key.locator('.structure-key-auto').click()
  await sleep(2500)
  console.log('key after autoscale:', await key.textContent())
  await shot('sc05-autoscale-again')
} finally {
  console.log('errors:', errors.length ? errors.join('\n') : 'none')
  await browser.close()
}
