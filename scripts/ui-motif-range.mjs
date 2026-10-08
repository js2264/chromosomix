/**
 * Drive *Find a motif* over references read by range, in headless Chromium,
 * and write one screenshot a step (§8.8, §8.21, §18.8).
 *
 * First a genome too large to hold: an 80 Mb FASTA of three sequences with its
 * `.fai`, written by this script under `out/motif-range/` (git-ignored) and
 * opened alone in the 1D browser — so it is read by range from its index, as
 * a mouse genome is. The row says so; the form ticks every sequence and prices
 * the search as a scan in bytes and requests; a run is caught mid-way with its
 * bar naming the sequence being read; then the lane, and a second run over one
 * sequence ticked, priced as that sequence and landing as a row of its own.
 * Then the yeast tracks demo with its `.2bit` beside the FASTA: the same form
 * on the `.2bit` priced at a quarter of a byte a base, its sites at a locus,
 * and the same form on the FASTA held whole, still free — the two runs' counts
 * printed, which must agree. Prints the cost line and the notes.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-motif-range.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs'
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
const DATA = 'out/motif-range'
mkdirSync(OUT, { recursive: true })
mkdirSync(DATA, { recursive: true })

// ---------------------------------------------------------------------------
// The data: a genome past the whole-read line, with its index
// ---------------------------------------------------------------------------

const SEQUENCES = [
  ['chr1', 40_000_000],
  ['chr2', 25_000_000],
  ['chr3', 15_000_000],
]
const FASTA = join(DATA, 'large-genome.fa')
if (!existsSync(`${FASTA}.fai`)) {
  let seed = 11
  const fd = openSync(FASTA, 'w')
  const fai = []
  let at = 0
  for (const [name, length] of SEQUENCES) {
    const head = `>${name}\n`
    writeSync(fd, head)
    at += head.length
    fai.push(`${name}\t${length}\t${at}\t60\t61`)
    const line = Buffer.alloc(61)
    for (let done = 0; done < length; done += 60) {
      const n = Math.min(60, length - done)
      for (let i = 0; i < n; i++) {
        // `Math.imul`, not `*`: the product of two 32-bit numbers is past what
        // a double holds exactly, and the low bits a base is cut from go first.
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
        line[i] = 'ACGT'.charCodeAt((seed >>> 16) & 3)
      }
      line[n] = 10
      writeSync(fd, line, 0, n + 1)
      at += n + 1
    }
  }
  closeSync(fd)
  writeFileSync(`${FASTA}.fai`, fai.join('\n') + '\n')
}

/** A 1D browser session holding a sequence row and nothing else. */
function session(url, name, locus) {
  return {
    kind: 'metacooler.workspace',
    version: 1,
    createdAt: '2026-10-07T00:00:00.000Z',
    active: 0,
    tabs: [
      {
        version: 1,
        createdAt: '2026-10-07T00:00:00.000Z',
        state: { uri: url, view: 'browser', locus },
        tracks: [sequenceRow('large-sequence', name, url)],
        name: 'A genome read by range',
      },
    ],
  }
}

function sequenceRow(id, name, url) {
  return {
    id,
    card: 'linear',
    kind: 'sequence',
    label: name,
    source: { kind: 'remote', name, url },
    visible: true,
    placement: { bottom: true, right: false },
    style: {
      colour: '#8c6d31', size: 46, mode: 'line', limits: { auto: false, min: 0, max: 1 },
      group: '', shape: 'element', radius: 7, opacity: 1, flip: false,
    },
  }
}

const LARGE = `${BASE}/${DATA}/large-genome.fa`
writeFileSync(join(DATA, 'large.metacooler.json'), JSON.stringify(session(LARGE, 'large-genome.fa', 'chr2:10,000,001-10,060,000'), null, 1))

// The yeast tracks demo, with the `.2bit` of the same sequence as a second row.
const yeast = JSON.parse(execSync('cat demo/yeast/Yeast_tracks.metacooler.json').toString())
for (const track of yeast.tabs[0].tracks) {
  if (track.source?.url !== undefined && !/^https?:/.test(track.source.url)) {
    track.source.url = `${BASE}/demo/yeast/${track.source.url}`
  }
}
yeast.tabs[0].state.uri = `${BASE}/demo/yeast/${yeast.tabs[0].state.uri}`
yeast.tabs[0].tracks.splice(1, 0, sequenceRow('demo-twobit', 'Yeast_reference.2bit', `${BASE}/demo/yeast/Yeast_reference.2bit`))
yeast.tabs[0].tracks[1].label = '.2bit'
writeFileSync(join(DATA, 'yeast.metacooler.json'), JSON.stringify(yeast, null, 1))

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const errors = []
// A context of its own per session, so the second does not open into the
// first one's restored tabs.
async function fresh() {
  const next = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
let page = await fresh()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return true }
  }
  return false
}
const openTask = async (title) => {
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) { await close.click(); await sleep(600) }
  const row = page.locator('.analysis-row-title', { hasText: title }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1200)
}
const choose = async (key, option) => {
  const select = page.locator(`.analysis-drawer select[id$="-${key}"]`).first()
  if (!(await select.count())) { console.log('no select for', key); return }
  const text = await select.locator('option', { hasText: option }).first().textContent()
  await select.selectOption({ label: text ?? option })
  await sleep(800)
}
const pattern = async (text) => {
  const box = page.locator('.analysis-drawer input[type="text"]').first()
  await box.fill(text)
  await box.press('Enter')
  await sleep(800)
}
const tickOnly = async (name) => {
  await page.locator('.analysis-drawer .param-check-actions button', { hasText: 'none' }).first().click()
  await sleep(400)
  await page.locator('.analysis-drawer .param-sequences label', { hasText: name }).first().locator('input').check()
  await sleep(800)
}
const cost = () => page.evaluate(() => document.querySelector('.analysis-drawer .analysis-cost')?.textContent ?? '')
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
const notes = () => page.evaluate(() => [...document.querySelectorAll('.analysis-drawer-body li')].map((li) => li.innerText).join('\n'))
const run = async (marker, during) => {
  const before = await computed()
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  if (during !== undefined) await during()
  await page.waitForFunction(({ before, marker }) => {
    const text = document.querySelector('.analysis-drawer-body')?.innerText ?? ''
    const now = text.match(/computed in [^\n]*/)?.[0] ?? ''
    return now !== '' && now !== before && text.includes(marker)
  }, { before, marker }, { timeout: 600000 }).catch(() => console.log('run did not finish:', marker))
  await sleep(1500)
}
const closeDrawer = async () => {
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) { await close.click(); await sleep(1500) }
}
const goTo = async (locus) => {
  const box = page.locator('input.input-region').first()
  await box.fill(locus)
  await box.press('Enter')
  await sleep(3000)
}
const rows = () => page.evaluate(() =>
  [...document.querySelectorAll('.annotation-card .ann-row')].map((row) => row.innerText.replace(/\s+/g, ' ').trim()),
)

try {
  // --- A genome too large to hold --------------------------------------------
  await page.goto(`${BASE}/?config=${BASE}/${DATA}/large.metacooler.json`)
  await page.waitForFunction(
    () => [...document.querySelectorAll('.annotation-card .ann-row')].some((row) => /read by range/.test(row.textContent ?? '')),
    null,
    { timeout: 180000 },
  ).catch(() => console.log('the row never said it was read by range'))
  await sleep(5000)
  console.log('rows:\n' + (await rows()).join('\n'))
  await shot('mr01-genome-read-by-range')

  await fold('Show the Analysis panel')
  await sleep(1000)
  await openTask('Find a motif')
  await pattern('TGACTCA')
  console.log('cost, every sequence:', await cost())
  await shot('mr02-form-every-sequence')

  await run('sites', async () => {
    await page.waitForFunction(() => /searching chr/.test(document.querySelector('.analysis-drawer')?.textContent ?? ''), null, { timeout: 120000 })
      .catch(() => console.log('never saw the bar name a sequence'))
    await sleep(300)
    await shot('mr03-searching')
  })
  console.log('every sequence:\n' + (await notes()) + '\n' + (await computed()))
  await shot('mr04-every-sequence-result')

  await closeDrawer()
  await fold('Fold the Analysis panel')
  await sleep(2000)
  await shot('mr05-sites-lane')

  await fold('Show the Analysis panel')
  await sleep(1000)
  await openTask('Find a motif')
  await tickOnly('chr2')
  console.log('cost, chr2:', await cost())
  await shot('mr06-form-chr2')
  await run('on chr2')
  console.log('chr2:\n' + (await notes()) + '\n' + (await computed()))
  await closeDrawer()
  await fold('Fold the Analysis panel')
  await sleep(2000)
  console.log('rows:\n' + (await rows()).join('\n'))
  await shot('mr07-two-lanes')

  // --- The yeast demo's .2bit -------------------------------------------------
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/${DATA}/yeast.metacooler.json`)
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('Yeast, no map'), null, { timeout: 180000 })
  await sleep(6000)
  const heightBox = page.locator('xpath=//*[normalize-space(text())="track height"]/following::input[1]').first()
  await heightBox.fill('30')
  await heightBox.press('Enter')
  await sleep(1500)
  await fold('Show the Analysis panel')
  await sleep(1000)
  await openTask('Find a motif')
  await choose('sequence', '.2bit')
  await pattern('TGACTCA')
  console.log('cost, .2bit:', await cost())
  await shot('mr08-form-twobit')
  await run('sites')
  console.log('.2bit:\n' + (await notes()))
  await closeDrawer()
  await fold('Fold the Analysis panel')
  await sleep(1500)
  await goTo('IV:1,200,001-1,300,000')
  console.log('rows:\n' + (await rows()).join('\n'))
  await shot('mr09-twobit-sites')
  // The same search over the FASTA, held whole: the count must be the same.
  // (Its lane takes the .2bit run's row — one search, one row — so the two
  // are compared in the log rather than drawn side by side.)
  await fold('Show the Analysis panel')
  await sleep(1000)
  await openTask('Find a motif')
  await choose('sequence', 'sequence')
  await pattern('TGACTCA')
  console.log('cost, FASTA held whole:', await cost())
  await shot('mr10-form-fasta-held')
  await run('sites')
  console.log('FASTA:\n' + (await notes()))
} finally {
  if (errors.length > 0) console.log('page errors:\n' + errors.join('\n'))
  await browser.close()
}
