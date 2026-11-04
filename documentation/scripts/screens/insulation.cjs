/**
 * Diamond insulation on the yeast Micro-C demo, chromosome IV (the picture of
 * `analyses/insulation.mdx`).
 *
 *   node documentation/scripts/screens/insulation.cjs <out-dir>
 *
 * insulation-00-form     the drawer on Diamond insulation as it opens
 * insulation-01-drawer   the drawer after a run
 * insulation-02-map      the drawer put away: the score in a lane beside the map, the
 *                        boundaries beside it, the domains as corners along the diagonal
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT)
  try {
    await s.open(`#uri=${DEMO}yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000`)
    await s.openTask('Diamond insulation')
    await s.shot('insulation-00-form')
    await s.run('Insulation boundaries')
    console.log('notes:', JSON.stringify(await s.notes()))
    await s.shot('insulation-01-drawer')
    await s.page.evaluate(() => {
      const body = document.querySelector('.analysis-drawer-body')
      if (body) body.scrollTop = 0
    })
    await s.closeDrawer()
    await s.fold('Fold the Analysis panel')
    await s.settled()
    await s.shot('insulation-02-map')
  } finally {
    await s.close()
  }
})()
