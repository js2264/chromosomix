/**
 * The pictures of Your files → Opening files (`files/opening.md`):
 *
 * - **landing-ways-in** the landing page's three ways in: *Load files* with
 *   its drop area and the URL box behind *or a URL*, the four buttons of
 *   *Connect a local or remote folder*, and the data store tiles. The dev
 *   server is built without the site's Google and Dropbox keys, so the page is
 *   served the published site's own (`publishedKeys`) and shows the row
 *   chromosomix.app shows;
 * - **files-panel** the Files panel on a connected folder holding the yeast
 *   demo's files, its BAM offered beside the index it reads, which is dimmed.
 *   A headless browser cannot answer a folder dialog, so the dialog is stood in
 *   for, as `scripts/ui-files-routes.mjs` does: it hands back a real directory
 *   (in the origin's private file system) holding the demo's files, which the
 *   column then reads exactly as it reads a folder on disk.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/files-opening.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow, around } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/files-opening'
const FOLDER = 'yeast-microC'
/** The demo's own files, fetched from the dev server into the folder. */
const FILES = [
  'S288c_syn40-XIII.fa',
  'Yeast_ATAC.bw',
  'Yeast_ATAC.narrowPeak',
  'Yeast_ChIP_Pol2-vs-input.bw',
  'Yeast_ChIP_Pol2-vs-input.narrowPeak',
  'Yeast_ONT_basemods.sim.bam',
  'Yeast_ONT_basemods.sim.bam.bai',
  'Yeast_annotations.gtf',
  'Yeast_cytobands.txt',
  'Yeast_hic.hic',
  'Yeast_microC.chromosomix.json',
  'Yeast_microC_G2M_1kb.cool',
  'Yeast_microC_loops.tsv',
  'Yeast_reference.2bit',
  'Yeast_structure.g3d.gz',
]

;(async () => {
  const browser = await launch()

  {
    const w = await newWindow(browser, OUT, { published: true })
    const { page } = w
    await page.goto(`${BASE}/`)
    await page.waitForSelector('.view-picker .picker-stores .store-tile', { timeout: 60000 })
    await w.quiet()
    await sleep(1500)
    console.log('  folder row:', (await page.locator('.picker-providers').innerText()).replace(/\s+/g, ' '))
    await w.shot('landing-ways-in', { clip: await around(page, ['.picker-load', '.picker-providers', '.picker-stores'], 24) })
    await w.context.close()
  }

  {
    const w = await newWindow(browser, OUT)
    const { page, context } = w
    await context.addInitScript((name) => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
    }, FOLDER)
    await page.goto(`${BASE}/`)
    await page.waitForSelector('.view-picker', { timeout: 60000 })
    await page.evaluate(
      async ({ at, name, files }) => {
        const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
        for (const file of files) {
          const handle = await folder.getFileHandle(file, { create: true })
          const writable = await handle.createWritable()
          await writable.write(await (await fetch(`${at}/demo/yeast/${file}`)).arrayBuffer())
          await writable.close()
        }
      },
      { at: BASE, name: FOLDER, files: FILES },
    )
    await page.getByRole('button', { name: /^choose a folder/ }).first().click()
    await page.waitForSelector('.folder-entry', { timeout: 60000 })
    await sleep(2000)
    for (const row of await page.$$eval('.folder-entry', (rows) =>
      rows.map((r) => `${r.classList.contains('folder-entry-file') ? 'offered' : 'dimmed '} ${r.querySelector('.folder-entry-name')?.textContent} — ${r.getAttribute('title') ?? ''}`),
    ))
      console.log('  ', row)
    // The column widened by its inner edge, as a reader drags it, so that no
    // name breaks in two; then the pointer on the BAM's row, whose two marks
    // show under it, the dimmed index below.
    const handle = await page.evaluate(() => {
      const column = document.querySelector('.folder-entry').closest('.panel-column')
      const r = column.querySelector('.panel-column-handle').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    await page.mouse.move(handle.x, handle.y)
    await page.mouse.down()
    for (let k = 1; k <= 10; k++) {
      await page.mouse.move(handle.x + 16 * k, handle.y)
      await sleep(30)
    }
    await page.mouse.up()
    await sleep(1200)
    await page.hover('.folder-entry:has(.folder-entry-name:text-is("Yeast_ONT_basemods.sim.bam"))')
    await sleep(800)
    // The column, from its heading to the foot of the window.
    const column = await page.evaluate(() => {
      const r = document.querySelector('.folder-entry').closest('.panel-column').getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    })
    await w.shot('files-panel', { clip: column }, { keepPointer: true })
    await w.shot('files-panel-window', {}, { keepPointer: true })
    await w.context.close()
  }

  await browser.close()
})()
