/**
 * A block of two windows, typed (§5.4): the region box on the yeast demo given
 * `IV:1,000,001-1,200,000 V:1-200,000`, then the same pair with ` x ` and with
 * `|` between, each opening IV × V — and the box then showing the pair with `×`
 * between, which Enter opens again without moving; then the whole genome's own
 * box given `I x II`, and the Chromosomes table's given a pair of windows.
 *
 * Every step prints the box, the title over the map and the hash, so a pair
 * that opened one window, or a box that showed half of what it holds, is a line
 * here as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-locus-pairs.mjs [out-dir]
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })
const COOL = `${base}/demo/yeast/Yeast_microC_G2M_1kb.cool`

const settled = async () => {
  await sleep(1500)
  await page.waitForFunction(
    () =>
      document.querySelector('.heatmap-canvas') !== null &&
      [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
    null,
    { timeout: 180000 },
  )
  await sleep(1200)
}
const said = async (step) => {
  const state = await page.evaluate(() => {
    const hash = new URLSearchParams(location.hash.slice(1))
    return {
      box: document.querySelector('.input-region')?.value ?? document.querySelector('.search-box input')?.value,
      title: document.querySelector('.panel-title, .view-title, h2')?.textContent?.trim(),
      view: hash.get('view'),
      region: hash.get('region'),
      region2: hash.get('region2'),
      error: document.querySelector('.inline-error:not(.hidden)')?.textContent?.trim() ?? null,
    }
  })
  console.log(`--- ${step}: ${JSON.stringify(state)}`)
}
const typeInto = async (selector, text) => {
  const box = page.locator(selector).first()
  await box.click()
  await box.fill(text)
  await box.press('Enter')
  await settled()
}

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await settled()
  await said('the demo')

  await typeInto('.input-region', 'IV:1,000,001-1,200,000 V:1-200,000')
  await said('typed with a space between')
  await shot('lp01-pair-space')

  await typeInto('.input-region', 'IV:1,000,001-1,200,000 x V:1-200,000')
  await said('typed with x between')
  await typeInto('.input-region', 'IV:1,000,001-1,200,000|V:1-200,000')
  await said('typed with | between')
  await shot('lp02-pair-pipe')

  // Enter on what the box shows: the same block.
  const before = await page.evaluate(() => location.hash)
  await page.locator('.input-region').first().press('Enter')
  await settled()
  const after = await page.evaluate(() => location.hash)
  console.log('Enter on the box’s own pair moved the view:', before !== after)
  await page.locator('.input-region').first().screenshot({ path: `${OUT}/lp03-box-shows-pair.png` })
  console.log('shot lp03-box-shows-pair')

  // The whole genome's box.
  await page.goto(`${base}/#uri=${COOL}&view=whole`)
  await page.waitForSelector('button:has-text("compute whole genome")', { timeout: 120000 })
  await page.locator('.view-head input').first().fill('I x II')
  await page.locator('.view-head input').first().press('Enter')
  await settled()
  await said('I x II from the whole genome’s box')
  await shot('lp04-whole-box-pair')

  // The Chromosomes table's box.
  await page.goto(`${base}/#uri=${COOL}&view=contigs`)
  await sleep(4000)
  const tableBox = page.locator('.seqbar input, .seqbar-box input, .view-head input').first()
  if ((await tableBox.count()) > 0) {
    await tableBox.fill('XII:1-300,000 × XIV:1-300,000')
    await tableBox.press('Enter')
    await settled()
    await said('a pair from the Chromosomes table')
    await shot('lp05-table-box-pair')
  } else {
    console.log('(no Chromosomes table box found)')
  }
} finally {
  await close()
}
