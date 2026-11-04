/**
 * Contact probability P(s) on the yeast Micro-C demo (the picture of
 * `analyses/expected.mdx`): the curve, a line per chromosome, and its log-log
 * slope under it, both in the drawer at its default width.
 *
 * A window taller than the other scripts' (1440 × 1500), because the two
 * figures stand one above the other and each takes its height from the
 * drawer's width: at 900 the second is below the fold.
 *
 *   node documentation/scripts/screens/expected.cjs <out-dir>
 *
 * expected-01-drawer   both figures, the curve's heading at the top of the drawer
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT, { height: 1500 })
  try {
    await s.open(`#uri=${DEMO}yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000`)
    await s.fold('Fold the General panel')
    await s.openTask('Contact probability P\\(s\\)')
    await s.run('Log-log slope')
    console.log('figures:', JSON.stringify(await s.figures()))
    await s.scrollDrawerTo('.analysis-figure-head', 'Contact probability P(s)', 10)
    await s.shot('expected-01-drawer')
    console.log('drawer:', JSON.stringify(await s.box('.analysis-drawer')))
    console.log(
      'figures at:',
      JSON.stringify(
        await s.page.$$eval('.analysis-drawer .analysis-figure', (all) =>
          all.map((n) => {
            const r = n.getBoundingClientRect()
            return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
          }),
        ),
      ),
    )
  } finally {
    await s.close()
  }
})()
