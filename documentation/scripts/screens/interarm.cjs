/**
 * Inter-arm alignment on *B. subtilis* WT at 10 kb, from the lab's bucket (the
 * picture of `analyses/interarm.mdx`): the chromosome read as a circle with its
 * origin at its first base, the map framed on the origin with `ori`, the
 * secondary diagonal crossing it, and the curve by distance from the origin in
 * the drawer beside it.
 *
 * The circle and the origin are the Chromosomes table's; a workspace served
 * from this process says them, as a saved session does.
 *
 *   node documentation/scripts/screens/interarm.cjs <out-dir>
 *
 * interarm-00-map             the map on its origin
 * interarm-01-map-and-curve   the map on its origin and the drawer on the curve
 */

const { BUCKET, serveFiles, sleep, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'
const MAP = `${BUCKET}subtilis/Bsubtilis_WT%5Emapped_PY79%5EFKEBR7.mcool::/resolutions/10000`
const SEQUENCE = 'NC_022898.1'

;(async () => {
  const { server, urls } = await serveFiles({
    'interarm.chromosomix.json': {
      kind: 'chromosomix.workspace',
      version: 1,
      active: 0,
      tabs: [
        {
          version: 1,
          state: { uri: MAP, view: 'region', region: SEQUENCE, balance: true },
          circular: [SEQUENCE],
          origins: { [SEQUENCE]: 0 },
        },
      ],
    },
  })
  const s = await start(OUT, { drawer: 600 })
  const { page } = s
  try {
    await s.open(`?config=${encodeURIComponent(urls['interarm.chromosomix.json'])}`, { wait: 6000 })
    await s.foldColumns(['Aesthetics'])
    const ori = page.locator('button.btn-word', { hasText: /^ori$/ }).first()
    if (await ori.count()) {
      await ori.click()
      await s.settled()
    } else console.log('no ori button')
    console.log('ori pressed:', await ori.getAttribute('aria-pressed').catch(() => null))
    await s.foldColumns(['Analysis', 'Aesthetics'])
    await s.shot('interarm-00-map')
    await s.openTask('Inter-arm alignment')
    console.log('price:', await s.price())
    await s.run('Inter-arm alignment per sequence')
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    await s.scrollDrawerTo('.analysis-figure-head', 'Inter-arm alignment by distance from the origin', 10)
    await sleep(800)
    await s.shot('interarm-01-map-and-curve')
  } finally {
    await s.close()
    server.close()
  }
})()
