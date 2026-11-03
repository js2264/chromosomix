/**
 * Coverage and marginals on the yeast Micro-C demo, chromosome IV (the picture
 * of `analyses/coverage.mdx`): total coverage and the cis fraction as two lanes
 * beside the map, over a stretch with bins the balancer dropped, which are the
 * pale stripes on the balanced map and the dips in the raw total.
 *
 *   node documentation/scripts/screens/coverage.cjs <out-dir>
 *
 * coverage-01-map   the map with Coverage · total and Cis fraction beside it
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT)
  try {
    await s.open(`#uri=${DEMO}yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:800000-1200000`)
    await s.openTask('Coverage and marginals')
    await s.field('cis fraction').locator('button').first().click()
    await s.page.waitForTimeout(600)
    console.log('price:', await s.price())
    await s.run('Cis fraction')
    console.log('notes:', JSON.stringify(await s.notes()))
    await s.closeDrawer()
    await s.foldColumns()
    await s.shot('coverage-01-map')
    console.log('clip:', JSON.stringify(await s.mapClip()))
  } finally {
    await s.close()
  }
})()
