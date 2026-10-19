/**
 * The drawer's run row on a deck (§18.1, §18.4), in headless Chromium, on the
 * yeast deck — the cooler beside the `.hic`, with the genes and the ATAC
 * bigWig. A task that reads a map is offered `run on ★` and `run on all 2
 * maps`; a 1D task, which reads only the tracks, one plain `run` and no batch,
 * whichever map is starred. Peak calling is then run with the star on the
 * `.hic`: its peaks are one row on the Tracks card, named by no map, beside the
 * first map. P(s) is run on the star beside it, and after a pan P(s)'s heading
 * turns stale and offers *recompute here* while the peak call's names the
 * tracks and offers nothing. Last, the star taken off every map: P(s)'s open
 * drawer refuses, the column greys every task that reads a map under one
 * warning and leaves the 1D card as its tracks have it, and Peak calling's Run
 * is live. Prints the run row, the heading, the tabs, the column and the Tracks
 * card's computed rows at each step, so a batch button that came back is a line
 * in the log as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-run-row.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
function playwright() {
  try {
    return require('playwright')
  } catch {
    const root = execSync('npm root -g').toString().trim()
    return require(join(root, 'playwright'))
  }
}
const { chromium } = playwright()

const OUT = process.argv[2] ?? 'gallery'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}

/** The drawer as a reader reads it: the run row, the heading, the tabs. */
const drawer = () =>
  page.evaluate(() => {
    const shown = (node) => node !== null && node !== undefined && !node.classList.contains('hidden')
    const head = document.querySelector('.analysis-framing')
    const recompute = [...document.querySelectorAll('.analysis-drawer-head button')].find(
      (button) => button.textContent.trim() === 'recompute here',
    )
    const run = document.querySelector('.analysis-run button')
    return {
      task: document.querySelector('.analysis-drawer-title')?.textContent ?? '',
      row: [...document.querySelectorAll('.analysis-run button')]
        .filter((button) => shown(button))
        .map(
          (button) =>
            `${button.textContent.trim()}${button.querySelector('svg.run-star') === null ? '' : ' ★'}` +
            `${button.disabled ? ' (greyed)' : ''}`,
        ),
      tooltip: run?.title ?? '',
      refusal: document.querySelector('.analysis-refusal')?.textContent ?? '',
      heading: `${head?.textContent ?? ''}${head?.classList.contains('is-stale') ? ' [stale]' : ''}`,
      recompute: shown(recompute),
      tabs: [...document.querySelectorAll('.analysis-maps:not(.hidden) .analysis-map')].map((tab) =>
        tab.textContent.trim(),
      ),
    }
  })
const say = async (what) => console.log(`${what}:`, JSON.stringify(await drawer()))

/** Each card of the column, and how many of its rows are greyed. */
const column = () =>
  page.evaluate(() => {
    const cards = {}
    for (const card of document.querySelectorAll('.analysis-card')) {
      const name = card.querySelector('.card-head')?.textContent?.trim() ?? '?'
      const rows = [...card.querySelectorAll('.analysis-row')]
      cards[name] = `${rows.filter((row) => row.classList.contains('is-waiting')).length} of ${rows.length} greyed`
    }
    return { warning: document.querySelector('.analysis-blocked:not(.hidden)')?.textContent ?? '', cards }
  })
const computedRows = () =>
  page.$$eval('.annotation-card .ann-row.is-synthetic', (rows) =>
    rows.map((row) => `${row.querySelector('.ann-name')?.value ?? '?'} [${row.getAttribute('data-id')}]`),
  )
const stars = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.deck-grid > .deck-panel')]
      .map((cell) => {
        const star = cell.querySelector('.deck-star')
        return star === null ? '-' : star.getAttribute('aria-pressed') === 'true' ? '★' : '☆'
      })
      .join(' '),
  )

/** Put an open drawer down first: it overlays the column the rows are in. */
const openTask = async (title) => {
  if ((await page.locator('.analysis-drawer:not(.collapsed)').count()) > 0) {
    await page.keyboard.press('Escape')
    await sleep(800)
  }
  const row = page.locator('.analysis-row-title', { hasText: title }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1500)
}
const closeDrawer = async () => {
  await page.keyboard.press('Escape')
  await sleep(800)
}
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
/** Press the run row's button whose text is `label`, and wait for its result. */
const press = async (label) => {
  const before = await computed()
  await page.locator('.analysis-run button', { hasText: label }).first().click()
  await page
    .waitForFunction(
      (before) => {
        const now = document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? ''
        return now !== '' && now !== before
      },
      before,
      { timeout: 300000 },
    )
    .catch(() => console.log('no result within five minutes'))
  await sleep(2500)
}
/**
 * Press a map's star. Dispatched to the star itself, as a key press on it
 * would be: an open drawer lies over the second map's heading.
 */
const pressStar = async (lead) => {
  await page
    .locator(`.deck-grid > .deck-panel${lead ? '.is-lead' : ':not(.is-lead)'} .deck-star`)
    .first()
    .dispatchEvent('click')
  await sleep(2500)
  console.log('stars:', await stars())
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_deck.chromosomix.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelectorAll('.heatmap-canvas').length >= 2,
    null,
    { timeout: 180000 },
  )
  await sleep(3000)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(1000)
  console.log('stars:', await stars())
  console.log('column:', JSON.stringify(await column()))

  // ---- a task that reads a map: the star's, or every map's -----------------
  await openTask('Contact probability P(s)')
  await say('P(s), the first map starred')
  await shot('rr01-map-task-run-row')

  // ---- a 1D task: one run, and nothing about the star ------------------------
  await openTask('Peak calling')
  await say('Peak calling, the first map starred')
  await shot('rr02-1d-task-run-row')

  // ---- the star moved to the .hic: the 1D task's row does not change ---------
  await pressStar(false)
  await say('Peak calling, the .hic starred')
  await shot('rr03-1d-task-star-on-hic')

  // Run there: one job, one row on the Tracks card, named by no map.
  await press(/^run$/)
  await say('Peak calling, run with the .hic starred')
  await closeDrawer()
  await fold('Show the Annotations panel')
  await sleep(1500)
  console.log('computed rows:', JSON.stringify(await computedRows()))
  await shot('rr04-peaks-beside-the-first-map')
  await fold('Fold the Annotations panel')

  // ---- P(s) on the star, then a pan with the drawer put down ------------------
  await openTask('Contact probability P(s)')
  await press(/^run on\s*$/)
  await say('P(s), run on the .hic')
  await closeDrawer()
  // Half a window downstream, from the heading's own button; the deck follows.
  await page.locator('button[title^="Move half a window downstream"]').first().click()
  await sleep(3000)
  console.log('the view:', await page.locator('input.input-region').first().inputValue())
  await openTask('Contact probability P(s)')
  await say('P(s), after a pan')
  await shot('rr05-map-task-stale-after-pan')
  await openTask('Peak calling')
  await say('Peak calling, after the pan')
  await shot('rr06-1d-task-not-stale')

  // ---- no map starred ------------------------------------------------------------
  await openTask('Contact probability P(s)')
  await pressStar(false)
  await say('P(s), no map starred')
  await shot('rr07-no-star-map-task-refused')
  await closeDrawer()
  console.log('column, no map starred:', JSON.stringify(await column()))
  // The warning over the greyed map tasks, then further down the 1D card.
  await page.locator('.analysis-blocked').first().scrollIntoViewIfNeeded()
  await sleep(600)
  await shot('rr08-no-star-column-warning')
  await page.locator('.analysis-card', { hasText: '1D tasks' }).first().scrollIntoViewIfNeeded()
  await sleep(600)
  await shot('rr08b-no-star-column-1d-card')
  await openTask('Peak calling')
  await say('Peak calling, no map starred')
  await shot('rr09-no-star-1d-task-runs')
} catch (err) {
  console.log('FAILED', err)
  await shot('rr99-failure').catch(() => {})
} finally {
  console.log('page errors:', errors.length === 0 ? 'none' : errors.join('\n'))
  await browser.close()
}
