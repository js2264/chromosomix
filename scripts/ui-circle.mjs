/**
 * The circle of a metagenome (§7.6, dev), in headless Chromium on the mock
 * community demo: the Genomes table's `circle →` and the gate it lands on, the
 * 48 genomes drawn round with their chords, a genome hovered with its partners
 * lit and weighed, a chord hovered, the chords thinned from the Map card, two
 * tracks dropped on the Tracks card as rings — a bedGraph of Hi-C hits per kb
 * (log10) and a BED of the long contigs, both written here from the file's own
 * contig table — four metadata columns added as four more, a ring hovered, held
 * and dragged to another place with the Metadata card following, the contig ×
 * contig circle grouped by genome, the five sub-bins of one recursive bin ticked
 * and opened as a circle — cut into its genomes, then into their contigs with a
 * genome's band hovered — an arc clicked open into its genome's contigs drawn
 * round, a chord clicked open into its pair (where the toggle says why there is
 * no circle), the figure saved as a PNG and as a PDF and each written out, the
 * dark theme, the palette's command, and the dev features off. Prints what it found
 * at each step — the geometry the canvas publishes, the tooltips, the order of
 * the rings and of the Tracks card — so a picture that did not change is a line
 * in the log as well.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-circle.mjs [out-dir]     # ci01 … ci22, ci-figure.png, ci-figure.pdf, ci-figure-page.png
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import h5wasm from 'h5wasm/node'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const DEMO = 'demo/metagenomics/mock-community'
mkdirSync(OUT, { recursive: true })

// Two tracks along the community's contigs, from the file's own contig table:
// the Hi-C hits each contig holds per kb — on a log scale, since a contig of a
// few hundred bases can hold thousands per kb — and the contigs of 100 kb or more.
await h5wasm.ready
const h5 = new h5wasm.File(`${DEMO}/Mock_microbial_community.metacool`, 'r')
const contigNames = h5.get('contigs/name').value
const contigLengths = h5.get('contigs/length').value
const contigHits = h5.get('contigs/Hit').value
h5.close()
let bedGraph = 'track type=bedGraph name="Hi-C hits per kb (log10)"\n'
let bed = ''
for (let i = 0; i < contigNames.length; i++) {
  const length = Number(contigLengths[i])
  bedGraph += `${contigNames[i]}\t0\t${length}\t${Math.log10(1 + (Number(contigHits[i]) / length) * 1000).toFixed(3)}\n`
  if (length >= 100_000) bed += `${contigNames[i]}\t0\t${length}\t${contigNames[i]}\n`
}

const g = await gallery(OUT)
const { page, shot, text } = g
page.on('pageerror', (error) => console.log('page error:', String(error).slice(0, 300)))
page.on('console', (message) => { if (message.type() === 'error') console.log('console error:', message.text().slice(0, 300)) })
const where = () => page.evaluate(() => decodeURIComponent(location.hash).replace(/uri=[^&]*&?/, ''))
// The stand-in save dialog, which keeps a file's bytes whole — the PDF as well
// as the picture — so the figure itself can be written out and looked at.
await page.context().addInitScript(() => {
  window.__saves = []
  window.showSaveFilePicker = async (options) => {
    const record = { suggested: options.suggestedName, bytes: 0, data: null }
    window.__saves.push(record)
    return {
      name: options.suggestedName,
      createWritable: async () => ({
        write: async (blob) => {
          record.data = await new Promise((resolve) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result)
            reader.readAsDataURL(blob)
          })
          record.bytes = blob.size
        },
        close: async () => {},
      }),
    }
  }
})

const CONFIG = `?config=${g.base}/${DEMO}/Mock_microbial_community.chromosomix.json`
const TOGGLE = 'button[title^="Draw the map as a circle"]'

/** The geometry the canvas publishes, in page pixels; null while there is no circle. */
async function geo() {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll('.circle-canvas')].find((node) => node.getBoundingClientRect().width > 0)
    if (canvas === undefined || canvas.dataset.geometry === undefined) return null
    const box = canvas.getBoundingClientRect()
    return { left: box.left, top: box.top, width: box.width, height: box.height, ...JSON.parse(canvas.dataset.geometry) }
  })
}

/** Wait for a circle whose geometry holds still, and return it. */
async function settledCircle(timeout = 60_000) {
  const until = Date.now() + timeout
  let last = null
  while (Date.now() < until) {
    await sleep(400)
    const now = await geo()
    if (now !== null && last !== null && JSON.stringify(now) === JSON.stringify(last)) return now
    last = now
  }
  return last
}

/**
 * The pointer off the picture, and the hint under the key given time to fade.
 *
 * Moved twice and then waited on: a circle drawn in under a pointer that has
 * not moved can keep its hover through one move in headless Chromium.
 */
async function away() {
  await page.mouse.move(8, 496)
  await page.mouse.move(5, 500)
  await page
    .waitForFunction(() => ![...document.querySelectorAll('.circle-wrap')].some((node) => node.matches(':hover')), null, { timeout: 3000 })
    .catch(() => {})
  await sleep(400)
}

const point = (G, radius, angle) => ({ x: G.left + G.cx + Math.cos(angle) * radius, y: G.top + G.cy + Math.sin(angle) * radius })
const sectionOf = (G, name) => {
  const unit = G.units.find((entry) => entry.name === name) ?? G.units[0]
  return point(G, (G.sections[0] + G.sections[1]) / 2, unit.mid)
}
const describe = (G) =>
  G === null
    ? 'no circle'
    : `${G.units.length} sections · ${G.chords.toLocaleString('en-US')} of ${G.pairs.toLocaleString('en-US')} chords · ` +
      `${G.rings.length} rings${G.rings.length > 0 ? ` (${G.rings.map((ring) => ring.name).join(' | ')})` : ''}`
const tip = () => page.evaluate(() => {
  const node = document.querySelector('.circle-tip')
  return node === null || node.offsetParent === null ? null : node.innerText.replace(/\n+/g, ' / ')
})

/** Press the visible `compute …` of a gate, and wait for its circle. */
async function compute() {
  const button = page.locator('button:visible', { hasText: /^compute/ })
  if ((await button.count()) === 0) return
  console.log('gate:', (await page.locator('.overview-gate:visible, .gate:visible').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 220))
  await button.first().click()
}

async function columnOpen(key, selector, open) {
  const shown = await page.evaluate((s) => {
    const node = document.querySelector(s)
    return node !== null && node.getBoundingClientRect().width > 0
  }, selector)
  if (shown !== open) {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    await page.keyboard.press(key)
    await sleep(700)
  }
}

/** Wait for the `count`th save and write its bytes out under `name`. */
async function keep(count, name) {
  await page.waitForFunction((n) => window.__saves.length >= n && window.__saves[n - 1].bytes > 0, count, { timeout: 120_000 }).catch(() => {})
  const save = await page.evaluate((n) => window.__saves[n - 1] ?? null, count)
  if (save === null || typeof save.data !== 'string') {
    console.log(`${name}: nothing was saved`)
    return null
  }
  const path = join(OUT, name)
  writeFileSync(path, Buffer.from(save.data.slice(save.data.indexOf(',') + 1), 'base64'))
  console.log(`${name}: suggested ${save.suggested}, ${save.bytes.toLocaleString('en-US')} bytes`)
  return path
}

const exportCard = () => page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()

// ---------------------------------------------------------------------------
// The door: the Genomes table's last button, and the gate it opens on.
// ---------------------------------------------------------------------------

await g.openWithDev(CONFIG)
await page.waitForSelector('.table-toolbar', { timeout: 120_000 })
await sleep(3000)
const table = page.locator('.table').filter({ has: page.locator('.table-toolbar button', { hasText: 'circle →' }) }).first()
const circleButton = table.locator('.table-toolbar button', { hasText: 'circle →' })
console.log('circle → title, nothing ticked:', await circleButton.getAttribute('title'))
await circleButton.hover()
await sleep(300)
await shot('ci01-genomes-button')

await circleButton.click()
await sleep(2500)
console.log('hash:', decodeURIComponent(await page.evaluate(() => location.hash)).replace(/uri=[^&]*&?/, ''))
await shot('ci02-gate')
await compute()
let G = await settledCircle(90_000)
console.log('genome level:', describe(G))
console.log('key and hint:', await page.evaluate(() => document.querySelector('.circle-hint')?.textContent ?? null))
await away()
await shot('ci03-circle')

// A genome hovered: its partners lit and counted, the rest set back.
const RICH = 'metator_00002_00003'
let at = sectionOf(G, RICH)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log(`hovered ${RICH}:`, await tip())
await shot('ci04-hover-genome')

// The strongest chord hovered: its two ends lit, the rest dimmed.
const strongest = G.strongest[0]
await page.mouse.move(G.left + strongest.x, G.top + strongest.y)
await sleep(500)
console.log(`hovered the strongest chord, ${strongest.a} × ${strongest.b}:`, await tip())
await shot('ci05-hover-chord')

// Thinned from the Map card: the strongest 50.
await away()
const chords = page.locator('.controls-card.is-circle select').filter({ has: page.locator('option', { hasText: 'strongest 50' }) }).first()
await chords.selectOption({ label: 'strongest 50' })
G = await settledCircle()
console.log('strongest 50:', describe(G))
await shot('ci06-strongest-50')
await chords.selectOption({ label: 'all' })
G = await settledCircle()

// ---------------------------------------------------------------------------
// Rings: two tracks dropped on the Tracks card, then four metadata columns.
// ---------------------------------------------------------------------------

console.log('before the drop:', await where())
await columnOpen('2', '.ann-drop', true)
console.log('column open:', await where(), '·', describe(await geo()))
await page.evaluate(
  (files) => {
    const target = document.querySelector('.ann-drop')
    const transfer = new DataTransfer()
    for (const file of files) transfer.items.add(new File([file.text], file.name, { type: 'text/plain' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  },
  [
    { name: 'hits_per_kb_log10.bedgraph', text: bedGraph },
    { name: 'long_contigs.bed', text: bed },
  ],
)
await sleep(3000)
G = await settledCircle()
console.log('two tracks dropped:', describe(G), '·', await where())
await shot('ci07-track-rings')

// The Metadata card, folded until it is asked for, opened as a reader would.
await page.evaluate(() => {
  const card = document.querySelector('.metadata-card')
  if (card?.classList.contains('is-folded')) card.querySelector(':scope > .card-head')?.click()
})
await page.locator('.metadata-card').first().scrollIntoViewIfNeeded().catch(() => {})
for (const value of ['genomes/parent', 'genomes/Completeness', 'contigs/GC_content', 'genomes/HiC_abundance']) {
  const said = await page.evaluate((v) => {
    const select = document.querySelector('.metadata-card select')
    if (select === null) return 'no metadata card'
    if (![...select.options].some((option) => option.value === v)) return `no ${v}`
    select.value = v
    select.dispatchEvent(new Event('change', { bubbles: true }))
    ;[...document.querySelectorAll('.metadata-card button')].find((b) => b.textContent?.trim() === 'add')?.click()
    return 'added'
  }, value)
  console.log(`  ${value}: ${said}`)
  await sleep(500)
}
G = await settledCircle()
console.log('with metadata:', describe(G))
await shot('ci08-metadata-rings')
await columnOpen('2', '.ann-drop', false)
G = await settledCircle()
await away()
await shot('ci09-rings')

// A ring hovered: its name, the place and the value there.
const gc = G.rings.find((ring) => ring.id.includes('GC_content')) ?? G.rings[0]
at = point(G, (gc.inner + gc.outer) / 2, 0.35)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log('ring hovered:', await tip())
await shot('ci10-ring-hover')

// The outermost ring held and carried in, past two others, then let go.
const order = (G) => G.rings.map((ring) => ring.name).join(' | ')
console.log('rings before:', order(G))
const outer = G.rings[G.rings.length - 1]
const target = G.rings[Math.max(0, G.rings.length - 4)]
const from = point(G, (outer.inner + outer.outer) / 2, 0.95)
const to = point(G, (target.inner + target.outer) / 2 - 1, 0.95)
await page.mouse.move(from.x, from.y)
await page.mouse.down()
for (let k = 1; k <= 16; k++) {
  await page.mouse.move(from.x + ((to.x - from.x) * k) / 16, from.y + ((to.y - from.y) * k) / 16)
  await sleep(35)
}
await sleep(400)
await shot('ci11-ring-held')
await page.mouse.up()
G = await settledCircle()
console.log('rings after: ', order(G))
await columnOpen('2', '.ann-drop', true)
await sleep(400)
console.log(
  'Tracks and Metadata cards:',
  await page.evaluate(() => [...document.querySelectorAll('.ann-row .ann-name, .metadata-card .ann-name')].map((node) => node.value || node.textContent?.trim()).join(' | ')),
)
// The Metadata card's rows, which moved with the ring.
await page.locator('.metadata-card').first().scrollIntoViewIfNeeded().catch(() => {})
await away()
await shot('ci12-ring-dropped')
await columnOpen('2', '.ann-drop', false)

// ---------------------------------------------------------------------------
// The contig × contig circle, grouped by genome under a band.
// ---------------------------------------------------------------------------

const level = page.locator('select:visible').filter({ has: page.locator('option', { hasText: 'contig × contig' }) }).first()
await level.selectOption({ label: 'contig × contig' })
await sleep(1500)
await compute()
G = await settledCircle(120_000)
console.log('contig level:', describe(G), `· ${G.withinGenome} of the chords drawn within one genome`)
await away()
await shot('ci13-contig-level')
at = sectionOf(G, G.units[Math.floor(G.units.length * 0.12)].name)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log('contig hovered:', await tip())
await shot('ci14-contig-hover')

// ---------------------------------------------------------------------------
// A subset: the five sub-bins of one recursive bin, ticked and opened — cut
// into its genomes, then into their contigs.
// ---------------------------------------------------------------------------

await page.evaluate(() => { location.hash = location.hash.replace(/view=[^&]*/, 'view=genomes') })
await page.waitForSelector('.table-toolbar', { timeout: 60_000 })
await sleep(1500)
const filter = table.locator('.table-toolbar input').first()
await filter.fill('metator_00002_')
await sleep(800)
const ticks = table.locator('.tbody .tcheck')
const count = await ticks.count()
for (let i = 0; i < count; i++) await ticks.nth(i).check()
console.log(`ticked ${count}; circle → title:`, await circleButton.getAttribute('title'))
await circleButton.click()
await sleep(2000)
await compute()
G = await settledCircle(90_000)
const selection = await where()
console.log('selection:', describe(G), '·', selection)
await away()
await shot('ci15-selection')

const sections = page.locator('.controls-card.is-circle select').filter({ has: page.locator('option[value="contigs"]') }).first()
await sections.selectOption('contigs')
G = await settledCircle()
console.log('cut into contigs:', describe(G), `· ${G.withinGenome} of the chords drawn within one genome ·`, await where())
await away()
await shot('ci16-selection-contigs')

// A genome's band hovered: the chords that leave it, and nothing else.
const BAND = 'metator_00002_00003'
const group = G.groups.find((entry) => entry.name === BAND) ?? G.groups[0]
at = point(G, (G.band[0] + G.band[1]) / 2, group.mid)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log(`band of ${group.name} hovered:`, await tip())
await shot('ci17-band-hover')

// ---------------------------------------------------------------------------
// Clicks that open: a band into its genome, a chord into its pair.
// ---------------------------------------------------------------------------

await page.mouse.click(at.x, at.y)
await sleep(2500)
G = await settledCircle(90_000)
console.log(`clicked the band of ${group.name}:`, (await page.locator('.breadcrumb').innerText()).replace(/\s+/g, ' '), '·', describe(G))
await away()
await shot('ci18-genome-opened')

await page.evaluate((hash) => { location.hash = `${location.hash.match(/uri=[^&]*/)[0]}&${hash.replace(/^#/, '').replace(/&sections=contigs/, '')}` }, selection)
await sleep(2500)
await compute()
G = await settledCircle(90_000)
console.log('back at the selection, genomes cut:', describe(G))
const chord = G.strongest[0]
await page.mouse.click(G.left + chord.x, G.top + chord.y)
await sleep(4000)
console.log(`clicked the chord ${chord.a} × ${chord.b}:`, (await page.locator('.breadcrumb').innerText()).replace(/\s+/g, ' '))
console.log(
  'the toggle on the pair:',
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.controls-card button[aria-pressed]')].find((node) => node.querySelector('svg') !== null && /circle|rectangle|diagonal to draw round/.test(node.title))
    return button === undefined ? 'none' : { disabled: button.disabled, pressed: button.getAttribute('aria-pressed'), title: button.title }
  }),
)
await shot('ci19-chord-opened')

// ---------------------------------------------------------------------------
// The figure, saved: a PNG and a PDF of the whole metagenome's circle.
// ---------------------------------------------------------------------------

await page.evaluate(() => { location.hash = `${location.hash.match(/uri=[^&]*/)[0]}&view=overview&level=genome&circle=true` })
await sleep(2500)
await compute()
G = await settledCircle(90_000)
console.log('back at the genomes:', describe(G))
const card = exportCard()
await card.scrollIntoViewIfNeeded()
await card.locator('.select-format').selectOption('png')
await sleep(300)
await card.locator('.export-acts button').first().click()
const png = await keep(1, 'ci-figure.png')
await card.locator('.select-format').selectOption('pdf')
await sleep(300)
await card.locator('.export-acts button').first().click()
const pdf = await keep(2, 'ci-figure.pdf')
if (png !== null) console.log('figure:', execFileSync('file', [png]).toString().trim())
if (pdf !== null) {
  try {
    const images = execFileSync('pdfimages', ['-list', pdf]).toString().trim().split('\n').slice(2)
    console.log(`  images in the PDF: ${images.length} (all paths and text where 0)`)
    console.log('  its text:', execFileSync('pdftotext', ['-layout', pdf, '-']).toString().replace(/\s+/g, ' ').trim().slice(0, 240))
    execFileSync('pdftoppm', ['-png', '-r', '110', '-singlefile', pdf, join(OUT, 'ci-figure-page')])
    console.log('  wrote ci-figure-page.png')
  } catch (error) {
    console.log(`  (poppler not available: ${String(error).split('\n')[0]})`)
  }
}

// ---------------------------------------------------------------------------
// The dark theme, the palette's command, and the dev features off.
// ---------------------------------------------------------------------------

await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
await page.keyboard.press('t')
await sleep(1000)
console.log('theme:', await page.evaluate(() => document.documentElement.dataset.theme ?? 'system'))
G = await settledCircle()
at = sectionOf(G, RICH)
await page.mouse.move(at.x, at.y)
await sleep(500)
await shot('ci20-dark')
await away()
await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
await page.keyboard.press('t')
await sleep(300)
console.log('theme back:', await page.evaluate(() => document.documentElement.dataset.theme ?? 'system'))
await page.evaluate(() => { document.documentElement.removeAttribute('data-theme'); localStorage.removeItem('chromosomix:theme') })
await sleep(500)

await page.keyboard.press('Control+p')
await sleep(400)
await page.keyboard.type('circle')
await sleep(600)
console.log('palette:', await page.evaluate(() => [...document.querySelectorAll('.palette-row')].map((node) => node.textContent?.replace(/\s+/g, ' ').trim()).slice(0, 5)))
await shot('ci21-palette')
await page.keyboard.press('Escape')
await sleep(300)

// The dev features off: a .metacool is refused whole (§29), and its circle
// with it — no toggle, no button, nothing drawn round.
await page.evaluate(() => localStorage.removeItem('chromosomix:dev-features'))
await page.reload()
await sleep(6000)
console.log(
  'dev off:',
  await page.evaluate(() => ({
    hash: decodeURIComponent(location.hash).replace(/uri=[^&]*&?/, ''),
    toggle: [...document.querySelectorAll('button')].some((node) => node.title.startsWith('Draw the map as a circle')),
    circle: [...document.querySelectorAll('.circle-canvas')].some((node) => node.getBoundingClientRect().width > 0),
    said: (document.querySelector('.error, .error-page, .gate, main')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
  })),
)
await shot('ci22-dev-off')

await g.close()
