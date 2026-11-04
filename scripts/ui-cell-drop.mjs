/**
 * The Contact maps card's *Load a map into a cell of its own* (§16.9), end to
 * end in headless Chromium.
 *
 * The yeast cooler open on IV, the Annotations column shown: the card with its
 * two rectangles, the triangle's and the cell's; the cell's lit under a drag of
 * files; two coolers let go on it together, which is a deck of three, its hint
 * saying *maps*; a third cooler on the triangle's rectangle, which goes, and
 * the cell's stays under the full square; a fourth through the cell's chooser;
 * a row of the Files column dragged onto it; and the card in the dark theme.
 *
 * Every step prints the card's rows, its rectangles and the deck's cells, so a
 * map that went to the wrong place is a line here as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-cell-drop.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const COOL_PATH = 'demo/yeast/Yeast_microC_G2M_1kb.cool'
const COOL = `${BASE}/${COOL_PATH}`
const REGION = 'IV:1000000-1400000'

/** Copies of the yeast cooler under names of their own: one chosen, one in a folder. */
const DISK = mkdtempSync(join(tmpdir(), 'cell-drop-'))
mkdirSync(join(DISK, 'maps'))
copyFileSync(join(ROOT, COOL_PATH), join(DISK, 'Yeast_rep4.cool'))
copyFileSync(join(ROOT, COOL_PATH), join(DISK, 'maps', 'Yeast_rep5.cool'))

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
// A browser with no directory picker connects a folder as a snapshot, which an
// input can answer.
await context.addInitScript(() => {
  delete window.showDirectoryPicker
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
/** The Contact maps card alone, with a margin of the column round it. */
const cardShot = async (name) => {
  const box = await page.locator('.compare-card').first().boundingBox()
  if (box === null) {
    console.log('!! no Contact maps card for', name)
    return
  }
  const pad = 12
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad },
  })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
/** Every map's veil down, after a draw has had time to start. */
const settled = async (timeout = 180000) => {
  await sleep(1500)
  await page
    .waitForFunction(
      () => [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
      null,
      { timeout },
    )
    .catch(() => console.log('!! a veil stayed up'))
  await sleep(1500)
}
/** What the card lists and asks for, and what the deck holds. */
const said = async (step) => {
  const state = await page.evaluate(() => {
    const card = document.querySelector('.compare-card')
    const rows = [...(card?.querySelectorAll('.compare-row') ?? [])].map((row) => {
      const name = row.querySelector('.ann-name')
      const text = name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')
      const mark = row.querySelector('.compare-mark')?.textContent ?? ''
      return `${mark}${text.trim()}`
    })
    const zones = [...(card?.querySelectorAll('.ann-drop') ?? [])].map(
      (zone) =>
        `${zone.querySelector('.ann-drop-label')?.textContent} — ${zone.querySelector('.ann-drop-hint')?.textContent}`,
    )
    const cells = [...document.querySelectorAll('.deck-grid > .deck-panel')].map((cell) => {
      const name = cell.querySelector('.deck-name')
      return (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim() || '(no name)'
    })
    const hash = new URLSearchParams(location.hash.slice(1))
    return { rows, zones, cells, maps: hash.get('maps'), uri2: hash.get('uri2') }
  })
  console.log(`--- ${step}:\n${JSON.stringify(state, null, 2)}`)
  return state
}
/** Coolers fetched from the dev server and let go on a rectangle of the card, as a reader drops them. */
const dropOn = async (text, files) => {
  await page.evaluate(
    async ({ text, files, url }) => {
      const blob = await (await fetch(url)).blob()
      const transfer = new DataTransfer()
      for (const name of files) transfer.items.add(new File([blob], name))
      const zone = [...document.querySelectorAll('.compare-card .ann-drop')].find((node) =>
        (node.textContent ?? '').includes(text),
      )
      if (zone === undefined) throw new Error(`no rectangle saying ${text}`)
      for (const kind of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
    },
    { text, files, url: COOL },
  )
}
const cellZone = () => page.locator('.compare-card .ann-drop', { hasText: 'a cell of its own' }).first()

try {
  await page.goto(`${BASE}/#uri=${COOL}&view=region&region=${REGION}`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await settled()
  await fold('Show the Annotations panel')
  await page.waitForSelector('.compare-card', { timeout: 20000 })
  await said('one map')
  await shot('cd01-one-map')
  await cardShot('cd01b-card-one-map')

  // A drag of files over the cell's rectangle, held there: lit, as the
  // triangle's is.
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['x'], 'held.cool'))
    const zone = [...document.querySelectorAll('.compare-card .ann-drop')].find((node) =>
      (node.textContent ?? '').includes('a cell of its own'),
    )
    zone?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  // Past the zone's transition into its lit colours.
  await sleep(600)
  await cardShot('cd02-cell-lit')
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('.compare-card .ann-drop.over')) {
      node.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
    }
  })

  // Two coolers let go together: a deck of three.
  await dropOn('a cell of its own', ['Yeast_rep2.cool', 'Yeast_rep3.cool'])
  await page
    .waitForFunction(() => document.querySelectorAll('.deck-grid > .deck-panel').length >= 2, null, { timeout: 60000 })
    .catch(() => console.log('!! no deck after two coolers on the cell rectangle'))
  await page.waitForFunction(() => document.querySelectorAll('.heatmap-canvas').length >= 3, null, { timeout: 180000 }).catch(() => console.log('!! three maps never drew'))
  await settled()
  const deck = await said('two coolers on the cell rectangle')
  if (deck.cells.length < 3) console.log('!! expected three cells')
  await shot('cd03-two-dropped')
  await cardShot('cd03b-card-deck-of-three')

  // A third on the triangle's rectangle: it goes, and the cell's stays.
  await dropOn('lower triangle', ['Yeast_G1.cool'])
  // The marks and not `uri2`: a local second file is not in the link (§5.7).
  await page
    .waitForFunction(() => document.querySelector('.compare-card .compare-lower') !== null, null, { timeout: 60000 })
    .catch(() => console.log('!! no lower triangle after the triangle drop'))
  await settled()
  const square = await said('a cooler in the lower triangle')
  if (!square.zones.some((zone) => zone.includes('a cell of its own'))) console.log('!! the cell rectangle went with the triangle')
  await shot('cd04-square-full')
  await cardShot('cd04b-card-square-full')

  // A fourth through the cell rectangle's chooser.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), cellZone().click()])
  console.log('chooser takes several:', chooser.isMultiple())
  await chooser.setFiles(join(DISK, 'Yeast_rep4.cool'))
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid > .deck-panel').length >= 4, null, { timeout: 60000 }).catch(() => console.log('!! no fourth cell after the chooser'))
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 4, null, { timeout: 180000 }).catch(() => console.log('!! four maps never drew'))
  await settled()
  await said('a cooler chosen')
  await shot('cd05-chosen')

  // A row of the Files column dragged onto it.
  await page.keyboard.press('Control+p')
  await sleep(400)
  await page.keyboard.type('folder')
  await sleep(400)
  await page.keyboard.press('Enter')
  await sleep(900)
  const [folder] = await Promise.all([page.waitForEvent('filechooser'), page.click('.connect-signin button')])
  await folder.setFiles(join(DISK, 'maps'))
  await sleep(1500)
  await page.waitForSelector('.folder-entry-file', { timeout: 20000 })
  await fold('Show the Annotations panel')
  const row = page.locator('.folder-entry-file', { hasText: 'Yeast_rep5.cool' }).first()
  await row.dragTo(cellZone())
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid > .deck-panel').length >= 5, null, { timeout: 60000 }).catch(() => console.log('!! no fifth cell after the Files row'))
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 5, null, { timeout: 180000 }).catch(() => console.log('!! five maps never drew'))
  await settled()
  await said('a Files row on the cell rectangle')
  await cardShot('cd06-card-files-row')
  // Room for five cells: the Files and General columns folded, the card kept.
  await fold('Fold the Files panel')
  await fold('Fold the General panel')
  await settled()
  await shot('cd06b-deck-of-five')

  // The dark theme.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await sleep(800)
  await cardShot('cd07-card-dark')
} finally {
  if (errors.length > 0) console.log('page errors:', errors)
  await browser.close()
}
