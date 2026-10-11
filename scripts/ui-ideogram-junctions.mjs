/**
 * Drive the ideogram and the junction lanes in headless Chromium and write what
 * each state looks like (§8.22, §8.23).
 *
 * The human chrX demo first, in the 1D browser the hg19 cytoBand opens: RPL10
 * as the session opens it — the coverage with its own arcs, two samples' STAR
 * junctions on one typed axis — then FLNA beside it, where the reverse strand's
 * arcs hang below the line; the whole of chromosome X, bands and all, and the
 * whole karyotype; a click on an arc and one on a band, and the cards they
 * open; the Tracks card's rows for the three kinds; a band typed in the locus
 * box; the junctions coloured by whether STAR's GTF knew them, at DDX3X and its
 * 3′ end, where the novel acceptor parts from the annotated one three bases
 * away, with that lane's axis let go to the window; a regtools BED dropped on
 * the browser; and the dark theme, whose chrome turns while the figure stays
 * on paper (§16.5). Then the yeast map with its karyotype on two edges — CEN4's
 * waist at 449 kb — and on chromosome I with the test subset's junctions
 * beside it, EFB1's arc and CEN1 on both axes. Prints what each step found.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-ideogram-junctions.mjs [out-dir]
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
const HUMAN = `${BASE}/?config=${BASE}/demo/human/Human_chrX_RNA.chromosomix.json`
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
/** Each row of the Tracks card as `name: summary` — the name is an input, which has no text. */
const rowsSay = () =>
  page.$$eval('.annotation-card .ann-row', (rows) =>
    rows.map((row) => `${row.querySelector('input.ann-name')?.value ?? ''}: ${row.textContent?.replace(/\s+/g, ' ').trim().slice(0, 90)}`),
  )
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
const lanesShot = async (name, height = 560) => {
  const box = await browserBox()
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: box.x, y: box.y + 30, width: box.width, height: Math.min(box.height - 30, height) } })
  console.log('shot', name)
}
/** Where on the browser canvas a colour is, scanning rows from the bottom: the first run of it found. */
const findInk = (rgb, from = 'bottom', minRun = 1) =>
  page.evaluate(({ rgb, from, minRun }) => {
    const canvas = document.querySelector('.browser-canvas')
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    const data = ctx.getImageData(0, 0, width, height).data
    const box = canvas.getBoundingClientRect()
    const scale = width / box.width
    const rows = [...Array(height).keys()]
    if (from === 'bottom') rows.reverse()
    for (const y of rows) {
      let run = 0
      for (let x = Math.floor(width * 0.3); x < width; x++) {
        const i = (y * width + x) * 4
        const hit = Math.abs(data[i] - rgb[0]) < 6 && Math.abs(data[i + 1] - rgb[1]) < 6 && Math.abs(data[i + 2] - rgb[2]) < 6
        run = hit ? run + 1 : 0
        if (run >= minRun) return { x: box.left + (x - (minRun - 1) / 2) / scale, y: box.top + y / scale }
      }
    }
    return null
  }, { rgb, from, minRun })
const cardSays = () =>
  page.$$eval('.modal-backdrop .modal-head, .modal-backdrop .feature-row', (rows) => rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim()).join(' | '))
const closeCard = async () => { await page.keyboard.press('Escape'); await sleep(400) }

try {
  // -------------------------------------------------------------------------
  // Human chrX in the 1D browser
  // -------------------------------------------------------------------------
  page = await fresh()
  await page.goto(HUMAN)
  await page.waitForSelector('.browser-canvas', { timeout: 120000 })
  await fold('Show the Annotations panel')
  await allReady(5)
  await sleep(2500)
  console.log('rows:', (await rowsSay()).join('\n      '))
  await fold('Fold the Annotations panel')
  await sleep(800)
  await shot('ij01-rpl10-sashimi')
  await lanesShot('ij02-rpl10-lanes')

  await goTo('chrX:153,570,001-153,640,000')
  await lanesShot('ij03-flna-rpl10-both-strands')

  await goTo('chrX')
  await sleep(2500)
  await lanesShot('ij04-whole-chrX')

  // The strongest arc of the GBR junction lane: its apex is the topmost pixel
  // of the lowest run of the lane's blue, which is below the coverage's blue.
  await goTo('chrX:153,625,301-153,629,900')
  const apex = await page.evaluate(() => {
    const canvas = document.querySelector('.browser-canvas')
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    const data = ctx.getImageData(0, 0, width, height).data
    const box = canvas.getBoundingClientRect()
    const scale = width / box.width
    const blue = (i) => Math.abs(data[i] - 0x00) < 30 && Math.abs(data[i + 1] - 0x72) < 30 && Math.abs(data[i + 2] - 0xb2) < 30
    let seen = false
    let gap = 0
    let top = null
    for (let y = height - 1; y >= 0; y--) {
      let row = null
      for (let x = Math.floor(width * 0.35); x < width; x++) if (blue((y * width + x) * 4)) { row = x; break }
      if (row !== null) { seen = true; gap = 0; top = { x: row, y } }
      else if (seen && ++gap > 20 * scale) break
    }
    return top === null ? null : { x: box.left + top.x / scale, y: box.top + top.y / scale + 1 }
  })
  console.log('apex of the strongest GBR arc:', apex)
  if (apex !== null) {
    await page.mouse.click(apex.x, apex.y)
    await sleep(1200)
    console.log('junction card:', await cardSays())
    await shot('ij05-junction-card')
    await closeCard()
  }

  // A band: the unstained q28 under RPL10, found by its colour.
  const band = await findInk([247, 247, 245], 'top', 20)
  console.log('band at:', band)
  if (band !== null) {
    await page.mouse.click(band.x, band.y)
    await sleep(1200)
    console.log('band card:', await cardSays())
    await shot('ij06-band-card')
    await closeCard()
  }

  // The Tracks card's rows for the three kinds, opened.
  await fold('Show the Annotations panel')
  for (const want of ['hg19 bands', 'GBR ERR188428', 'junctions · GBR ERR188428']) {
    const row = await rowNamed(want)
    await row.scrollIntoViewIfNeeded()
    await row.locator('.ann-more').click()
    await sleep(700)
    await row.scrollIntoViewIfNeeded()
    const file = `ij07-card-${want.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
    await row.screenshot({ path: `${OUT}/${file}.png` })
    console.log('shot', file, '·', (await row.textContent())?.replace(/\s+/g, ' ').trim().slice(0, 240))
    await row.locator('.ann-more').click()
    await sleep(400)
  }

  // Colour the GBR junctions by whether STAR's GTF knew them, at DDX3X's novel one.
  {
    const row = await rowNamed('junctions · GBR ERR188428')
    await row.locator('.ann-more').click()
    await sleep(600)
    const picker = row.locator('select').filter({ has: page.locator('option[value="annotated"]') }).first()
    await picker.selectOption('annotated')
    await sleep(800)
    await row.scrollIntoViewIfNeeded()
    await row.screenshot({ path: `${OUT}/ij08-card-coloured-by-annotated.png` })
    console.log('shot ij08-card-coloured-by-annotated')
    // The typed 1–400 is RPL10's axis; DDX3X's junctions are tens of reads, so
    // this lane's is let go to the window and the other keeps the typed pair.
    await row.locator('.clip-auto').click()
    await sleep(600)
    await row.locator('.ann-more').click()
    await sleep(400)
  }
  await fold('Fold the Annotations panel')
  await goTo('chrX:41,196,001-41,212,000')
  await lanesShot('ij09-ddx3x-novel-junction')
  // The novel acceptor is three bases past the annotated one, so at the gene's
  // scale the two arcs share their pixels: the 3′ end, where they part.
  await goTo('chrX:41,205,601-41,207,000')
  await lanesShot('ij09b-ddx3x-novel-acceptor')

  // A band typed in the locus box: the hits, then the window it opens.
  {
    const input = locusBox()
    await input.click()
    await input.fill('Xq13')
    await sleep(1200)
    const hits = await page.$$eval('.browser-hit, .search-hit', (items) => items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim()).slice(0, 8))
    console.log('hits for Xq13:', hits)
    const box = await browserBox()
    await page.screenshot({ path: `${OUT}/ij10-band-search.png`, clip: { x: box.x - 20, y: box.y - 90, width: box.width + 40, height: 420 } })
    console.log('shot ij10-band-search')
    await input.press('Enter')
    await sleep(3500)
    await page.mouse.move(5, 5)
    console.log('window after Enter:', await locusBox().inputValue())
    await lanesShot('ij11-band-opened', 260)
  }

  // Whole genome: the karyotype, every sequence ticked and the window at `*`.
  await page.locator('text=show the whole genome').first().click()
  await sleep(2500)
  await goTo('*', 6000)
  console.log('window at the whole genome:', await locusBox().inputValue())
  await lanesShot('ij12-whole-genome-karyotype', 200)

  // A junctions BED dropped on the browser, as regtools writes one.
  await goTo('chrX:153,625,301-153,629,900')
  {
    const url = `${BASE}/demo/human/Geuvadis_chrX_GBR_ERR188428.junctions.bed`
    await page.evaluate(async (url) => {
      const bytes = await (await fetch(url)).arrayBuffer()
      const file = new File([bytes], url.split('/').pop(), { type: 'text/plain' })
      const target = document.querySelector('.browser-canvas')
      const transfer = new DataTransfer()
      transfer.items.add(file)
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
    }, url)
    await fold('Show the Annotations panel')
    await allReady(6)
    await sleep(2000)
    console.log('rows after the drop:', (await rowsSay()).join('\n      '))
    await fold('Fold the Annotations panel')
    await sleep(800)
    await lanesShot('ij13-regtools-bed-dropped', 760)
  }

  // The dark theme: the chrome and the Tracks card turn, the figure stays on
  // paper (§16.5) — so the whole page, with the three kinds' rows in the card.
  page = await fresh('dark')
  await page.goto(HUMAN)
  await page.waitForSelector('.browser-canvas', { timeout: 120000 })
  await fold('Show the Annotations panel')
  await allReady(5)
  await sleep(3000)
  await page.mouse.move(5, 5)
  await shot('ij14-dark-theme')

  // -------------------------------------------------------------------------
  // Yeast: the karyotype and the junctions beside a map
  // -------------------------------------------------------------------------
  const session = JSON.parse(readFileSync('demo/yeast/Yeast_microC.chromosomix.json', 'utf8'))
  const tab = session.tabs[0]
  const lane = (id, kind, label, file, colour, size, placement) => ({
    id, card: 'linear', kind, label,
    source: { kind: 'remote', name: file, url: file },
    visible: true, placement,
    style: { colour, size, mode: 'area', limits: { auto: true, min: 0, max: 1 }, group: '', shape: 'element', radius: 7, opacity: 1, flip: false },
  })
  tab.tracks = [
    lane('gallery-karyotype', 'ideogram', 'karyotype', 'Yeast_cytobands.txt', '#5b6169', 36, { top: false, right: true, bottom: true, left: false }),
    ...tab.tracks.filter((track) => track.id === 'demo-genes'),
    lane('gallery-junctions', 'junctions', 'junctions', 'Yeast_RNA_junctions.SJ.out.tab', '#0072b2', 70, { top: false, right: true, bottom: true, left: false }),
  ]
  tab.state.region = 'IV:250000-650000'
  const probe = 'demo/yeast/_gallery-ideogram.chromosomix.json'
  writeFileSync(probe, JSON.stringify(session))
  try {
    page = await fresh()
    await page.goto(`${BASE}/?config=${BASE}/${probe}`)
    await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
    await sleep(9000)
    await page.mouse.move(5, 5)
    await shot('ij15-yeast-map-cen4')
    const heat = await page.locator('.heatmap-canvas').first().boundingBox()
    await page.screenshot({ path: `${OUT}/ij16-yeast-map-cen4-edges.png`, clip: { x: heat.x - 20, y: heat.y - 20, width: heat.width + 300, height: heat.height + 230 } })
    console.log('shot ij16-yeast-map-cen4-edges')
    await goTo('I:125,001-160,000', 6000)
    const map = await page.locator('.heatmap-canvas').first().boundingBox()
    await page.screenshot({ path: `${OUT}/ij17-yeast-chrI-efb1-junctions.png`, clip: { x: map.x - 20, y: map.y - 20, width: map.width + 300, height: map.height + 230 } })
    console.log('shot ij17-yeast-chrI-efb1-junctions')
  } finally {
    rmSync(probe, { force: true })
  }
} catch (err) {
  console.error('FAILED', err)
  if (page !== null) await page.screenshot({ path: `${OUT}/ij-failed.png` }).catch(() => {})
}

console.log('errors:', errors.length === 0 ? 'none' : errors.slice(0, 10))
await browser.close()
