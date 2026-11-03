/**
 * The published validation notebook, on its coverage section: the heading, the
 * sentence that says how cooltools' coverage differs, and the figure that sets
 * chromosomix against cooltools bin for bin (validation.md).
 *
 *   node documentation/scripts/screens/validation.cjs <out-dir>
 *
 * Reads https://chromosomix.app/validation/ (VALIDATION_URL to read another
 * render). Writes validation-coverage.png (the section's top, in the window)
 * and validation-coverage-figure.png (the figure's own block, heading kept).
 */
const { chromium } = require('playwright')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

const OUT = process.argv[2] ?? 'screens'
const URL = process.env.VALIDATION_URL ?? 'https://chromosomix.app/validation/'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
  const browser = await chromium.launch({ args: proxy ? [`--proxy-server=${proxy}`] : [] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' })
  const page = await context.newPage()
  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 180000 })
    await page.waitForSelector('#coverage', { timeout: 60000 })
    await sleep(1500)
    // The heading at the top of the window, a little room above it.
    await page.evaluate(() => {
      const head = document.querySelector('#coverage h2, section#coverage > h2') ?? document.querySelector('#coverage')
      window.scrollTo(0, head.getBoundingClientRect().top + window.scrollY - 24)
    })
    await sleep(1200)
    await page.screenshot({ path: join(OUT, 'validation-coverage.png') })
    console.log('shot validation-coverage')
    // The figure itself, scrolled to, with where it sits printed.
    const figure = page.locator('#fig-coverage').first()
    await figure.scrollIntoViewIfNeeded()
    await sleep(1000)
    const box = await page.evaluate(() => {
      const head = document.querySelector('#coverage h2')
      const fig = document.querySelector('#fig-coverage')
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y + window.scrollY, w: b.width, h: b.height } }
      return { head: head ? r(head) : null, fig: fig ? r(fig) : null }
    })
    console.log('heading and figure:', JSON.stringify(box))
    await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, box.fig.y - 140))
    await sleep(1000)
    await page.screenshot({ path: join(OUT, 'validation-coverage-figure.png') })
    console.log('shot validation-coverage-figure')
  } finally {
    await browser.close()
  }
})()
