/**
 * A figure's frame, its fit and its legend (§18.13), on the real page.
 *
 * On the yeast demo, P(s): the curve in its black frame, the abscissa from the
 * first separation to the last of the task's window and the ordinate fitted to
 * what is drawn in it — in the drawer, at the size of the window, after a wheel
 * zoom along the abscissa (the ordinate refits as it goes), and with *fit*
 * pressed, which is the whole of the data; then as violins on the log axis,
 * and as a histogram.
 * Then the yeast deck with its two maps renamed to long file names and P(s)
 * run on both: the legend down the right beside the plot rather than over it,
 * its names wrapped at their dots in the drawer and on one line each at the
 * size of the window, and the PNG saved from it under files/. Prints each
 * axis's labels and the plot's and the legend's edges, so a legend over the
 * plot is a line here too.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-figure-frame.mjs [out-dir]
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const FILES = join(OUT, 'files')
mkdirSync(FILES, { recursive: true })
// A browser for each config: the app reopens the tab it remembers before it
// reads `?config=`.
let { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })

const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}

/**
 * What a chart shows, read off its SVG: the plot's frame (the one rectangle
 * stroked in the ink, at the grid), the labels left of it and under it, and
 * the legend's left edge — the text right of the frame.
 */
const chartAt = (root) =>
  page.evaluate((selector) => {
    const svg = document.querySelector(`${selector} .figure-chart svg`)
    if (svg === null) return null
    const box = svg.getBoundingClientRect()
    const texts = [...svg.querySelectorAll('text')].map((t) => {
      const r = t.getBoundingClientRect()
      return { text: t.textContent ?? '', x: r.left - box.left, y: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top }
    })
    // The frame: the largest shape stroked in the ink and filled with nothing —
    // the ink exactly, since a series may be drawn in a near-black of its own
    // and a clipped curve's box runs far past the plot.
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim().toLowerCase()
    const inks = new Set([ink, 'rgb(22,24,29)', 'rgb(22, 24, 29)'])
    let frame = null
    for (const shape of svg.querySelectorAll('path, rect')) {
      const stroke = (shape.getAttribute('stroke') ?? '').toLowerCase()
      const fill = shape.getAttribute('fill') ?? ''
      if (!inks.has(stroke) || (fill !== 'none' && fill !== 'transparent' && !/rgba\(0, ?0, ?0, ?0\)/.test(fill))) continue
      const r = shape.getBoundingClientRect()
      if (frame === null || r.width * r.height > frame.width * frame.height) {
        frame = { left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top, width: r.width, height: r.height }
      }
    }
    if (frame === null) return { frame: null, texts: texts.map((t) => t.text) }
    const below = texts.filter((t) => t.y > frame.bottom && t.y < frame.bottom + 30).sort((a, b) => a.x - b.x).map((t) => t.text)
    const left = texts.filter((t) => t.right < frame.left + 2 && t.y > frame.top - 10 && t.bottom < frame.bottom + 10).sort((a, b) => a.y - b.y).map((t) => t.text)
    const beside = texts.filter((t) => t.x > frame.right)
    return {
      frame: { left: Math.round(frame.left), right: Math.round(frame.right), top: Math.round(frame.top), bottom: Math.round(frame.bottom) },
      x: below,
      y: left,
      legend: beside.length === 0 ? null : { left: Math.round(Math.min(...beside.map((t) => t.x))), names: beside.map((t) => t.text) },
      overPlot: texts.filter((t) => t.x > frame.left + 4 && t.right < frame.right - 4 && t.y > frame.top + 4 && t.bottom < frame.bottom - 4).map((t) => t.text),
    }
  }, root)

const run = async (title, wait) => {
  await page.keyboard.press('Escape')
  await sleep(600)
  await page.locator(`text=${title}`).first().click()
  await sleep(900)
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(wait, null, { timeout: 180000 }).catch(() => console.log('no output for', title))
  await sleep(2500)
}

try {
  // --- one map: P(s) ---------------------------------------------------------
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(2500)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(800)
  await run('Contact probability P(s)', () => document.querySelector('.figure-chart svg') !== null)
  await page.locator('.figure-block').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(800)
  console.log('P(s) in the drawer:', JSON.stringify(await chartAt('.figure-block')))
  await shot('fr01-ps-drawer')

  await page.locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage .figure-chart svg', { timeout: 20000 })
  await sleep(2000)
  const before = await chartAt('.modal-stage')
  console.log('P(s) at the size of the window:', JSON.stringify(before))
  await shot('fr02-ps-dialog')

  // A wheel along the abscissa, over the middle of the plot: the ordinate on
  // auto refits to what the window now holds.
  if (before?.frame) {
    const svg = await page.locator('.modal-stage .figure-chart svg').boundingBox()
    const x = svg.x + (before.frame.left + before.frame.right) / 2
    const y = svg.y + (before.frame.top + before.frame.bottom) / 2
    await page.mouse.move(x, y)
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -120)
      await sleep(150)
    }
    await sleep(1200)
    console.log('after a wheel along the abscissa:', JSON.stringify(await chartAt('.modal-stage')))
    await shot('fr03-ps-wheel')
  }

  // *fit*: the whole of the data, both axes.
  await page.locator('.modal-stage button', { hasText: /^fit$/ }).first().click()
  await sleep(1800)
  console.log('fitted to the whole of the data:', JSON.stringify(await chartAt('.modal-stage')))
  await shot('fr04-ps-fit')

  // As violins on the log ordinate: labels a decade or two apart, never one.
  const field = (label) =>
    page.locator('.modal-stage .field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) }).first()
  await field('mark').locator('select').selectOption('violin')
  await sleep(2500)
  console.log('as violins:', JSON.stringify(await chartAt('.modal-stage')))
  await shot('fr05-ps-violin')
  // And as a histogram: the abscissa from the first bin's edge to the last,
  // with the room, and no more.
  await field('mark').locator('select').selectOption('histogram')
  await sleep(2500)
  console.log('as a histogram:', JSON.stringify(await chartAt('.modal-stage')))
  await shot('fr05b-ps-histogram')
  await field('mark').locator('select').selectOption('line')
  await sleep(1200)
  await page.keyboard.press('Escape')
  await sleep(800)

  // --- a deck of two maps with long names ------------------------------------
  await close()
  ;({ page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 }))
  await page.context().addInitScript(() => {
    window.showSaveFilePicker = undefined
  })
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_deck.chromosomix.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await sleep(5000)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  // The two headings renamed in one go: Tab from the first to the second.
  await page.locator('.deck-grid input.deck-name').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('T4-infection.0min.mcool::5000')
  await page.keyboard.press('Tab')
  await sleep(400)
  await page.keyboard.press('Control+A')
  await page.keyboard.type('T4dNDD-infection.10min.mcool::5000')
  await page.keyboard.press('Enter')
  await sleep(1500)
  console.log('headings:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.deck-grid input.deck-name')].map((n) => n.value))))
  await fold('Show the Analysis panel')
  await sleep(800)
  await page.waitForFunction(() => {
    const hit = [...document.querySelectorAll('.analysis-row')].find((row) => (row.textContent ?? '').includes('Contact probability P(s)'))
    return hit !== undefined && hit.getAttribute('aria-disabled') !== 'true'
  }, null, { timeout: 90000 }).catch(() => console.log('P(s) never offered'))
  await page.locator('.analysis-row-title', { hasText: 'Contact probability P(s)' }).first().click()
  await sleep(1500)
  await page.locator('.analysis-drawer button', { hasText: /^run on all/ }).first().click()
  await page.waitForFunction(() => [...document.querySelectorAll('.analysis-map')].some((b) => /all maps/.test(b.textContent ?? '')), null, { timeout: 300000 }).catch(() => console.log('no all-maps tab'))
  await sleep(5000)
  await page.locator('.analysis-map', { hasText: 'all maps' }).first().click()
  await sleep(2500)
  const block = page.locator('.figure-block').filter({ has: page.locator('.figure-chart svg') }).first()
  await block.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(1000)
  console.log('both maps in the drawer:', JSON.stringify(await chartAt('.analysis-drawer .figure-block')))
  await shot('fr06-maps-drawer')

  await block.locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage .figure-chart svg', { timeout: 20000 })
  await sleep(2000)
  console.log('both maps at the size of the window:', JSON.stringify(await chartAt('.modal-stage')))
  await shot('fr07-maps-dialog')
  await page.keyboard.press('Escape')
  await sleep(1000)

  // The PNG, legend and all.
  const arriving = page.waitForEvent('download', { timeout: 60000 })
  await block.locator('.analysis-figure-head button', { hasText: /^PNG$/ }).first().click()
  const saved = await arriving
  copyFileSync(await saved.path(), join(FILES, 'fr08-maps.png'))
  console.log('saved fr08-maps.png')
} finally {
  await close()
}
