/**
 * Track correlation (analyses/trackcorr.mdx): two ATAC-seq replicates of the
 * yeast strain carrying the Mycoplasma mycoides chromosome (Meneu et al. 2025,
 * on the lab's bucket) and an insulation score — Diamond insulation run on
 * the same strain's Hi-C map at 4 kb over every sequence — correlated over the
 * form's default 100 bp windows: the drawer's matrix and its Pairs table.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/trackcorr.cjs <out-dir>
 *
 * The window is 1440 × SCREENS_HEIGHT (900 by default).
 */
const { open, sleep, BASE, BUCKET } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const MAP = `${BUCKET}/store/meneu2025/HiC/HiC_Mmyco_G2M.mcool::/resolutions/4000`
// The paper's ATAC, as its data release on the lab's bucket holds it: the store has no copy.
const ATAC = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/public-data/2025_Meneu_et_al/ATAC'
const REP1 = `${ATAC}/ATAC_Mmyco_rep1.CPM.bw`
const REP2 = `${ATAC}/ATAC_Mmyco_rep2.CPM.bw`
const HEIGHT = Number(process.env.SCREENS_HEIGHT ?? 900)

;(async () => {
  const s = await open(OUT, { height: HEIGHT, drawer: Number(process.env.SCREENS_DRAWER ?? 560) })
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${encodeURIComponent(MAP)}&view=region&region=Mmmyco&transform=log10&balance=true`)
    await s.mapDrawn()
    await sleep(4000)
    await s.addByUrl(REP1)
    await sleep(4000)
    await s.addByUrl(REP2)
    await sleep(6000)
    await s.fold('Fold the General panel')
    await s.fold('Fold the Aesthetics panel')
    await s.shot('trackcorr-map')

    await s.openTask('Diamond insulation')
    console.log('insulation sequences:', await s.tickAll())
    await s.shot('trackcorr-insulation-form')
    await s.run('Tracks card', 900000)
    console.log('insulation notes:\n' + (await s.notes()))

    await s.openTask('Track correlation')
    const offered = (await s.field('tracks').locator('label').allInnerTexts()).map((t) => t.trim())
    console.log('tracks offered:', JSON.stringify(offered))
    await s.only('tracks', ['ATAC_Mmyco_rep1', 'ATAC_Mmyco_rep2', 'Insulation'])
    await s.shot('trackcorr-form')
    await s.run('Pairs', 900000)
    console.log('notes:\n' + (await s.notes()))
    await s.scrollDrawerTo('computed in', 8)
    await sleep(2000)
    await s.shot('trackcorr-result')
    // The matrix's block at the top of the drawer, the Pairs table under it.
    await s.scrollDrawerToBlock('^Track correlation')
    await sleep(1500)
    console.log('blocks:', JSON.stringify(await s.blocks()))
    await s.shot('trackcorr-pairs')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('trackcorr-failure')
  } finally {
    await s.close()
  }
})()
