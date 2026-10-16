/**
 * Two maps in one square, end to end in headless Chromium (§5.7, §7.5, §20.5).
 *
 * First the scale a ratio takes over and gives back: the yeast cooler beside
 * itself, split on its own `log10` and default ramp; *ratio*, on `log2` and the
 * diverging ramp; *split* again, which must be back on `log10` and the default
 * ramp — it stayed on the ratio's, since a change of comparison rebuilds the map
 * and the panel that would have given the scale back was the one torn down.
 * Then ratio → difference → split, the second map's eye closed under a ratio,
 * and a ratio reached by a link and put back to split, which has no scale of its
 * own to go back to and takes the file's defaults.
 *
 * Then a row out of the Files column dropped on the Contact maps card's *Load a
 * map into the lower triangle*: a folder connected (as a snapshot, which an
 * input — and so Playwright — can answer), its `.cool` dragged onto the slot,
 * and the square split between the two.
 *
 * Every step prints the Map card's transform and colours and the hash's, so a
 * scale that did not come back is a line here as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-compare-modes.mjs [out-dir]
 *
 * `GALLERY_ONLY=scale` or `files` runs one part.
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const ONLY = process.env.GALLERY_ONLY ?? ''
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const COOL = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`
const REGION = 'IV:1000000-1400000'

/** A folder holding a copy of the yeast cooler, to connect. */
const FOLDER = mkdtempSync(join(tmpdir(), 'compare-'))
mkdirSync(join(FOLDER, 'maps'))
copyFileSync(join(ROOT, 'demo/yeast/Yeast_microC_G2M_1kb.cool'), join(FOLDER, 'maps', 'Yeast_G2M_copy.cool'))

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
// A browser with no directory picker connects a folder as a snapshot, which an
// input can answer.
await context.addInitScript(() => {
  delete window.showDirectoryPicker
})
const page = await context.newPage()
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
/** Every map's veil down, after a draw has had time to start. */
const settled = async (timeout = 180000) => {
  await sleep(1500)
  await page.waitForFunction(
    () => [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
    null,
    { timeout },
  )
  await sleep(1200)
}
const open = async (url) => {
  await page.goto(url)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await settled()
}
/** The Map card's select under a label. */
const fieldSelect = (label) =>
  page.locator('.field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) }).locator('select').first()
/** What the card and the hash say about the scale. */
const said = async (step) => {
  const state = await page.evaluate(() => {
    const field = (label) => {
      for (const node of document.querySelectorAll('.field')) {
        if (node.querySelector('.field-label')?.textContent === label) return node.querySelector('select')?.value ?? null
      }
      return null
    }
    const hash = new URLSearchParams(location.hash.slice(1))
    return {
      compare: field('compare'),
      transform: field('transform'),
      colours: field('colours'),
      hash: { op: hash.get('op'), transform: hash.get('transform'), colormap: hash.get('colormap') },
      key: document.querySelector('.map-key')?.textContent?.replace(/\s+/g, ' ').trim(),
    }
  })
  console.log(`--- ${step}: ${JSON.stringify(state)}`)
  return state
}
const pick = async (op) => {
  await fieldSelect('compare').selectOption(op)
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 60000 })
  await settled()
}

try {
  if (ONLY === '' || ONLY === 'scale') {
    await open(`${BASE}/#uri=${COOL}&uri2=${COOL}&view=region&region=${REGION}`)
    await fold('Fold the General panel')
    await said('split, as opened')
    await shot('cm01-split')
    await pick('ratio')
    await said('ratio')
    await shot('cm02-ratio')
    await pick('split')
    const back = await said('split again')
    if (back.transform !== 'log10' || back.colours !== 'default') console.log('!! the split did not get its scale back')
    await shot('cm03-split-again')

    await pick('ratio')
    await pick('difference')
    await said('difference, after a ratio')
    await shot('cm04-difference')
    await pick('split')
    await said('split, after ratio and difference')
    await shot('cm05-split-after-difference')

    // The second map's eye under a ratio: a single map of counts, on counts' scale.
    await pick('ratio')
    await fold('Show the Annotations panel')
    const eyes = page.locator('.compare-card .ann-eye, .ann-row .ann-eye')
    console.log('eyes on the Contact maps card:', await eyes.count())
    await eyes.nth(1).click()
    await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 60000 })
    await settled()
    await said('ratio, second map hidden')
    await shot('cm06-ratio-second-hidden')
    await eyes.nth(1).click()
    await settled()
    await said('ratio, second map shown again')

    // A ratio arrived at by a link, carrying the ratio's own scale: put back to
    // split, it takes the file's defaults.
    await open(`${BASE}/#uri=${COOL}&uri2=${COOL}&view=region&region=${REGION}&op=ratio&transform=log2&colormap=RdBu_r`)
    await said('ratio from a link')
    await pick('split')
    await said('split, from a ratio that came by link')
    await shot('cm07-split-from-linked-ratio')
  }

  if (ONLY === '' || ONLY === 'files') {
    await open(`${BASE}/#uri=${COOL}&view=region&region=${REGION}`)
    // The folder, through the palette's command and the input it opens.
    await page.keyboard.press('Control+p')
    await sleep(400)
    await page.keyboard.type('folder')
    await sleep(400)
    await page.keyboard.press('Enter')
    await sleep(900)
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.connect-signin button')])
    await chooser.setFiles(join(FOLDER, 'maps'))
    await sleep(1500)
    await fold('Show the Annotations panel')
    await page.waitForSelector('.folder-entry-file', { timeout: 20000 })
    await shot('cm08-files-and-slot')
    const row = page.locator('.folder-entry-file', { hasText: 'Yeast_G2M_copy.cool' }).first()
    const slot = page.locator('.ann-drop', { hasText: 'lower triangle' }).first()
    await row.dragTo(slot)
    await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get('view') === 'region', null, { timeout: 30000 })
    await page.waitForFunction(
      () => [...document.querySelectorAll('.field .field-label')].some((n) => n.textContent === 'compare'),
      null,
      { timeout: 60000 },
    ).catch(() => console.log('!! no compare field after the drop'))
    await settled()
    await said('a Files row dropped on the lower triangle')
    await shot('cm09-row-in-lower-triangle')
  }
} finally {
  if (errors.length > 0) console.log('page errors:', errors)
  await browser.close()
}
