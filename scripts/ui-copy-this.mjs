/**
 * Press *Copy this* on every right-click menu that has it, in headless
 * Chromium, and write what landed on the clipboard (§7.2).
 *
 * The clipboard is stood in for — a headless browser has none a page may
 * write to — by a `navigator.clipboard.write` that keeps the PNG it is handed,
 * as `ui-saves.mjs` keeps what its stand-in save dialog is handed. So each step
 * writes two pictures: the menu as it opened, and the copied PNG itself, which
 * must be the data object alone — the map's cells with no axis, key, frame or
 * pointer; one lane with no name, range or hairline; the model with no key or
 * buttons — at the screen's density. It prints each PNG's size and the line
 * the corner said.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-copy-this.mjs [out-dir]
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
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
await context.addInitScript(() => {
  window.__copied = []
  const keep = async (items) => {
    for (const item of items) {
      const blob = await item.getType('image/png')
      const data = await new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.readAsDataURL(blob)
      })
      window.__copied.push(data)
    }
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: keep, writeText: async () => {} },
  })
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}

/** Right-click at a point, shoot the menu with a margin round it. */
const menuAt = async (x, y, name, button = 'right') => {
  await page.mouse.move(x, y)
  await sleep(400)
  if (button === 'right') await page.mouse.click(x, y, { button: 'right' })
  await page.waitForSelector('.context-menu', { timeout: 10000 })
  await sleep(300)
  const box = await page.locator('.context-menu').boundingBox()
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.context-menu > *')).slice(0, 4).map((n) => n.textContent?.trim()))
  const clip = { x: Math.max(0, Math.min(x, box.x) - 30), y: Math.max(0, Math.min(y, box.y) - 30), width: 0, height: 0 }
  clip.width = Math.max(x, box.x + box.width) + 30 - clip.x
  clip.height = Math.max(y, box.y + box.height) + 30 - clip.y
  await page.screenshot({ path: `${OUT}/${name}.png`, clip })
  console.log('shot', name, '· first rows:', JSON.stringify(rows))
}

/** Press Copy this in the menu that is up, and write what the clipboard got. */
const copyThis = async (name) => {
  const before = await page.evaluate(() => window.__copied.length)
  await page.locator('.context-menu .crumb-menu-item', { hasText: 'Copy this' }).first().click()
  await page.waitForFunction((n) => window.__copied.length > n, before, { timeout: 15000 })
  await sleep(500)
  const data = await page.evaluate(() => window.__copied[window.__copied.length - 1])
  const bytes = Buffer.from(String(data).replace(/^data:image\/png;base64,/, ''), 'base64')
  writeFileSync(`${OUT}/${name}.png`, bytes)
  // The PNG's own size, from its header: width and height are the first two
  // words of the IHDR chunk.
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const said = await page.evaluate(() => document.querySelector('.toast-stack')?.textContent?.trim() ?? '')
  console.log('copied', name, `${width} × ${height}`, '· the corner said:', said)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.lane-canvas:not(.hidden)').length > 0, null, { timeout: 120000 })
  await sleep(8000)

  // The map.
  const map = await page.locator('.heatmap-canvas').first().boundingBox()
  await menuAt(map.x + map.width * 0.55, map.y + map.height * 0.45, 'cp1-map-menu')
  await copyThis('cp2-map-copied')
  await page.screenshot({ path: `${OUT}/cp3-map-on-screen.png`, clip: { x: map.x - 60, y: map.y - 30, width: map.width + 90, height: map.height + 60 } })
  console.log('shot cp3-map-on-screen')

  // A lane below the map: the one with the most ink, the genes.
  const lanes = await page.locator('.lane-canvas:not(.hidden)').all()
  let bottom = null
  for (const lane of lanes) {
    const box = await lane.boundingBox()
    if (box !== null && box.y > map.y + map.height - 2 && (bottom === null || box.height > bottom.height)) bottom = box
  }
  if (bottom !== null) {
    // Somewhere down the stack, where a lane is rather than the gap between two.
    await menuAt(bottom.x + bottom.width * 0.5, bottom.y + Math.min(bottom.height * 0.35, 70), 'cp4-lane-menu')
    await copyThis('cp5-lane-copied')
  }

  // The same session's 1D browser: a lane of it.
  await page.mouse.move(5, 5)
  await page.keyboard.press('v')
  await page.waitForSelector('.browser-canvas', { timeout: 60000 })
  await sleep(5000)
  const stage = await page.locator('.browser-canvas').first().boundingBox()
  await menuAt(stage.x + stage.width * 0.6, stage.y + Math.min(stage.height * 0.3, 140), 'cp6-browser-lane-menu')
  await copyThis('cp7-browser-lane-copied')
  await page.keyboard.press('v')
  await page.waitForSelector('.heatmap-canvas', { timeout: 60000 })
  await sleep(4000)

  // The model, in a cell beside the map: dropped on the Structures card, then
  // a right click that does not drag.
  await fold('Show the Annotations panel')
  await page.evaluate(async (url) => {
    const card = document.querySelector('.structure-card')
    if (card === null) throw new Error('no Structures card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure canvas', { timeout: 120000 })
  await fold('Fold the Annotations panel')
  await sleep(6000)
  const model = await page.locator('.deck-structure .structure-wrap').first().boundingBox()
  const [mx, my] = [model.x + model.width * 0.7, model.y + model.height * 0.2]
  await page.mouse.move(mx, my)
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  await menuAt(mx, my, 'cp8-model-menu', 'none')
  await copyThis('cp9-model-copied')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
