/**
 * P(s) leaves out the first two diagonals by default (§18.8).
 *
 * On the yeast demo: the form as it opens, *minimum separation* reading 2
 * bins; the curve in the drawer; enlarged with *fit* pressed, which is the
 * whole of the data — its first point two bins out; then the same run at 0,
 * fitted, where the diagonal's break is back at the left edge and every other
 * point is a share of a total it dominates. Prints each run's first point and
 * the ordinate's labels.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-ps-floor.mjs [out-dir]
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })

const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
const field = (label) =>
  page
    .locator('.analysis-form .field')
    .filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) })
    .first()
/** The texts of the enlarged chart left of its plot and under it, top to bottom and left to right. */
const axes = () =>
  page.evaluate(() => {
    const svg = document.querySelector('.modal-stage .figure-chart svg')
    if (svg === null) return null
    const box = svg.getBoundingClientRect()
    const texts = [...svg.querySelectorAll('text')].map((t) => {
      const r = t.getBoundingClientRect()
      return { text: t.textContent ?? '', x: r.left - box.left, y: r.top - box.top }
    })
    return {
      left: texts.filter((t) => t.x < 70).sort((a, b) => a.y - b.y).map((t) => t.text),
      under: texts.filter((t) => t.y > box.height - 60).sort((a, b) => a.x - b.x).map((t) => t.text),
    }
  })
const run = async () => {
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(() => document.querySelector('.analysis-drawer .figure-chart svg') !== null, null, { timeout: 180000 })
  await sleep(2500)
}

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(2500)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await page.locator('text=Contact probability P(s)').first().click()
  await sleep(1200)
  const box = field('minimum separation').locator('input').first()
  console.log('minimum separation, as the form opens:', await box.inputValue())
  await field('minimum separation').scrollIntoViewIfNeeded()
  await sleep(500)
  await shot('pf01-form')

  await run()
  await page.locator('.figure-block').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(800)
  await shot('pf02-drawer')

  await page.locator('.figure-block').filter({ has: page.locator('.figure-chart svg') }).first().locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage .figure-chart svg', { timeout: 20000 })
  await sleep(1500)
  await page.locator('.modal-stage button', { hasText: /^fit$/ }).first().click()
  await sleep(1800)
  console.log('fitted, two bins left out:', JSON.stringify(await axes()))
  await shot('pf03-fit-two')
  await page.keyboard.press('Escape')
  await sleep(800)

  // At 0: the diagonal back in the first break.
  await page.locator('.analysis-form').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await box.fill('0')
  await box.press('Enter')
  await sleep(600)
  console.log('minimum separation, typed:', await box.inputValue())
  await run()
  const curve = page.locator('.figure-block').filter({ has: page.locator('.figure-chart svg') }).first()
  await curve.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(800)
  await shot('pf04-drawer-zero')
  await curve.locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage .figure-chart svg', { timeout: 20000 })
  await sleep(1500)
  await page.locator('.modal-stage button', { hasText: /^fit$/ }).first().click()
  await sleep(1800)
  console.log('fitted, nothing left out:', JSON.stringify(await axes()))
  await shot('pf05-fit-zero')
} finally {
  await close()
}
