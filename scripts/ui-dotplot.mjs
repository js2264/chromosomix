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
 *   node scripts/ui-dotplot.mjs [out-dir]     # d01 … d07, and the PNG export under files/
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
