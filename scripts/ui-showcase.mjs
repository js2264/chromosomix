/**
 * The K562 showcase (§24.11), in headless Chromium: the landing page's offer and
 * the tab it opens, read from 4DN's, ENCODE's and IGV's buckets.
 *
 * The offer in the margin beside the store tiles' last row on a wide page, in
 * the dark theme, under the tiles where the column has no margin, and on a
 * phone; then a press, the tab while its files arrive and once every lane has
 * drawn, its Tracks card, the same on a laptop, and a press from a tab that
 * already holds a file — which opens a second tab rather than emptying the
 * first. It prints where the offer stands against the tiles and every lane the
 * tab drew, so a lane that did not arrive is a line in the log rather than a
 * gap to spot in a picture. It needs the network: every file is on its
 * consortium's own bucket.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-showcase.mjs [out-dir]     # sc01 … sc10
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
/** How long a tab is given for every lane to arrive: ten bigWigs of a gigabyte or more, read by range. */
const SETTLE = Number(process.env.SHOWCASE_SETTLE ?? 45_000)
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function scene(name, fn, { width = 1600, height = 1000, dark = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: dark ? 'dark' : 'light',
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e)}`))
  const shot = async (file, options = {}) => {
    await page.screenshot({ path: join(OUT, `${file}.png`), ...options })
    console.log(`wrote ${file}.png`)
  }
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.picker-store-section .store-tile')
  await sleep(1200)
  try {
    await fn({ page, shot })
  } finally {
    await context.close()
  }
}

/** Where the offer stands, against the tiles beside it. */
async function placement(page) {
  return page.evaluate(() => {
    const offer = document.querySelector('.picker-showcase')?.getBoundingClientRect()
    const tiles = [...document.querySelectorAll('.picker-store-section .store-tile')].map((t) => t.getBoundingClientRect())
    if (offer === undefined || tiles.length === 0) return 'no offer'
    const lastRow = Math.max(...tiles.map((t) => t.top))
    const row = tiles.filter((t) => t.top === lastRow)
    const firstLeft = Math.min(...row.map((t) => t.left))
    const beside = offer.right <= firstLeft && offer.bottom > lastRow
    const under = offer.top >= Math.max(...tiles.map((t) => t.bottom))
    return `offer ${Math.round(offer.width)}×${Math.round(offer.height)} at (${Math.round(offer.left)}, ${Math.round(offer.top)}): ${
      beside ? 'in the margin beside the tiles’ last row' : under ? 'under the tiles' : 'neither beside nor under the tiles'
    }`
  })
}

/** Every row of the Tracks card, by its name, and the ones that say they failed. */
async function rows(page) {
  return page.evaluate(() => ({
    names: [...document.querySelectorAll('.ann-list input.ann-name')].map((input) => input.value),
    failed: [...document.querySelectorAll('.ann-list .inline-error')].map((note) =>
      (note.parentElement?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    ),
  }))
}

async function openShowcase(page) {
  await page.click('.picker-showcase-open')
}

// ------------------------------------------------------------- the offer
await scene('wide', async ({ page, shot }) => {
  console.log(await placement(page))
  await shot('sc01-landing-wide')
  await page.hover('.picker-showcase-open')
  await sleep(300)
  await page.locator('.picker-showcase').screenshot({ path: join(OUT, 'sc02-offer-close.png') })
  console.log('wrote sc02-offer-close.png')
})

await scene('dark', async ({ page, shot }) => {
  console.log(await placement(page))
  await shot('sc03-landing-dark')
}, { dark: true })

await scene('narrow', async ({ page, shot }) => {
  console.log(await placement(page))
  await page.locator('.picker-showcase').scrollIntoViewIfNeeded()
  await sleep(300)
  await shot('sc04-landing-narrow')
}, { width: 1100, height: 900 })

await scene('phone', async ({ page, shot }) => {
  console.log(await placement(page))
  await page.locator('.picker-showcase').scrollIntoViewIfNeeded()
  await sleep(300)
  await shot('sc05-landing-phone')
}, { width: 390, height: 844 })

// --------------------------------------------------------------- the tab
await scene('open', async ({ page, shot }) => {
  await openShowcase(page)
  await sleep(6000)
  console.log(`tabs after the press: ${await page.locator('.tabstrip .tab').count()}`)
  await shot('sc06-tab-arriving')
  await sleep(SETTLE)
  await shot('sc07-tab')
  await page.click('.head-panels button[aria-label="Annotations panel"]')
  await sleep(2500)
  const { names, failed } = await rows(page)
  console.log(`rows: ${names.join(' · ')}`)
  console.log(failed.length === 0 ? 'no row reports a failure' : `failed rows: ${failed.join(' | ')}`)
  if (failed.length > 0) errors.push(`open: ${failed.length} rows failed`)
  await shot('sc08-tracks-card')
})

await scene('laptop', async ({ page, shot }) => {
  await openShowcase(page)
  await sleep(SETTLE)
  await shot('sc09-tab-laptop')
}, { width: 1440, height: 900 })

// A tab holding a file is not emptied: pressed from a new tab beside it, the
// showcase opens a second tab, and the strip names both.
await scene('beside', async ({ page, shot }) => {
  await openShowcase(page)
  await sleep(8000)
  await page.click('.tabstrip .tab-new')
  await page.waitForSelector('.picker-showcase-open')
  await sleep(800)
  await openShowcase(page)
  await sleep(8000)
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.tabstrip .tab-label')].map((tab) => tab.textContent?.trim()),
  )
  console.log(`tabs: ${names.join(' | ')}`)
  if (names.length !== 2) errors.push(`beside: ${names.length} tabs, not 2`)
  await shot('sc10-two-tabs')
})

await browser.close()
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}
