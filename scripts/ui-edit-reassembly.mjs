/**
 * The stage on a real reassembly (§27.5, §27.11), in headless Chromium: a
 * long-read assembly of a yeast whose chromosome XVI carries the *Mycoplasma
 * mycoides* genome, 32 contigs, with its Hi-C map and its sequence — the stage
 * open with what the method offers, what the sequence says about the contigs'
 * ends, the join at the fused chromosome's working centromere lit, auto mode's run, the fused chromosome framed with its GC
 * showing the four stretches, what is left for review, and the AGP it writes.
 *
 * Reads `data/` (see `data/README.md`) through a session config under `out/`:
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-reassembly.mjs [out-dir]     # r01 … r07, r02b
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const CONFIG = process.env.REASSEMBLY_CONFIG ?? '/out/reasm/Reassembly.chromosomix.json'
const g = await gallery(OUT)
const { page, shot, text, history } = g
const files = join(OUT, 'files')
mkdirSync(files, { recursive: true })

await g.openWithDev(`?config=${g.base}${CONFIG}`)
await sleep(14000)
console.log('heading:', (await text('.crumb-reference'))?.trim())
await shot('r01-map')

// The stage: the whole assembly at 1 kb, and what the method offers.
await g.openStage()
await g.settled()
// The sequence, read once the picture is in, for its telomeres and gaps.
await page.waitForFunction(() => /^From /.test(document.querySelector('.edit-evidence-note')?.textContent ?? ''), null, { timeout: 60_000 }).catch(() => undefined)
await g.settled()
console.log('sequence:', await text('.edit-evidence-note'))
console.log('stage:', await text('.edit-readout'))
console.log('offered:', await g.suggestions())
await shot('r02-stage')
// What the sequence said, at the foot of the side panel.
await page.evaluate(() => document.querySelector('.edit-evidence-note')?.scrollIntoView({ block: 'end' }))
await sleep(300)
await shot('r02b-sequence')
await page.evaluate(() => document.querySelector('.edit-modes')?.scrollIntoView({ block: 'start' }))
await sleep(200)

// The join at the working centromere, lit from its label on the rail.
const lit = await page.evaluate(() => {
  const label = [...document.querySelectorAll('.edit-rail-label')].find((node) => /contig_39’s end to contig_34’s start/.test(node.getAttribute('title') ?? ''))
  if (label === undefined) return null
  const r = label.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
if (lit !== null) {
  await page.mouse.move(lit.x, lit.y)
  await sleep(500)
}
console.log('lit:', await page.evaluate(() => document.querySelector('.edit-suggestion.is-lit .edit-suggestion-words')?.textContent ?? null))
await shot('r03-lit')
await page.mouse.move(5, 5)

// Auto: every suggestion at even odds or more, best first, counted again after each.
await page.click('.edit-modes >> text=auto')
await sleep(400)
console.log('auto offers:', await text('.edit-suggestions-card .edit-acts'))
await page.click('.edit-suggestions-card .edit-acts button')
await sleep(1000)
await g.settled()
console.log('after auto:', await history())
await shot('r04-auto')

// The fused chromosome, framed from the list: the yeast, myco, yeast, myco
// stretches along its GC.
const fused = await page.evaluate(() => {
  for (const button of document.querySelectorAll('.edit-sequence')) {
    const name = button.querySelector('.edit-sequence-name')?.textContent ?? ''
    if (name.startsWith('contig_39')) {
      button.click()
      return name
    }
  }
  return null
})
await sleep(1200)
console.log('framed:', fused, '·', await text('.edit-card .edit-locus'))
await page.keyboard.press('Escape')
await sleep(600)
await shot('r05-fused')

// What is left, in review.
await page.click('.edit-modes >> text=review')
await sleep(800)
console.log('review:', await text('.edit-review'))
await shot('r06-review')

// Named, sorted, and a circle started elsewhere (§27.3, §27.4): the fused
// chromosome given the name the strain gives it, the sequences longest first,
// and contig_62 — which reads as a circle — started at its middle with O.
await page.click('.edit-modes >> text=manual')
await sleep(300)
if (fused !== null) {
  await page.evaluate((name) => {
    document.querySelector(`.edit-sequence-rename[aria-label="Rename ${name}"]`)?.click()
  }, fused)
  await sleep(200)
  await page.fill('.edit-rename-input', 'chrXVI_Mmmyco')
  await page.keyboard.press('Enter')
  await sleep(1200)
}
await page.click('.edit-sequences-card button >> text=longest first').catch(() => console.log('longest first: not offered'))
await sleep(1200)
await g.settled()
console.log('named and sorted:', await page.evaluate(() => [...document.querySelectorAll('.edit-sequence-name')].slice(0, 6).map((node) => node.textContent)))
{
  // contig_62 framed from the list — a few pixels wide in the whole genome —
  // then the pointer on its middle.
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('.edit-sequence')) {
      if (button.querySelector('.edit-sequence-name')?.textContent === 'contig_62') button.click()
    }
  })
  await sleep(900)
  const box = await g.mapBox()
  const c62 = await g.cellsOf('contig_62')
  if (c62 !== null) {
    const middle = Math.round((c62[0] + c62[1]) / 2)
        await page.mouse.move(...Object.values(g.at(box, middle, middle)))
    await sleep(300)
    console.log('over contig_62:', c62, await text('.edit-readout'))
    await page.keyboard.press('o')
    await sleep(1200)
    console.log('after O:', await text('.edit-readout'))
  } else console.log('origin: no contig_62')
}
console.log('history now:', (await history()).slice(-3))
await page.evaluate(() => document.querySelector('.edit-sequences-card')?.scrollIntoView({ block: 'start' }))
await sleep(300)
await shot('r06b-named')

// The AGP of the rebuilt assembly.
await page.click('.edit-modes >> text=manual')
await page.evaluate(() => {
  window.showSaveFilePicker = undefined
  document.querySelector('.edit-export-card')?.scrollIntoView({ block: 'center' })
})
const [download] = await Promise.all([page.waitForEvent('download'), page.click('.edit-export-card button[data-format="AGP"]')])
const path = join(files, download.suggestedFilename())
await download.saveAs(path)
const agp = readFileSync(path, 'utf8')
console.log('AGP, the fused chromosome:\n' + agp.split('\n').filter((line) => line.startsWith('chrXVI_Mmmyco') || line.startsWith('contig_39')).join('\n'))
await shot('r07-export')
await g.close()
