/**
 * Curating the genomes (§33.3), in headless Chromium on the mock community MM133:
 * the heading's word, the stage opening and reading the contacts, the three
 * pictures and the list, a genome lit in every part, the fragments of one
 * organism selected, the review's questions with their price, a question taken
 * and turned down, a host question, the host map large and around an element, the scatter large, a lasso, a drag onto a
 * genome, the close-up, auto, the exports, the session drawn through the
 * curation once the stage closes, the dark theme, a narrow window, and the dev
 * features off.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-curate.mjs [out-dir]     # cu01 … cu20
 *
 * `CONFIG` names another session to open (a path under the dev server).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const CONFIG = process.env.CONFIG ?? 'demo/metagenomics/mock-community/MM133.chromosomix.json'
const g = await gallery(OUT)
const { page, text } = g
/** A shot, and — on the stage — how many small pictures it shows beside the large one, so a layout that hides them says so. */
async function shot(name) {
  await g.shot(name)
  const smalls = await page.evaluate(() =>
    document.querySelector('.curate-stage') === null ? null : [...document.querySelectorAll('.curate-slot.is-small')].filter((slot) => slot.getBoundingClientRect().width > 0).length,
  )
  if (smalls !== null) console.log(`${name}: ${smalls} small pictures shown`)
}
const files = join(OUT, 'files')
mkdirSync(files, { recursive: true })

/** The stage's readout, its band and its large picture, as words. */
const readout = () => text('.curate-readout')
const band = () => page.evaluate(() => document.querySelector('.curate-band:not(.hidden)')?.textContent?.replace(/\s+/g, ' ').trim() ?? null)
const large = () => page.evaluate(() => document.querySelector('.curate-slot.is-large')?.getAttribute('data-slot') ?? null)
const history = () =>
  page.evaluate(() => [...document.querySelectorAll('.curate-history-row, .edit-history-row')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()))
const listNames = () => page.evaluate(() => [...document.querySelectorAll('.curate-row-genome .curate-row-name')].map((node) => node.textContent))

/** Wait until the stage has read the contacts and counted. */
async function counted() {
  for (let i = 0; i < 240; i++) {
    await sleep(250)
    const state = await page.evaluate(() => document.querySelector('.curate-stage')?.getAttribute('data-contacts'))
    const weighing = /weighing/.test((await readout()) ?? '')
    if (state === 'read' && !weighing) break
  }
  await sleep(600)
}

// The session: the genomes table, the heading's word as in the file.
await g.openWithDev(`?config=${g.base}/${CONFIG}`)
await page.evaluate(() => {
  for (const key of Object.keys(localStorage)) if (key.includes(':map:curation')) localStorage.removeItem(key)
})
await sleep(9000)
console.log('heading word:', await text('.crumb-genomes'))
await shot('cu01-session')

// The stage, from the palette.
await page.keyboard.press('Control+p')
await sleep(400)
await page.keyboard.type('Curate the genomes')
await sleep(400)
await page.keyboard.press('Enter')
await page.waitForSelector('.curate-stage', { timeout: 30_000 })
await sleep(200)
console.log('opening:', await text('.curate-status'))
await shot('cu02-reading')
await counted()
console.log('title:', await text('.modal-curate .modal-title'))
console.log('readout:', await readout())
console.log('list, first rows:', (await listNames()).slice(0, 8))
console.log('large:', await large())
await shot('cu03-stage')

// A genome under the pointer, lit in every part.
const firstRow = await page.$('.curate-row-genome')
if (firstRow !== null) {
  await firstRow.hover()
  await sleep(300)
  console.log('hover says:', await readout())
  await shot('cu04-lit')
}

// One organism's fragments: B. cereus is MM133_metator_00700_*.
await page.fill('.curate-filter', '00700_')
await sleep(300)
await page.click('.curate-filter-note .btn-link').catch(() => console.log('no "select them"'))
await sleep(500)
console.log('selection:', await page.evaluate(() => document.querySelector('[data-card="selection"]')?.textContent?.replace(/\s+/g, ' ').slice(0, 300)))
// The run of three named once on each bar, its count kept: `00700_00001 +2`.
console.log('plates:', await page.evaluate(() => document.querySelector('.curate-contact-overlay')?.dataset.plates ?? null))
await shot('cu05-one-organism')
await page.fill('.curate-filter', '')
await sleep(200)
// The selection let go of, so review's pictures show the question alone.
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await sleep(300)

// Review: the questions, each with its price.
await page.click('[data-mode="review"]')
await sleep(1500)
console.log('band:', await band())
console.log('large in review:', await large())
await shot('cu06-review')
await page.keyboard.down(' ')
await sleep(1200)
await shot('cu07-as-it-would-be')
await page.keyboard.up(' ')
await sleep(300)
await page.keyboard.press('y')
await counted()
console.log('after Y, readout:', await readout())
console.log('band:', await band())
await shot('cu08-taken')
await page.keyboard.press('n')
await counted()
console.log('after N, band:', await band())
console.log('history:', await history())

// A host question in review: → until the band asks one, the host map large.
for (let k = 0; k < 80; k++) {
  // The question's own words: the band's spans run together in its text.
  if (/^(link|unlink) /.test((await text('.curate-band-words')) ?? '')) break
  await page.keyboard.press('ArrowRight')
  await sleep(120)
}
await sleep(800)
console.log('host question:', await band())
console.log('large on a host question:', await large())
await shot('cu08b-host-question')

// The host map and the scatter large.
await page.click('[data-mode="manual"]')
await sleep(300)
await page.keyboard.press('2')
await sleep(800)
console.log('large:', await large())
await shot('cu09-hosts')
// An element selected: the host map around it.
await page.fill('.curate-filter', 'MGE_00003')
await sleep(400)
const element = await page.$('.curate-row-genome[data-genome^="MetaTOR_MGE_"]')
if (element !== null) {
  await element.click()
  await sleep(300)
  await page.click('.curate-host-scope [data-scope="selection"], button:has-text("around the selection")').catch(() => console.log('no "around the selection"'))
  await sleep(800)
  console.log('host map around:', await text('[data-pane="hosts"] .curate-host-head, [data-pane="hosts"] header'))
  await shot('cu09b-hosts-around')
}
await page.fill('.curate-filter', '')
await page.keyboard.press('Escape')
await sleep(300)
await page.keyboard.press('3')
await sleep(800)
console.log('large:', await large())
await shot('cu10-scatter')

// A lasso on the scatter: a small loop in the middle of its plot.
const scatter = await page.$('.curate-slot.is-large [data-pane="scatter"] canvas:last-of-type')
if (scatter !== null) {
  const box = await scatter.boundingBox()
  if (box !== null) {
    const cx = box.x + box.width * 0.45
    const cy = box.y + box.height * 0.45
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2
      await page.mouse.move(cx + Math.cos(a) * 60, cy + Math.sin(a) * 40)
      await sleep(15)
    }
    await page.mouse.up()
    await sleep(500)
    console.log('lasso selected:', await page.evaluate(() => document.querySelector('[data-card="selection"] .edit-card-head')?.textContent))
    await shot('cu11-lasso')
  }
}

// Move to…: the chooser, ranked.
await page.keyboard.press('m')
await sleep(600)
await shot('cu12-chooser')
await page.keyboard.press('Escape')
await sleep(300)

// The close-up of a genome's contigs.
await page.keyboard.press('1')
await sleep(400)
await page.click('.curate-row-genome')
await sleep(200)
await page.keyboard.press('Enter')
await sleep(2500)
await shot('cu13-close-up')
await page.keyboard.press('Shift+Enter')
await sleep(500)

// Auto: the sure questions taken, what would lower a grade held back.
await page.click('[data-mode="auto"]')
await sleep(500)
await shot('cu14-auto')
const apply = await page.$('.curate-suggestions-apply, .curate-auto-apply')
if (apply !== null) {
  await apply.click()
  for (let i = 0; i < 240; i++) {
    await sleep(500)
    if (!(await page.evaluate(() => /applying/.test(document.querySelector('.curate-suggestions-card')?.textContent ?? '')))) break
  }
  await counted()
  console.log('after auto:', await readout())
  await shot('cu15-after-auto')
}
await page.click('[data-mode="manual"]')
await sleep(300)

// The exports: each table written, the save dialog stood aside.
await page.evaluate(() => {
  window.showSaveFilePicker = undefined
})
// A file the session cannot write yet — the FASTA, with no assembly's sequence loaded — is left alone.
for (const button of await page.$$('.curate-export-file:not([disabled])')) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }).catch(() => null), button.click()])
  if (download !== null) {
    const name = download.suggestedFilename()
    await download.saveAs(join(files, name))
    console.log('wrote', name)
  }
  await sleep(300)
}
const card = await page.$('.curate-export-card, [class*="curate-export"]')
if (card !== null) {
  await card.scrollIntoViewIfNeeded()
  await sleep(200)
  await card.screenshot({ path: join(OUT, 'cu16-export.png') })
  console.log('wrote cu16-export.png')
}

// The dark theme, and a narrow window.
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await sleep(800)
await shot('cu17-dark')
await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
await page.setViewportSize({ width: 1280, height: 800 })
await sleep(800)
await shot('cu18-narrow')
await page.setViewportSize({ width: 1600, height: 1000 })
await sleep(500)

// Closed: the session drawn through the curation.
await page.click('.modal-curate .btn-close')
await sleep(9000)
console.log('heading word:', await text('.crumb-genomes'))
await shot('cu19-session-curated')

// The dev features off: no stage, no word.
await page.goto(`${g.base}/?config=${g.base}/${CONFIG}`)
await sleep(6000)
await shot('cu20-dev-off')

writeFileSync(join(OUT, 'cu-log.txt'), `errors: ${JSON.stringify(g.errors)}\n`)
await g.close()
process.exit(0)
