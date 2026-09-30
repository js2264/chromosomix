/**
 * The stage on one genome of a metagenome (§27.10), in headless Chromium on the
 * mock community demo: the genome picker the stage asks with, the stage on one
 * MAG's contigs alone, what the method offers there, where its contigs and the
 * others belong by their contacts, auto mode's scaffolds, a contig sent to
 * another genome and one brought in, and the AGP of that genome alone.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-metagenome.mjs [out-dir]     # g01 … g08, g03b, g04b, g04c, g04d, g06b
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const GENOME = process.env.GENOME ?? 'metator_00009_00000'
const g = await gallery(OUT)
const { page, shot, text, history } = g
const files = join(OUT, 'files')
mkdirSync(files, { recursive: true })

await g.openWithDev(`?config=${g.base}/demo/metagenomics/mock-community/Mock_microbial_community.metacooler.json`)
await sleep(9000)
await shot('g01-genomes')

// The stage, from the command palette: on a metagenome it asks which genome.
await page.keyboard.press('Control+p')
await sleep(400)
await page.keyboard.type('Edit a genome')
await sleep(400)
await page.keyboard.press('Enter')
await page.waitForSelector('.genome-picker-row', { timeout: 30_000 })
await sleep(300)
console.log('picker rows:', await page.evaluate(() => document.querySelectorAll('.genome-picker-row').length))
await shot('g02-picker')
await page.fill('.genome-picker-filter', GENOME.replace(/^metator_/, ''))
await sleep(300)
await shot('g03-picker-filtered')
await page.click('.genome-picker-row')
// The read, saying what it reads as it starts (§27.12).
for (let i = 0; i < 40; i++) {
  await sleep(100)
  if (/stored pixels|every stored pixel/.test((await text('.edit-status-text')) ?? '')) break
}
console.log('reading:', await text('.edit-status-text'))
await shot('g03b-reading')
for (let i = 0; i < 240; i++) {
  await sleep(500)
  if (await page.evaluate(() => document.querySelector('.edit-status')?.classList.contains('hidden'))) break
}
await sleep(800)
await g.settled()
console.log('title:', await text('.modal-edit .modal-title'))
console.log('stage:', await text('.edit-readout'))
console.log('offered:', await g.suggestions())
console.log('picture:', await text('.edit-picture-card .edit-note'))
await shot('g04-stage')

// Closer than a cell (§27.9): the genome's longest contig framed from the
// list, its picture cells enlarged at once, then the window read again finer.
await page.evaluate(() => document.querySelector('.edit-sequence')?.click())
await sleep(150)
await shot('g04c-enlarged')
for (let i = 0; i < 40; i++) {
  await sleep(250)
  if (await page.evaluate(() => document.querySelector('.edit-window-note') !== null)) break
}
await sleep(400)
console.log('closer:', await text('.edit-window-note'))
await shot('g04d-closer')
await page.keyboard.press('Escape')
await page.keyboard.press('0')
await sleep(500)

// Where the genome's contigs belong, read from every contact of the file.
for (let i = 0; i < 120; i++) {
  await sleep(500)
  if (await page.evaluate(() => document.querySelector('.edit-genome-card .edit-genome-sub') !== null)) break
}
await page.evaluate(() => document.querySelector('.edit-genome-card')?.scrollIntoView({ block: 'start' }))
await sleep(300)
console.log('genome card:', await page.evaluate(() => document.querySelector('.edit-genome-card')?.innerText.replace(/\n+/g, ' | ') ?? null))
await shot('g04b-genome-card')
await page.evaluate(() => document.querySelector('.edit-modes')?.scrollIntoView({ block: 'start' }))
await sleep(200)

// The best join lit, from its row in the list.
const first = await page.evaluate(() => {
  const row = document.querySelector('.edit-suggestion')
  if (row === null) return null
  const r = row.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + 12 }
})
if (first !== null) {
  await page.mouse.move(first.x, first.y)
  await sleep(500)
}
await shot('g05-lit')
await page.mouse.move(5, 5)

// Auto: every suggestion at even odds or more.
await page.click('.edit-modes >> text=auto')
await sleep(400)
console.log('auto offers:', await text('.edit-suggestions-card .edit-acts'))
const acts = await page.$('.edit-suggestions-card .edit-acts button')
if (acts !== null && (await acts.isEnabled())) {
  await acts.click()
  await sleep(1500)
  await g.settled()
}
console.log('after auto:', await history())
await shot('g06-auto')

// A contig sent to the genome it meets more, and one of another genome brought in.
await page.click('.edit-modes >> text=manual')
await page.evaluate(() => document.querySelector('.edit-genome-card')?.scrollIntoView({ block: 'start' }))
await sleep(300)
const sent = await page.evaluate(() => {
  const button = [...document.querySelectorAll('.edit-genome-card .edit-genome-act')].find((b) => /^send to/.test(b.textContent ?? ''))
  if (button === undefined) return null
  const name = button.closest('.edit-genome-row')?.querySelector('.edit-genome-name')?.textContent ?? null
  button.click()
  return name
})
console.log('sent:', sent)
await sleep(600)
await g.settled()
const brought = await page.evaluate(() => {
  const button = [...document.querySelectorAll('.edit-genome-card .edit-genome-act')].find((b) => b.textContent === 'bring in')
  if (button === undefined) return null
  const name = button.closest('.edit-genome-row')?.querySelector('.edit-genome-name')?.textContent ?? null
  button.click()
  return name
})
console.log('brought:', brought)
for (let i = 0; i < 120; i++) {
  await sleep(500)
  if (await page.evaluate(() => document.querySelector('.edit-status')?.classList.contains('hidden'))) break
}
await sleep(800)
await g.settled()
console.log('history:', await history())
console.log('stage:', await text('.edit-readout'))
await page.evaluate(() => document.querySelector('.edit-history')?.scrollIntoView({ block: 'center' }))
await sleep(300)
await shot('g06b-sent-brought')

// The genome's AGP, named after it.
await page.click('.edit-modes >> text=manual')
await page.evaluate(() => {
  window.showSaveFilePicker = undefined
  document.querySelector('.edit-export-card')?.scrollIntoView({ block: 'center' })
})
await sleep(300)
const [download] = await Promise.all([page.waitForEvent('download'), page.click('.edit-export-card button[data-format="AGP"]')])
const path = join(files, download.suggestedFilename())
await download.saveAs(path)
const agp = readFileSync(path, 'utf8')
console.log(`AGP → ${download.suggestedFilename()}:\n` + agp.split('\n').filter((line) => line !== '' && !line.startsWith('#')).slice(0, 8).join('\n'))
console.log('AGP comments:\n' + agp.split('\n').filter((line) => line.startsWith('# aside')).join('\n'))
console.log('status:', await text('.edit-export-status'))
await shot('g07-export')

// The binning of the whole metagenome, every genome's edit applied.
const [table] = await Promise.all([page.waitForEvent('download'), page.click('.edit-export-card button[data-format="binning"]')])
const tablePath = join(files, table.suggestedFilename())
await table.saveAs(tablePath)
const rows = readFileSync(tablePath, 'utf8').trim().split('\n')
console.log(`table → ${table.suggestedFilename()}: ${rows.length} rows`)
for (const wanted of [sent, brought]) if (wanted !== null) console.log('  ', rows.find((row) => row.startsWith(`${wanted}\t`)))
console.log('status:', await text('.edit-export-status'))
await shot('g08-binning')
await g.close()
