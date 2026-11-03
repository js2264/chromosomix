/**
 * Peak calling (analyses/peaks.mdx): the yeast demo's ATAC-seq bigWig opened
 * alone in the 1D browser, peaks called on it with no replicate and the
 * strongest 5,000 kept — the cut the page suggests once the curvatures show
 * two populations — the new lane under the coverage, beside the drawer's
 * curvature figure.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/peaks.cjs <out-dir>
 */
const { open, sleep, BASE } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const ATAC = `${BASE}/demo/yeast/Yeast_ATAC.bw`
const LOCUS = process.env.SCREENS_LOCUS ?? 'IV:1,246,215-1,295,987'
const KEEP = process.env.SCREENS_KEEP ?? '5000'

;(async () => {
  const s = await open(OUT, { drawer: Number(process.env.SCREENS_DRAWER ?? 600) })
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${encodeURIComponent(ATAC)}&view=browser&locus=${encodeURIComponent(LOCUS)}`)
    await page.waitForSelector('canvas', { timeout: 120000 })
    await sleep(8000)
    await s.shot('peaks-browser')
    await s.fold('Fold the General panel')
    await s.fold('Fold the Aesthetics panel')
    await s.openTask('Peak calling')
    console.log('tracks offered:', JSON.stringify(await s.field('track').locator('option').allTextContents()))
    await s.pick('track', 'ATAC')
    if (KEEP !== '') {
      const keep = page.locator('.analysis-drawer input[id$="-truncate"]').first()
      await keep.fill(KEEP)
      await keep.press('Enter')
      await sleep(600)
    }
    await s.shot('peaks-form')
    await s.run(KEEP !== '' ? 'below the cut' : 'Curvature of every candidate', 600000)
    console.log('notes:\n' + (await s.notes()))
    await s.scrollDrawerTo('Curvature of every candidate', 12)
    await sleep(2000)
    await s.shot('peaks-curvature')
    await s.closeDrawer()
    await s.fold('Fold the Analysis panel')
    await sleep(3000)
    await s.shot('peaks-lane')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('peaks-failure')
  } finally {
    await s.close()
  }
})()
