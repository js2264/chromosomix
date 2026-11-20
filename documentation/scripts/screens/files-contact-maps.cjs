/**
 * The pictures of Your files → Contact maps (`files/contact-maps.md`):
 *
 * - **scool-cells** a single-cell cooler at an address — the 1 Mb Nagano et al.
 *   mouse `.scool`, named in SCREENS_SCOOL — downloaded once, on its Cells table,
 *   with four cells ticked and the button that sums them;
 * - **pairs-bin** the dialog a `.pairs.gz` opens with: the lab's E. coli
 *   contacts (SRR19500734, named in SCREENS_PAIRS), its base resolution, its
 *   ladder and their cost.
 *
 * Both were on the lab's bucket and are no longer; a picture whose file is not
 * named is skipped.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/files-contact-maps.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow, around } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/files-contact-maps'
// Both files were on the lab's bucket (demo/mouse/, demo/ecoli/) and are no longer: each picture
// is taken when its file is named, by its address, in SCREENS_SCOOL or SCREENS_PAIRS.
const SCOOL = process.env.SCREENS_SCOOL
const PAIRS = process.env.SCREENS_PAIRS

;(async () => {
  const browser = await launch()

  if (SCOOL === undefined) console.log('  scool-cells skipped: name nagano_1MB_raw.scool in SCREENS_SCOOL')
  else {
    const w = await newWindow(browser, OUT)
    const { page } = w
    await page.goto(`${BASE}/#uri=${SCOOL}`)
    // A remote .scool asks first; reading it whole is a minute on a good line.
    await page.getByRole('button', { name: /^download all/ }).click({ timeout: 120000 })
    await page.waitForSelector('.view-cells .tbody .tr', { timeout: 600000 })
    await w.quiet()
    await sleep(1500)
    const boxes = page.locator('.view-cells .tbody .tr .td-check input.tcheck')
    for (const row of [1, 2, 4, 7]) {
      await boxes.nth(row).click()
      await sleep(250)
    }
    await sleep(800)
    console.log('  button:', await page.locator('.view-cells button', { hasText: /^sum \d/ }).first().textContent())
    // The view from its heading to its twelfth row, with a margin round it.
    const view = await around(page, ['.view-cells h2', '.view-cells .table'], 16)
    const row = await page.locator('.view-cells .tbody .tr').nth(11).boundingBox()
    await w.shot('scool-cells', { clip: { ...view, height: Math.round(row.y + row.height + 1 - view.y) } })
    await w.context.close()
  }

  if (PAIRS === undefined) console.log('  pairs-bin skipped: name SRR19500734.pairs.gz in SCREENS_PAIRS')
  else {
    const w = await newWindow(browser, OUT)
    const { page } = w
    await page.goto(`${BASE}/#uri=${PAIRS}`)
    await page.waitForSelector('.modal-backdrop .modal-panel', { timeout: 120000 })
    await w.quiet()
    await sleep(1500)
    console.log('  dialog:', (await page.locator('.modal-panel').innerText()).replace(/\s+/g, ' ').slice(0, 300))
    await w.shot('pairs-bin', { clip: await around(page, ['.modal-panel'], 6) })
    await w.context.close()
  }

  await browser.close()
})()
