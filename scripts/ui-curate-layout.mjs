/**
 * A genome's edit of the reference inside the curation (§27.10, §33.3, §33.4,
 * §33.8), in headless Chromium on the mock community MM133: a genome selected
 * on the curation stage with its *lay out* act, the reference editor opened over
 * the stage with `S`, a contig turned and moved and one brought in, back on the
 * stage with the genome marked and the bring a move of the curation, the
 * genomes' sequences on the export card and written, the session drawn with the
 * genome laid out, its contigs table with what each sequence is made of, and the
 * editor opened again after the curation moved one of its contigs away — on the
 * genome as the map draws it.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-curate-layout.mjs [out-dir]     # cl01 … cl11
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const CONFIG = process.env.CONFIG ?? 'demo/metagenomics/mock-community/MM133.chromosomix.json'
/** A MAG of ten contigs. */
const GENOME = process.env.GENOME ?? 'MM133_metator_00001_00008'
const g = await gallery(OUT)
const { page, shot, text, history, mapBox, cellsOf } = g

/** Where a unit of the edited axis is on one of the editor's bars, on the page. */
async function onBar(side, unit) {
  const box = await mapBox()
  const bar = await page.evaluate((s) => {
    const r = document.querySelector(`.edit-bar-${s}`).getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }, side)
  return side === 'top'
    ? { x: box.left + ((unit - box.x0) / (box.x1 - box.x0)) * box.width, y: bar.top + bar.height / 2 }
    : { x: bar.left + bar.width / 2, y: box.top + ((unit - box.y0) / (box.y1 - box.y0)) * box.height }
}
const sequenceNames = () => page.evaluate(() => [...document.querySelectorAll('.edit-sequence-name')].map((node) => node.textContent))
const files = join(OUT, 'files')
mkdirSync(files, { recursive: true })

const readout = () => text('.curate-readout')
const curationHistory = () => page.evaluate(() => [...document.querySelectorAll('.curate-history-row')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()))
const words = (selector) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, selector)

async function counted() {
  for (let i = 0; i < 240; i++) {
    await sleep(250)
    const state = await page.evaluate(() => document.querySelector('.curate-stage')?.getAttribute('data-contacts'))
    if (state === 'read' && !/weighing/.test((await readout()) ?? '')) break
  }
  await sleep(600)
}

/** The editor's picture read, its genome card read. */
async function editorRead() {
  await page.waitForSelector('.modal-edit', { timeout: 60_000 })
  for (let i = 0; i < 480; i++) {
    await sleep(500)
    if (await page.evaluate(() => document.querySelector('.edit-status')?.classList.contains('hidden'))) break
  }
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    if (!(await page.evaluate(() => /Reading every contact/.test(document.querySelector('.edit-genome-card')?.textContent ?? '')))) break
  }
  await sleep(800)
}

async function selectGenome(name) {
  await page.fill('.curate-filter', name)
  await sleep(400)
  await page.click(`.curate-row-genome[data-genome="${name}"]`)
  await sleep(500)
}

// The session, and the curation stage on it.
await g.openWithDev(`?config=${g.base}/${CONFIG}`)
await sleep(9000)
await page.keyboard.press('Control+p')
await sleep(400)
await page.keyboard.type('Curate the genomes')
await sleep(400)
await page.keyboard.press('Enter')
await page.waitForSelector('.curate-stage', { timeout: 30_000 })
await counted()

// One genome selected: the card offers to lay it out.
await selectGenome(GENOME)
console.log('selection acts:', await page.evaluate(() => [...document.querySelectorAll('.curate-selection-acts button')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim())))
await shot('cl01-selected')

// S: the reference editor on the genome, over the stage.
await page.keyboard.press('s')
await editorRead()
console.log('editor title:', await text('.modal-edit .modal-title'))
console.log('sequences:', await page.evaluate(() => [...document.querySelectorAll('.edit-sequence-name')].map((node) => node.textContent)))
console.log('genome card:', (await words('.edit-genome-card'))?.slice(0, 400))
console.log('dialogs open:', await page.evaluate(() => document.querySelectorAll('.modal-backdrop').length))
await shot('cl02-editor')

// A stray sent to the genome it meets more — and one brought in, where the
// contacts offer one: each a move of the curation too.
const send = await page.$('.edit-genome-card button:has-text("send there")')
if (send !== null) {
  console.log('sending:', await send.evaluate((node) => node.title))
  await send.click()
  await sleep(1500)
} else console.log('nothing to send')
const bring = await page.$('.edit-genome-card button:has-text("bring in")')
if (bring !== null) {
  await bring.click()
  await sleep(1500)
} else console.log('nothing to bring in')
// Its second contig turned by a double click on the left bar; then the join
// the stage suggests, taken in review with Y: one scaffold, a hundred N
// between.
const names = await sequenceNames()
if (names.length >= 3) {
  const second = await cellsOf(names[1])
  const on = await onBar('left', (second[0] + second[1]) / 2)
  await page.mouse.dblclick(on.x, on.y)
  await sleep(1500)
  await g.settled()
  console.log('suggested:', await page.evaluate(() => [...document.querySelectorAll('.modal-edit .edit-suggestion-main')].slice(0, 3).map((row) => row.textContent?.replace(/\s+/g, ' ').trim())))
  await page.click('.modal-edit .edit-modes button:has-text("review")')
  await sleep(800)
  await page.keyboard.press('y')
  await sleep(1500)
  await page.click('.modal-edit .edit-modes button:has-text("manual")')
  await sleep(600)
}
console.log('editor history:', await history())
console.log('sequences now:', await page.evaluate(() => [...document.querySelectorAll('.edit-sequence-name')].map((node) => node.textContent)))
await shot('cl03-edited')

// Escape speaks to the editor alone; the stage is under it.
await page.keyboard.press('Escape')
await sleep(300)
await page.click('.modal-edit .btn-close')
await sleep(1500)
console.log('dialogs open after closing the editor:', await page.evaluate(() => document.querySelectorAll('.modal-backdrop').length))
await counted()
await page.fill('.curate-filter', '')
await sleep(300)
await selectGenome(GENOME)
console.log('readout:', await readout())
console.log('marked in the list:', await page.evaluate(() => [...document.querySelectorAll('.curate-row-genome')].filter((row) => row.querySelector('.curate-laid-out') !== null).map((row) => row.getAttribute('data-genome'))))
console.log('acts now:', await page.evaluate(() => [...document.querySelectorAll('.curate-selection-acts button')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim())))
console.log('curation history:', await curationHistory())
await shot('cl04-back-on-the-stage')

// The genomes' sequences on the export card, written.
await page.evaluate(() => {
  window.showSaveFilePicker = undefined
})
for (const format of ['agp', 'sequence-genome', 'fasta']) {
  const button = await page.$(`.curate-export-file[data-format="${format}"]`)
  if (button === null) continue
  console.log(`${format}:`, await button.evaluate((node) => `${node.disabled ? 'disabled' : 'enabled'} · ${node.title}`))
  if (await button.evaluate((node) => node.disabled)) continue
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }).catch(() => null), button.click()])
  if (download !== null) {
    const name = download.suggestedFilename()
    await download.saveAs(join(files, name))
    console.log('wrote', name)
  }
  await sleep(400)
}
console.log('export status:', await text('.curate-export-status'))
const exportCard = await page.$('.curate-export-card')
if (exportCard !== null) {
  await exportCard.scrollIntoViewIfNeeded()
  await sleep(200)
  await exportCard.screenshot({ path: join(OUT, 'cl05-export.png') })
  console.log('wrote cl05-export.png')
}

// Closed: the session drawn with the genome laid out.
await page.click('.modal-curate .btn-close')
await sleep(9000)
console.log('heading word:', await text('.crumb-genomes'))
console.log('file card:', await page.evaluate(() => [...document.querySelectorAll('.info-row, tr')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()).filter((row) => /laid out|curation/.test(row ?? '')).slice(0, 4)))
await shot('cl06-session')

// The genome's row in the genomes table, and its map in the session.
await page.fill('.view-genomes input[placeholder^="filter genome"]', GENOME).catch(() => console.log('no genome filter'))
await sleep(800)
console.log('genome row:', await page.evaluate(() => document.querySelector('.view-genomes .tr:not(.th)')?.textContent?.replace(/\s+/g, ' ').trim()))
await page.locator('.view-genomes .tr .td:not(.td-check)').first().click()
await sleep(6000)
console.log('its sequences:', await page.evaluate(() => document.querySelector('.view-genome, main')?.querySelector('h2, .view-title')?.parentElement?.textContent?.replace(/\s+/g, ' ').slice(0, 120)))
await shot('cl07-genome-laid-out')

// The contigs table, its genome column filtered to the genome: its sequences,
// and what each is made of beside its length.
await page.keyboard.press('c')
await sleep(3000)
const filtered = await page.evaluate((name) => {
  const view = document.querySelector('.view-contigs')
  if (view === null) return 'no contigs view'
  const heads = [...view.querySelectorAll('.th .td')].map((cell) => cell.textContent?.trim() ?? '')
  const at = heads.findIndex((text) => text === 'genome')
  const inputs = [...view.querySelectorAll('.th input, .tfilter input, input[placeholder="contains"], input[placeholder="compare"]')]
  return JSON.stringify({ heads: heads.slice(0, 8), at, inputs: inputs.length })
}, GENOME)
console.log('contigs table:', filtered)
// name, parts, genome: the third box that filters by text.
const genomeFilter = page.locator('.view-contigs input[placeholder="contains"]').nth(2)
await genomeFilter.fill(GENOME).catch(() => console.log('no genome filter'))
await sleep(1500)
console.log('rows:', await page.evaluate(() => [...document.querySelectorAll('.view-contigs .tr:not(.th)')].slice(0, 4).map((row) => row.textContent?.replace(/\s+/g, ' ').trim().slice(0, 140))))
await shot('cl08-contigs-parts')
await page.keyboard.press('g')
await sleep(1500)

// Back on the stage: one of the genome's contigs moved to the pool by the
// curation, then the genome laid out again — the editor opens on the genome as
// the map draws it, one step, until a step is made there.
await page.click('.crumb-genomes-button')
await page.waitForSelector('.curate-stage', { timeout: 30_000 })
await counted()
await selectGenome(GENOME)
await page.click(`.curate-row-genome[data-genome="${GENOME}"] .curate-row-disclosure`).catch(() => {})
await sleep(400)
// Its shortest contig, which the scaffold does not hold.
const contigs = await page.$$('.curate-row-contig')
const contig = contigs.length === 0 ? null : contigs[contigs.length - 1]
if (contig !== null) {
  console.log('unbinning:', await contig.evaluate((node) => node.textContent?.replace(/\s+/g, ' ').trim()))
  await contig.click()
  await sleep(300)
  await page.keyboard.press('Delete')
  await counted()
}
console.log('after the unbin:', await readout())
await selectGenome(GENOME)
await shot('cl09-moved-on-the-stage')
await page.keyboard.press('s')
await editorRead()
console.log('editor history on reopening:', await history())
console.log('sequences:', await page.evaluate(() => [...document.querySelectorAll('.edit-sequence-name')].map((node) => node.textContent)))
await shot('cl10-editor-as-drawn')
await page.click('.modal-edit .btn-close')
await sleep(1200)

// Dark.
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await sleep(800)
await shot('cl11-dark')
await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))

writeFileSync(join(OUT, 'cl-log.txt'), `errors: ${JSON.stringify(g.errors)}\n`)
await g.close()
process.exit(0)
