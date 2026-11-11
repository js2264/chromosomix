/**
 * Drive the app's *furniture* in headless Chromium and write a gallery of it.
 *
 * `ui-gallery.mjs` walks one map and its structure; `ui-figures.mjs` walks the
 * analysis figures. This one walks everything else a reader meets: the landing
 * page in both themes, every dialog, the two drawers, the five columns with
 * their cards open, the deck, the 1D browser, the tables of a metagenome, an
 * error page, the embed, and a laptop-sized window. One PNG per step, each
 * scene in its own context so a failure in one leaves the rest standing.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-tour.mjs [out-dir]
 *
 * Playwright and Chromium are resolved as `ui-gallery.mjs` resolves them.
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

const OUT = process.argv[2] ?? 'tour'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errors = []

/** Whether the page is actually drawing the dark palette right now. */
const isDark = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector('.panel-column') ?? document.body
    const [r, g, b] = getComputedStyle(panel)
      .backgroundColor.match(/\d+/g)
      .slice(0, 3)
      .map(Number)
    // The dark palette's panels are near-black; the light one's are near-white.
    return (r + g + b) / 3 < 96
  })

const YEAST = `${BASE}/demo/yeast/Yeast_microC.chromosomix.json`
const DECK = `${BASE}/demo/yeast/Yeast_deck.chromosomix.json`
const TRACKS = `${BASE}/demo/yeast/Yeast_tracks.chromosomix.json`
const MOCK = `${BASE}/demo/metagenomics/mock-community/Mock_microbial_community.chromosomix.json`

/** One scene: its own context, viewport and storage. */
async function scene(name, fn, { width = 1920, height = 1100, dark = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e).slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text().slice(0, 200)}`) })
  const shot = async (id, opts = {}) => { await page.screenshot({ path: `${OUT}/${id}.png`, ...opts }); console.log('shot', id) }
  const fold = async (title) => {
    for (const b of await page.$$(`button[title^="${title}"]`)) {
      if (await b.isVisible()) { await b.click(); await sleep(500); return true }
    }
    return false
  }
  const opened = async () => {
    await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas, .browser-canvas, .view-genomes, .view-contigs, .view-error') !== null, null, { timeout: 120000 })
    await sleep(2000)
  }
  try {
    await fn({ page, shot, fold, opened })
  } catch (e) {
    console.log('FAILED', name, String(e).slice(0, 300))
    await shot(`${name}-99-failure`).catch(() => {})
  }
  await context.close()
}

// ---------------------------------------------------------------- landing
await scene('landing', async ({ page, shot }) => {
  await page.goto(`${BASE}/`)
  await page.waitForSelector('.view-picker', { timeout: 60000 })
  await sleep(1500)
  await shot('01-landing', { fullPage: true })
  // About, shortcuts, palette, connect, share: the dialogs from the header.
  await page.click('button[title="About this viewer"]')
  await sleep(1500)
  await shot('02-about')
  await page.keyboard.press('Escape')
  await sleep(400)
  await page.click('button[title^="Keyboard shortcuts"]')
  await sleep(800)
  await shot('03-shortcuts')
  await page.keyboard.press('Escape')
  await sleep(400)
  await page.click('.action-bar')
  await sleep(800)
  await shot('04-palette')
  await page.keyboard.type('fold')
  await sleep(500)
  await shot('04b-palette-filtered')
  await page.keyboard.press('Escape')
  await sleep(400)
  // On an empty tab the link button is *disabled*, with the way out in its
  // title — so there is no refusal dialog to shoot here any more, and what is
  // worth seeing is the header in that state. The share dialog itself is shot
  // from the browser scene, where a file is open.
  const share = page.locator('button[title^="Share this tab as a link"]').first()
  console.log('share disabled on an empty tab:', await share.isDisabled())
  await shot('05-header-nothing-to-share', { clip: { x: 1500, y: 0, width: 420, height: 52 } })
  // The Connect dialog on each of its panes, from the landing page's buttons.
  const providers = await page.$$('.picker-provider')
  console.log('providers:', providers.length)
  for (const [i, label] of [['bucket', 'a bucket'], ['drive', 'Google Drive'], ['dropbox', 'Dropbox']]) {
    const btn = page.locator('.picker-provider', { hasText: new RegExp(label, 'i') }).first()
    if (await btn.count()) {
      await btn.click()
      await sleep(900)
      await shot(`06-connect-${i}`)
      await page.keyboard.press('Escape')
      await sleep(400)
    }
  }
  // The connect dialog's local pane, from the palette command.
  await page.keyboard.press('Control+p')
  await sleep(400)
  await page.keyboard.type('folder')
  await sleep(400)
  await page.keyboard.press('Enter')
  await sleep(900)
  await shot('06-connect-local')
  await page.keyboard.press('Escape')
  await sleep(400)
  // The store drawer: the shelf, then a portal.
  await page.keyboard.press('\\')
  await sleep(2500)
  await shot('07-store-drawer')
  const tileCount = (await page.$$('.store-head-tiles .store-tile')).length
  console.log('store tiles:', tileCount)
  for (let n = 1; n < Math.min(tileCount, 4); n++) {
    const tile = (await page.$$('.store-head-tiles .store-tile'))[n]
    if (!tile) break
    await tile.click()
    await sleep(6000)
    await shot(`07-store-${n}`)
  }
  await page.keyboard.press('\\')
  await sleep(500)
  // The console, empty.
  await page.keyboard.press('Control+Backquote')
  await sleep(800)
  await shot('08-console-empty')
  await page.keyboard.press('Control+Backquote')
  await sleep(300)
  // What the browser remembers.
  await page.keyboard.press('Control+p')
  await sleep(400)
  await page.keyboard.type('remember')
  await sleep(400)
  await page.keyboard.press('Enter')
  await sleep(900)
  await shot('09-stored-data')
  await page.keyboard.press('Escape')
})

await scene('landing-dark', async ({ page, shot }) => {
  await page.goto(`${BASE}/`)
  await page.waitForSelector('.view-picker', { timeout: 60000 })
  await sleep(1500)
  await shot('01d-landing-dark', { fullPage: true })
  await page.click('button[title="About this viewer"]')
  await sleep(1200)
  await shot('02d-about-dark')
  await page.keyboard.press('Escape')
  await page.keyboard.press('\\')
  await sleep(2500)
  await shot('07d-store-drawer-dark')
}, { dark: true })

// ---------------------------------------------------------------- the map and its columns
await scene('map', async ({ page, shot, fold, opened }) => {
  await page.goto(`${BASE}/?config=${YEAST}`)
  await opened()
  await fold('Show the Annotations panel')
  await fold('Show the Analysis panel')
  await sleep(2500)
  await shot('10-map-all-panels')
  // Every card in General, scrolled.
  await shot('11-general', { clip: { x: 0, y: 90, width: 300, height: 1010 } })
  await page.evaluate(() => { const c = document.querySelector('.panel-general .panel-column-body'); if (c) c.scrollTop = c.scrollHeight })
  await sleep(400)
  await shot('11b-general-bottom', { clip: { x: 0, y: 90, width: 300, height: 1010 } })
  // The Tracks card with a row expanded, the batch bar, and the other cards.
  const first = await page.$('.ann-row .ann-more')
  if (first) { await first.click(); await sleep(400) }
  await shot('12-annotations-top', { clip: { x: 280, y: 90, width: 340, height: 1010 } })
  const box = await page.$('.ann-row input[type="checkbox"]')
  if (box) { await box.click(); await sleep(300); const box2 = (await page.$$('.ann-row input[type="checkbox"]'))[1]; if (box2) await box2.click(); await sleep(400) }
  await shot('12b-annotations-batch', { clip: { x: 280, y: 90, width: 340, height: 1010 } })
  await page.evaluate(() => { const c = document.querySelector('.panel-annotations .panel-column-body'); if (c) c.scrollTop = c.scrollHeight })
  await sleep(400)
  await shot('12c-annotations-bottom', { clip: { x: 280, y: 90, width: 340, height: 1010 } })
  await page.evaluate(() => { const c = document.querySelector('.panel-annotations .panel-column-body'); if (c) c.scrollTop = 0 })
  // Aesthetics and Analysis columns.
  await shot('13-aesthetics', { clip: { x: 1330, y: 90, width: 300, height: 1010 } })
  await page.evaluate(() => { const c = document.querySelector('.panel-aesthetics .panel-column-body'); if (c) c.scrollTop = c.scrollHeight })
  await sleep(400)
  await shot('13b-aesthetics-bottom', { clip: { x: 1330, y: 90, width: 300, height: 1010 } })
  await shot('14-analysis-list', { clip: { x: 1600, y: 90, width: 320, height: 1010 } })
  await page.evaluate(() => { const c = document.querySelector('.panel-analysis .panel-column-body'); if (c) c.scrollTop = c.scrollHeight })
  await sleep(400)
  await shot('14b-analysis-list-bottom', { clip: { x: 1600, y: 90, width: 320, height: 1010 } })
  // The whole header and breadcrumb row, at full size.
  await shot('15-header-and-crumb', { clip: { x: 0, y: 0, width: 1920, height: 140 } })
  // Hover the map: the readout in the status bar, and the tooltip over a lane.
  const map = await page.locator('.heatmap-canvas').first().boundingBox()
  if (map) {
    await page.mouse.move(map.x + map.width * 0.55, map.y + map.height * 0.4)
    await sleep(600)
    await shot('16-hover-map')
    // A lane under the map: hover it for the tooltip and the hairline.
    await page.mouse.move(map.x + map.width * 0.45, map.y + map.height + 40)
    await sleep(700)
    await shot('16b-hover-lane')
    // Click a lane for its settings.
    await page.mouse.click(map.x + map.width * 0.45, map.y + map.height + 40)
    await sleep(800)
    await shot('16c-lane-settings')
    await page.keyboard.press('Escape')
    await sleep(300)
    // The context menu on the map.
    await page.mouse.click(map.x + map.width * 0.5, map.y + map.height * 0.5, { button: 'right' })
    await sleep(600)
    await shot('17-map-context-menu')
    await page.keyboard.press('Escape')
    await sleep(300)
  }
  // Status bar popovers.
  const read = page.locator('.status-item', { hasText: 'read' }).first()
  if (await read.count()) { await read.hover(); await sleep(500); await shot('18-status-read-pop', { clip: { x: 1200, y: 800, width: 720, height: 300 } }) }
  await page.mouse.move(10, 10)
  // The resolution dialog from the `+` on the bar.
  const add = await page.$('.res-add')
  if (add) { await add.click(); await sleep(700); await shot('19-resolution-dialog'); await page.keyboard.press('Escape'); await sleep(300) }
  // Zoom buttons and the locus box.
  await shot('20-crumb-bar', { clip: { x: 280, y: 90, width: 1360, height: 120 } })
  // **The other presentation, and it is the turned one.** `ViewState.flip` is
  // *absent means square* (`src/types.ts`), so every map above this line is the
  // square a reader arrives at — and one press of this button is what puts it on
  // its diagonal. The shot has been called `21-turned` and `21-square` in turn,
  // each time naming the state the press was leaving; it names what the press
  // gives you now.
  const turn = await page.$('button[title*="45°"]')
  if (turn) { await turn.click(); await sleep(2500); await shot('21-turned'); await turn.click(); await sleep(1500) }
  // Dark theme with the map open.
  //
  // Asserted rather than assumed: a shot named `dark` that comes out light is a
  // picture that lies about the app, and it is the one kind of gallery defect a
  // reader cannot catch by looking. `t` cycles system → dark → light, so from a
  // light machine one press is dark; if the key did not land, say so loudly and
  // reach the state through the button instead.
  await page.keyboard.press('t')
  await sleep(1200)
  if (!(await isDark(page))) {
    errors.push('map: `t` did not reach the dark theme; used the button')
    await page.click('button[title^="Theme:"]')
    await sleep(900)
    while (!(await isDark(page))) {
      await page.click('button[title^="Theme:"]')
      await sleep(900)
    }
  }
  await shot('22-map-dark')
  await page.keyboard.press('t')
  await sleep(600)
  // Whole genome.
  await page.keyboard.press('w')
  await opened()
  await sleep(2000)
  await shot('23-whole-genome')
  // The chromosomes table.
  await page.keyboard.press('c')
  await sleep(2000)
  await shot('24-chromosomes-table')
  // A second tab, the strip, and a rename.
  await page.keyboard.press('o')
  await sleep(1200)
  await shot('25-new-tab-picker')
  await page.keyboard.press('F2')
  await sleep(500)
  await shot('25b-tab-rename', { clip: { x: 0, y: 50, width: 800, height: 50 } })
  await page.keyboard.press('Escape')
  // The console after work.
  await page.keyboard.press('Control+Backquote')
  await sleep(800)
  await shot('26-console')
})

// ---------------------------------------------------------------- the drawer and a figure
await scene('analysis', async ({ page, shot, fold, opened }) => {
  await page.goto(`${BASE}/?config=${YEAST}`)
  await opened()
  await fold('Fold the General panel')
  await fold('Show the Analysis panel')
  await sleep(800)
  await page.locator('.analysis-row-title', { hasText: 'Contact probability' }).first().click()
  await sleep(1200)
  await shot('30-drawer-ps-form')
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(() => /computed in/.test(document.querySelector('.analysis-drawer')?.textContent ?? ''), null, { timeout: 180000 }).catch(() => console.log('no P(s) result'))
  await sleep(4000)
  await shot('31-drawer-ps-result')
  await page.evaluate(() => { const d = document.querySelector('.analysis-drawer-body'); if (d) d.scrollTop = d.scrollHeight })
  await sleep(600)
  await shot('31b-drawer-ps-result-bottom')
  // The figure's strip and its enlarge dialog.
  const expand = await page.$('.analysis-drawer .figure-strip button[title*="dialog" i], .analysis-drawer .figure-strip button[title*="nlarge" i], .analysis-drawer .figure-strip button[title*="window" i]')
  if (expand) { await expand.click(); await sleep(2500); await shot('32-figure-stage'); await page.keyboard.press('Escape'); await sleep(600) }
  // Insulation: a task that writes synthetic tracks. The drawer floats over
  // the column, so it is put down first or the row cannot be pressed.
  await page.keyboard.press('Escape')
  await sleep(700)
  await page.locator('.analysis-row-title', { hasText: 'Diamond insulation' }).first().click()
  await sleep(1000)
  await shot('33-drawer-insulation-form')
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(() => /computed in/.test(document.querySelector('.analysis-drawer')?.textContent ?? ''), null, { timeout: 180000 }).catch(() => console.log('no insulation'))
  await sleep(3000)
  await shot('34-drawer-insulation-result')
  await page.keyboard.press('Escape')
  await sleep(600)
  await fold('Show the Annotations panel')
  await sleep(1500)
  await shot('35-synthetic-tracks')
  // The APA row waiting on a loop set, the greyed rows, the drawer's runs.
  await shot('36-analysis-states', { clip: { x: 1600, y: 90, width: 320, height: 1010 } })
  // Cis and trans: the one drawer whose figure is a bar chart, and the one
  // setting that changes what a figure *is* rather than how it is drawn. Both
  // answers are shot, because a stacked pair and a single row of bars are two
  // pictures and the legend only appears on one of them.
  await fold('Fold the Annotations panel')
  await page.keyboard.press('Escape')
  await sleep(700)
  await page.locator('.analysis-row-title', { hasText: 'Cis and trans' }).first().click()
  await sleep(1000)
  await shot('37-drawer-cistrans-form')
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(() => /computed in/.test(document.querySelector('.analysis-drawer')?.textContent ?? ''), null, { timeout: 180000 }).catch(() => console.log('no cis/trans result'))
  await sleep(4000)
  // **The figure's own box, not the page.** The per-sequence table is emitted
  // first and fills the drawer, so a shot of the top of a finished run is a shot
  // of the table; and a chart taller than what is left below the fold is a shot
  // of its own heading. These two are here for the bars, so they are clipped to
  // the bars.
  const figureShot = async (name) => {
    // The block that holds a *chart*, not the first output block: this task
    // emits its per-sequence table first, and `.analysis-figure` is the class
    // both of them wear.
    const figure = await page.$('.analysis-drawer .analysis-figure:has(.figure-chart)')
    if (figure === null) { errors.push(`${name}: no chart to shoot`); return }
    await figure.scrollIntoViewIfNeeded()
    await sleep(1200)
    const box = await figure.boundingBox()
    if (box === null) { errors.push(`${name}: the chart has no box`); return }
    await shot(name, {
      clip: {
        x: box.x,
        y: Math.max(0, box.y),
        width: box.width,
        height: Math.min(box.height, 1100 - Math.max(0, box.y)),
      },
    })
  }
  await figureShot('38-drawer-cistrans-bars')
  // …and the same run with both fractions stacked.
  const bars = await page.$('.analysis-drawer select')
  const which = await page.$$('.analysis-drawer select')
  for (const select of which) {
    const values = await select.evaluate((node) => [...node.options].map((option) => option.value))
    if (values.includes('both')) { await select.selectOption('both'); break }
  }
  await sleep(600)
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await sleep(6000)
  await figureShot('39-drawer-cistrans-stacked')
})

// ---------------------------------------------------------------- deck
await scene('deck', async ({ page, shot, fold, opened }) => {
  await page.goto(`${BASE}/?config=${DECK}`)
  await opened()
  await page.waitForFunction(() => document.querySelectorAll('.heatmap-canvas').length >= 2, null, { timeout: 120000 }).catch(() => console.log('no second map'))
  await sleep(4000)
  await shot('40-deck')
  // A companion's scale menu on its picture.
  //
  // Every press in this scene is optional and none of them is allowed to cost
  // the shots after it: the buttons on a cell move with the cell's own layout,
  // and when the maps became square by default (§17.2) this one ended up under
  // the picture's corner, where a click waits thirty seconds for an element that
  // will never be free. A missing affordance is worth a line in the error list;
  // it is not worth four missing pictures.
  const press = async (handle, what) => {
    if (handle === null) { errors.push(`deck: no ${what} to press`); return false }
    try {
      await handle.click({ timeout: 4000 })
      return true
    } catch {
      errors.push(`deck: ${what} could not be pressed`)
      return false
    }
  }
  const scale = await page.$('.deck-panel:not(.is-lead) button[title*="scale" i], .deck-panel:not(.is-lead) button[title*="colour" i], .deck-panel:not(.is-lead) button[title*="clip" i]')
  if (await press(scale, 'the companion’s scale menu')) {
    await sleep(700)
    await shot('41-deck-companion-scale')
    await page.keyboard.press('Escape')
    await sleep(300)
  }
  // The add row: the bar is repainted on every press, so the button is found again.
  if (await press(await page.$('.deck-add-toggle'), 'the deck’s add row')) {
    await sleep(600)
    await shot('42-deck-add-menu')
    await press(await page.$('.deck-add-toggle'), 'the deck’s add row again')
    await sleep(400)
  }
  await shot('43-deck-bar', { clip: { x: 280, y: 90, width: 1360, height: 160 } })
  // Asserted, for the reason the map's dark shot is — see `22-map-dark`.
  await page.keyboard.press('t')
  await sleep(1200)
  if (!(await isDark(page))) {
    errors.push('deck: `t` did not reach the dark theme; used the button')
    while (!(await isDark(page))) {
      await page.click('button[title^="Theme:"]')
      await sleep(900)
    }
  }
  await shot('44-deck-dark')
})

// ---------------------------------------------------------------- the 1D browser
await scene('browser', async ({ page, shot, fold, opened }) => {
  await page.goto(`${BASE}/?config=${TRACKS}`)
  await opened()
  await page.waitForFunction(() => document.querySelector('.browser-canvas') !== null, null, { timeout: 120000 })
  await sleep(5000)
  await shot('50-browser')
  const stage = await page.locator('.browser-canvas').first().boundingBox()
  if (stage) {
    await page.mouse.move(stage.x + stage.width * 0.5, stage.y + stage.height * 0.5)
    await sleep(700)
    await shot('51-browser-hover')
    await page.mouse.move(stage.x + stage.width * 0.5, stage.y + stage.height * 0.35)
    await sleep(700)
    await shot('51b-browser-hover-2')
  }
  await fold('Show the Annotations panel')
  await fold('Show the Analysis panel')
  await sleep(1500)
  await shot('52-browser-panels')
  // Locus box search.
  const locus = page.locator('.browser-search input').first()
  if (await locus.count()) { await locus.click(); await locus.fill('YDR'); await sleep(800); await shot('53-browser-search') }
  await page.keyboard.press('Escape')
  // The share dialog with something to share.
  await page.click('button[title^="Share this tab as a link"]')
  await sleep(1000)
  await shot('54-share')
  await page.keyboard.press('Escape')
})

// ---------------------------------------------------------------- the metagenome
await scene('metagenome', async ({ page, shot, fold, opened }) => {
  await page.goto(`${BASE}/?config=${MOCK}`)
  await opened()
  await sleep(2500)
  await shot('60-genomes-table')
  // Tick two rows, the batch line.
  const boxes = await page.$$('.view-genomes .tr .tcheck')
  console.log('genome boxes:', boxes.length)
  if (boxes.length > 1) { await boxes[0].click(); await boxes[1].click(); await sleep(600); await shot('60b-genomes-selected') }
  // A genome view.
  await page.locator('.view-genomes .tr .td:not(.td-check)').first().click()
  await opened()
  await sleep(3000)
  await shot('61-genome-view')
  await shot('61b-genome-general', { clip: { x: 0, y: 90, width: 300, height: 1010 } })
  // The whole-file scan gate.
  await page.keyboard.press('w')
  await sleep(2500)
  await shot('62-whole-file')
  await page.keyboard.press('c')
  await sleep(2500)
  await shot('63-contigs-table')
  await page.keyboard.press('g')
  await sleep(1500)
})

// ---------------------------------------------------------------- an error, the embed, a laptop
await scene('error', async ({ page, shot }) => {
  await page.goto(`${BASE}/#uri=${BASE}/demo/yeast/does-not-exist.cool&view=region&region=IV:1-1000`)
  await page.waitForSelector('.view-error, .view-picker, .heatmap-canvas, .browser-canvas', { timeout: 60000 })
  await sleep(2000)
  await shot('70-error-view')
})

await scene('embed', async ({ page, shot, opened }) => {
  await page.goto(`${BASE}/?embed=1#uri=${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&transform=log10&balance=true`)
  await opened()
  await sleep(2500)
  await shot('71-embed')
  await page.click('button[title^="Show the Aesthetics panel"]').catch(() => {})
  await sleep(1200)
  await shot('71b-embed-aesthetics')
}, { width: 1000, height: 640 })

await scene('laptop', async ({ page, shot, fold, opened }) => {
  await page.goto(`${BASE}/?config=${YEAST}`)
  await opened()
  await sleep(2500)
  await shot('72-laptop-1366')
  await fold('Show the Annotations panel')
  await sleep(1500)
  await shot('72b-laptop-1366-annotations')
}, { width: 1366, height: 768 })

await scene('narrow', async ({ page, shot }) => {
  await page.goto(`${BASE}/`)
  await page.waitForSelector('.view-picker', { timeout: 60000 })
  await sleep(1500)
  await shot('73-narrow-landing', { fullPage: true })
}, { width: 900, height: 700 })

console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 12))
await browser.close()
