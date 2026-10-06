/**
 * The UI shot behind Fig. 1a: the real app, driven in headless Chromium.
 *
 * The yeast micro-C demo at IV:1.0–1.4 Mb with its tracks. From the Analysis
 * column: Diamond insulation (its lane and borders join the map) and a model
 * from the map (pastis-NB, a cell of the deck). A 1D browser cell carries ATAC,
 * Pol II and the insulation lane; the model is coloured by the Pol II track.
 * General, Annotations and Aesthetics are folded to their strips so the deck
 * has the room. Shot at twice the CSS pixel density, to stay sharp at 100 mm.
 *
 * The manuscript names the app Chromlens and the build still says (meta)cooler:
 * the header's word (and `metacooler-run` wherever it is printed) is rewritten
 * in the page before the shot — BRAND below. Nothing else on screen is touched.
 *
 * Writes ui-session.png beside this script (make_figure.py crops it to the deck),
 * and the steps on the way to build/ui/.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node manuscript/figure1/capture-ui.mjs [out-dir]
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

const OUT = process.argv[2] ?? 'manuscript/figure1/build/ui'
const FINAL = process.env.FINAL ?? 'manuscript/figure1/ui-session.png'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const BRAND = process.env.BRAND ?? 'Chromlens'
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1600)
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 1000)
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return true }
  }
  return false
}
const rebrand = (brand) =>
  page.evaluate((brand) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const hits = []
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) hits.push(n)
    for (const n of hits) {
      if (n.nodeValue.includes('(meta)cooler')) n.nodeValue = n.nodeValue.replaceAll('(meta)cooler', brand)
      if (n.nodeValue.includes('metacooler-run')) n.nodeValue = n.nodeValue.replaceAll('metacooler-run', `${brand.toLowerCase()}-run`)
    }
  }, brand)
const runTask = async (title, done) => {
  await page.keyboard.press('Escape')
  await sleep(600)
  await page.locator('.analysis-row-title', { hasText: title }).first().click()
  await sleep(1200)
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(done, null, { timeout: 240000 }).catch(() => console.log(`no result for ${title}`))
  await sleep(2500)
  await page.keyboard.press('Escape')
  await sleep(1200)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(3000)

  // Two tasks from the Analysis column, with the forms' defaults.
  await fold('Show the Analysis panel')
  await sleep(800)
  await runTask('Diamond insulation', () => /computed in/.test(document.querySelector('.analysis-drawer')?.textContent ?? ''))
  await runTask('Model from the map', () => /Spearman ρ/.test(document.querySelector('.analysis-drawer')?.textContent ?? ''))
  await shot('u01-after-tasks')

  // A 1D browser cell, with ATAC, Pol II and the insulation lane placed on it.
  await page.click('.deck-add-toggle')
  await page.click('.deck-add-tracks')
  await page.waitForSelector('.deck-tracks', { timeout: 20000 })
  await fold('Show the Annotations panel')
  await sleep(600)
  const placed = await page.evaluate(() => {
    const wanted = ['demo-atac', 'demo-pol2', 'insulation']
    const out = []
    for (const row of document.querySelectorAll('.annotation-card .ann-row')) {
      const id = row.getAttribute('data-id') ?? ''
      if (!wanted.some((w) => id.includes(w))) continue
      row.querySelector('.ann-more')?.click()
      out.push(id)
    }
    return out
  })
  console.log('rows opened:', JSON.stringify(placed))
  await sleep(800)
  const clicked = await page.evaluate(() => {
    let n = 0
    for (const row of document.querySelectorAll('.annotation-card .ann-place-map')) {
      if (row.querySelector('.ann-place-name')?.textContent !== 'tracks') continue
      const bottom = Array.from(row.querySelectorAll('button.ann-place')).find((x) => x.dataset.edge === 'bottom')
      if (bottom && !bottom.disabled && bottom.getAttribute('aria-pressed') !== 'true') { bottom.click(); n++ }
    }
    return n
  })
  console.log('tracks placed on the tracks cell:', clicked)
  await sleep(2000)
  await fold('Fold the Annotations panel')
  await sleep(1000)

  // The model coloured by Pol II, from the 3D card.
  await fold('Show the Aesthetics panel')
  await sleep(600)
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('.structure-settings select option')).map((o) => [o.value, o.textContent]))
  const pol2 = options.find(([v, t]) => v.startsWith('track:') && /Pol/i.test(t))
  if (pol2) {
    const row = page.locator('.structure-settings .field').filter({ has: page.locator('.field-label', { hasText: /^colour by$/ }) }).first()
    await row.locator('select').selectOption(pol2[0])
    await sleep(3500)
  } else console.log('no Pol II option', JSON.stringify(options.slice(0, 12)))
  await fold('Fold the Aesthetics panel')
  await fold('Fold the General panel')
  await sleep(1500)

  // Three across, the model framed.
  await page.evaluate(() => {
    const select = Array.from(document.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => /across/.test(o.textContent ?? '')))
    if (select) {
      const three = Array.from(select.options).find((o) => /^3 across/.test(o.textContent ?? ''))
      if (three) { select.value = three.value; select.dispatchEvent(new Event('change', { bubbles: true })) }
    }
  })
  await sleep(2500)
  for (const frame of await page.$$('.structure-frame')) { if (await frame.isVisible()) { await frame.click(); await sleep(800) } }
  await page.mouse.move(5, 5)
  await sleep(2500)
  await rebrand(BRAND)
  await sleep(300)
  await page.screenshot({ path: FINAL })
  console.log('wrote', FINAL)
} catch (e) {
  console.log('FAILED', e)
  await shot('u99-failure')
} finally {
  if (errors.length > 0) console.log('page errors:', JSON.stringify(errors.slice(0, 10)))
  await browser.close()
}
