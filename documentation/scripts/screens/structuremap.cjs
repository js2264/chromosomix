/**
 * Model versus map (analyses/structuremap.mdx): the demo's yeast model
 * (Yeast_structure.g3d.gz, a bead every 5 kb) against the demo's Micro-C map
 * of chromosome IV read at 5 kb, so a bead is a bin. The picture is the
 * drawer at its predicted contacts, with the model's distance by separation
 * under them (structuremap-predicted.png); the other figures are shot too.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/structuremap.cjs <out-dir>
 *
 * The window is 1440 × SCREENS_HEIGHT (1260 by default) rather than 900, for
 * the reason metaplot.cjs gives: two of the drawer's figures, one above the
 * other, need more than a 900 px window. SCREENS_VMAX (0.001 by default, empty
 * for none) is typed into the predicted contacts' own settings as the top of
 * their colour scale: 1/d³ spans orders of magnitude, and the linear scale the
 * figure fits by default is set by the centromere's closest pair (1/d³ ≈ 6),
 * which leaves every other cell white.
 */
const { open, sleep, BASE } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const MAP = `${BASE}/demo/yeast/Yeast_microC_G2M_1kb.cool`
const MODEL = `${BASE}/demo/yeast/Yeast_structure.g3d.gz`
const DRAWER = process.env.SCREENS_DRAWER ? Number(process.env.SCREENS_DRAWER) : 560
const HEIGHT = Number(process.env.SCREENS_HEIGHT ?? 1260)

;(async () => {
  const s = await open(OUT, { drawer: DRAWER, height: HEIGHT })
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${encodeURIComponent(MAP)}&view=region&region=IV&coarsen=5000&transform=log10&balance=true`)
    await s.mapDrawn()
    await sleep(3000)
    await s.fold('Show the Annotations panel')
    await page.waitForSelector('.structure-card', { timeout: 30000 })
    await s.dropStructure(MODEL, 'Yeast_structure.g3d.gz')
    await page.waitForSelector('.deck-structure', { timeout: 60000 }).catch(() => console.log('no structure cell'))
    await sleep(5000)
    await s.fold('Fold the Annotations panel')
    await s.fold('Fold the General panel')
    await s.fold('Fold the Aesthetics panel')
    await s.openTask('Model versus map')
    await s.pick('structure', 'Yeast_structure')
    const region = await s.field('sequences').locator('input').first().inputValue().catch(() => '')
    console.log('sequences as it opens:', region)
    if (!/^IV$/.test(region.trim())) await s.type('sequences', 'IV')
    await s.shot('structuremap-form')
    await s.run('Spearman', 300000)
    console.log('notes:\n' + (await s.notes()))
    const heads = await page.evaluate(() => [...document.querySelectorAll('.analysis-figure-head')].map((h) => h.textContent.replace(/\s+/g, ' ').trim()))
    console.log('figures:', JSON.stringify(heads))
    await s.shot('structuremap-result')
    // The predicted contacts on their own colour range, from the figure's
    // settings: 1/d^α spans orders of magnitude, and a linear scale fitted to
    // the closest pair leaves every other cell white.
    const VMAX = process.env.SCREENS_VMAX ?? '0.001'
    const predicted = page.locator('.figure-block').filter({ has: page.locator('.analysis-figure-head', { hasText: /^Predicted contacts/ }) }).first()
    if (VMAX !== '') {
      await predicted.locator('.figure-enlarge').first().click()
      await page.waitForSelector('.figure-range input', { timeout: 20000 })
      await sleep(1500)
      const top = page.locator('.figure-range input').nth(1)
      await top.fill(VMAX)
      await top.press('Enter')
      await sleep(2000)
      await s.shot('structuremap-dialog')
      await page.keyboard.press('Escape')
      await sleep(1500)
    }
    await s.scrollDrawerTo('Predicted contacts', 12)
    await sleep(2000)
    await s.shot('structuremap-predicted')
    console.log('blocks:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.analysis-drawer .figure-block')].map((b) => {
      const r = b.getBoundingClientRect()
      return { head: b.querySelector('.analysis-figure-head')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 40), y: Math.round(r.y), h: Math.round(r.height), x: Math.round(r.x), w: Math.round(r.width) }
    }))))
    await s.scrollDrawerTo('Model distance by separation', 12)
    await sleep(2000)
    await s.shot('structuremap-curves')
    await s.scrollDrawerTo('over the same bins', 12)
    await sleep(2000)
    await s.shot('structuremap-ps')
    console.log('table:', await page.evaluate(() => {
      const t = [...document.querySelectorAll('.analysis-drawer table')].find((x) => /Spearman/.test(x.textContent ?? ''))
      return t ? [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.textContent.trim()).join(' | ')).join('\n') : 'none'
    }))
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('structuremap-failure')
  } finally {
    await s.close()
  }
})()
