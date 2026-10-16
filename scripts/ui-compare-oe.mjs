/**
 * The O/E under a ratio of two maps (§7.5): greyed, unlit and saying why.
 *
 * The yeast cooler against the perturbed copy `ui-ratio-missing.mjs` writes
 * under `gallery/` (written here too when it is not there), over a window of IV
 * at 1 kb, opened with the O/E on: as a split, the toggle lit and both maps
 * drawn over their expected; as a *ratio*, the toggle greyed and out, the ratio
 * taken of the two maps as they are, and `e` pressed changing nothing; as a
 * *difference*, lit again and drawn; and back to the split. Each step prints the
 * O/E button's state and tooltip, the hash's `oe` and `op`, and the key's title,
 * and a crop of the Map card shows the compare picker over the picture row.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-compare-oe.mjs [out-dir]
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import h5wasm from 'h5wasm/node'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'

// --- the second map, as ui-ratio-missing.mjs writes it ------------------------
mkdirSync('gallery', { recursive: true })
const COPY = 'gallery/Yeast_perturbed.cool'
if (!existsSync(COPY)) {
  copyFileSync('demo/yeast/Yeast_microC_G2M_1kb.cool', COPY)
  await h5wasm.ready
  const file = new h5wasm.File(COPY, 'a')
  const dataset = file.get('pixels/count')
  const counts = Int32Array.from(dataset.value)
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let i = 0; i < counts.length; i++) {
    counts[i] = random() < 1 / 3 ? 0 : Math.max(1, Math.round(counts[i] * (0.5 + 1.5 * random())))
  }
  dataset.write_slice([[0, counts.length]], counts)
  file.flush()
  file.close()
  console.log(`wrote ${COPY}`)
}

const WINDOW = 'IV:1150001-1250000'
const { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })

const settled = async () => {
  await sleep(1500)
  await page.waitForFunction(
    () => [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
    null,
    { timeout: 120000 },
  )
  await sleep(1200)
}
const compareSelect = () =>
  page
    .locator('.field')
    .filter({ has: page.locator('.field-label', { hasText: /^compare$/ }) })
    .locator('select')
    .first()
const pick = async (op) => {
  await compareSelect().selectOption(op)
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 60000 })
  await settled()
}
/** The O/E button, the hash and the key, as one line. */
const said = async (step) => {
  const state = await page.evaluate(() => {
    const oe = [...document.querySelectorAll('button')].find((b) => b.querySelector('.btn-word-text')?.textContent === 'O/E')
    const hash = new URLSearchParams(location.hash.slice(1))
    return {
      oe:
        oe === undefined
          ? null
          : { disabled: oe.disabled, pressed: oe.getAttribute('aria-pressed'), title: oe.title.slice(0, 90) },
      hash: { oe: hash.get('oe'), op: hash.get('op') },
      key: document.querySelector('.map-key-title')?.textContent?.trim() ?? null,
    }
  })
  console.log(`--- ${step}: ${JSON.stringify(state)}`)
  return state
}
/** The Map card from the compare picker down to the picture row, close up. */
const card = async (name) => {
  const box = await page.evaluate(() => {
    const fields = [...document.querySelectorAll('.field')].filter((node) =>
      ['compare', 'picture'].includes(node.querySelector('.field-label')?.textContent ?? ''),
    )
    if (fields.length === 0) return null
    const rects = fields.map((node) => node.getBoundingClientRect())
    const left = Math.min(...rects.map((r) => r.left))
    const top = Math.min(...rects.map((r) => r.top))
    const right = Math.max(...rects.map((r) => r.right))
    const bottom = Math.max(...rects.map((r) => r.bottom))
    return { x: Math.max(0, left - 12), y: Math.max(0, top - 12), width: right - left + 24, height: bottom - top + 24 }
  })
  if (box === null) return
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: box })
  console.log('wrote', `${name}.png`)
}

try {
  await page.goto(`${base}/#uri=${base}/demo/yeast/Yeast_microC_G2M_1kb.cool&uri2=${base}/${COPY}&view=region&region=${WINDOW}&oe=1`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await settled()
  await said('split, O/E on')
  await shot('co01-split-oe')
  await card('co01b-split-card')

  await pick('ratio')
  await said('ratio')
  await shot('co02-ratio')
  await card('co02b-ratio-card')
  // `e` is the O/E's key: under the ratio it stands down with the button.
  await page.locator('.heatmap-canvas').first().hover()
  await page.keyboard.press('e')
  await sleep(1500)
  await said('ratio, after e')

  await pick('difference')
  await said('difference')
  await shot('co03-difference')
  await card('co03b-difference-card')

  await pick('split')
  await said('split again')
  await shot('co04-split-again')
} finally {
  await close()
}
