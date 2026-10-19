/**
 * Where a dropped file lands, and the doors to one (§5.5, §16.9, §20.5, §24.2),
 * in headless Chromium:
 *
 * - **the header's `+`**, before back: on the landing page, and on a tab a
 *   cooler was dropped into — no folder connected, so no Files column — with
 *   its tooltip, the dialog it opens (the landing page's *Load files*: the drop
 *   area that also chooses, and the URL box under it), and a second map and a
 *   bigWig added through the box, the map as a deck;
 * - **a Files row** — a folder on this machine, stood in for by a directory of
 *   the origin-private file system — let go on the second map's lanes rather
 *   than on one of its rectangles, and on a tracks cell: the cell outlined
 *   while the file is in the air, and the track drawn in that cell;
 * - **a store's row** — a store this script writes under `gallery/`, its files
 *   the yeast demo's on this server — dragged out of the drawer onto the same
 *   two cells, and its saved workspace's row, which does not drag; then a map
 *   row let go on a new tab's landing page, opened under the store's name.
 *
 * Every drag is a real one, the mouse moved in steps as a hand moves it: a cell
 * that refuses `dragover` never gets a drop, and one that is lit only after the
 * pointer arrives is lit too late for a release in the same instant. The
 * in-the-air shots are taken with the button still down. It prints the `+`'s
 * tooltip, the dialog's controls, the store rows that drag, and per cell after
 * every drop the thickness of each lane stack — a stack that gains a track is
 * thicker — so a track that landed on the first map is a line in the log.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-deck-drops.mjs [out-dir]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page, base, browser, errors } = await gallery(OUT, { width: 1600, height: 1000 })
const YEAST = `${base}/demo/yeast`

// A store of the demo's files, served from beside it: the drawer reads it as it
// reads any store at an address (§24.2).
mkdirSync('gallery', { recursive: true })
const STORE = 'gallery/_drops-store.json'
writeFileSync(
  STORE,
  JSON.stringify(
    {
      kind: 'chromosomix.store',
      version: 1,
      name: 'Yeast demo files',
      columns: [{ key: 'assay', label: 'Assay' }],
      entries: [
        { label: 'Pol II ChIP over input', uri: `${YEAST}/Yeast_ChIP_Pol2-vs-input.bw`, kind: 'genome', fields: { assay: 'ChIP-seq' } },
        { label: 'RNA-seq, forward strand', uri: `${YEAST}/Yeast_RNA_fwd.bw`, kind: 'genome', fields: { assay: 'RNA-seq' } },
        { label: 'RNA-seq, reverse strand', uri: `${YEAST}/Yeast_RNA_rev.bw`, kind: 'genome', fields: { assay: 'RNA-seq' } },
        { label: 'micro-C, G2/M', uri: `${YEAST}/Yeast_microC_G2M_1kb.cool`, kind: 'map', fields: { assay: 'micro-C' } },
        { label: 'The micro-C demo, saved', uri: `${YEAST}/Yeast_microC.chromosomix.json`, kind: 'workspace' },
      ],
    },
    null,
    1,
  ),
)

// The folder dialog, answered with `run2` in the origin-private file system;
// and the store drawer as narrow as a reader drags its edge to, beside the deck
// — at its default it lies over two of the three cells. Kept, as a drag of the
// edge keeps it, in `localStorage`, which the drawer reads once it is built.
await page.context().addInitScript(() => {
  window.showDirectoryPicker = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle('run2', { create: true })
  window.showSaveFilePicker = undefined
  window.localStorage.setItem('chromosomix:store-drawer:width', '560')
})

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const shotOf = async (selector, name, pad = 6) => {
  const box = await page.locator(selector).first().boundingBox()
  if (box === null) {
    console.log('nothing to shoot for', name)
    return
  }
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad },
  })
  console.log('shot', name)
}

/** The grid in reading order, and per cell the thickness of each lane stack it draws. */
const cells = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.deck-grid > .deck-panel')).map((cell) => {
      const name = cell.querySelector('.deck-name')
      const text = (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim()
      const kind = cell.classList.contains('deck-tracks') ? 'tracks' : cell.classList.contains('is-vacant') ? 'empty' : 'map'
      const stacks = {}
      for (const lane of cell.querySelectorAll('.lane-canvas')) {
        if (lane.classList.contains('hidden')) continue
        const edge = ['top', 'right', 'bottom', 'left'].find((side) => lane.classList.contains(`lane-${side}`)) ?? '?'
        const box = lane.getBoundingClientRect()
        const across = edge === 'top' || edge === 'bottom' ? box.height : box.width
        if (across > 0) stacks[edge] = Math.round(across)
      }
      const browser = cell.querySelector('.browser-canvas')
      const lanes = browser === null ? '' : ` lanes ${Math.round(browser.getBoundingClientRect().height)}px`
      return `${kind} ${text || '(lead)'}${Object.keys(stacks).length > 0 ? ' ' + JSON.stringify(stacks) : ''}${lanes}`
    }),
  )
const lit = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.deck-grid > .deck-panel.is-file-target')).map(
      (cell) => cell.querySelector('.deck-name')?.value ?? cell.className,
    ),
  )

/**
 * Take hold of `source` and carry it over `target` at `at` (a fraction of its
 * box) in steps, as a hand does; the button stays down until `release`.
 */
async function carry(source, target, at = { x: 0.5, y: 0.5 }) {
  const from = await source.boundingBox()
  const box = await target.boundingBox()
  if (from === null || box === null) throw new Error('nothing to carry or nowhere to carry it')
  const to = { x: box.x + box.width * at.x, y: box.y + box.height * at.y }
  const grip = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  await page.mouse.move(grip.x + 24, grip.y, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 24 })
  await sleep(250)
  await page.mouse.move(to.x + 3, to.y + 3, { steps: 3 })
  await sleep(400)
  return async () => {
    await page.mouse.up()
    // A drag ends with no pointer move of its own, and the page's hover is
    // where the hand was when it began until the next one: the hand is put
    // down in the status bar, where it says nothing over the picture.
    await page.mouse.move(8, 990)
    await sleep(5000)
  }
}

const plus = page.locator('.app-head .head-add')
/** Type an address into the `+`'s dialog and open it. */
async function addByUrl(url) {
  await plus.click()
  await sleep(600)
  await page.locator('.modal-panel input.input-url').fill(url)
  await page.locator('.modal-panel button', { hasText: /^open$/ }).click()
  await sleep(500)
}

try {
  // --- the header's + ------------------------------------------------------
  await page.goto(`${base}/?store=${encodeURIComponent(`${base}/${STORE}`)}`)
  await sleep(2500)
  // The drawer opens on the store the link names; it is put away for now.
  await page.keyboard.press('Escape')
  await sleep(600)
  console.log('landing: + says', JSON.stringify(await plus.getAttribute('title')))
  await shotOf('.app-head', 'dd01-header-plus-on-the-landing-page', 2)

  // A cooler dropped on the landing page, as most tabs begin: nothing is
  // connected, so there is no Files column, and the landing page is gone.
  await page.evaluate(async (url) => {
    const bytes = await (await fetch(url)).arrayBuffer()
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Yeast_microC_G2M_1kb.cool'))
    document.querySelector('.dropzone')?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  }, `${YEAST}/Yeast_microC_G2M_1kb.cool`)
  await page.waitForSelector('.input-region', { timeout: 120000 })
  await sleep(1500)
  const region = page.locator('.input-region').first()
  await region.fill('IV:1,000,001-1,400,000')
  await region.press('Enter')
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 120000 })
  await sleep(3000)
  console.log('a dropped cooler: + says', JSON.stringify(await plus.getAttribute('title')))
  console.log('Files column there:', await page.locator('.panel-files:not(.is-absent)').count())
  await plus.click()
  await sleep(800)
  console.log(
    'the dialog:',
    JSON.stringify(
      await page.evaluate(() => ({
        title: document.querySelector('.modal-title')?.textContent,
        zone: document.querySelector('.modal-panel .dropzone')?.textContent,
        rule: document.querySelector('.modal-panel .load-or')?.textContent,
        box: document.querySelector('.modal-panel input.input-url')?.getAttribute('placeholder'),
      })),
    ),
  )
  await shot('dd02-plus-dialog-on-a-dropped-cooler')
  await page.keyboard.press('Escape')
  await sleep(400)

  // A second map, then a bigWig, typed into it: the map beside, the track under.
  await addByUrl(`${YEAST}/Yeast_hic.hic`)
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid > .deck-panel').length >= 2, null, { timeout: 120000 })
  await addByUrl(`${YEAST}/Yeast_ATAC.bw`)
  await sleep(6000)
  console.log('after the + twice:', JSON.stringify(await cells()))
  await shot('dd03-a-map-and-a-track-added-by-url')

  // --- a Files row on a cell ----------------------------------------------
  await page.evaluate(async (at) => {
    const run2 = await (await navigator.storage.getDirectory()).getDirectoryHandle('run2', { create: true })
    for (const name of ['Yeast_MNase.bw', 'Yeast_Shotgun.bw']) {
      const writable = await (await run2.getFileHandle(name, { create: true })).createWritable()
      await writable.write(await (await fetch(`${at}/${name}`)).arrayBuffer())
      await writable.close()
    }
  }, YEAST)
  await page.keyboard.press('Control+P')
  await sleep(400)
  await page.keyboard.type('connect a local')
  await sleep(300)
  await page.keyboard.press('Enter')
  await sleep(1000)
  await page.locator('.modal-panel button', { hasText: /choose a folder/ }).first().click()
  await sleep(2000)
  // A tracks cell, from the deck's bar.
  await page.click('.deck-add-toggle')
  await page.click('.deck-add-tracks')
  await page.waitForFunction(() => document.querySelector('.deck-grid > .deck-tracks') !== null, null, { timeout: 20000 })
  await sleep(3000)
  console.log('the deck:', JSON.stringify(await cells()))

  const row = (name) => page.locator('.folder-entry', { hasText: name }).first()
  const second = page.locator('.deck-grid > .deck-panel').nth(1)
  const tracks = page.locator('.deck-grid > .deck-tracks').first()

  // Under the second map, on its lanes — not on a rectangle.
  let release = await carry(row('Yeast_MNase.bw'), second, { x: 0.5, y: 0.93 })
  console.log('MNase in the air, lit:', JSON.stringify(await lit()))
  await shot('dd04-files-row-over-the-second-map')
  await release()
  console.log('MNase let go on the second map:', JSON.stringify(await cells()))
  await shot('dd05-files-row-on-the-second-map')

  release = await carry(row('Yeast_Shotgun.bw'), tracks, { x: 0.5, y: 0.6 })
  console.log('Shotgun in the air, lit:', JSON.stringify(await lit()))
  await shot('dd06-files-row-over-the-tracks-cell')
  await release()
  console.log('Shotgun let go on the tracks cell:', JSON.stringify(await cells()))
  await shot('dd07-files-row-in-the-tracks-cell')

  // --- a store's row on a cell ---------------------------------------------
  await page.locator('.app-head button[title^="Open the stores"]').first().click()
  await page.waitForSelector('.portal-row', { timeout: 60000 })
  await sleep(1500)
  console.log(
    'store rows that drag:',
    JSON.stringify(
      await page.$$eval('.portal-row', (rows) =>
        rows.map((node) => `${node.querySelector('.portal-name')?.textContent}: ${node.draggable}`),
      ),
    ),
  )
  await shot('dd08-store-drawer-beside-the-deck')

  const storeRow = (name) => page.locator('.portal-row', { hasText: name }).first()
  release = await carry(storeRow('Pol II ChIP'), second, { x: 0.5, y: 0.05 })
  console.log('Pol II in the air, lit:', JSON.stringify(await lit()))
  await shot('dd09-store-row-over-the-second-map')
  await release()
  console.log('Pol II let go on the second map:', JSON.stringify(await cells()))
  await shot('dd10-store-row-on-the-second-map')

  release = await carry(storeRow('RNA-seq, forward'), tracks, { x: 0.5, y: 0.5 })
  await release()
  console.log('RNA let go on the tracks cell:', JSON.stringify(await cells()))
  await page.keyboard.press('Escape')
  await sleep(800)
  await shot('dd11-store-row-in-the-tracks-cell')

  // --- a store's row on a landing page ---------------------------------------
  // A new tab, and the map row let go on its *Load files*: opened there under
  // the store's name for it, which the address alone did not carry.
  await page.locator('.tabstrip .tab-new').click()
  await page.waitForSelector('.view-picker .dropzone', { timeout: 20000 })
  await sleep(800)
  await page.locator('.app-head button[title^="Open the stores"]').first().click()
  await page.waitForSelector('.portal-row', { timeout: 60000 })
  await sleep(800)
  release = await carry(storeRow('micro-C, G2/M'), page.locator('.view-picker .dropzone').first(), { x: 0.8, y: 0.5 })
  await release()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('.view-picker') === null, null, { timeout: 120000 }).catch(() => {})
  await sleep(3000)
  console.log(
    'a store row on a landing page opened as:',
    JSON.stringify(await page.$eval('.tabstrip .tab.is-active .tab-label', (label) => label.textContent)),
  )
  await shot('dd12-store-row-on-a-landing-page')
} finally {
  if (errors.length > 0) console.log('page errors:', JSON.stringify(errors.slice(0, 5)))
  await browser.close()
}
