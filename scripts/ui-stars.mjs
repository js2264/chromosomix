/**
 * Drive the stars of a deck in headless Chromium and write what each state
 * looks like (§16.5, §18.1, §25.3, §16.9).
 *
 * The stars are gestures a gallery of arrivals never makes: which map the
 * Aesthetics column's *Map* card sets moves with the star, a filled star
 * pressed leaves nothing starred — the card then sets every map and the
 * Analysis column greys every task — and an empty cell takes a track row as
 * readily as a map. Opens the yeast deck demo (a cooler beside a `.hic`),
 * presses each star in turn, changes a setting on the card in each state, and
 * prints what it found to stdout as well as shooting it, so a card that did
 * not follow the star is a line in the log rather than something to spot in a
 * picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-stars.mjs [out-dir]
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
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}

/** What the Aesthetics column's Map card says it sets, and its colours select. */
const card = () =>
  page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.controls-card')).filter(
      (node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Map' && node.offsetParent !== null,
    )
    const shown = cards[0]
    if (shown === undefined) return { cards: 0 }
    const field = (label) =>
      Array.from(shown.querySelectorAll('.field')).find((f) => f.querySelector('.field-label')?.textContent === label)
    const line = shown.querySelector('.map-card-for')
    return {
      cards: cards.length,
      for: line?.classList.contains('hidden') ? '' : (line?.textContent ?? ''),
      every: line?.classList.contains('is-every') ?? false,
      colours: field('colours')?.querySelector('select')?.value ?? null,
      transform: field('transform')?.querySelector('select')?.value ?? null,
    }
  })
const stars = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.deck-grid > .deck-panel')).map((cell) => {
      const star = cell.querySelector('.deck-star')
      return star === null ? '-' : star.getAttribute('aria-pressed') === 'true' ? '★' : '☆'
    }).join(' '),
  )
/** The colormap each map of the deck is drawing, read off its own key. */
const drawn = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.deck-grid > .deck-panel .heatmap-canvas')).length,
  )
const pickOnCard = async (label, value) => {
  await page.evaluate(({ label, value }) => {
    const cards = Array.from(document.querySelectorAll('.controls-card')).filter(
      (node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Map' && node.offsetParent !== null,
    )
    const field = Array.from(cards[0]?.querySelectorAll('.field') ?? []).find(
      (f) => f.querySelector('.field-label')?.textContent === label,
    )
    const select = field?.querySelector('select')
    if (select === null || select === undefined) throw new Error(`no ${label} on the Map card`)
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, { label, value })
  await sleep(2000)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await sleep(4000)
  await fold('Fold the General panel')
  await fold('Fold the Annotations panel')
  await fold('Show the Aesthetics panel')
  await sleep(1000)
  console.log('maps drawn:', await drawn(), '· stars:', await stars())
  console.log('corner menus on the companions:', await page.locator('.map-settings-toggle').count())
  console.log('lead starred · card:', JSON.stringify(await card()))
  await shot('s1-lead-starred')

  // The companion's star: the column's Map card becomes the companion's.
  await page.locator('.deck-grid > .deck-panel:not(.is-lead) .deck-star').first().click()
  await sleep(1500)
  console.log('companion starred · stars:', await stars(), '· card:', JSON.stringify(await card()))
  await shot('s2-companion-starred')
  await pickOnCard('colours', 'viridis')
  console.log('colours → viridis on the companion · card:', JSON.stringify(await card()))
  await shot('s3-companion-recoloured')

  // Back on the first map: its own card, its own colours, untouched.
  await page.locator('.deck-grid > .deck-panel.is-lead .deck-star').first().click()
  await sleep(1500)
  console.log('lead starred again · card:', JSON.stringify(await card()))

  // The filled star pressed: nothing is starred, the card sets every map.
  await page.locator('.deck-grid > .deck-panel.is-lead .deck-star').first().click()
  await sleep(1500)
  console.log('no star · stars:', await stars(), '· card:', JSON.stringify(await card()))
  await pickOnCard('colours', 'magma')
  console.log('colours → magma with no star · card:', JSON.stringify(await card()))
  await shot('s4-no-star-every-map')
  const presses = await page.evaluate(() =>
    ['deck-share', 'deck-resolutions'].map((kind) => document.querySelector(`.deck-bar .${kind}`)?.disabled),
  )
  console.log('match presses disabled with no star:', JSON.stringify(presses))

  // The Analysis column with nothing starred: every task greyed, one warning.
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(1200)
  const analysis = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.analysis-row'))
    return {
      warning: document.querySelector('.analysis-blocked:not(.hidden)')?.textContent ?? '',
      rows: rows.length,
      greyed: rows.filter((row) => row.classList.contains('is-waiting')).length,
    }
  })
  console.log('analysis with no star:', JSON.stringify(analysis))
  await shot('s5-no-star-analysis')

  // Star the first map again; the tasks come back.
  await page.locator('.deck-grid > .deck-panel.is-lead .deck-star').first().click()
  await sleep(1200)
  const back = await page.evaluate(() => ({
    warning: document.querySelector('.analysis-blocked:not(.hidden)') !== null,
    greyed: document.querySelectorAll('.analysis-row.is-waiting').length,
  }))
  console.log('analysis starred again:', JSON.stringify(back))
  await fold('Fold the Analysis panel')

  // An empty cell, from the + beside the deck: it offers every kind of cell.
  await page.locator('.deck-grow.is-beside').first().click()
  await sleep(1500)
  const vacancy = await page.evaluate(() => ({
    label: document.querySelector('.deck-vacant .ann-drop-label')?.textContent ?? '',
    hint: document.querySelector('.deck-vacant .ann-drop-hint')?.textContent ?? '',
  }))
  console.log('empty cell:', JSON.stringify(vacancy))
  await shot('s6-empty-cell')

  // A track row of the Tracks card, dragged onto it: a tracks cell drawing it.
  await fold('Show the Annotations panel')
  await sleep(600)
  const trackId = await page.evaluate(() => {
    const zone = document.querySelector('.deck-vacant')
    // The demo's ATAC track, by the id its config gives it; any track row else.
    const row = document.querySelector('.ann-row[data-id="demo-atac"]') ?? document.querySelector('.ann-row[data-id]')
    const id = row?.getAttribute('data-id') ?? ''
    if (zone === null || id === '') return ''
    const transfer = new DataTransfer()
    transfer.setData('application/x-metacooler-track', id)
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    return id
  })
  await sleep(3000)
  const filled = await page.evaluate(() => ({
    tracksCells: document.querySelectorAll('.deck-grid > .deck-tracks').length,
    empty: document.querySelectorAll('.deck-vacant').length,
  }))
  console.log('track row', trackId, 'dropped on the empty cell:', JSON.stringify(filled))
  await fold('Fold the Annotations panel')
  await shot('s7-track-in-empty-cell')

  // Two structure cells, neither starred: the 3D card sets both. Two names,
  // so the second drop is a second row rather than the first one replaced.
  await fold('Show the Annotations panel')
  for (const name of ['Yeast_structure.g3d.gz', 'Yeast_structure_copy.g3d.gz']) {
    await page.evaluate(async ({ url, name }) => {
      const card = document.querySelector('.structure-card')
      if (card === null) throw new Error('no Structures card')
      const bytes = await (await fetch(url)).arrayBuffer()
      const file = new File([bytes], name, { type: 'application/gzip' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      for (const kind of ['dragenter', 'dragover', 'drop']) {
        card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
    }, { url: `${BASE}/demo/yeast/Yeast_structure.g3d.gz`, name })
    await sleep(6000)
  }
  await fold('Fold the Annotations panel')
  await page.waitForFunction(() => document.querySelectorAll('.deck-structure').length >= 2, null, { timeout: 60000 }).catch(() => {})
  await sleep(4000)
  // The 3D card names the starred cell under its title, as the Map card names
  // the starred map — first the first cell, then the second, starred by hand.
  await fold('Show the Aesthetics panel')
  await sleep(800)
  const structureLine = () =>
    page.evaluate(() => {
      const line = document.querySelector('.structure-settings .structure-card-for')
      return {
        line: line?.textContent ?? '',
        every: line?.classList.contains('is-every') ?? false,
        pickers: Array.from(document.querySelectorAll('.structure-settings .field-label')).filter((n) => n.textContent === 'structure').length,
        heads: Array.from(document.querySelectorAll('.deck-structure .deck-name, .deck-structure .deck-title')).map((n) => n.value ?? n.textContent),
      }
    })
  console.log('first structure starred:', JSON.stringify(await structureLine()))
  await page.locator('.structure-settings').first().scrollIntoViewIfNeeded()
  await shot('s8a-structure-starred-first')
  await page.locator('.deck-structure .structure-star').nth(1).click()
  await sleep(1500)
  console.log('second structure starred:', JSON.stringify(await structureLine()))
  await page.locator('.structure-settings').first().scrollIntoViewIfNeeded()
  await shot('s8b-structure-starred-second')
  const starred = page.locator('.deck-structure .structure-star[aria-pressed="true"]').first()
  if (await starred.count()) await starred.click()
  await sleep(1500)
  const cells = await page.evaluate(() => ({
    cells: document.querySelectorAll('.deck-structure').length,
    starred: document.querySelectorAll('.deck-structure .structure-star[aria-pressed="true"]').length,
    line: document.querySelector('.structure-settings .structure-card-for')?.textContent ?? '',
  }))
  console.log('structures with no star:', JSON.stringify(cells))
  // Sticks on, from the card: both models take them.
  await page.evaluate(() => {
    const toggle = Array.from(document.querySelectorAll('.structure-settings .structure-toggle')).find((node) =>
      (node.getAttribute('title') ?? '').startsWith('Sticks'),
    )
    toggle?.click()
  })
  await sleep(2500)
  // The two cells are under the maps; bring them up so both models are seen
  // taking the change the card made.
  await page.evaluate(() => document.querySelectorAll('.deck-structure')[0]?.scrollIntoView({ block: 'end' }))
  await sleep(2500)
  const sticks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.deck-structure')).length,
  )
  console.log('structure cells on screen:', sticks)
  await shot('s8-structures-no-star')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
