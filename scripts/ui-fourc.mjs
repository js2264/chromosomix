/**
 * The 4C task's *exclude anchor region*, in headless Chromium (§18.8).
 *
 * On the micro-C demo: the task's form with the switch beside *cis only*, the
 * profile run from one anchor with the switch off — the anchor's own spike
 * setting the lane's scale — and again with it on, the anchor and a bin either
 * side left as a gap and the lane's range read off the rest. It prints each
 * track's name and range as the lane reports it.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-fourc.mjs [out-dir]
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
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const field = (label) =>
  page.locator('.analysis-form .field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) }).first()
const syntheticRows = () =>
  page.$$eval('.annotation-card .ann-row.is-synthetic .ann-name', (nodes) => nodes.map((n) => n.value ?? n.textContent))

/** Press run, and wait for a computed track whose name contains `named` — and, with `not`, lacks it. */
const runFor = async (named, not = null) => {
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(
    ({ named, not }) =>
      document.querySelectorAll('.lane-canvas.lane-left:not(.hidden)').length > 0 &&
      Array.from(document.querySelectorAll('.annotation-card .ann-row.is-synthetic .ann-name')).some((n) => {
        const text = n.value ?? n.textContent ?? ''
        return text.includes(named) && (not === null || !text.includes(not))
      }),
    { named, not },
    { timeout: 120000 },
  ).catch(() => console.log('no such track after run:', named))
  await sleep(3000)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(6000)
  await fold('Show the Analysis panel')
  await page.locator('.analysis-row-title', { hasText: '4C profile from an anchor' }).first().click()
  await sleep(1200)
  const anchor = field('anchor').locator('input').first()
  await anchor.fill('IV:1,200,001-1,202,000')
  await anchor.press('Enter')
  await sleep(800)
  const form = page.locator('.analysis-form').first()
  await form.screenshot({ path: `${OUT}/fc1-form.png` })
  console.log('shot fc1-form · exclude row says:', (await field('exclude anchor region').textContent())?.trim())

  // Off: the anchor's contact with itself is in the profile.
  await runFor('4C', 'excluded')
  console.log('tracks after the first run:', JSON.stringify(await syntheticRows()))
  // The result drawer floats over the map: put it away to see the lane.
  await page.keyboard.press('Escape')
  await fold('Fold the Analysis panel')
  await sleep(2500)
  const map = await page.locator('.heatmap-canvas').first().boundingBox()
  const left = await page.locator('.lane-canvas.lane-left:not(.hidden)').first().boundingBox()
  const clip = { x: Math.max(0, left.x - 10), y: map.y - 10, width: map.x + map.width * 0.6 - left.x + 10, height: map.height + 20 }
  await page.screenshot({ path: `${OUT}/fc2-anchor-kept.png`, clip })
  console.log('shot fc2-anchor-kept')

  // On: the anchor and a bin either side are a gap.
  await fold('Show the Analysis panel')
  await sleep(800)
  if ((await field('exclude anchor region').count()) === 0 || !(await field('exclude anchor region').isVisible())) {
    await page.locator('.analysis-row-title', { hasText: '4C profile from an anchor' }).first().click()
    await sleep(1200)
  }
  await field('exclude anchor region').locator('button').first().click()
  await sleep(600)
  await form.screenshot({ path: `${OUT}/fc3-form-exclude-on.png` })
  console.log('shot fc3-form-exclude-on · switch now:', (await field('exclude anchor region').locator('button').first().textContent())?.trim())
  await runFor('anchor excluded')
  console.log('tracks after the second run:', JSON.stringify(await syntheticRows()))
  await page.keyboard.press('Escape')
  await fold('Fold the Analysis panel')
  await sleep(2500)
  await page.screenshot({ path: `${OUT}/fc4-anchor-excluded.png`, clip })
  console.log('shot fc4-anchor-excluded')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
