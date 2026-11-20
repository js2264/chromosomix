/**
 * Origin and terminus (analyses/oriter.mdx): the E. coli K-12 MG1655
 * reference beside the demo's map of its chromosome at 10 kb — the ori and ter
 * loci and the sites found as lanes of the map, and the drawer's table.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/oriter.cjs <out-dir>
 */
const { open, sleep, BASE, BUCKET } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const MAP = `${BASE}/demo/ecoli/Ecoli.mcool::/resolutions/10000`
const FASTA = `${BUCKET}/store/ecoli/ecoli_k12_mg1655.fa`

;(async () => {
  const s = await open(OUT, { drawer: Number(process.env.SCREENS_DRAWER ?? 720) })
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${encodeURIComponent(MAP)}&view=region&region=NC_000913.3&transform=log10&balance=true`)
    await s.mapDrawn()
    await sleep(3000)
    const dismiss = page.locator('button', { hasText: /^dismiss$/ }).first()
    if (await dismiss.isVisible().catch(() => false)) { await dismiss.click(); await sleep(800) }
    await s.fold('Show the Annotations panel')
    await page.waitForSelector('.ann-drop', { timeout: 30000 })
    await s.dropTrack(FASTA, 'ecoli_k12_mg1655.fa')
    await sleep(6000)
    await s.fold('Fold the Annotations panel')
    await s.fold('Fold the General panel')
    // Aesthetics left open: the deck is narrower and the map sits left of the
    // drawer rather than under it.
    await s.openTask('Origin and terminus')
    await s.shot('oriter-form')
    await s.run('Origin and terminus per sequence')
    console.log('notes:\n' + (await s.notes()))
    console.log('table:', await page.evaluate(() => {
      const t = [...document.querySelectorAll('.analysis-drawer table')].find((x) => /terminus/.test(x.textContent ?? ''))
      return t ? [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.textContent.trim()).join(' | ')).join('\n') : 'none'
    }))
    // The run's banner (where the origin went) is left up: put away, it gives
    // the map the room to grow under the drawer. Then the tracks' names to the
    // map's corners (the name column, `u`), so no name is written over the
    // loci it labels.
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('u')
    await sleep(2500)
    await s.shot('oriter-result')
    await s.scrollDrawerTo('Origin and terminus per sequence', 60)
    await sleep(1200)
    await s.shot('oriter-table')
    await s.closeDrawer()
    await s.fold('Fold the Analysis panel')
    await sleep(3000)
    await s.shot('oriter-map')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('oriter-failure')
  } finally {
    await s.close()
  }
})()
