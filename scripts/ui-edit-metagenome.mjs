/**
 * The stage on one genome of a metagenome (§27.10), in headless Chromium on the
 * mock community demo: the genome picker the stage asks with, the stage on one
 * MAG's contigs alone, what the method offers there, auto mode's scaffolds, and
 * the AGP of that genome alone.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-metagenome.mjs [out-dir]     # g01 … g07
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
for (let i = 0; i < 240; i++) {
  await sleep(500)
  if (await page.evaluate(() => document.querySelector('.edit-status')?.classList.contains('hidden'))) break
}
await sleep(800)
await g.settled()
console.log('title:', await text('.modal-edit .modal-title'))
console.log('stage:', await text('.edit-readout'))
console.log('offered:', await g.suggestions())
console.log('picture:', await text('.edit-card .edit-note'))
await shot('g04-stage')

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
if (acts !== null) {
  await acts.click()
  await sleep(1500)
  await g.settled()
}
console.log('after auto:', await history())
await shot('g06-auto')

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
console.log('status:', await text('.edit-export-status'))
await shot('g07-export')
await g.close()
