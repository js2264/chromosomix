/**
 * Loop calling on the yeast Micro-C demo at 1 kb, chromosome IV (the picture of
 * `analyses/loops.mdx`): the called loops as rings on the map, and their table
 * in the drawer beside it. The map's bins have no kernel in cooltools' table,
 * so the half-widths are typed, as the page says to (outer 5, inner 2).
 *
 *   node documentation/scripts/screens/loops.cjs <out-dir>
 *
 * loops-01-map-and-table   the map with Called loops, the drawer narrowed beside it on the table
 */

const { DEMO, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT, { drawer: 560 })
  try {
    await s.open(`#uri=${DEMO}yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1030000-1140000`)
    await s.foldColumns(['Analysis'])
    await s.openTask('Loop calling')
    await s.setNumber('outer half-width', 5)
    await s.setNumber('inner half-width', 2)
    await s.tickOnly(['IV'])
    console.log('price:', await s.price())
    await s.run('Contacts needed')
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    await s.settled()
    await s.scrollDrawerTo('.analysis-figure-head', ' loops', 10)
    await s.shot('loops-01-map-and-table')
    await s.page.evaluate(() => {
      const body = document.querySelector('.analysis-drawer-body')
      const run = document.querySelector('.analysis-drawer .analysis-run')
      if (body && run) body.scrollTop += run.getBoundingClientRect().top - body.getBoundingClientRect().top - 8
    })
    await s.shot('loops-02-map-and-notes')
  } finally {
    await s.close()
  }
})()
