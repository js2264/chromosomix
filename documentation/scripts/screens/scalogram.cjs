/**
 * The scalogram on the *E. coli* demo at 5 kb (the picture of
 * `analyses/scalogram.mdx`): its five bands as one lane beside the whole
 * chromosome's map, the lane widened from the Tracks card so the bands can be
 * read; then the stretch around the terminus, where they step.
 *
 *   node documentation/scripts/screens/scalogram.cjs <out-dir>
 *
 * scalogram-01-map     the whole chromosome
 * scalogram-02-close   NC_000913.3:700,001-2,500,000
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT)
  const { page } = s
  try {
    await s.open(`#uri=${DEMO}ecoli/Ecoli.mcool::/resolutions/5000&view=region&region=NC_000913.3`)
    for (const b of await page.$$('button')) {
      if ((await b.innerText()).trim() === 'dismiss' && (await b.isVisible())) await b.click()
    }
    await s.openTask('Scalogram')
    console.log('price:', await s.price())
    await s.run('Scalogram 90')
    console.log('notes:', JSON.stringify(await s.notes()))
    await s.closeDrawer()
    await s.trackHeight(Number(process.env.SCREENS_LANE ?? 260))
    await s.foldColumns()
    await s.shot('scalogram-01-map')
    console.log('clip:', JSON.stringify(await s.mapClip()))
    await s.goTo('NC_000913.3:700,001-2,500,000')
    await s.shot('scalogram-02-close')
    console.log('clip:', JSON.stringify(await s.mapClip()))
  } finally {
    await s.close()
  }
})()
