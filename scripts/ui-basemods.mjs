/**
 * Drive base modifications from a BAM's MM/ML tags in headless Chromium and
 * write what each state looks like (§8.13).
 *
 * The yeast demo's chromosome IV in the 1D browser, its sequence and genes
 * only, with the simulated nanopore BAM (`demo/yeast/Yeast_ONT_basemods.sim.bam`,
 * written by `scripts/make-basemods-demo.mjs`) dropped on it with its index:
 * the pile's settings card with *colour by → base modification* and its key;
 * the reads coloured by 5mC across UTP5 and its nearly bare promoter, then
 * closer; 5hmC and 6mA picked instead; a hover on one call and the card a
 * click on its read opens; the depth row drawn as the percentage modified,
 * at two thresholds; and the dark theme. Prints every row, card and readout
 * it met.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-basemods.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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
const BAM = 'Yeast_ONT_basemods.sim.bam'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page = null
async function fresh(scheme = 'light') {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: scheme })
  const next = await context.newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const rowsSay = () =>
  page.$$eval('.annotation-card .ann-row', (rows) =>
    rows.map((row) => `${row.querySelector('input.ann-name')?.value ?? ''}: ${row.textContent?.replace(/\s+/g, ' ').trim().slice(0, 110)}`),
  )
const rowNames = () =>
  page.$$eval('.annotation-card .ann-row', (rows) => rows.map((row) => row.querySelector('input.ann-name')?.value ?? ''))
const rowMatching = async (test) => {
  const names = await rowNames()
  const at = names.findIndex(test)
  if (at < 0) throw new Error(`no such row: ${names.join(', ')}`)
  return page.locator('.annotation-card .ann-row').nth(at)
}
const allReady = (n) =>
  page.waitForFunction(
    (count) => {
      const rows = [...document.querySelectorAll('.annotation-card .ann-row')]
      return rows.length >= count && rows.every((row) => !/reading|loading|reopening/i.test(row.textContent ?? ''))
    },
    n,
    { timeout: 180000 },
  )
const locusBox = () => page.locator('input.search, .search-box input').first()
const goTo = async (locus, settle = 3500) => {
  const input = locusBox()
  await input.click()
  await input.fill(locus)
  await input.press('Enter')
  await sleep(settle)
  await page.mouse.move(5, 5)
  await sleep(300)
}
const browserBox = () => page.locator('.browser-canvas').first().boundingBox()
const lanesShot = async (name, height = 760) => {
  const box = await browserBox()
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: box.x, y: box.y + 30, width: box.width, height: Math.min(box.height - 30, height) } })
  console.log('shot', name)
}
/** Where on the browser canvas a colour is, from the top: the first run of it found. */
const findInk = (rgb, minRun = 1, tolerance = 40) =>
  page.evaluate(({ rgb, minRun, tolerance }) => {
    const canvas = document.querySelector('.browser-canvas')
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    const data = ctx.getImageData(0, 0, width, height).data
    const box = canvas.getBoundingClientRect()
    const scale = width / box.width
    for (let y = Math.floor(height * 0.3); y < height; y++) {
      let run = 0
      for (let x = Math.floor(width * 0.3); x < width; x++) {
        const i = (y * width + x) * 4
        const hit = Math.abs(data[i] - rgb[0]) < tolerance && Math.abs(data[i + 1] - rgb[1]) < tolerance && Math.abs(data[i + 2] - rgb[2]) < tolerance
        run = hit ? run + 1 : 0
        if (run >= minRun) return { x: box.left + (x - (minRun - 1) / 2) / scale, y: box.top + y / scale }
      }
    }
    return null
  }, { rgb, minRun, tolerance })
const tipSays = () => page.$$eval('.cell-tip-block', (tips) => tips.map((tip) => tip.textContent?.replace(/\s+/g, ' ').trim()).join(' | '))
const cardSays = () =>
  page.$$eval('.modal-backdrop .modal-head, .modal-backdrop .feature-row', (rows) => rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim()).join(' | '))

/** Drop the BAM and its index on the browser, as a reader would from a file manager. */
async function dropBam() {
  await page.evaluate(async ({ base, name }) => {
    const files = []
    for (const file of [name, `${name}.bai`]) {
      const bytes = await (await fetch(`${base}/demo/yeast/${file}`)).arrayBuffer()
      files.push(new File([bytes], file, { type: 'application/octet-stream' }))
    }
    const target = document.querySelector('.browser-canvas')
    const transfer = new DataTransfer()
    for (const file of files) transfer.items.add(file)
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  }, { base: BASE, name: BAM })
}

/** The pile's row, opened, with its colouring set. */
async function colourBy(value) {
  const row = await rowMatching((name) => /basemods/i.test(name) && /read/i.test(name))
  await row.scrollIntoViewIfNeeded()
  if ((await row.locator('select').count()) === 0) {
    await row.locator('.ann-more').click()
    await sleep(700)
  }
  // Tall enough for the window's reads, so the pile is not cut off and its
  // caption does not run on about the rest.
  const height = row.locator('label:has-text("height") input').first()
  await height.fill('300')
  await height.press('Enter')
  await sleep(600)
  const picker = row.locator('select').filter({ has: page.locator('option[value="basemod"]') }).first()
  await picker.selectOption(value)
  await sleep(1500)
  return row
}

// A session of the yeast demo with its sequence and genes and nothing else, so
// the reads have the height.
const session = JSON.parse(readFileSync('demo/yeast/Yeast_tracks.metacooler.json', 'utf8'))
const tab = session.tabs[0]
tab.tracks = tab.tracks.filter((track) => track.id === 'demo-sequence' || track.id === 'demo-genes')
tab.state.locus = 'IV:1,266,001-1,274,000'
const probe = 'demo/yeast/_gallery-basemods.metacooler.json'
writeFileSync(probe, JSON.stringify(session))
const CONFIG = `${BASE}/?config=${BASE}/${probe}`

async function open(scheme = 'light') {
  page = await fresh(scheme)
  await page.goto(CONFIG)
  await page.waitForSelector('.browser-canvas', { timeout: 120000 })
  await fold('Show the Annotations panel')
  await allReady(2)
  await sleep(1500)
  await dropBam()
  await sleep(1000)
  await allReady(4)
  await sleep(2500)
}

try {
  await open()
  console.log('rows:', (await rowsSay()).join('\n      '))

  // The pile's card: colour by → base modification, its key and its controls.
  {
    const row = await colourBy('basemod')
    await page.mouse.click(5, 5)
    await sleep(800)
    await row.scrollIntoViewIfNeeded()
    await row.screenshot({ path: `${OUT}/bm01-card-colour-by-basemod.png` })
    console.log('shot bm01-card-colour-by-basemod ·', (await row.textContent())?.replace(/\s+/g, ' ').trim().slice(0, 300))
    const options = await row.locator('select').nth(0).locator('option').allTextContents()
    console.log('colour by offers:', options.join(', '))
  }
  await fold('Fold the Annotations panel')
  await sleep(800)
  await goTo('IV:1,266,001-1,274,000', 4500)
  await shot('bm02-reads-5mC-whole-page')
  await lanesShot('bm03-reads-5mC-utp5')
  await goTo('IV:1,266,701-1,267,900', 4000)
  await lanesShot('bm04-reads-5mC-promoter-closer')

  // A hover on one call: the first strong red the pile has, then the readout.
  {
    const red = await findInk([215, 25, 28], 2, 30)
    console.log('a 5mC call at:', red)
    if (red !== null) {
      await page.mouse.move(red.x, red.y + 1)
      await sleep(900)
      console.log('hover:', await tipSays())
      await shot('bm05-hover-on-a-call')
      // …and the read's own card.
      await page.mouse.click(red.x, red.y + 1)
      await sleep(1500)
      console.log('read card:', await cardSays())
      await shot('bm06-read-card')
      await page.keyboard.press('Escape')
      await sleep(400)
    }
  }

  // Another modification: 5hmC across the same window, then 6mA up close.
  await fold('Show the Annotations panel')
  {
    const row = await rowMatching((name) => /basemods/i.test(name) && /read/i.test(name))
    await row.scrollIntoViewIfNeeded()
    const pick = row.locator('select').filter({ has: page.locator('option[value="h"]') }).first()
    console.log('modifications offered:', (await pick.locator('option').allTextContents()).join(', '))
    await pick.selectOption('h')
    await sleep(1200)
    await page.mouse.click(5, 5)
    await row.screenshot({ path: `${OUT}/bm07-card-5hmC-picked.png` })
    console.log('shot bm07-card-5hmC-picked')
  }
  await fold('Fold the Annotations panel')
  await sleep(800)
  await goTo('IV:1,266,701-1,267,900', 4000)
  await lanesShot('bm08-reads-5hmC')
  await fold('Show the Annotations panel')
  {
    const row = await rowMatching((name) => /basemods/i.test(name) && /read/i.test(name))
    await row.locator('select').filter({ has: page.locator('option[value="a"]') }).first().selectOption('a')
    await sleep(800)
  }
  await fold('Fold the Annotations panel')
  await goTo('IV:1,267,101-1,267,400', 4000)
  await lanesShot('bm09-reads-6mA-close')

  // Back to 5mC, and the depth row drawn as the percentage modified.
  await fold('Show the Annotations panel')
  {
    const pile = await rowMatching((name) => /basemods/i.test(name) && /read/i.test(name))
    await pile.locator('select').filter({ has: page.locator('option[value="m"]') }).first().selectOption('m')
    await sleep(600)
    const depth = await rowMatching((name) => /basemods/i.test(name) && !/read/i.test(name))
    await depth.scrollIntoViewIfNeeded()
    if ((await depth.locator('text=% modified').count()) === 0) {
      await depth.locator('.ann-more').click()
      await sleep(700)
    }
    await depth.locator('button', { hasText: '% modified' }).click()
    await sleep(1500)
    const fresh = await rowMatching((name) => /basemods/i.test(name) && !/read/i.test(name))
    await fresh.scrollIntoViewIfNeeded()
    await fresh.screenshot({ path: `${OUT}/bm10-card-depth-percent-modified.png` })
    console.log('shot bm10-card-depth-percent-modified ·', (await fresh.textContent())?.replace(/\s+/g, ' ').trim().slice(0, 300))
  }
  await fold('Fold the Annotations panel')
  await goTo('IV:1,266,001-1,274,000', 5000)
  await lanesShot('bm11-depth-as-percent-5mC')
  {
    // The readout over the percentage lane.
    const box = await browserBox()
    await page.mouse.move(box.x + box.width * 0.62, box.y + 200)
    await sleep(800)
    console.log('hover over the percentage:', await tipSays())
  }
  // Closer, where each value is one cytosine — drawn as points, a dot per
  // call's base, which is how a bedMethyl reads best at this zoom.
  await fold('Show the Annotations panel')
  {
    const depth = await rowMatching((name) => /basemods/i.test(name) && !/read/i.test(name))
    await depth.locator('select').filter({ has: page.locator('option[value="points"]') }).first().selectOption('points')
    await sleep(600)
  }
  await fold('Fold the Annotations panel')
  await goTo('IV:1,266,701-1,267,900', 4000)
  await lanesShot('bm12-depth-as-percent-closer')

  // A stricter threshold: the coin-flips leave both the pile and the fraction.
  await fold('Show the Annotations panel')
  {
    const pile = await rowMatching((name) => /basemods/i.test(name) && /read/i.test(name))
    const box = pile.locator('input[type="number"][step="0.05"]').first()
    await box.fill('0.9')
    await box.press('Enter')
    await page.mouse.click(5, 5)
    await sleep(1500)
  }
  await fold('Fold the Annotations panel')
  await goTo('IV:1,266,701-1,267,900', 4000)
  await lanesShot('bm13-threshold-0.9')

  // The dark theme: the chrome turns, the figure stays on paper (§16.5).
  page = await fresh('dark')
  await page.goto(CONFIG)
  await page.waitForSelector('.browser-canvas', { timeout: 120000 })
  await fold('Show the Annotations panel')
  await allReady(2)
  await sleep(1500)
  await dropBam()
  await sleep(1000)
  await allReady(4)
  await sleep(2000)
  await colourBy('basemod')
  await page.mouse.click(5, 5)
  await sleep(600)
  await goTo('IV:1,266,701-1,267,900', 4500)
  await page.mouse.move(5, 5)
  await shot('bm14-dark-theme')
} catch (err) {
  console.error('FAILED', err)
  if (page !== null) await page.screenshot({ path: `${OUT}/bm-failed.png` }).catch(() => {})
} finally {
  rmSync(probe, { force: true })
}

console.log('errors:', errors.length === 0 ? 'none' : errors.slice(0, 10))
await browser.close()
