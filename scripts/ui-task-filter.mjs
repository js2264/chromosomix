/**
 * The box over the Analysis column's task list (§18.1), on the yeast demo:
 * the column as it opens, the box given `TAD`, `pileup`, `a/b` and a word
 * nothing matches, then Escape, and Enter opening the first task left. Each
 * step prints the rows and cards left, so a filter that kept the wrong rows is
 * a line here as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-task-filter.mjs [out-dir]
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })

const left = () =>
  page.evaluate(() => ({
    rows: [...document.querySelectorAll('.analysis-row')]
      .filter((row) => !row.classList.contains('is-filtered-out'))
      .map((row) => row.querySelector('.analysis-row-title')?.textContent),
    cards: [...document.querySelectorAll('.analysis-card')].filter((card) => !card.classList.contains('is-filtered-out')).length,
    note: document.querySelector('.analysis-no-match:not(.hidden)')?.textContent ?? null,
  }))
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
  await page.waitForSelector('input.analysis-filter', { timeout: 20000 })
  console.log('as it opens:', JSON.stringify(await left()))
  await shot('tf01-column')

  const box = page.locator('input.analysis-filter')
  for (const [word, name] of [['TAD', 'tf02-tad'], ['pileup', 'tf03-pileup'], ['a/b', 'tf04-ab'], ['hairpin loops in a dream', 'tf05-nothing']]) {
    await box.fill(word)
    await sleep(400)
    console.log(`${word}:`, JSON.stringify(await left()))
    await shot(name)
  }
  await box.press('Escape')
  await sleep(300)
  console.log('after Escape:', JSON.stringify(await left()), 'box:', JSON.stringify(await box.inputValue()))

  await box.fill('decay')
  await box.press('Enter')
  await sleep(1500)
  console.log('Enter on "decay" opened:', await page.evaluate(() => document.querySelector('.analysis-drawer h2, .drawer-title, .analysis-drawer-title')?.textContent ?? null))
  await shot('tf06-enter-opens')
} finally {
  await close()
}
