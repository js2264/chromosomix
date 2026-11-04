/**
 * Model from the map (analyses/reconstruct3d.mdx): the demo's yeast Micro-C
 * map of IV:1,000,001-1,400,000 at 1 kb, modelled by pastis-NB at the form's
 * defaults — the model in a structure cell of its own beside the map, and the
 * drawer's table of how it was made.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/reconstruct3d.cjs <out-dir>
 */
const { open, sleep, BASE } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const MAP = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`

;(async () => {
  const s = await open(OUT, { drawer: Number(process.env.SCREENS_DRAWER ?? 590) })
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${encodeURIComponent(MAP)}&view=region&region=IV:1000000-1400000&transform=log10&balance=true`)
    await s.mapDrawn()
    await sleep(3000)
    // Aesthetics left open: the deck is narrower, so the map and the model's
    // cell both sit left of the drawer.
    await s.fold('Fold the General panel')
    await s.openTask('Model from the map')
    await s.shot('reconstruct3d-form')
    await s.run('Spearman ρ', 300000)
    await page.waitForSelector('.deck-structure', { timeout: 60000 }).catch(() => console.log('no structure cell'))
    await sleep(5000)
    console.log('notes:\n' + (await s.notes()))
    await s.shot('reconstruct3d-result')
    await s.scrollDrawerTo('Model from the map ·', 8)
    await sleep(1500)
    await s.shot('reconstruct3d-table')
    await s.closeDrawer()
    await sleep(3000)
    await s.shot('reconstruct3d-deck')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('reconstruct3d-failure')
  } finally {
    await s.close()
  }
})()
