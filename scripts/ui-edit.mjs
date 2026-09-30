/**
 * The stage that edits the reference (§27), in headless Chromium, on the yeast
 * micro-C demo with its tracks: the heading's word on the reference, the stage
 * open on the whole genome with nothing to suggest, the pointer snapping to a
 * sequence's edge, a stretch selected along the diagonal and lit on the map, the
 * bars and the lanes, the same stretch turned round, the method's suggestion to
 * turn it back — its diamonds, its corners, its label on the rail — lit from the
 * rail, a zoom onto its corner with the pointer snapped to it, a stretch dragged
 * into another chromosome with the map rearranged under the hand, the drop, a
 * box of two stretches off the diagonal, the menu that sets a stretch aside, an
 * undo, review mode on the suggestion, the map as it would be with Space held,
 * the suggestion taken, a second turn inside the window behind the stage, the session
 * redrawn through the edit once the stage is closed — the map, its tracks, a box
 * drawn on it and a line typed at a place in the file, both kept in the file's
 * coordinates, and the Chromosomes table — the stage in the dark theme, a
 * suggestion turned down and offered again, auto mode and what it applied, the
 * file put back by the heading's arrow with the marks where the file has them,
 * and the chip gone with the dev features off.
 *
 * It prints what each step found — the selection, the history, the readout —
 * so a step that did not happen is a line in the log rather than something to
 * spot in a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit.mjs [out-dir]     # e01 … e25, e01b, e14b, e17b, e24b
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

/** A panel's fold button, by the start of its title. */
async function fold(title) {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
const manual = () => page.locator('.annotation-card').filter({ has: page.locator('.card-head', { hasText: /Manual annotations/i }) }).first()
const form = (title) =>
  manual()
    .locator('.manual-form')
    .filter({ has: page.locator('.manual-form-title', { hasText: new RegExp(`^${title}$`) }) })
    .first()

/**
 * Where a base of an edited sequence is on the session's map, along its
 * diagonal: two points hovered, their readouts read, and the line between them.
 */
async function diagonalAt(name) {
  const r = await page.evaluate(() => {
    const box = document.querySelector('.heatmap-canvas').getBoundingClientRect()
    return { left: box.left, top: box.top, width: box.width, height: box.height }
  })
  const read = async (f) => {
    await page.mouse.move(r.left + f * r.width, r.top + f * r.height)
    await sleep(250)
    const found = new RegExp(`${name}:([\\d,]+)`).exec((await text('.status-coords')) ?? '')
    return found === null ? null : Number(found[1].replaceAll(',', ''))
  }
  const [f0, f1] = [0.3, 0.7]
  const [b0, b1] = [await read(f0), await read(f1)]
  if (b0 === null || b1 === null) return null
  return (bp) => {
    const f = f0 + ((bp - b0) / (b1 - b0)) * (f1 - f0)
    return { x: r.left + f * r.width, y: r.top + f * r.height }
  }
}

/** Wait for the suggestions to be counted again after an edit. */
async function settled() {
  for (let i = 0; i < 40; i++) {
    await sleep(150)
    const weighing = await page.evaluate(() => /weighing/.test(document.querySelector('.edit-suggestions-card .edit-card-head')?.textContent ?? ''))
    if (!weighing) break
  }
  await sleep(300)
}
/** The suggestions the list shows, as words and confidence. */
const suggestions = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.edit-suggestion-main')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()),
  )

async function openStage(reading = null) {
  await page.click('.crumb-reference-button')
  // The read saying what it reads as it starts (§27.12), caught mid-read.
  if (reading !== null) {
    for (let i = 0; i < 100; i++) {
      await sleep(50)
      if (/stored pixel/.test((await text('.edit-status-text')) ?? '')) break
    }
    console.log('reading:', await text('.edit-status-text'))
    await shot(reading)
  }
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
await openStage('e01b-reading')
let box = await mapBox()
console.log('stage:', box.n, 'cells a side ·', await text('.edit-readout'))
await settled()
console.log('suggested at open:', await suggestions(), '·', await text('.edit-suggestions-card .edit-empty'))
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

// The method sees the bow-tie the turn drew and offers to turn it back: a
// diamond at each end, the two corners where the ends belong, a number, and
// its label on the rail at the height of the stretch. (The selection let go
// of, so its outline is not over the corners.)
await page.keyboard.press('Escape')
await settled()
console.log('suggested:', await suggestions())
await shot('e06-suggested')

// Its label on the rail, hovered: its marks lit on the map, and what it would do.
await page.hover('.edit-rail-label')
await sleep(400)
console.log('lit rows:', await page.evaluate(() => document.querySelectorAll('.edit-suggestion.is-lit').length))
await shot('e07-lit')

// Zoomed onto the corner — the stretch's two ends meeting off the diagonal —
// and the pointer snapping to it in the plane.
p = at(box, b, a)
await page.mouse.move(p.x, p.y)
for (let k = 0; k < 5; k++) {
  await page.mouse.wheel(0, -240)
  await sleep(80)
}
await sleep(500)
box = await mapBox()
p = at(box, b, a)
await page.mouse.move(p.x + 5, p.y - 4)
await sleep(300)
console.log('near the corner:', await text('.edit-readout'))
await shot('e08-corner')
await page.keyboard.press('0')
await sleep(400)
box = await mapBox()
// The stretch selected again, to be moved by its square.
await drag(at(box, a, a), at(box, b, b))

// The stretch dragged into X, the map rearranged under the hand.
const x = await cellsOf('X')
const mid = (a + b) / 2
const target = x[0] + 300 + (b - a) / 2
await drag(at(box, mid, mid), at(box, target, target), 14, async () => {
  await sleep(300)
  console.log('while dragging:', await text('.edit-readout'))
  await shot('e09-dragging')
})
console.log('history:', await history())
await settled()
console.log('suggested after the move:', await suggestions())
await shot('e10-dropped')

// The move back, lit from its label on the rail: the stretch outlined where it
// is, an arrow to the line where it goes in.
await page.keyboard.press('Escape')
await page.hover('.edit-rail-label')
await sleep(400)
console.log('lit:', await page.evaluate(() => document.querySelector('.edit-suggestion.is-lit .edit-suggestion-words')?.textContent ?? null))
await shot('e10b-move-lit')
await page.mouse.move(5, 5)
await sleep(200)

// A box off the diagonal: two stretches, and what two stretches admit.
const xv = await cellsOf('XV')
const vii = await cellsOf('VII')
await drag(at(box, xv[0] + 100, vii[0] + 100), at(box, xv[0] + 500, vii[0] + 400))
console.log('box:', await page.evaluate(() => [...document.querySelectorAll('.edit-box-row')].map((row) => row.textContent)))
await shot('e11-box')
await page.keyboard.press('Escape')
await sleep(200)

// A stretch set aside: the menu asks why.
const xvi = await cellsOf('XVI')
await drag(at(box, xvi[0] + 300, xvi[0] + 300), at(box, xvi[0] + 500, xvi[0] + 500))
await page.keyboard.press('Delete')
await sleep(400)
console.log('menu:', await page.evaluate(() => [...document.querySelectorAll('.context-menu button, .context-menu .context-menu-head')].map((row) => row.textContent)))
await shot('e12-aside-menu')
await page.keyboard.press('Escape')
await sleep(200)

// Undone, with its key: the step stays in the history, greyed, to be redone.
await page.keyboard.press('Escape')
await page.keyboard.press('Control+z')
await sleep(600)
await settled()
console.log('after undo:', await history())
await shot('e13-undone')

// Review: the suggestions as a queue, the one it is on framed, and its keys.
await page.click('.edit-modes >> text=review')
await sleep(900)
console.log('review:', await text('.edit-review'))
await shot('e14-review')

// An end of the one review is on, dragged along the diagonal to adjust it,
// then put back where the method found it.
{
  const box = await mapBox()
  const words = (await text('.edit-review-words')) ?? ''
  const found = /IV_e1:([\d,]+)-([\d,]+)/.exec(words)
  const iv = await cellsOf('IV_e1')
  if (found !== null && iv !== null) {
    const end = Math.round(Number(found[2].replaceAll(',', '')) / 1000) + iv[0]
    await drag(at(box, end, end), at(box, end - 60, end - 60))
    console.log('adjusted:', await text('.edit-review'), '·', await suggestions())
    await shot('e14b-adjusted')
    await page.locator('.edit-chip-button', { hasText: 'adjusted' }).first().click()
    await sleep(300)
    console.log('as found:', await text('.edit-review-words'))
  } else console.log('adjust: no suggestion to adjust')
}

// Space held: the map as it would be with the suggestion taken.
await page.keyboard.down(' ')
await sleep(900)
console.log('held:', await text('.edit-review'))
await shot('e15-as-it-would-be')
await page.keyboard.up(' ')
await sleep(300)

// Y: taken — a step marked as the suggestion's, and nothing left to suggest.
await page.keyboard.press('y')
await sleep(600)
await settled()
console.log('after taking it:', await history(), '· suggested:', await suggestions())
await shot('e16-taken')
await page.click('.edit-modes >> text=manual')
await sleep(300)

// A second turn, inside the window the map behind the stage is showing: the
// map's own view is IV:1,000,001-1,400,000, and this is its middle.
box = await mapBox()
const ivNow = (await cellsOf('IV_e1')) ?? (await cellsOf('IV'))
await drag(at(box, ivNow[0] + 1100, ivNow[0] + 1100), at(box, ivNow[0] + 1300, ivNow[0] + 1300))
await page.keyboard.press('i')
await sleep(500)
console.log('history:', await history())

// Closed: the session is redrawn through the edit — the map behind, its
// tracks mirrored through the turned stretch, and the heading edited.
await page.click('.modal-panel .btn-close')
for (let i = 0; i < 60; i++) {
  await sleep(500)
  if (/IV_e1/.test((await text('.breadcrumb')) ?? '')) break
}
await sleep(4000)
console.log('heading says:', (await text('.crumb-reference'))?.trim(), '·', (await text('.breadcrumb'))?.replace(/\s+/g, ' '))
await shot('e17-session-edited')

// The readout through the edit: each place with where it was in the file —
// a column inside the turned stretch, a row before it.
{
  const r = await page.evaluate(() => {
    const b = document.querySelector('.heatmap-canvas').getBoundingClientRect()
    return { left: b.left, top: b.top, width: b.width, height: b.height }
  })
  await page.mouse.move(r.left + 0.45 * r.width, r.top + 0.2 * r.height)
  await sleep(400)
  console.log('readout through the edit:', await text('.status-coords'))
  await shot('e17b-readout')
}

// A bookmark of the view, kept in the file's coordinates.
await page.click('button[title^="Bookmark this view"]')
await sleep(500)
const bookmarks = () => page.evaluate(() => [...document.querySelectorAll('.bookmark-coords')].map((row) => row.textContent))
console.log('bookmark kept at:', await bookmarks())

// Marks on the edited map, from the Manual annotations card: a box drawn inside
// the turned stretch, and a line typed at a place in the file. Both are kept in
// the file's coordinates — the card's rows say where — and drawn where the edit
// puts them: the box where it was drawn, the line mirrored through the turn.
await fold('Show the Annotations panel')
const along = await diagonalAt('IV_e1')
if (along === null) console.log('marks: no readout to place the box by')
else {
  await form('Rectangles').locator('button', { hasText: /^draw on map$/ }).click()
  await sleep(300)
  await drag(along(1_120_000), along(1_160_000))
  await page.keyboard.press('Escape')
  await sleep(300)
}
await form('Lines').locator('input.input').first().fill('IV:1,250,000')
await form('Lines').locator('button', { hasText: /^add$/ }).click()
await sleep(1200)
const marks = () => page.evaluate(() => [...document.querySelectorAll('.manual-mark .manual-where')].map((row) => row.textContent))
console.log('marks kept at:', await marks())
await shot('e18-marks')

// The Chromosomes table, which lists the edited assembly.
await page.click('.breadcrumb >> text=Chromosomes')
await sleep(2500)
console.log('table names IV_e1:', /IV_e1/.test(await page.evaluate(() => document.body.innerText)))
await shot('e19-chromosomes')
await page.goBack()
await sleep(3000)

// The dark theme.
await page.emulateMedia({ colorScheme: 'dark' })
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await openStage()
await settled()
console.log('suggested in the dark:', await suggestions())
await shot('e20-dark')

// Turned down, from the rail with N: struck through in the list, gone from the
// map, and learned from — then offered again.
await page.hover('.edit-rail-label')
await sleep(300)
await page.keyboard.press('n')
await sleep(200)
await settled()
await page.click('.edit-declined > summary')
await sleep(300)
console.log('turned down:', await page.evaluate(() => [...document.querySelectorAll('.edit-declined-words')].map((row) => row.textContent)))
await shot('e21-turned-down')
await page.click('.edit-declined-list button')
await sleep(200)
await settled()

// Auto: every suggestion at even odds or more, applied best first, each a step
// marked auto.
await page.click('.edit-modes >> text=auto')
await sleep(400)
console.log('auto offers:', await text('.edit-suggestions-card .edit-acts'))
await shot('e22-auto')
await page.click('.edit-suggestions-card .edit-acts button')
await sleep(600)
await settled()
console.log('after auto:', await history())
await shot('e23-auto-applied')
await page.click('.modal-panel .btn-close')
await sleep(800)
await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
await page.emulateMedia({ colorScheme: 'light' })

// Reverted: the arrow beside the chip puts the file back, as one more undo.
await page.click('.crumb-reference-revert')
for (let i = 0; i < 60; i++) {
  await sleep(500)
  if (!/IV_e1/.test((await text('.breadcrumb')) ?? '')) break
}
await sleep(3000)
console.log('after revert:', (await text('.crumb-reference'))?.trim(), '·', (await text('.breadcrumb'))?.replace(/\s+/g, ' '))
console.log('marks still at:', await marks())
await shot('e24-reverted')

// The bookmark taken on the edited map, gone back to on the file as it is:
// where the file has that stretch.
await fold('Show the Annotations panel')
await page.evaluate(() => {
  const card = [...document.querySelectorAll('.annotation-card')].find((c) => /Bookmarks/.test(c.querySelector('.card-head')?.textContent ?? ''))
  if (card?.querySelector('.bookmark-go') === null || card?.querySelector('.bookmark-go')?.offsetParent === null) card?.querySelector('.card-head')?.click()
  card?.scrollIntoView({ block: 'center' })
})
await sleep(400)
const go = await page.$('.bookmark-go')
if (go === null) console.log('bookmark: no row to go to')
else {
  await go.click()
  await sleep(3500)
  console.log('bookmark opened at:', (await text('.breadcrumb'))?.replace(/\s+/g, ' '))
  await shot('e24b-bookmark-reverted')
}

// The dev features off: no word on the reference, no command.
await page.evaluate(() => localStorage.removeItem('metacooler-viewer:dev-features'))
await page.reload()
await sleep(7000)
console.log('dev off · heading has the reference:', (await page.$('.crumb-reference')) !== null)
await shot('e25-dev-off')

if (errors.length > 0) console.log('page errors:', errors)
await browser.close()
