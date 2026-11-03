/**
 * Base composition (analyses/composition.mdx): the E. coli K-12 MG1655
 * reference counted in the 10 kb bins of the demo's E. coli map — GC content,
 * GC skew and cumulative GC skew as lanes of the whole chromosome's map (AT
 * skew turned off, so the three the page names are the three drawn).
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/composition.cjs <out-dir>
 */
const { open, sleep, BASE, BUCKET } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const MAP = `${BASE}/demo/ecoli/Ecoli.mcool::/resolutions/10000`
const FASTA = `${BUCKET}/ecoli_naps/ecoli_k12_mg1655.fa`
const WINDOW = process.env.SCREENS_WINDOW ?? ''

;(async () => {
  const s = await open(OUT, { drawer: 520 })
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
    await s.fold('Fold the Aesthetics panel')
    await s.openTask('Base composition')
    await s.toggle('AT skew', false)
    if (WINDOW !== '') await s.type('window', WINDOW)
    await sleep(800)
    await s.shot('composition-form')
    await s.run('Cumulative GC skew')
    console.log('notes:\n' + (await s.notes()))
    await s.shot('composition-result')
    await s.closeDrawer()
    await s.fold('Fold the Analysis panel')
    await sleep(3000)
    await s.shot('composition-map')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('composition-failure')
  } finally {
    await s.close()
  }
})()
