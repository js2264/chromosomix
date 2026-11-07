/**
 * Reproducibility on a deck of three chicken maps at 100 kb, from the lab's
 * bucket (the picture of `analyses/hicrep.mdx`): DT40 cells in G2, and 5 and
 * 60 minutes after release into mitosis (Gibcus et al. 2018, 4DN) — the
 * validation's own data — on one grid; HiCRep run between them, and the drawer
 * beside the deck on its coefficient matrix down to its correlation by
 * separation. The deck and its names are a workspace served from this
 * process, as a saved session gives them.
 *
 * A window taller than the other scripts' (1440 × 2000): the drawer stacks
 * the matrix, two tables and the curve, and the curve is the point.
 *
 *   node documentation/scripts/screens/hicrep.cjs <out-dir>
 *
 * hicrep-00-deck      the deck before the run
 * hicrep-01-drawer    the deck and the drawer on its four results
 */

const { BUCKET, serveFiles, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'
const DIR = `${BUCKET}store/gibcus2018/`
const RUNG = '::/resolutions/100000'
const MAPS = [
  ['G2', 'G2_4DNFIT479GDR.mcool'],
  ['5 min', '5m_4DNFINSJ2GYV.mcool'],
  ['60 min', '60m_4DNFIWHQLZTL.mcool'],
]
const REGION = process.env.SCREENS_REGION ?? 'chr7'

;(async () => {
  const { server, urls } = await serveFiles({
    'hicrep.chromosomix.json': {
      kind: 'chromosomix.workspace',
      version: 1,
      active: 0,
      tabs: [
        {
          version: 1,
          name: 'G2 into mitosis',
          state: {
            uri: DIR + MAPS[0][1] + RUNG,
            maps: MAPS.slice(1)
              .map(([, file]) => DIR + file + RUNG)
              .join('|'),
            view: 'region',
            region: REGION,
            balance: true,
          },
          deck: { columns: 2 },
          mapNames: Object.fromEntries(MAPS.map(([name, file]) => [DIR + file, name])),
        },
      ],
    },
  })
  const s = await start(OUT, { height: 2000, drawer: 560 })
  const { page } = s
  try {
    await s.open(`?config=${encodeURIComponent(urls['hicrep.chromosomix.json'])}`, { wait: 6000 })
    await page
      .waitForFunction(() => document.querySelectorAll('.heatmap-canvas').length >= 3, null, { timeout: 300000 })
      .catch(() => console.log('fewer than three maps'))
    await s.settled()
    await s.foldColumns(['Analysis', 'Aesthetics'])
    await s.shot('hicrep-00-deck')
    await s.openTask('Reproducibility')
    console.log('price:', await s.price())
    await s.run('Correlation by separation', { timeout: 1800000 })
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    await s.scrollDrawerTo('.analysis-figure-head', 'Stratum-adjusted correlation', 10)
    await s.shot('hicrep-01-drawer')
    console.log('drawer:', JSON.stringify(await s.box('.analysis-drawer')))
    console.log(
      'pooled:',
      await page.evaluate(() =>
        [...document.querySelectorAll('.analysis-drawer .analysis-figure')]
          .find((n) => (n.textContent ?? '').includes('Pooled over every sequence'))
          ?.innerText.replace(/\s+/g, ' ')
          .slice(0, 400),
      ),
    )
  } finally {
    await s.close()
    server.close()
  }
})()
