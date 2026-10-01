/**
 * Every called set on both surfaces (§18.7): on the map and as a lane.
 *
 * On the micro-C demo — a yeast map with the ATAC bigWig beside it — peaks are
 * called on ATAC and arrive as boxes in a lane directly under the coverage and
 * as marks on the map; diamond insulation's boundaries and domains arrive on
 * the map and as lanes under the insulation track; compartments on chromosome
 * IV arrive as A/B segments coloured by their name, on the map and under E1.
 * Then the two switches, *on the map* and *as a lane*, on a row's settings and
 * in the drawer; and last the 1D browser demo, which has no map, where the
 * peaks are a lane alone.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-task-segments.mjs [out-dir]
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

const OUT = process.argv[2] ?? 'gallery-segments'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
let page
const fresh = async () => {
  const next = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const shotOf = async (selector, name) => {
  await page.locator(selector).first().screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(700); return true }
  }
  return false
}
const closeDrawer = async () => {
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) { await close.click(); await sleep(1200) }
}
const openTask = async (title) => {
  await closeDrawer()
  await fold('Show the Analysis panel')
  const row = page.locator('.analysis-row-title', { hasText: new RegExp(`^${title}$`) }).first()
  if (!(await row.isVisible())) {
    // A task in a folded card: open the card it is in.
    await row.evaluate((node) => {
      const card = node.closest('.is-folded')
      card?.querySelector('button[title^="Show"], .card-head button')?.click()
    })
    await sleep(800)
  }
  await row.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(async () => {
    await page.screenshot({ path: `${OUT}/debug-${title}.png` })
    console.log('rows:', JSON.stringify(await page.$$eval('.analysis-row-title', (a) => a.map((x) => `${x.textContent}${x.offsetParent ? '' : ' (hidden)'}`))))
    throw new Error(`no visible row ${title}`)
  })
  await row.click()
  await sleep(1200)
}
const choose = async (key, option) => {
  const select = page.locator(`.analysis-drawer select[id$="-${key}"]`).first()
  if (!(await select.count())) { console.log('no select for', key); return }
  const text = await select.locator('option', { hasText: option }).first().textContent()
  await select.selectOption({ label: text ?? option })
  await sleep(600)
}
const chooseText = async (option) => {
  const select = page.locator('.analysis-drawer select').filter({ has: page.locator('option', { hasText: option }) }).first()
  if (!(await select.count())) { console.log('no select offers', option); return }
  const text = await select.locator('option', { hasText: option }).first().textContent()
  await select.selectOption({ label: text ?? option })
  await sleep(600)
}
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
const run = async (marker) => {
  const before = await computed()
  await page.locator('.analysis-drawer button', { hasText: /^run(\s+on)?\s*$/i }).first().click()
  await page.waitForFunction(({ before, marker }) => {
    const text = document.querySelector('.analysis-drawer-body')?.innerText ?? ''
    const now = text.match(/computed in [^\n]*/)?.[0] ?? ''
    return now !== '' && now !== before && text.includes(marker)
  }, { before, marker }, { timeout: 600000 }).catch(() => console.log('run did not finish:', marker))
  await sleep(2000)
}
const elsewhere = () =>
  page.$$eval('.analysis-elsewhere', (all) => all.map((one) => one.innerText.replace(/\s+/g, ' ').trim()))
const showElsewhere = () =>
  page.evaluate(() => document.querySelector('.analysis-elsewhere')?.scrollIntoView({ block: 'center' }))
const goTo = async (locus) => {
  const box = page.locator('input.input-region').first()
  await box.fill(locus)
  await box.press('Enter')
  await sleep(3500)
}
const rows = () =>
  page.$$eval('.annotation-card .ann-row', (all) =>
    all.map((row) => `${row.getAttribute('data-id')} ${row.classList.contains('ann-ready') ? 'ready' : ''}`),
  )
/** Open one row's settings on the Tracks card, by the end of its id. */
const openRow = async (suffix) => {
  await fold('Show the Annotations panel')
  const row = page.locator(`.annotation-card .ann-row[data-id$="${suffix}"]`).first()
  await row.scrollIntoViewIfNeeded()
  const more = row.locator('.ann-more').first()
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click()
  await sleep(800)
  await page.locator(`.annotation-card .ann-row[data-id$="${suffix}"]`).first().scrollIntoViewIfNeeded()
  return page.locator(`.annotation-card .ann-row[data-id$="${suffix}"]`).first()
}

try {
  // ---------------------------------------------------------------------------
  // A map with its coverage: peaks under ATAC, on the map and as a lane.
  // ---------------------------------------------------------------------------
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(6000)

  await openTask('Peak calling')
  await choose('signal', 'ATAC')
  const keep = page.locator('.analysis-drawer input[id$="-truncate"]').first()
  if (await keep.count()) { await keep.fill('5000'); await keep.press('Enter'); await sleep(500) }
  await run('Curvature of every candidate')
  console.log('peaks, where they went:', JSON.stringify(await elsewhere()))
  await showElsewhere()
  await sleep(600)
  await shot('s01-peaks-drawer-switches')

  await closeDrawer()
  await fold('Fold the Analysis panel')
  await goTo('IV:1,240,000-1,300,000')
  console.log('rows:', JSON.stringify(await rows()))
  await shot('s02-peaks-under-atac-and-on-the-map')
  await goTo('IV:1,262,000-1,272,000')
  await shot('s03-peaks-close')

  // ---------------------------------------------------------------------------
  // Diamond insulation: boundaries and domains, on the map and as lanes.
  // ---------------------------------------------------------------------------
  await goTo('IV:1,000,000-1,400,000')
  await openTask('Diamond insulation')
  await run('Insulation boundaries')
  console.log('insulation, where they went:', JSON.stringify(await elsewhere()))
  await showElsewhere()
  await sleep(600)
  await shot('s04-insulation-drawer-switches')
  await closeDrawer()
  await fold('Fold the Analysis panel')
  await sleep(1500)
  await shot('s05-insulation-boundaries-domains-map-and-lanes')

  // ---------------------------------------------------------------------------
  // Compartments on chromosome IV: A/B segments, coloured by name.
  // ---------------------------------------------------------------------------
  await page.evaluate(() => {
    const hash = new URLSearchParams(location.hash.slice(1))
    hash.set('region', 'IV')
    location.hash = hash.toString()
  })
  await page.waitForFunction(() => /1,532 × 1,532 bins/.test(document.body.innerText), null, { timeout: 120000 })
    .catch(() => console.log('chromosome IV did not open whole'))
  await sleep(3000)
  await openTask('Compartments')
  await chooseText('genes')
  await run('A/B compartments')
  console.log('compartments, where they went:', JSON.stringify(await elsewhere()))
  await showElsewhere()
  await sleep(600)
  await shot('s06-compartments-drawer-switches')
  await closeDrawer()
  await fold('Fold the Analysis panel')
  await sleep(1500)
  await shot('s07-compartments-ab-on-the-map-and-under-e1')
  // Closer, where the A and B boxes are wide enough to read their colours.
  await goTo('IV:150,000-650,000')
  await shot('s07b-compartments-ab-closer')

  // The lane's row on the Tracks card: the two switches, coloured by name.
  await openRow('compartment-ab:lane')
  await sleep(600)
  await shot('s08-compartments-lane-row-settings')
  await shotOf('.annotation-card .ann-row[data-id$="compartment-ab:lane"]', 's09-compartments-lane-row-alone')

  // A switch pressed on the row, then the panel folded so the map has its room.
  const flip = async (which) => {
    const row = await openRow('compartment-ab:lane')
    await row.locator('.ann-surfaces button', { hasText: which }).first().click()
    await sleep(600)
    await fold('Fold the Annotations panel')
    await sleep(1500)
  }
  // Off the map: the overlay goes and the lane stays.
  await flip('on the map')
  await shot('s10-compartments-lane-only')
  // …and the other way round: on the map, no lane.
  await flip('on the map')
  await flip('as a lane')
  await shot('s11-compartments-map-only')
  await flip('as a lane')
  // The overlay's own row carries the same two switches.
  await openRow('compartment-ab')
  await shotOf('.annotation-card .ann-row[data-id$="compartment-ab"]', 's12-compartments-overlay-row-alone')

  // ---------------------------------------------------------------------------
  // A session reloaded: both rows come back, with which surface was on.
  // ---------------------------------------------------------------------------
  const peaksLane = await openRow(':lane')
  void peaksLane
  await page.locator('.annotation-card .ann-row[data-id*=":peaks-"][data-id$=":lane"] .ann-surfaces button', { hasText: 'on the map' }).first().click().catch(() => console.log('no peaks overlay switch'))
  await sleep(800)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(6000)
  await fold('Show the Annotations panel')
  console.log('after a reload:', JSON.stringify(await rows()))
  const peaksRow = page.locator('.annotation-card .ann-row[data-id*=":peaks-"][data-id$=":lane"]').first()
  if (await peaksRow.count()) {
    await peaksRow.scrollIntoViewIfNeeded()
    await peaksRow.locator('.ann-more').first().click()
    await sleep(800)
    await peaksRow.scrollIntoViewIfNeeded()
  }
  await shot('s13-reloaded-rows-detached-switches-kept')

  // ---------------------------------------------------------------------------
  // No map: the 1D browser demo, where the peaks are a lane alone.
  // ---------------------------------------------------------------------------
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_tracks.metacooler.json`)
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('Yeast, no map'), null, { timeout: 180000 })
  await sleep(6000)
  const heightBox = page.locator('xpath=//*[normalize-space(text())="track height"]/following::input[1]').first()
  if (await heightBox.count()) { await heightBox.fill('34'); await heightBox.press('Enter'); await sleep(1500) }
  await openTask('Peak calling')
  await choose('signal', 'ATAC')
  const keep2 = page.locator('.analysis-drawer input[id$="-truncate"]').first()
  if (await keep2.count()) { await keep2.fill('5000'); await keep2.press('Enter'); await sleep(500) }
  await run('Curvature of every candidate')
  console.log('peaks with no map, where they went:', JSON.stringify(await elsewhere()))
  await closeDrawer()
  await fold('Fold the Analysis panel')
  await goTo('IV:1,240,000-1,300,000')
  await shot('s14-browser-no-map-peaks-lane-under-atac')
} finally {
  console.log(errors.length ? `page errors:\n${errors.slice(0, 20).join('\n')}` : 'no page errors')
  await browser.close()
}
