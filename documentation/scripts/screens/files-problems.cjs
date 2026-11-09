/**
 * The picture of Your files → When a file will not open (`files/problems.md`):
 *
 * - **cors-refusal** the page a remote map is replaced by when its host does
 *   not allow a cross-origin read: the VGP's Juicer map of the zebra finch
 *   (bTaeGut1) on GenomeArk's public bucket, which serves byte ranges but
 *   sends no `Access-Control-Allow-Origin` — its heading, the message, the
 *   advice and the way out.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/files-problems.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow, around } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/files-problems'
const MAP =
  'https://genomeark.s3.amazonaws.com/species/Taeniopygia_guttata/bTaeGut1/assembly_vgp_standard_1.0/evaluation/juicer/inter_30.hic'

;(async () => {
  const browser = await launch()
  const w = await newWindow(browser, OUT)
  const { page } = w
  await page.goto(`${BASE}/#uri=${MAP}`)
  await page.waitForSelector('.view-error .error-actions', { timeout: 120000 })
  await w.quiet()
  await sleep(1500)
  console.log('  says:', (await page.locator('.view-error').innerText()).replace(/\s+/g, ' ').slice(0, 400))
  // The window from its header down to the buttons under the advice.
  const actions = await around(page, ['.view-error .error-actions'], 0)
  await w.shot('cors-refusal', { clip: { x: 0, y: 0, width: 1440, height: actions.y + actions.height + 48 } })
  await browser.close()
})()
