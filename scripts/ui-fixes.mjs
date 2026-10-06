/**
 * The audited behaviours that a reader meets once and remembers, in headless
 * Chromium on the yeast demos — one shot each, with what each said printed to
 * stdout so a regression is a line in the log as well as a picture.
 *
 * The shortcuts dialog's map gestures (a sideways scroll slides along the
 * diagonal); the Chromosomes table's circular column, whose tooltip names ori
 * and the tasks that read a circle; a block of two stretches of one sequence
 * scrolled sideways, which moves both axes by one distance and keeps its
 * separation; the resolution dialog refusing a thirteenth added rung; a
 * picker tab's status bar, which has no read and no validation to offer; a
 * variant lane's right-click menu with the point switch its card has; a
 * `.hic`'s normalisation on the File card; the single map closed into the 1D
 * browser with the Manual annotations card there; what Pattern detection, APA
 * under chromosight's normalisation and Compartments say they will read; the
 * palette's Annotations row live on a metacool; and an embed's landing page and
 * palette, which offer no folder, no stores and no column it does not mount.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-fixes.mjs [out-dir]     # fx01 … fx17
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT, { width: 1920, height: 1100 })
const { page, shot } = g
const COOL = `${g.base}/demo/yeast/Yeast_microC_G2M_1kb.cool`

/** A page of its own: a tab the app would otherwise restore stays out of it. */
async function fresh(url, { width = 1920, height = 1100 } = {}) {
  const context = await g.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  const tab = await context.newPage()
  tab.on('pageerror', (e) => g.errors.push(String(e)))
  await tab.goto(url)
  return tab
}
const save = async (tab, name) => {
  await tab.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`wrote ${name}.png`)
}
const hashRegions = (tab) =>
  tab.evaluate(() => {
    const hash = new URLSearchParams(location.hash.slice(1))
    return `${hash.get('region')} × ${hash.get('region2')}`
  })

// ---- the shortcuts dialog --------------------------------------------------
await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.metacooler.json`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(6000)
await page.keyboard.press('?')
await sleep(900)
const gestures = await page.$$eval('.shortcut-gestures .shortcut-row', (rows) =>
  rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '').filter((text) => /sideways|Shift|diagonal|lane|edge/i.test(text)),
)
console.log('shortcuts, the map gestures:', gestures)
await shot('fx01-shortcuts')
await page.keyboard.press('Escape')
await sleep(400)

// ---- the circular column's tooltip -----------------------------------------
await page.keyboard.press('c')
await sleep(2000)
const circularTitle = await page.evaluate(() => {
  for (const node of document.querySelectorAll('[title]')) {
    if (/joins its own ends/.test(node.getAttribute('title') ?? '')) return node.getAttribute('title')
  }
  return null
})
console.log('circular column tooltip:', circularTitle)
await shot('fx02-chromosomes-circular')

// ---- the resolution dialog at twelve added rungs ---------------------------
await page.goto(`${g.base}/#uri=${COOL}&view=region&region=IV:1000000-1400000`)
await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(4000)
for (const kb of [2, 3, 4, 5, 6, 8, 10, 16, 20, 25, 32, 50]) {
  await page.click('.res-add')
  await sleep(400)
  const box = page.locator('.modal-panel .res-ask')
  await box.fill(String(kb))
  await box.dispatchEvent('input')
  await page.locator('.modal-panel input.res-unit-radio[value="kb"]').check().catch(() => {})
  await sleep(150)
  await page.locator('.modal-panel .modal-actions button', { hasText: /^add$/ }).click()
  await sleep(500)
}
console.log('rungs added:', await page.locator('.res-stop.res-added').count())
await page.click('.res-add')
await sleep(600)
console.log('the dialog says:', await page.locator('.modal-panel .res-verdict').textContent(), '· add disabled:', await page.locator('.modal-panel .modal-actions button').first().isDisabled())
await shot('fx03-thirteenth-rung')
await page.keyboard.press('Escape')
await sleep(400)

// ---- a picker tab's status bar ---------------------------------------------
await page.keyboard.press('o')
await sleep(1200)
await page.keyboard.press('Control+Comma')
await sleep(1500)
await page.keyboard.press('Control+Period')
await sleep(1500)
console.log(
  'status bar on the picker tab:',
  (await page.$$eval('.status-item', (all) => all.filter((one) => one.offsetParent !== null).map((one) => one.querySelector('.status-key')?.textContent ?? one.textContent?.trim().slice(0, 20)))).join(' · '),
)
await shot('fx04-picker-status-bar')

// ---- a block of two stretches of one sequence, scrolled sideways ----------
const block = await fresh(`${g.base}/#uri=${COOL}&view=region&region=IV:200000-400000&region2=IV:600000-800000&transform=log10&balance=true`)
await block.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(6000)
console.log('off-diagonal block:', await hashRegions(block))
// Zoomed in first: a block fitted whole has nowhere to slide to.
const canvas = await block.locator('.heatmap-canvas').first().boundingBox()
const centre = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }
await block.mouse.move(centre.x, centre.y)
for (let k = 0; k < 4; k++) {
  await block.mouse.wheel(0, -240)
  await sleep(150)
}
await sleep(2500)
/** What the status bar says about the bin under the pointer. */
const under = async () => {
  await block.mouse.move(centre.x + 1, centre.y)
  await sleep(150)
  await block.mouse.move(centre.x, centre.y)
  await sleep(400)
  return (await block.locator('.status-coords').first().textContent())?.trim()
}
console.log('under the pointer, before:', await under())
await save(block, 'fx05-cis-block-before')
for (let k = 0; k < 12; k++) {
  await block.mouse.wheel(60, 0)
  await sleep(40)
}
await sleep(2500)
// Rows and columns moved by one distance: the separation under the pointer is
// the one it was, where a slide of the columns alone changed it.
console.log('under the pointer, after a sideways scroll:', await under())
await save(block, 'fx06-cis-block-slid')
await block.context().close()

// ---- a variant lane's right-click menu --------------------------------------
const variants = await fresh(`${g.base}/#uri=${COOL}&view=region&region=IV:1000000-1400000&transform=log10&balance=true`)
await variants.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(4000)
await variants.click('button[title^="Show the Annotations panel"]').catch(() => {})
await sleep(800)
const vcf = [
  '##fileformat=VCFv4.2',
  '##contig=<ID=IV,length=1531933>',
  '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
  ...[1_020_001, 1_061_500, 1_120_250, 1_180_000, 1_201_001, 1_255_555, 1_300_123, 1_352_000].map(
    (pos, k) => `IV\t${pos}\tv${k + 1}\tA\t${k % 2 === 0 ? 'G' : 'AT'}\t60\tPASS\t.`,
  ),
].join('\n')
await variants.evaluate((text) => {
  // The Tracks card's zone, not the Contact maps card's above it, which would
  // take the file for a map.
  const zone = [...document.querySelectorAll('.ann-drop')].find((node) => /Load a track/.test(node.textContent ?? ''))
  const transfer = new DataTransfer()
  transfer.items.add(new File([text], 'calls.vcf', { type: 'text/plain' }))
  for (const kind of ['dragenter', 'dragover', 'drop']) zone?.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
}, `${vcf}\n`)
await sleep(3000)
const lanes = await variants.locator('.lane-canvas.lane-bottom').first().boundingBox()
if (lanes !== null) {
  await variants.mouse.click(lanes.x + lanes.width * 0.5, lanes.y + lanes.height - 6, { button: 'right' })
  await sleep(700)
  console.log('variant lane menu:', (await variants.locator('.context-menu, .menu').first().textContent().catch(() => ''))?.replace(/\s+/g, ' ').slice(0, 300))
}
await save(variants, 'fx07-variant-lane-menu')
await variants.keyboard.press('Escape')
await variants.context().close()

// ---- a .hic's normalisation on the File card --------------------------------
const hic = await fresh(`${g.base}/#uri=${g.base}/demo/yeast/Yeast_hic.hic&view=region&region=IV:1000000-1400000`)
await hic.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(5000)
const fileCard = (await hic.locator('.info-panel').first().textContent())?.replace(/\s+/g, ' ') ?? ''
console.log('File card, normalisation:', /normalisation ?\S+/.exec(fileCard)?.[0] ?? 'not named')
await save(hic, 'fx08-hic-file-card')
await hic.context().close()

// ---- the single map closed into the 1D browser ------------------------------
const closing = await fresh(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.metacooler.json`)
await closing.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(5000)
await closing.click('button[title^="Show the Annotations panel"]').catch(() => {})
await sleep(800)
const closer = closing.locator('button[title*="keep browsing its genome as tracks"]').first()
if (await closer.count()) {
  await closer.scrollIntoViewIfNeeded()
  await closer.click()
  await closing.waitForSelector('.browser-canvas, .view-browser', { timeout: 60000 }).catch(() => console.log('no browser after the close'))
  await sleep(4000)
  await closing.click('button[title^="Show the Annotations panel"]').catch(() => {})
  await sleep(800)
  const cards = await closing.$$eval('.annotation-card .card-head, .controls-card .controls-title', (all) => all.map((one) => one.textContent?.trim()))
  console.log('cards in the browser:', cards)
} else {
  console.log('no close button on the Contact maps card')
}
await save(closing, 'fx09-closed-into-browser')
await closing.context().close()

// ---- three tasks' forms: what each says it will read ------------------------
const tasks = await fresh(`${g.base}/?config=${g.base}/demo/yeast/Yeast_microC.metacooler.json`)
await tasks.waitForSelector('.heatmap-canvas', { timeout: 120000 })
await sleep(5000)
await tasks.click('button[title^="Show the Analysis panel"]').catch(() => {})
await sleep(800)
const form = async (title, name, setUp = async () => {}) => {
  await tasks.keyboard.press('Escape')
  await sleep(500)
  await tasks.locator('.analysis-row-title', { hasText: title }).first().click()
  await sleep(1200)
  await setUp()
  await sleep(600)
  console.log(`${title}, its price:`, (await tasks.locator('.analysis-cost').first().textContent())?.trim())
  await save(tasks, name)
}
// Pattern detection prices the band along each diagonal, not the square.
await form('Pattern detection', 'fx14-pattern-detection-price')
// Compartments' hint names both readings of its sequences.
await form('Compartments', 'fx15-compartments-hint', async () => {
  const formText = (await tasks.locator('.analysis-form').first().textContent())?.replace(/\s+/g, ' ') ?? ''
  console.log('Compartments, the sequences hint:', /One correlation per sequence[^.]*\./.exec(formText)?.[0] ?? 'not found')
})
// APA under chromosight's normalisation, over the demo's loops: a band, in words.
await form('Aggregate peak analysis', 'fx16-apa-chromosight-price', async () => {
  const field = tasks.locator('.analysis-form .field').filter({ has: tasks.locator('.field-label', { hasText: /^normalisation$/i }) }).first()
  const select = field.locator('select').first()
  if (await select.count()) await select.selectOption('chromosight')
  else await field.locator('button', { hasText: /chromosight/i }).first().click().catch(() => {})
})
console.log('clip box tooltip:', await tasks.locator('.clip-box').first().getAttribute('title').catch(() => null))
await tasks.context().close()

// ---- the palette's Annotations row on a metacool --------------------------------
const metacool = await fresh(`${g.base}/`)
await metacool.evaluate(() => localStorage.setItem('metacooler-viewer:dev-features', 'on'))
await metacool.goto(`${g.base}/?config=${g.base}/demo/metagenomics/mock-community/Mock_microbial_community.metacooler.json`)
await metacool.waitForSelector('.view-genomes .tr', { timeout: 120000 }).catch(() => console.log('no genomes table'))
await sleep(2500)
await metacool.keyboard.press('Control+p')
await sleep(600)
await metacool.keyboard.type('annotations panel')
await sleep(600)
console.log(
  'metacool palette, Annotations panel:',
  await metacool.$$eval('.palette-row', (rows) =>
    rows.filter((row) => /Annotations panel/.test(row.textContent ?? '')).map((row) => `${row.classList.contains('disabled') ? 'greyed' : 'live'} — ${row.querySelector('.palette-hint')?.textContent ?? ''}`),
  ),
)
await save(metacool, 'fx17-metacool-annotations-row')
await metacool.context().close()

// ---- the stores, named once ---------------------------------------------------
await page.goto(`${g.base}/`)
await sleep(2500)
console.log('stores toggle:', await page.locator('button[title*="tore"]').first().getAttribute('title').catch(() => null))
await page.keyboard.press('Control+p')
await sleep(600)
await page.keyboard.type('stores')
await sleep(600)
await shot('fx10-palette-stores')
await page.keyboard.press('Escape')

// ---- an embed's landing page and palette -------------------------------------
const embed = await fresh(`${g.base}/?embed=1`, { width: 1000, height: 640 })
await sleep(4000)
console.log('embed landing:', (await embed.locator('body').textContent())?.replace(/\s+/g, ' ').slice(0, 200))
await save(embed, 'fx11-embed-landing')
await embed.keyboard.press('Control+p')
await sleep(700)
const greyed = await embed.$$eval('.palette-row.disabled .palette-title', (rows) => rows.map((row) => row.textContent?.trim()))
console.log('embed palette, greyed:', greyed)
await save(embed, 'fx12-embed-palette')
await embed.keyboard.type('folder')
await sleep(500)
await save(embed, 'fx13-embed-palette-folder')
await embed.context().close()

await g.close()
