/**
 * Every locus a reader sees or types, 1-based (§26.1), in headless Chromium on
 * the yeast micro-C demo and the mock community — the surfaces that were the
 * last to read or print a coordinate 0-based.
 *
 * The Bookmarks card with the view saved and a place typed; the Manual
 * annotations card with a line and a box typed; the map's right-click menu
 * over a bin; the 4C form with its anchor typed, the lane the run names after
 * it, and the console's line for the run; *Fraction of signal in features*
 * scored per feature, whose table prints each peak's first base; and, with the
 * dev features on, a genome view's box with a locus typed into it and the window
 * it opens, its link keeping the 0-based grammar a link always had. Each card's
 * rows are printed to stdout as well as shot, so a coordinate a base off is a
 * line in the log.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-loci.mjs [out-dir]     # lo01 … lo10
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT, { width: 1920, height: 1100 })
const { page, shot } = g

const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const card = (title) =>
  page.locator('.annotation-card').filter({ has: page.locator('.card-head', { hasText: new RegExp(title, 'i') }) }).first()
const field = (label) =>
  page.locator('.analysis-form .field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) }).first()
const pick = async (label, wanted) => {
  const control = field(label)
  if ((await control.count()) === 0) return false
  const select = control.locator('select').first()
  if (await select.count()) {
    const options = await select.locator('option').evaluateAll((all) => all.map((one) => ({ value: one.value, text: one.textContent ?? '' })))
    const match = options.find((one) => one.text.includes(wanted) || one.value.includes(wanted))
    if (match === undefined) return false
    await select.selectOption(match.value)
    await sleep(500)
    return true
  }
  const row = control.locator('label', { hasText: wanted }).first()
  if ((await row.count()) === 0) return false
  await row.locator('input[type="checkbox"]').check()
  await sleep(500)
  return true
}
const shown = () => page.$$eval('.analysis-figure-head', (all) => all.map((one) => one.textContent).join('|'))
const ran = async (label, before) => {
  await page
    .waitForFunction((was) => [...document.querySelectorAll('.analysis-figure-head')].map((one) => one.textContent).join('|') !== was, before, { timeout: 300000 })
    .catch(() => console.log('no output for', label))
  await sleep(3000)
}

await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(6000)
console.log('breadcrumb:', (await page.locator('.region-title').first().textContent())?.trim())

// ---- Bookmarks: the view on screen, and a place typed ---------------------
await fold('Show the Annotations panel')
const bookmarks = card('Bookmarks')
await bookmarks.scrollIntoViewIfNeeded()
if ((await bookmarks.locator('.manual-form').count()) === 0 || !(await bookmarks.locator('.manual-form').first().isVisible())) {
  await bookmarks.locator('.card-head').first().click()
  await sleep(500)
}
await bookmarks.locator('button', { hasText: /^save this view$/ }).click()
await sleep(400)
await bookmarks.locator('input.input').first().fill('II:120,001-180,000')
await bookmarks.locator('button', { hasText: /^add$/ }).first().click()
await sleep(600)
console.log('bookmark rows:', await bookmarks.locator('.bookmark-where').allTextContents())
await bookmarks.scrollIntoViewIfNeeded()
await shot('lo01-bookmarks')
console.log('bookmark box tooltip:', await bookmarks.locator('input.input').first().getAttribute('title'))

// ---- Manual annotations: a line and a box typed ---------------------------
const manual = card('Manual annotations')
await manual.scrollIntoViewIfNeeded()
await manual.locator('input[placeholder="I:120,000"]').fill('IV:1,200,001')
await manual.locator('.manual-form').first().locator('button', { hasText: /^add$/ }).click()
await sleep(400)
const boxForm = manual.locator('.manual-form').nth(2)
await boxForm.locator('input').first().fill('IV:1,100,001-1,150,000')
await boxForm.locator('button', { hasText: /^add$/ }).click()
await sleep(800)
console.log('manual rows:', (await manual.locator('.ann-row').allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim()))
await manual.scrollIntoViewIfNeeded()
// The card and the map together: the line at the base the row names, the box
// over the bases its row names.
await shot('lo02-manual-marks')

// ---- The map's right-click menu over a bin ---------------------------------
const map = await page.locator('.heatmap-canvas').first().boundingBox()
await page.mouse.click(map.x + map.width * 0.4, map.y + map.height * 0.6, { button: 'right' })
await sleep(700)
console.log('menu rows:', (await page.locator('.context-menu, .menu').first().allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim()).join(' | ').slice(0, 400))
await shot('lo04-map-menu')
await page.keyboard.press('Escape')
await sleep(400)

// ---- 4C: the anchor typed, the lane it names, the console's line ----------
await fold('Show the Analysis panel')
await page.locator('.analysis-row-title', { hasText: '4C profile from an anchor' }).first().click()
await sleep(1200)
const anchor = field('anchor').locator('input').first()
console.log('4C anchor seeded as:', await anchor.inputValue(), '· tooltip:', await anchor.getAttribute('title'))
await anchor.fill('IV:1,200,001-1,202,000')
await anchor.press('Enter')
await sleep(500)
await shot('lo05-fourc-form')
await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
// A 4C run lands as a lane rather than a figure, so the wait is for its row.
await page
  .waitForFunction(() => [...document.querySelectorAll('.annotation-card .ann-name')].some((one) => /4C/.test(one.value ?? one.textContent ?? '')), null, { timeout: 120000 })
  .catch(() => console.log('no 4C lane'))
await sleep(2500)
await page.keyboard.press('Escape')
await sleep(800)
console.log('lanes named:', (await page.$$eval('.annotation-card .ann-name', (all) => all.map((one) => one.value ?? one.textContent))).filter((name) => /4C/.test(name ?? '')))
await shot('lo06-fourc-lane')
await page.keyboard.press('Control+Backquote')
await sleep(900)
console.log('console:', (await page.locator('.console-list').first().textContent())?.replace(/\s+/g, ' ').slice(0, 500))
await shot('lo07-console')
await page.keyboard.press('Control+Backquote')
await sleep(500)

// ---- FRiP per feature: each peak's first base ------------------------------
await page.locator('.analysis-row-title', { hasText: 'Fraction of signal in features' }).first().click()
await sleep(1200)
await pick('features', 'ATAC peaks')
await pick('tracks', 'ATAC')
const every = field('score every feature').locator('button[aria-pressed="false"]')
if (await every.count()) await every.click()
await sleep(400)
const beforeFrip = await shown()
await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
await ran('FRiP', beforeFrip)
const perFeature = page.locator('.figure-block').filter({ has: page.locator('.analysis-figure-head', { hasText: /Per feature/ }) }).first()
if (await perFeature.count()) {
  await perFeature.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(800)
  const head = await perFeature.locator('th').allTextContents()
  const first = await perFeature.locator('tbody tr').first().locator('td').allTextContents()
  console.log('per feature:', head.join(' | '), '→', first.join(' | '))
} else {
  console.log('no Per feature table')
}
await shot('lo08-frip-per-feature')

// ---- A genome view's box, with the dev features on ------------------------
// In a page of its own: the one above has a tab the app would restore.
const fresh = await (await g.browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: 1 })).newPage()
await fresh.goto(`${g.base}/?dev&config=${g.base}/demo/metagenomics/mock-community/Mock_microbial_community.chromosomix.json`)
await fresh.waitForSelector('.view-genomes .tr', { timeout: 120000 }).catch(() => console.log('no genomes table'))
await sleep(2500)
await fresh.locator('.view-genomes .tr .td:not(.td-check)').first().click()
await fresh.waitForSelector('.view-genome .heatmap-canvas', { timeout: 120000 }).catch(() => {})
await sleep(3500)
const box = fresh.locator('.view-genome .view-head input.search-input').first()
if (await box.count()) {
  console.log('genome view box:', await box.getAttribute('placeholder'), '· tooltip:', await box.getAttribute('title'))
  console.log('a go beside it:', await fresh.locator('.view-genome .view-head button', { hasText: /^go$/ }).count())
  // A contig of this genome, named off its own Contigs card, and a window typed
  // in it the way IGV writes one.
  const contig = (await fresh.locator('.view-genome .tr .td').allTextContents()).map((text) => text.trim()).find((text) => /^NODE_\d+_len_\d+$/.test(text))
  const typed = `${contig ?? 'NODE_5537_len_59904'}:1,001-20,000`
  await box.fill(typed)
  await fresh.screenshot({ path: `${OUT}/lo09-genome-view-box.png` })
  console.log('wrote lo09-genome-view-box.png, typed', typed)
  await fresh.locator('.view-genome .view-head button', { hasText: /^go$/ }).click()
  await fresh.waitForSelector('.region-title', { timeout: 60000 }).catch(() => {})
  await sleep(3000)
  console.log('opened:', (await fresh.locator('.region-title').first().textContent().catch(() => null))?.trim(), '· the hash:', decodeURIComponent(new URL(fresh.url()).hash).match(/region=[^&]*/)?.[0])
  await fresh.screenshot({ path: `${OUT}/lo10-genome-view-opened.png` })
  console.log('wrote lo10-genome-view-opened.png')
} else {
  console.log('no box found on the genome view')
}

await g.close()
