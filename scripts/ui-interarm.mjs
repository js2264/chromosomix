/**
 * Inter-arm alignment read as the map is drawn, in headless Chromium (§18.8).
 *
 * On the *E. coli* demo at 5 kb, with its origin declared: the task's drawer
 * over the map as it opens — balanced counts on `log10` — saying what it will
 * read the map as, and its run; then the O/E switched on in the Map card, the
 * finished result marked as having moved, and the run again; then the O/E along
 * both arms; then the correlation, whose ratio is read on its own `log2` rather
 * than the coefficient's linear scale. Each run's line, curve and table are
 * printed as well as shot.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-interarm.mjs [out-dir]
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
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const word = (text) => page.locator('button').filter({ has: page.locator(`.btn-word-text:text-is("${text}")`) }).first()
const line = () => page.evaluate(() => document.querySelector('.analysis-framing')?.textContent ?? '')
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
const run = async () => {
  const before = await computed()
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction((before) => {
    const now = document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? ''
    return now !== '' && now !== before
  }, before, { timeout: 300000 }).catch(() => console.log('run did not finish'))
  await sleep(1500)
}
const said = () => page.evaluate(() => {
  const body = document.querySelector('.analysis-drawer-body')
  const table = [...(body?.querySelectorAll('table') ?? [])].at(-1)
  const rows = [...(table?.querySelectorAll('tr') ?? [])].map((tr) => [...tr.children].map((cell) => (cell.textContent ?? '').trim()).join(' | '))
  const titles = [...(body?.querySelectorAll('.analysis-figure-title') ?? [])].map((node) => node.textContent ?? '')
  return `${titles.join('\n')}\n${rows.join('\n')}`
})
// The drawer floats over the map and its cards while it is open.
const closeDrawer = async () => {
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) { await close.click(); await sleep(600) }
}
const openTask = async (title) => {
  await closeDrawer()
  const row = page.locator('.analysis-row-title', { hasText: title }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1200)
}
const toTable = () => page.evaluate(() => {
  const body = document.querySelector('.analysis-drawer-body')
  const hit = [...(body?.querySelectorAll('*') ?? [])].find((el) => el.childElementCount === 0 && /Inter-arm alignment per sequence/.test(el.textContent ?? ''))
  hit?.scrollIntoView({ block: 'center' })
})

try {
  // The origin as the Origin and terminus task finds it on this map, so the
  // arms are read from where they start.
  const map = encodeURIComponent(`${BASE}/demo/ecoli/Ecoli.mcool::/resolutions/5000`)
  await page.goto(`${BASE}/#uri=${map}&view=region&region=NC_000913.3`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
  // Declared on the Chromosomes table's origin box, as a reader would.
  await page.goto(`${BASE}/#uri=${map}&view=contigs`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input.tedit', { timeout: 60000 }).catch(() => {})
  const box = page.locator('input.tedit').first()
  if (await box.count()) {
    await box.fill('3,925,744')
    await box.press('Enter')
    await sleep(800)
  }
  await page.goto(`${BASE}/#uri=${map}&view=region&region=NC_000913.3`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)

  for (const b of await page.$$('button[title^="Show the Analysis panel"]')) {
    if (await b.isVisible()) { await b.click(); await sleep(800); break }
  }
  await openTask('Inter-arm alignment')
  console.log('before a run:', await line())
  await shot('ia1-drawer-counts')
  await run()
  console.log('counts, log10:\n' + (await said()))
  await toTable()
  await shot('ia2-result-counts')

  // The O/E switched on in the Map card, with the drawer out of its way.
  await closeDrawer()
  await word('O/E').click()
  await sleep(3000)
  await shot('ia3-map-oe')
  await openTask('Inter-arm alignment')
  console.log('after O/E:', await line())
  await shot('ia4-moved')
  await run()
  console.log('O/E, log2:\n' + (await said()))
  await toTable()
  await shot('ia5-result-oe')

  await closeDrawer()
  await word('arms').click()
  await sleep(3000)
  await openTask('Inter-arm alignment')
  console.log('after arms:', await line())
  await run()
  console.log('O/E along the arms:\n' + (await said()))
  await toTable()
  await shot('ia6-result-arms')

  // The correlation from the score picker, with the arms off: the picture is a
  // coefficient on a linear scale, and the task reads the ratio under it.
  await closeDrawer()
  await word('arms').click()
  await sleep(2000)
  const picker = page.locator('select').filter({ has: page.locator('option[value="correlation"]') }).first()
  await picker.selectOption('correlation')
  await page.waitForFunction(() => /correlation/i.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {})
  await sleep(6000)
  await openTask('Inter-arm alignment')
  console.log('under a correlation:', await line())
  await run()
  console.log('O/E under the correlation:\n' + (await said()))
  await shot('ia7-correlation')
} finally {
  console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors')
  await browser.close()
}
