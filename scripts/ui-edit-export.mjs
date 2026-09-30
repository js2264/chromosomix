/**
 * The stage's export card (§27.8), in headless Chromium on the yeast micro-C
 * demo: the card under an edit, each text file written and its first lines
 * printed, and an AGP of another arrangement read back — one step in the
 * history, the map laid out as it says.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-export.mjs [out-dir]     # x01 … x04
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot, text, history } = g
const files = join(OUT, 'files')
mkdirSync(files, { recursive: true })

await g.openWithDev(`?config=${g.base}/demo/yeast/Yeast_microC.metacooler.json`)
await sleep(8000)
await g.openStage()
await g.settled()

// An edit to write: a stretch of IV turned round.
let box = await g.mapBox()
const iv = await g.cellsOf('IV')
await g.drag(g.at(box, iv[0] + 400, iv[0] + 400), g.at(box, iv[0] + 900, iv[0] + 900))
await page.keyboard.press('i')
await sleep(400)
await page.keyboard.press('Escape')
await g.settled()
console.log('history:', await history())

// The card, under the sequences.
await page.evaluate(() => document.querySelector('.edit-export-card')?.scrollIntoView({ block: 'center' }))
await sleep(300)
await shot('x01-export-card')

// Each text file, through the download a browser without a save dialog makes.
await page.evaluate(() => {
  window.showSaveFilePicker = undefined
})
async function save(format) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click(`.edit-export-card button[data-format="${format}"]`)])
  const path = join(files, download.suggestedFilename())
  await download.saveAs(path)
  const body = readFileSync(path, 'utf8')
  console.log(`${format} → ${download.suggestedFilename()}:\n${body.split('\n').slice(0, 9).join('\n')}\n…`)
  return body
}
await save('AGP')
const sizes = await save('chrom.sizes')
await save('.assembly')
await save('chain')
console.log('status:', await text('.edit-export-status'))
await shot('x02-written')

// Another arrangement read back: IV and V as one scaffold, V turned, with a
// join's gap between — the rest as they are.
const lengths = new Map(
  sizes
    .trim()
    .split('\n')
    .map((line) => line.split('\t'))
    .map(([name, length]) => [name, Number(length)]),
)
const rows = []
for (const [name, length] of lengths) {
  if (name === 'V') continue
  const original = name === 'IV_e1' ? 'IV' : name
  if (name === 'IV_e1') {
    rows.push(['IV_V', 1, length, 1, 'W', 'IV', 1, length, '+'])
    rows.push(['IV_V', length + 1, length + 200, 2, 'N', 200, 'scaffold', 'yes', 'proximity_ligation'])
    const v = lengths.get('V')
    rows.push(['IV_V', length + 201, length + 200 + v, 3, 'W', 'V', 1, v, '-'])
    continue
  }
  rows.push([original, 1, length, 1, 'W', original, 1, length, '+'])
}
const agp = join(files, 'IV_V.agp')
writeFileSync(agp, `##agp-version\t2.1\n${rows.map((row) => row.join('\t')).join('\n')}\n`)
await page.setInputFiles('.edit-export-card input[type="file"]', agp)
await sleep(600)
await g.settled()
console.log('read back:', await text('.edit-export-status'))
console.log('history:', await history())
await shot('x03-read-back')
await page.evaluate(() => document.querySelector('.edit-history')?.scrollIntoView({ block: 'center' }))
await sleep(300)
await shot('x04-history')
await g.close()
