/**
 * Fig. 2's chromosomix panels, made in the app as a reader makes them: the store's tab, the Analysis
 * column, Run, and each figure's own PDF button — nothing computed outside the browser.
 *
 * The tab is *The Chromosomix paper*'s Fig. 2: 4DN's GM12878 map on chr19 at 10 kb with two labs' CTCF
 * and ATAC-seq, read in place from 4DN's and ENCODE's buckets, every task opening on the figure's
 * recipe (`FIG2_RECIPES` in scripts/make_rsg_store.py). In order:
 *
 *   1. Diamond insulation — four scales, 50 to 400 kb, chr19;
 *   2. Peak calling — CTCF Broad with CTCF Stanford as its replicate, IDR ≤ 0.05, chr19;
 *   3. the map switched to 2 kb, Aggregate peak analysis — each peak with the next, ±10 bins, over the
 *      expected, from 22 bins (coolpuppy's floor for that window);
 *   4. Metaplot over a feature set — both CTCF tracks and ATAC-seq about the peaks, ±2 kb in 50 bp,
 *      then the four insulation tracks, ±500 kb in 10 kb — each with its bootstrap band and heatmaps.
 *
 * Each figure is saved with its PDF button (and its numbers with TSV) into the folder given, and the
 * drawer is photographed after every run, into gallery/figure2/. A reader does the same by hand.
 *
 *   python3 scripts/make_rsg_store.py stage --out gallery/stage --local http://127.0.0.1:5173
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node manuscript/figure2/chromosomix_panels.mjs [manuscript/figure2/chromosomix]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
function playwright() {
  try {
    return require('playwright')
  } catch {
    return require(join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
}
const { chromium } = playwright()

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2] ?? join(HERE, 'chromosomix')
// The drawer after every run, for the reader to look at: the repository's (ignored) gallery folder.
const SHOTS = process.env.SHOTS ?? join(HERE, '..', '..', 'gallery', 'figure2')
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const WORKSPACE = process.env.PAPER_WORKSPACE ?? `${BASE}/gallery/stage/chromosomix_paper/Chromosomix_paper.chromosomix.json`
mkdirSync(SHOTS, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
// 4DN's and ENCODE's buckets through the session's proxy where there is one; only https, since the dev
// server is plain http on the loopback.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    ...(proxy ? [`--proxy-server=https=${proxy.replace(/^https?:\/\//, '')}`] : []),
  ],
})
const context = await browser.newContext({
  viewport: { width: 1800, height: 1100 },
  acceptDownloads: true,
})
// No save dialog: a headless browser cancels one the moment it opens, and every export asks it first
// (`ui/export.ts`). Without it an export is the plain download a browser with no dialog makes.
await context.addInitScript(() => { window.showSaveFilePicker = undefined })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`shot ${name}`)
}

const openTask = async (title) => {
  // The drawer covers the column's rows while it is open.
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) {
    await close.click()
    await sleep(800)
  }
  const row = page.locator('.analysis-row-title', { hasText: title }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1500)
}
/** The form's field by its label, case-blind. */
const field = (label) =>
  page
    .locator('.analysis-form .field')
    .filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) })
    .first()
/** Choose the option of a field's select whose text contains `wanted`. */
const choose = async (label, wanted) => {
  const select = field(label).locator('select').first()
  const options = await select.locator('option').evaluateAll((all) => all.map((o) => ({ value: o.value, text: o.textContent ?? '' })))
  const match = options.find((o) => wanted.test(o.text))
  if (match === undefined) throw new Error(`${label}: no option ${wanted} among ${options.map((o) => o.text).join(' | ')}`)
  await select.selectOption(match.value)
  await sleep(700)
  return match.text
}
/** Tick exactly the boxes of a list field whose label matches `wanted`. */
const tickOnly = async (label, wanted) => {
  const boxes = field(label).locator('label')
  const ticked = []
  for (let i = 0; i < (await boxes.count()); i++) {
    const row = boxes.nth(i)
    const text = ((await row.textContent()) ?? '').trim()
    const box = row.locator('input[type="checkbox"]')
    if ((await box.count()) === 0) continue
    const want = wanted.test(text)
    if ((await box.isChecked()) !== want) await box.setChecked(want)
    if (want) ticked.push(text)
  }
  await sleep(700)
  return ticked
}
const type = async (label, value) => {
  const box = field(label).locator('input').first()
  await box.fill(String(value))
  await box.press('Enter')
  await sleep(500)
}
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
/** Run, and wait for *this* run's line: the drawer keeps the last result on screen. */
const run = async (what, minutes = 30) => {
  const before = await computed()
  const started = Date.now()
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(
    (before) => {
      const now = document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? ''
      return now !== '' && now !== before
    },
    before,
    { timeout: minutes * 60000 },
  )
  await sleep(2500)
  console.log(`${what}: ${await computed()} (${((Date.now() - started) / 1000).toFixed(0)} s on the clock)`)
}
/** The figure in the drawer whose head says `title`. */
const figure = (title) =>
  page.locator('.analysis-drawer .figure-block').filter({ has: page.locator('.analysis-figure-head', { hasText: title }) }).first()
/** Press a figure's export button and keep the file under `name`. */
const save = async (block, button, name) => {
  await block.scrollIntoViewIfNeeded()
  const download = page.waitForEvent('download', { timeout: 60000 })
  await block.locator('.analysis-figure-head button', { hasText: new RegExp(`^${button}$`) }).first().click()
  await (await download).saveAs(join(OUT, name))
  console.log(`saved ${name}`)
}
/**
 * Drag the drawer's left edge until it is `px` wide, as a reader widens or narrows it.
 *
 * A figure is exported at the size it is drawn (`figureBox`), so the drawer's width is the figure's: a
 * curve is exported from a drawer 760 wide, the pile-up from one 560 wide and a heatmap from the
 * narrowest the drawer goes, 380, so that set beside the reference tools' figures — a heatmap a third of
 * half a page — each reads at a few points, with the tab's own type sizes (its `figures`).
 */
const drawerWidth = async (px) => {
  const handle = page.locator('.analysis-drawer .panel-column-handle').first()
  const box = await handle.boundingBox()
  const now = await page.evaluate(() => document.querySelector('.analysis-drawer')?.getBoundingClientRect().width ?? 0)
  const y = box.y + Math.min(box.height / 2, 300)
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + (now - px), y, { steps: 12 })
  await page.mouse.up()
  await sleep(2500)
}
const heads = () => page.$$eval('.analysis-drawer .analysis-figure-head', (all) => all.map((h) => h.innerText.split('\n')[0]))

try {
  await page.goto(`${BASE}/?config=${encodeURIComponent(WORKSPACE)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.heatmap-canvas').length >= 1, null, { timeout: 240000 })
  for (const label of await page.$$('.tabstrip .tab-label')) {
    if ((await label.textContent()).startsWith('Fig. 2 ')) {
      await label.click()
      break
    }
  }
  await page.waitForFunction(() => document.querySelectorAll('.heatmap-canvas').length >= 1, null, { timeout: 240000 })
  await sleep(30000)
  await shot('c0-fig2-tab')
  for (const b of await page.$$('button[title^="Show the Analysis panel"]')) {
    if (await b.isVisible()) {
      await b.click()
      break
    }
  }
  await sleep(1500)

  // 1. Insulation at four scales, on chr19 at 10 kb.
  await openTask('Diamond insulation')
  await run('insulation')
  await shot('c1-insulation')

  // 2. CTCF's peaks, the two labs as replicates.
  await openTask('Peak calling')
  await run('peaks')
  await shot('c2-peaks')

  // 3. The APA at 2 kb: each peak with the next.
  await page.selectOption('select.res-pick', { label: '2 kb' })
  await page.waitForFunction(() => document.querySelectorAll('.heatmap-canvas').length >= 1, null, { timeout: 240000 })
  await sleep(20000)
  await openTask('Aggregate peak analysis')
  console.log('anchors:', await choose('anchors', /each feature with the next/))
  console.log('features:', await choose('features', /peak/i))
  await shot('c3-apa-form')
  await run('APA', 60)
  await shot('c3-apa')
  await drawerWidth(560)
  await save(figure(/^APA/), 'PDF', 'apa.pdf')
  await save(figure(/^APA/), 'TSV', 'apa.tsv')

  // 4. The metaplots: the two CTCF tracks and ATAC-seq, then the insulation.
  await openTask('Metaplot over a feature set')
  console.log('features:', await choose('features', /peak/i))
  console.log('tracks:', await tickOnly('tracks', /CTCF|ATAC/))
  await run('metaplot of the signal')
  await shot('c4-metaplot-signal')
  console.log('figures:', await heads())
  await drawerWidth(760)
  await save(figure(/^Metaplot/), 'PDF', 'metaplot-signal.pdf')
  await save(figure(/^Metaplot/), 'TSV', 'metaplot-signal.tsv')
  await drawerWidth(380)
  for (let i = 0; i < 3; i++) {
    const block = page.locator('.analysis-drawer .figure-block').filter({ has: page.locator('.analysis-figure-head', { hasText: /per feature/ }) }).nth(i)
    await save(block, 'PDF', `metaplot-signal-heatmap-${i + 1}.pdf`)
  }

  console.log('tracks:', await tickOnly('tracks', /insulation/i))
  await type('flank', 500000)
  await type('resolution', 10000)
  await run('metaplot of the insulation')
  await shot('c5-metaplot-insulation')
  console.log('figures:', await heads())
  await drawerWidth(760)
  await save(figure(/^Metaplot/), 'PDF', 'metaplot-insulation.pdf')
  await save(figure(/^Metaplot/), 'TSV', 'metaplot-insulation.tsv')
  await drawerWidth(380)
  for (let i = 0; i < 4; i++) {
    const block = page.locator('.analysis-drawer .figure-block').filter({ has: page.locator('.analysis-figure-head', { hasText: /per feature/ }) }).nth(i)
    await save(block, 'PDF', `metaplot-insulation-heatmap-${i + 1}.pdf`)
  }
} catch (e) {
  console.log('FAILED', String(e).slice(0, 1200))
  await shot('c9-failure').catch(() => {})
  process.exitCode = 1
} finally {
  if (errors.length > 0) console.log('page errors:', errors.join('\n'))
  await browser.close()
}
