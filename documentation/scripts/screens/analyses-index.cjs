/**
 * The two pictures of `analyses/index.mdx`, on the yeast Micro-C demo,
 * chromosome IV: the drawer on Diamond insulation after a run, floating over
 * the map, and the drawer after a run of P(s) — its notes, its record line and
 * the curve with its exports.
 *
 *   node documentation/scripts/screens/analyses-index.cjs <out-dir>
 *
 * index-01-insulation-drawer   the drawer over the map: the form's foot, run and its price, the record line
 * index-02-ps-drawer           P(s): the record line, the notes, the curve and its buttons
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT)
  const { page } = s
  try {
    await s.open(`#uri=${DEMO}yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000`)
    // The map's own room: the General column folded, so the drawer is seen to
    // float over the map rather than over another column.
    await s.fold('Fold the General panel')
    await s.settled()

    await s.openTask('Diamond insulation')
    await s.run('Insulation boundaries')
    console.log('notes:', JSON.stringify(await s.notes()))
    // The run row a little below the top, the form's foot above it and the
    // record line and what went beside the map under it.
    await s.scrollDrawerTo('.analysis-form .card, .analysis-form section', 'BOUNDARIES', 8)
    await page.evaluate(() => {
      const body = document.querySelector('.analysis-drawer-body')
      const run = document.querySelector('.analysis-drawer .analysis-run')
      if (body && run) body.scrollTop += run.getBoundingClientRect().top - body.getBoundingClientRect().top - 260
    })
    await s.shot('index-01-insulation-drawer')

    await s.openTask('Contact probability P\\(s\\)')
    await s.run('Log-log slope')
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    // The record line at the top of the drawer, the curve and its exports whole under it.
    await s.scrollDrawerTo('.plot-icon-row', 'copy provenance', 8)
    await s.shot('index-02-ps-drawer')
  } finally {
    await s.close()
  }
})()
