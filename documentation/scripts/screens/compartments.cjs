/**
 * Compartments on a chicken map at 100 kb, from the lab's bucket (the picture
 * of `analyses/compartments.mdx`): DT40 cells in G2 (Gibcus et al. 2018, 4DN),
 * chromosome 7, with Ensembl's chicken genes added beside the map by their
 * address so the run is phased by gene density; E1 and the A/B segments beside
 * the map and the saddle in the drawer, narrowed beside it.
 *
 *   node documentation/scripts/screens/compartments.cjs <out-dir>
 *
 * compartments-01-map-and-saddle   the map with E1 and A/B, the drawer on the saddle
 * compartments-02-map              the drawer away
 */

const { BUCKET, sleep, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'
const SEQUENCE = process.env.SCREENS_SEQUENCE ?? 'chr7'
// The map is the lab's store's copy; the genes it was phased by were beside the map it was copied
// from (demo/chicken/genes.gtf.gz), which is gone: name a copy, by its address, in SCREENS_GENES.
const GENES = process.env.SCREENS_GENES
if (GENES === undefined) {
  console.error('the chicken genes (demo/chicken/genes.gtf.gz) are no longer on the lab’s bucket: name a copy in SCREENS_GENES')
  process.exit(1)
}

;(async () => {
  const s = await start(OUT, { drawer: 460 })
  const { page } = s
  try {
    await s.open(`#uri=${BUCKET}store/gibcus2018/G2_4DNFIT479GDR.mcool::/resolutions/100000&view=region&region=${SEQUENCE}`)
    // The genes, by their address, through the header's +.
    await page.locator('.app-head .head-add').click()
    await sleep(700)
    await page.locator('.modal-panel input.input-url').fill(GENES)
    await page.locator('.modal-panel button', { hasText: /^open$/ }).click()
    await page
      .waitForFunction(() => /genes/.test(document.querySelector('.annotation-card')?.textContent ?? ''), null, {
        timeout: 300000,
      })
      .catch(() => console.log('no genes row'))
    await sleep(8000)
    await s.settled()
    await s.foldColumns(['Analysis'])
    await s.openTask('Compartments')
    await s.tickOnly([SEQUENCE])
    console.log('price:', await s.price())
    console.log(
      'selects:',
      JSON.stringify(
        await page.$$eval('.analysis-form select', (all) =>
          all.map(
            (n) =>
              `${n.closest('.field')?.querySelector('.field-label')?.textContent}: ${n.options[n.selectedIndex]?.textContent}`,
          ),
        ),
      ),
    )
    await s.run('Saddle')
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    await s.settled()
    await s.scrollDrawerTo('.analysis-figure-head', 'Saddle', 10)
    await s.shot('compartments-01-map-and-saddle')
    await s.closeDrawer()
    await s.foldColumns()
    await s.shot('compartments-02-map')
  } finally {
    await s.close()
  }
})()
