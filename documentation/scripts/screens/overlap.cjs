/**
 * Interval set overlap (analyses/overlap.mdx): the yeast demo's ATAC-seq peaks
 * (its MACS2 narrowPeak) against the genes of its GTF — the demo has no
 * promoter set — with the shuffled null on at the form's 1,000 shuffles, the
 * peaks the set that moves: the drawer's Overlap table and the table against
 * the shuffles. The demo's map is open, so the shuffle knows every sequence's
 * length.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/overlap.cjs <out-dir>
 */
const { open, sleep, BASE } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'

;(async () => {
  const s = await open(OUT, { drawer: Number(process.env.SCREENS_DRAWER ?? 760) })
  const { page } = s
  try {
    await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
    await s.mapDrawn()
    await sleep(4000)
    await s.fold('Fold the General panel')
    await s.fold('Fold the Aesthetics panel')
    await s.openTask('Interval set overlap')
    console.log('sets offered:', JSON.stringify(await s.field('first set').locator('option').allTextContents()))
    await s.pick('first set', 'ATAC peaks')
    await s.pick('second set', 'genes')
    await s.toggle('shuffled null', true)
    await sleep(800)
    await s.shot('overlap-form')
    await s.run('Expected', 900000)
    console.log('notes:\n' + (await s.notes()))
    for (const name of ['Overlap', 'shuffle']) {
      console.log(name, 'table:', await page.evaluate((name) => {
        const t = [...document.querySelectorAll('.analysis-drawer table')].find((x) => (x.closest('.figure-block')?.querySelector('.analysis-figure-head')?.textContent ?? '').includes(name))
        return t ? [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.textContent.trim()).join(' | ')).join('\n') : 'none'
      }, name))
    }
    await s.scrollDrawerTo('computed in', 8)
    await sleep(1500)
    console.log('blocks:', JSON.stringify(await s.blocks()))
    await s.shot('overlap-result')
    await s.scrollDrawerToBlock('^Overlap')
    await sleep(1500)
    await s.shot('overlap-tables')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('overlap-failure')
  } finally {
    await s.close()
  }
})()
