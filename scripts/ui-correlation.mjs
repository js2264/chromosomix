/**
 * The map's correlation at the size it is now allowed, in headless Chromium (§7.5).
 *
 * On the *E. coli* demo at 1 kb: a 4,096-bin window balanced, the correlation
 * picked from the score picker — the O/E drawn under the veil while it is
 * computed, empty pixels paper — and the answer, with how long it took from the
 * pick to the picture printed for each; the same again on a second window, which
 * the helper workers kept from the first make quicker; a 2,048-bin and a
 * 1,024-bin window; the whole chromosome, 4,642 bins, which the map reads pooled
 * to 2 kb to fit its raster — so no square it draws is past the cap; the
 * Compartments task's line beside Run for the correlation method at a
 * resolution finer than it wants; and yeast chromosome IV from the micro-C demo,
 * in a tab of its own.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-correlation.mjs [out-dir]
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
const fresh = async () => {
  const next = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
let page = await fresh()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const ecoli = encodeURIComponent(`${BASE}/demo/ecoli/Ecoli.mcool::/resolutions/1000`)

const picker = () => page.locator('select').filter({ has: page.locator('option[value="correlation"]') }).first()
const summary = () => page.evaluate(() => document.body.innerText.match(/[\d,]+ × [\d,]+ bins[^\n]*/)?.[0] ?? '?')
const go = async (region) => {
  await page.evaluate((region) => {
    const hash = new URLSearchParams(location.hash.slice(1))
    hash.set('region', region)
    location.hash = hash.toString()
  }, region)
  await page.waitForFunction(() => /[\d,]+ × [\d,]+ bins/.test(document.body.innerText), null, { timeout: 120000 })
  await sleep(4000)
}

/** Pick the correlation and wait for it; `veil` names a shot taken while it is computed. */
const correlate = async (label, name, veil = null) => {
  const before = await summary()
  const t0 = Date.now()
  await picker().selectOption('correlation')
  // The veil first, so its going means the answer and not that it had yet to come.
  await page.waitForFunction(() => /correlating/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {})
  if (veil !== null) {
    await sleep(300)
    await shot(veil)
  }
  await page
    .waitForFunction(() => !/correlating/.test(document.body.innerText), null, { timeout: 300000 })
    .catch(() => console.log('  still correlating'))
  console.log(`${label} (${before}): picture after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await sleep(1500)
  await shot(name)
  const caption = await page.evaluate(() => document.body.innerText.match(/[^\n]*correlation[^\n]*/g)?.slice(0, 3) ?? [])
  console.log('  says:', caption.join(' | '))
}
const back = async () => {
  await picker().selectOption('balanced')
  await sleep(2500)
}

try {
  await page.goto(`${BASE}/#uri=${ecoli}&view=region&region=${encodeURIComponent('NC_000913.3:1-4096000')}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await page.waitForFunction(() => /[\d,]+ × [\d,]+ bins/.test(document.body.innerText), null, { timeout: 120000 })
  await sleep(4000)
  console.log('the option says:', await picker().locator('option[value="correlation"]').getAttribute('title'))
  await shot('co1-balanced-4096')

  await correlate('4,096 bins, the first in the page', 'co3-correlation-4096', 'co2-correlating-veil')
  await back()
  // Back to it: the answer is held, so nothing is computed again.
  const t0 = Date.now()
  await picker().selectOption('correlation')
  await sleep(200)
  console.log(`the same again: ${await page.evaluate(() => /correlating/.test(document.body.innerText) ? 'computing' : 'drawn at once')} after ${Date.now() - t0} ms`)
  await back()

  await go('NC_000913.3:500001-4596000')
  await correlate('4,096 bins, another window', 'co4-correlation-4096-again')
  await back()
  await go('NC_000913.3:1-2048000')
  await correlate('2,048 bins', 'co5-correlation-2048')
  await back()
  await go('NC_000913.3:1-1024000')
  await correlate('1,024 bins', 'co6-correlation-1024')
  await back()

  // The whole chromosome: 4,642 bins at 1 kb, which the map reads pooled to fit
  // its raster — the block is the cap, so every square it draws can be correlated.
  await go('NC_000913.3')
  await correlate('the whole chromosome', 'co7-whole-chromosome')
  await back()

  // Compartments, by the correlation, at a resolution finer than it wants.
  for (const b of await page.$$('button[title^="Show the Analysis panel"]')) {
    if (await b.isVisible()) { await b.click(); await sleep(800); break }
  }
  const row = page.locator('.analysis-row-title', { hasText: 'Compartments' }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1200)
  const method = page.locator('.analysis-drawer select').filter({ has: page.locator('option[value="correlation"]') }).first()
  if (await method.count()) {
    await method.selectOption('correlation')
    await sleep(800)
  }
  console.log('beside Run:', await page.evaluate(() => document.querySelector('.analysis-drawer')?.innerText.match(/[^\n]*far finer[^\n]*/)?.[0] ?? 'no warning'))
  await page.evaluate(() => {
    const drawer = document.querySelector('.analysis-drawer')
    const line = [...(drawer?.querySelectorAll('*') ?? [])].find((node) => node.childElementCount === 0 && /far finer/.test(node.textContent ?? ''))
    line?.scrollIntoView({ block: 'center' })
  })
  await sleep(500)
  await shot('co8-compartments-estimate')

  // Yeast chromosome IV at 1 kb, the micro-C demo: 1,532 bins, in a tab of its own.
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
  await go('IV')
  await correlate('yeast chromosome IV', 'co9-yeast-iv')
} finally {
  console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors')
  await browser.close()
}
