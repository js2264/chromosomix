/**
 * Per-cell contact QC on single mouse cells at 1 Mb, from the lab's bucket
 * (the picture of `analyses/cellqc.mdx`): Nagano et al. (2017)'s cells as an
 * `.scool`, read whole (the dialog an `.scool` at an address asks), every cell
 * measured, the Cells table sorted by the mitotic share the run added to it,
 * and the phasing scatter in the drawer beside the table.
 *
 *   node documentation/scripts/screens/cellqc.cjs <out-dir>
 *
 * cellqc-00-cells     the Cells table as the file opens
 * cellqc-01-scatter   the table, sorted by the mitotic share, and the drawer on the scatter
 */

const { BASE, BUCKET, sleep, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'
const SCOOL = process.env.SCREENS_SCOOL ?? `${BUCKET}mouse/nagano_1MB_raw.scool`

;(async () => {
  const s = await start(OUT, { drawer: Number(process.env.SCREENS_DRAWER ?? 640) })
  const { page } = s
  try {
    await page.goto(`${BASE}/#uri=${SCOOL}&view=cells`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    // An .scool at an address asks how to read its list of cells.
    const whole = page.locator('button', { hasText: /^download all .* once$/ }).first()
    await whole.waitFor({ timeout: 180000 }).catch(() => console.log('no load dialog'))
    if (await whole.isVisible().catch(() => false)) await whole.click()
    await page
      .waitForFunction(() => document.querySelectorAll('.view-cells .tr').length > 5, null, { timeout: 900000 })
      .catch(() => console.log('no cells table'))
    await sleep(4000)
    await s.foldColumns(['Analysis'])
    await s.shot('cellqc-00-cells')
    console.log(
      'columns before:',
      JSON.stringify(await page.$$eval('.view-cells .th', (all) => all.map((n) => n.textContent.trim()))),
    )
    await s.openTask('Per-cell contact QC')
    console.log('price:', await s.price())
    await s.run('Cell-cycle phasing', { timeout: 2400000 })
    console.log('notes:', JSON.stringify(await s.notes()))
    console.log('figures:', JSON.stringify(await s.figures()))
    const heads = await page.$$eval('.view-cells .th', (all) => all.map((n) => n.textContent.trim()))
    console.log('columns after:', JSON.stringify(heads))
    // The mitotic band's column, `2 Mb–12 Mb` at the defaults: sorted, largest first.
    const mitotic = page.locator('.view-cells .th', { hasText: /2 Mb.12 Mb/ }).first()
    if (await mitotic.count()) {
      await mitotic.click()
      await sleep(800)
      const arrow = await mitotic.locator('.sort-arrow').textContent()
      if (!/↓|▼|desc/i.test(arrow ?? '')) {
        await mitotic.click()
        await sleep(800)
      }
      console.log('sorted by:', (await mitotic.textContent())?.trim())
    } else console.log('no mitotic column')
    await s.scrollDrawerTo('.analysis-figure-head', 'Cell-cycle phasing', 10)
    await s.shot('cellqc-01-scatter')
  } finally {
    await s.close()
  }
})()
