/**
 * Cis and trans per sequence on a chicken map, from the lab's bucket (the
 * picture of `analyses/cistrans.mdx`): DT40 cells in G2 (Gibcus et al. 2018,
 * 4DN), 36 sequences, at 1 Mb; the drawer after the run, on the bars of cis
 * fraction per sequence and the square between sequences against
 * indifference. A window taller than the other scripts' (1440 × 1800), since
 * the drawer stacks its four results.
 *
 *   node documentation/scripts/screens/cistrans.cjs <out-dir>
 *
 * cistrans-01-bars     the drawer on the bars
 * cistrans-02-square   the drawer on the square
 */

const { BUCKET, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT, { height: 1800 })
  try {
    await s.open(`#uri=${BUCKET}store/gibcus2018/G2_4DNFIT479GDR.mcool::/resolutions/1000000&view=region&region=chr7`)
    await s.fold('Fold the General panel')
    await s.openTask('Cis and trans per sequence')
    console.log('price:', await s.price())
    await s.run('Cis fraction')
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    console.log(
      'figures at:',
      JSON.stringify(
        await s.page.$$eval('.analysis-drawer .analysis-figure', (all) =>
          all.map((n) => {
            const r = n.getBoundingClientRect()
            return [n.querySelector('.analysis-figure-head')?.textContent.slice(0, 40), Math.round(r.y), Math.round(r.height)]
          }),
        ),
      ),
    )
    await s.scrollDrawerTo('.analysis-figure-head', 'Cis fraction', 10)
    await s.shot('cistrans-01-bars')
    await s.scrollDrawerTo('.analysis-figure-head', 'between sequences', 10)
    await s.shot('cistrans-02-square')
  } finally {
    await s.close()
  }
})()
