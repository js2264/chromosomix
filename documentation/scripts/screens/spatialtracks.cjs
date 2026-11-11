/**
 * Spatial tracks (analyses/spatialtracks.mdx): a model made by Model from the
 * map of the demo's yeast Micro-C map, IV:1,000,001-1,400,000 at 1 kb (one
 * bead a bin, so every bin has a value), turned into its three tracks — radial
 * position, local compaction and the distance to a locus — which open as lanes
 * of the map; then the model in its cell coloured by its radial position.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/spatialtracks.cjs <out-dir>
 */
const { open, sleep, BASE } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const MAP = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`
const LOCUS = process.env.SCREENS_LOCUS ?? 'IV:1,250,001-1,255,000'

;(async () => {
  const s = await open(OUT, { drawer: 620 })
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${encodeURIComponent(MAP)}&view=region&region=IV:1000000-1400000&transform=log10&balance=true`)
    await s.mapDrawn()
    await sleep(3000)
    await s.fold('Fold the General panel')
    await s.openTask('Model from the map')
    await s.run('Spearman ρ', 300000)
    await page.waitForSelector('.deck-structure', { timeout: 60000 }).catch(() => console.log('no structure cell'))
    await sleep(4000)

    await s.openTask('Spatial tracks')
    const offered = await page.evaluate(() =>
      [...document.querySelectorAll('.analysis-drawer select option')].map((o) => o.textContent.trim()))
    console.log('offered:', JSON.stringify(offered))
    await s.pick('structure', '3D model')
    await s.type('distance to', LOCUS)
    await s.shot('spatialtracks-form')
    await s.run('Radial position')
    console.log('notes:\n' + (await s.notes()))
    await s.shot('spatialtracks-result')
    await s.closeDrawer()
    await sleep(1500)

    // The model coloured by its radial position, from the 3D structure card.
    const colourBy = page.locator('.structure-settings .field')
      .filter({ has: page.locator('.field-label', { hasText: /^colour by$/ }) }).first().locator('select')
    const options = await colourBy.locator('option').evaluateAll((all) => all.map((o) => ({ value: o.value, text: o.textContent.trim() })))
    console.log('colour by:', JSON.stringify(options.map((o) => o.text)))
    const radial = options.find((o) => /^Radial position/.test(o.text))
    if (radial) await colourBy.selectOption(radial.value)
    else console.log('no radial position to colour by')
    await sleep(4000)
    await s.shot('spatialtracks-coloured')
    await s.fold('Fold the Aesthetics panel')
    await s.fold('Fold the Analysis panel')
    await sleep(4000)
    await s.shot('spatialtracks-deck')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('spatialtracks-failure')
  } finally {
    await s.close()
  }
})()
