/**
 * The stage that edits the reference (§27), in headless Chromium, on the yeast
 * micro-C demo with its tracks: the heading's word on the reference, the stage
 * open on the whole genome, the pointer snapping to a sequence's edge, a stretch
 * selected along the diagonal and lit on the map, the bars and the lanes, the
 * same stretch turned round, a zoom onto the bow-tie that makes, a stretch
 * dragged into another chromosome with the map rearranged under the hand, the
 * drop, a box of two stretches off the diagonal, the menu that sets a stretch
 * aside, an undo, the heading once the stage is closed, the stage in the dark
 * theme, and the chip gone with the dev features off.
 *
 * It prints what each step found — the selection, the history, the readout —
 * so a step that did not happen is a line in the log rather than something to
 * spot in a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit.mjs [out-dir]     # e01 … e14
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
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  console.log(`wrote ${name}.png`)
}
const text = (selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector)
const history = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.edit-history-row')].map(
      (row) => `${row.classList.contains('is-current') ? '▸' : row.classList.contains('is-undone') ? '·' : ' '} ${row.textContent}`,
    ),
  )

/** The stage's map, and where a unit of its axis is on the page. */
async function mapBox() {
  return page.evaluate(() => {
    const canvas = document.querySelector('.edit-overlay')
    const r = canvas.getBoundingClientRect()
    const [x0, x1, y0, y1] = (canvas.dataset.view ?? '0 1 0 1').split(' ').map(Number)
    return { left: r.left, top: r.top, width: r.width, height: r.height, x0, x1, y0, y1, n: Number(canvas.dataset.cells) }
  })
}
const at = (box, ux, uy) => ({
  x: box.left + ((ux - box.x0) / (box.x1 - box.x0)) * box.width,
  y: box.top + ((uy - box.y0) / (box.y1 - box.y0)) * box.height,
})
/** A sequence's cells on the stage's axis, from the sidebar's list. */
async function cellsOf(name) {
  return page.evaluate((wanted) => {
    for (const button of document.querySelectorAll('.edit-sequence')) {
      if (button.querySelector('.edit-sequence-name')?.textContent === wanted) return button.dataset.cells.split(' ').map(Number)
    }
    return null
  }, name)
}
/** Drag from one place to another in steps, so the stage sees the travel. */
async function drag(from, to, steps = 12, hold = null) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let k = 1; k <= steps; k++) {
    await page.mouse.move(from.x + ((to.x - from.x) * k) / steps, from.y + ((to.y - from.y) * k) / steps)
    await sleep(25)
  }
  if (hold !== null) await hold()
  await page.mouse.up()
  await sleep(400)
}

async function openStage() {
  await page.click('.crumb-reference-button')
  for (let i = 0; i < 240; i++) {
    await sleep(500)
    if (await page.evaluate(() => document.querySelector('.edit-status')?.classList.contains('hidden'))) break
  }
  await sleep(800)
}

// ── The map, with the dev features on ────────────────────────────────────────
await page.goto(`${BASE}/`)
await page.evaluate(() => {
  localStorage.setItem('metacooler-viewer:dev-features', 'on')
  sessionStorage.clear()
  for (const key of Object.keys(localStorage)) if (key.includes(':map:edit')) localStorage.removeItem(key)
})
await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`)
await page.reload()
await sleep(8000)
console.log('heading says:', (await text('.crumb-reference'))?.trim())
await shot('e01-heading')

// ── The stage ────────────────────────────────────────────────────────────────
await openStage()
let box = await mapBox()
console.log('stage:', box.n, 'cells a side ·', await text('.edit-readout'))
await shot('e02-stage')

// The pointer near the edge between IV and V: it snaps, and the readout says so.
const iv = await cellsOf('IV')
let p = at(box, iv[1] + (4 * (box.x1 - box.x0)) / box.width, iv[1] - 300)
await page.mouse.move(p.x, p.y)
await sleep(300)
console.log('near IV’s end:', await text('.edit-readout'))
await shot('e03-snapped')

// A stretch of IV along the diagonal.
const a = iv[0] + 400
const b = iv[0] + 900
await drag(at(box, a, a), at(box, b, b))
console.log('selected:', await text('.edit-card .edit-locus'))
await shot('e04-selected')

// Turned round, with its key.
await page.keyboard.press('i')
await sleep(600)
console.log('history:', await history())
await shot('e05-turned')

// Zoomed onto it: the bow-tie a turned stretch draws at its two ends.
p = at(box, (a + b) / 2, (a + b) / 2)
await page.mouse.move(p.x, p.y)
for (let k = 0; k < 7; k++) {
  await page.mouse.wheel(0, -240)
  await sleep(80)
}
await sleep(500)
console.log('zoomed view:', (await mapBox()).x0.toFixed(0), '→', (await mapBox()).x1.toFixed(0))
await shot('e06-zoomed')
await page.keyboard.press('0')
await sleep(400)
box = await mapBox()

// The stretch dragged into X, the map rearranged under the hand.
const x = await cellsOf('X')
const mid = (a + b) / 2
const target = x[0] + 300 + (b - a) / 2
await drag(at(box, mid, mid), at(box, target, target), 14, async () => {
  await sleep(300)
  console.log('while dragging:', await text('.edit-readout'))
  await shot('e07-dragging')
})
console.log('history:', await history())
await shot('e08-dropped')

// A box off the diagonal: two stretches, and what two stretches admit.
const xv = await cellsOf('XV')
const vii = await cellsOf('VII')
await drag(at(box, xv[0] + 100, vii[0] + 100), at(box, xv[0] + 500, vii[0] + 400))
console.log('box:', await page.evaluate(() => [...document.querySelectorAll('.edit-box-row')].map((row) => row.textContent)))
await shot('e09-box')
await page.keyboard.press('Escape')
await sleep(200)

// A stretch set aside: the menu asks why.
const xvi = await cellsOf('XVI')
await drag(at(box, xvi[0] + 300, xvi[0] + 300), at(box, xvi[0] + 500, xvi[0] + 500))
await page.keyboard.press('Delete')
await sleep(400)
console.log('menu:', await page.evaluate(() => [...document.querySelectorAll('.context-menu button, .context-menu .context-menu-head')].map((row) => row.textContent)))
await shot('e10-aside-menu')
await page.keyboard.press('Escape')
await sleep(200)

// Undone, with its key: the step stays in the history, greyed, to be redone.
await page.keyboard.press('Escape')
await page.keyboard.press('Control+z')
await sleep(600)
console.log('after undo:', await history())
await shot('e11-undone')

// Closed: the heading says the session is edited.
await page.click('.modal-panel .btn-close')
await sleep(800)
console.log('heading says:', (await text('.crumb-reference'))?.trim())
await shot('e12-closed')

// The dark theme.
await page.emulateMedia({ colorScheme: 'dark' })
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await openStage()
await shot('e13-dark')
await page.click('.modal-panel .btn-close')
await sleep(400)
await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
await page.emulateMedia({ colorScheme: 'light' })

// The dev features off: no word on the reference, no command.
await page.evaluate(() => localStorage.removeItem('metacooler-viewer:dev-features'))
await page.reload()
await sleep(7000)
console.log('dev off · heading has the reference:', (await page.$('.crumb-reference')) !== null)
await shot('e14-dev-off')

if (errors.length > 0) console.log('page errors:', errors)
await browser.close()
