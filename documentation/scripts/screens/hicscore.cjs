/**
 * The HiC score on the *E. coli* demo at 2 kb (the picture of
 * `analyses/hicscore.mdx`): the track beside the map, widened from the Tracks
 * card, over a megabase of the chromosome and over the whole of it.
 *
 *   node documentation/scripts/screens/hicscore.cjs <out-dir>
 *
 * hicscore-01-map     the whole chromosome
 * hicscore-02-close   NC_000913.3:1,000,001-2,000,000
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT)
  const { page } = s
  try {
    await s.open(`#uri=${DEMO}ecoli/Ecoli.mcool::/resolutions/2000&view=region&region=NC_000913.3`)
    for (const b of await page.$$('button')) {
      if ((await b.innerText()).trim() === 'dismiss' && (await b.isVisible())) await b.click()
    }
    await s.openTask('HiC score')
    console.log('price:', await s.price())
    await s.run('HiC score ·')
    console.log('notes:', JSON.stringify(await s.notes()))
    await s.closeDrawer()
    await s.trackHeight(Number(process.env.SCREENS_LANE ?? 200))
    await s.foldColumns()
    await s.shot('hicscore-01-map')
    console.log('clip:', JSON.stringify(await s.mapClip()))
    await s.goTo('NC_000913.3:1,000,001-2,000,000')
    await s.shot('hicscore-02-close')
    console.log('clip:', JSON.stringify(await s.mapClip()))
  } finally {
    await s.close()
  }
})()
