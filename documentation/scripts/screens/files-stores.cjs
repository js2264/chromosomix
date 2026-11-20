/**
 * The pictures of Your files → Data stores (`files/stores.md`):
 *
 * - **store-tiles** the landing page's *Connect to a data store* tiles with
 *   *Just looking?* and its four example sessions in the margin beside them;
 * - **store-drawer** 4DN's K562 Hi-C (4DNESC23ZYOF) opened from the store on
 *   chr15 at 250 kb, then the drawer opened again from the header, on 4DN,
 *   dragged narrower by its edge so that the map shows beside it (the
 *   Aesthetics panel folded for the room), with two facets ticked — K562
 *   under *Biosource*, `bw` under *Format* — which leave one set's two
 *   bigWigs, both ticked, so that the tray offers them together. (Narrowed to
 *   one set on purpose: a group heading scrolled under the tray is drawn over
 *   it, `.portal-group`'s z-index above the tray's.)
 *
 * Network: the stores are read from the deployed site and the map from 4DN's
 * bucket, so `HTTPS_PROXY` is handed to Chromium (see the lib).
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/files-stores.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow, around } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/files-stores'
const SET = '4DNESC23ZYOF'
/** A pattern matching `text` and nothing longer: a facet's value as written. */
const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^$()|[\]{}\\]/g, (c) => `\\${c}`)}$`)

;(async () => {
  const browser = await launch()
  const w = await newWindow(browser, OUT, { published: true })
  const { page } = w

  // The tiles and the examples beside them.
  await page.goto(`${BASE}/`)
  await page.waitForSelector('.picker-stores .store-tile[data-store="4dn"]', { timeout: 60000 })
  await w.quiet()
  await sleep(1000)
  // Short of the status bar under the window's edge.
  const tiles = await around(page, ['.picker-store-section', '.picker-examples'], 20)
  await w.shot('store-tiles', { clip: { ...tiles, height: tiles.height - 14 } })

  // The set opened with its tracks, on chr15 at 250 kb.
  await page.click('.picker-stores .store-tile[data-store="4dn"]')
  const search = page.locator('.store-drawer .portal-search')
  await search.waitFor({ timeout: 120000 })
  await search.fill(SET)
  await page.waitForFunction(
    (set) => [...document.querySelectorAll('.store-drawer .portal-group-key')].some((n) => n.textContent?.includes(set)),
    SET,
    { timeout: 120000 },
  )
  await sleep(800)
  await page.locator('.store-drawer .portal-group', { hasText: SET }).locator('.portal-session').first().click()
  await page.waitForSelector('.content .tviewport .tbody .tr', { timeout: 180000 })
  await w.quiet(120000)
  // The resolution is the reader's to pick with *Refine on zoom* unticked (SPECS §2).
  if (await page.locator('.crumb-res .res-refine input').first().isChecked()) await page.click('.crumb-res .res-refine input')
  await sleep(800)
  await page.selectOption('select.res-pick', { label: '250 kb' })
  await sleep(1500)
  await page.click('.content .tviewport .tr .td[title="chr15"]')
  await page.waitForSelector('.heatmap-canvas', { timeout: 180000 })
  await w.quiet(180000)
  await w.tracksRead(1)
  await sleep(2500)

  // The drawer again, from the header: it comes back on 4DN. Narrowed by its
  // edge, with the Aesthetics panel folded, so that the map stands beside it.
  await w.fold('Fold the Aesthetics panel')
  await sleep(1500)
  await page.click('.head-files button[aria-label="stores"]')
  await page.waitForSelector('.store-drawer:not(.collapsed) .portal-search', { timeout: 60000 })
  await search.fill('')
  await sleep(1500)
  const edge = await page.evaluate(() => {
    const r = document.querySelector('.store-drawer > .panel-column-handle').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const target = 640
  await page.mouse.move(edge.x, edge.y)
  await page.mouse.down()
  for (let k = 1; k <= 12; k++) {
    await page.mouse.move(edge.x + ((target - edge.x) * k) / 12, edge.y)
    await sleep(30)
  }
  await page.mouse.up()
  await sleep(1500)
  console.log('  drawer width:', await page.evaluate(() => Math.round(document.querySelector('.store-drawer').getBoundingClientRect().width)))
  /** Tick one value of one facet, by the facet's label and the value's text. */
  const tick = async (facet, value) => {
    const group = page.locator('.store-drawer .facet-group', { has: page.locator('.facet-label', { hasText: new RegExp(`^${facet}$`) }) }).first()
    const filter = group.locator('.facet-filter')
    if ((await filter.count()) > 0) {
      await filter.fill(value)
      await sleep(600)
    }
    await group.locator('label.facet-value', { has: page.locator('.facet-value-text', { hasText: exactly(value) }) }).first().click()
    await sleep(1500)
    if ((await filter.count()) > 0) {
      await filter.fill('')
      await sleep(600)
    }
  }
  console.log('  facets:', await page.$$eval('.store-drawer .facet-label', (labels) => labels.map((l) => l.textContent)))
  await tick('Biosource', 'K562')
  await tick('Format', 'bw')
  await w.quiet()
  // Two rows of the answer, ticked.
  const boxes = page.locator('.store-drawer .portal-row input.portal-box')
  console.log('  rows with a box:', await boxes.count())
  await boxes.nth(0).click()
  await sleep(500)
  await boxes.nth(1).click()
  await sleep(1200)
  console.log('  tray:', (await page.locator('.store-drawer .portal-tray').innerText()).replace(/\s+/g, ' '))
  await w.shot('store-drawer')
  console.log('  errors:', w.errors.slice(0, 6))
  await browser.close()
})()
