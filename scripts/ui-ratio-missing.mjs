/**
 * A ratio of two maps where either has no contacts (§6): missing, drawn in the
 * colormap's middle.
 *
 * The yeast cooler against a perturbed copy of itself, written under
 * `gallery/` — which the dev server serves and git does not track — with a
 * third of its pixels zeroed and every other count scaled by a factor between
 * a half and two, so the ratio has both arms and a cell missing on one side:
 * the pair compared as a *ratio* over a window of IV at 1 kb. Every cell the
 * copy lost is missing and drawn white, the middle of `RdBu_r`, where `4 / 0`
 * used to be the top of the scale; close up, with the readout over one; and as
 * a *difference*, which keeps its zeros and leaves its unbalanced bins to the
 * paper. Prints, for each picture, how many of the map's pixels are the ramp's
 * middle, its top, its bottom and the paper.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-ratio-missing.mjs [out-dir]
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import h5wasm from 'h5wasm/node'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'

// --- the second map: the cooler with a third of its pixels zeroed -----------
mkdirSync('gallery', { recursive: true })
const COPY = 'gallery/Yeast_perturbed.cool'
copyFileSync('demo/yeast/Yeast_microC_G2M_1kb.cool', COPY)
await h5wasm.ready
{
  const file = new h5wasm.File(COPY, 'a')
  const dataset = file.get('pixels/count')
  const counts = Int32Array.from(dataset.value)
  // A fixed sequence, so a rerun is the same picture.
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  let zeroed = 0
  for (let i = 0; i < counts.length; i++) {
    if (random() < 1 / 3) {
      counts[i] = 0
      zeroed++
    } else {
      counts[i] = Math.max(1, Math.round(counts[i] * (0.5 + 1.5 * random())))
    }
  }
  dataset.write_slice([[0, counts.length]], counts)
  file.flush()
  file.close()
  console.log(`wrote ${COPY}: ${zeroed.toLocaleString()} of ${counts.length.toLocaleString()} pixels zeroed`)
}

const WINDOW = 'IV:1,150,001-1,250,000'

/** A browser on the pair. */
async function pair() {
  const handle = await gallery(OUT, { width: 1600, height: 1000 })
  const { page, base } = handle
  const cool = `${base}/demo/yeast/Yeast_microC_G2M_1kb.cool`
  const copy = `${base}/${COPY}`
  await page.goto(`${base}/#uri=${cool}&uri2=${copy}&view=region&region=${WINDOW.replaceAll(',', '')}`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(3000)
  for (const b of await page.$$('button[title^="Fold the General panel"]')) {
    if (await b.isVisible()) {
      await b.click()
      break
    }
  }
  await sleep(800)
  return handle
}

const compareTo = async (page, op) => {
  await page
    .locator('.field')
    .filter({ has: page.locator('.field-label', { hasText: /^compare$/ }) })
    .locator('select')
    .first()
    .selectOption(op)
  await sleep(1500)
  await page.waitForFunction(
    () => [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
    null,
    { timeout: 120000 },
  )
  await sleep(1500)
}

/**
 * The map's pixels by colour: the ramp's middle (RdBu_r's `#F7F7F7`-ish
 * white), its saturated top (dark red) and bottom (dark blue), and the rest.
 */
const census = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('.heatmap-canvas')
    const ctx = canvas?.getContext('2d')
    if (canvas === null || ctx === null) return null
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let middle = 0
    let top = 0
    let bottom = 0
    let paper = 0
    let all = 0
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
      all++
      if (a < 10) paper++
      else if (r > 235 && g > 235 && b > 235) middle++
      else if (r > 90 && r < 140 && g < 20 && b < 50) top++
      else if (r < 20 && g < 70 && b > 80 && b < 120) bottom++
    }
    const pct = (n) => `${((100 * n) / all).toFixed(1)}%`
    return { middle: pct(middle), top: pct(top), bottom: pct(bottom), paper: pct(paper) }
  })

const handle = await pair()
try {
  const { page, shot } = handle
  await compareTo(page, 'ratio')
  console.log('ratio:', JSON.stringify(await census(page)))
  await shot('rm01-ratio')

  // Close up, the pointer over a missing cell: the readout says so.
  const heat = await page.locator('.heatmap-canvas').first().boundingBox()
  if (heat !== null) {
    const spot = await page.evaluate(() => {
      const canvas = document.querySelector('.heatmap-canvas')
      const ctx = canvas.getContext('2d')
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      // A white pixel well off the diagonal, in the canvas's own pixels.
      for (let y = Math.floor(height * 0.15); y < height * 0.4; y += 3) {
        for (let x = Math.floor(width * 0.6); x < width * 0.9; x += 3) {
          const i = (y * width + x) * 4
          if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235 && data[i + 3] > 200) {
            return { x: x / width, y: y / height }
          }
        }
      }
      return null
    })
    if (spot !== null) {
      await page.mouse.move(heat.x + spot.x * heat.width, heat.y + spot.y * heat.height)
      await sleep(800)
      console.log('readout over a white cell:', await page.evaluate(() => document.querySelector('.statusbar, .status-readout, footer')?.textContent?.replace(/\s+/g, ' ').trim() ?? null))
    }
    await page.screenshot({
      path: `${OUT}/rm02-ratio-close.png`,
      clip: { x: heat.x + heat.width * 0.5, y: heat.y, width: heat.width * 0.5, height: heat.height * 0.5 },
    })
    console.log('wrote rm02-ratio-close.png')
  }

  // The difference keeps its zeros, and its unbalanced bins are paper.
  await page.mouse.move(8, 990)
  await compareTo(page, 'difference')
  console.log('difference:', JSON.stringify(await census(page)))
  await shot('rm03-difference')
} finally {
  await handle.close()
}
