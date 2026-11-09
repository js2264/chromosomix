/**
 * A 4C profile on the yeast Micro-C demo at 1 kb, chromosome IV (the picture of
 * `analyses/fourc.mdx`): the profile from IV:1,200,001-1,210,000 over P(s), the
 * anchor region left out, as a lane beside the map; then *pick on map* pressed
 * again — lit, *pointing…* — and a Shift-drag held across the anchor's stretch,
 * the band it names drawn on the map while the hand is still down.
 *
 *   node documentation/scripts/screens/fourc.cjs <out-dir>
 *
 * fourc-01-lane         the profile's lane beside the map, the drawer away
 * fourc-02-picking      the drawer narrowed beside the map, pick on map lit, the band held
 */

const { DEMO, sleep, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT, { drawer: 600 })
  const { page } = s
  try {
    await s.open(`#uri=${DEMO}yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1100000-1300000`)
    await s.foldColumns(['Analysis', 'Aesthetics'])
    await s.openTask('4C profile from an anchor')
    const anchor = s.field('anchor').locator('input').first()
    await anchor.fill('IV:1,200,001-1,210,000')
    await anchor.press('Enter')
    await sleep(600)
    await s.choose('by P(s)')
    // The anchor's contact with itself left out, so the lane's range is read
    // off the profile rather than off the one spike at the anchor.
    await s.field('exclude anchor region').locator('button').first().click()
    await sleep(600)
    console.log('price:', await s.price())
    await s.run('4C ·')
    console.log('notes:', JSON.stringify(await s.notes()))
    await s.settled()
    await s.shot('fourc-00-ran')

    // The anchor named again from the map: the button lit, and a Shift-drag
    // along the columns over the anchor's ten bins, held.
    await page.evaluate(() => {
      const body = document.querySelector('.analysis-drawer-body')
      if (body) body.scrollTop = 0
    })
    await s.field('anchor').locator('button', { hasText: /^pick on map$/ }).first().click()
    await sleep(700)
    const map = await s.box('.heatmap-canvas')
    // IV:1,100,001-1,300,000 across the canvas's plot: the anchor is half way.
    const plot = await page.evaluate(() => {
      const c = document.querySelector('.heatmap-canvas')
      const r = c.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    console.log('map:', JSON.stringify(map), JSON.stringify(plot))
    const y = plot.y + plot.height * 0.3
    const x0 = plot.x + plot.width * 0.5
    const x1 = plot.x + plot.width * 0.55
    await page.keyboard.down('Shift')
    await page.mouse.move(x0, y)
    await page.mouse.down()
    for (let k = 1; k <= 12; k++) {
      await page.mouse.move(x0 + ((x1 - x0) * k) / 12, y)
      await sleep(30)
    }
    await sleep(600)
    await s.shot('fourc-02-picking')
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await sleep(1200)
    console.log('anchor after the pick:', await s.field('anchor').locator('input').first().inputValue())
    await s.shot('fourc-03-picked')
    await s.closeDrawer()
    await s.foldColumns()
    await s.shot('fourc-01-lane')
  } finally {
    await s.close()
  }
})()
