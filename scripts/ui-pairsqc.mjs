/**
 * Drive *Pairs QC* end to end in headless Chromium (§18.8), and write one
 * screenshot a step.
 *
 * On a yeast library binned on the fly from its `.pairs`, then on the `.mcool`
 * made from the same records — the two kinds of map the task meets:
 *
 * - **binned** — the catalogue with Pairs QC beside P(s) and Restriction sites
 *   beside Find a motif; the form asking for no file, priced as free; the run
 *   drawn from the import's own counts (P(s) by orientation, the pair types,
 *   cis and trans, the pairtools table); P(s)'s form with no four orientations
 *   left on it; then the reference dropped, DpnII chosen and the price turning
 *   to a pass, and the run's restriction figures — the classes stacked by
 *   orientation and their table, the distance to the next cut, the read ends
 *   per fragment, and coverage against the sites; a custom site typed without
 *   its `^`, refused beside a greyed Run.
 * - **matrix** — the `.mcool`: the form asking for the `.pairs`, refused until
 *   it has one; the file dropped; the run's figures from it — the same as the
 *   import's — and then DpnII against the dropped file's records, on the
 *   `.mcool`'s own grid.
 *
 * Every step prints the price line and, after a run, the drawer's notes and the
 * figures' headings, so a figure that did not come is a line here too.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-pairsqc.mjs [out-dir]
 *
 * The files are read from `GALLERY_DATA` (default `/out/pairsqc/` on the dev
 * server, which serves the repository): `GALLERY_PAIRS`, `GALLERY_MCOOL` and
 * `GALLERY_FASTA` name them, by default `CH128.sample.pairs.gz`,
 * `CH128.sample.mcool` and `R64.fa` — a one-in-twenty sample of the CH128
 * Micro-C library, the `.mcool` `cooler cload pairs` and `zoomify` made of it,
 * and Ensembl's R64-1-1 reference. `GALLERY_ONLY=binned` or `matrix` runs one
 * part.
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
const ONLY = process.env.GALLERY_ONLY ?? ''
const DATA = (process.env.GALLERY_DATA ?? `${BASE}/out/pairsqc/`).replace(/\/?$/, '/')
const PAIRS = process.env.GALLERY_PAIRS ?? 'CH128.sample.pairs.gz'
const MCOOL = process.env.GALLERY_MCOOL ?? 'CH128.sample.mcool'
const FASTA = process.env.GALLERY_FASTA ?? 'R64.fa'
/** The sequence the map stands on: yeast IV, the longest. */
const SEQUENCE = process.env.GALLERY_SEQUENCE ?? 'IV'
const address = (name) => `${DATA}${encodeURIComponent(name)}`

mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  for (const close of await page.$$('.toast-close')) await close.click().catch(() => {})
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
const drawer = () => page.locator('.analysis-drawer').first()

/** The price line, the form's cards and whether Run can be pressed. */
const said = async (step) => {
  const state = await page.evaluate(() => {
    const drawerEl = document.querySelector('.analysis-drawer')
    const cards = [...(drawerEl?.querySelectorAll('.param-group') ?? [])].map((group) =>
      group.innerText.split('\n').filter((line) => line.trim() !== ''),
    )
    const run = [...(drawerEl?.querySelectorAll('.analysis-run button') ?? [])].find((b) =>
      /^run/i.test(b.textContent?.trim() ?? ''),
    )
    return {
      cards,
      price: drawerEl?.querySelector('.analysis-cost')?.textContent ?? null,
      run: run === undefined ? null : { text: run.textContent?.trim(), disabled: run.disabled },
    }
  })
  console.log(`--- ${step}\n${JSON.stringify(state, null, 1)}`)
}

/** Every note the drawer printed under the run, and the figures it drew. */
const notes = async (step) => {
  const { text, figures } = await page.evaluate(() => ({
    text: [...document.querySelectorAll('.analysis-drawer .analysis-notes li')].map((n) => n.textContent),
    figures: [...document.querySelectorAll('.analysis-drawer .figure-block')].map(
      (n) => n.querySelector('.figure-title, h3, h4, .figure-label')?.textContent ?? n.textContent?.slice(0, 80),
    ),
  }))
  console.log(`--- notes, ${step}\n${text.map((line) => `  · ${line}`).join('\n') || '  (none)'}`)
  console.log(`--- figures, ${step}\n${figures.map((line) => `  · ${line}`).join('\n') || '  (none)'}`)
}

/** Open a map (or a `.pairs`, answering the dialog) and stand on {@link SEQUENCE}. */
const open = async (url, { pairs }) => {
  await page.goto(`${BASE}/#uri=${url}`)
  if (pairs) {
    await page.waitForSelector('.pairs-base', { timeout: 180000 })
    await sleep(600)
    await page.locator('.pairs-download input').uncheck()
    await page.locator('button', { hasText: 'build the map' }).click()
  }
  const started = Date.now()
  await page.waitForFunction(
    () =>
      !document.body.textContent.includes('Opening ') &&
      (document.querySelector('.heatmap-canvas') !== null ||
        document.querySelector('.breadcrumb')?.textContent.includes('Chromosomes')),
    null,
    { timeout: 900000 },
  )
  console.log(`opened ${decodeURIComponent(url.split('/').pop())} in ${Math.round((Date.now() - started) / 1000)} s`)
  await sleep(1500)
  for (const b of await page.$$('button')) {
    if ((await b.innerText()).trim() === 'dismiss' && (await b.isVisible())) await b.click()
  }
  const box = page.locator('input[placeholder*="a sequence"]').first()
  await box.fill(SEQUENCE)
  await box.press('Enter')
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(2500)
}

/** The Analysis column open, the General and Aesthetics ones folded out of its way. */
const analysis = async () => {
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(800)
}

/** A task's drawer, by its row's title. */
const openTask = async (title) => {
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) {
    await close.click()
    await sleep(600)
  }
  const row = page.locator('.analysis-row-title', { hasText: title }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1200)
}

/** Press Run and wait for the task's last figure, or for a failure. */
const run = async (step, until) => {
  const started = Date.now()
  await drawer().locator('.analysis-run button', { hasText: /^run/i }).first().click()
  await page
    .waitForFunction(
      (wanted) => {
        const text = document.querySelector('.analysis-drawer')?.textContent ?? ''
        return text.includes(wanted) || document.querySelector('.analysis-drawer .inline-error') !== null
      },
      until,
      { timeout: 300000 },
    )
    .catch(() => console.log(`never saw “${until}”`))
  console.log(`${step}: ran in ${Math.round((Date.now() - started) / 1000)} s`)
  await sleep(2500)
  await notes(step)
}

/** The figure whose heading holds `text`, scrolled to the top of the drawer. */
const toFigure = async (text) => {
  const found = await page.evaluate((wanted) => {
    const block = [...document.querySelectorAll('.analysis-drawer .figure-block')].find((node) =>
      node.textContent?.includes(wanted),
    )
    block?.scrollIntoView({ block: 'start' })
    return block !== undefined
  }, text)
  if (!found) console.log(`no figure “${text}”`)
  await sleep(1200)
}

/** A file fetched in the page and dropped where `selector` (and `text`) says. */
const dropOn = async (selector, text, url, name) => {
  await page.evaluate(
    async ({ selector, text, url, name }) => {
      const target = [...document.querySelectorAll(selector)].find((el) => text === '' || (el.textContent ?? '').includes(text))
      if (target === undefined) throw new Error(`nothing to drop on: ${selector} ${text}`)
      const file = new File([await (await fetch(url)).blob()], name)
      const transfer = new DataTransfer()
      transfer.items.add(file)
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
    },
    { selector, text, url, name },
  )
  await sleep(1500)
}

/** Choose `option` in the drawer's select whose options include it. */
const choose = async (option) => {
  const select = drawer().locator('select').filter({ has: page.locator('option', { hasText: option }) }).first()
  if (!(await select.count())) {
    console.log('no select offers', option)
    return
  }
  const label = await select.locator('option', { hasText: option }).first().textContent()
  await select.selectOption({ label: label ?? option })
  await sleep(800)
}

try {
  if (ONLY === '' || ONLY === 'binned') {
    // ---- the .pairs, binned on the fly ------------------------------------
    await open(address(PAIRS), { pairs: true })
    await analysis()
    await shot('q01-catalogue')
    // The 1D card's head, where Restriction sites sits under Find a motif.
    await page.locator('.analysis-row-title', { hasText: 'Restriction sites' }).first().scrollIntoViewIfNeeded()
    await sleep(500)
    await shot('q02-catalogue-1d')

    await openTask('Pairs QC')
    await said('binned: the form')
    await shot('q03-form-binned')
    await run('binned, the import alone', 'pairtools stats')
    await toFigure('P(s) by pair orientation')
    await shot('q04-orientation')
    await toFigure('Pair types')
    await shot('q05-types-cis')
    await toFigure('pairtools stats')
    await shot('q06-stats-table')

    // P(s) asks for no orientation any more.
    await openTask('Contact probability P(s)')
    await said('P(s): the form')
    await shot('q07-ps-form')

    // The reference, dropped on the Annotations panel as a reader drops one.
    // Its lane is drawn on a canvas, so what says it has arrived is the GC lane's
    // row in the page; then the form's reference list offers it.
    await dropOn('.ann-drop', 'Load a track', address(FASTA), FASTA)
    await sleep(6000)
    await openTask('Pairs QC')
    await choose(FASTA.replace(/\.(fa|fasta|2bit)(\.gz)?$/i, ''))
    await choose('DpnII')
    await said('binned: DpnII chosen')
    await shot('q08-form-digest')
    await run('binned, DpnII', 'Coverage against')
    await toFigure('Pair classes by orientation')
    await shot('q09-classes')
    await toFigure('Distance from a read')
    await shot('q10-distance-fragments')
    await toFigure('Coverage against')
    await shot('q11-sites')

    // A typed site with no cut in it: refused beside a greyed Run.
    await choose('custom')
    const sites = drawer().locator('.param-field', { hasText: 'sites' }).locator('input').first()
    await sites.fill('GATC')
    await sites.press('Enter')
    await sleep(800)
    await said('binned: a site typed without its ^')
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.analysis-drawer .param-group')].find((group) =>
        group.textContent?.includes('Restriction enzyme'),
      )
      card?.scrollIntoView({ block: 'start' })
    })
    await sleep(500)
    await shot('q12-custom-refused')
  }

  if (ONLY === '' || ONLY === 'matrix') {
    // ---- the .mcool, and the .pairs handed to the form -------------------
    await open(address(MCOOL), { pairs: false })
    await analysis()
    await openTask('Pairs QC')
    await said('matrix: the form')
    await shot('q13-form-matrix')
    await dropOn('.param-drop', '', address(PAIRS), PAIRS)
    await said('matrix: the .pairs dropped')
    await shot('q14-matrix-dropped')
    await run('matrix, dropped', 'pairtools stats')
    await toFigure('P(s) by pair orientation')
    await shot('q15-matrix-figures')

    // The digest against the dropped file's records, on the matrix's own grid.
    await page.evaluate(() => document.querySelector('.analysis-drawer .param-group')?.scrollIntoView({ block: 'start' }))
    await choose(FASTA.replace(/\.(fa|fasta|2bit)(\.gz)?$/i, ''))
    await choose('DpnII')
    await said('matrix: DpnII chosen')
    await shot('q16-matrix-digest-form')
    await run('matrix, DpnII', 'Coverage against')
    await toFigure('Pair classes by orientation')
    await shot('q17-matrix-classes')
    await toFigure('Coverage against')
    await shot('q18-matrix-sites')
  }
} catch (error) {
  console.log('ERROR', error)
  await shot('q-error')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
