/**
 * Aggregate peak analysis on the yeast Micro-C demo (the picture of
 * `analyses/apa.mdx`): the demo's loops piled up over the expected at the
 * form's defaults, the dot in the middle, the windows and P2LL under the
 * pileup, and the ATAC track's aggregate along its top and right edges.
 *
 *   node documentation/scripts/screens/apa.cjs <out-dir>
 *
 * apa-01-pileup   the drawer on the pileup
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT)
  try {
    await s.open(`?config=${DEMO}yeast/Yeast_microC.chromosomix.json`, { wait: 8000 })
    await s.foldColumns(['Analysis'])
    await s.openTask('Aggregate peak analysis')
    console.log('price:', await s.price())
    await s.run('P2LL')
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    await s.scrollDrawerTo('.analysis-figure-head', 'APA', 10)
    await s.shot('apa-01-pileup')
  } finally {
    await s.close()
  }
})()
