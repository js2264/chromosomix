/**
 * Which maps an overlay is drawn on, in headless Chromium (§8.1).
 *
 * A deck of three yeast maps — the micro-C cooler, the Hi-C `.hic` and the
 * yeast–*M. pneumoniae* cooler — with the micro-C loop calls and the ATAC
 * track loaded. The loops row's *maps* field is pressed through its states,
 * shooting the deck and the row at each:
 *
 * - imported: on the first map only, *on 1 of 3*;
 * - the Hi-C map's mark pressed: circled on two;
 * - *every map*: on all three, *on every map*;
 * - the first map's mark pressed off: on the other two;
 * - *no map*: on none, the row still in the list;
 *
 * then the ATAC row beside it, whose *location* keeps its four edges a map, the
 * batch box's two fields with both ticked, and the Analysis column's rows for
 * *Compartments* and *Reproducibility* under their names. It prints
 * which marks are lit and how many circles each map drew at every step.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-overlay-maps.mjs [out-dir]
 *
 * The deck is a workspace this script writes under `gallery/`, which the dev
 * server serves beside `demo/` and git does not track.
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
mkdirSync('gallery', { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

// ---------------------------------------------------------------------------
// The deck: three maps, the loops and the ATAC track.
// ---------------------------------------------------------------------------

const YEAST = `${BASE}/demo/yeast`
const style = (colour, size, opacity) => ({
  colour,
  size,
  mode: 'area',
  limits: { auto: true, min: 0, max: 1 },
  group: '',
  shape: 'element',
  radius: 7,
  opacity,
  flip: false,
})
const workspace = {
  kind: 'metacooler.workspace',
  version: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
  active: 0,
  tabs: [
    {
      version: 1,
      createdAt: '2026-09-28T00:00:00.000Z',
      state: {
        uri: `${YEAST}/Yeast_microC_G2M_1kb.cool`,
        maps: [`${YEAST}/Yeast_hic.hic`, `${BASE}/demo/yeast-mpneumoniae/Yeast_mpneumoniae_G2M.mcool::/resolutions/1000`].join('|'),
        view: 'region',
        region: 'IV:1000000-1400000',
        level: 'bin',
        balance: true,
        transform: 'log10',
        colormap: 'default',
      },
      tracks: [
        {
          id: 'demo-loops',
          card: 'overlay',
          kind: 'pairs',
          label: 'loops',
          source: { kind: 'remote', name: 'Yeast_microC_loops.tsv', url: `${YEAST}/Yeast_microC_loops.tsv` },
          visible: true,
          placement: { bottom: true, right: false },
          style: style('#cc79a7', 16, 0.9),
        },
        {
          id: 'demo-atac',
          card: 'linear',
          kind: 'track',
          label: 'ATAC',
          source: { kind: 'remote', name: 'Yeast_ATAC.bw', url: `${YEAST}/Yeast_ATAC.bw` },
          visible: true,
          placement: { bottom: true, right: false },
          style: style('#d55e00', 56, 1),
        },
      ],
      manual: [],
      sequences: [],
      groups: {},
      scaling: {},
      compareNormalise: false,
      tables: {},
      name: 'loops on three maps',
      deck: { columns: 3 },
    },
  ],
}
writeFileSync('gallery/_overlay-deck.metacooler.json', JSON.stringify(workspace, null, 1))

// ---------------------------------------------------------------------------

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
const shotOf = async (locator, name, pad = 6) => {
  const box = await locator.first().boundingBox()
  if (box === null) { console.log('nothing to shoot for', name); return }
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const rowOf = (id) => page.locator(`.annotation-card .ann-row[data-id="${id}"]`)
const openRow = async (id) => {
  const row = rowOf(id)
  await row.scrollIntoViewIfNeeded()
  if ((await row.locator('.ann-field').count()) === 0) await row.locator('.ann-more').click()
  await sleep(600)
  await row.scrollIntoViewIfNeeded()
  return row
}
/** The loops row's `maps` field as text: each map's name and whether its mark is lit, then the count. */
const marks = () =>
  page.evaluate(() => {
    const row = document.querySelector('.annotation-card .ann-row[data-id="demo-loops"]')
    const field = Array.from(row?.querySelectorAll('.field') ?? []).find(
      (node) => node.querySelector(':scope > .field-label')?.textContent === 'maps',
    )
    if (field === undefined) return 'no maps field'
    const lines = Array.from(field.querySelectorAll('.ann-place-map')).map(
      (line) =>
        `${line.querySelector('.ann-place-name')?.textContent}: ${line.querySelector('[data-face]')?.getAttribute('aria-pressed')}`,
    )
    return [...lines, field.querySelector('.ann-place-count')?.textContent ?? ''].join(' · ')
  })
/** The field's controls: a map's mark by its line, or one of the two buttons. */
const mapsField = () => rowOf('demo-loops').locator('.field', { has: page.locator('.field-label', { hasText: /^maps$/ }) })
const pressMap = async (index) => {
  await mapsField().locator('[data-face]').nth(index).click()
  await sleep(1500)
}
const pressAll = async (text) => {
  await mapsField().locator('.ann-place-all .btn', { hasText: text }).click()
  await sleep(1500)
}
const deck = () => page.locator('.deck-grid').first()

try {
  await page.goto(`${BASE}/?config=${BASE}/gallery/_overlay-deck.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelectorAll('.heatmap-canvas').length >= 3,
    null,
    { timeout: 180000 },
  )
  await page.waitForFunction(
    () => document.querySelector('.annotation-card .ann-row[data-id="demo-loops"].ann-ready') !== null,
    null,
    { timeout: 120000 },
  )
  await sleep(6000)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Annotations panel')
  await sleep(800)

  const loops = await openRow('demo-loops')
  console.log('imported:', await marks())
  await shot('om01-deck-loops-on-the-first-map')
  await shotOf(loops, 'om02-loops-row-on-1-of-3')

  await pressMap(1)
  console.log('Hi-C pressed:', await marks())
  await shot('om03-deck-loops-on-two-maps')
  await shotOf(rowOf('demo-loops'), 'om04-loops-row-on-2-of-3')

  await pressAll('every map')
  console.log('every map:', await marks())
  await shotOf(deck(), 'om05-deck-loops-on-every-map')
  await shotOf(rowOf('demo-loops'), 'om06-loops-row-on-every-map')

  await pressMap(0)
  console.log('first map off:', await marks())
  await shot('om07-deck-loops-off-the-first-map')

  await pressAll('no map')
  console.log('no map:', await marks())
  await shot('om08-deck-loops-on-no-map')
  await shotOf(rowOf('demo-loops'), 'om09-loops-row-on-no-map')
  await pressMap(2)
  console.log('third map back:', await marks())

  // The lane beside it: its location keeps four edges a map.
  const atac = await openRow('demo-atac')
  await shotOf(atac, 'om10-atac-row-location')

  // Both ticked: the batch box carries the two fields, each for its own rows.
  for (const id of ['demo-loops', 'demo-atac']) {
    await rowOf(id).locator('.ann-tick').check()
    await sleep(400)
  }
  await sleep(800)
  // The box is taller than the column shows, so its two placement fields are
  // shot one at a time, each scrolled into view.
  const batchField = (label) =>
    page.locator('.ann-batch .field', { has: page.locator(':scope > .field-label', { hasText: new RegExp(`^${label}$`) }) })
  for (const [label, name] of [['location', 'om11-batch-location'], ['maps', 'om12-batch-maps']]) {
    await batchField(label).first().scrollIntoViewIfNeeded()
    await sleep(400)
    await batchField(label).first().screenshot({ path: `${OUT}/${name}.png` })
    console.log('shot', name)
  }
  console.log(
    'batch fields:',
    JSON.stringify(await page.$$eval('.ann-batch .field > .field-label', (all) => all.map((n) => n.textContent))),
  )
  for (const id of ['demo-loops', 'demo-atac']) await rowOf(id).locator('.ann-tick').uncheck()

  // The two renamed tasks, in the Analysis column.
  await fold('Show the Analysis panel')
  await sleep(1200)
  const titles = await page.$$eval('.analysis-row-title', (all) => all.map((n) => n.textContent.trim()))
  console.log('tasks:', JSON.stringify(titles.filter((t) => /Compartments|Reproducibility/.test(t))))
  for (const [title, name] of [['Compartments', 'om13-analysis-compartments'], ['Reproducibility', 'om14-analysis-reproducibility']]) {
    const row = page.locator('.analysis-row', { has: page.locator('.analysis-row-title', { hasText: new RegExp(`^${title}$`) }) })
    await row.first().scrollIntoViewIfNeeded()
    await sleep(600)
    await shotOf(row, name, 60)
  }
} finally {
  if (errors.length > 0) console.log('page errors:', JSON.stringify(errors.slice(0, 10)))
  await browser.close()
}
