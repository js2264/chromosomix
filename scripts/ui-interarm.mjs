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
 * On PAK, the profile after detrend beside the profile it removes, on one axis,
 * and the decay curves along the diagonal and along both arms. Last, the ParB
 * time course as one deck: the all-maps table drawn as the reach against the
 * minutes in each map's name, its least-squares line over every point, and
 * again over the box drawn across the points that are under way.
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
// The ParB time course as one deck: a workspace naming each map by its condition,
// written beside the gallery and served by the dev server (`GALLERY_COURSE` to
// point elsewhere).
const COURSE_DIR = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/subtilis/'
const COURSE_MAPS = [
  ['WT', 'Bsubtilis_WT%5Emapped_PY79%5EFKEBR7.mcool'],
  ['ΔparAB', 'Bsubtilis_dparAB%5Emapped_PY79%5ENT9IOH.mcool'],
  ['+parB 0 min', 'Bsubtilis_induction_0min%5Emapped_PY79%5E14WJZP.mcool'],
  ['+parB 15 min', 'Bsubtilis_induction_15min%5Emapped_PY79%5E3JNIKY.mcool'],
  ['+parB 20 min', 'Bsubtilis_induction_20min%5Emapped_PY79%5E4WPQI3.mcool'],
  ['+parB 30 min', 'Bsubtilis_induction_30min%5Emapped_PY79%5EYKZ54M.mcool'],
  ['+parB 35 min', 'Bsubtilis_induction_35min%5Emapped_PY79%5EFSTYHN.mcool'],
  ['+parB 45 min', 'Bsubtilis_induction_45min%5Emapped_PY79%5ELW6QCG.mcool'],
]
const COURSE_RUNG = '::/resolutions/10000'
const COURSE_FILE = join(OUT, '_parb-course.chromosomix.json')
mkdirSync(OUT, { recursive: true })
writeFileSync(
  COURSE_FILE,
  JSON.stringify({
    kind: 'chromosomix.workspace',
    version: 1,
    active: 0,
    tabs: [{
      version: 1,
      name: 'ParB induction',
      state: {
        uri: COURSE_DIR + COURSE_MAPS[0][1] + COURSE_RUNG,
        maps: COURSE_MAPS.slice(1).map(([, file]) => COURSE_DIR + file + COURSE_RUNG).join('|'),
        view: 'region',
        region: 'NC_022898.1',
        balance: true,
      },
      circular: ['NC_022898.1'],
      origins: { 'NC_022898.1': 0 },
      deck: { columns: 4 },
      mapNames: Object.fromEntries(COURSE_MAPS.map(([name, file]) => [COURSE_DIR + file, name])),
    }],
  }),
)
const COURSE = process.env.GALLERY_COURSE ?? `${BASE}/${COURSE_FILE}`
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
  // The profile after detrend, on the measurement's axis, and the two decays.
  for (const [needle, name] of [
    ['Inter-arm alignment after detrend', 'ia5b-pak-after-detrend'],
    ['Contact decay along the diagonal and along both arms', 'ia5c-pak-decays'],
  ]) {
    await page.evaluate((needle) => {
      const body = document.querySelector('.analysis-drawer-body')
      const hit = [...(body?.querySelectorAll('.analysis-figure-title') ?? [])].find((el) => (el.textContent ?? '').startsWith(needle))
      hit?.scrollIntoView({ block: 'start' })
    }, needle)
    await sleep(800)
    await shot(name)
  }

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

  // The time course as one deck, named by condition, every map run at once; the
  // all-maps table drawn as the reach against the minutes in each name.
  page = await fresh()
  await page.goto(`${BASE}/?config=${encodeURIComponent(COURSE)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(
    () => !(document.body.innerText ?? '').includes('opening...') && document.querySelectorAll('.heatmap-canvas').length >= 4,
    null, { timeout: 600000 },
  ).catch(() => console.log('the deck did not open'))
  await sleep(3000)
  await openInterArm()
  await page.locator('.analysis-drawer button', { hasText: /^run on all/ }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.analysis-drawer .analysis-map').length >= 5, null, { timeout: 600000 })
    .catch(() => console.log('run on all maps did not finish'))
  await sleep(3000)
  await page.locator('.analysis-drawer .analysis-map', { hasText: /^all maps$/ }).first().click()
  await sleep(2500)
  console.log('time course, all maps:\n' + (await table()))
  const block = page.locator('.analysis-figure').filter({ has: page.locator('.analysis-figure-title', { hasText: /^Inter-arm alignment per sequence — all maps$/ }) }).first()
  await block.locator('.figure-enlarge').click()
  await sleep(1200)
  const field = (label) => page.locator('.figure-settings label.field').filter({ has: page.locator(`.field-label:text-is("${label}")`) }).locator('select').first()
  await field('plot').selectOption('reach')
  await sleep(800)
  console.log('against offers:', JSON.stringify(await field('against').locator('option').evaluateAll((o) => o.map((x) => x.value))))
  await field('against').selectOption('map')
  await sleep(800)
  const word = page.locator('.figure-settings .field-label', { hasText: /^least squares$/ }).first()
  await page.locator(`.figure-settings button[aria-labelledby="${await word.getAttribute('id')}"]`).first().click()
  await sleep(1500)
  await shot('ia7-course-reach-dialog')
  await page.keyboard.press('Escape')
  await sleep(1000)
  const legend = () => page.evaluate(() =>
    [...document.querySelectorAll('.analysis-drawer-body svg text')].map((t) => t.textContent).filter((t) => /least squares/.test(t ?? '')))
  console.log('fit over every point:', JSON.stringify(await legend()))
  await block.scrollIntoViewIfNeeded()
  await sleep(600)
  await shot('ia8-course-reach-every-point')
  // A box drawn across the points that are under way, ⌘ or Ctrl held: the line refits to them.
  const geometry = await block.evaluate((node) => {
    let chart = null
    for (const svg of node.querySelectorAll('svg')) {
      const r = svg.getBoundingClientRect()
      if (chart === null || r.width * r.height > chart.width * chart.height) chart = { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const ticks = [...node.querySelectorAll('svg text')]
      .map((t) => { const r = t.getBoundingClientRect(); return { text: (t.textContent ?? '').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 } })
      .filter((t) => /^\d+$/.test(t.text))
    const bottom = Math.max(...ticks.map((t) => t.y))
    return { chart, row: ticks.filter((t) => Math.abs(t.y - bottom) < 3).sort((a, b) => a.x - b.x) }
  })
  const [first, last] = [geometry.row[0], geometry.row.at(-1)]
  const at = (minutes) => first.x + ((minutes - Number(first.text)) * (last.x - first.x)) / (Number(last.text) - Number(first.text))
  const y = geometry.chart.y + geometry.chart.height * 0.55
  await page.keyboard.down('Control')
  await page.mouse.move(at(8), y)
  await page.mouse.down()
  await page.mouse.move(at(30), y + 2, { steps: 6 })
  await page.mouse.move(at(48), y + 4, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await sleep(2500)
  console.log('fit over the box:', JSON.stringify(await legend()))
  await shot('ia9-course-reach-under-way')
} finally {
  console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors')
  await browser.close()
}
