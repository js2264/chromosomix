/**
 * Find a motif (analyses/motif.mdx): GATC searched along the yeast reference
 * beside the demo's Micro-C map of IV, its sites and their count per 1 kb bin
 * as two tracks under the map.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/motif.cjs <out-dir>
 */
const { open, sleep, BASE } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const MAP = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`
const FASTA = `${BASE}/demo/yeast/S288c_syn40-XIII.fa`

;(async () => {
  const s = await open(OUT, { drawer: 620 })
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${encodeURIComponent(MAP)}&view=region&region=IV:1000000-1400000&transform=log10&balance=true`)
    await s.mapDrawn()
    await sleep(3000)
    await s.fold('Show the Annotations panel')
    await page.waitForSelector('.ann-drop', { timeout: 30000 })
    await s.dropTrack(FASTA, 'S288c_syn40-XIII.fa')
    await sleep(5000)
    await s.fold('Fold the Annotations panel')
    await s.fold('Fold the General panel')
    await s.fold('Fold the Aesthetics panel')
    await s.openTask('Find a motif')
    await s.type('motif', 'GATC')
    await sleep(800)
    await s.shot('motif-form')
    await s.run('sites')
    console.log('notes:\n' + (await s.notes()))
    await s.shot('motif-result')
    await s.closeDrawer()
    await s.fold('Fold the Analysis panel')
    await sleep(3000)
    await s.shot('motif-map')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('motif-failure')
  } finally {
    await s.close()
  }
})()
