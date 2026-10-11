/**
 * Drive *Peak calling* in headless Chromium and write one screenshot a step.
 *
 * The 1D browser demo holds exactly what the task is for — an ATAC bigWig, and
 * beside it the MACS2 peaks called from the same reads — so the gallery calls
 * peaks on the track and lays them beside the ones it can be checked against:
 * the Analysis panel's 1D card with the task in it, the form, a run on one
 * track (no IDR, and said), its figure and table, the new lane at the demo's
 * locus and closer in, box for box under MACS2's; then the same track with
 * the Pol II ChIP as its replicate, which is *not* a replicate, so the run is
 * caught mid-fit and then shown saying so under IDR's six thresholds (§18.8).
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-peaks.mjs [out-dir]
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

const OUT = process.argv[2] ?? 'gallery-peaks'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
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
// The select of the parameter `key`, set to the option reading `option`. By the
// id the form gives it (`pf0-signal`), since a label is a word two rows can share.
const choose = async (key, option) => {
  const select = page.locator(`.analysis-drawer select[id$="-${key}"]`).first()
  if (!(await select.count())) { console.log('no select for', key); return }
  const text = await select.locator('option', { hasText: option }).first().textContent()
  await select.selectOption({ label: text ?? option })
  await sleep(600)
}
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
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
// A little above the text found, so a row of buttons beside it is not cut by
// the drawer's head.
const scrollDrawerTo = (needle) => page.evaluate((needle) => {
  const body = document.querySelector('.analysis-drawer-body')
  const hit = [...(body?.querySelectorAll('*') ?? [])].find((el) => el.childElementCount === 0 && (el.textContent ?? '').includes(needle))
  if (hit === undefined) return
  let scroller = hit.parentElement
  while (scroller !== null && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
    scroller = scroller.parentElement
  }
  if (scroller === null) { hit.scrollIntoView({ block: 'start' }); return }
  scroller.scrollTop += hit.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12
}, needle)
const notes = () => page.evaluate(() => [...document.querySelectorAll('.analysis-drawer-body li')].map((li) => li.innerText).join('\n'))
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

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_tracks.chromosomix.json`)
  // The lanes are drawn on a canvas, so what the page says in text is the tab's
  // name and the sequences card, and the lanes are given time to draw.
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('Yeast, no map'), null, { timeout: 180000 })
  await sleep(6000)
  // Every lane at half height, so the stack fits the window and a new lane —
  // which lands at the bottom of it — is on screen beside the ones above.
  const heightBox = page.locator('xpath=//*[normalize-space(text())="track height"]/following::input[1]').first()
  await heightBox.fill('34')
  await heightBox.press('Enter')
  await sleep(1500)

  // The 1D card, with the task that makes a peak set second, beside the motif search.
  await fold('Show the Analysis panel')
  await sleep(1200)
  await page.locator('.analysis-row-title', { hasText: 'Peak calling' }).first().scrollIntoViewIfNeeded()
  await sleep(600)
  await shot('p01-analysis-1d-card')

  // The form: a track to call on, no replicate, and the price of a scan.
  await openTask('Peak calling')
  await choose('signal', 'ATAC')
  await shot('p02-form-one-track')

  // One track, everything kept: no IDR, said in a note and in the lane's name,
  // and the figure is how the cut is chosen — two populations.
  await run('Curvature of every candidate')
  console.log('one track:\n' + (await notes()))
  await scrollDrawerTo('computed in')
  await sleep(600)
  await shot('p03-one-track-result')
  await scrollDrawerTo('Curvature of every candidate')
  await sleep(600)
  await shot('p04-one-track-curvature')

  // The cut the figure suggests: the upper population, about five thousand.
  const keep = page.locator('.analysis-drawer input[id$="-truncate"]').first()
  await keep.fill('5000')
  await keep.press('Enter')
  await sleep(600)
  await run('below the cut')
  console.log('strongest 5,000:\n' + (await notes()))
  await scrollDrawerTo('Curvature of every candidate')
  await sleep(600)
  await shot('p05-strongest-5000-curvature')
  await scrollDrawerTo('Per sequence')
  await sleep(600)
  await shot('p06-strongest-5000-table')

  // The new lane beside the MACS2 peaks of the same reads, at the demo's locus,
  // and closer in, where the two sets can be compared peak for peak.
  await closeDrawer()
  await fold('Fold the Analysis panel')
  await sleep(1500)
  await shot('p07-lane-at-demo-locus')
  await goTo('IV:1,262,000-1,270,000')
  await shot('p08-lane-close')

  // With a replicate: IDR over the two rankings. Pol II is not a replicate of
  // ATAC, so the fit ends at its box's edge and the run says so.
  await fold('Show the Analysis panel')
  await sleep(1000)
  await openTask('Peak calling')
  await choose('signal', 'ATAC')
  await choose('replicate', 'Pol II')
  await keep.fill('100000')
  await keep.press('Enter')
  await sleep(600)
  await shot('p09-form-replicate')
  await run('IDR thresholds', async () => {
    await page.waitForFunction(() => /IDR, round \d+/.test(document.querySelector('.analysis-drawer')?.textContent ?? ''), null, { timeout: 240000 })
      .catch(() => console.log('never saw an IDR round'))
    await sleep(800)
    await shot('p10-replicate-fitting')
  })
  console.log('two tracks:\n' + (await notes()))
  await scrollDrawerTo('computed in')
  await sleep(600)
  await shot('p11-replicate-result')
  await scrollDrawerTo('IDR thresholds')
  await sleep(600)
  await shot('p12-idr-thresholds')
  await closeDrawer()
  await fold('Fold the Analysis panel')
  await sleep(1500)
  await shot('p13-both-lanes')
} finally {
  if (errors.length > 0) console.log('page errors:\n' + errors.join('\n'))
  await browser.close()
}
