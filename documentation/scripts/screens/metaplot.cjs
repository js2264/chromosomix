/**
 * Metaplot over a feature set (analyses/metaplot.mdx): the yeast demo's ATAC
 * bigWig about the start of every transcript of its GTF — the form's
 * defaults, 2 kb either side in 50 bp columns, strand respected — with the
 * per-feature heatmap on: the drawer's profile above its heatmap.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/metaplot.cjs <out-dir>
 *
 * The window is 1440 × 1180 rather than the other pages' 900: a figure in
 * the drawer is drawn 0.78 times as tall as it is wide (260 to 520 px), so a
 * 900 px window cannot hold the profile and its heatmap at once, and the page
 * is about the two together. The picture is the drawer alone, cropped.
 */
const { open, sleep, BASE } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const HEIGHT = Number(process.env.SCREENS_HEIGHT ?? 1180)
const DRAWER = process.env.SCREENS_DRAWER ? Number(process.env.SCREENS_DRAWER) : 560

;(async () => {
  const s = await open(OUT, { height: HEIGHT, drawer: DRAWER })
  const { page } = s
  try {
    await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
    await s.mapDrawn()
    await sleep(4000)
    await s.fold('Fold the General panel')
    await s.fold('Fold the Aesthetics panel')
    await s.openTask('Metaplot over a feature set')
    console.log('features offered:', JSON.stringify(await s.field('features').locator('option').allTextContents()))
    await s.pick('features', 'genes')
    await s.only('tracks', ['ATAC'])
    await s.toggle('per-feature heatmap', true)
    await s.shot('metaplot-form')
    await s.run('per feature', 600000)
    console.log('notes:\n' + (await s.notes()))
    const heads = await page.evaluate(() => [...document.querySelectorAll('.analysis-figure-head')].map((h) => h.textContent.replace(/\s+/g, ' ').trim()))
    console.log('figures:', JSON.stringify(heads))
    const profile = page.locator('.figure-block').filter({ has: page.locator('.figure-chart svg') }).first()
    await profile.evaluate((node) => node.scrollIntoView({ block: 'start' }))
    await sleep(2500)
    await s.shot('metaplot-profile')
    const blocks = await page.evaluate(() => [...document.querySelectorAll('.analysis-drawer .figure-block')].map((b) => {
      const r = b.getBoundingClientRect()
      return { head: b.querySelector('.analysis-figure-head')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 50), y: Math.round(r.y), h: Math.round(r.height), x: Math.round(r.x), w: Math.round(r.width) }
    }))
    console.log('blocks:', JSON.stringify(blocks))
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('metaplot-failure')
  } finally {
    await s.close()
  }
})()
