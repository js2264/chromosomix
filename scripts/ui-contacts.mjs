/**
 * Drive the breadcrumb's *contacts* box end to end in headless Chromium (§6.5).
 *
 * One map first — the yeast demo: the box with the file's own 179,175,551 in
 * grey, `10M` typed and the map redrawn from ten million contacts, a figure
 * saved with the caption that says so (through a stand-in save dialog that keeps
 * the bytes, as `ui-captions.mjs` does), P(s) run on the drawn map with its
 * framing line and the console's `chromosomix … --contacts` printed, a total
 * that is not one refused in the box, and the box emptied again. Then the deck
 * demo, a cooler beside a `.hic`: the two chevrons, pressed down (every map at
 * the shallower one's total) and up (every map at the deeper one's, through
 * Boost-HiC), and the deck's figure saved. Then two maps in one square, split
 * across the diagonal (the second named in `GALLERY_PAIR`), with no *match
 * depth* left on the Map card.
 * Last, E. coli at 1 kb, too long a chromosome for Boost-HiC, refused by name,
 * and the refusal's two ways out: *read as stored*, and the same total at 2 kb.
 *
 * Every step prints what the box said — its value, its placeholder, its title,
 * each chevron — and the hash, so a box that did not follow is a line here too.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-contacts.mjs [out-dir]
 *
 * `GALLERY_ONLY=map`, `deck`, `pair` or `refusal` runs one part.
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
const ONLY = process.env.GALLERY_ONLY ?? ''
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
// The stand-in save dialog: answers with the suggested name and keeps the bytes.
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
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const crumb = async (name) => {
  await page.locator('.breadcrumb').first().screenshot({ path: `${OUT}/${name}.png` })
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
/** What the box and its chevrons say, and the hash. */
const said = async (step) => {
  const state = await page.evaluate(() => {
    const box = document.querySelector('.contacts-input')
    const chevrons = [...document.querySelectorAll('.contacts-match')].map((b) =>
      b.classList.contains('hidden') ? 'hidden' : `${b.getAttribute('aria-pressed') === 'true' ? 'lit' : 'plain'}: ${b.title}`,
    )
    const notes = [...document.querySelectorAll('.map-panel-note, .panel-note, .deck-panel-note, .error-view')]
      .map((n) => n.textContent?.trim())
      .filter((t) => t)
    return {
      value: box?.value,
      placeholder: box?.placeholder,
      title: box?.title,
      classes: box?.className,
      chevrons,
      notes,
      hash: decodeURIComponent(location.hash).replace(/https?:\/\/[^/]+\/demo\//g, ''),
    }
  })
  console.log(`--- ${step}\n${JSON.stringify(state, null, 1)}`)
}
/** Every map's veil down, after a draw has had time to start. */
const settled = async (timeout = 180000) => {
  await sleep(1500)
  await page.waitForFunction(
    () => [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
    null,
    { timeout },
  )
  await sleep(1500)
}
const exportCard = () =>
  page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()
const saveAs = async (name) => {
  const before = await page.evaluate(() => window.__files.length)
  await exportCard().locator('.export-acts button').first().click()
  await page.waitForFunction((n) => window.__files.length > n, before, { timeout: 120000 })
  const file = await page.evaluate(() => window.__files.at(-1))
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(file.b64, 'base64'))
  console.log('saved', name, `(${file.name})`)
}
const type = async (text) => {
  const box = page.locator('.contacts-input')
  await box.click()
  await box.fill(text)
  await box.press('Enter')
}
const open = async (url, cells = 1) => {
  await page.goto(url)
  await page.waitForFunction(
    (n) => !document.body.textContent.includes('Opening ') && document.querySelectorAll('.heatmap-canvas').length >= n,
    cells,
    { timeout: 180000 },
  )
  await settled()
}

try {
  if (ONLY === '' || ONLY === 'map') {
    // ---- one map --------------------------------------------------------
    await open(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
    await fold('Fold the Annotations panel')
    await said('the file as stored')
    await crumb('ct01-crumb-as-stored')
    await shot('ct02-map-as-stored')

    await type('10M')
    await page.waitForFunction(() => location.hash.includes('contacts=10000000'), null, { timeout: 20000 })
    await settled()
    await said('10M typed')
    await crumb('ct03-crumb-10M')
    await shot('ct04-map-10M')

    // The figure, captioned: the line under the title says what the map was drawn to.
    await exportCard().locator('select.select-dpi').selectOption('150')
    await exportCard().locator('select.select-format').selectOption('png')
    await saveAs('ct05-figure-10M-captioned')

    // A task on the drawn map: its framing names the total, and so does the
    // command the console writes for it.
    await fold('Fold the General panel')
    await fold('Show the Analysis panel')
    await sleep(800)
    await page.locator('text=Contact probability P(s)').first().click()
    await sleep(900)
    await page.locator('button', { hasText: /^run$/i }).first().click()
    await page
      .waitForFunction(() => document.querySelector('.figure-chart svg') !== null, null, { timeout: 180000 })
      .catch(() => console.log('no P(s) figure'))
    await sleep(2500)
    console.log(
      'framing:',
      await page.evaluate(() => document.querySelector('.analysis-framing')?.textContent ?? '(none)'),
    )
    await shot('ct06-task-at-10M')
    await page.keyboard.press('Escape')
    await sleep(600)
    // The console only builds its rows while it is open.
    await page.locator('button[aria-label="console"]').first().click()
    await sleep(900)
    console.log(
      'console:',
      await page.evaluate(() =>
        [...document.querySelectorAll('.console-line.is-shell')].map((n) => n.textContent).at(-1) ?? '(none)',
      ),
    )
    await shot('ct06b-console-at-10M')
    await page.locator('button[aria-label="console"]').first().click()
    await sleep(600)
    await fold('Fold the Analysis panel')

    // A total that is not one: refused in the box, nothing redrawn.
    await type('lots')
    await sleep(800)
    await said('“lots” typed')
    await crumb('ct07-crumb-refused')

    // Emptied: every file as stored again.
    await page.keyboard.press('Escape')
    await type('')
    await page.waitForFunction(() => !location.hash.includes('contacts='), null, { timeout: 20000 })
    await settled()
    await said('emptied')
    await crumb('ct08-crumb-emptied')
  }

  if (ONLY === '' || ONLY === 'deck') {
    // ---- a deck: a cooler beside a .hic ---------------------------------
    await open(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.chromosomix.json`, 2)
    await fold('Fold the Annotations panel')
    // The .hic says nothing exact about its total, and is counted.
    await page
      .waitForFunction(
        () => [...document.querySelectorAll('.contacts-match')].every((b) => !b.classList.contains('hidden') && !b.disabled),
        null,
        { timeout: 60000 },
      )
      .catch(() => console.log('the chevrons did not come up'))
    await said('deck, as stored')
    await crumb('ct09-deck-crumb')
    await shot('ct10-deck-as-stored')

    await page.locator('.contacts-match').first().click()
    await settled()
    await said('down: every map at the shallowest')
    await shot('ct11-deck-down')

    await page.locator('.contacts-match').nth(1).click()
    await settled(300000)
    await said('up: every map at the deepest, through Boost-HiC')
    await shot('ct12-deck-up')
    await exportCard().locator('select.select-dpi').selectOption('150')
    await exportCard().locator('select.select-format').selectOption('png')
    await saveAs('ct13-deck-figure-captioned')
  }

  if (ONLY === '' || ONLY === 'pair') {
    // ---- the same two files in one square, split across the diagonal ----
    // The demo has no second yeast map with the cooler's sixteen sequences (the
    // `.hic` carries a seventeenth, which the pair's gate refuses), so the
    // second file is named in GALLERY_PAIR — a thinned copy of the cooler does —
    // and is the cooler itself where none is named: a file drawn beside itself,
    // which at one total and one seed is one map twice.
    const cool = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`
    const second = process.env.GALLERY_PAIR ?? cool
    await open(`${BASE}/#uri=${cool}&uri2=${second}&view=region&region=IV:1000000-1400000&transform=log10`)
    await page.waitForFunction(() => document.querySelectorAll('.contacts-match:not(.hidden)').length === 2, null, { timeout: 60000 })
      .catch(() => console.log('no chevrons on the pair'))
    await settled()
    console.log(
      'Map card fields:',
      await page.evaluate(() => [...document.querySelectorAll('.field .field-label')].map((n) => n.textContent).join(', ')),
    )
    await said('pair, as stored')
    await shot('ct14-pair-as-stored')
    await page.locator('.contacts-match').first().click()
    await settled()
    await said('pair, down')
    await shot('ct15-pair-down')
  }

  if (ONLY === '' || ONLY === 'refusal') {
    // ---- a chromosome too long for Boost-HiC ----------------------------
    await open(`${BASE}/#uri=${BASE}/demo/ecoli/Ecoli.mcool::/resolutions/1000&view=region&region=NC_000913.3&transform=log10`)
    await type('500M')
    await sleep(6000)
    await said('E. coli at 1 kb, 500M typed')
    await shot('ct16-refused-oversample')

    // The way out the refusal offers: the file as stored, one press away.
    await page.locator('button', { hasText: /^read as stored$/ }).click()
    await page.waitForFunction(() => !location.hash.includes('contacts='), null, { timeout: 20000 })
    await page.waitForFunction(() => document.querySelectorAll('.heatmap-canvas').length >= 1, null, { timeout: 60000 })
    await settled()
    await said('read as stored')
    await shot('ct17-read-as-stored')

    // And the one the message gives: a coarser resolution, which Boost-HiC takes.
    await page.goto(
      `${BASE}/#uri=${BASE}/demo/ecoli/Ecoli.mcool::/resolutions/2000&view=region&region=NC_000913.3&transform=log10&contacts=500000000`,
    )
    await page.waitForFunction(() => document.querySelectorAll('.heatmap-canvas').length >= 1, null, { timeout: 300000 })
    await settled(300000)
    await said('E. coli at 2 kb, 500M')
    await shot('ct18-oversampled-2kb')
  }
} catch (error) {
  console.log('FAILED', error)
  await shot('ct-failure')
}
console.log('errors:', errors.length === 0 ? 'none' : errors.slice(0, 12))
await browser.close()
