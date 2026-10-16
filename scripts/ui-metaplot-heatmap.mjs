/**
 * The metaplot's per-feature heatmap as one picture (§18.8, §18.13).
 *
 * On the yeast demo, the metaplot of ATAC over its own peaks with the heatmap
 * on: the drawer's figure, close up — one smoothed image with no seams and no
 * frame, where it was a grid of squares — the pointer resting on it (no border
 * lights and no card opens), the figure enlarged, and its PNG and PDF, the PDF
 * rendered with poppler's `pdftoppm` and its image checked for `/Interpolate`.
 * The files are written under `files/`.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-metaplot-heatmap.mjs [out-dir]
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
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
const pick = async (label, wanted) => {
  const control = page
    .locator('.analysis-form .field')
    .filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) })
    .first()
  if ((await control.count()) === 0) return false
  const select = control.locator('select').first()
  if (await select.count()) {
    const options = await select.locator('option').evaluateAll((all) => all.map((one) => ({ value: one.value, text: one.textContent ?? '' })))
    const match = options.find((one) => one.text.includes(wanted) || one.value.includes(wanted))
    if (match === undefined) return false
    await select.selectOption(match.value)
    await sleep(500)
    return true
  }
  const row = control.locator('label', { hasText: wanted }).first()
  if ((await row.count()) === 0) return false
  await row.locator('input[type="checkbox"]').check()
  await sleep(500)
  return true
}
const download = async (name, press) => {
  const arriving = page.waitForEvent('download', { timeout: 120000 })
  await press()
  const file = await arriving
  const path = join(FILES, name)
  copyFileSync(await file.path(), path)
  console.log('saved', name, `(${file.suggestedFilename()})`)
  return path
}

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(2500)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await page.locator('text=Metaplot over a feature set').first().click()
  await sleep(1200)
  console.log('features:', await pick('Features', 'ATAC peaks'), 'tracks:', await pick('Tracks', 'ATAC'))
  const heatmap = page
    .locator('.analysis-form .field')
    .filter({ has: page.locator('.field-label', { hasText: /heatmap/i }) })
    .first()
    .locator('button[aria-pressed="false"]')
  if (await heatmap.count()) await heatmap.click()
  await sleep(500)
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(
    () => [...document.querySelectorAll('.analysis-figure-head')].some((head) => /per feature/.test(head.textContent ?? '')),
    null,
    { timeout: 300000 },
  )
  await sleep(3000)
  const heat = page
    .locator('.figure-block')
    .filter({ has: page.locator('.analysis-figure-head', { hasText: /per feature/ }) })
    .first()
  await heat.scrollIntoViewIfNeeded()
  await sleep(800)
  console.log('drawn as:', await heat.evaluate((block) => (block.querySelector('svg') !== null ? 'a chart (rects)' : block.querySelector('canvas') !== null ? 'one canvas' : 'nothing')))
  await heat.screenshot({ path: `${OUT}/mh01-heatmap.png` })
  console.log('shot mh01-heatmap')

  // The pointer over it: nothing lights and no card opens.
  const box = await heat.locator('canvas').first().boundingBox()
  if (box !== null) await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4)
  await sleep(800)
  console.log('a card under the pointer:', await page.evaluate(() => document.querySelector('.figure-tooltip:not(.hidden), .echarts-tooltip, [class*="tooltip"]:not(.hidden)')?.textContent ?? null))
  await shot('mh02-pointer-over')

  await heat.locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage', { timeout: 20000 })
  await sleep(2000)
  await shot('mh03-dialog')
  await page.keyboard.press('Escape')
  await sleep(800)

  await download('mh04-heatmap.png', () => heat.locator('.analysis-figure-head button', { hasText: 'PNG' }).first().click())
  const pdf = await download('mh05-heatmap.pdf', () => heat.locator('.analysis-figure-head button', { hasText: 'PDF' }).first().click())
  const text = readFileSync(pdf).toString('latin1')
  console.log('pdf image:', text.includes('/Subtype /Image') ? 'one image' : 'NO IMAGE', text.includes('/Interpolate true') ? 'interpolated' : 'NOT interpolated')
  try {
    execFileSync('pdftoppm', ['-png', '-r', '110', '-singlefile', pdf, join(FILES, 'mh05-heatmap-page')])
    console.log('rendered mh05-heatmap-page.png')
  } catch (err) {
    console.log('(no pdftoppm:', String(err).split('\n')[0], ')')
  }
} finally {
  await close()
}
