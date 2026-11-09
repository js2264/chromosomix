/**
 * The pictures of Your files → Contact maps (`files/contact-maps.md`):
 *
 * - **scool-cells** a single-cell cooler on the lab's bucket — the 1 Mb
 *   Nagano et al. mouse `.scool` — downloaded once, on its Cells table, with
 *   four cells ticked and the button that sums them;
 * - **pairs-bin** the dialog a `.pairs.gz` opens with: the lab's E. coli
 *   contacts (SRR19500734), its base resolution, its ladder and their cost.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/files-contact-maps.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow, around } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/files-contact-maps'
const BUCKET = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo'

;(async () => {
  const browser = await launch()

  {
    const w = await newWindow(browser, OUT)
    const { page } = w
    await page.goto(`${BASE}/#uri=${BUCKET}/mouse/nagano_1MB_raw.scool`)
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

  {
    const w = await newWindow(browser, OUT)
    const { page } = w
    await page.goto(`${BASE}/#uri=${BUCKET}/ecoli/SRR19500734.pairs.gz`)
    await page.waitForSelector('.modal-backdrop .modal-panel', { timeout: 120000 })
    await w.quiet()
    await sleep(1500)
    console.log('  dialog:', (await page.locator('.modal-panel').innerText()).replace(/\s+/g, ' ').slice(0, 300))
    await w.shot('pairs-bin', { clip: await around(page, ['.modal-panel'], 6) })
    await w.context.close()
  }

  await browser.close()
})()
