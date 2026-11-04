/**
 * Restriction sites (analyses/restriction.mdx): the yeast reference cut with
 * DpnII beside the demo's Micro-C map of IV — the cuts and the cuts per 1 kb
 * bin as two lanes of the map, the drawer beside them with the run's note.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/restriction.cjs <out-dir>
 */
const { open, sleep, BASE } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const MAP = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`
const FASTA = `${BASE}/demo/yeast/S288c_syn40-XIII.fa`
const DRAWER = Number(process.env.SCREENS_DRAWER ?? 520)

;(async () => {
  const s = await open(OUT, { drawer: DRAWER })
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
    await s.openTask('Restriction sites')
    await s.pick('enzyme', 'DpnII')
    await sleep(800)
    await s.shot('restriction-form')
    await s.run('fragments')
    console.log('notes:\n' + (await s.notes()))
    await s.scrollDrawerTo('computed in', 8)
    await sleep(1500)
    await s.shot('restriction-result')
    await s.closeDrawer()
    await sleep(2000)
    await s.shot('restriction-map')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('restriction-failure')
  } finally {
    await s.close()
  }
})()
