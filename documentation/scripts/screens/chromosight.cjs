/**
 * Pattern detection on the yeast Micro-C demo at 1 kb, chromosome IV (the
 * picture of `analyses/chromosight.mdx`): loops, the default pattern, detected
 * and drawn as rings on the map, and their pileup on its 0 to 2 scale in the
 * drawer beside it.
 *
 *   node documentation/scripts/screens/chromosight.cjs <out-dir>
 *
 * chromosight-01-map-and-pileup   the map with Detected loops, the drawer narrowed beside it on the pileup
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT, { drawer: 600 })
  try {
    await s.open(`#uri=${DEMO}yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1200000`)
    await s.foldColumns(['Analysis', 'Aesthetics'])
    await s.openTask('Pattern detection')
    await s.tickOnly(['IV'])
    console.log('price:', await s.price())
    await s.run('Pileup of')
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    await s.settled()
    await s.scrollDrawerTo('.analysis-figure-head', 'Pileup of', 10)
    await s.shot('chromosight-01-map-and-pileup')
  } finally {
    await s.close()
  }
})()
