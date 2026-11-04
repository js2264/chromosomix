/**
 * Fraction of signal in features (analyses/frip.mdx): the two ATAC-seq
 * replicates of the yeast strain carrying the Mycoplasma mycoides chromosome
 * (Meneu et al. 2025, on the lab's bucket), opened in the 1D browser, over the
 * peaks called on the first of them (its narrowPeak) — the drawer's table, a
 * row per replicate.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/frip.cjs <out-dir>
 */
const { open, sleep, BASE, BUCKET } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const REP1 = `${BUCKET}/meneu/ATAC/ATAC_Mmyco_rep1.CPM.bw`
const REP2 = `${BUCKET}/meneu/ATAC/ATAC_Mmyco_rep2.CPM.bw`
const PEAKS = `${BUCKET}/meneu/ATAC/ATAC_Mmyco_rep1.narrowPeak`

;(async () => {
  const s = await open(OUT, { drawer: Number(process.env.SCREENS_DRAWER ?? 900) })
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${encodeURIComponent(REP1)}&view=browser&locus=${encodeURIComponent('Mmmyco:1-1,222,199')}`)
    await page.waitForSelector('canvas', { timeout: 120000 })
    await sleep(6000)
    await s.addByUrl(REP2)
    await sleep(5000)
    await s.addByUrl(PEAKS)
    await sleep(5000)
    await s.fold('Fold the General panel')
    await s.fold('Fold the Aesthetics panel')
    await s.shot('frip-browser')
    await s.openTask('Fraction of signal in features')
    console.log('features offered:', JSON.stringify(await s.field('features').locator('option').allTextContents()))
    await s.pick('features', 'ATAC_Mmyco_rep1')
    await s.only('tracks', ['ATAC_Mmyco_rep1', 'ATAC_Mmyco_rep2'])
    await s.shot('frip-form')
    await s.run('Enrichment', 900000)
    console.log('notes:\n' + (await s.notes()))
    console.log('table:', await page.evaluate(() => {
      const t = [...document.querySelectorAll('.analysis-drawer table')].find((x) => /FRiP/.test(x.textContent ?? ''))
      return t ? [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.textContent.trim()).join(' | ')).join('\n') : 'none'
    }))
    await s.scrollDrawerTo('computed in', 8)
    await sleep(1500)
    await s.shot('frip-result')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('frip-failure')
  } finally {
    await s.close()
  }
})()
