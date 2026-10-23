/**
 * The paper's card of the lab store (§24.2), opened from its address as the card opens it: Fig. 1a's
 * three cells — GM12878 at 2 kb with its insulation above, its compartments at its left and its 4C
 * under it; the tracks cell the workspace put eight tracks on (§16.11); the model — then the same tab
 * after a reload, its tracks cell still filled; Fig. 2 at 10 kb; and Fig. S3c, the bacteria renamed.
 *
 * The workspace is the store's, staged so that every name points at where its file is today
 * (`make_rsg_store.py stage`), the 4DN and ENCODE files read in place through the session's proxy:
 *
 *   python3 scripts/make_rsg_store.py stage --out gallery/stage --local http://127.0.0.1:5173
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-paper-store.mjs gallery      # ps01 … ps05
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
    return require(join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
}
const { chromium } = playwright()

const OUT = process.argv[2] ?? 'gallery'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const WORKSPACE = process.env.PAPER_WORKSPACE ?? `${BASE}/gallery/stage/chromosomix_paper/Chromosomix_paper.chromosomix.json`
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
// The buckets through the session's proxy where there is one, and only https: the dev server is plain
// http on the loopback.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    ...(proxy ? [`--proxy-server=https=${proxy.replace(/^https?:\/\//, '')}`] : []),
  ],
})
const context = await browser.newContext({ viewport: { width: 1800, height: 1000 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  console.log(`wrote ${name}.png`)
}
/** The rows a tracks cell draws, by their labels, and what each cell of the deck is. */
const deck = () =>
  page.evaluate(() => ({
    cells: [...document.querySelectorAll('.deck-grid > *')].map((cell) => cell.className.split(' ')[0]),
    tracks: [...document.querySelectorAll('.deck-tracks .track-name, .deck-tracks .lane-label')].map((n) => n.textContent),
  }))
const settle = async () => {
  await page.waitForFunction(() => document.querySelectorAll('.heatmap-canvas').length >= 1, null, { timeout: 240000 })
  // The tracks are read from three buckets after the map: a minute for the last of them to draw.
  await sleep(60000)
}
const tab = async (prefix) => {
  for (const label of await page.$$('.tabstrip .tab-label')) {
    if ((await label.textContent()).startsWith(prefix)) {
      await label.click()
      return
    }
  }
  throw new Error(`no tab ${prefix}`)
}

try {
  await page.goto(`${BASE}/?config=${encodeURIComponent(WORKSPACE)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await settle()
  console.log('Fig. 1a', JSON.stringify(await deck()))
  await shot('ps01-fig1a')
  await page.evaluate(() => document.querySelector('.tabstrip')?.scrollIntoView())
  await page.locator('.tabstrip').screenshot({ path: join(OUT, 'ps02-tabs.png') })
  console.log('wrote ps02-tabs.png')

  // The tracks cell's tracks are kept by its seat: a reload brings the cell back as it was.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await settle()
  console.log('Fig. 1a, reloaded', JSON.stringify(await deck()))
  await shot('ps03-fig1a-reloaded')

  await tab('Fig. 2 ')
  await settle()
  await shot('ps04-fig2')

  await tab('Fig. S3c')
  await settle()
  await shot('ps05-figS3c')
} finally {
  if (errors.length > 0) console.log('page errors:', errors.join('\n'))
  await browser.close()
}
