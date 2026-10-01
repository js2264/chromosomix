/**
 * Two sequences against each other (§28), in headless Chromium: the task in
 * the Analysis panel's 1D card, run on a long-read assembly of a yeast whose
 * chromosome XVI carries the *Mycoplasma mycoides* genome against the
 * theoretical genome the strain was built to be — the signed density, the
 * streaks as a table, and the note on what was sampled.
 *
 * Reads `data/` (see `data/README.md`) through a session config under `out/`
 * that holds both FASTAs:
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-dotplot.mjs [out-dir]     # d01 … d06 with d04b and d04c, and the PNG export under files/
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const CONFIG = process.env.DOTPLOT_CONFIG ?? '/out/reasm/Dotplot.metacooler.json'
const g = await gallery(OUT)
const { page, shot } = g

await g.openWithDev(`?config=${g.base}${CONFIG}`)
await sleep(15000)

// The task, from the Analysis panel's 1D card.
const row = page.locator('.analysis-row-title', { hasText: 'Two sequences against each other' }).first()
if (!(await row.isVisible().catch(() => false))) {
  await page.locator('button', { hasText: /analysis/i }).last().click().catch(() => undefined)
  await sleep(800)
}
await row.scrollIntoViewIfNeeded()
await shot('d01-task')
await row.click()
await sleep(1200)
// Along x the assembly, along y the theoretical genome.
const selects = page.locator('.analysis-drawer select').filter({ has: page.locator('option', { hasText: 'theoretical' }) })
console.log('sequence pickers:', await selects.count())
if ((await selects.count()) >= 2) {
  await selects.nth(0).selectOption({ label: 'sequence' })
  await selects.nth(1).selectOption({ label: 'theoretical' })
}
await sleep(400)
await shot('d02-form')
/** Run the task and wait for its result. */
async function run() {
  const before = await page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page
    .waitForFunction(
      (before) => {
        const now = document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? ''
        return now !== '' && now !== before
      },
      before,
      { timeout: 300_000 },
    )
    .catch(() => console.log('the run did not finish'))
  await sleep(1500)
  console.log('notes:', await page.evaluate(() => [...document.querySelectorAll('.analysis-drawer-body li')].map((li) => li.innerText).join('\n')))
}

/** Scroll the drawer to the first leaf whose text matches. */
async function scrollTo(pattern) {
  await page.evaluate((source) => {
    const re = new RegExp(source)
    const body = document.querySelector('.analysis-drawer-body')
    const hit = [...(body?.querySelectorAll('*') ?? [])].find((el) => el.childElementCount === 0 && re.test(el.textContent ?? ''))
    hit?.scrollIntoView({ block: 'start' })
  }, pattern.source)
  await sleep(600)
}

await run()
await shot('d03-figure')
// The whole picture: the figure's head at the top of the drawer.
await scrollTo(/^Streaks one to one/)
await shot('d04-picture')
// The view of its own (§28.2): a streak under the pointer, named on both axes;
// then zoomed onto the fused chromosome's corner, and a streak named there.
const plot = page.locator('.dotplot-canvas').first()
async function hoverStreak(from, to) {
  const box = await plot.boundingBox()
  if (box === null) return ''
  const across = box.width - 98
  const side = Math.min(across, box.height - 56)
  const rect = { x: box.x + 86 + (across - side) / 2, y: box.y + 10, width: side, height: side }
  for (let t = from; t <= to; t += 0.004) {
    await page.mouse.move(rect.x + t * rect.width, rect.y + t * rect.height)
    const said = await page.evaluate(() => document.querySelector('.dotplot-readout')?.textContent ?? '')
    if (/anchors/.test(said)) return said
  }
  return page.evaluate(() => document.querySelector('.dotplot-readout')?.textContent ?? '')
}
if ((await plot.count()) > 0) {
  console.log('idle:', await page.evaluate(() => document.querySelector('.dotplot-readout')?.textContent))
  console.log('hovered:', await hoverStreak(0.1, 0.5))
  await shot('d04b-hover')
  // A streak of the fused chromosome, in the plot's far corner: the pointer
  // put on the middle of its line, as the figure says it drew it, and zoomed
  // there — the streak stays under the pointer, named, as it grows.
  console.log('in the corner:', await hoverStreak(0.8, 0.99))
  // The next frame draws the lit streak, and says where.
  await sleep(250)
  const middle = await page.evaluate(() => {
    const canvas = document.querySelector('.dotplot-canvas')
    const lit = canvas?.dataset.lit?.split(' ').map(Number)
    if (canvas === null || lit === undefined) return null
    const r = canvas.getBoundingClientRect()
    return { x: r.left + (lit[0] + lit[2]) / 2, y: r.top + (lit[1] + lit[3]) / 2 }
  })
  if (middle !== null) await page.mouse.move(middle.x, middle.y)
  for (let k = 0; k < 5; k++) {
    await page.mouse.wheel(0, -300)
    await sleep(200)
  }
  await sleep(600)
  if (middle !== null) {
    await page.mouse.move(middle.x + 1, middle.y)
    await page.mouse.move(middle.x, middle.y)
  }
  await sleep(200)
  // A pixel's worth of aim before the zoom is twenty after it: the streak is
  // found again near the pointer.
  if (middle !== null) {
    let said = ''
    for (let r = 0; r <= 40 && !/anchors/.test(said); r += 4) {
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
        await page.mouse.move(middle.x + dx, middle.y + dy)
        said = await page.evaluate(() => document.querySelector('.dotplot-readout')?.textContent ?? '')
        if (/anchors/.test(said)) break
      }
    }
  }
  await sleep(250)
  console.log('zoomed:', await page.evaluate(() => document.querySelector('.dotplot-readout')?.textContent))
  await shot('d04c-zoomed')
  await page.locator('.dotplot-whole').first().click().catch(() => undefined)
  await sleep(300)
}
await scrollTo(/^Streaks$/)
await shot('d05-streaks')

// The figure as a PNG, from its own button.
const files = join(OUT, 'files')
mkdirSync(files, { recursive: true })
await scrollTo(/^Streaks one to one/)
// A download rather than the save picker, which headless Chromium would leave open.
await page.evaluate(() => (window.showSaveFilePicker = undefined))
const png = page.locator('.analysis-figure-head button', { hasText: /^PNG$/ }).first()
if (await png.isVisible().catch(() => false)) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), png.click()])
  const path = join(files, download.suggestedFilename())
  await download.saveAs(path)
  console.log('PNG →', path)
}

// Every streak, a repeat's other copies too: the grid one to one leaves out.
await page.evaluate(() => document.querySelector('.analysis-drawer-body')?.scrollTo({ top: 0 }))
const streaks = page.locator('.analysis-drawer select').filter({ has: page.locator('option', { hasText: 'every one' }) })
if ((await streaks.count()) > 0) {
  await streaks.first().selectOption({ label: 'every one' })
  await sleep(300)
  await run()
  await scrollTo(/^Streaks, the same way round/)
  await shot('d06-every-one')
}
await g.close()
