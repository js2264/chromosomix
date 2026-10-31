/**
 * TAD annotation and the map report (§18.8) in headless Chromium, on the yeast
 * micro-C demo.
 *
 * The Analysis column filtered by `TAD`, with *TAD annotation* beside the three
 * tasks that score each bin; its form, with Juicer's window and six thresholds
 * and the price line; a run, its notes and Juicer's columns as a table; the
 * domains as corners on the map, whole and close up on chromosome IV. Then the
 * *Map report* row after Pairs QC, its form and price, a run, the drawer's
 * figures and tables page by page, and the *HTML report* button: the file it
 * saves is written under files/ and opened on its own: every tab in light,
 * three in dark, a figure under the pointer, and a phone's width. Prints each form's fields, its price, each run's notes and the
 * drawer's headings, so a figure that did not arrive is a line in the log as
 * well as a missing picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-arrowhead-report.mjs [out-dir]
 */

import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })
mkdirSync(join(OUT, 'files'), { recursive: true })
// No save dialog, so a saved file is a download the script can keep.
await page.context().addInitScript(() => {
  window.showSaveFilePicker = undefined
})

// The column re-renders as the map arrives, so a button found can be gone by
// the time it is pressed: asked again, a few times, rather than once.
const fold = async (title) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      for (const b of await page.$$(`button[title^="${title}"]`)) {
        if (await b.isVisible()) {
          await b.click({ timeout: 5000 })
          await sleep(600)
          return
        }
      }
      return
    } catch {
      await sleep(800)
    }
  }
}
const shotOf = async (selector, name) => {
  await page.locator(selector).first().screenshot({ path: `${OUT}/${name}.png` })
  console.log(`wrote ${name}.png`)
}
const figureTitles = () =>
  page.$$eval('.analysis-figure-head', (all) => all.map((one) => one.textContent.trim()).join(' | '))
const notes = () => page.$$eval('.analysis-drawer .analysis-notes li', (all) => all.map((n) => n.textContent.trim()))
const fields = () =>
  page.$$eval('.analysis-form .field', (all) => all.map((f) => f.textContent.trim().replace(/\s+/g, ' ').slice(0, 140)))
const priceLine = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.analysis-drawer .analysis-cost, .analysis-drawer .analysis-refusal')]
      .map((n) => n.textContent.trim().replace(/\s+/g, ' '))
      .filter(Boolean),
  )
const openTask = async (title) => {
  await page.keyboard.press('Escape')
  await sleep(600)
  await page.locator('.analysis-row-title', { hasText: new RegExp(`^${title}$`) }).first().click()
  await sleep(1200)
}
const run = async (expect) => {
  const before = await figureTitles()
  await page.locator('.analysis-drawer button', { hasText: /^run(\s+on)?\s*$/i }).first().click()
  await page
    .waitForFunction(
      ([prior, wanted]) => {
        const now = [...document.querySelectorAll('.analysis-figure-head')].map((one) => one.textContent.trim()).join(' | ')
        return now !== prior && now.includes(wanted)
      },
      [before, expect],
      { timeout: 300000 },
    )
    .catch(() => console.log(`no “${expect}” within five minutes`))
  await sleep(2500)
}
const drawerPages = async (prefix, count) => {
  const drawer = page.locator('.analysis-drawer').first()
  for (let i = 0; i < count; i++) {
    await drawer.evaluate(
      (node, [i, count]) => {
        const scroller = node.querySelector('.analysis-drawer-body') ?? node
        scroller.scrollTo({ top: (scroller.scrollHeight * i) / count })
      },
      [i, count],
    )
    await sleep(800)
    await shotOf('.analysis-drawer', `${prefix}${String(i + 1).padStart(2, '0')}`)
  }
}

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(3000)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.analysis-row-title')].some(
        (node) => node.textContent.trim() === 'TAD annotation' && node.offsetParent !== null,
      ),
    null,
    { timeout: 60000 },
  )
  await sleep(800)

  // ---- the rows -------------------------------------------------------------
  const rowTitles = await page.$$eval('.analysis-row-title', (all) => all.map((n) => n.textContent.trim()))
  console.log('2D rows:', JSON.stringify(rowTitles.slice(0, 20)))
  await page.locator('input.analysis-filter').fill('TAD')
  await sleep(700)
  console.log(
    'filtered by “TAD”:',
    JSON.stringify(
      await page.$$eval('.analysis-row:not(.hidden) .analysis-row-title', (all) =>
        all.filter((n) => n.offsetParent !== null).map((n) => n.textContent.trim()),
      ),
    ),
  )
  await shot('ar01-filter-tad')
  await page.locator('input.analysis-filter').fill('')
  await sleep(500)

  // ---- TAD annotation -------------------------------------------------------
  await openTask('TAD annotation')
  console.log('form fields:', JSON.stringify(await fields()))
  console.log('price:', JSON.stringify(await priceLine()))
  await shot('ar02-tad-form')
  await shotOf('.analysis-form', 'ar03-tad-form-alone')
  await run('Arrowhead domains')
  console.log('figures:', await figureTitles())
  console.log('notes:', JSON.stringify(await notes()))
  await shot('ar04-tad-ran')
  await drawerPages('ar05-tad-drawer-', 2)
  await page.keyboard.press('Escape')
  await sleep(1500)
  await shot('ar06-domains-on-the-map')
  const region = page.locator('.input-region').first()
  await region.fill('IV:400,000-700,000')
  await region.press('Enter')
  await sleep(3500)
  await shot('ar07-domains-close-up')
  await region.fill('IV')
  await region.press('Enter')
  await sleep(2500)

  // ---- the map report -------------------------------------------------------
  await openTask('Map report')
  console.log('form fields:', JSON.stringify(await fields()))
  console.log('price:', JSON.stringify(await priceLine()))
  await shot('ar08-report-form')
  await run('Resolutions, coarsest to finest')
  console.log('figures:', await figureTitles())
  console.log('notes:', JSON.stringify(await notes()))
  await shot('ar09-report-ran')
  await drawerPages('ar10-report-drawer-', 6)

  // ---- the page it saves ----------------------------------------------------
  const button = page.locator('.analysis-drawer button', { hasText: /^HTML report$/ }).first()
  console.log('HTML report button visible:', await button.isVisible().catch(() => false))
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), button.click()])
  const saved = join(OUT, 'files', download.suggestedFilename())
  await download.saveAs(saved)
  console.log('saved', saved)
  const report = await page.context().newPage()
  for (const scheme of ['light', 'dark']) {
    await report.emulateMedia({ colorScheme: scheme })
    await report.setViewportSize({ width: 1280, height: 900 })
    await report.goto(`file://${resolve(saved)}`)
    await sleep(500)
    const tabs = await report.$$eval('[role=tab]', (all) => all.map((a) => a.getAttribute('aria-controls')))
    console.log(`report tabs (${scheme}):`, JSON.stringify(tabs))
    for (const [i, id] of tabs.entries()) {
      if (scheme === 'dark' && !['overview', 'library', 'resolutions'].includes(id)) continue
      await report.click(`#tab-${id}`)
      await sleep(400)
      const name = `ar${11 + i}-page-${id}-${scheme}`
      await report.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
      console.log(`wrote ${name}.png`)
    }
  }
  // The pointer on P(s): the guide and the card with its value.
  await report.emulateMedia({ colorScheme: 'light' })
  await report.click('#tab-decay')
  await sleep(400)
  const figure = report.locator('#decay .chart svg').first()
  const at = await figure.boundingBox()
  await report.mouse.move(at.x + at.width * 0.45, at.y + at.height * 0.4)
  await sleep(300)
  await report.screenshot({ path: `${OUT}/ar18-page-hover.png`, clip: { x: at.x - 40, y: at.y - 90, width: at.width + 80, height: at.height + 110 } })
  console.log('wrote ar18-page-hover.png')
  // A phone.
  await report.setViewportSize({ width: 390, height: 844 })
  await report.click('#tab-overview')
  await sleep(400)
  await report.screenshot({ path: `${OUT}/ar19-page-phone.png`, fullPage: true })
  console.log('wrote ar19-page-phone.png', 'scroll width', await report.evaluate(() => document.documentElement.scrollWidth))
  await report.close()
} finally {
  await close()
}
