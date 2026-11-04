/**
 * Pictures for browse/console.md and cli/from-the-app.md: the console along
 * the bottom of the window, under the yeast Micro-C demo opened by its address
 * on the lab's bucket, IV:1.0–1.4 Mb.
 *
 * Diamond insulation is run twice from the Analysis panel — at its default
 * window of 10 bins, then at 20 — and the console opened: the file opened and
 * the two runs as the `chromosomix` commands that repeat them, its provenance
 * switch off as it starts (cl-insulation). Then the map's figure is saved from
 * the Export card, through a stand-in for the system's save dialog that keeps
 * the suggested name, as a reader pressing Save would, and the console shows
 * the file written under the runs (cl-wrote).
 *
 *   node documentation/scripts/screens/browse-console.cjs [out-dir]   # cl-insulation, cl-wrote
 */

const { BUCKET, sleep, start } = require('./browse-lib.cjs')

const MAP = `${BUCKET}/yeast/Yeast_microC_G2M_1kb.cool`

;(async () => {
  const app = await start(process.argv[2], {
    // The save dialog, as a reader answers it: Save, under the name offered.
    // And the console as tall as a reader once dragged it, which this browser
    // remembers, so that every line of the session is in view at once.
    init: () => {
      window.showSaveFilePicker = async (options) => ({
        name: options.suggestedName,
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      })
      try {
        window.localStorage.setItem('chromosomix:console:height', '400')
      } catch {
        /* about:blank has no storage */
      }
    },
  })
  const { page } = app
  const lines = () =>
    page.evaluate(() => [...document.querySelectorAll('.console-list .console-line, .console-list [class*="console-row"]')].length)
  const synthetic = () => page.evaluate(() => document.querySelectorAll('.ann-row.is-synthetic').length)
  /** Press Run in the drawer and wait for the run's rows to land on the Tracks card. */
  async function run() {
    const before = await synthetic()
    await page.locator('.analysis-drawer button', { hasText: /^run(\s+on)?\s*$/i }).first().click()
    await page.waitForFunction((before) => document.querySelectorAll('.ann-row.is-synthetic').length > before, before, { timeout: 240000 })
    await app.until(() => true)
  }
  try {
    await app.open(`#uri=${MAP}&view=region&region=IV:1000000-1400000&balance=true&transform=log10`)
    await app.press('Fold the General panel')
    await app.press('Show the Analysis panel')
    await page.locator('.analysis-row-title', { hasText: /^Diamond insulation$/ }).first().click()
    await sleep(1200)
    await run()
    // The same task again, at twice the window.
    const window = page.locator('.analysis-form .field').filter({ has: page.locator('.field-label', { hasText: /^window/ }) }).first()
    await window.locator('input').first().fill('20')
    await window.locator('input').first().press('Tab')
    await sleep(500)
    await run()
    await page.keyboard.press('Escape')
    await sleep(800)
    await app.press('Fold the Analysis panel')

    await page.keyboard.press('Control+Backquote')
    await sleep(1500)
    await page.mouse.move(8, 140)
    await sleep(500)
    console.log('console:', await page.evaluate(() => document.querySelector('.console-list')?.innerText))
    await app.shot('cl-insulation')

    // The map's figure saved from the Export card, the first card of Aesthetics.
    await page.keyboard.press('Escape')
    await sleep(600)
    await page
      .locator('.controls-card')
      .filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) })
      .first()
      .locator('.export-acts button')
      .first()
      .click()
    await page.waitForFunction(() => /wrote/.test(document.querySelector('.console-list')?.textContent ?? ''), null, { timeout: 60000 }).catch(() => {})
    await sleep(1500)
    if (!(await page.evaluate(() => document.querySelector('.console-drawer')?.classList.contains('collapsed') === false))) {
      await page.keyboard.press('Control+Backquote')
      await sleep(1500)
    }
    await page.mouse.move(8, 140)
    await sleep(500)
    console.log('console:', await page.evaluate(() => document.querySelector('.console-list')?.innerText))
    await app.shot('cl-wrote')
  } finally {
    await app.close()
  }
})()
