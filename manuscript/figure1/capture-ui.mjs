/**
 * The UI shot behind Fig. 1a: the real app, driven in headless Chromium.
 *
 * Mouse ES-cell Hi-C (4DN 4DNFI5QJNFAT, 1.07 billion contacts) at the Sox2 locus,
 * chr3:34.2–35.2 Mb at 5 kb, with CTCF, H3K27ac and H3K4me3 ChIP-seq — the map and
 * the three tracks read in place from 4DN's bucket, through the session's proxy
 * (session/mouse_sox2.chromosomix.json). From the Analysis column: Diamond
 * insulation (its lane and borders join the map) and a model from the map
 * (pastis-NB, a cell of the deck). A 1D browser cell carries CTCF, H3K27ac and the
 * insulation lane; the model is coloured by H3K27ac.
 * General, Annotations and Aesthetics are folded to their strips so the deck
 * has the room. Shot at twice the CSS pixel density, to stay sharp at 100 mm.
 *
 * The app names itself, chromosomix, in its header and in every command line it
 * prints. BRAND, when set, rewrites that word in the page before the shot, for a
 * figure made while a name is not settled; nothing else on screen is touched.
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
const BRAND = process.env.BRAND ?? ''
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1600)
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 1000)
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

// The 4DN bucket is reached through the session's HTTPS proxy where there is one,
// and only https goes there: the dev server is plain http on the loopback. The
// proxy's CA is already in the system's NSS store.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    ...(proxy ? [`--proxy-server=https=${proxy.replace(/^https?:\/\//, '')}`] : []),
  ],
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
      if (n.nodeValue.includes('chromosomix')) n.nodeValue = n.nodeValue.replaceAll('chromosomix', brand)
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
  await page.goto(`${BASE}/?config=${BASE}/manuscript/figure1/session/mouse_sox2.chromosomix.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 300000 })
  await sleep(8000)
  await shot('u00-opened')

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
    const wanted = ['mm-ctcf', 'mm-h3k27ac', 'insulation-w10']
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
  const k27 = options.find(([v, t]) => v.startsWith('track:') && /H3K27ac/i.test(t))
  if (k27) {
    const row = page.locator('.structure-settings .field').filter({ has: page.locator('.field-label', { hasText: /^colour by$/ }) }).first()
    await row.locator('select').selectOption(k27[0])
    await sleep(3500)
  } else console.log('no H3K27ac option', JSON.stringify(options.slice(0, 12)))
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
  if (BRAND !== '') await rebrand(BRAND)
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
