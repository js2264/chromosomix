/**
 * The landing page's example sessions (§24.11), in headless Chromium: the
 * column under *Just looking?* and the four tabs it opens, read from 4DN's,
 * ENCODE's, IGV's and the lab's buckets.
 *
 * The column in the margin beside the store tiles on a wide page, a `?`
 * hovered and its tip, the dark theme, under the tiles where the column has no
 * margin, and on a phone; a press on a `?`, which must open nothing; then each
 * button pressed on a landing page of its own, and its tab once every lane has
 * drawn — Human Hi-C data with its Tracks card, Yeast micro-C data, Linear
 * tracks and Comparing data — the first on a laptop too, and a press from a
 * second tab, which opens one tab and not two. It prints where the column
 * stands against the tiles and each tab's rows, so a lane that did not arrive
 * is a line in the log rather than a gap to spot in a picture. It needs the
 * network: every file is on its publisher's own bucket.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-examples.mjs [out-dir]     # ex01 … ex13
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
const SETTLE = Number(process.env.EXAMPLES_SETTLE ?? 45_000)
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
    const offer = document.querySelector('.picker-examples')?.getBoundingClientRect()
    const tiles = [...document.querySelectorAll('.picker-store-section .store-tile')].map((t) => t.getBoundingClientRect())
    if (offer === undefined || tiles.length === 0) return 'no offer'
    const lastRow = Math.max(...tiles.map((t) => t.top))
    const row = tiles.filter((t) => t.top === lastRow)
    const firstLeft = Math.min(...row.map((t) => t.left))
    const beside = offer.right <= firstLeft && offer.bottom > lastRow
    const under = offer.top >= Math.max(...tiles.map((t) => t.bottom))
    return `offer ${Math.round(offer.width)}×${Math.round(offer.height)} at (${Math.round(offer.left)}, ${Math.round(offer.top)}): ${
      beside ? 'in the margin beside the tiles' : under ? 'under the tiles' : 'neither beside nor under the tiles'
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

async function press(page, id) {
  await page.click(`.picker-example[data-example="${id}"]`)
}

/** Press an example on a fresh landing page, wait for its lanes, and say what arrived. */
async function opened(page, id) {
  await press(page, id)
  await sleep(SETTLE)
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.tabstrip .tab-label')].map((t) => t.textContent?.trim()))
  await page.click('.head-panels button[aria-label="Annotations panel"]').catch(() => {})
  await sleep(2000)
  const { names, failed } = await rows(page)
  console.log(`${id}: tabs ${tabs.join(' | ')}; rows: ${names.join(' · ')}`)
  console.log(failed.length === 0 ? `${id}: no row reports a failure` : `${id}: failed rows: ${failed.join(' | ')}`)
  if (failed.length > 0) errors.push(`${id}: ${failed.length} rows failed`)
  if (tabs.length !== 1) errors.push(`${id}: ${tabs.length} tabs, not 1`)
  // The Annotations column back as it was, so the picture is the tab's own.
  await page.click('.head-panels button[aria-label="Annotations panel"]').catch(() => {})
  await sleep(1500)
}

// ------------------------------------------------------------- the column
await scene('wide', async ({ page, shot }) => {
  console.log(await placement(page))
  await shot('ex01-landing-wide')
  await page.hover('[data-example="human"] .picker-example-hint')
  await sleep(400)
  await shot('ex02-hint-hovered')
  await page.hover('[data-example="compare"] .picker-example-hint')
  await sleep(400)
  const words = await page.evaluate(() => document.querySelector('.question-tip:not(.hidden)')?.textContent ?? null)
  console.log(`compare's tip: ${words}`)
  await page.screenshot({ path: join(OUT, 'ex03-column-close.png'), clip: { x: 0, y: 600, width: 720, height: 380 } })
  console.log('wrote ex03-column-close.png')
  // A press on a `?` reads and does not open.
  await page.click('[data-example="yeast"] .picker-example-hint')
  await sleep(1500)
  const still = await page.locator('.picker-examples').count()
  console.log(still === 1 ? 'a press on a ? opened nothing' : 'a press on a ? opened a tab')
  if (still !== 1) errors.push('wide: a press on a ? opened a tab')
})

await scene('dark', async ({ page, shot }) => {
  console.log(await placement(page))
  await shot('ex04-landing-dark')
}, { dark: true })

await scene('narrow', async ({ page, shot }) => {
  console.log(await placement(page))
  await page.locator('.picker-examples').scrollIntoViewIfNeeded()
  await sleep(300)
  await shot('ex05-landing-narrow')
}, { width: 1100, height: 900 })

await scene('phone', async ({ page, shot }) => {
  console.log(await placement(page))
  await page.locator('.picker-examples').scrollIntoViewIfNeeded()
  await sleep(300)
  await shot('ex06-landing-phone')
}, { width: 390, height: 844 })

// ---------------------------------------------------------------- the tabs
await scene('human', async ({ page, shot }) => {
  await opened(page, 'human')
  await shot('ex07-human')
})

await scene('yeast', async ({ page, shot }) => {
  await opened(page, 'yeast')
  await shot('ex08-yeast-micro-c')
})

await scene('linear', async ({ page, shot }) => {
  await opened(page, 'linear')
  await shot('ex09-linear-tracks')
})

await scene('compare', async ({ page, shot }) => {
  await opened(page, 'compare')
  await shot('ex10-comparing')
  await page.click('.head-panels button[aria-label="Annotations panel"]').catch(() => {})
  await sleep(1500)
  await shot('ex11-comparing-tracks-card')
})

await scene('laptop', async ({ page, shot }) => {
  await press(page, 'human')
  await sleep(SETTLE)
  await shot('ex12-human-laptop')
}, { width: 1440, height: 900 })

// A tab holding a file is not emptied: pressed from a new tab beside it, an
// example fills that new tab, and the strip names two.
await scene('beside', async ({ page, shot }) => {
  await press(page, 'compare')
  await sleep(8000)
  await page.click('.tabstrip .tab-new')
  await page.waitForSelector('.picker-example')
  await sleep(800)
  await press(page, 'linear')
  await sleep(10000)
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.tabstrip .tab-label')].map((tab) => tab.textContent?.trim()),
  )
  console.log(`tabs: ${names.join(' | ')}`)
  if (names.length !== 2) errors.push(`beside: ${names.length} tabs, not 2`)
  await shot('ex13-two-tabs')
})

await browser.close()
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}
