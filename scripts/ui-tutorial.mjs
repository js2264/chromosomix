/**
 * Drive the guided tutorial (§30) from About to its last step, in headless
 * Chromium, and shoot every step it shows.
 *
 * The tutorial is the app used on real data, so this is the app used on real
 * data: the 4DN store, the IMR-90 map on 4DN's bucket, the map drawn as a
 * correlation, compartments phased and run on chr13, two zooms down to a few
 * domains seen under O/E and smoothing, insulation run, the domains moved under
 * the map, the four tracks correlated and the console opened. Each step is
 * answered the way a reader would answer it — a real press on the lit control,
 * a real drag across the square the tour lights — so a step whose target is
 * covered by the tour's own grey fails here as it would fail a reader. On the
 * way it also takes the roads that are not the main one, each shot and printed:
 * the landing page's button that starts it, a wrong accession typed (the name
 * blinks) and the right one pasted from its copy button, a press on the grey,
 * *back* to a step already done, *skip tutorial* half way and *resume* from
 * About, the dark theme, and About after *finish*.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-tutorial.mjs gallery-tutorial
 *
 * Network: the stores are read from the deployed site (the dev server has no
 * `stores/`), or from a folder holding `4dn.json` and `4dn-sessions.json` named
 * in `GALLERY_STORES`; the map and its tracks from 4DN's open-data bucket. A
 * machine that reaches the world through a proxy names it in `HTTPS_PROXY`,
 * which is handed to Chromium as its own flag so the dev server stays direct.
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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

const OUT = process.argv[2] ?? 'gallery-tutorial'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const STORES = process.env.GALLERY_STORES ?? null
const SITE = 'https://chromosomix.app/stores/'
mkdirSync(OUT, { recursive: true })

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: [
    // Chromium's own flag rather than Playwright's option, which also proxies
    // the loopback and so the dev server.
    ...(proxy === undefined ? [] : [`--proxy-server=${proxy}`]),
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
// The accession's copy button writes the clipboard and this script reads it back.
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
await context.route(`${BASE}/stores/**`, async (route) => {
  const name = new URL(route.request().url()).pathname.replace(/^.*\/stores\//, '')
  if (STORES !== null && existsSync(join(STORES, name))) {
    await route.fulfill({ status: 200, body: readFileSync(join(STORES, name)), contentType: 'application/json' })
    return
  }
  await route.fulfill({ response: await route.fetch({ url: `${SITE}${name}` }) })
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
// Requests on their way, the workers' included: what `quiet` waits on.
let inFlight = 0
page.on('request', () => inFlight++)
page.on('requestfinished', () => inFlight--)
page.on('requestfailed', () => inFlight--)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let shots = 0
const shot = async (name) => {
  shots++
  const file = `${String(shots).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: join(OUT, file) })
  console.log(`  wrote ${file}`)
}
/** The step on screen: its id, counter, title and the note under it, or `null` with no tour. */
const card = () =>
  page.evaluate(() => {
    const node = document.querySelector('.tour-card')
    if (node === null || !node.isConnected) return null
    return {
      id: node.dataset.step ?? '',
      count: node.querySelector('.tour-count')?.textContent ?? '',
      title: node.querySelector('.tour-title')?.textContent ?? '',
      note: node.querySelector('.tour-note:not(.hidden)')?.textContent ?? '',
      next: node.querySelector('.tour-next')?.textContent ?? '',
    }
  })
/**
 * Wait for the ring and the card to stop moving: two readings 200 ms apart
 * that agree, or three seconds. The ring follows its target as the layout
 * around it settles — lanes arriving under a map widen it — and a picture
 * taken on the way shows a hole beside the thing it lights.
 */
async function still() {
  const boxes = () =>
    page.evaluate(() =>
      ['.tour-ring', '.tour-card']
        .map((sel) => {
          const r = document.querySelector(sel)?.getBoundingClientRect()
          return r === undefined ? '-' : [r.left, r.top, r.width, r.height].map(Math.round).join(',')
        })
        .join(' '),
    )
  let last = await boxes()
  for (let k = 0; k < 15; k++) {
    await sleep(200)
    const now = await boxes()
    if (now === last) return
    last = now
  }
}
/**
 * Wait for the reads to stop: no request on its way for a second and a half,
 * or thirty seconds. Before every shot, because a step often opens while the
 * picture behind it is still arriving from 4DN's bucket — the map after a
 * zoom, the tracks at a new resolution — and a shot taken then shows a blank
 * map under a card talking about it. Counted on the wire rather than read off
 * the status bar, whose figure stands still while a slow read is out.
 */
async function quiet() {
  let idle = 0
  for (let k = 0; k < 120 && idle < 6; k++) {
    await sleep(250)
    idle = inFlight <= 0 ? idle + 1 : 0
  }
}
/** Wait for the card to leave a step, or for the tour to end. */
async function leave(id, ms = 150_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const now = await card()
    if (now === null || now.id !== id) return now
    await sleep(250)
  }
  throw new Error(`the tutorial stayed on ${id} for ${ms / 1000} s`)
}
const about = async () => {
  await page.click('.head-actions button[title="About this viewer"]')
  await page.waitForSelector('.about-tutorial')
  await sleep(300)
}
const next = () => page.click('.tour-card .tour-next')
const clickTask = (title) =>
  page
    .locator('.analysis-row', { has: page.locator('.analysis-row-title', { hasText: new RegExp(`^${title}$`) }) })
    .first()
    .click()
const clickSequence = (name) =>
  page
    .locator('.analysis-drawer .param-sequences label.param-check', {
      has: page.locator('span', { hasText: new RegExp(`^${name}$`) }),
    })
    .first()
    .click()
const domains = '.ann-row[data-id="analysis:insulation:insulation-domains"]'
/** A location toggle on the domains row, pressed where it is. */
async function clickPlace(edge) {
  const at = await page.evaluate(
    ([row, wanted]) => {
      const toggle = [...document.querySelectorAll(`${row} .ann-place`)].find((node) =>
        new RegExp(`\\b${wanted} edge\\b`).test(node.title),
      )
      if (toggle === undefined) return null
      const r = toggle.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    },
    [domains, edge],
  )
  if (at === null) throw new Error(`no ${edge} toggle on the domains row`)
  await page.mouse.click(at.x, at.y)
}

/**
 * Shift and Option (Alt) held, a drag across the square the tour lights, from
 * one of its corners to the other — what the step asks of a reader, read off
 * the ring rather than worked out again here.
 */
async function dragLit() {
  const ring = await page.locator('.tour-ring').boundingBox()
  if (ring === null) throw new Error('nothing lit to drag across')
  // Inside the ring's six pixels of air, and a little in from the corners.
  const from = { x: ring.x + 10, y: ring.y + 10 }
  const to = { x: ring.x + ring.width - 10, y: ring.y + ring.height - 10 }
  await page.keyboard.down('Shift')
  await page.keyboard.down('Alt')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let k = 1; k <= 12; k++) {
    await page.mouse.move(from.x + ((to.x - from.x) * k) / 12, from.y + ((to.y - from.y) * k) / 12)
    await sleep(25)
  }
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await page.keyboard.up('Shift')
  // Off the map, as a hand reaching for the card does: a pointer resting on
  // the map shows the map's own hint over its corner.
  await page.mouse.move(8, 500)
}

/** A select of the Map card, by the word beside it. */
const mapSelect = (word) =>
  page
    .locator('.controls-card', { has: page.locator('.controls-title', { hasText: /^Map$/ }) })
    .locator('label.field', { has: page.locator('.field-label', { hasText: new RegExp(`^${word}$`) }) })
    .locator('select')
    .first()
/** The store's 4DN tile: in the drawer, open on the lab's store behind the welcome, or on the page. */
async function pressStore() {
  const inDrawer = page.locator('.store-drawer .store-tile[data-store="4dn"]').first()
  const onPage = page.locator('.store-tiles-large .store-tile[data-store="4dn"]').first()
  await ((await inDrawer.isVisible()) ? inDrawer : onPage).click()
}
/** Tick whichever of the correlation's four tracks is not ticked yet. */
async function tickFour() {
  for (const words of ['4DNFIR2STZVV', '4DNFIRL31X9M', 'E1 · chr13', 'Insulation · ']) {
    const box = page.locator('.analysis-drawer label.param-check', { hasText: words }).first()
    if (!(await box.locator('input').isChecked())) await box.click()
  }
}

/** What a reader does at each step. */
const ACT = {
  welcome: next,
  store: pressStore,
  // A wrong accession first, shot blinking, then the right one pasted from the
  // card's copy button: the road a reader who does not want to type twelve
  // characters takes, and the one a test can miss.
  search: async () => {
    const box = page.locator('.store-drawer .portal-search')
    await box.fill('')
    await box.type('4DNES5', { delay: 30 })
    await sleep(260)
    await shot('search-wrong')
    const marked = await page.locator('.tour-card .tour-name').getAttribute('class')
    console.log(`  typed 4DNES5: the name is ${marked ?? ''}`)
    await page.click('.tour-card .tour-copy')
    await sleep(200)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    console.log(`  copied from the card: ${copied}`)
    await box.fill(copied)
  },
  'open-set': () => page.click('.store-drawer .portal-session'),
  'resolution-250': () => page.selectOption('select.res-pick', { label: '250 kb' }),
  chromosome: () => page.click('.content .tviewport .tr .td[title="chr13"]'),
  'look-general': next,
  'look-map': next,
  'look-aesthetics': next,
  'score-correlation': () => mapSelect('score').selectOption('correlation'),
  'look-correlation': next,
  'analysis-compartments': () => page.click('.panel-analysis .panel-tab'),
  'tasks-2d': next,
  'tasks-3d': next,
  'tasks-1d': next,
  compartments: () => clickTask('Compartments'),
  'compartments-none': () => page.click('.analysis-drawer button[title="Untick every sequence"]'),
  'compartments-sequence': () => clickSequence('chr13'),
  'compartments-run': () => page.click('.analysis-drawer .analysis-run > button'),
  'look-saddle': next,
  'compartments-close': () => page.click('.analysis-drawer .analysis-drawer-head .btn-close'),
  'look-compartments': next,
  'score-balanced': () => mapSelect('score').selectOption('balanced'),
  zoom: dragLit,
  'resolution-10': () => page.selectOption('select.res-pick', { label: '10 kb' }),
  'zoom-domains': dragLit,
  'look-domains': next,
  'oe-on': () =>
    page
      .locator('.controls-card', { has: page.locator('.controls-title', { hasText: /^Map$/ }) })
      .locator('button', { hasText: /^O\/E$/ })
      .first()
      .click(),
  smooth: () => mapSelect('smooth').selectOption('1'),
  'look-oe': next,
  'analysis-insulation': () => page.click('.panel-analysis .panel-tab'),
  insulation: () => clickTask('Diamond insulation'),
  'insulation-none': () => page.click('.analysis-drawer button[title="Untick every sequence"]'),
  'insulation-sequence': () => clickSequence('chr13'),
  'insulation-run': () => page.click('.analysis-drawer .analysis-run > button'),
  'insulation-close': () => page.click('.analysis-drawer .analysis-drawer-head .btn-close'),
  'look-insulation': next,
  annotations: () => page.click('.panel-annotations .panel-tab'),
  domains: () => page.click(`${domains} .ann-more`),
  'domains-display': () => page.selectOption(`${domains} select[data-display]`, 'lane'),
  'domains-bottom': () => clickPlace('bottom'),
  'domains-left': () => clickPlace('left'),
  'analysis-trackcorr': () => page.click('.panel-analysis .panel-tab'),
  trackcorr: () => clickTask('Track correlation'),
  'tick-tracks': tickFour,
  'trackcorr-run': () => page.click('.analysis-drawer .analysis-run > button'),
  'look-trackcorr': next,
  console: () => page.click('button[aria-label="console"]'),
  finish: next,
}

const progress = () => page.evaluate(() => window.localStorage.getItem('chromosomix:tour'))

try {
  await page.goto(`${BASE}/`)
  await page.waitForSelector('.store-tiles-large')
  await sleep(800)
  await shot('landing')
  await about()
  await shot('about')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.modal-backdrop', { state: 'detached' })
  await page.click('.picker-tutorial-play')
  // The tour is a chunk of its own, fetched by the press.
  await page.waitForSelector('.tour-card[data-step]')

  let resumed = false
  let backed = false
  let nudged = false
  for (let guard = 0; guard < 80; guard++) {
    const now = await card()
    if (now === null) break
    // Let the ring settle on its target before the picture; a step passed
    // over in that time is simply not shot.
    await sleep(500)
    await quiet()
    await still()
    const settled = await card()
    if (settled === null) break
    if (settled.id !== now.id) continue
    console.log(
      `${settled.count.padEnd(14)} ${settled.id.padEnd(22)} ${settled.title}` +
        (settled.note === '' ? '' : `  [${settled.note}]`),
    )
    await shot(settled.id)

    // A press on the grey, once: the ring answers rather than the app.
    if (!nudged && settled.id === 'compartments-none') {
      nudged = true
      await page.mouse.click(40, 500)
      await sleep(220)
      await shot('compartments-none-nudged')
      console.log(`  after a press on the grey: still ${(await card())?.id}`)
    }

    // Back to a step already done: it waits with *next*, and does not bounce.
    if (!backed && settled.id === 'look-compartments') {
      backed = true
      await page.click('.tour-card .tour-back')
      await sleep(900)
      const back = await card()
      console.log(`  back: ${back?.id}, offering ${JSON.stringify(back?.next)}`)
      await shot(`back-${back?.id}`)
      await next()
      await sleep(300)
      continue
    }

    // Half way, leave and come back: About offers to resume, and the steps
    // whose state still holds go by on their own.
    if (!resumed && settled.id === 'insulation-sequence') {
      resumed = true
      await page.click('.tour-card .tour-skip')
      await sleep(500)
      console.log(`  skipped: ${await progress()}`)
      await about()
      await shot('about-resume')
      await page.click('.about-tutorial-play')
      await page.waitForSelector('.tour-card[data-step]')
      await sleep(1500)
      console.log(`  resumed on ${(await card())?.id}`)
      continue
    }

    if (settled.id === 'finish') {
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
      })
      await sleep(400)
      await shot('finish-dark')
      await page.evaluate(() => {
        delete document.documentElement.dataset.theme
      })
      await sleep(200)
    }

    const act = ACT[settled.id]
    if (act === undefined) throw new Error(`no action for ${settled.id}`)
    await act()
    await leave(settled.id)
  }

  console.log(`ended: ${await progress()}`)
  await sleep(500)
  await shot('after')
  await about()
  await shot('about-again')
  console.log(`About offers: ${await page.locator('.about-tutorial-play').textContent()}`)
} catch (error) {
  await shot('failed')
  throw error
} finally {
  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n  ${errors.join('\n  ')}`)
  await browser.close()
}
