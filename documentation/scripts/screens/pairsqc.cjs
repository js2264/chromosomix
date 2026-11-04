/**
 * Pairs QC on a yeast Hi-C library binned from its `.pairs` (the picture of
 * `analyses/pairsqc.mdx`), read against DpnII sites on R64-1-1: the
 * orientation curves, and the pair classes stacked by orientation.
 *
 * The library is CH128, a yeast Hi-C contact list in the lab's bucket
 * (`demo/yeast/CH128.pairs.gz`, 1.5 GB; the enzyme it was cut with is not
 * recorded, and the validation reads it against DpnII). A one-in-twenty sample
 * of its records is enough for the figures and opens in a browser: keep every
 * `#` line and every twentieth record, gzip it, serve its folder with byte
 * ranges and CORS (`python3 scripts/DBZ_store.py serve <folder> --port 8793`),
 * and name its address:
 *
 *   SCREENS_PAIRS=http://127.0.0.1:8793/CH128.sample.pairs.gz \
 *     node documentation/scripts/screens/pairsqc.cjs <out-dir>
 *
 * The reference is the store's R64-1-1 FASTA, dropped on the Annotations
 * column as a reader drops one.
 *
 * pairsqc-00-dialog        the .pairs's import dialog
 * pairsqc-01-orientation   P(s) by pair orientation
 * pairsqc-02-classes       the pair classes stacked by orientation
 * pairsqc-03-types         the pair types and cis and trans
 */

const { BASE, BUCKET, sleep, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'
const PAIRS = process.env.SCREENS_PAIRS
const FASTA = `${BUCKET}store/S288c.fa`

;(async () => {
  if (!PAIRS) throw new Error('SCREENS_PAIRS must name the sampled .pairs.gz (see the header)')
  const s = await start(OUT)
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${PAIRS}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await page.waitForSelector('.pairs-base', { timeout: 180000 })
    await sleep(800)
    await s.shot('pairsqc-00-dialog')
    await page
      .locator('.pairs-download input')
      .uncheck()
      .catch(() => {})
    await page.locator('button', { hasText: 'build the map' }).click()
    await page.waitForFunction(
      () =>
        !document.body.textContent.includes('Opening ') &&
        (document.querySelector('.heatmap-canvas') !== null ||
          (document.querySelector('.breadcrumb')?.textContent ?? '').includes('Chromosomes')),
      null,
      { timeout: 900000 },
    )
    await sleep(1500)
    for (const b of await page.$$('button')) {
      if ((await b.innerText()).trim() === 'dismiss' && (await b.isVisible())) await b.click()
    }
    const box = page.locator('input[placeholder*="a sequence"]').first()
    if (await box.count()) {
      await box.fill('IV')
      await box.press('Enter')
    }
    await page.waitForSelector('.heatmap-canvas', { timeout: 180000 })
    await s.settled()
    // The reference, dropped on the Annotations column's drop area.
    await page.evaluate(
      async ({ url, name }) => {
        const target = [...document.querySelectorAll('.ann-drop')].find((el) =>
          (el.textContent ?? '').includes('Load a track'),
        )
        if (target === undefined) throw new Error('no drop area')
        const file = new File([await (await fetch(url)).blob()], name)
        const transfer = new DataTransfer()
        transfer.items.add(file)
        for (const type of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
        }
      },
      { url: FASTA, name: 'S288c.fa' },
    )
    await sleep(8000)
    await s.foldColumns(['Analysis'])
    await s.openTask('Pairs QC')
    await s.choose('S288c')
    await s.choose('DpnII')
    console.log('price:', await s.price())
    await s.run('Coverage against', { timeout: 1800000 })
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    await s.scrollDrawerTo('.analysis-figure-head', 'P(s) by pair orientation', 10)
    await s.shot('pairsqc-01-orientation')
    await s.scrollDrawerTo('.analysis-figure-head', 'Pair classes by orientation', 10)
    await s.shot('pairsqc-02-classes')
    await s.scrollDrawerTo('.analysis-figure-head', 'Pair types', 10)
    await s.shot('pairsqc-03-types')
  } finally {
    await s.close()
  }
})()
