/**
 * Inter-arm alignment's table, in headless Chromium (§18.8).
 *
 * The task gives each sequence one row: its enrichment over its own distance
 * decay, which is the measurement, and beside it the enrichment after detrend,
 * over the decay along both arms — the map's arms and Compartments'
 * expectation — which is a control on that detrending. Shot on the *E. coli*
 * demo at 5 kb, whose arms are not aligned — the form with the control's
 * window, the notes, the table — on *P. aeruginosa* PAK from the DNA Bacterial
 * Zoo at 8 kb, whose arms are, so the control has an alignment to take away, and
 * on *B. subtilis* 45 minutes after ParB is induced, at 10 kb, whose alignment
 * has run to the terminus. Each table and its notes are printed as well as shot.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-interarm.mjs [out-dir]
 *
 * The zoo and the *B. subtilis* demo are read over the network
 * (`GALLERY_DATA`, `GALLERY_SUBTILIS` point elsewhere). Behind a proxy (`HTTPS_PROXY`) the browser
 * is sent through it, the dev server excepted.
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
const ZOO = process.env.GALLERY_DATA ?? 'https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/PAK_MM142'
const SUBTILIS =
  process.env.GALLERY_SUBTILIS ??
  'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/subtilis/Bsubtilis_induction_45min%5Emapped_PY79%5ELW6QCG.mcool'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const proxy = process.env.HTTPS_PROXY

// Chromium's own flags rather than Playwright's `proxy`, which sends loopback
// through the proxy too — and a proxy that only tunnels HTTPS answers the dev
// server's plain HTTP with a 405. Chromium's own rules leave loopback direct.
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    ...(proxy === undefined || proxy === '' ? [] : [`--proxy-server=${proxy}`]),
  ],
})
const errors = []
let page = null
const fresh = async () => {
  const next = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const until = (text, timeout = 180000) =>
  page.waitForFunction((t) => (document.body.innerText ?? '').includes(t), text, { timeout })
    .catch(() => console.log('never saw:', text))
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
const run = async () => {
  const before = await computed()
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction((before) => {
    const text = document.querySelector('.analysis-drawer-body')?.innerText ?? ''
    const now = text.match(/computed in [^\n]*/)?.[0] ?? ''
    return now !== '' && now !== before && text.includes('Inter-arm alignment per sequence')
  }, before, { timeout: 300000 }).catch(() => console.log('run did not finish'))
  await sleep(1500)
}
const openInterArm = async () => {
  for (const b of await page.$$('button[title^="Show the Analysis panel"]')) {
    if (await b.isVisible()) { await b.click(); await sleep(800); break }
  }
  const row = page.locator('.analysis-row-title', { hasText: 'Inter-arm alignment' }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1200)
}
const table = () => page.evaluate(() => {
  const body = document.querySelector('.analysis-drawer-body')
  const last = [...(body?.querySelectorAll('table') ?? [])].at(-1)
  return [...(last?.querySelectorAll('tr') ?? [])]
    .map((tr) => [...tr.children].map((cell) => (cell.textContent ?? '').trim()).join(' | '))
    .join('\n')
})
const notes = () =>
  page.evaluate(() => [...document.querySelectorAll('.analysis-drawer-body li')].map((li) => li.innerText).join('\n'))
const toTable = async () => {
  await page.evaluate(() => {
    const body = document.querySelector('.analysis-drawer-body')
    const hit = [...(body?.querySelectorAll('*') ?? [])].find((el) => el.childElementCount === 0 && /Inter-arm alignment per sequence/.test(el.textContent ?? ''))
    hit?.scrollIntoView({ block: 'center' })
  })
  // Shot at once, the table's head was caught before its buttons were painted.
  await sleep(500)
}
/** The map, with the origin typed into the Chromosomes table first, as a reader would. */
const openWithOrigin = async (map, sequence, origin) => {
  await page.goto(`${BASE}/#uri=${encodeURIComponent(map)}&view=contigs`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('input.tedit', { timeout: 180000 }).catch(() => {})
  await sleep(1500)
  const box = page.locator('input.tedit').first()
  if (await box.count()) {
    await box.click()
    await box.fill(origin)
    await box.press('Enter')
    await sleep(800)
  }
  await page.goto(`${BASE}/#uri=${encodeURIComponent(map)}&view=region&region=${sequence}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.heatmap-canvas', { timeout: 180000 })
  await sleep(5000)
}

try {
  // E. coli: MukBEF does not align the arms, so both rows are near nothing.
  page = await fresh()
  await openWithOrigin(`${BASE}/demo/ecoli/Ecoli.mcool::/resolutions/5000`, 'NC_000913.3', '3,925,744')
  await openInterArm()
  await shot('ia1-form')
  await run()
  console.log('E. coli notes:\n' + (await notes()))
  console.log('E. coli table:\n' + (await table()))
  await shot('ia2-ecoli-result')
  await toTable()
  await shot('ia3-ecoli-table')

  // P. aeruginosa PAK: its arms are held together from the origin, and the
  // control is what is left once the decay along them is divided out.
  page = await fresh()
  await openWithOrigin(`${ZOO}/PAK_MM142.mcool::/resolutions/8000`, 'LR657304.1', '6,374,501')
  await until('reads as circular', 60000)
  await openInterArm()
  await run()
  console.log('PAK notes:\n' + (await notes()))
  console.log('PAK table:\n' + (await table()))
  await shot('ia4-pak-result')
  await toTable()
  await shot('ia5-pak-table')

  // B. subtilis, 45 minutes into ParB induction: the alignment has spread from
  // parS to the terminus, and the reach is the whole arm.
  page = await fresh()
  await openWithOrigin(`${SUBTILIS}::/resolutions/10000`, 'NC_022898.1', '1')
  await until('reads as circular', 60000)
  await openInterArm()
  await run()
  console.log('B. subtilis notes:\n' + (await notes()))
  console.log('B. subtilis table:\n' + (await table()))
  await toTable()
  await shot('ia6-subtilis-table')
} finally {
  console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors')
  await browser.close()
}
