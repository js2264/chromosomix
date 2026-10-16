/**
 * The distance axis on a scalogram's lane (§18.12), end to end.
 *
 * On the yeast demo: the Scalogram task run with its defaults, then its lane
 * beside the map — the range read as distances (`1 kb – 104 kb`, where it read
 * the exponents `0 – 16.7`), a faint rule at each power of ten and its distance
 * written at the lane's foot, clear of the five names — close up; the same lane
 * in the browser, across the page; and the map's PNG, which carries the axis.
 * Each step prints the lane's range as the label wrote it.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-scalogram-axis.mjs [out-dir]
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const FILES = join(OUT, 'files')
mkdirSync(FILES, { recursive: true })
const { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })
await page.context().addInitScript(() => {
  window.showSaveFilePicker = undefined
})

const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(2500)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await page.locator('.analysis-row-title', { hasText: /^Scalogram$/ }).first().click()
  await sleep(1200)
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(() => /tracks? added/.test(document.body.textContent ?? ''), null, { timeout: 300000 })
  await sleep(2000)
  await page.keyboard.press('Escape')
  await sleep(3000)
  await shot('sa01-map')

  // The lane close up: the left-hand stack of the map's plot.
  const lanes = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 20)
    const heat = document.querySelector('.heatmap-canvas')?.getBoundingClientRect()
    const left = canvases
      .map((c) => c.getBoundingClientRect())
      .filter((r) => heat !== undefined && r.right <= heat.left + 2 && r.height > 200)
      .sort((a, b) => b.right - a.right)[0]
    return left === undefined ? null : { x: left.x, y: left.y, width: left.width, height: left.height }
  })
  if (lanes !== null) {
    await page.screenshot({
      path: `${OUT}/sa02-lane-close.png`,
      clip: { x: lanes.x - 4, y: lanes.y - 8, width: lanes.width + 8, height: lanes.height + 16 },
      scale: 'device',
    })
    console.log('wrote sa02-lane-close.png')
  } else console.log('no left-hand lane found')

  // The figure saved from the map, axis and all, from the Export card.
  await fold('Show the Aesthetics panel')
  await sleep(2500)
  const card = page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()
  await card.scrollIntoViewIfNeeded()
  await card.locator('select.select-format').selectOption('png')
  await card.locator('select.select-dpi').selectOption('96').catch(() => {})
  const arriving = page.waitForEvent('download', { timeout: 120000 })
  await card.locator('.export-acts button').first().click()
  const saved = await arriving
  copyFileSync(await saved.path(), join(FILES, 'sa03-map.png'))
  console.log('saved sa03-map.png', `(${saved.suggestedFilename()})`)

  // The browser, the same lanes across the page.
  await page.evaluate(() => {
    const hash = new URLSearchParams(location.hash.slice(1))
    const region = hash.get('region')
    hash.set('view', 'browser')
    hash.delete('region')
    if (region !== null) hash.set('locus', region)
    location.hash = hash.toString()
  })
  await sleep(5000)
  await shot('sa04-browser')
} finally {
  await close()
}
