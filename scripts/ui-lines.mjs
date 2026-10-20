/**
 * The reader's order and the two lines (§7.6, dev), in headless Chromium on the
 * mock community demo. First the order: a genome carried along the circle with
 * the bar in the gap it would land in, dropped, the Genomes card and the Map
 * card's `order` row following and the square of the whole metagenome drawn in
 * the new order; a contig carried along its genome's circle with the Contigs
 * card following; five ticked genomes cut into contigs and one carried by its
 * band, the ticks kept; Escape mid-carry; *file order* putting everything back.
 * Then the two lines: the toggle beside the circle's and the picture asking for
 * a column, the `split by` select with every column of the Genomes table and
 * why all but `step` cannot split the genomes, the two lines split by `step`
 * with the names on and off, a genome and a ribbon hovered, a genome carried
 * along its line, the lines swapped, three tracks as lanes above the top line
 * and below the bottom one with a lane hovered, the contig level under each
 * genome's band with a band hovered, the toggle greyed on one genome with its
 * reason, the figure saved as a PNG and a PDF, and the palette's *Two lines*.
 * Prints what it found at each step — the order of the sections, the lists, the
 * geometry the canvas publishes and the tooltips — so a picture that did not
 * change is a line in the log as well.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-lines.mjs [out-dir]     # ln01 … ln21, ln-figure.png, ln-figure.pdf
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import h5wasm from 'h5wasm/node'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const DEMO = 'demo/metagenomics/mock-community'
mkdirSync(OUT, { recursive: true })

// One track along the community's contigs, from the file's own contig table:
// the Hi-C hits each contig holds per kb, on a log scale.
await h5wasm.ready
const h5 = new h5wasm.File(`${DEMO}/Mock_microbial_community.metacool`, 'r')
const contigNames = h5.get('contigs/name').value
const contigLengths = h5.get('contigs/length').value
const contigHits = h5.get('contigs/Hit').value
h5.close()
let bedGraph = 'track type=bedGraph name="Hi-C hits per kb (log10)"\n'
for (let i = 0; i < contigNames.length; i++) {
  const length = Number(contigLengths[i])
  bedGraph += `${contigNames[i]}\t0\t${length}\t${Math.log10(1 + (Number(contigHits[i]) / length) * 1000).toFixed(3)}\n`
}

const g = await gallery(OUT)
const { page, shot } = g
page.on('pageerror', (error) => console.log('page error:', String(error.stack ?? error).slice(0, 400)))
page.on('console', (message) => { if (message.type() === 'error') console.log('console error:', message.text().slice(0, 300)) })
const where = () => page.evaluate(() => decodeURIComponent(location.hash).replace(/uri=[^&]*&?/, ''))
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

/** The geometry the picture on screen publishes — the circle's or the lines' — in page pixels. */
async function geo() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll('.circle-canvas')].find((node) => node.getBoundingClientRect().width > 0)
    if (canvas === undefined || canvas.dataset.geometry === undefined) return null
    const box = canvas.getBoundingClientRect()
    return { left: box.left, top: box.top, width: box.width, height: box.height, ...JSON.parse(canvas.dataset.geometry) }
  })
}

/** Wait for a picture whose geometry holds still, and return it. */
async function settled(timeout = 60_000) {
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

/** Wait for the picture to differ from `before`, then to hold still. */
async function changed(before, timeout = 10_000) {
  const was = JSON.stringify(before)
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const now = await geo()
    if (now !== null && JSON.stringify(now) !== was) break
    await sleep(100)
  }
  return settled()
}

async function away() {
  await page.mouse.move(8, 496)
  await page.mouse.move(5, 500)
  await sleep(400)
}

const tip = () =>
  page.evaluate(() => {
    const node = [...document.querySelectorAll('.circle-tip')].find((x) => x.offsetParent !== null && !x.classList.contains('hidden'))
    return node === undefined ? null : node.innerText.replace(/\n+/g, ' / ')
  })

/** Press the visible card button whose tooltip starts with `title`. */
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

async function compute() {
  const button = page.locator('button:visible', { hasText: /^compute/ })
  if ((await button.count()) > 0) await button.first().click()
}

/** The left column's list — genomes, or one genome's contigs — the first rows, ticks and all. */
const card = (rows = 8) =>
  page.evaluate(
    (n) =>
      [...document.querySelectorAll('.seq-card .seq-row')]
        .slice(0, n)
        .map((row) => `${row.querySelector('.seq-tick')?.checked ? '☑' : '☐'} ${row.querySelector('.seq-name')?.textContent}`)
        .join(' · '),
    rows,
  )
const orderRow = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.controls-card .field')].some(
      (node) => node.getBoundingClientRect().width > 0 && node.querySelector('button')?.textContent === 'file order',
    ),
  )

const point = (G, radius, angle) => ({ x: G.left + G.cx + Math.cos(angle) * radius, y: G.top + G.cy + Math.sin(angle) * radius })
const sectionMid = (G) => (G.sections[0] + G.sections[1]) / 2

/** Carry from `from` to `to` in steps, the hand held there for a picture, and let go — or not. */
async function carry(from, to, name, release = true) {
  await page.mouse.move(from.x, from.y)
  await sleep(200)
  await page.mouse.down()
  for (let k = 1; k <= 14; k++) {
    await page.mouse.move(from.x + ((to.x - from.x) * k) / 14, from.y + ((to.y - from.y) * k) / 14)
    await sleep(35)
  }
  await sleep(350)
  console.log(`${name}, in the hand:`, await tip())
  await shot(name)
  if (release) await page.mouse.up()
}

// ---------------------------------------------------------------------------
// The reader's order, on the circle.
// ---------------------------------------------------------------------------

await g.openWithDev(CONFIG)
await page.waitForSelector('.table-toolbar', { timeout: 120_000 })
await sleep(2500)
await page.locator('.table-toolbar button', { hasText: 'circle →' }).first().click()
await sleep(2500)
await compute()
let G = await settled(90_000)
console.log('labels pressed:', await press('labels —'))
G = await settled()
const before = G.units.map((unit) => unit.name)
console.log('circle, file order:', before.slice(0, 7).join(', '))
console.log('the hint:', await page.evaluate(() => document.querySelector('.circle-hint')?.innerText.replace(/\n/g, ' / ')))

// The first genome, carried round to between the fifth and the sixth.
const gapAngle = (G.units[4].mid + G.units[5].mid) / 2
await carry(point(G, sectionMid(G), G.units[0].mid), point(G, sectionMid(G) + 30, gapAngle), 'ln01-circle-carry')
G = await changed(G)
console.log('circle, after the drop:', G.units.slice(0, 7).map((unit) => unit.name).join(', '))
console.log('the Genomes card:', await card())
console.log('the order row shown:', await orderRow())
await away()
await shot('ln02-circle-dropped')

// Escape mid-carry: the arc goes back, and the press is no click.
await page.mouse.move(...Object.values(point(G, sectionMid(G), G.units[3].mid)))
await page.mouse.down()
for (let k = 1; k <= 8; k++) {
  const at = point(G, sectionMid(G), G.units[3].mid + 0.06 * k)
  await page.mouse.move(at.x, at.y)
  await sleep(30)
}
await page.keyboard.press('Escape')
await sleep(300)
await page.mouse.up()
await sleep(800)
const afterEscape = await settled()
console.log('Escape mid-carry, the order unchanged:', afterEscape.units.map((u) => u.name).join() === G.units.map((u) => u.name).join(), '·', await where())

// The square, in the same order.
console.log('circle off:', await press('Draw the map as a circle'))
await sleep(2500)
await away()
await shot('ln03-square-follows')
console.log('the square, in the same order:', await where())
console.log('circle on:', await press('Draw the map as a circle'))
G = await settled()

// A genome's contigs, its circle opened by a click on its arc.
const RICH = 'metator_00002_00003'
const rich = G.units.find((unit) => unit.name === RICH)
const richAt = point(G, sectionMid(G), rich.mid)
await page.mouse.click(richAt.x, richAt.y)
await sleep(3000)
await compute()
G = await settled(90_000)
console.log('opened:', await where(), '·', G.units.length, 'contigs')
console.log('the Contigs card:', await card(5))
const contigGap = (G.units[2].mid + G.units[3].mid) / 2
await carry(point(G, sectionMid(G), G.units[0].mid), point(G, sectionMid(G), contigGap), 'ln04-contig-carry')
G = await changed(G)
console.log('contigs, after the drop:', G.units.slice(0, 5).map((unit) => unit.name).join(', '))
console.log('the Contigs card:', await card(5))
await away()
await shot('ln05-contig-dropped')

// Five ticked genomes cut into contigs: a genome carried by its band, the ticks kept.
await page.evaluate(() => { location.hash = location.hash.replace(/view=[^&]*/, 'view=genomes').replace(/&genome=[^&]*/, '') })
await page.waitForSelector('.table-toolbar', { timeout: 60_000 })
await sleep(1500)
const table = page.locator('.table').filter({ has: page.locator('.table-toolbar button', { hasText: 'circle →' }) }).first()
await table.locator('.table-toolbar input').first().fill('metator_00002_')
await sleep(800)
const ticks = table.locator('.tbody .tcheck')
for (let i = 0; i < (await ticks.count()); i++) await ticks.nth(i).check()
await table.locator('.table-toolbar button', { hasText: 'circle →' }).click()
await sleep(2500)
await compute()
G = await settled(90_000)
const sections = page.locator('.controls-card.is-circle select').filter({ has: page.locator('option[value="contigs"]') }).first()
await sections.selectOption('contigs')
G = await settled()
console.log('ticked, cut into contigs:', G.groups.map((group) => group.name).join(', '))
const bandMid = (G.band[0] + G.band[1]) / 2
await carry(point(G, bandMid, G.groups[0].mid), point(G, bandMid + 24, G.groups[2].mid + 0.12), 'ln06-band-carry')
G = await changed(G)
console.log('the bands after the drop:', G.groups.map((group) => group.name).join(', '))
console.log('the Genomes card, ticks kept:', await card(7), '·', await page.evaluate(() => document.querySelector('.seq-card .seq-chosen')?.textContent))

// *file order*: every genome and contig back where the file has them.
await page.locator('.controls-card button:visible', { hasText: 'file order' }).first().click()
G = await changed(G)
console.log('after file order:', G.groups.map((group) => group.name).join(', '), '· the row shown:', await orderRow())
await away()
await shot('ln07-file-order')

// ---------------------------------------------------------------------------
// The two lines.
// ---------------------------------------------------------------------------

await page.evaluate(() => { location.hash = `${location.hash.match(/uri=[^&]*/)[0]}&view=overview&level=genome&circle=true` })
await sleep(2500)
await compute()
G = await settled(90_000)
console.log('the picture row:', await page.evaluate(() =>
  [...document.querySelectorAll('.controls-card .field-block')].find((node) => node.textContent?.startsWith('picture'))
    ?.querySelectorAll('button').length))
console.log('two lines pressed:', await press('Draw the map as two lines'))
await sleep(1200)
console.log('hash:', await where())
console.log('the prompt:', await page.evaluate(() => document.querySelector('.lines-prompt:not(.hidden) .lines-prompt-text')?.textContent))
console.log(
  'split by offers:',
  await page.evaluate(() =>
    [...document.querySelectorAll('.controls-card .split-row select option')]
      .map((option) => `${option.textContent}${option.disabled ? ' ✗' : ''}`)
      .join(' · '),
  ),
)
await away()
await shot('ln08-lines-prompt')

await page.evaluate(() => {
  const select = document.querySelector('.lines-prompt select')
  select.value = 'step'
  select.dispatchEvent(new Event('change', { bubbles: true }))
})
G = await settled()
console.log('hash:', await where())
// The names are on from the circle above, as the Map card's `labels` is.
console.log('split:', JSON.stringify(G.split), '· left out:', G.leftOut, '· ribbons:', G.chords, 'of', G.pairs, '· named:', G.labelled)
await away()
await shot('ln09-lines-named')

console.log('labels pressed:', await press('labels —'))
G = await changed(G)
console.log('unnamed:', G.labelled, '· room for names:', G.names)
await away()
await shot('ln10-lines-unnamed')
console.log('labels pressed again:', await press('labels —'))
G = await changed(G)

const ySections = (line) => G.top + (G.rows[line].sections[0] + G.rows[line].sections[1]) / 2
const top = G.units.filter((unit) => unit.line === 0)
await page.mouse.move(G.left + top[2].mid, ySections(0))
await sleep(500)
console.log('a genome hovered:', await tip())
await shot('ln11-lines-hover')
const strongest = G.strongest[0]
await page.mouse.move(G.left + strongest.x, G.top + strongest.y)
await sleep(500)
console.log('a ribbon hovered:', await tip())
await shot('ln12-lines-ribbon')

await carry(
  { x: G.left + top[0].mid, y: ySections(0) },
  { x: G.left + (top[3].mid + top[4].mid) / 2, y: ySections(0) + 24 },
  'ln13-lines-carry',
)
G = await changed(G)
console.log('the top line after the drop:', G.units.filter((unit) => unit.line === 0).slice(0, 5).map((unit) => unit.name).join(', '))

console.log('swap pressed:', await press('Swap the two lines'))
G = await settled()
console.log('swapped:', JSON.stringify(G.split), '·', await where())
await away()
await shot('ln14-lines-swapped')
await press('Swap the two lines')
G = await settled()

// Tracks, as lanes: a bedGraph and two of the file's columns.
await page.keyboard.press('2')
await sleep(700)
await page.evaluate((text) => {
  const target = document.querySelector('.ann-drop')
  const data = new DataTransfer()
  data.items.add(new File([text], 'hits_per_kb_log10.bedgraph', { type: 'text/plain' }))
  for (const kind of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: data }))
}, bedGraph)
await sleep(2500)
await page.evaluate(() => {
  const metadata = document.querySelector('.metadata-card')
  if (metadata?.classList.contains('is-folded')) metadata.querySelector(':scope > .card-head')?.click()
})
for (const value of ['genomes/Completeness', 'contigs/GC_content']) {
  await page.evaluate((v) => {
    const select = document.querySelector('.metadata-card select')
    select.value = v
    select.dispatchEvent(new Event('change', { bubbles: true }))
    ;[...document.querySelectorAll('.metadata-card button')].find((node) => node.textContent?.trim() === 'add')?.click()
  }, value)
  await sleep(600)
}
await page.keyboard.press('2')
await sleep(1500)
G = await settled()
console.log('lanes:', G.lanes.map((lane) => `${lane.id} ${lane.rows.map((row) => `${row[0]}–${row[1]}`).join(' / ')}`).join(' | '))
await away()
await shot('ln15-lines-lanes')
const bottom = G.units.filter((unit) => unit.line === 1)
const firstLane = G.lanes[0].rows[1]
await page.mouse.move(G.left + bottom[1].mid, G.top + (firstLane[0] + firstLane[1]) / 2)
await sleep(600)
console.log('a lane hovered:', await tip())
await shot('ln16-lines-lane-hover')

// The contig level: each line's contigs under their genome's band.
const level = page.locator('select:visible').filter({ has: page.locator('option', { hasText: 'contig × contig' }) }).first()
await level.selectOption({ label: 'contig × contig' })
await sleep(1500)
await compute()
G = await settled(120_000)
console.log('contig level:', G.units.length, 'contigs under', G.groups.length, 'genomes · ribbons', G.chords, 'of', G.pairs, '·', await where())
await away()
await shot('ln17-lines-contigs')
const band = G.rows[0].band
const group = G.groups.find((entry) => entry.line === 0)
await page.mouse.move(G.left + group.mid, G.top + (band[0] + band[1]) / 2)
await sleep(600)
console.log('a band hovered:', await tip())
await shot('ln18-lines-band-hover')

// The figure: the two lines, saved as a PNG and a PDF.
const exportCard = page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()
await exportCard.scrollIntoViewIfNeeded()
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
await exportCard.locator('.select-format').selectOption('png')
await sleep(300)
await exportCard.locator('.export-acts button').first().click()
const png = await keep(1, 'ln-figure.png')
if (png !== null) console.log('figure:', execFileSync('file', [png]).toString().trim())
await exportCard.locator('.select-format').selectOption('pdf')
await sleep(300)
await exportCard.locator('.export-acts button').first().click()
const pdf = await keep(2, 'ln-figure.pdf')
if (pdf !== null) {
  try {
    const images = execFileSync('pdfimages', ['-list', pdf]).toString().trim().split('\n').slice(2)
    console.log(`  images in the PDF: ${images.length} (all paths and text where 0)`)
    console.log('  its text:', execFileSync('pdftotext', ['-layout', pdf, '-']).toString().replace(/\s+/g, ' ').trim().slice(0, 260))
  } catch (error) {
    console.log('  (no poppler to read the PDF):', String(error).slice(0, 80))
  }
}
await shot('ln19-lines-saved')

// One genome: the toggle greyed, with its reason; the lines kept for the way back.
await page.evaluate(() => { location.hash = `${location.hash.match(/uri=[^&]*/)[0]}&view=genome&genome=metator_00002_00003&lines=true&split=step` })
await sleep(3000)
await compute()
await sleep(1500)
console.log(
  'on one genome:',
  await page.evaluate(() => {
    // Third in the picture row: the refit, the circle, the two lines.
    const row = [...document.querySelectorAll('.controls-card .field-block')].find(
      (node) => node.getBoundingClientRect().width > 0 && node.textContent?.startsWith('picture'),
    )
    const button = row?.querySelectorAll('button')[2]
    return button === undefined ? 'no toggle' : { disabled: button.disabled, title: button.title }
  }),
)
await shot('ln20-lines-refused')

// The palette's row.
await page.keyboard.press('Control+p')
await sleep(400)
await page.keyboard.type('two lines')
await sleep(600)
console.log('palette:', await page.evaluate(() => [...document.querySelectorAll('.palette-row')].map((node) => node.textContent?.replace(/\s+/g, ' ').trim()).slice(0, 3)))
await shot('ln21-palette')
await page.keyboard.press('Escape')

await g.close()
