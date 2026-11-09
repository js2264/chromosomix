/**
 * The pictures of Your files → Tracks and features (`files/tracks.md`):
 *
 * - **tracks-card** the yeast micro-C cooler on IV:1,200,001-1,340,000 with
 *   three files dropped on the Tracks card's *Load a track* — the ATAC bigWig,
 *   the GTF of genes and the simulated nanopore BAM with its index — the card's
 *   four rows (a BAM is two: its depth and its reads) beside the lanes drawn
 *   under the map;
 * - **bam-reads** the human chrX demo's RNA-seq BAM (Geuvadis, GBR
 *   ERR188428) dropped with its index on a 1D browser over hg19's bands and
 *   genes, at RPL10 where every read carries the same substitution: the depth
 *   row, the reads row with its mismatches coloured from the reads' `MD` tags,
 *   and the card a click on a read opens.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/files-tracks.cjs [out-dir]
 */

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { BASE, sleep, launch, newWindow, around } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/files-tracks'
const ROOT = join(__dirname, '..', '..', '..')
const YEAST = `${BASE}/demo/yeast`
const HUMAN = `${BASE}/demo/human`

;(async () => {
  const browser = await launch()

  {
    const w = await newWindow(browser, OUT)
    const { page } = w
    await page.goto(`${BASE}/#uri=${YEAST}/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1200000-1340000&balance=true&transform=log10`)
    await w.opened()
    await w.fold('Fold the General panel')
    await w.fold('Fold the Aesthetics panel')
    await w.fold('Show the Annotations panel')
    await w.drop(
      '.annotation-card .ann-drop',
      [`${YEAST}/Yeast_ATAC.bw`, `${YEAST}/Yeast_annotations.gtf`, `${YEAST}/Yeast_ONT_basemods.sim.bam`, `${YEAST}/Yeast_ONT_basemods.sim.bam.bai`],
      'Load a track',
    )
    await sleep(2000)
    await w.tracksRead(4)
    await w.quiet()
    await sleep(2500)
    for (const row of await page.$$eval('.annotation-card .ann-row', (rows) =>
      rows.map((r) => `${r.querySelector('input.ann-name')?.value} · ${r.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80)}`),
    ))
      console.log('  row:', row)
    // The Annotations panel and the map's column, cut after the heading's
    // second arrow so that no button is cut in two.
    const panel = await around(page, ['.panel-annotations'], 0)
    const right = await page.evaluate(() =>
      Math.max(
        document.querySelector('.heatmap-canvas').getBoundingClientRect().right + 24,
        ...[...document.querySelectorAll('button')].filter((b) => /half/i.test(b.title)).map((b) => b.getBoundingClientRect().right + 3),
      ),
    )
    await w.shot('tracks-card', { clip: { x: panel.x, y: panel.y, width: Math.round(right - panel.x), height: panel.height } })
    await w.context.close()
  }

  {
    const w = await newWindow(browser, OUT)
    const { page, context } = w
    // The demo's session with its bands and genes alone, served from here, so
    // the BAM comes in as a reader brings it: dropped, with its index.
    const session = JSON.parse(readFileSync(join(ROOT, 'demo/human/Human_chrX_RNA.chromosomix.json'), 'utf8'))
    const tab = session.tabs[0]
    tab.tracks = tab.tracks.filter((track) => track.id === 'demo-ideogram' || track.id === 'demo-genes')
    tab.state.locus = 'chrX:153,629,081-153,629,230'
    const config = `${HUMAN}/_screens-rna-reads.chromosomix.json`
    await context.route(config, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }))
    await page.goto(`${BASE}/?config=${config}`)
    await page.waitForSelector('.browser-canvas', { timeout: 120000 })
    await w.quiet()
    await sleep(1500)
    await w.drop('.browser-canvas', [`${HUMAN}/Geuvadis_chrX_GBR_ERR188428.bam`, `${HUMAN}/Geuvadis_chrX_GBR_ERR188428.bam.bai`])
    await sleep(2000)
    await w.fold('Show the Annotations panel')
    await w.tracksRead(4)
    // The pile as tall as the window has room for.
    const names = await page.$$eval('.annotation-card .ann-row', (rows) => rows.map((r) => r.querySelector('input.ann-name')?.value ?? ''))
    const pile = page.locator('.annotation-card .ann-row').nth(names.findIndex((name) => name.endsWith('· reads')))
    await pile.locator('.ann-more').click()
    await sleep(600)
    const height = pile.locator('label:has-text("height") input').first()
    await height.fill('270')
    await height.press('Enter')
    await sleep(600)
    await page.mouse.click(5, 5)
    await w.fold('Fold the Annotations panel')
    await w.fold('Fold the General panel')
    await w.fold('Fold the Aesthetics panel')
    await sleep(2000)
    await w.quiet()
    await sleep(1500)
    // A read through the substitution: its colour, found on the canvas.
    const at = await page.evaluate(() => {
      const canvas = document.querySelector('.browser-canvas')
      const { width, height } = canvas
      const data = canvas.getContext('2d').getImageData(0, 0, width, height).data
      const box = canvas.getBoundingClientRect()
      const scale = width / box.width
      const hits = []
      for (let y = Math.floor(height * 0.55); y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          if (Math.abs(data[i] - 208) < 20 && Math.abs(data[i + 1] - 144) < 20 && Math.abs(data[i + 2] - 32) < 24) hits.push([x, y])
        }
      if (hits.length === 0) return null
      const [x, y] = hits[Math.floor(hits.length * 0.35)]
      return { x: box.left + x / scale, y: box.top + y / scale }
    })
    if (at === null) throw new Error('no substitution found in the pile')
    await page.mouse.click(at.x, at.y)
    await page.waitForSelector('.modal-backdrop .modal-panel', { timeout: 10000 })
    await sleep(1200)
    console.log('  card:', (await page.locator('.modal-panel').innerText()).replace(/\s+/g, ' ').slice(0, 300))
    await page.screenshot({ path: join(OUT, 'bam-reads.png') })
    console.log('shot bam-reads')
    await w.context.close()
  }

  await browser.close()
})()
