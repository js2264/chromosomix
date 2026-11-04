/**
 * A deck cell's heading in narrow cells (§16.9), end to end in headless Chromium.
 *
 * Every heading — a grip, the name, then the cell's controls — has to stay in
 * its cell. Where the name cannot keep 6rem beside the controls they go,
 * together, to a line under it at the cell's right; in a cell narrower still
 * they wrap again inside it. Before, four maps across a column with two side
 * panels open ran each cell's chain over the next cell's grip and name.
 *
 * The yeast cooler at 1600 × 1000 with General and Annotations open, at two,
 * three, four and five maps across; the E. coli `.mcool`, whose headings carry
 * a rung picker as well, four across; a mixed deck of four — the map, a model
 * dropped on the Structures card, a tracks cell and an empty cell; three across
 * on a 1280-pixel laptop; and four across in the dark theme.
 *
 * Every step prints each cell's width, its heading's lines, the name's width
 * and how many of the heading's parts reach outside the cell — which has to be
 * none — so a heading that spills is a line here as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-deck-heads.mjs [out-dir]
 *
 * `GALLERY_ONLY=across`, `mcool`, `mixed`, `laptop` or `dark` runs one part.
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
const ONLY = process.env.GALLERY_ONLY ?? ''
const want = (part) => ONLY === '' || ONLY === part
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const YEAST = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`
const ECOLI = `${BASE}/demo/ecoli/Ecoli.mcool::/resolutions/5000`

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let spilled = 0

async function fresh(width = 1600, height = 1000) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light' })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return page
}

const fold = async (page, title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}

/** A deck opened from its address, every map drawn, the Annotations column shown. */
async function openDeck(page, uri, maps, region, drawn) {
  await page.goto(`${BASE}/#uri=${uri}&view=region&region=${region}&maps=${maps.join('|')}`)
  await page
    .waitForFunction((n) => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= n, drawn, { timeout: 180000 })
    .catch(() => console.log(`!! fewer than ${drawn} maps drew`))
  await sleep(3000)
  await fold(page, 'Show the Annotations panel')
  await sleep(2000)
}

/** Each cell on screen: its width, its heading's lines, its name's width, and what of the heading leaves it. */
async function measure(page, step) {
  const cells = await page.evaluate(() =>
    [...document.querySelectorAll('.deck-grid > .deck-panel:not(.is-parked)')].map((cell) => {
      const box = cell.getBoundingClientRect()
      const head = cell.querySelector('.deck-head:not(.hidden)')
      const outside = []
      for (const node of head?.querySelectorAll('*') ?? []) {
        if (node.closest('.hidden') !== null || getComputedStyle(node).display === 'none') continue
        const b = node.getBoundingClientRect()
        if (b.width === 0) continue
        if (b.right > box.right + 0.5 || b.left < box.left - 0.5) {
          outside.push(String(node.className?.baseVal ?? node.className))
        }
      }
      const name = head?.querySelector('.deck-name')
      const tools = head?.querySelector('.deck-tools')
      const nameBox = name?.getBoundingClientRect()
      const toolsBox = tools?.getBoundingClientRect()
      const kind = cell.classList.contains('is-lead')
        ? 'lead'
        : cell.classList.contains('deck-structure')
          ? '3d'
          : cell.classList.contains('deck-tracks')
            ? 'tracks'
            : cell.classList.contains('is-vacant')
              ? 'empty'
              : 'map'
      const shown = name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')
      return {
        kind,
        cell: Math.round(box.width),
        heading: Math.round(head?.getBoundingClientRect().height ?? 0),
        under: nameBox !== undefined && toolsBox !== undefined && toolsBox.top >= nameBox.bottom - 2,
        name: Math.round(nameBox?.width ?? 0),
        says: shown.trim(),
        outside,
      }
    }),
  )
  console.log(`--- ${step}`)
  for (const cell of cells) {
    console.log(
      `  ${cell.kind.padEnd(6)} cell ${String(cell.cell).padStart(4)} px · heading ${String(cell.heading).padStart(3)} px · ` +
        `controls ${cell.under ? 'under the name' : 'beside it'} · name ${cell.name} px «${cell.says}»` +
        (cell.outside.length === 0 ? '' : ` · !! OUTSIDE THE CELL: ${cell.outside.join(', ')}`),
    )
    spilled += cell.outside.length
  }
}

/** The deck's own box, with its bar, so the headings are legible at full size. */
async function deckShot(page, name) {
  const box = await page.locator('.deck').first().boundingBox()
  if (box === null) {
    console.log('!! no deck for', name)
    return
  }
  const pad = 8
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + 2 * pad,
      height: Math.min(box.height + 2 * pad, 520),
    },
  })
  console.log('shot', name)
}

try {
  // Two to five yeast maps across, General and Annotations open.
  for (const across of want('across') ? [2, 3, 4, 5] : []) {
    const page = await fresh()
    await openDeck(page, YEAST, Array.from({ length: across - 1 }, () => YEAST), 'IV:1000000-1400000', across)
    await measure(page, `${across} across, 1600 px`)
    if (across === 4) {
      await page.screenshot({ path: `${OUT}/dh01-four-across-page.png` })
      console.log('shot dh01-four-across-page')
    }
    await deckShot(page, `dh0${across}-${across}-across`)
    if (across === 4) {
      // A companion with a window of its own (§16.3): its chain opened and a
      // box drawn on it, which puts the window's pill among its controls.
      await page.locator('.deck-grid > .deck-panel:not(.is-lead) .deck-lock').first().click()
      await sleep(800)
      const target = await page.locator('.deck-grid > .deck-panel:not(.is-lead) .heatmap-canvas').first().boundingBox()
      if (target !== null) {
        const at = (f) => [target.x + target.width * f, target.y + target.height * f]
        const [x0, y0] = at(0.3)
        const [x1, y1] = at(0.6)
        await page.mouse.move(x0, y0)
        await page.keyboard.down('Alt')
        await page.keyboard.down('Shift')
        await page.mouse.down()
        await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 })
        await page.mouse.move(x1, y1, { steps: 5 })
        await page.mouse.up()
        await page.keyboard.up('Shift')
        await page.keyboard.up('Alt')
      }
      await page
        .waitForFunction(() => document.querySelector('.deck-place:not(.hidden)') !== null, null, { timeout: 30000 })
        .catch(() => console.log('!! no window of its own on the companion'))
      await sleep(4000)
      await measure(page, '4 across, a companion on a window of its own')
      await deckShot(page, 'dh04b-4-across-own-window')
    }
    await page.close()
  }

  // A collection's maps: the rung picker in every heading as well.
  if (want('mcool')) {
    const page = await fresh()
    await openDeck(page, ECOLI, [ECOLI, ECOLI, ECOLI], 'NC_000913.3:1-1500000', 4)
    await measure(page, 'E. coli .mcool, 4 across')
    await deckShot(page, 'dh06-mcool-four-across')
    await page.close()
  }

  // A mixed deck: the map, a model, a tracks cell and an empty cell.
  if (want('mixed')) {
    const page = await fresh()
    await openDeck(page, YEAST, ['tracks'], 'IV:1000000-1400000', 1)
    await page.evaluate(async (url) => {
      const card = document.querySelector('.structure-card')
      if (card === null) throw new Error('no Structures card')
      const bytes = await (await fetch(url)).arrayBuffer()
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' }))
      for (const kind of ['dragenter', 'dragover', 'drop']) {
        card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
    }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
    await page.waitForSelector('.deck-structure canvas', { timeout: 120000 }).catch(() => console.log('!! no structure cell'))
    // An empty cell, as a reader opens one: the `+` beside the deck.
    await page.locator('.deck-grow.is-beside').first().click()
    await page
      .waitForFunction(() => document.querySelectorAll('.deck-grid > .deck-panel').length >= 4, null, { timeout: 30000 })
      .catch(() => console.log('!! fewer than four cells'))
    await sleep(5000)
    await measure(page, 'a map, a model, a tracks cell and an empty cell')
    await deckShot(page, 'dh07-mixed-deck')
    await page.close()
  }

  // A laptop: three across in 1280 pixels.
  if (want('laptop')) {
    const page = await fresh(1280, 800)
    await openDeck(page, YEAST, [YEAST, YEAST], 'IV:1000000-1400000', 3)
    await measure(page, '3 across, 1280 px')
    await page.screenshot({ path: `${OUT}/dh08-laptop-three-across.png` })
    console.log('shot dh08-laptop-three-across')
    await page.close()
  }

  // Dark.
  if (want('dark')) {
    const page = await fresh()
    await openDeck(page, YEAST, [YEAST, YEAST, YEAST], 'IV:1000000-1400000', 4)
    // As `ui-tour.mjs` reaches it, and asserted as it is there: `t` steps the
    // theme, and a shot called dark that came out light would be a picture
    // that lies about the app.
    const dark = () =>
      page.evaluate(() => {
        const panel = document.querySelector('.panel-column') ?? document.body
        const [r, g, b] = getComputedStyle(panel).backgroundColor.match(/\d+/g).slice(0, 3).map(Number)
        return (r + g + b) / 3 < 96
      })
    await page.locator('.deck-bar').first().click({ position: { x: 2, y: 2 } }).catch(() => undefined)
    await page.keyboard.press('t')
    await sleep(1200)
    for (let tries = 0; tries < 3 && !(await dark()); tries++) {
      await page.click('button[title^="Theme:"]')
      await sleep(900)
    }
    if (!(await dark())) console.log('!! the dark theme was not reached')
    await sleep(1500)
    await measure(page, '4 across, dark')
    await page.screenshot({ path: `${OUT}/dh09-dark-four-across.png` })
    console.log('shot dh09-dark-four-across')
    await page.close()
  }
} finally {
  console.log(spilled === 0 ? 'every heading inside its cell' : `!! ${spilled} parts of headings outside their cells`)
  if (errors.length > 0) console.log('page errors:', errors)
  await browser.close()
}
