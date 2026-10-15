/**
 * Folders kept by the installed app, and a workspace's files found in them
 * again (§20.6), end to end.
 *
 * Headless Chromium has no install and no native folder dialog, so both are
 * stood in for: the app is told it is open as an installed app (the display
 * mode a browser opens one in), and the folder dialog hands back a directory
 * of the origin-private file system holding the yeast demo's map and ATAC
 * track as `run2/hic/…` and `run2/chip/…` — a real directory handle, read by
 * the same code a folder on disk is.
 *
 * - **installed**: `run2` connected, the map opened from it and the ATAC added
 *   as a track, the workspace saved (its `folders` printed); then a fresh
 *   window of the same app, `run2` still in the Files column, and the
 *   workspace dropped — the map and its track opened with nobody asked;
 * - **another installation**: the same workspace dropped where `run2` is not
 *   connected — the note naming it, with a button that connects it — and then
 *   the map, found there;
 * - **a browser tab**: `run2` connected *for this visit*, and gone after a
 *   reload.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-installed-folders.mjs [out-dir]
 */

import { mkdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const FILES = join(OUT, 'files')
mkdirSync(FILES, { recursive: true })
const { page: first, close, base, browser } = await gallery(OUT, { width: 1600, height: 1000 })
await first.close()

/** Open as an installed app: the display mode a browser opens one in. */
const asApp = () => {
  const original = window.matchMedia.bind(window)
  window.matchMedia = (query) =>
    query === '(display-mode: standalone)'
      ? {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => false,
        }
      : original(query)
}
/** The folder dialog, answered with `run2` in the origin-private file system; saves download. */
const withFolder = () => {
  window.showDirectoryPicker = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle('run2', { create: true })
  window.showSaveFilePicker = undefined
}

async function contextFor(app) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
  if (app) await context.addInitScript(asApp)
  await context.addInitScript(withFolder)
  return context
}

/** Put the demo's map and ATAC track into `run2`, as a pipeline would have. */
const fill = (page) =>
  page.evaluate(async (at) => {
    const root = await navigator.storage.getDirectory()
    const run2 = await root.getDirectoryHandle('run2', { create: true })
    const put = async (dir, name) => {
      const folder = await run2.getDirectoryHandle(dir, { create: true })
      const handle = await folder.getFileHandle(name, { create: true })
      const writable = await handle.createWritable()
      await writable.write(await (await fetch(`${at}/demo/yeast/${name}`)).arrayBuffer())
      await writable.close()
    }
    await put('hic', 'Yeast_microC_G2M_1kb.cool')
    await put('chip', 'Yeast_ATAC.bw')
  }, base)

const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('wrote', `${name}.png`)
}
const folders = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.files-folder')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()),
  )
const mapDrawn = (page) =>
  page.evaluate(() => document.querySelector('.heatmap-canvas') !== null && !document.body.textContent.includes('Opening '))
const tracks = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.ann-name, .track-name')].map((n) => (n instanceof HTMLInputElement ? n.value : n.textContent)))
const press = async (page, text) => {
  await page.getByRole('button', { name: text }).first().click()
  await sleep(1500)
}
const row = (page, name) => page.locator('.folder-entry', { hasText: name }).first()
/** Drop a file on the landing page's drop zone, as a reader drags one there. */
const drop = (page, name, text) =>
  page.evaluate(
    ({ name, text }) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([text], name, { type: 'application/json' }))
      const zone = document.querySelector('.dropzone')
      zone?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
    },
    { name, text },
  )

try {
  // --- installed -----------------------------------------------------------
  const app = await contextFor(true)
  let page = await app.newPage()
  await page.goto(`${base}/`)
  await sleep(2500)
  await fill(page)
  await press(page, 'choose a folder…')
  console.log('installed, connected:', JSON.stringify(await folders(page)))
  await row(page, 'hic/').click()
  await sleep(800)
  await row(page, 'Yeast_microC_G2M_1kb.cool').click()
  // A local cooler opens on its table of sequences; a window of IV is the map.
  await page.waitForSelector('.input-region', { timeout: 120000 })
  await sleep(1500)
  const box = page.locator('.input-region').first()
  await box.fill('IV:1,000,001-1,400,000')
  await box.press('Enter')
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 120000 })
  await sleep(4000)
  await page.locator('.folder-crumbs .btn-link', { hasText: 'run2' }).first().click()
  await sleep(800)
  await row(page, 'chip/').click()
  await sleep(800)
  await row(page, 'Yeast_ATAC.bw').locator('.row-verb-add').click()
  await sleep(5000)
  await shot(page, 'if01-app-folder')
  const saving = page.waitForEvent('download', { timeout: 60000 })
  await page.locator('button[title^="Save every tab as a file"]').click()
  const saved = await saving
  const workspace = join(FILES, 'if02-workspace.json')
  copyFileSync(await saved.path(), workspace)
  const text = readFileSync(workspace, 'utf8')
  console.log('workspace folders:', JSON.stringify(JSON.parse(text).tabs.map((tab) => tab.folders)))

  // A fresh window of the same app: the folder is still there, and the
  // workspace finds its files in it.
  await page.close()
  page = await app.newPage()
  await page.goto(`${base}/`)
  await sleep(3000)
  console.log('next window, kept folders:', JSON.stringify(await folders(page)))
  await drop(page, 'yeast.chromosomix.json', text)
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 120000 }).catch(() => {})
  await sleep(6000)
  console.log('reopened: map drawn', await mapDrawn(page), 'tracks', JSON.stringify(await tracks(page)))
  await shot(page, 'if03-reopened')
  await app.close()

  // --- another installation ----------------------------------------------------
  const other = await contextFor(true)
  page = await other.newPage()
  await page.goto(`${base}/`)
  await sleep(2500)
  await fill(page)
  await drop(page, 'yeast.chromosomix.json', text)
  await sleep(3000)
  console.log('another installation asks:', await page.evaluate(() => document.querySelector('.folders-asked')?.textContent ?? null))
  await shot(page, 'if04-asks-for-folder')
  await page.locator('.folders-asked button').first().click()
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 120000 }).catch(() => {})
  await sleep(6000)
  console.log('found there: map drawn', await mapDrawn(page), 'tracks', JSON.stringify(await tracks(page)))
  await shot(page, 'if05-found-in-folder')
  await other.close()

  // --- a browser tab ------------------------------------------------------
  const tab = await contextFor(false)
  page = await tab.newPage()
  await page.goto(`${base}/`)
  await sleep(2500)
  await fill(page)
  await press(page, 'choose a folder (this visit)…')
  console.log('tab, connected:', JSON.stringify(await folders(page)))
  await shot(page, 'if06-tab-this-visit')
  await page.reload()
  await sleep(3000)
  console.log('tab, after a reload:', JSON.stringify(await folders(page)))
  await tab.close()
} finally {
  await close()
}
