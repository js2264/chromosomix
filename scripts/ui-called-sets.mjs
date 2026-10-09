/**
 * A called set as one row (§18.7): insulation's score, boundaries and domains.
 *
 * On the micro-C demo, chromosome IV: diamond insulation run, and what lands —
 * the score as a lane, the boundaries as short segments under it, the domains
 * as corners along the diagonal — then each row's *display* and *look*
 * dropdowns driven: the boundaries put on the map as points and as short
 * diagonal markers, the domains put back to a lane of long segments, a turned
 * map, a reload that keeps each choice, and the 1D browser demo where a called
 * set is a lane alone. Prints the Tracks card's rows and every dropdown's value
 * at each step.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-called-sets.mjs [out-dir]
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

const OUT = process.argv[2] ?? 'gallery-called'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const ONLY = process.env.GALLERY_ONLY ?? ''
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
    await row.evaluate((node) => {
      const card = node.closest('.is-folded')
      card?.querySelector('button[title^="Show"], .card-head button')?.click()
    })
    await sleep(800)
  }
  await row.scrollIntoViewIfNeeded({ timeout: 10000 })
  await row.click()
  await sleep(1200)
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
const goTo = async (locus) => {
  const box = page.locator('input.input-region').first()
  await box.fill(locus)
  await box.press('Enter')
  await sleep(3500)
}
/** Every row of the Tracks card: its id, its summary line, and its display. */
const rows = () =>
  page.$$eval('.annotation-card .ann-row', (all) =>
    all.map((row) => {
      const summary = row.querySelector('.ann-note')?.textContent?.trim() ?? ''
      const display = row.querySelector('select[data-field="display"]')?.value ?? ''
      const look = row.querySelector('select[data-field="look"]')?.value ?? ''
      return `${row.getAttribute('data-id')} | ${summary}${display ? ` | display=${display}` : ''}${look ? ` look=${look}` : ''}`
    }),
  )
/** Open one row's settings on the Tracks card, by the end of its id (or `*part` for a part of it). */
const openRow = async (suffix) => {
  await fold('Show the Annotations panel')
  const selector = suffix.startsWith('*')
    ? `.annotation-card .ann-row[data-id*="${suffix.slice(1)}"]`
    : `.annotation-card .ann-row[data-id$="${suffix}"]`
  const row = page.locator(selector).first()
  await row.scrollIntoViewIfNeeded()
  const more = row.locator('.ann-more').first()
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click()
  await sleep(800)
  await page.locator(selector).first().scrollIntoViewIfNeeded()
  return page.locator(selector).first()
}
/** Pick an option of one of a row's dropdowns, by the select's field name. */
const pick = async (suffix, field, value) => {
  const row = await openRow(suffix)
  const select = row.locator(`select[data-field="${field}"]`).first()
  if (!(await select.count())) { console.log(`no ${field} on`, suffix); return false }
  await select.selectOption(value)
  await sleep(800)
  return true
}

try {
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(6000)

  // -------------------------------------------------------------------------
  // The run: three rows — the score, the boundaries as a 1D track under it,
  // the domains as corners along the diagonal.
  // -------------------------------------------------------------------------
  await goTo('IV:1,000,000-1,400,000')
  await openTask('Diamond insulation')
  await run('Insulation boundaries')
  await page.evaluate(() => document.querySelector('.analysis-elsewhere')?.scrollIntoView({ block: 'center' }))
  await sleep(600)
  await shot('cs01-drawer-displays')
  console.log('drawer:', JSON.stringify(await page.$$eval('.analysis-elsewhere', (all) => all.map((one) => one.innerText.replace(/\s+/g, ' ').trim()))))
  console.log('drawer dropdowns:', JSON.stringify(await page.$$eval('.analysis-surfaces select', (all) => all.map((one) => `${one.dataset.field}=${one.value}`))))
  // The boundaries put on the map from the drawer: the look appears beside the
  // display. Then back, so the rest of the walk starts from the task's choice.
  await page.locator('.analysis-surfaces select[data-field="display"]').first().selectOption('overlay')
  await sleep(800)
  await shot('cs01b-drawer-boundaries-on-the-map-with-look')
  console.log('drawer dropdowns, boundaries on the map:', JSON.stringify(await page.$$eval('.analysis-surfaces select', (all) => all.map((one) => `${one.dataset.field}=${one.value}`))))
  await page.locator('.analysis-surfaces select[data-field="display"]').first().selectOption('lane')
  await sleep(800)
  // The domains moved by their row's own dropdown on the Tracks card, the
  // drawer still open: the drawer's dropdown follows it there and back.
  const cardDisplay = (suffix, value) =>
    page.evaluate(async ({ suffix, value }) => {
      const row = () => document.querySelector(`.annotation-card .ann-row[data-id$="${suffix}"]`)
      const more = row()?.querySelector('.ann-more')
      if (more?.getAttribute('aria-expanded') !== 'true') more?.click()
      await new Promise((r) => setTimeout(r, 400))
      const select = row()?.querySelector('select[data-field="display"]')
      if (!select) return false
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, { suffix, value })
  const drawerDisplays = () =>
    page.$$eval('.analysis-surfaces select', (all) => all.map((one) => `${one.dataset.field}=${one.value}`))
  await cardDisplay('insulation-domains', 'lane')
  await sleep(800)
  console.log('drawer after the card made the domains a track:', JSON.stringify(await drawerDisplays()))
  await cardDisplay('insulation-domains', 'overlay')
  await sleep(800)
  console.log('drawer after the card put them back on the map:', JSON.stringify(await drawerDisplays()))
  await closeDrawer()
  await fold('Fold the Analysis panel')
  await sleep(1500)
  await shot('cs02-arrived-track-and-corners')
  await fold('Show the Annotations panel')
  await sleep(800)
  console.log('rows:', JSON.stringify(await rows(), null, 1))
  await page.locator('.annotation-card .ann-row[data-id$="insulation-domains"]').first().scrollIntoViewIfNeeded()
  await sleep(400)
  await shot('cs03-tracks-card-three-rows')

  // The boundaries' settings: the display first, and a track's controls.
  await openRow('insulation-boundaries')
  await shotOf('.annotation-card .ann-row[data-id$="insulation-boundaries"]', 'cs04-boundaries-row-as-track')

  // -------------------------------------------------------------------------
  // The boundaries on the map: a point, then the short diagonal marker.
  // -------------------------------------------------------------------------
  await pick('insulation-boundaries', 'display', 'overlay')
  await shotOf('.annotation-card .ann-row[data-id$="insulation-boundaries"]', 'cs05-boundaries-row-on-the-map')
  console.log('rows:', JSON.stringify(await rows(), null, 1))
  await fold('Fold the Annotations panel')
  await sleep(1500)
  await shot('cs06-boundaries-points-domains-corners')
  await goTo('IV:1,150,000-1,250,000')
  await shot('cs07-points-and-corners-close')

  await pick('insulation-boundaries', 'look', 'border')
  await fold('Fold the Annotations panel')
  await sleep(1500)
  await shot('cs08-short-diagonal-markers-close')

  // -------------------------------------------------------------------------
  // The domains back to a 1D track of long segments.
  // -------------------------------------------------------------------------
  await pick('insulation-domains', 'display', 'lane')
  await shotOf('.annotation-card .ann-row[data-id$="insulation-domains"]', 'cs09-domains-row-as-track')
  await fold('Fold the Annotations panel')
  await sleep(1500)
  await shot('cs10-domains-as-long-segments')

  // …and back on the map, then the map turned: corners stand on the axis.
  await pick('insulation-domains', 'display', 'overlay')
  await pick('insulation-boundaries', 'look', 'point')
  await fold('Fold the Annotations panel')
  await goTo('IV:1,000,000-1,400,000')
  const turn = page.locator('button[title^="Turn this map 45°"]').first()
  if (await turn.count()) {
    await turn.click()
    await sleep(3000)
    await shot('cs11-turned-corners-and-points')
    await page.locator('button[title^="Draw this map square again"]').first().click().catch(() => {})
    await sleep(2000)
  } else console.log('no turn button')

  // -------------------------------------------------------------------------
  // A reload keeps each row's display and look.
  // -------------------------------------------------------------------------
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(6000)
  await fold('Show the Annotations panel')
  await sleep(800)
  await openRow('insulation-boundaries')
  console.log('after a reload:', JSON.stringify(await rows(), null, 1))
  await shot('cs12-reloaded-rows-keep-their-display')

  // -------------------------------------------------------------------------
  // No map: the 1D browser demo, where a called set is a track and offers no display.
  // -------------------------------------------------------------------------
  if (ONLY !== 'map') {
    page = await fresh()
    await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_tracks.metacooler.json`)
    await page.waitForFunction(() => (document.body.innerText ?? '').includes('Yeast, no map'), null, { timeout: 180000 })
    await sleep(6000)
    await openTask('Peak calling')
    const signal = page.locator('.analysis-drawer select[id$="-signal"]').first()
    if (await signal.count()) {
      const text = await signal.locator('option', { hasText: 'ATAC' }).first().textContent()
      await signal.selectOption({ label: text ?? 'ATAC' })
      await sleep(600)
    }
    const keep = page.locator('.analysis-drawer input[id$="-truncate"]').first()
    if (await keep.count()) { await keep.fill('5000'); await keep.press('Enter'); await sleep(500) }
    await run('Curvature of every candidate')
    console.log('browser drawer dropdowns:', JSON.stringify(await page.$$eval('.analysis-surfaces select', (all) => all.map((one) => `${one.dataset.field}=${one.value}`))))
    await closeDrawer()
    await fold('Fold the Analysis panel')
    await goTo('IV:1,240,000-1,300,000')
    await fold('Show the Annotations panel')
    await openRow('*:peaks-')
    console.log('browser rows:', JSON.stringify(await rows(), null, 1))
    await shot('cs13-browser-peaks-a-track-no-display')
  }
} finally {
  console.log(errors.length ? `page errors:\n${errors.slice(0, 20).join('\n')}` : 'no page errors')
  await browser.close()
}
