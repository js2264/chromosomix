/**
 * The circle of a metagenome (§7.6, dev), in headless Chromium on the mock
 * community demo: the Genomes table's `circle →` and the gate it lands on, the
 * 48 genomes drawn round with the names off — the demo's `labels`, as the
 * square's — and then on from the Map card, a genome hovered with its partners
 * lit and weighed, a chord hovered, the chords thinned, three tracks dropped on
 * the Tracks card as rings — two bedGraphs, Hi-C hits and restriction sites per
 * kb (log10), and a BED of the long contigs, all written here from the file's
 * own contig table — four metadata columns added as four more, a ring hovered
 * with the crosshair's radial line through every ring, held and dragged to
 * another place with the Metadata card following, the two bedGraphs grouped from
 * the batch box and overlaid into one ring from the Groups card, then the
 * Aesthetics column's switches one at a time — track text, track fill and the
 * legend off, and stretch — the contig × contig circle under its genome band,
 * five ticked sub-bins cut into genomes and then contigs with a band hovered, a
 * band and a chord clicked open, the figure saved as a PNG and a PDF and each
 * written out, the dark theme, the palette's command and the dev features off.
 * And the zoom: the wheel over a genome with its neighbours named, a ring
 * hovered there, a drag that pans, the keys, the rings' names at twelve o'clock
 * with one carried by its name, a double click back; a ring's foot hovered and
 * dragged thicker, and Escape mid-drag; the tracks outside the arcs from the Map
 * card, a genome hovered there and zoomed into; the contigs of one genome
 * zoomed into and named; the figure of a zoomed view.
 * Prints what it found at each step — the geometry the canvas publishes, the
 * tooltips, the toggles offered and lit, the rings' order and thickness — so a
 * picture that did not change is a line in the log as well.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-circle.mjs [out-dir]     # ci01 … ci40, ci-figure.png, ci-figure.pdf, ci-figure-page.png, ci-figure-zoomed.png
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import h5wasm from 'h5wasm/node'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const DEMO = 'demo/metagenomics/mock-community'
mkdirSync(OUT, { recursive: true })

// Three tracks along the community's contigs, from the file's own contig table:
// the Hi-C hits and the restriction sites each contig holds per kb — on a log
// scale, since a contig of a few hundred bases can hold thousands of hits per
// kb — and the contigs of 100 kb or more.
await h5wasm.ready
const h5 = new h5wasm.File(`${DEMO}/Mock_microbial_community.metacool`, 'r')
const contigNames = h5.get('contigs/name').value
const contigLengths = h5.get('contigs/length').value
const contigHits = h5.get('contigs/Hit').value
const contigSites = h5.get('contigs/Restriction_site').value
h5.close()
let bedGraph = 'track type=bedGraph name="Hi-C hits per kb (log10)"\n'
let sites = 'track type=bedGraph name="restriction sites per kb (log10)"\n'
let bed = ''
for (let i = 0; i < contigNames.length; i++) {
  const length = Number(contigLengths[i])
  bedGraph += `${contigNames[i]}\t0\t${length}\t${Math.log10(1 + (Number(contigHits[i]) / length) * 1000).toFixed(3)}\n`
  sites += `${contigNames[i]}\t0\t${length}\t${Math.log10(1 + (Number(contigSites[i]) / length) * 1000).toFixed(3)}\n`
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
  // A frame first: headless Chromium runs one only when something asks for it,
  // so a picture changed by a key press — Escape putting a ring back — would
  // otherwise be read as it was before the key.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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
 * Wait for the circle to differ from `before`, then for it to hold still: a
 * step that changes the picture is read after the change, not before it — two
 * polls of the old geometry match as well as two of the new.
 */
async function changedCircle(before, timeout = 10_000) {
  const was = JSON.stringify(before)
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const now = await geo()
    if (now !== null && JSON.stringify(now) !== was) break
    await sleep(100)
  }
  return settledCircle()
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

/** Press the visible toggle whose tooltip starts with `title`; says whether there was one. */
async function press(title) {
  const pressed = await page.evaluate((t) => {
    const button = [...document.querySelectorAll('.controls-card button')].find(
      (node) => node.getBoundingClientRect().width > 0 && node.title.startsWith(t),
    )
    if (button === undefined) return false
    button.click()
    return true
  }, title)
  await sleep(600)
  return pressed
}

/** The overlay toggles each visible Map and Tracks card offers, and which are lit. */
const overlays = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.controls-card .plot-icon-row button')]
      .filter((node) => node.getBoundingClientRect().width > 0 && node.hasAttribute('aria-pressed') && / — /.test(node.title))
      .map((node) => `${node.title.split(' — ')[0]} ${node.getAttribute('aria-pressed') === 'true' ? 'on' : 'off'}`)
      .join(' · '),
  )
const thickness = (G) => G.rings.map((ring) => `${ring.name} ${Math.round(ring.outer - ring.inner)}px`).join(' | ')

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
console.log('genome level:', describe(G), `· names ${G.names ? 'kept' : 'none'}`)
console.log('Map card overlays while drawn round:', await overlays())
await away()
await shot('ci03-circle')

// The names: the Map card's `labels`, off in this demo as it is for the square.
console.log('labels pressed:', await press('labels —'))
G = await settledCircle()
console.log('labels on:', `names ${G.names ? 'kept' : 'none'} · sections at ${G.sections[1]}px of ${Math.round(G.width / 2)}`)
await away()
await shot('ci04-labels-on')

// A genome hovered: its partners lit and counted, the rest set back.
const RICH = 'metator_00002_00003'
let at = sectionOf(G, RICH)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log(`hovered ${RICH}:`, await tip())
await shot('ci05-hover-genome')

// The strongest chord hovered: its two ends lit, the rest dimmed.
const strongest = G.strongest[0]
await page.mouse.move(G.left + strongest.x, G.top + strongest.y)
await sleep(500)
console.log(`hovered the strongest chord, ${strongest.a} × ${strongest.b}:`, await tip())
await shot('ci06-hover-chord')

// Thinned from the Map card: the strongest 50.
await away()
const chords = page.locator('.controls-card.is-circle select').filter({ has: page.locator('option', { hasText: 'strongest 50' }) }).first()
await chords.selectOption({ label: 'strongest 50' })
G = await settledCircle()
console.log('strongest 50:', describe(G))
await shot('ci07-strongest-50')
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
    { name: 'sites_per_kb_log10.bedgraph', text: sites },
    { name: 'long_contigs.bed', text: bed },
  ],
)
await sleep(3000)
G = await settledCircle()
console.log('three tracks dropped:', describe(G), '·', await where())
await shot('ci08-track-rings')

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
await shot('ci09-metadata-rings')
await columnOpen('2', '.ann-drop', false)
G = await settledCircle()
await away()
await shot('ci10-rings')

// A ring hovered: its name, the place and the value there.
const gc = G.rings.find((ring) => ring.id.includes('GC_content')) ?? G.rings[0]
at = point(G, (gc.inner + gc.outer) / 2, 0.35)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log('ring hovered:', await tip())
console.log(
  'the crosshair:',
  await page.evaluate(() => {
    const guide = document.querySelector('.circle-guide')
    const ctx = guide?.getContext('2d')
    if (!guide || !ctx) return 'no layer'
    const data = ctx.getImageData(0, 0, guide.width, guide.height).data
    let inked = 0
    for (let k = 3; k < data.length; k += 4) if (data[k] > 0) inked++
    return `${inked} pixels drawn on its layer`
  }),
)
await shot('ci11-crosshair')

// The outermost ring held by its name at twelve o'clock — its handle, as a
// lane's name is (the rest of the picture pans) — and carried in, past two
// others, then let go.
const order = (G) => G.rings.map((ring) => ring.name).join(' | ')
console.log('rings before:', order(G))
const outer = G.rings[G.rings.length - 1]
const target = G.rings[Math.max(0, G.rings.length - 4)]
const handle = G.grips.find((grip) => grip.id === outer.id)
console.log('the outer ring held by', handle === undefined ? 'its stretch of the gap at twelve' : 'its name')
const from = handle === undefined ? point(G, (outer.inner + outer.outer) / 2, -Math.PI / 2) : { x: G.left + handle.x, y: G.top + handle.y }
const to = point(G, (target.inner + target.outer) / 2 - 1, -Math.PI / 2)
await page.mouse.move(from.x, from.y)
await page.mouse.down()
for (let k = 1; k <= 16; k++) {
  await page.mouse.move(from.x + ((to.x - from.x) * k) / 16, from.y + ((to.y - from.y) * k) / 16)
  await sleep(35)
}
await sleep(400)
await shot('ci12-ring-held')
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
await shot('ci13-ring-dropped')

// The two bedGraphs ticked, grouped from the batch box, and overlaid into one
// ring from the Groups card — as they would be into one lane beside the map.
for (const name of ['hits_per_kb_log10', 'sites_per_kb_log10']) {
  const ticked = await page.evaluate((label) => {
    const rows = [...document.querySelectorAll('.annotation-card:not(.metadata-card) .ann-row')]
    const row = rows.find((node) => {
      const field = node.querySelector('.ann-name')
      return (field?.value ?? field?.textContent?.trim()) === label
    })
    const tick = row?.querySelector('.ann-tick')
    if (!(tick instanceof HTMLElement)) return false
    tick.click()
    return true
  }, name)
  console.log(`  ticked ${name}:`, ticked)
  await sleep(400)
}
page.once('dialog', (dialog) => void dialog.accept('per kb'))
await page
  .locator('.ann-batch .field')
  .filter({ has: page.locator('.field-label', { hasText: /^group$/ }) })
  .first()
  .locator('select')
  .selectOption(' new')
await sleep(800)
await columnOpen('2', '.ann-drop', false)
const groupsCard = page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Groups$/ }) }).first()
await groupsCard.scrollIntoViewIfNeeded().catch(() => {})
console.log('overlaid:', await press('A lane each. Press to draw all of these into one lane'))
G = await settledCircle()
console.log('one ring for the group:', describe(G))
const both = G.rings.find((ring) => ring.name === 'per kb') ?? G.rings[0]
at = point(G, (both.inner + both.outer) / 2, 0.35)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log('the group ring hovered:', await tip())
await shot('ci14-group-overlay')
await away()

// The Tracks card's switches, one at a time, each put back after its picture.
const tracksCard = page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Tracks$/ }) }).first()
await tracksCard.scrollIntoViewIfNeeded().catch(() => {})
console.log('Tracks card overlays:', await overlays())
console.log('track text off:', await press('track text —'))
await away()
await shot('ci15-track-text-off')
await press('track text —')
console.log('track fill off:', await press('track fill —'))
await away()
await shot('ci16-track-fill-off')
await press('track fill —')

// The legend off: no key on the circle or in its figure, and the hint in the
// corner the key stood in.
await exportCard().scrollIntoViewIfNeeded().catch(() => {})
console.log('legend off:', await press('legend —'))
G = await settledCircle()
at = sectionOf(G, RICH)
await page.mouse.move(G.left + G.width - 40, G.top + 40)
await sleep(600)
console.log('hint with no key:', await page.evaluate(() => document.querySelector('.circle-hint')?.innerText.replace(/\n+/g, ' / ') ?? null))
await shot('ci17-legend-off')
await away()
await press('legend —')

// Stretch, which beside a map fills the lanes' room: here the rings' depth —
// with the names off, as the demo has them, so there is depth to fill.
console.log('labels off again:', await press('labels —'))
const unstretched = await settledCircle()
console.log('rings before the stretch:', thickness(unstretched))
console.log('stretch:', await press('Stretch every track'))
G = await changedCircle(unstretched)
console.log('rings after the stretch: ', thickness(G))
await away()
await shot('ci18-stretched')

// The names back on, and the text size, which every name and the key are
// written in.
await press('labels —')
const named = (await settledCircle()).fontPx
await press('Larger text on the pictures')
const larger = (await settledCircle()).fontPx
await press('Smaller text on the pictures')
G = await settledCircle()
console.log(`names written at ${named}px, at ${larger}px a text size up, and at ${G.fontPx}px back down`)

// ---------------------------------------------------------------------------
// The zoom (§7.6): the wheel over a genome, its neighbours named, a ring
// hovered, the rings read again for the zoom's own bins, a drag that pans, the
// keys, the rings' names at twelve o'clock with one carried by its name, and a
// double click back to the whole circle.
// ---------------------------------------------------------------------------

const zoomState = (G) =>
  `zoom ×${G.zoom} · ${G.labelled} named · ` +
  (G.detail === null
    ? 'drawn in the whole circle’s bins'
    : `${G.detail.bins.toLocaleString('en-US')} bins of its own, ${G.detail.tracks} tracks read for them`)
/** Turn the wheel over a point, a notch at a time; up is in. */
async function wheel(at, notches) {
  await page.mouse.move(at.x, at.y)
  for (let k = 0; k < Math.abs(notches); k++) {
    await page.mouse.wheel(0, notches > 0 ? -120 : 120)
    await sleep(40)
  }
}
/**
 * A zoomed circle once its bins are cut and every track with numbers is read
 * for them — the signals' reads land after the view holds still — or as it is,
 * past the wait.
 */
async function finer(timeout = 30_000) {
  const until = Date.now() + timeout
  let G = await settledCircle()
  let last = -1
  while (Date.now() < until && G.zoom > 1 && (G.detail === null || G.detail.tracks !== last)) {
    last = G.detail?.tracks ?? -1
    await sleep(800)
    G = await geo()
  }
  return settledCircle()
}
const hintText = () => page.evaluate(() => document.querySelector('.circle-hint')?.innerText.replace(/\n+/g, ' / ') ?? null)

G = await settledCircle()
at = sectionOf(G, RICH)
await page.mouse.move(at.x, at.y)
await sleep(300)
console.log('the hint at rest:', await hintText())
await wheel(at, 9)
G = await finer()
console.log(`the wheel over ${RICH}:`, zoomState(G))
console.log('the hint zoomed:', await hintText())
console.log('under the pointer:', await tip())
await shot('ci19-zoomed')

// A ring under the pointer, at the zoom: its value, and the crosshair.
const zoomAngle = Math.atan2(at.y - (G.top + G.cy), at.x - (G.left + G.cx))
const gcZoomed = G.rings.find((ring) => ring.id.includes('GC_content')) ?? G.rings[0]
const onRing = point(G, (gcZoomed.inner + gcZoomed.outer) / 2, zoomAngle + 0.004)
await page.mouse.move(onRing.x, onRing.y)
await sleep(500)
console.log('a ring hovered, zoomed:', await tip())
await shot('ci20-zoomed-ring')

// A drag across the picture pans it.
const panFrom = { x: G.left + G.width * 0.35, y: G.top + G.height * 0.5 }
const before = { ...G.offset }
await page.mouse.move(panFrom.x, panFrom.y)
await page.mouse.down()
for (let k = 1; k <= 14; k++) {
  await page.mouse.move(panFrom.x + 18 * k, panFrom.y - 9 * k)
  await sleep(25)
}
await page.mouse.up()
G = await finer()
console.log(`a drag of 252 × −126 px: the middle from ${before.x}, ${before.y} to ${G.offset.x}, ${G.offset.y} · ${zoomState(G)}`)
await away()
await shot('ci21-panned')

// The keys, on the picture the press gave the focus to.
for (const key of ['PageUp', 'PageUp', 'ArrowLeft', 'Shift+ArrowUp', 'PageDown', 'Home']) {
  await page.keyboard.press(key)
  G = await settledCircle()
  console.log(`  ${key}: zoom ×${G.zoom}, middle at ${G.offset.x}, ${G.offset.y}`)
}

// Twelve o'clock, zoomed: the rings' names, the one under the pointer lit, and
// a ring carried by its name to another place.
const topRing = G.rings[Math.floor(G.rings.length / 2)]
await wheel(point(G, (topRing.inner + topRing.outer) / 2, -Math.PI / 2), 6)
G = await finer()
console.log('zoomed at twelve:', zoomState(G), '·', G.grips.length, 'names to hold a ring by')
const lifted = G.rings[G.rings.length - 2]
const liftedGrip = G.grips.find((grip) => grip.id === lifted.id)
if (liftedGrip !== undefined) {
  await page.mouse.move(G.left + liftedGrip.x, G.top + liftedGrip.y)
  await sleep(400)
  console.log(`over the name of ${lifted.name}: cursor`, await page.evaluate(() => document.querySelector('.circle-canvas:hover')?.style.cursor ?? null))
  await shot('ci22-zoomed-top')
  const dropAt = G.rings[1]
  const start = { x: G.left + liftedGrip.x, y: G.top + liftedGrip.y }
  const end = point(G, (dropAt.inner + dropAt.outer) / 2, -Math.PI / 2)
  await page.mouse.down()
  for (let k = 1; k <= 16; k++) {
    await page.mouse.move(start.x + ((end.x - start.x) * k) / 16, start.y + ((end.y - start.y) * k) / 16)
    await sleep(35)
  }
  await sleep(300)
  await shot('ci23-zoomed-ring-held')
  await page.mouse.up()
  G = await settledCircle()
  console.log('rings after, zoomed:', order(G))
} else {
  console.log(`no name drawn for ${lifted.name}`)
}

// A double click: the whole circle again.
await page.mouse.dblclick(G.left + G.width * 0.3, G.top + G.height * 0.6)
G = await settledCircle()
console.log('a double click:', zoomState(G), '·', describe(G))
await away()
await shot('ci24-fitted-again')

// ---------------------------------------------------------------------------
// A ring's foot, and the tracks outside (§7.6): the inner edge of a ring
// under the pointer, ruled in blue under the double arrow along the radius; a
// drag that makes the ring thicker, its track's height beside the hand;
// Escape mid-drag; then the Map card's `tracks` row putting the rings outside
// the arcs, the genomes the inner circle round the chords — hovered there, and
// zoomed into — and back inside.
// ---------------------------------------------------------------------------

const ringsOf = (G) => G.rings.map((ring) => `${ring.name} ${Math.round(ring.outer - ring.inner)}px`).join(' | ')
const cursorNow = () => page.evaluate(() => document.querySelector('.circle-canvas')?.style.cursor ?? null)
// The names off, as the demo has them: on, they take two fifths of the radius
// and six rings share what is left at a few pixels each.
console.log('labels off for the rings:', await press('labels —'))
G = await settledCircle()
const footed = G.rings.find((ring) => ring.name === 'Completeness') ?? G.rings[Math.floor(G.rings.length / 2)]
const footAngle = 0.62
console.log('rings before:', ringsOf(G))
at = point(G, footed.inner, footAngle)
await page.mouse.move(at.x, at.y)
await sleep(400)
console.log(`on the foot of ${footed.name}: cursor ${await cursorNow()}`)
await shot('ci25-ring-foot')
await page.mouse.down()
for (let k = 1; k <= 14; k++) {
  const step = point(G, footed.inner - (36 * k) / 14, footAngle)
  await page.mouse.move(step.x, step.y)
  await sleep(30)
}
await sleep(300)
console.log('held 36 px in:', await tip(), '·', ringsOf(await geo()))
await shot('ci26-ring-foot-held')
await page.mouse.up()
G = await settledCircle()
console.log('let go:', ringsOf(G))
// Escape mid-drag puts the height back.
const again = G.rings.find((ring) => ring.id === footed.id) ?? footed
at = point(G, again.inner, footAngle + 1.4)
await page.mouse.move(at.x, at.y)
await page.mouse.down()
for (let k = 1; k <= 8; k++) {
  const step = point(G, again.inner + (24 * k) / 8, footAngle + 1.4)
  await page.mouse.move(step.x, step.y)
  await sleep(30)
}
await sleep(200)
console.log('held 24 px out:', ringsOf(await geo()))
await page.keyboard.press('Escape')
G = await settledCircle()
console.log('Escape:', ringsOf(G))
await page.mouse.up()
await away()

// The tracks outside, from the Map card.
const tracksRow = page.locator('.controls-card.is-circle select').filter({ has: page.locator('option[value="outside"]') }).first()
await tracksRow.selectOption('outside')
G = await settledCircle()
console.log(
  'tracks outside:',
  `chords to ${G.chord}px · sections ${G.sections.join('–')}px · rings ${G.rings.map((ring) => `${ring.inner}–${ring.outer}`).join(', ')}px · names from ${G.labelAt}px · outside ${G.outside}`,
)
await away()
await shot('ci27-tracks-outside')
at = sectionOf(G, RICH)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log(`outside, ${RICH} hovered:`, await tip())
await shot('ci28-outside-hover')
await wheel(at, 8)
G = await finer()
console.log('outside, zoomed:', zoomState(G), '·', ringsOf(G))
await away()
await shot('ci29-outside-zoomed')
await page.mouse.dblclick(G.left + G.width * 0.3, G.top + G.height * 0.6)
await settledCircle()
await tracksRow.selectOption('inside')
G = await settledCircle()
console.log('back inside:', ringsOf(G), '· outside', G.outside)
await press('labels —')

// ---------------------------------------------------------------------------
// The contig × contig circle, grouped by genome under a band.
// ---------------------------------------------------------------------------

const level = page.locator('select:visible').filter({ has: page.locator('option', { hasText: 'contig × contig' }) }).first()
await level.selectOption({ label: 'contig × contig' })
await sleep(1500)
await compute()
G = await settledCircle(120_000)
console.log('contig level:', describe(G), `· ${G.withinGenome} of the chords drawn within one genome · names ${G.names ? 'kept' : 'none'}`)
await away()
await shot('ci30-contig-level')
at = sectionOf(G, G.units[Math.floor(G.units.length * 0.12)].name)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log('contig hovered:', await tip())
await shot('ci31-contig-hover')

// Zoomed into one genome's contigs: few enough in view to be named, under
// their genome's name, and a named contig opened by its name.
const bandOf = G.groups.find((entry) => entry.name === RICH) ?? G.groups[0]
await wheel(point(G, (G.band[0] + G.band[1]) / 2, bandOf.mid), 22)
G = await settledCircle()
console.log(`the contigs of ${bandOf.name}, zoomed:`, zoomState(G))
await away()
await shot('ci32-contig-zoom')
// Back from the Map card's refit, which undoes the circle's zoom as it does the square's.
console.log('the refit pressed:', await press('Undo every pan and zoom'))
G = await settledCircle()
console.log('  ', zoomState(G))

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
await shot('ci33-selection')

const sections = page.locator('.controls-card.is-circle select').filter({ has: page.locator('option[value="contigs"]') }).first()
await sections.selectOption('contigs')
G = await settledCircle()
console.log('cut into contigs:', describe(G), `· ${G.withinGenome} of the chords drawn within one genome ·`, await where())
await away()
await shot('ci34-selection-contigs')

// A genome's band hovered: the chords that leave it, and nothing else.
const BAND = 'metator_00002_00003'
const group = G.groups.find((entry) => entry.name === BAND) ?? G.groups[0]
at = point(G, (G.band[0] + G.band[1]) / 2, group.mid)
await page.mouse.move(at.x, at.y)
await sleep(500)
console.log(`band of ${group.name} hovered:`, await tip())
await shot('ci35-band-hover')

// ---------------------------------------------------------------------------
// Clicks that open: a band into its genome, a chord into its pair.
// ---------------------------------------------------------------------------

await page.mouse.click(at.x, at.y)
await sleep(2500)
G = await settledCircle(90_000)
console.log(`clicked the band of ${group.name}:`, (await page.locator('.breadcrumb').innerText()).replace(/\s+/g, ' '), '·', describe(G))
await away()
await shot('ci36-genome-opened')

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
await shot('ci37-chord-opened')

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

// Zoomed, the figure is the view: the box and what of the circle is in it.
G = await settledCircle()
await wheel(sectionOf(G, RICH), 7)
G = await finer()
console.log('zoomed for the figure:', zoomState(G))
await card.locator('.select-format').selectOption('png')
await sleep(300)
await card.locator('.export-acts button').first().click()
const zoomedPng = await keep(3, 'ci-figure-zoomed.png')
if (zoomedPng !== null) console.log('zoomed figure:', execFileSync('file', [zoomedPng]).toString().trim())
await press('Undo every pan and zoom')

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
await shot('ci38-dark')
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
await shot('ci39-palette')
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
await shot('ci40-dev-off')

await g.close()
