/**
 * Drive the ideogram view (§5.10) in headless Chromium and write what each state
 * looks like.
 *
 * The yeast tracks demo, from a session this script writes to `demo/yeast/` and
 * removes: the karyotype from `Yeast_cytobands.txt`, ATAC as an area, Pol II
 * over input as a line, MNase as a heatmap, the micro-C loops (one
 * chromosome's own pairs) and a file of pairs between the centromeres (written
 * beside it — yeast centromeres cluster at the spindle pole, so these are the
 * trans contacts every yeast Hi-C map shows); the ATAC peaks and the genes
 * open but hidden, there to colour by; and three of the reader's marks: a
 * line, a box and an arrowhead between two chromosomes. Then: the browser as
 * it opens, with the switch in its bar; `z`, the chromosomes standing in a row
 * with their lanes beside them; the pointer on chromosome IV — the hairline
 * across it and the card — and close up; the Ideogram card; the view flipped,
 * lying in one column; coloured by ATAC, with its scale in the corner, and by
 * the ATAC peaks; wider and further apart; a drag along IV in the air, and the
 * browser it opens on that stretch; Back, and a click on XII opening it whole;
 * the figure saved as a PNG through a stand-in save dialog, and coloured by
 * ATAC as a PDF. Then the
 * human demo's hg19 karyotype; the yeast micro-C map with `z` putting the map
 * down and `v` bringing it back; and the dark theme. Prints what each step
 * found: the hash, the card's rows, the key, the readout.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-ideogram-view.mjs [out-dir]
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

/** A window with the dev features on (§29) and a save dialog that keeps the bytes. */
async function fresh(scheme = 'light') {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: scheme })
  await context.addInitScript(() => {
    window.localStorage.setItem('chromosomix:dev-features', 'on')
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
const hash = () => page.evaluate(() => decodeURIComponent(location.hash))
const canvasBox = () => page.locator('.browser-canvas').first().boundingBox()
const card = () => page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Ideogram$/ }) }).first()
const exportCard = () => page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()
const readout = () => page.evaluate(() => document.querySelector('.status-readout, .readout')?.textContent?.trim() ?? '')
const tip = () => page.evaluate(() => {
  const node = document.querySelector('.view-browser .cell-tip')
  return node === null || node.classList.contains('hidden') ? '(hidden)' : node.textContent?.replace(/\s+/g, ' ').trim()
})
const summary = () => page.evaluate(() => document.querySelector('.view-browser .summary')?.textContent?.trim() ?? '')
/** Where on the canvas a chromosome's name is written, from the picture: the first row of ink under it. */
const allReady = (n) =>
  page.waitForFunction(
    (count) => {
      const rows = [...document.querySelectorAll('.annotation-card .ann-row')]
      return rows.length >= count && rows.every((row) => !/reading|loading|reopening/i.test(row.textContent ?? ''))
    },
    n,
    { timeout: 180000 },
  )
/** The canvas point of a base pair on a standing chromosome, by the layout the page exposes for tests. */
const pointOf = (contig, fraction) =>
  page.evaluate(({ contig, fraction }) => {
    const view = document.querySelector('.view-browser')
    const places = JSON.parse(view?.dataset.karyotype ?? '[]')
    const place = places.find((each) => each.contig === contig)
    if (place === undefined) return null
    const canvas = document.querySelector('.browser-canvas').getBoundingClientRect()
    const along = place.along0 + (place.along1 - place.along0) * fraction
    return place.vertical
      ? { x: canvas.left + place.body, y: canvas.top + along }
      : { x: canvas.left + along, y: canvas.top + place.body }
  }, { contig, fraction })
const saveAs = async (name, extension = 'png') => {
  const before = await page.evaluate(() => window.__files.length)
  await exportCard().locator('.export-acts button').first().click()
  await page.waitForFunction((n) => window.__files.length > n, before, { timeout: 120000 })
  const file = await page.evaluate(() => window.__files.at(-1))
  writeFileSync(`${OUT}/${name}.${extension}`, Buffer.from(file.b64, 'base64'))
  console.log('saved', name, `(${file.name})`)
}

// ---------------------------------------------------------------------------
// The session: the yeast tracks, a karyotype, cis and trans pairs, three marks
// ---------------------------------------------------------------------------
const cens = new Map()
for (const line of readFileSync('demo/yeast/Yeast_cytobands.txt', 'utf8').split('\n')) {
  const [chrom, start, end, name, stain] = line.split('\t')
  if (stain === 'acen' && name === 'p11') cens.set(chrom, [Number(start), Number(end)])
}
const names = [...cens.keys()]
const transRows = []
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const [a0] = cens.get(names[i])
    const [b0] = cens.get(names[j])
    transRows.push([names[i], a0 - 5000, a0 + 5000, names[j], b0 - 5000, b0 + 5000, `cen_${names[i]}_${names[j]}`, 10 + ((i * 7 + j * 3) % 20)].join('\t'))
  }
}
const transFile = 'demo/yeast/_gallery-centromeres.bedpe'
writeFileSync(transFile, `${transRows.join('\n')}\n`)
const style = (colour, size, mode = 'area', extra = {}) => ({
  colour, size, mode, limits: { auto: true, min: 0, max: 1 }, group: '', shape: 'element', radius: 7, opacity: 1, flip: false, ...extra,
})
const track = (id, kind, label, file, colour, size, mode, extra, visible = true) => ({
  id, card: 'linear', kind, label,
  source: { kind: 'remote', name: file, url: file },
  visible, placement: { bottom: true, right: false },
  style: style(colour, size, mode, extra),
})
const session = {
  kind: 'chromosomix.workspace',
  version: 1,
  createdAt: '2026-10-19T00:00:00.000Z',
  active: 0,
  tabs: [
    {
      version: 1,
      createdAt: '2026-10-19T00:00:00.000Z',
      name: 'Yeast, ideogram',
      state: { uri: 'Yeast_ATAC.bw', view: 'browser', locus: 'IV:1,246,215-1,295,987' },
      tracks: [
        track('iv-karyotype', 'ideogram', 'karyotype', 'Yeast_cytobands.txt', '#5b6169', 40, 'area'),
        // A ceiling under the rDNA's pile-up, as a reader sets one: the whole
        // genome autoscaled is one spike and a flat line, in the lane and on a
        // chromosome coloured by it.
        track('iv-atac', 'track', 'ATAC', 'Yeast_ATAC.bw', '#d55e00', 60, 'area', { limits: { auto: false, min: 0, max: 40 } }),
        track('iv-pol2', 'track', 'Pol II / input', 'Yeast_ChIP_Pol2-vs-input.bw', '#009e73', 50, 'line'),
        track('iv-mnase', 'track', 'MNase', 'Yeast_MNase.bw', '#0072b2', 30, 'heatmap'),
        track('iv-peaks', 'segments', 'ATAC peaks', 'Yeast_ATAC.narrowPeak', '#d55e00', 26, 'area', {}, false),
        track('iv-genes', 'gtf', 'genes', 'Yeast_annotations.gtf', '#5b6169', 40, 'area', {}, false),
        track('iv-loops', 'pairs', 'loops', 'Yeast_microC_loops.tsv', '#cc79a7', 40, 'area'),
        track('iv-cens', 'pairs', 'centromeres', '_gallery-centromeres.bedpe', '#7b3fb0', 30, 'area'),
      ],
      manual: [
        { id: 'm-line', kind: 'line', axis: 'vertical', at: { contig: 'XII', bp: 460000 }, colour: '#c0392b' },
        { id: 'm-box', kind: 'rect', a: { contig: 'IV', from: 900000, to: 1200000 }, b: { contig: 'IV', from: 900000, to: 1200000 }, colour: '#1f5fa9' },
        { id: 'm-arrow', kind: 'arrowhead', a: { contig: 'VII', bp: 800000 }, b: { contig: 'XV', bp: 300000 }, colour: '#111318' },
      ],
      bookmarks: [],
      sequences: [],
      groups: {},
      scaling: {},
      tables: {},
      plot: { text: true, fills: true, baseline: true, outline: false, gutter: true, crosshair: true, dividers: false, breaks: true, labels: false, ticks: true },
    },
  ],
}
const probe = 'demo/yeast/_gallery-ideogram-view.chromosomix.json'
writeFileSync(probe, JSON.stringify(session))

try {
  page = await fresh()
  await page.goto(`${BASE}/?config=${BASE}/${probe}`)
  await page.waitForSelector('.browser-canvas', { timeout: 120000 })
  await fold('Show the Annotations panel')
  await allReady(8)
  await fold('Fold the Annotations panel')
  await sleep(2500)
  await page.mouse.move(5, 5)
  await shot('iv01-browser-with-the-switch')
  const toggle = page.locator('.browser-bar button[aria-pressed]').last()
  console.log('switch:', await toggle.getAttribute('title'), '· pressed', await toggle.getAttribute('aria-pressed'))

  // z: the ideogram, standing.
  await page.locator('.browser-canvas').first().click({ position: { x: 600, y: 600 } })
  await page.keyboard.press('z')
  await sleep(5000)
  await page.mouse.move(5, 5)
  console.log('hash:', await hash())
  console.log('summary:', await summary())
  await shot('iv02-ideogram-standing')

  // The pointer on IV: the hairline across it and its lanes, and the card.
  const iv = await pointOf('IV', 0.62)
  if (iv !== null) {
    await page.mouse.move(iv.x, iv.y)
    await sleep(700)
    console.log('card on IV:', await tip())
    await shot('iv03-hover-iv')
    await page.screenshot({ path: `${OUT}/iv04-hover-iv-close.png`, clip: { x: iv.x - 160, y: iv.y - 140, width: 520, height: 300 } })
    console.log('shot iv04-hover-iv-close')
  }
  await page.mouse.move(5, 5)

  // The Ideogram card.
  await card().screenshot({ path: `${OUT}/iv05-ideogram-card.png` })
  console.log('shot iv05-ideogram-card')
  console.log('colour by:', await card().locator('select').first().evaluate((s) => [...s.options].map((o) => o.text).join(' | ')))

  // Flipped: lying in one column, tracks above each.
  await card().locator('button[aria-pressed]').first().click()
  await sleep(4000)
  console.log('flipped hash:', await hash())
  await shot('iv06-ideogram-lying')
  await page.locator('.browser-canvas').first().screenshot({ path: `${OUT}/iv07-lying-canvas.png` })
  console.log('shot iv07-lying-canvas')
  await card().locator('button[aria-pressed]').first().click()
  await sleep(3500)
  await page.mouse.move(5, 5)

  // Coloured by ATAC, then by its peaks.
  await card().locator('select').first().selectOption({ label: 'ATAC' })
  await sleep(3500)
  console.log('coloured:', await summary())
  await shot('iv08-coloured-by-atac')
  await card().locator('select').first().selectOption({ label: 'ATAC peaks' })
  await sleep(3500)
  await shot('iv09-coloured-by-peaks')
  await card().locator('select').first().selectOption({ label: 'bands' })
  await sleep(1500)

  // Wider and further apart.
  const steppers = card().locator('.field-stepper input')
  await steppers.nth(0).fill('20')
  await steppers.nth(0).press('Enter')
  await steppers.nth(1).fill('24')
  await steppers.nth(1).press('Enter')
  await sleep(3000)
  await shot('iv10-wider-further-apart')
  await steppers.nth(0).fill('12')
  await steppers.nth(0).press('Enter')
  await steppers.nth(1).fill('14')
  await steppers.nth(1).press('Enter')
  await sleep(2500)

  // A drag along IV, in the air, and the browser it opens.
  const from = await pointOf('IV', 0.3)
  const to = await pointOf('IV', 0.45)
  if (from !== null && to !== null) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, (from.y + to.y) / 2, { steps: 5 })
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await sleep(500)
    await shot('iv11-drag-along-iv')
    await page.mouse.up()
    await sleep(4000)
    await page.mouse.move(5, 5)
    console.log('after the drag:', await hash())
    await shot('iv12-opened-the-stretch')
  }

  // Back to the ideogram, and a click on XII opening it whole.
  await page.goBack()
  await sleep(4000)
  console.log('back:', await hash())
  const xii = await pointOf('XII', 0.5)
  const onCanvas = xii !== null && (await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('browser-canvas') ?? false, xii))
  console.log('XII on screen:', onCanvas)
  if (xii !== null && onCanvas) {
    await page.mouse.click(xii.x, xii.y)
    await sleep(4000)
    await page.mouse.move(5, 5)
    console.log('after the click on XII:', await hash())
    await shot('iv13-opened-xii-whole')
  }

  // The figure, saved as a PNG.
  await page.goBack()
  await sleep(4000)
  await exportCard().locator('select.select-format').selectOption('png')
  await exportCard().locator('select.select-dpi').selectOption('150')
  await saveAs('iv14-figure')
  // …and as a PDF, coloured by ATAC, so the scale in the key's corner goes onto the vector page too.
  await card().locator('select').first().selectOption({ label: 'ATAC' })
  await sleep(3000)
  await exportCard().locator('select.select-format').selectOption('pdf')
  await saveAs('iv15-figure-coloured-by-atac', 'pdf')
  await card().locator('select').first().selectOption({ label: 'bands' })
  await sleep(1000)
} finally {
  rmSync(probe, { force: true })
  rmSync(transFile, { force: true })
}

// ---------------------------------------------------------------------------
// The human karyotype, a map put down by z, and the dark theme
// ---------------------------------------------------------------------------
page = await fresh()
await page.goto(`${BASE}/?config=${BASE}/demo/human/Human_chrX_RNA.chromosomix.json`)
await page.waitForSelector('.browser-canvas', { timeout: 120000 })
await sleep(6000)
await page.locator('.browser-canvas').first().click({ position: { x: 600, y: 600 } })
await page.keyboard.press('z')
await sleep(6000)
await page.mouse.move(5, 5)
console.log('human:', await summary())
await shot('iv16-human-karyotype')

page = await fresh()
await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(8000)
await page.locator('.heatmap-canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => {})
await page.keyboard.press('z')
await sleep(6000)
await page.mouse.move(5, 5)
console.log('map put down:', await hash())
await shot('iv17-map-put-down-for-the-ideogram')
await page.locator('.browser-canvas').first().click({ position: { x: 5, y: 5 } })
await page.keyboard.press('v')
await sleep(6000)
await page.mouse.move(5, 5)
console.log('v:', await hash())
await shot('iv18-v-brings-the-map-back')

page = await fresh('dark')
await page.goto(`${BASE}/?config=${BASE}/demo/human/Human_chrX_RNA.chromosomix.json`)
await page.waitForSelector('.browser-canvas', { timeout: 120000 })
await sleep(6000)
await page.locator('.browser-canvas').first().click({ position: { x: 600, y: 600 } })
await page.keyboard.press('z')
await sleep(6000)
await page.mouse.move(5, 5)
await shot('iv19-dark-theme')

console.log('errors:', errors.length === 0 ? 'none' : errors.slice(0, 10))
await browser.close()
