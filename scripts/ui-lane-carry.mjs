/**
 * Carry a lane off its map by its grip, in headless Chromium, to every place
 * that takes one (§16.9): the other map's edge, a `+` edge of the deck, an
 * empty cell, and a cell drawing tracks; a row of the Structures card dropped
 * on a `+` edge; and a lane carried off a lone map onto its `+`, which opens
 * the deck.
 *
 * Each landing is a **move**: the lane is drawn where it was let go and taken
 * off the map it came from. So beside the pictures it prints, per cell, how
 * thick each of its lane stacks is — a stack that loses a lane gets thinner,
 * one that gains it gets thicker — and which cells the grid holds.
 *
 * The grip is found the way a reader finds it: by the open hand the lane
 * canvas shows over it (`is-grab`), hunted for with pointer moves sent into the
 * page, since where it sits depends on the lane's height and name.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-lane-carry.mjs [out-dir]
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
const errors = []
const fresh = async () => {
  const next = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
let page = await fresh()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}

/** The grid in reading order, and per cell the thickness of each lane stack it draws. */
const cells = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.deck-grid > .deck-panel')).map((cell) => {
      const name = cell.querySelector('.deck-name')
      const text = (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim()
      const kind = cell.classList.contains('deck-structure')
        ? '3d'
        : cell.classList.contains('deck-tracks')
          ? 'tracks'
          : cell.classList.contains('is-vacant')
            ? 'empty'
            : 'map'
      const stacks = {}
      for (const lane of cell.querySelectorAll('.lane-canvas')) {
        if (lane.classList.contains('hidden')) continue
        const edge = ['top', 'right', 'bottom', 'left'].find((side) => lane.classList.contains(`lane-${side}`)) ?? '?'
        const box = lane.getBoundingClientRect()
        const across = edge === 'top' || edge === 'bottom' ? box.height : box.width
        if (across > 0) stacks[edge] = Math.round(across)
      }
      const browserLanes = cell.querySelectorAll('.browser-canvas').length
      return `${kind} ${text}${Object.keys(stacks).length > 0 ? ' ' + JSON.stringify(stacks) : ''}${browserLanes > 0 ? ' (1D browser)' : ''}`
    }),
  )

/**
 * The grip of the lane nearest the map on an edge of the cell at `index`, as
 * a point on the page: the first point, scanning outward from the map, where
 * the lane canvas shows the open hand.
 */
const gripOf = (index, edge) =>
  page.evaluate(
    ({ index, edge }) => {
      const cell = document.querySelectorAll('.deck-grid > .deck-panel')[index]
      const canvas = cell?.querySelector(`.lane-canvas.lane-${edge}:not(.hidden)`)
      if (!(canvas instanceof HTMLCanvasElement)) return null
      const box = canvas.getBoundingClientRect()
      const horizontal = edge === 'top' || edge === 'bottom'
      const along = horizontal ? box.width : box.height
      const across = horizontal ? box.height : box.width
      for (let a = 0; a < across; a += 2) {
        // Outward from the map: down a bottom stack, up a top one.
        const at = edge === 'bottom' || edge === 'right' ? a : across - 1 - a
        for (let b = 0; b < Math.min(along, 160); b += 2) {
          const x = horizontal ? box.left + b : box.left + at
          const y = horizontal ? box.top + at : box.top + b
          canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerId: 1 }))
          if (canvas.classList.contains('is-grab')) return { x, y }
        }
      }
      return null
    },
    { index, edge },
  )

/** Take a grip and carry it to a point, in steps, shooting it in the air before letting go. */
const carry = async (from, to, name) => {
  await page.mouse.move(from.x, from.y)
  await sleep(200)
  await page.mouse.down()
  const steps = 24
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await sleep(25)
  }
  await sleep(400)
  if (name !== undefined) await shot(name)
  await page.mouse.up()
  await sleep(3000)
}

/** The middle of an element's box. */
const middle = async (selector) => {
  const box = await page.locator(selector).first().boundingBox()
  return box === null ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .lane-canvas:not(.hidden)').length >= 1, null, { timeout: 120000 })
  await sleep(6000)
  console.log('deck:', JSON.stringify(await cells()))
  await shot('lc1-deck-as-opened')

  // -------------------------------------------------------------------------
  // A lane under the first map, carried onto the second map's top edge.
  // -------------------------------------------------------------------------
  const first = await gripOf(0, 'bottom')
  console.log('grip of the first map’s nearest bottom lane:', JSON.stringify(first))
  const second = await page.locator('.deck-grid > .deck-panel').nth(1).locator('.heatmap-canvas').boundingBox()
  if (first !== null && second !== null) {
    await carry(first, { x: second.x + second.width / 2, y: second.y + 12 }, 'lc2-lane-over-the-other-maps-top')
    console.log('after the lane landed on the other map’s top:', JSON.stringify(await cells()))
    await shot('lc3-lane-moved-to-the-other-map')
  }

  // -------------------------------------------------------------------------
  // The next lane, carried onto the `+` beside the deck.
  // -------------------------------------------------------------------------
  const next = await gripOf(0, 'bottom')
  const plus = await middle('.deck-grow.is-beside')
  console.log('next grip:', JSON.stringify(next), '· + beside at:', JSON.stringify(plus))
  if (next !== null && plus !== null) {
    await carry(next, plus, 'lc4-lane-over-the-plus')
    console.log('after the lane landed on the +:', JSON.stringify(await cells()))
    await shot('lc5-lane-in-a-cell-of-its-own')
  }

  // -------------------------------------------------------------------------
  // The lane now on the second map, carried into the tracks cell just made.
  // -------------------------------------------------------------------------
  const moved = await gripOf(1, 'top')
  const tracks = await middle('.deck-grid > .deck-tracks')
  console.log('grip on the second map’s top:', JSON.stringify(moved), '· tracks cell at:', JSON.stringify(tracks))
  if (moved !== null && tracks !== null) {
    await carry(moved, tracks, 'lc6-lane-over-the-tracks-cell')
    console.log('after the lane landed in the tracks cell:', JSON.stringify(await cells()))
    await shot('lc7-tracks-cell-draws-both')
  }

  // -------------------------------------------------------------------------
  // An empty cell: the + below pressed with nothing in the hand. A lane put
  // back under the first map from the Tracks card — a *placement*, the card's
  // way — then carried by its grip into that empty cell.
  // -------------------------------------------------------------------------
  await page.locator('.deck-grow.is-below').first().click()
  await sleep(2000)
  await fold('Show the Annotations panel')
  await page.evaluate(() => {
    const cell = document.querySelectorAll('.deck-grid > .deck-panel')[0]
    const zone = cell?.querySelector('.lane-drop-bottom')
    if (zone === null || zone === undefined) throw new Error('no bottom edge on the first map')
    const transfer = new DataTransfer()
    transfer.setData('application/x-metacooler-track', 'demo-atac')
    for (const kind of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await fold('Fold the Annotations panel')
  await sleep(3000)
  console.log('with an empty row, ATAC put back under the first map:', JSON.stringify(await cells()))
  await shot('lc8-empty-row-and-atac-back')
  const last = await gripOf(0, 'bottom')
  const vacant = await middle('.deck-grid > .is-vacant')
  console.log('grip on the first map’s bottom:', JSON.stringify(last), '· empty cell at:', JSON.stringify(vacant))
  if (last !== null && vacant !== null) {
    await carry(last, vacant, 'lc9-lane-over-the-empty-cell')
    console.log('after the lane landed in the empty cell:', JSON.stringify(await cells()))
    await shot('lc10-empty-cell-draws-it')
  }

  // -------------------------------------------------------------------------
  // A row of the Structures card, dropped on a `+`.
  // -------------------------------------------------------------------------
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await sleep(5000)
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
  await sleep(5000)
  console.log('with the model:', JSON.stringify(await cells()))
  await shot('lc11-model-where-the-eye-put-it')
  const dropped = await page.evaluate(() => {
    const row = document.querySelector('.structure-card .ann-row[data-id]')
    const grow = document.querySelector('.deck-grow.is-below')
    const id = row?.getAttribute('data-id') ?? ''
    if (grow === null || id === '') return ''
    const transfer = new DataTransfer()
    transfer.setData('application/x-metacooler-structure', id)
    for (const kind of ['dragenter', 'dragover', 'drop']) grow.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    return id
  })
  await sleep(5000)
  console.log('Structures row', dropped, 'dropped on the + below:', JSON.stringify(await cells()))
  await fold('Fold the Annotations panel')
  await sleep(1500)
  // The new row is below the fold: bring the model's cell up to be seen.
  await page.locator('.deck-grid > .deck-structure').first().evaluate((node) => node.scrollIntoView({ block: 'end' }))
  await sleep(2500)
  await shot('lc12-model-moved-to-the-new-row')

  // -------------------------------------------------------------------------
  // A lone map, no deck yet: a lane carried onto its `+` opens the deck with a
  // tracks cell drawing it — the session's own edges, before there are cells.
  // -------------------------------------------------------------------------
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.lane-canvas:not(.hidden)').length > 0, null, { timeout: 120000 })
  await sleep(6000)
  const loneGrip = await page.evaluate(() => {
    const canvas = document.querySelector('.lane-canvas.lane-bottom:not(.hidden)')
    if (!(canvas instanceof HTMLCanvasElement)) return null
    const box = canvas.getBoundingClientRect()
    for (let a = 0; a < box.height; a += 2) {
      for (let b = 0; b < 160; b += 2) {
        canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + b, clientY: box.top + a, bubbles: true, pointerId: 1 }))
        if (canvas.classList.contains('is-grab')) return { x: box.left + b, y: box.top + a }
      }
    }
    return null
  })
  const lonePlus = await middle('.deck-grow.is-beside')
  console.log('lone map, grip:', JSON.stringify(loneGrip), '· + beside at:', JSON.stringify(lonePlus))
  if (loneGrip !== null && lonePlus !== null) {
    await carry(loneGrip, lonePlus, 'lc13-lone-map-lane-over-the-plus')
    console.log('after the lane landed on the lone map’s +:', JSON.stringify(await cells()))
    await page.mouse.move(5, 500)
    await sleep(800)
    await shot('lc14-lone-map-lane-in-a-new-cell')
  }

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
