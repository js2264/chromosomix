/**
 * The metaplot over two tracks and one feature set: a heatmap for each (§18.8).
 *
 * On the yeast demo, ATAC and Pol II over the ATAC peaks: the profile with its
 * two curves, then a per-feature heatmap under it for each track — the same
 * peak on the same row of both, strongest over the two first — each block
 * close up, and the second one enlarged. Then the same set ranked by score in
 * two groups, which draws a heatmap for each of the four curves. Prints the
 * heading of every figure the drawer holds.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-metaplot-tracks.mjs [out-dir]
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })

const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
const field = (label) =>
  page
    .locator('.analysis-form .field')
    .filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) })
    .first()
const pick = async (label, wanted) => {
  const control = field(label)
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
const heads = () =>
  page.evaluate(() => [...document.querySelectorAll('.analysis-figure-head')].map((head) => (head.querySelector('.analysis-figure-title, h4, strong, span')?.textContent ?? head.textContent ?? '').replace(/\s+/g, ' ').trim()))
const run = async (count) => {
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.analysis-figure-head')].filter((head) => /per feature/.test(head.textContent ?? '')).length >= n,
    count,
    { timeout: 300000 },
  )
  await sleep(3000)
}
const heatmapBlocks = () =>
  page.locator('.figure-block').filter({ has: page.locator('.analysis-figure-head', { hasText: /per feature/ }) })

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(2500)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await page.locator('text=Metaplot over a feature set').first().click()
  await sleep(1200)
  console.log('features:', await pick('Features', 'ATAC peaks'), 'tracks:', await pick('Tracks', 'ATAC'), await pick('Tracks', 'Pol II'))
  const off = field('per-feature heatmap').locator('button[aria-pressed="false"]')
  if (await off.count()) await off.click()
  await sleep(500)
  await run(2)
  console.log('figures, two tracks:', JSON.stringify(await heads()))

  // The profile, and the first heatmap under it.
  const profile = page.locator('.figure-block').filter({ has: page.locator('.figure-chart svg') }).first()
  await profile.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(1000)
  await shot('mt01-profile-and-first')

  // Each heatmap close up: the same peaks, row for row.
  const blocks = heatmapBlocks()
  console.log('heatmaps:', await blocks.count())
  for (let i = 0; i < (await blocks.count()); i++) {
    await blocks.nth(i).scrollIntoViewIfNeeded()
    await sleep(800)
    await blocks.nth(i).screenshot({ path: `${OUT}/mt02-heatmap-${i + 1}.png` })
    console.log(`shot mt02-heatmap-${i + 1}`)
  }
  await blocks.nth(1).evaluate((node) => node.scrollIntoView({ block: 'end' }))
  await sleep(800)
  await shot('mt03-both-heatmaps')

  await blocks.nth(1).locator('.figure-enlarge').first().click()
  await page.waitForSelector('.modal-stage', { timeout: 20000 })
  await sleep(2000)
  await shot('mt04-second-enlarged')
  await page.keyboard.press('Escape')
  await sleep(800)

  // Ranked by score into two groups: four curves, four heatmaps.
  await page.locator('.analysis-form').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  console.log('rank by:', await pick('rank by', 'score'))
  console.log('then:', await pick('then', 'K groups'))
  const groups = field('groups').locator('input').first()
  if (await groups.count()) {
    await groups.fill('2')
    await groups.press('Enter')
  }
  await sleep(600)
  await run(4)
  console.log('figures, two tracks in two groups:', JSON.stringify(await heads()))
  await heatmapBlocks().first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await sleep(1000)
  await shot('mt05-groups')
} finally {
  await close()
}
