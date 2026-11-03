/**
 * TAD annotation on the yeast Micro-C demo at 1 kb (the picture of
 * `analyses/arrowhead.mdx`): the Arrowhead domains of chromosome XVI as
 * corners along the diagonal, the small ones nested in larger ones. XVI from
 * 200 to 400 kb is the 200 kb of the genome that holds the most nesting, read
 * off a run over every sequence.
 *
 *   node documentation/scripts/screens/arrowhead.cjs <out-dir>
 *
 * arrowhead-01-map   XVI:200,001-400,000
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT)
  try {
    await s.open(`#uri=${DEMO}yeast/Yeast_microC_G2M_1kb.cool&view=region&region=XVI:200000-400000`)
    await s.openTask('TAD annotation')
    await s.tickOnly(['XVI'])
    console.log('price:', await s.price())
    await s.run('as Juicer writes them')
    console.log('notes:', JSON.stringify(await s.notes()))
    await s.closeDrawer()
    await s.foldColumns()
    await s.shot('arrowhead-01-map')
    console.log('clip:', JSON.stringify(await s.mapClip()))
  } finally {
    await s.close()
  }
})()
