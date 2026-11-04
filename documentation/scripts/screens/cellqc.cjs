/**
 * Per-cell contact QC on single mouse cells at 1 Mb, from the lab's bucket
 * (the picture of `analyses/cellqc.mdx`): Nagano et al. (2017)'s cells as an
 * `.scool`, read whole (the dialog an `.scool` at an address asks), every cell
 * measured from the map of all of them summed on chromosome 1 — run from the
 * Cells table itself, the task is refused with *this view has no contact map
 * to run against* — then the Cells table, which the run has given its shares
 * as columns, sorted by the mitotic share, and the drawer opened again over it
 * on the phasing scatter.
 *
 *   node documentation/scripts/screens/cellqc.cjs <out-dir>
 *
 * cellqc-01-map-scatter     the drawer on the scatter, beside the summed map
 * cellqc-02-cells-sorted    the Cells table sorted by the mitotic share, the drawer away
 * cellqc-03-cells-scatter   the same table and the drawer, narrowed, on the scatter beside it
 *                           (the picture on the page)
 *
 * The summed map's veil (*summing 3,882 of 3,882 cells…*) stays up after the
 * map has drawn, so its wait is a short one: the task needs only the framing.
 */

const { BASE, BUCKET, sleep, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'
const SCOOL = process.env.SCREENS_SCOOL ?? `${BUCKET}mouse/nagano_1MB_raw.scool`

;(async () => {
  const s = await start(OUT, { drawer: Number(process.env.SCREENS_DRAWER ?? 430) })
  const { page } = s
  const state = () =>
    page.evaluate(() => {
      const body = document.querySelector('.analysis-drawer-body')
      const row = [...document.querySelectorAll('.analysis-row')].find((n) =>
        (n.textContent ?? '').includes('Per-cell contact QC'),
      )
      return {
        done: (body?.innerText ?? '').includes('Cell-cycle phasing'),
        error: body?.querySelector('.inline-error')?.textContent ?? row?.querySelector('.inline-error')?.textContent ?? '',
        row: (row?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 160),
      }
    })
  const columns = () => page.$$eval('.view-cells .th', (all) => all.map((n) => n.textContent.trim()))
  try {
    await page.goto(`${BASE}/#uri=${SCOOL}&view=region&region=chr1`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    // An .scool at an address asks how to read its list of cells.
    const whole = page.locator('button', { hasText: /^download all .* once$/ }).first()
    await whole.waitFor({ timeout: 180000 }).catch(() => console.log('no load dialog'))
    if (await whole.isVisible().catch(() => false)) await whole.click()
    await page.waitForSelector('.heatmap-canvas', { timeout: 900000 })
    // The map is every cell summed; the task needs only its framing, so the
    // wait for its veil to lift is a short one.
    await page
      .waitForFunction(
        () => [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
        null,
        { timeout: 120000, polling: 2000 },
      )
      .catch(() => console.log('the summed map was still veiled'))
    await sleep(3000)
    await s.foldColumns(['Analysis'])
    await s.shot('cellqc-00-map')

    await s.openTask('Per-cell contact QC')
    console.log('price:', await s.price())
    await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
    for (let waited = 0; waited < 2400; waited += 30) {
      await sleep(30000)
      const now = await state()
      console.log(`${waited + 30} s:`, JSON.stringify(now))
      if (now.done || now.error !== '') break
    }
    await sleep(3000)
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    await s.scrollDrawerTo('.analysis-figure-head', 'Cell-cycle phasing', 10)
    await s.shot('cellqc-01-map-scatter')

    // The Cells table, from the breadcrumb, with the run's shares as columns.
    await s.closeDrawer()
    await page.evaluate(() => {
      location.hash = location.hash.replace(/view=[^&]*/, 'view=cells').replace(/&region=[^&]*/, '')
    })
    await page
      .waitForFunction(() => document.querySelectorAll('.view-cells .tr').length > 5, null, { timeout: 300000 })
      .catch(() => console.log('no cells table'))
    await sleep(3000)
    console.log('columns:', JSON.stringify(await columns()))
    // The mitotic band's column, `2 Mb–12 Mb` at the defaults: sorted, largest first.
    const mitotic = page.locator('.view-cells .th', { hasText: /^2 Mb.12 Mb/ }).first()
    if (await mitotic.count()) {
      await mitotic.click()
      await sleep(800)
      await mitotic.click()
      await sleep(1200)
      console.log('sorted by:', (await mitotic.textContent())?.trim())
    } else console.log('no mitotic column')
    await s.shot('cellqc-02-cells-sorted')

    await s.openTask('Per-cell contact QC')
    await s.scrollDrawerTo('.analysis-figure-head', 'Cell-cycle phasing', 10)
    console.log('drawer over the table:', JSON.stringify(await state()))
    await s.shot('cellqc-03-cells-scatter')
  } finally {
    await s.close()
  }
})()
