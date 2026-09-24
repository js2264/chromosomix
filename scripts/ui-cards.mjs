/**
 * Move cards by their headings in headless Chromium, and write what each step
 * looks like (§26.6).
 *
 * The arrangement is only worth anything if it survives the columns' own
 * rebuilds, so this does the rebuilds too: a card carried within Aesthetics and
 * one carried into it from Annotations, then a zoom (a new set of Aesthetics
 * cards), a reload, the General column rearranged across its nested hosts, a
 * press on a heading (which must still fold it), ⌥↓, a second tab and back, a
 * deck arriving (its 3D card must land after the Map card, wherever that is),
 * the Map card carried to General and a companion starred (the card there must
 * become the companion's), and the palette's reset. Prints every column's
 * cards after each step, so a card that did not come back is a line in the log.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-cards.mjs [out-dir]
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
const context = await browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: 1 })
const errors = []
const watch = (tab) => {
  tab.on('pageerror', (e) => errors.push(String(e)))
  tab.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return tab
}
let page = watch(await context.newPage())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
/** Every open column's cards, top to bottom; a folded card is marked ▸. */
const columns = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.panel-column')]
        .filter((c) => !c.classList.contains('is-absent'))
        .map((c) => [
          c.className.match(/panel-(general|annotations|aesthetics|analysis|files)/)?.[1],
          [...c.querySelectorAll('.panel-column-body .card-head')]
            .filter((h) => h.parentElement.matches('.card, .controls-card') && !h.parentElement.parentElement.closest('.card, .controls-card'))
            .map((h) => (h.parentElement.classList.contains('is-folded') ? '▸' : '') + h.textContent.trim()),
        ]),
    ),
  )
const log = async (what) => console.log(`${what}:`, JSON.stringify(await columns()))
const head = (column, title) =>
  page.locator(`.panel-${column} .panel-column-body .card-head`).filter({ hasText: new RegExp(`^${title}$`) }).first()
const cardOf = (column, title) => head(column, title).locator('..')
/**
 * Press a heading, carry it in small steps to just inside the top (`above`) or
 * bottom (`below`) of another card, and — unless told to hold — let go.
 */
async function carry(from, to, where, { hold = false } = {}) {
  await from.scrollIntoViewIfNeeded()
  const box = await from.boundingBox()
  const x = box.x + box.width * 0.3
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 8, y + 8)
  await sleep(50)
  const target = await to.boundingBox()
  const tx = target.x + 40
  const ty = where === 'above' ? target.y + 2 : target.y + target.height - 2
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(x + ((tx - x) * i) / 12, y + ((ty - y) * i) / 12)
    await sleep(30)
  }
  await sleep(200)
  const release = async () => {
    await page.mouse.up()
    await sleep(700)
  }
  if (hold) return release
  await release()
  return null
}
const openDemo = async (config) => {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/${config}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
}

try {
  await openDemo('Yeast_microC.metacooler.json')
  await page.evaluate(() => localStorage.removeItem('metacooler-viewer:card-layout'))
  await openDemo('Yeast_microC.metacooler.json')
  await fold('Show the Annotations panel')
  await log('as built')

  // Within Aesthetics: Export under the Map card, shot in the air.
  let release = await carry(head('aesthetics', 'Export'), cardOf('aesthetics', 'Map'), 'below', { hold: true })
  await shot('c1-card-in-the-air')
  await release()
  await log('Export under Map')
  // Across: Bookmarks from Annotations to the top of Aesthetics.
  release = await carry(head('annotations', 'Bookmarks'), cardOf('aesthetics', 'Map'), 'above', { hold: true })
  await shot('c2-carried-across')
  await release()
  await log('Bookmarks into Aesthetics')
  await shot('c3-after-two-drops')

  // A zoom builds Aesthetics anew; a reload builds everything anew.
  await page.locator('button', { hasText: /3×/ }).first().click()
  await sleep(3500)
  await log('after a zoom')
  await openDemo('Yeast_microC.metacooler.json')
  await log('after a reload')
  await shot('c4-after-reload')

  // General, whose cards sit in three different hosts: Metadata above File,
  // and Export carried in under Sequences.
  await carry(head('general', 'Metadata'), cardOf('general', 'File'), 'above')
  await carry(head('aesthetics', 'Export'), cardOf('general', 'Sequences'), 'below')
  await log('General rearranged')
  // A press on a heading still folds it, and a second opens it.
  await head('general', 'Metadata').click()
  await sleep(300)
  await log('Metadata pressed')
  await head('general', 'Metadata').click()
  await sleep(300)
  // ⌥↓ on its chevron: one place down.
  await cardOf('general', 'Metadata').locator('.card-fold').focus()
  await page.keyboard.press('Alt+ArrowDown')
  await sleep(400)
  await log('Metadata ⌥↓')
  await shot('c5-general-rearranged')

  // Another tab has none of these cards; back, and they are all there.
  await page.locator('.tab-add, button[title^="New tab"], button[aria-label^="New tab"]').first().click()
  await sleep(1500)
  await log('a new tab')
  await page.locator('.tab').first().click()
  await sleep(2500)
  await log('back in the first tab')

  // A deck: its 3D card after the Map card.
  await page.evaluate(async (url) => {
    const card = document.querySelector('.structure-card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await sleep(5000)
  await log('a deck')
  await shot('c6-deck')

  // The palette's reset.
  await page.keyboard.press('Control+p')
  await sleep(500)
  await page.keyboard.type('Put every card back')
  await sleep(400)
  await page.keyboard.press('Enter')
  await sleep(1200)
  await log('reset')
  console.log('stored after reset:', await page.evaluate(() => localStorage.getItem('metacooler-viewer:card-layout')))
  await shot('c7-reset')

  // Two maps: the Map card carried to General, then the companion starred —
  // the card there becomes the companion's, and goes back with the star. In a
  // page of its own: a config opened over a window with tabs asks where it goes.
  await page.close()
  page = watch(await context.newPage())
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await sleep(4000)
  const mapCard = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.controls-card')]
        .filter((n) => n.querySelector(':scope > .card-head')?.textContent?.trim() === 'Map')
        .map((n) => `${n.closest('.panel-column')?.className.match(/panel-(general|annotations|aesthetics|analysis)/)?.[1]}: ${n.querySelector('.clip-note')?.textContent ?? ''}`),
    )
  await carry(head('aesthetics', 'Map'), cardOf('general', 'Metadata'), 'below')
  console.log('Map card carried to General:', JSON.stringify(await mapCard()))
  await page.locator('.deck-grid > .deck-panel:not(.is-lead) .deck-star').first().click()
  await sleep(1500)
  console.log('companion starred:', JSON.stringify(await mapCard()))
  await shot('c8-companion-card-in-general')
  await page.locator('.deck-grid > .deck-panel.is-lead .deck-star').first().click()
  await sleep(1500)
  console.log('first map starred again:', JSON.stringify(await mapCard()))
  await page.evaluate(() => localStorage.removeItem('metacooler-viewer:card-layout'))

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
