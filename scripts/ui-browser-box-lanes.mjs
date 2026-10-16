/**
 * A box marked in the 1D browser, then the map (§8.1): washed over the tracks
 * in both, and boxed on the map.
 *
 * On the yeast demo, a stretch of IV boxed from the 1D browser — the box the
 * Rectangles form's *pick on track* drag makes, its two sides one stretch —
 * washed over the browser's tracks; then the map, the same box on its diagonal
 * and the same wash over the tracks beside it and under it, close up; then a
 * box off the diagonal, whose two stretches are washed over every stack, and
 * the map's saved PNG. Prints how many pixels of the wash each stack carries.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-browser-box-lanes.mjs [out-dir]
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
const manual = () =>
  page.locator('.annotation-card').filter({ has: page.locator('.card-head', { hasText: /Manual annotations/i }) }).first()
const form = (title) =>
  manual()
    .locator('.manual-form')
    .filter({ has: page.locator('.manual-form-title', { hasText: new RegExp(`^${title}$`) }) })
    .first()
/** The pointer off every picture, so its guide line is not read as a mark. */
const park = async () => {
  await page.mouse.move(8, 992)
  await sleep(400)
}
const view = (name, locus) =>
  page.evaluate(
    ({ name, locus }) => {
      const hash = new URLSearchParams(location.hash.slice(1))
      hash.set('view', name)
      if (name === 'browser') {
        hash.delete('region')
        hash.set('locus', locus)
      } else {
        hash.delete('locus')
        hash.set('region', locus)
      }
      location.hash = hash.toString()
    },
    { name, locus },
  )

/**
 * Pixels of each lane canvas that the box's wash tints: the mark's colour at a
 * tenth over the canvas, read as the share of pixels whose colour moved toward
 * it — counted per stack, beside the pixels in the anchor band past the lanes.
 */
const washed = () =>
  page.evaluate(() => {
    const out = {}
    for (const canvas of document.querySelectorAll('canvas.lane-canvas')) {
      const box = canvas.getBoundingClientRect()
      if (box.width < 4 || box.height < 4) continue
      const ctx = canvas.getContext('2d')
      if (ctx === null) continue
      const name = [...canvas.classList].join('.')
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let tinted = 0
      for (let at = 0; at < data.length; at += 4) {
        // The wash is a tenth of the mark's ink over a transparent canvas: a
        // faint, nearly transparent pixel of a grey or a colour.
        const alpha = data[at + 3]
        if (alpha > 10 && alpha < 40) tinted++
      }
      out[name] = { tinted, width: canvas.width, height: canvas.height }
    }
    return out
  })

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(2500)
  await fold('Fold the General panel')
  await fold('Show the Annotations panel')

  // The 1D browser, and a box on IV: its two sides one stretch, which is what
  // the Rectangles form's drag on the tracks makes.
  await view('browser', 'IV:1,000,001-1,400,000')
  await page.waitForSelector('.browser-canvas, canvas.browser', { timeout: 60000 }).catch(() => {})
  await sleep(4000)
  await form('Rectangles').locator('input.input').first().fill('IV:1,150,000-1,230,000')
  await form('Rectangles').locator('button', { hasText: /^add$/ }).click()
  await sleep(1500)
  await park()
  await shot('bb01-browser-box')

  // The map: the same box on the diagonal, and over the tracks beside it.
  await view('region', 'IV:1000000-1400000')
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 120000 })
  await sleep(5000)
  await park()
  console.log('on the diagonal, lanes:', JSON.stringify(await washed()))
  await shot('bb02-map-box')

  // The stack under the map, close up: the wash and nothing hanging past it.
  const under = await page.evaluate(() => {
    const heat = document.querySelector('.heatmap-canvas')?.getBoundingClientRect()
    if (heat === undefined) return null
    return { x: heat.left - 40, y: heat.bottom - 10, width: heat.width + 80, height: 300 }
  })
  if (under !== null) {
    await page.screenshot({ path: `${OUT}/bb03-lanes-close.png`, clip: under })
    console.log('wrote bb03-lanes-close.png')
  }

  // A box off the diagonal: rows on one stretch, columns on another. Each
  // stack washes both, as the browser does.
  await form('Rectangles').locator('input.input').nth(0).fill('IV:1,040,000-1,080,000')
  await form('Rectangles').locator('input.input').nth(1).fill('IV:1,300,000-1,360,000')
  await form('Rectangles').locator('button', { hasText: /^add$/ }).click()
  await sleep(2000)
  await park()
  console.log('off the diagonal too, lanes:', JSON.stringify(await washed()))
  await shot('bb04-map-off-diagonal')

  // The map's PNG, the lanes and their washes with it.
  await fold('Fold the Annotations panel')
  await fold('Show the Aesthetics panel')
  await sleep(1500)
  const card = page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()
  await card.scrollIntoViewIfNeeded()
  await card.locator('select.select-format').selectOption('png')
  const arriving = page.waitForEvent('download', { timeout: 120000 })
  await card.locator('.export-acts button').first().click()
  const saved = await arriving
  copyFileSync(await saved.path(), join(FILES, 'bb05-map.png'))
  console.log('saved bb05-map.png')
} finally {
  await close()
}
