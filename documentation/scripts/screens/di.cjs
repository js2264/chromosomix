/**
 * The directionality index at Dixon et al.'s scale (the picture of
 * `analyses/di.mdx`): GM12878 in situ Hi-C (Rao et al. 2014, from 4DN's open
 * bucket) at 50 kb, one chromosome scored with a 40-bin (2 Mb) window; the
 * index beside the map, swinging from one sign to the other across each
 * domain, its borders beside it and the domains as corners on the map.
 *
 *   node documentation/scripts/screens/di.cjs <out-dir>
 *
 * The lanes are widened from the Tracks card (`SCREENS_LANE` px) so the
 * index's swing can be read. `SCREENS_REGIONS` lists windows of the scored
 * chromosome to shoot, joined by spaces; each is `di-01-<n>`.
 */

const { start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'
const MAP =
  process.env.SCREENS_MAP ??
  'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/d6abea45-b0bb-4154-9854-1d3075b98097/4DNFIXP4QG5B.mcool::/resolutions/50000'
const SEQUENCE = process.env.SCREENS_SEQUENCE ?? 'chr6'
const REGIONS = (process.env.SCREENS_REGIONS ?? 'chr6:120,000,001-140,000,000').split(' ')
const WINDOW = Number(process.env.SCREENS_WINDOW ?? 40)

;(async () => {
  const s = await start(OUT)
  const { page } = s
  try {
    const first = REGIONS[0].replace(/,/g, '').replace(/:(\d+)-/, (_, a) => `:${Number(a) - 1}-`)
    await s.open(`#uri=${MAP}&view=region&region=${first}`, { wait: 8000 })
    // The junction test's notice, put away: it is about circles, not this task.
    for (const b of await page.$$('button')) {
      if ((await b.innerText()).trim() === 'dismiss' && (await b.isVisible())) await b.click()
    }
    await s.openTask('Directionality index')
    await s.tickOnly([SEQUENCE])
    await s.setNumber('window', WINDOW)
    console.log('price:', await s.price())
    await s.run('DI borders')
    console.log('notes:', JSON.stringify(await s.notes()))
    await s.closeDrawer()
    // The lanes widened from the Tracks card, so the index's swing reads.
    await s.trackHeight(Number(process.env.SCREENS_LANE ?? 150))
    await s.foldColumns()
    for (const [n, region] of REGIONS.entries()) {
      await s.goTo(region)
      await s.shot(`di-01-${n + 1}`)
      console.log(`di-01-${n + 1}:`, region, JSON.stringify(await s.mapClip()))
    }
  } finally {
    await s.close()
  }
})()
