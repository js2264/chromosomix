/**
 * The lower triangle in a reading of its own (§5.10), in headless Chromium.
 *
 * The yeast Micro-C demo on IV, balanced in `log10` above the diagonal. The Map
 * card's second tab, `◣ lower`, with its switch off; switched on, which must
 * change nothing on screen; its O/E on, which draws the triangle below the
 * diagonal on a diverging ramp of its own and puts a second key under the
 * first; a despeckle and a ramp chosen for it; its score moved to counts, which
 * is a second read of the same file; a hover on each side of the diagonal; the
 * map turned, the two readings as two bands; a bound typed in the second key;
 * a reload, from the link alone; the map's own tab with the dot on the second;
 * and a second file opened into the triangle, which puts the reading down.
 * Every step prints the two keys and the lower keys of the hash.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-lower-reading.mjs [out-dir]      # writes lr01 … lr13
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
// The stand-in save dialog of `ui-captions.mjs`: keeps what is written.
await context.addInitScript(() => {
  window.__files = []
  window.showSaveFilePicker = async (options) => ({
    name: options.suggestedName,
    createWritable: async () => ({
      write: async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        window.__files.push({ name: options.suggestedName, b64: btoa(s) })
      },
      close: async () => {},
    }),
  })
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name, clip) => {
  await sleep(400)
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip === undefined ? {} : { clip }) })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return true }
  }
  return false
}
const settled = () =>
  page.waitForFunction(
    () => {
      const veil = document.querySelector('.panel-overlay')
      return document.querySelector('.heatmap-canvas') !== null && (veil === null || veil.classList.contains('hidden'))
    },
    null,
    { timeout: 120000 },
  ).catch(() => console.log('the map never settled'))
/** The Map card, by its title. */
const mapCard = () => page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Map$/ }) }).first()
const tab = (text) => mapCard().locator('.map-tab', { hasText: text })
/** A field of the lower tab, by its label. */
const lowerField = (label) => mapCard().locator('.map-lower .field').filter({ has: page.locator(`.field-label:text-is("${label}")`) }).first()
/** The map and the Map card beside it, in one picture. */
const withCard = async (name) => {
  // Off the card and the map, so no control is drawn under the hand.
  await page.mouse.move(5, 5)
  const map = await page.locator('.heatmap-wrap').first().boundingBox()
  const card = await mapCard().boundingBox()
  if (map === null || card === null) return shot(name)
  const x = Math.max(0, Math.min(map.x, card.x) - 10)
  const y = Math.max(0, Math.min(map.y, card.y) - 10)
  const right = Math.max(map.x + map.width, card.x + card.width) + 10
  const bottom = Math.max(map.y + map.height, card.y + card.height) + 10
  await shot(name, { x, y, width: Math.min(1600, right) - x, height: Math.min(1000, bottom) - y })
}
const report = async (when) => {
  const said = await page.evaluate(() => ({
    keys: [...document.querySelectorAll('.map-key')]
      .filter((node) => !node.classList.contains('hidden'))
      .map((node) => `${node.querySelector('.map-key-title')?.textContent ?? ''} [${[...node.querySelectorAll('.map-key-value')].map((v) => v.textContent).join(' – ')}]`),
    tabs: [...document.querySelectorAll('.map-tab')].map((node) => `${node.textContent}${node.classList.contains('is-on') ? '*' : ''}${node.classList.contains('is-set') ? '•' : ''}`),
    hash: decodeURIComponent(location.hash).match(/(lower|score2|oe2|smooth2|transform2|colormap2|vmin2|vmax2|uri2|score|balance|oe|flip)=[^&]*/g)?.join(' ') ?? '',
  }))
  console.log(`\n${when}\n  tabs: ${said.tabs.join(' | ')}\n  keys: ${said.keys.join('  /  ')}\n  hash: ${said.hash}`)
}
/** Point at a cell `fx` across and `fy` down the plot, and read the status line. */
const hover = async (fx, fy) => {
  const canvas = await page.locator('.heatmap-canvas').first().boundingBox()
  if (canvas === null) return ''
  await page.mouse.move(canvas.x + canvas.width * fx, canvas.y + canvas.height * fy)
  await sleep(500)
  return page.evaluate(() => document.querySelector('.status-coords')?.textContent ?? '')
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await settled()
  await sleep(2500)
  // A square map: the demo may open turned.
  const square = await page.$('button[title*="square" i]')
  if (square) { await square.click(); await settled(); await sleep(2000) }
  await mapCard().scrollIntoViewIfNeeded()
  await report('opened: balanced log10, one reading')
  await withCard('lr01-map-tab')

  await tab('lower').click()
  await sleep(500)
  await report('the lower tab, switch off')
  await withCard('lr02-lower-off')

  await lowerField('own reading').locator('button').click()
  await settled()
  await sleep(1500)
  await report('switched on: seeded from the map, so nothing moves')
  await withCard('lr03-lower-on-seeded')

  await lowerField('baseline').locator('button').click()
  await settled()
  await sleep(2000)
  await report('O/E below the diagonal')
  await withCard('lr04-lower-oe')

  await lowerField('smooth').locator('select').selectOption({ label: 'adaptive' }).catch(async () => {
    const options = await lowerField('smooth').locator('option').allTextContents()
    console.log('smooth options:', options.join(' | '))
    await lowerField('smooth').locator('select').selectOption({ index: options.length - 1 })
  })
  await settled()
  await sleep(4000)
  await lowerField('colours').locator('select').selectOption('BuWtRd')
  await sleep(1500)
  await report('despeckled, on BuWtRd')
  await withCard('lr05-lower-smooth-ramp')

  await lowerField('score').locator('select').selectOption('count')
  await page.waitForFunction(() => decodeURIComponent(location.hash).includes('score2=count'), null, { timeout: 20000 }).catch(() => {})
  await settled()
  await sleep(4000)
  await report('counts below the diagonal: a second read of the same file')
  await withCard('lr06-lower-counts')

  console.log('\nreadout above the diagonal:', await hover(0.7, 0.3))
  await shot('lr07a-hover-upper')
  console.log('readout below the diagonal:', await hover(0.3, 0.7))
  await shot('lr07b-hover-lower')
  await page.mouse.move(5, 5)

  // The turn, from the map's own tab.
  await tab('map').click()
  await sleep(400)
  const turn = await page.$('button[title*="Turn the map 45"]')
  if (turn) { await turn.click(); await settled(); await sleep(3000) }
  else console.log('no turn button')
  await report('turned: two bands')
  await withCard('lr08-turned-bands')
  if (turn) {
    const back = await page.$('button[title*="square" i]')
    if (back) { await back.click(); await settled(); await sleep(2500) }
  }

  // A bound typed in the second key, as in the first.
  const lowerKey = page.locator('.map-key:not(.hidden)').nth(1)
  await lowerKey.locator('.map-key-value.is-hi').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('2.5')
  await page.keyboard.press('Enter')
  await sleep(1500)
  await report('a bound typed in the second key')
  await shot('lr09-second-key-bound', await page.locator('.heatmap-wrap').first().boundingBox() ?? undefined)

  // The figure as saved: both readings, both keys, and a caption that says both.
  const exportCard = page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()
  await exportCard.locator('select.select-format').selectOption('png')
  const before = await page.evaluate(() => window.__files.length)
  await exportCard.locator('.export-acts button').first().click()
  await page.waitForFunction((n) => window.__files.length > n, before, { timeout: 120000 }).catch(() => console.log('nothing saved'))
  const saved = await page.evaluate(() => window.__files.at(-1))
  if (saved !== undefined) {
    writeFileSync(`${OUT}/lr09b-saved-figure.png`, Buffer.from(saved.b64, 'base64'))
    console.log('saved lr09b-saved-figure', `(${saved.name})`)
  }

  await report('the map tab, with the dot on the lower one')
  await withCard('lr10-map-tab-dot')

  await page.reload()
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await settled()
  await sleep(4000)
  await report('reloaded from the link')
  await withCard('lr11-reloaded')

  // Switched off: the map is one reading again, and the link keeps the rest.
  await tab('lower').click()
  await lowerField('own reading').locator('button').click()
  await settled()
  await sleep(2000)
  await report('switched off')
  await withCard('lr12-off-again')
  await lowerField('own reading').locator('button').click()
  await settled()
  await sleep(2000)

  // A second file into the triangle: the reading is put down.
  await page.evaluate(() => {
    const hash = new URLSearchParams(location.hash.slice(1))
    hash.set('uri2', hash.get('uri') ?? '')
    location.hash = [...hash.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  })
  await sleep(6000)
  await settled()
  await report('a second file opened into the triangle')
  await withCard('lr13-second-file-drops-it')
} catch (err) {
  console.log('failed:', err)
  await shot('lr-failure')
} finally {
  if (errors.length > 0) console.log('\npage errors:\n  ' + [...new Set(errors)].slice(0, 20).join('\n  '))
  await browser.close()
}
