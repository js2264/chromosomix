/**
 * The picture of Your files → Reference sequences (`files/sequences.md`):
 *
 * - **circular-table** the demo's E. coli `.mcool` opened for the first time,
 *   on its Chromosomes table: the bar under the tabs saying its chromosome
 *   reads as circular, the *circular* column ticked by that first open and the
 *   *origin* column at its first base, and the `↻` the declaration puts on the
 *   General panel's Sequences card.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/files-sequences.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow, around } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/files-sequences'

;(async () => {
  const browser = await launch()
  const w = await newWindow(browser, OUT)
  const { page } = w
  await page.goto(`${BASE}/#uri=${BASE}/demo/ecoli/Ecoli.mcool`)
  await page.waitForSelector('.content .tviewport .tbody .tr', { timeout: 120000 })
  // The test that ticks the circle runs once the table is up.
  await page.waitForFunction(() => document.querySelector('.notice-slot')?.textContent?.includes('circular'), null, {
    timeout: 60000,
  })
  await w.quiet()
  await sleep(1500)
  console.log('  bar:', (await page.locator('.notice-slot').innerText()).replace(/\s+/g, ' '))
  // From the bar under the tabs to the foot of the General panel's Sequences card.
  const clip = await around(page, ['.notice-slot', '.content .tbody .tr', '.seq-card'], 0)
  await w.shot('circular-table', { clip: { ...clip, height: clip.height + 14 } })
  await browser.close()
})()
