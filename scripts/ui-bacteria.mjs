/**
 * Drive the bacterial chain in headless Chromium and write one screenshot a step.
 *
 * What `ui-gallery.mjs` cannot show, because the yeast demo has no circle and no
 * origin: *P. aeruginosa* PAK from the DNA Bacterial Zoo, read as circular on
 * its first open, its origin and terminus placed from its sequence, its
 * composition drawn, the map framed on the origin — `ori` lit while it is, and
 * pressed again to frame the sequence from its first base — the O/E taken along
 * both arms and correlated, the two tasks that read the arms (§8.15, §18.8), and
 * the composition again in a 1D browser holding the FASTA alone (§5.8).
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-bacteria.mjs [out-dir]
 *
 * The map, reference and coverage are read from the lab's bucket unless
 * GALLERY_DATA names a folder served with byte ranges and CORS
 * (`python3 scripts/DBZ_store.py serve <folder>`) holding the same three names.
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

const OUT = process.argv[2] ?? 'gallery-bacteria'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const DATA = process.env.GALLERY_DATA ?? 'https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/PAK_MM142'
const MAP = `${DATA}/PAK_MM142.mcool`
const FASTA = `${DATA}/PAK.fa`
const COVERAGE = process.env.GALLERY_DATA
  ? `${DATA}/PAK_MM142_500.coverage.coverage-total.bw`
  : `${DATA}/coverage/PAK_MM142_500.coverage.coverage-total.bw`
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const errors = []
// A fresh tab, for the part of the chain that starts from nothing open.
const fresh = async () => {
  const next = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
let page = await fresh()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const until = (text, timeout = 180000) =>
  page.waitForFunction((t) => (document.body.innerText ?? '').includes(t), text, { timeout })
    .catch(() => console.log('never saw:', text))
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return true }
  }
  return false
}
// No card has a box to paste a URL into, so a file gets in by being dropped:
// fetched in the page, made a File, and handed over with a DataTransfer.
const dropTrack = (url, name) => page.evaluate(async ({ url, name }) => {
  const target = [...document.querySelectorAll('.ann-drop')].find((el) => /Load a track/.test(el.textContent ?? ''))
  if (target === undefined) throw new Error('no track drop zone')
  const file = new File([await (await fetch(url)).arrayBuffer()], name)
  const transfer = new DataTransfer()
  transfer.items.add(file)
  for (const kind of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }
}, { url, name })
const openTask = async (title) => {
  // The drawer covers the panel's rows while it is open.
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) { await close.click(); await sleep(600) }
  const row = page.locator('.analysis-row-title', { hasText: title }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1200)
}
const choose = async (optionText) => {
  const select = page.locator('.analysis-drawer select').filter({ has: page.locator('option', { hasText: optionText }) }).first()
  if (!(await select.count())) { console.log('no select offers', optionText); return }
  const label = await select.locator('option', { hasText: optionText }).first().textContent()
  await select.selectOption({ label: label ?? optionText })
  await sleep(600)
}
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
// Run, and wait for *this* run's line: the drawer keeps the last result on
// screen, so waiting for a result to exist returns at once.
const run = async (marker) => {
  const before = await computed()
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(({ before, marker }) => {
    const text = document.querySelector('.analysis-drawer-body')?.innerText ?? ''
    const now = text.match(/computed in [^\n]*/)?.[0] ?? ''
    return now !== '' && now !== before && text.includes(marker)
  }, { before, marker }, { timeout: 300000 }).catch(() => console.log('run did not finish:', marker))
  await sleep(1500)
}
const scrollDrawerTo = (needle) => page.evaluate((needle) => {
  const body = document.querySelector('.analysis-drawer-body')
  const hit = [...(body?.querySelectorAll('*') ?? [])].find((el) => el.childElementCount === 0 && (el.textContent ?? '').includes(needle))
  hit?.scrollIntoView({ block: 'start' })
}, needle)
const notes = () => page.evaluate(() => [...document.querySelectorAll('.analysis-drawer-body li')].map((li) => li.innerText).join('\n'))
const word = (text) => page.locator('button').filter({ has: page.locator(`.btn-word-text:text-is("${text}")`) }).first()
const rung = (kb) => `${MAP}::/resolutions/${kb * 1000}`
// Whether `ori` is lit, and where the view says it is.
const ori = async (when) => {
  const state = await word('ori').getAttribute('aria-pressed')
  const region = await page.evaluate(() => decodeURIComponent(location.hash).match(/region=[^&]*/)?.[0] ?? '')
  console.log(`ori ${when}: aria-pressed=${state} · ${region}`)
}
// The map's controls, close up, so a lit button can be told from an unlit one.
const controls = async (name) => {
  // Off the button first: a pointer left on it after a press draws its hover.
  await page.mouse.move(5, 5)
  await sleep(300)
  const box = await word('ori').boundingBox()
  if (box === null) return
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: { x: Math.max(0, box.x - 420), y: Math.max(0, box.y - 14), width: 560, height: box.height + 28 },
  })
  console.log('shot', name)
}

// A map dropped on the Contact maps card, fetched in the page as a file.
const dropMap = (url, name) => page.evaluate(async ({ url, name }) => {
  const target = [...document.querySelectorAll('.ann-drop')].find((el) => /Load a contact map/.test(el.textContent ?? ''))
  if (target === undefined) throw new Error('no map drop zone')
  const file = new File([await (await fetch(url)).arrayBuffer()], name)
  const transfer = new DataTransfer()
  transfer.items.add(file)
  for (const kind of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }
}, { url, name })
const circleTicked = () => page.evaluate(() =>
  [...document.querySelectorAll('input.tcheck')].some((box) => box.checked && /is read as a circle/.test(box.title)))
const originBox = () => page.evaluate(() => {
  const box = document.querySelector('input.tedit')
  return box === null ? null : { value: box.value, placeholder: box.placeholder, title: box.title }
})

// GALLERY_ONLY runs one part alone: `groups` for Signal by group,
// `declarations` for a 1D browser's Chromosomes table, a map dropped over it,
// and a map's default origin, and `store` for the DNA Bacterial Zoo as
// scripts/dbz-store.sh writes it — GALLERY_STORE names its store.chromosomix.json, served
// by `python3 scripts/DBZ_store.py serve <store>`; the lab's bucket otherwise.
const ONLY = process.env.GALLERY_ONLY ?? ''
const STORE = process.env.GALLERY_STORE ?? 'https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.chromosomix.json'
const DBZ_STORE = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.chromosomix.json'

try {
  if (ONLY === '') {
  await page.goto(`${BASE}/#uri=${encodeURIComponent(rung(4))}&view=contigs`)
  await until('reads as circular')
  await sleep(1500)
  await shot('b01-detected-circular')

  await fold('Show the Annotations panel')
  await page.waitForSelector('.ann-drop', { timeout: 30000 })
  await dropTrack(FASTA, 'PAK.fa')
  await sleep(4000)
  await dropTrack(COVERAGE, 'PAK_coverage-total.bw')
  await sleep(4000)

  await fold('Show the Analysis panel')
  await sleep(1200)
  await openTask('Origin and terminus')
  await choose('PAK_coverage-total')
  await run('Origin and terminus per sequence')
  await until('Origin set on')
  console.log('origin and terminus:\n' + (await notes()))
  await shot('b02-oriter-result')
  await scrollDrawerTo('Origin and terminus per sequence')
  await sleep(500)
  await shot('b03-oriter-table')

  await openTask('Base composition')
  console.log('bin size on the 4 kb map:', await page.locator('.analysis-drawer input[id$="-resolution"]').first().inputValue())
  await run('Cumulative GC skew')
  await shot('b04-composition')
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) await close.click()
  await sleep(800)
  await shot('b05-origin-column')
  await page.evaluate(() => {
    const lane = [...document.querySelectorAll('input')].find((el) => /^GC skew · PAK/.test(el.value ?? ''))
    lane?.scrollIntoView({ block: 'center' })
  })
  await sleep(600)
  await shot('b05b-lane-exports')

  // The chromosome's map, with room to see it.
  await page.evaluate((hash) => { location.hash = hash }, `#uri=${encodeURIComponent(rung(4))}&view=region&region=LR657304.1`)
  await sleep(6000)
  for (const name of ['General', 'Annotations', 'Analysis']) await fold(`Fold the ${name} panel`)
  await sleep(4000)
  await shot('b06-map')
  await word('ori').click()
  await sleep(8000)
  await ori('after pressing it')
  await shot('b07-ori-centred')
  await controls('b07a-ori-lit')
  // A zoom about the middle keeps the origin there; a pan moves it off, and the
  // address does not follow a pan, so pressing `ori` then has to rebuild.
  const middle = async () => {
    const box = await page.locator('.heatmap-canvas').first().boundingBox()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  let at = await middle()
  await page.mouse.move(at.x, at.y)
  await page.mouse.wheel(0, -400)
  await sleep(5000)
  await ori('after a wheel zoom at the middle')
  at = await middle()
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 160, at.y, { steps: 8 })
  await page.mouse.up()
  await sleep(5000)
  await ori('after a pan')
  await shot('b07b-ori-panned')
  await word('ori').click()
  await sleep(8000)
  await ori('pressed after the pan')
  await page.locator('button.btn-zoom').nth(2).click()
  await sleep(8000)
  await ori('after the bar’s 3× zoom')
  await shot('b07c-ori-zoomed')
  // Lit, it frames the sequence from its first base; unlit, it centres again.
  await word('ori').click()
  await sleep(8000)
  await ori('pressed while lit')
  await shot('b07d-ori-uncentred')
  await controls('b07e-ori-unlit')
  await word('ori').click()
  await sleep(8000)
  await ori('centred once more')
  await word('O/E').click()
  await sleep(5000)
  await shot('b08-oe')
  await word('arms').click()
  await sleep(6000)
  await shot('b09-oe-arms')

  // The correlation, at the rung the map can draw one at.
  await page.locator('label.res-stop', { hasText: /^8 kb$/ }).first().click()
  await sleep(8000)
  const score = page.locator('select').filter({ has: page.locator('option', { hasText: /^correlation$/ }) }).first()
  await score.selectOption({ label: 'correlation' })
  await sleep(10000)
  await shot('b10-correlation-arms')
  await word('arms').click()
  await sleep(10000)
  await shot('b11-correlation-plain')
  await word('arms').click()
  await sleep(6000)

  await fold('Show the Analysis panel')
  await sleep(1000)
  await openTask('Inter-arm alignment')
  await run('Inter-arm alignment per sequence')
  await shot('b12-interarm')
  await scrollDrawerTo('Inter-arm alignment per sequence')
  await sleep(500)
  await shot('b13-interarm-table')

  await openTask('Compartments')
  await choose('decay along both arms')
  await choose('GC content')
  await shot('b14-compartments-form')
  await run('Components')
  console.log('compartments:\n' + (await notes()))
  await shot('b15-compartments')
  await scrollDrawerTo('Components ·')
  await sleep(500)
  await shot('b16-components-table')

  // The same run by the correlation of observed/expected's rows, as
  // Lieberman-Aiden et al. (2009) did, rather than by cooltools' default
  // (§18.8) — E1 still the largest eigenvalue's, GC content still only its sign.
  await choose('Lieberman-Aiden 2009')
  await scrollDrawerTo('method')
  await sleep(500)
  await shot('b16b-compartments-correlation-form')
  await run('arms · correlation')
  console.log('compartments by the correlation:\n' + (await notes()))
  await shot('b16c-compartments-correlation')
  await scrollDrawerTo('Components ·')
  await sleep(500)
  await shot('b16d-components-correlation')

  // A 1D browser on the reference alone: no map, so the bin size is 10 kb.
  page = await fresh()
  await page.goto(`${BASE}/#uri=${encodeURIComponent(FASTA)}`)
  await until('the sequences')
  await sleep(4000)
  await fold('Show the Analysis panel')
  await sleep(1200)
  await openTask('Base composition')
  console.log('bin size with no map:', await page.locator('.analysis-drawer input[id$="-resolution"]').first().inputValue())
  await shot('b17-browser-composition-form')
  await run('Cumulative GC skew')
  await shot('b18-browser-composition')
  const shut = page.locator('.analysis-drawer-head button').last()
  if (await shut.isVisible().catch(() => false)) await shut.click()
  await sleep(1500)
  await shot('b19-browser-lanes')
  }

  if (ONLY === '' || ONLY === 'groups') {
  // Signal by group (§18.8): GC content compared between the compartments the
  // arms' reading found — by the A/B call's names, and by E1's sign. The origin
  // is typed into the table rather than called, which is the other hand that
  // writes it (§8.15).
  page = await fresh()
  await page.goto(`${BASE}/#uri=${encodeURIComponent(rung(8))}&view=contigs`)
  await until('reads as circular')
  await sleep(1500)
  const origin = page.locator('input.tedit').first()
  await origin.click()
  await origin.fill('6,374,501')
  await origin.press('Enter')
  await sleep(500)
  await fold('Show the Annotations panel')
  await page.waitForSelector('.ann-drop', { timeout: 30000 })
  await dropTrack(FASTA, 'PAK.fa')
  await sleep(4000)
  // The map of the chromosome, which is what the compartments are read from.
  await page.evaluate((hash) => { location.hash = hash }, `#uri=${encodeURIComponent(rung(8))}&view=region&region=LR657304.1`)
  await sleep(6000)
  await fold('Show the Analysis panel')
  await sleep(1200)
  await openTask('Base composition')
  await run('Cumulative GC skew')
  await openTask('Compartments')
  await choose('decay along both arms')
  await choose('GC content')
  await run('Components')
  await openTask('Signal by group')
  await page.locator('.analysis-drawer label.param-check', { hasText: 'GC content · PAK' }).locator('input').check()
  await sleep(400)
  await choose('A/B compartments')
  await shot('b26-groups-form')
  await run('Between groups')
  console.log('signal by group:\n' + (await notes()))
  await shot('b27-groups-violins')
  await scrollDrawerTo('Groups ·')
  await sleep(500)
  await shot('b28-groups-table')
  await scrollDrawerTo('Between groups')
  await sleep(500)
  await shot('b29-groups-tests')
  await choose('a track')
  await choose('E1 · LR657304.1')
  await run('by sign')
  await shot('b30-groups-by-sign')
  }

  if (ONLY === '' || ONLY === 'declarations') {
  // A 1D browser's Chromosomes table (§5.8): a circle ticked and an origin typed
  // with no map open, taken by the map dropped over the browser (§8.15).
  page = await fresh()
  await page.goto(`${BASE}/#uri=${encodeURIComponent(FASTA)}`)
  await until('the sequences')
  await sleep(3000)
  await page.locator('.crumb-arrow').first().click()
  await sleep(300)
  await page.locator('.crumb-menu-item', { hasText: 'Chromosomes' }).first().click()
  await sleep(2500)
  console.log('browser table, before:', JSON.stringify(await originBox()))
  await shot('b20-browser-chromosomes')
  await page.locator('.td-check input.tcheck').first().click()
  const typed = page.locator('input.tedit').first()
  await typed.click()
  await typed.fill('6,374,501')
  await typed.press('Enter')
  await sleep(800)
  console.log('browser table, after:', JSON.stringify(await originBox()), 'circle:', await circleTicked())
  await shot('b21-browser-declared')
  await page.locator('input.tedit').first().click()
  await page.locator('input.tedit').first().fill('7,000,000')
  await page.locator('input.tedit').first().press('Enter')
  await sleep(500)
  console.log('past the end:', JSON.stringify(await originBox()))
  await page.mouse.move(5, 5)
  await page.locator('input.tedit').first().hover()
  await sleep(600)
  await shot('b22-origin-refused')

  await fold('Show the Annotations panel')
  await page.waitForSelector('.ann-drop', { timeout: 30000 })
  await dropMap(`${MAP}`, 'PAK_MM142.mcool')
  await until('reads as circular', 60000)
  await sleep(4000)
  console.log('map table:', JSON.stringify(await originBox()), 'circle:', await circleTicked())
  await shot('b23-map-took-declarations')

  // A map with nothing declared: its origin is the first base, and the arms
  // are read from it rather than refused.
  page = await fresh()
  await page.goto(`${BASE}/#uri=${encodeURIComponent(rung(4))}&view=contigs`)
  await until('reads as circular')
  await sleep(1500)
  console.log('fresh map table:', JSON.stringify(await originBox()))
  await shot('b24-default-origin')
  await page.evaluate((hash) => { location.hash = hash }, `#uri=${encodeURIComponent(rung(4))}&view=region&region=LR657304.1`)
  await sleep(6000)
  for (const name of ['General', 'Annotations', 'Analysis']) await fold(`Fold the ${name} panel`)
  await sleep(3000)
  console.log('arms enabled:', await word('arms').isEnabled(), '·', await word('arms').getAttribute('title'))
  await word('ori').click()
  await sleep(8000)
  await ori('on the first base')
  await shot('b25-ori-on-first-base')
  }
  if (ONLY === '' || ONLY === 'store') {
    // The store: a card a species, its session the card's button.
    page = await fresh()
    await page.goto(`${BASE}/?store=${encodeURIComponent(STORE)}`)
    await page.waitForSelector('.genomes-card', { timeout: 60000 })
    await sleep(1500)
    await shot('b31-store-cards')
    const card = page.locator('.genomes-card', { has: page.locator('.gallery-card-title', { hasText: /^PAK$/ }) }).first()
    console.log('PAK card:', (await card.innerText()).split('\n').slice(0, 3).join(' · '))
    console.log('its session:', await card.locator('.gallery-card-open').getAttribute('title'))

    // Its fold: the map, the reference and every track, each a row.
    await card.locator('summary').click()
    await sleep(800)
    await card.locator('summary').scrollIntoViewIfNeeded()
    await shot('b32-store-fold')
    console.log('fold:', (await card.locator('.portal-name').allInnerTexts()).join(' | '))

    // The session: the map whole at 4 kb, and under it three tracks — nothing drawn on it.
    await card.locator('summary').click()
    await card.locator('.gallery-card-open').click()
    await sleep(15000)
    for (const name of ['General', 'Annotations', 'Analysis']) await fold(`Fold the ${name} panel`)
    await sleep(4000)
    console.log('session hash:', await page.evaluate(() => decodeURIComponent(location.hash)))
    await shot('b33-session')

    // What the session declared: the circle, and the origin E1's arms were read from.
    await page.evaluate(() => { location.hash = location.hash.replace(/view=[a-z]+/, 'view=contigs') })
    await sleep(5000)
    console.log('declared:', JSON.stringify(await originBox()), 'circle:', await circleTicked())
    await shot('b34-session-declarations')

    // `ori`, on the origin the session carries, with the three tracks under it:
    // on the chromosome's own view, which is where the arms have one sequence.
    await page.evaluate(() => {
      location.hash = location.hash.replace(/view=[a-z]+/, 'view=region') + '&region=LR657304.1'
    })
    await sleep(6000)
    await word('ori').click()
    await sleep(8000)
    await ori('on the declared origin')
    await shot('b35-session-ori')

    // The shipped tile with nothing uploaded yet names what builds it. A dev
    // feature (§29): the switch goes on first, or `dbz` names no tile.
    page = await fresh()
    await page.route(DBZ_STORE, (route) => route.fulfill({ status: 404, body: 'Not Found' }))
    await page.goto(`${BASE}/`)
    await page.evaluate(() => localStorage.setItem('chromosomix:dev-features', 'on'))
    await page.goto(`${BASE}/?store=dbz`)
    await until('Nothing has been published', 30000)
    await sleep(1000)
    console.log('unpublished:', await page.evaluate(() => document.querySelector('.portal-status')?.textContent ?? ''))
    await shot('b36-dbz-unpublished')
  }
} catch (error) {
  console.log('FAILED', error)
  await shot('99-failure')
} finally {
  console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 10))
  await browser.close()
}
