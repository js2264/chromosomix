/**
 * Drive a sequence lane's six reading frames in headless Chromium and write what
 * each state looks like (§8.8).
 *
 * The 1D browser demo, its FASTA's row opened on the Tracks card — before and
 * after *reading frames* is pressed, with the code beside it — then UTP5's start
 * codon on chromosome IV close enough for every codon to carry its amino acid,
 * further out where the codons are bare boxes, at 20 kb where the starts and
 * stops are ticks, and the whole chromosome, where the band says to zoom in. The
 * same window of codons read in the standard code and in table 4, where `TGA`
 * stops being a stop and becomes a tryptophan; the readout over a start codon;
 * a reload, which must bring the frames and the code back; and the dark theme.
 * Prints what each step found.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-orfs.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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
const TRACKS = `${BASE}/?config=${BASE}/demo/yeast/Yeast_tracks.metacooler.json`
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
const rowNamed = async (name) => {
  const names = await page.$$eval('.annotation-card .ann-row', (rows) => rows.map((row) => row.querySelector('input.ann-name')?.value ?? ''))
  const at = names.indexOf(name)
  if (at < 0) throw new Error(`no row named ${name}: ${names.join(', ')}`)
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
const goTo = async (locus, settle = 3000) => {
  const input = locusBox()
  await input.click()
  await input.fill(locus)
  await input.press('Enter')
  await sleep(settle)
  await page.mouse.move(5, 5)
  await sleep(300)
}
const browserBox = () => page.locator('.browser-canvas').first().boundingBox()
const lanesShot = async (name, height = 300) => {
  const box = await browserBox()
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, height) } })
  console.log('shot', name)
}
/** The sequence row's settings, opened: the chip's state and the code. */
const openSequence = async () => {
  await fold('Show the Annotations panel')
  const row = await rowNamed('sequence')
  await row.scrollIntoViewIfNeeded()
  if ((await row.locator('button:has-text("reading frames")').count()) === 0) {
    await row.locator('.ann-more').click()
    await sleep(700)
  }
  await row.scrollIntoViewIfNeeded()
  return row
}
const framesSay = async (row) => ({
  frames: await row.locator('button:has-text("reading frames")').getAttribute('aria-pressed'),
  code: await row.locator('select').filter({ has: page.locator('option[value="33"]') }).inputValue(),
})
const codeSelect = (row) => row.locator('select').filter({ has: page.locator('option[value="33"]') }).first()
/** Where the first strongly green pixel of the browser canvas is: a start codon, filled. */
const findGreen = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.browser-canvas')
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    const data = ctx.getImageData(0, 0, width, height).data
    const box = canvas.getBoundingClientRect()
    const scale = width / box.width
    for (let y = 0; y < height; y++) {
      for (let x = Math.floor(width * 0.2); x < width; x++) {
        const i = (y * width + x) * 4
        // A start codon's fill: #2e9d4f at 0.85 over the white paper.
        if (Math.abs(data[i] - 77) < 10 && Math.abs(data[i + 1] - 172) < 10 && Math.abs(data[i + 2] - 105) < 10) {
          return { x: box.left + (x + 6) / scale, y: box.top + (y + 5) / scale }
        }
      }
    }
    return null
  })

/** Codons of the demo FASTA in a window, by frame, as the lane reads them. */
function tgaIn(contig, from, to) {
  const text = readFileSync('demo/yeast/S288c_syn40-XIII.fa', 'utf8')
  const start = text.indexOf(`>${contig}\n`)
  const body = text.slice(text.indexOf('\n', start) + 1, text.indexOf('\n>', start + 1)).replace(/\s+/g, '')
  const found = []
  for (let p = from; p + 3 <= to; p++) {
    const codon = body.slice(p, p + 3).toUpperCase()
    if (codon === 'TGA') found.push(`+${(p % 3) + 1} at ${p + 1}`)
    if (codon === 'TCA') found.push(`−${(p % 3) + 1} at ${p + 1}`)
  }
  return found
}

try {
  page = await fresh()
  await page.goto(TRACKS)
  await page.waitForSelector('.browser-canvas', { timeout: 120000 })
  // The two outer columns folded, for a browser wide enough that the frames'
  // three rungs land where they would on a laptop with the columns open.
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Annotations panel')
  await allReady(5)
  await sleep(1500)

  // The setting, before and after it is pressed.
  {
    const row = await openSequence()
    console.log('before:', await framesSay(row))
    await row.screenshot({ path: `${OUT}/o01-settings-off.png` })
    console.log('shot o01-settings-off')
    await row.locator('button:has-text("reading frames")').click()
    await sleep(900)
    const again = await openSequence()
    console.log('after the press:', await framesSay(again))
    await again.screenshot({ path: `${OUT}/o02-settings-on.png` })
    console.log('shot o02-settings-on')
    const options = await codeSelect(again).locator('option').allTextContents()
    console.log('codes offered:', options.length, options.slice(0, 5).join(' | '), '…')
  }
  await fold('Fold the Annotations panel')
  await sleep(800)

  // UTP5's start codon, 1,267,471 – 1,267,473 (+): in frame +1, since 1,267,470
  // is a multiple of three.
  await goTo('IV:1,267,421-1,267,540')
  await lanesShot('o03-letters-utp5-start')
  // The readout over the start codon.
  const green = await findGreen()
  console.log('first filled start at:', green)
  if (green !== null) {
    await page.mouse.move(green.x, green.y)
    await sleep(700)
    const tip = await page.$$eval('.cell-tip-row', (rows) => rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim()))
    console.log('readout:', tip.join(' | '))
    const box = await browserBox()
    await page.screenshot({ path: `${OUT}/o04-readout-start-codon.png`, clip: { x: box.x, y: box.y, width: box.width, height: 420 } })
    console.log('shot o04-readout-start-codon')
    await page.mouse.move(5, 5)
  }

  await goTo('IV:1,267,101-1,268,100')
  await lanesShot('o05-codons-bare')
  await goTo('IV:1,262,001-1,282,000')
  await lanesShot('o06-ticks-20kb')
  await goTo('IV', 4000)
  await lanesShot('o07-whole-chromosome-zoom-in')

  // One window in two codes: TGA a stop in table 1, a tryptophan in table 4.
  const window = [1_268_101, 1_268_220]
  console.log('TGA (+) and TCA (−) codons in the window:', tgaIn('IV', window[0] - 1, window[1]).join(', '))
  await goTo(`IV:${window[0].toLocaleString('en')}-${window[1].toLocaleString('en')}`)
  await lanesShot('o08-table1-tga-stop')
  {
    const row = await openSequence()
    await codeSelect(row).selectOption('4')
    await sleep(900)
    console.log('after picking table 4:', await framesSay(await openSequence()))
  }
  await fold('Fold the Annotations panel')
  await sleep(800)
  await page.mouse.move(5, 5)
  await sleep(300)
  await lanesShot('o09-table4-tga-tryptophan')

  // A reload brings both back (§8.6).
  await page.reload()
  await page.waitForSelector('.browser-canvas', { timeout: 120000 })
  await fold('Show the Annotations panel')
  await allReady(5)
  await sleep(1500)
  console.log('after a reload:', await framesSay(await openSequence()))
  await fold('Fold the Annotations panel')
  await goTo(`IV:${window[0].toLocaleString('en')}-${window[1].toLocaleString('en')}`)
  await lanesShot('o10-after-reload')

  // The dark theme, at the start codon, with the frames turned on there.
  page = await fresh('dark')
  await page.goto(TRACKS)
  await page.waitForSelector('.browser-canvas', { timeout: 120000 })
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Annotations panel')
  await allReady(5)
  await sleep(1500)
  {
    const row = await openSequence()
    await row.locator('button:has-text("reading frames")').click()
    await sleep(900)
    await (await openSequence()).screenshot({ path: `${OUT}/o11-dark-settings.png` })
    console.log('shot o11-dark-settings')
  }
  await goTo('IV:1,267,421-1,267,540')
  await shot('o12-dark-theme')
  await fold('Fold the Annotations panel')
  await goTo('IV:1,262,001-1,282,000')
  await lanesShot('o13-dark-ticks')
} catch (err) {
  console.error('FAILED', err)
  if (page !== null) await page.screenshot({ path: `${OUT}/o-failed.png` }).catch(() => {})
}

console.log('errors:', errors.length === 0 ? 'none' : errors.slice(0, 10))
await browser.close()
