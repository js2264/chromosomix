/**
 * Drive the reader's lines on a turned map in headless Chromium (§17.4).
 *
 * On the yeast demo, three lines typed on the Manual annotations card — one
 * vertical at IV:1,165,000, one horizontal at IV:1,300,000 and one of each
 * (`both`) at IV:1,080,000 — shot on the square map, then turned: each line is
 * the V its place makes, two 45° rays standing on the axis, and carries on
 * straight down the lanes from the V's apex; the horizontal one too, which the
 * lanes used to leave out. Then a close-up where a V meets its lane line, a
 * zoom out that re-cuts the band (the V follows the new depth), and a pan that
 * leaves a place just off the side of the picture with one arm reaching in.
 *
 * It prints, for every step, where each line lands on the map's axis, so a V
 * that is not standing on its lane line is a line here too.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-turned-marks.mjs [out-dir]
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
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
const manual = () =>
  page.locator('.annotation-card').filter({ has: page.locator('.card-head', { hasText: /Manual annotations/i }) }).first()
const form = (title) =>
  manual()
    .locator('.manual-form')
    .filter({ has: page.locator('.manual-form-title', { hasText: new RegExp(`^${title}$`) }) })
    .first()
const line = async (at, axis) => {
  await form('Lines').locator('select').first().selectOption(axis)
  await form('Lines').locator('input.input').first().fill(at)
  await form('Lines').locator('button', { hasText: /^add$/ }).click()
  await sleep(300)
}
/** The map's own rectangle, and the stack of lanes under it. */
const regions = async () =>
  page.evaluate(() => {
    const box = (node) => {
      const r = node?.getBoundingClientRect()
      return r === undefined ? null : { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    }
    return {
      map: box(document.querySelector('.heatmap-canvas')),
      lanes: box(document.querySelector('.lane-stack, .lanes-bottom, .annotation-lanes')),
    }
  })
const settle = async () => {
  await sleep(1500)
  await page
    .waitForFunction(
      () => [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
      null,
      { timeout: 60000 },
    )
    .catch(() => {})
  await sleep(1200)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await settle()
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Annotations panel')
  await sleep(600)

  // Three lines, one of each axis.
  await line('IV:1,165,000', 'vertical')
  await line('IV:1,300,000', 'horizontal')
  await line('IV:1,080,000', 'both')
  await fold('Fold the Annotations panel')
  await settle()
  console.log('square:', JSON.stringify(await regions()))
  await shot('tm01-square')

  // Turned: every line a V on the band, straight on down the lanes. The turn is
  // on the Map card, in the Aesthetics column, which is put away again after.
  await fold('Show the Aesthetics panel')
  await page.locator('button[aria-label="Turn this map 45°, onto its diagonal"]').first().click()
  await fold('Fold the Aesthetics panel')
  await settle()
  const turned = await regions()
  console.log('turned:', JSON.stringify(turned))
  await shot('tm02-turned')

  // Close up where the vertical line's V meets its line in the lanes: the band's
  // bottom edge and the first lanes under it, around 1,165,000.
  if (turned.map !== null) {
    const span = [1_000_000, 1_400_000]
    const x = turned.map.x + ((1_165_000 - span[0]) / (span[1] - span[0])) * turned.map.width
    await page.screenshot({
      path: `${OUT}/tm03-apex.png`,
      clip: { x: Math.max(0, x - 170), y: turned.map.y + turned.map.height - 160, width: 340, height: 330 },
    })
    console.log('shot tm03-apex')
  }

  // Zoomed out, the band is re-cut to a new depth, and each V reaches its new
  // far edge rather than the old one.
  await page.locator('button', { hasText: /^3×$/ }).first().click()
  await settle()
  console.log('zoomed out:', await page.evaluate(() => decodeURIComponent(location.hash).match(/region=[^&]*/)?.[0] ?? ''))
  await shot('tm04-turned-zoomed-out')

  // Panned so the vertical line's place is just off the left side: its right
  // arm still reaches into the picture.
  await page.evaluate(() => {
    location.hash = location.hash.replace(/region=[^&]*/, 'region=IV:1175000-1275000')
  })
  await settle()
  console.log('panned:', await page.evaluate(() => decodeURIComponent(location.hash).match(/region=[^&]*/)?.[0] ?? ''))
  await shot('tm05-turned-off-side')
} catch (error) {
  console.log('ERROR', error)
  await shot('tm-error')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
