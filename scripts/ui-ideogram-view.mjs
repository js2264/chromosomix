/**
 * Drive the ideogram view (§5.10) in headless Chromium and write what each state
 * looks like, every page opened with the dev features asked for (`?dev`, §29).
 *
 * The yeast tracks demo, from a session this script writes to `demo/yeast/` and
 * removes: the karyotype from `Yeast_cytobands.txt`, ATAC as an area, Pol II
 * over input as a line, MNase as a heatmap, the micro-C loops (one
 * chromosome's own pairs) and a file of pairs between the centromeres (written
 * beside it — yeast centromeres cluster at the spindle pole, so these are the
 * trans contacts every yeast Hi-C map shows); the ATAC peaks and the genes
 * open but hidden, there to colour by; and three of the reader's marks: a
 * line, a box and an arrowhead between two chromosomes. Then: the browser with
 * the switch in its Tracks card's `picture` row; the switch pressed, the
 * chromosomes standing in a row with their lanes beside them; the pointer on
 * chromosome IV — the hairline across it and the card — and close up; the
 * Tracks card with the ideogram's rows; the view flipped, lying in one
 * column; coloured by ATAC, with its scale in the corner, and by the ATAC
 * peaks; wider and further apart; four sequences ticked on the Sequences card,
 * and the whole genome again; a drag along IV in the air, and the 1D browser
 * it gives back on that stretch; Back, and a click on XII giving it back whole;
 * the figure saved as a PNG through a stand-in save dialog, and coloured by
 * ATAC as a PDF. Then the yeast micro-C map: the switch in the map's Tracks
 * card, pressed — the map put down and the one ticked chromosome drawn — the
 * whole genome, a click on VII giving the **map** back on VII; Back, and the
 * ideogram of what the Sequences card holds now — VII, which the map ticked —
 * a drag along it giving the map back on that stretch, Back and the switch off
 * giving it back where it was. Then the human demo's chrX alone and its whole
 * karyotype, and the
 * dark theme. Then the camera, `iz…`: the wheel over IV magnifying it in
 * steps — the neighbours leaving the window, the names held at its top — IV
 * coloured by ATAC close up, with the colour scale in the corner and no box
 * round it, a drag moving the picture, a sideways scroll, Shift-drag choosing a
 * stretch while magnified, the figure saved as the window frames it, the wheel
 * back to every chromosome whole, the lying picture magnified about VII, and
 * the human karyotype magnified about chromosome 7. Prints what each step
 * found: the hash, the summary, the card's rows, the readout, the
 * magnification and the cursor.
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

/** A window with a save dialog that keeps the bytes; the dev features are asked for by each address (`?dev`, §29). */
async function fresh(scheme = 'light') {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: scheme })
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
/** The Tracks card on screen — the browser's, or the map's — which carries the ideogram's switch and rows. */
const tracksCard = () => page.locator('.controls-card:visible').filter({ has: page.locator('.controls-title', { hasText: /^Tracks$/ }) }).first()
const ideogramSwitch = () => tracksCard().locator('button[title^="Ideogram"]').first()
const flipSwitch = () => tracksCard().locator('button[title^="Flip"]').first()
const colourBy = () => tracksCard().locator('select[title="What a chromosome is filled with"]').first()
const widthBox = () => tracksCard().locator('input[title="How thick a chromosome is drawn"]').first()
const gapBox = () => tracksCard().locator('input[title="The room between two chromosomes"]').first()
/** A sequence's tick on the Sequences card, by its exact name. */
const tick = (name) =>
  page.locator('.seq-row').filter({ has: page.locator('.seq-name', { hasText: new RegExp(`^\\s*${name}\\s*$`) }) }).locator('.seq-tick').first()
const wholeGenome = () => page.locator('.seq-all:visible').first()
const placed = () => page.evaluate(() => JSON.parse(document.querySelector('.view-browser')?.dataset.karyotype ?? '[]').map((place) => place.contig).join(' '))
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
/** The wheel, turned over a point: negative towards the reader, magnifying. */
const wheel = async (point, deltaY, times = 1, deltaX = 0) => {
  await page.mouse.move(point.x, point.y)
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(deltaX, deltaY)
    await sleep(60)
  }
}
const zoomOf = () => page.evaluate(() => document.querySelector('.view-browser')?.dataset.karyotypeZoom ?? '')
const cursor = () => page.evaluate(() => getComputedStyle(document.querySelector('.browser-canvas')).cursor)
const inWindow = () =>
  page.evaluate(() =>
    JSON.parse(document.querySelector('.view-browser')?.dataset.karyotype ?? '[]')
      .filter((place) => place.visible)
      .map((place) => place.contig)
      .join(' '),
  )
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
  await page.goto(`${BASE}/?dev&config=${BASE}/${probe}`)
  await page.waitForSelector('.browser-canvas', { timeout: 120000 })
  await fold('Show the Annotations panel')
  await allReady(8)
  await fold('Fold the Annotations panel')
  await sleep(2500)
  await page.mouse.move(5, 5)
  await shot('iv01-browser-switch-in-the-tracks-card')
  console.log('switch:', await ideogramSwitch().getAttribute('title'), '· pressed', await ideogramSwitch().getAttribute('aria-pressed'))
  console.log('a switch in the bar:', await page.locator('.browser-bar button[title^="Ideogram"]').count())

  // The switch, pressed: the ideogram, standing, of the whole genome (nothing ticked).
  await ideogramSwitch().click()
  await sleep(5000)
  await page.mouse.move(5, 5)
  console.log('hash:', await hash())
  console.log('summary:', await summary())
  console.log('drawn:', await placed())
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

  // The Tracks card, with the ideogram's rows in it.
  await tracksCard().screenshot({ path: `${OUT}/iv05-tracks-card-in-the-ideogram.png` })
  console.log('shot iv05-tracks-card-in-the-ideogram')
  console.log('cards:', await page.locator('.controls-card:visible .controls-title').allTextContents())
  console.log('colour by:', await colourBy().evaluate((s) => [...s.options].map((o) => o.text).join(' | ')))

  // Flipped: lying in one column, tracks above each.
  await flipSwitch().click()
  await sleep(4000)
  console.log('flipped hash:', await hash())
  await shot('iv06-ideogram-lying')
  await page.locator('.browser-canvas').first().screenshot({ path: `${OUT}/iv07-lying-canvas.png` })
  console.log('shot iv07-lying-canvas')
  await flipSwitch().click()
  await sleep(3500)
  await page.mouse.move(5, 5)

  // Coloured by ATAC, then by its peaks.
  await colourBy().selectOption({ label: 'ATAC' })
  await sleep(3500)
  console.log('coloured:', await summary())
  await shot('iv08-coloured-by-atac')
  await colourBy().selectOption({ label: 'ATAC peaks' })
  await sleep(3500)
  await shot('iv09-coloured-by-peaks')
  await colourBy().selectOption({ label: 'bands' })
  await sleep(1500)

  // Wider and further apart.
  await widthBox().fill('20')
  await widthBox().press('Enter')
  await gapBox().fill('24')
  await gapBox().press('Enter')
  await sleep(3000)
  await page.mouse.move(5, 5)
  await shot('iv10-wider-further-apart')
  await widthBox().fill('12')
  await widthBox().press('Enter')
  await gapBox().fill('14')
  await gapBox().press('Enter')
  await sleep(2500)

  // Four sequences ticked on the Sequences card: the ideogram draws those.
  for (const name of ['I', 'III', 'V', 'VII']) {
    await tick(name).click()
    await sleep(400)
  }
  await sleep(3000)
  await page.mouse.move(5, 5)
  console.log('ticked:', await summary(), '·', await placed())
  await shot('iv11-four-ticked')
  await wholeGenome().click()
  await sleep(3500)
  console.log('whole genome again:', await placed())

  // A drag along IV, in the air, and the 1D browser it gives back.
  const from = await pointOf('IV', 0.3)
  const to = await pointOf('IV', 0.45)
  if (from !== null && to !== null) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, (from.y + to.y) / 2, { steps: 5 })
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await sleep(500)
    await shot('iv12-drag-along-iv')
    await page.mouse.up()
    await sleep(4000)
    await page.mouse.move(5, 5)
    console.log('after the drag:', await hash())
    await shot('iv13-the-stretch-in-the-browser')
  }

  // Back to the ideogram, and a click on XII giving it back whole.
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
    await shot('iv14-xii-whole-in-the-browser')
  }

  // The figure, saved as a PNG…
  await page.goBack()
  await sleep(4000)
  await exportCard().locator('select.select-format').selectOption('png')
  await exportCard().locator('select.select-dpi').selectOption('150')
  await saveAs('iv15-figure')
  // …and as a PDF, coloured by ATAC, so the scale in the key's corner goes onto the vector page too.
  await colourBy().selectOption({ label: 'ATAC' })
  await sleep(3000)
  await exportCard().locator('select.select-format').selectOption('pdf')
  await saveAs('iv16-figure-coloured-by-atac', 'pdf')
  await colourBy().selectOption({ label: 'bands' })
  await sleep(1000)

  // -------------------------------------------------------------------------
  // The camera: the wheel magnifies about the pointer, a drag moves
  // -------------------------------------------------------------------------
  await page.mouse.move(5, 5)
  await sleep(1500)
  const atIv = await pointOf('IV', 0.62)
  if (atIv !== null) {
    console.log('rest:', await zoomOf(), '· in the window:', await inWindow(), '· cursor on IV', await (async () => {
      await page.mouse.move(atIv.x, atIv.y)
      await sleep(300)
      return cursor()
    })())
    await wheel(atIv, -100, 3)
    await sleep(3000)
    console.log('three notches:', await zoomOf(), '· in the window:', await inWindow(), '· cursor', await cursor(), '·', await summary())
    await shot('iz01-three-notches-over-iv')
    await wheel(atIv, -100, 5)
    await sleep(3000)
    console.log('eight notches:', await zoomOf(), '· in the window:', await inWindow())
    console.log('card:', await tip())
    await shot('iz02-eight-notches-iv-and-its-neighbours-leaving')
    await wheel(atIv, -100, 6)
    await sleep(3500)
    console.log('fourteen notches:', await zoomOf(), '· in the window:', await inWindow(), '·', await summary())
    await shot('iz03-fourteen-notches-iv-fills-the-window')

    // Coloured by ATAC, close up: the fill read at the resolution it is drawn at, the scale unboxed.
    await colourBy().selectOption({ label: 'ATAC' })
    await sleep(3500)
    await page.mouse.move(atIv.x, atIv.y)
    await sleep(500)
    await shot('iz04-iv-coloured-by-atac-close-up')
    await page.screenshot({ path: `${OUT}/iz05-the-colour-scale-unboxed.png`, clip: { x: 1060, y: 205, width: 240, height: 70 } })
    console.log('shot iz05-the-colour-scale-unboxed')
    await colourBy().selectOption({ label: 'bands' })
    await sleep(2500)

    // A drag moves the picture: the hand closed while it is held.
    await page.mouse.move(atIv.x, atIv.y)
    await page.mouse.down()
    await page.mouse.move(atIv.x - 120, atIv.y - 160, { steps: 6 })
    await sleep(400)
    console.log('cursor while dragging:', await cursor())
    await shot('iz06-a-drag-moves-the-picture')
    await page.mouse.up()
    await sleep(3000)
    console.log('after the drag:', await zoomOf(), '· in the window:', await inWindow(), '·', await hash())

    // A sideways scroll moves the chromosomes left and right.
    await wheel(atIv, 0, 4, -90)
    await sleep(3000)
    await page.mouse.move(atIv.x, atIv.y + 20)
    await sleep(500)
    console.log('after the sideways scroll:', await inWindow())
    await shot('iz07-a-sideways-scroll')

    // Shift-drag along IV, magnified: a stretch, opened in the browser.
    const s0 = await pointOf('IV', 0.6)
    const s1 = await pointOf('IV', 0.64)
    if (s0 !== null && s1 !== null) {
      await page.keyboard.down('Shift')
      await page.mouse.move(s0.x, s0.y)
      await page.mouse.down()
      await page.mouse.move(s1.x, (s0.y + s1.y) / 2, { steps: 4 })
      await page.mouse.move(s1.x, s1.y, { steps: 4 })
      await sleep(400)
      await shot('iz08-shift-drag-chooses-a-stretch')
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await sleep(4000)
      await page.mouse.move(5, 5)
      console.log('after the shift-drag:', await hash())
      await shot('iz09-the-stretch-in-the-browser')
      await page.goBack()
      await sleep(4000)
      console.log('back:', await zoomOf(), '·', await hash())
    }

    // Magnified again, and saved as the window frames it.
    const again = await pointOf('IV', 0.62)
    if (again !== null) {
      await wheel(again, -100, 10)
      await sleep(3500)
      await page.mouse.move(5, 5)
      await exportCard().locator('select.select-format').selectOption('png')
      await saveAs('iz10-figure-of-the-window')
      // The zoom bar's buttons over the ideogram, and the wheel back to every chromosome whole.
      console.log('zoom buttons:', await page.locator('.zoom-steps button').evaluateAll((nodes) => nodes.map((node) => `${node.disabled ? 'off' : 'on'}: ${node.title}`).join(' | ')))
      await wheel(again, 100, 40)
      await sleep(3000)
      await page.mouse.move(5, 5)
      console.log('wheel back:', await zoomOf(), '· in the window:', await inWindow())
      console.log('zoom buttons at rest:', await page.locator('.zoom-steps button').evaluateAll((nodes) => nodes.map((node) => (node.disabled ? 'off' : 'on')).join(' ')))
      await shot('iz11-back-to-every-chromosome-whole')
    }

    // Lying, magnified about VII.
    await flipSwitch().click()
    await sleep(3500)
    const lying = await pointOf('VII', 0.4)
    if (lying !== null) {
      await wheel(lying, -100, 9)
      await sleep(3500)
      await page.mouse.move(lying.x, lying.y)
      await sleep(500)
      console.log('lying, magnified:', await zoomOf(), '· in the window:', await inWindow())
      await shot('iz12-lying-magnified-about-vii')
    }
    await flipSwitch().click()
    await sleep(2500)
  }
} finally {
  rmSync(probe, { force: true })
  rmSync(transFile, { force: true })
}

// ---------------------------------------------------------------------------
// Over a map: the switch in its Tracks card, and the map given back
// ---------------------------------------------------------------------------
page = await fresh()
await page.goto(`${BASE}/?dev&config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(8000)
await page.mouse.move(5, 5)
await shot('iv17-the-map-and-its-tracks-card')
console.log('map switch:', await ideogramSwitch().getAttribute('title'))
await ideogramSwitch().click()
await sleep(6000)
await page.mouse.move(5, 5)
console.log('over the map:', await hash(), '·', await summary(), '·', await placed())
await shot('iv18-over-the-map-the-ticked-chromosome')
await wholeGenome().click()
await sleep(5000)
await page.mouse.move(5, 5)
console.log('whole genome:', await placed())
await shot('iv19-over-the-map-the-whole-genome')
const vii = await pointOf('VII', 0.5)
if (vii !== null) {
  await page.mouse.click(vii.x, vii.y)
  await sleep(7000)
  await page.mouse.move(5, 5)
  console.log('after the click on VII:', await hash())
  await shot('iv20-click-on-vii-gives-the-map-back')
}
await page.goBack()
await sleep(6000)
await page.mouse.move(5, 5)
// Back on the ideogram, of what the Sequences card holds now: the map ticked VII.
console.log('back:', await hash(), '·', await summary(), '·', await placed())
await shot('iv21-back-the-ideogram-of-the-ticked-chromosome')
const s0 = await pointOf('VII', 0.25)
const s1 = await pointOf('VII', 0.5)
if (s0 !== null && s1 !== null) {
  await page.mouse.move(s0.x, s0.y)
  await page.mouse.down()
  await page.mouse.move((s0.x + s1.x) / 2, s1.y, { steps: 5 })
  await page.mouse.move(s1.x, s1.y, { steps: 5 })
  await sleep(400)
  await page.mouse.up()
  await sleep(7000)
  await page.mouse.move(5, 5)
  console.log('after the drag along VII:', await hash())
  await shot('iv22-drag-along-vii-gives-the-map-back')
}
await page.goBack()
await sleep(6000)
console.log('back again:', await hash())
await ideogramSwitch().click()
await sleep(6000)
await page.mouse.move(5, 5)
console.log('switched off:', await hash())
await shot('iv23-the-switch-off-gives-the-map-back-where-it-was')

// ---------------------------------------------------------------------------
// The human karyotype, and the dark theme
// ---------------------------------------------------------------------------
page = await fresh()
await page.goto(`${BASE}/?dev&config=${BASE}/demo/human/Human_chrX_RNA.chromosomix.json`)
await page.waitForSelector('.browser-canvas', { timeout: 120000 })
await sleep(6000)
await ideogramSwitch().click()
await sleep(6000)
await page.mouse.move(5, 5)
console.log('human, chrX ticked:', await summary(), '·', await placed())
await shot('iv24-human-chrx-ticked')
await wholeGenome().click()
await sleep(6000)
await page.mouse.move(5, 5)
console.log('human, whole genome:', await summary())
await shot('iv25-human-karyotype')
// The human karyotype magnified about chromosome 7: its neighbours leave the window on either side.
const chr7 = await pointOf('chr7', 0.45)
if (chr7 !== null) {
  await wheel(chr7, -100, 6)
  await sleep(4000)
  await page.mouse.move(chr7.x, chr7.y)
  await sleep(500)
  console.log('human, magnified:', await zoomOf(), '· in the window:', await inWindow())
  await shot('iz13-human-magnified-about-chr7')
  await wheel(chr7, -100, 8)
  await sleep(4000)
  await page.mouse.move(chr7.x, chr7.y)
  await sleep(500)
  console.log('human, closer:', await zoomOf(), '· in the window:', await inWindow(), '·', await tip())
  await shot('iz14-human-chr7-close')
}

page = await fresh('dark')
await page.goto(`${BASE}/?dev&config=${BASE}/demo/human/Human_chrX_RNA.chromosomix.json`)
await page.waitForSelector('.browser-canvas', { timeout: 120000 })
await sleep(6000)
await wholeGenome().click()
await sleep(2000)
await ideogramSwitch().click()
await sleep(6000)
await page.mouse.move(5, 5)
await shot('iv26-dark-theme')

console.log('errors:', errors.length === 0 ? 'none' : errors.slice(0, 10))
await browser.close()
