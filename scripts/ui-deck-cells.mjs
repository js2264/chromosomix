/**
 * Tracks cells and structure cells of the deck, in headless Chromium (§16.9,
 * §25.3, §25.4):
 *
 * - a lane carried onto a `+` opens a tracks cell — its axis and its lanes, no
 *   locus box and no zoom steps;
 * - a pointer on a cell of the map off its diagonal puts a hairline in the
 *   tracks cell at **both** ends of the contact;
 * - a second tracks cell headed `tracks 2`, as the location control lists it;
 * - the tracks cell renamed from its heading, and the location control naming
 *   it so, with no track renamed;
 * - a lane in the tracks cell carried out of it by its grip, onto a map's top;
 * - a track drawn along two sides of a map, one of them carried to a `+`: the
 *   cell draws it and the map keeps the other side;
 * - the Structures card's eye following the deck: lit by a row dropped on a
 *   `+`, dark once the cell is closed from its heading, lit again;
 * - the structure cell renamed from its heading, and its row on the card with it;
 * - a track beside the map — the demo's Pol II, which grows away from it — put
 *   in a tracks cell, reading up the page;
 * - the bar under a cell that sets its height: a tracks cell's dragged taller
 *   and double-clicked back to its row, and a structure cell's dragged too.
 *
 * It prints what each step left behind — the cells, which edges each track is
 * on, the eye — beside the pictures.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-deck-cells.mjs [out-dir]
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
const shotOf = async (selector, name, pad = 6) => {
  const box = await page.locator(selector).first().boundingBox()
  if (box === null) { console.log('nothing to shoot for', name); return }
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const open = async (config) => {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/${config}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .lane-canvas:not(.hidden)').length >= 1, null, { timeout: 120000 })
  await sleep(6000)
}

/** The grid in reading order: each cell's kind and the name on its heading. */
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
      const stacks = []
      for (const lane of cell.querySelectorAll('.lane-canvas')) {
        if (lane.classList.contains('hidden')) continue
        const edge = ['top', 'right', 'bottom', 'left'].find((side) => lane.classList.contains(`lane-${side}`)) ?? '?'
        const box = lane.getBoundingClientRect()
        if ((edge === 'top' || edge === 'bottom' ? box.height : box.width) > 0) stacks.push(edge)
      }
      return `${kind} “${text}”${stacks.length > 0 ? ` lanes: ${stacks.join(' ')}` : ''}`
    }),
  )

/** Which edges a track is lit on, per line of its location control: `name: bottom left`. */
const lit = (id) =>
  page.evaluate((id) => {
    const field = document.querySelector(`.annotation-card .ann-row[data-id="${id}"] .ann-field-places`)
    if (field === null) return 'no location field'
    const read = (host) =>
      Array.from(host.querySelectorAll('.ann-place'))
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.dataset.edge)
        .join(' ')
    const lines = field.querySelectorAll('.ann-place-map')
    if (lines.length === 0) return read(field) || 'nowhere'
    return Array.from(lines).map((line) => `${line.querySelector('.ann-place-name')?.textContent}: ${read(line) || 'nowhere'}`)
  }, id)
const rowOf = (id) => page.locator(`.annotation-card .ann-row[data-id="${id}"]`)
const openRow = async (id) => {
  const row = rowOf(id)
  await row.scrollIntoViewIfNeeded()
  if ((await row.locator('.ann-field-places').count()) === 0) await row.locator('.ann-more').click()
  await sleep(600)
  await row.scrollIntoViewIfNeeded()
  return row
}
const trackNames = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.annotation-card .ann-row[data-id] .ann-name')).map((n) => (n.value ?? n.textContent ?? '').trim()),
  )

/**
 * The grip of the lane nearest the map on an edge of the cell at `index`: the
 * first point, scanning outward from the map, where the lane canvas shows the
 * open hand.
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

/** The grip of the first lane in a tracks cell: in the margin left of its names. */
const cellGrip = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.deck-grid > .deck-tracks .browser-canvas')
    if (!(canvas instanceof HTMLCanvasElement)) return null
    const box = canvas.getBoundingClientRect()
    for (let y = 0; y < box.height; y += 2) {
      for (let x = 0; x < 40; x += 1) {
        canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + x, clientY: box.top + y, bubbles: true, pointerId: 1 }))
        if (canvas.classList.contains('is-grab')) return { x: box.left + x, y: box.top + y }
      }
    }
    return null
  })

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
const middle = async (selector) => {
  const box = await page.locator(selector).first().boundingBox()
  return box === null ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
/** Drag the height bar under a cell by `dy` pixels; the picture's height before and after. */
const dragBar = async (bar, picture, dy, name) => {
  const box = await page.locator(bar).first().boundingBox()
  const before = await page.locator(picture).first().evaluate((node) => Math.round(node.getBoundingClientRect().height))
  if (box === null) return { before, after: before }
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(from.x, from.y)
  await sleep(300)
  await page.mouse.down()
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(from.x, from.y + (dy * i) / 16)
    await sleep(25)
  }
  await sleep(300)
  if (name !== undefined) await shot(name)
  await page.mouse.up()
  await sleep(1500)
  const after = await page.locator(picture).first().evaluate((node) => Math.round(node.getBoundingClientRect().height))
  return { before, after }
}

/** Type a name into a heading's box and press Enter, as a reader would. */
const rename = async (selector, name) => {
  const box = page.locator(selector).first()
  await box.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await sleep(800)
}

try {
  // -------------------------------------------------------------------------
  // A tracks cell: what it has in its heading and over its lanes.
  // -------------------------------------------------------------------------
  await open('Yeast_deck.chromosomix.json')
  console.log('deck:', JSON.stringify(await cells()))
  const first = await gripOf(0, 'bottom')
  const plus = await middle('.deck-grow.is-beside')
  if (first !== null && plus !== null) await carry(first, plus)
  await page.mouse.move(5, 500)
  await sleep(1500)
  console.log('a lane carried onto the + beside:', JSON.stringify(await cells()))
  const bar = await page.evaluate(() => {
    const cell = document.querySelector('.deck-grid > .deck-tracks')
    return {
      locusBox: cell?.querySelector('.input-region, .browser-search') !== null,
      zoomSteps: cell?.querySelector('.zoom-steps') !== null,
      head: cell?.querySelector('.view-head') !== null,
      locus: cell?.querySelector('.view-browser')?.dataset.locus ?? null,
    }
  })
  console.log('the tracks cell has:', JSON.stringify(bar))
  await shot('dc1-deck-with-a-tracks-cell')
  await shotOf('.deck-grid > .deck-tracks', 'dc2-tracks-cell-axis-only', 4)

  // A pointer on the first map, off its diagonal: two places.
  const heat = await page.locator('.deck-grid > .deck-panel').first().locator('.heatmap-canvas').boundingBox()
  if (heat !== null) {
    await page.mouse.move(heat.x + heat.width * 0.28, heat.y + heat.height * 0.7)
    await sleep(1200)
    await shot('dc3-pointer-off-the-diagonal')
    const map = await page.locator('.deck-grid > .deck-panel').first().boundingBox()
    const cell = await page.locator('.deck-grid > .deck-tracks').first().boundingBox()
    if (map !== null && cell !== null) {
      const x = Math.min(map.x, cell.x)
      const y = Math.min(map.y, cell.y)
      await page.screenshot({
        path: `${OUT}/dc4-both-anchors-in-the-tracks-cell.png`,
        clip: { x, y, width: Math.max(map.x + map.width, cell.x + cell.width) - x, height: Math.max(map.y + map.height, cell.y + cell.height) - y },
      })
      console.log('shot dc4-both-anchors-in-the-tracks-cell')
    }
    await page.mouse.move(5, 500)
    await sleep(600)
  }

  // A second tracks cell, from the bar: headed as the location control lists it.
  await page.click('.deck-add-toggle')
  await page.click('.deck-add-tracks')
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid > .deck-tracks').length >= 2, null, { timeout: 20000 })
  await sleep(2500)
  console.log('a second tracks cell:', JSON.stringify(await cells()))
  await shot('dc5-two-tracks-cells-numbered')

  // Renamed from its heading: the cell, not the track on it.
  await fold('Show the Annotations panel')
  console.log('track names before:', JSON.stringify(await trackNames()))
  await rename('.deck-grid > .deck-tracks .deck-name', 'G2M tracks')
  console.log('after the rename:', JSON.stringify(await cells()))
  console.log('track names after:', JSON.stringify(await trackNames()))
  await shotOf('.deck-grid > .deck-tracks .deck-head', 'dc6-tracks-cell-renamed', 4)
  const atac = await openRow('demo-atac')
  console.log('ATAC’s location lines:', JSON.stringify(await lit('demo-atac')))
  await atac.locator('.ann-field-places').screenshot({ path: `${OUT}/dc7-location-names-the-cells.png` })
  console.log('shot dc7-location-names-the-cells')
  await fold('Fold the Annotations panel')
  await sleep(2000)

  // The lane in the tracks cell, carried out of it onto the second map's top.
  const inCell = await cellGrip()
  const second = await page.locator('.deck-grid > .deck-panel').nth(1).locator('.heatmap-canvas').boundingBox()
  console.log('grip in the tracks cell:', JSON.stringify(inCell))
  if (inCell !== null && second !== null) {
    await carry(inCell, { x: second.x + second.width / 2, y: second.y + 12 }, 'dc8-cell-lane-over-the-maps-top')
    await page.mouse.move(5, 500)
    await sleep(1500)
    console.log('after it landed on the second map’s top:', JSON.stringify(await cells()))
    await shot('dc9-cell-lane-on-the-maps-top')
  }

  // -------------------------------------------------------------------------
  // One side of a track drawn on two, carried to a `+`.
  // -------------------------------------------------------------------------
  page = await fresh()
  await open('Yeast_deck.chromosomix.json')
  await fold('Show the Annotations panel')
  // The genes off the map for this, so the lane under it is ATAC's alone.
  await rowOf('demo-genes').locator('.ann-eye').first().click()
  await sleep(500)
  const both = await openRow('demo-atac')
  await both.locator('.ann-place-map').nth(0).locator('[data-edge="left"]').click()
  await sleep(1000)
  console.log('ATAC under and left of the first map:', JSON.stringify(await lit('demo-atac')))
  await fold('Fold the Annotations panel')
  await sleep(3000)
  console.log('cells:', JSON.stringify(await cells()))
  await shot('dc10-atac-under-and-left-of-the-map')
  const under = await gripOf(0, 'bottom')
  const beside = await middle('.deck-grow.is-beside')
  if (under !== null && beside !== null) await carry(under, beside, 'dc11-its-bottom-lane-over-the-plus')
  await page.mouse.move(5, 500)
  await sleep(1500)
  console.log('after the bottom lane landed on the +:', JSON.stringify(await cells()))
  await shot('dc12-left-lane-stays-cell-draws-it')
  await fold('Show the Annotations panel')
  await openRow('demo-atac')
  console.log('ATAC now:', JSON.stringify(await lit('demo-atac')))
  await fold('Fold the Annotations panel')

  // -------------------------------------------------------------------------
  // The Structures card's eye, and the structure cell's name.
  // -------------------------------------------------------------------------
  page = await fresh()
  await open('Yeast_deck.chromosomix.json')
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
  const eye = () =>
    page.evaluate(() => {
      const row = document.querySelector('.structure-card .ann-row[data-id]')
      const name = row?.querySelector('.ann-name')
      return {
        name: (name?.value ?? name?.textContent ?? '').trim(),
        eye: row?.querySelector('.ann-eye')?.getAttribute('aria-pressed') ?? null,
      }
    })
  const dropOnPlus = (which) =>
    page.evaluate((which) => {
      const row = document.querySelector('.structure-card .ann-row[data-id]')
      const grow = document.querySelector(`.deck-grow.is-${which}`)
      const id = row?.getAttribute('data-id') ?? ''
      if (grow === null || id === '') return ''
      const transfer = new DataTransfer()
      transfer.setData('application/x-chromosomix-structure', id)
      for (const kind of ['dragenter', 'dragover', 'drop']) grow.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      return id
    }, which)
  console.log('the model arrived:', JSON.stringify(await cells()), JSON.stringify(await eye()))
  // Closed from its own heading: the eye goes dark.
  await page.locator('.deck-grid > .deck-structure .btn-close').first().click()
  await sleep(2500)
  console.log('its cell closed from the heading:', JSON.stringify(await cells()), JSON.stringify(await eye()))
  await shot('dc13-cell-closed-eye-dark')
  await shotOf('.structure-card', 'dc14-structures-card-eye-dark', 4)
  // Its row dropped on the + beside: a cell, and the eye lit.
  console.log('dropped on the + beside:', await dropOnPlus('beside'))
  await page.waitForSelector('.deck-structure canvas', { timeout: 120000 })
  await sleep(5000)
  console.log('after the drop:', JSON.stringify(await cells()), JSON.stringify(await eye()))
  await shot('dc15-dropped-on-plus-eye-lit')
  await shotOf('.structure-card', 'dc16-structures-card-eye-lit', 4)
  // Renamed from the cell's heading: the row on the card is renamed with it.
  await rename('.deck-grid > .deck-structure .deck-name', 'G2M model')
  console.log('after renaming the cell:', JSON.stringify(await cells()), JSON.stringify(await eye()))
  await shot('dc17-structure-renamed-from-its-cell')
  await shotOf('.structure-card', 'dc18-structures-card-row-renamed', 4)
  // The structure cell's own bar, now drawn by the code the tracks cell shares.
  const model = await dragBar('.deck-grid > .deck-structure .structure-resize', '.deck-grid > .deck-structure .structure-wrap', 160)
  console.log('the structure cell dragged 160 px down:', JSON.stringify(model))
  await page.mouse.move(5, 500)
  await sleep(800)
  await shot('dc18b-structure-cell-taller')

  // -------------------------------------------------------------------------
  // A track beside the map, put in a tracks cell.
  // -------------------------------------------------------------------------
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.lane-canvas:not(.hidden)').length > 0, null, { timeout: 120000 })
  await sleep(6000)
  await page.locator('.deck-grow.is-beside').first().click()
  await sleep(2000)
  await page.click('.deck-add-toggle')
  await page.click('.deck-add-tracks')
  await page.waitForSelector('.deck-grid > .deck-tracks', { timeout: 20000 })
  await sleep(2000)
  await fold('Show the Annotations panel')
  const pol2 = await openRow('demo-pol2')
  await pol2
    .locator('.ann-place-map')
    .filter({ has: page.locator('.ann-place-name', { hasText: /^tracks$/ }) })
    .locator('[data-edge="bottom"]')
    .click()
  await sleep(2000)
  console.log('Pol II / input:', JSON.stringify(await lit('demo-pol2')))
  await fold('Fold the Annotations panel')
  await sleep(3000)
  console.log('cells:', JSON.stringify(await cells()))
  await shot('dc19-pol2-upright-in-a-tracks-cell')
  await shotOf('.deck-grid > .deck-tracks', 'dc20-pol2-in-the-tracks-cell', 4)

  // The bar under the tracks cell: lit under the hand, dragged down, and
  // double-clicked back to the row.
  const tracksBar = '.deck-grid > .deck-tracks .tracks-resize'
  const tracksWrap = '.deck-grid > .deck-tracks .tracks-wrap'
  const barBox = await page.locator(tracksBar).first().boundingBox()
  if (barBox !== null) await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2)
  await sleep(600)
  await shotOf('.deck-grid > .deck-tracks', 'dc21-tracks-cell-bar-lit', 4)
  const taller = await dragBar(tracksBar, tracksWrap, 220, 'dc22-tracks-cell-bar-dragged')
  console.log('the tracks cell dragged 220 px down:', JSON.stringify(taller))
  await page.mouse.move(5, 500)
  await sleep(800)
  console.log(
    'let go and left alone:',
    await page.locator(tracksWrap).first().evaluate((node) => Math.round(node.getBoundingClientRect().height)),
  )
  await shot('dc23-tracks-cell-taller')
  await page.locator(tracksBar).first().dblclick()
  await sleep(1500)
  const back = await page.locator(tracksWrap).first().evaluate((node) => Math.round(node.getBoundingClientRect().height))
  console.log('double-clicked back to the row:', back)
  await page.mouse.move(5, 500)
  await sleep(800)
  await shot('dc24-tracks-cell-back-to-the-row')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
