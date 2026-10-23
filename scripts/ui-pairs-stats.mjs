/**
 * Drive the General column's *Pairs statistics* card in headless Chromium (§3.7).
 *
 * A `.pairs` opened by its address and binned through the import dialog, then
 * the card the import's counts land in: the column as it opens, the card close
 * up with its three charts — the pair types' bar, cis past each distance, P(s)
 * by orientation with the point the four meet marked — then the column at its
 * narrowest and wide, its *save .stats* through a stand-in save dialog that
 * keeps the bytes (written under `files/`, and its first lines printed — they
 * must be pairtools' own keys), the dark theme from the system and chosen in
 * the app, a file with no `pair_type` column, whose card must say no record was
 * counted as a duplicate and draw no types bar, and a file with no strand
 * columns, which draws no P(s).
 *
 * Every shot of the card is measured as well as taken: each chart's labels
 * inside its own box and clear of one another, nothing in the card wider than
 * the card, and the charts' text over the card's contrast floor. Findings are
 * printed under `--- card audit`.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-pairs-stats.mjs [out-dir]
 *
 * The file is the committed golden's (`test/golden/pairs_stats/sample.pairs.gz`,
 * 30,300 records drawn from the yeast Micro-C cooler), or the one named by
 * `GALLERY_PAIRS` relative to the dev server's root. The golden's strands are
 * drawn at random, so its four orientations lie on one another; with
 * `GALLERY_LIBRARY` naming a real library's `.pairs.gz` anywhere on disk (the
 * validation's CH128, say), the head of it — its header and first
 * `GALLERY_LIBRARY_RECORDS` records, 400,000 by default — is opened too, for a
 * P(s) whose orientations part at short range: ps07, ps07b dark. Its copy without the
 * `pair_type` column, and the one without strands, are written to
 * `<out-dir>/files/`, which the dev server serves when the out-dir is under the
 * repository (the default, `gallery/`).
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, relative, resolve } from 'node:path'
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib'

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
const PAIRS = process.env.GALLERY_PAIRS ?? 'test/golden/pairs_stats/sample.pairs.gz'
const FILES = join(OUT, 'files')
mkdirSync(FILES, { recursive: true })

// The same file with its `pair_type` column taken out, beside the shots.
const untyped = join(FILES, 'untyped.pairs.gz')
{
  const text = gunzipSync(readFileSync(PAIRS)).toString('utf8')
  const stripped = text
    .split('\n')
    .map((line) =>
      line.startsWith('#columns:')
        ? line.replace(' pair_type', '')
        : line.startsWith('#') || line === ''
          ? line
          : line.split('\t').slice(0, 7).join('\t'),
    )
    .join('\n')
  writeFileSync(untyped, gzipSync(stripped))
}

// …and with its two strand columns taken out, which the format allows: no
// orientation is counted, so the card has no P(s) to draw.
const unstranded = join(FILES, 'unstranded.pairs.gz')
{
  const text = gunzipSync(readFileSync(PAIRS)).toString('utf8')
  const stripped = text
    .split('\n')
    .map((line) =>
      line.startsWith('#columns:')
        ? line.replace(' strand1 strand2', '')
        : line.startsWith('#') || line === ''
          ? line
          : line
              .split('\t')
              .filter((_, i) => i !== 5 && i !== 6)
              .join('\t'),
    )
    .join('\n')
  writeFileSync(unstranded, gzipSync(stripped))
}
// The head of a real library, when one is named.
const LIBRARY = process.env.GALLERY_LIBRARY ?? null
const library = LIBRARY === null ? null : join(FILES, 'library-head.pairs.gz')
if (LIBRARY !== null) {
  const wanted = Number(process.env.GALLERY_LIBRARY_RECORDS ?? 400000)
  const lines = []
  let records = 0
  const input = createReadStream(LIBRARY).pipe(createGunzip())
  const reader = createInterface({ input, crlfDelay: Infinity })
  for await (const line of reader) {
    if (!line.startsWith('#')) records++
    if (records > wanted) break
    lines.push(line)
  }
  reader.close()
  input.destroy()
  writeFileSync(library, gzipSync(`${lines.join('\n')}\n`))
  console.log(`--- ${LIBRARY}: its header and first ${Math.min(records, wanted)} records, as ${library}`)
}
const served = (path) => `${BASE}/${relative(process.cwd(), resolve(path)).split('\\').join('/')}`

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errors = []

/** A page, its save dialog stood in for by one that keeps what it is handed. */
async function pageFor({ dark = false } = {}) {
  const context = await browser.newContext({
    // Tall, so the card with its charts fits the column whole at its narrowest.
    viewport: { width: 1600, height: 1500 },
    // Twice over: the charts' marks are a pixel or two, and at one they blur.
    deviceScaleFactor: 2,
    colorScheme: dark ? 'dark' : 'light',
  })
  // Vite's live reload held off: a file saved while the gallery runs would
  // reload the page under a shot and lose the card. Each page is the code as it
  // was when that page opened.
  await context.routeWebSocket(/./, () => {})
  await context.addInitScript(() => {
    window.__saved = []
    window.showSaveFilePicker = async (options) => ({
      name: options?.suggestedName ?? 'file',
      createWritable: async () => {
        const chunks = []
        return {
          write: async (chunk) => chunks.push(chunk),
          close: async () => {
            const blob = new Blob(chunks)
            window.__saved.push({ name: options?.suggestedName ?? 'file', text: await blob.text() })
          },
        }
      },
    })
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return { context, page }
}

/** Open a `.pairs` by its address, answer the dialog, and wait for the map. */
async function open(page, url) {
  await page.goto(`${BASE}/#uri=${url}`)
  await page.waitForSelector('.pairs-base', { timeout: 120000 })
  await sleep(500)
  const download = page.locator('.pairs-download input')
  if (await download.isChecked()) await download.uncheck()
  await page.locator('button', { hasText: 'build the map' }).click()
  await page.waitForFunction(
    () =>
      !document.body.textContent.includes('Opening ') &&
      (document.querySelector('.heatmap-canvas') !== null ||
        document.querySelector('.breadcrumb')?.textContent.includes('Chromosomes')),
    null,
    { timeout: 300000 },
  )
  await sleep(1500)
  for (const close of await page.$$('.toast-close')) await close.click().catch(() => {})
}

/** The card, scrolled into the column's view; its rows printed. */
async function card(page, step) {
  const found = await page.evaluate(() => {
    const node = document.querySelector('.card.pairs-stats')
    node?.scrollIntoView({ block: 'start' })
    return node === null
      ? null
      : {
          rows: [...node.querySelectorAll('.kv .k')].map((k) => `${k.textContent}: ${k.nextElementSibling?.textContent}`),
          types: node.querySelector('.pairs-stats-types')?.textContent ?? null,
          hints: [...node.querySelectorAll('.hint')].map((h) => h.textContent),
          charts: [...node.querySelectorAll('svg.pairs-stats-svg')].map((chart) => ({
            class: chart.getAttribute('class'),
            label: chart.getAttribute('aria-label'),
            viewBox: chart.getAttribute('viewBox'),
            width: Math.round(chart.getBoundingClientRect().width),
          })),
        }
  })
  console.log(`--- ${step}\n${JSON.stringify(found, null, 1)}`)
  await sleep(400)
  await audit(page, step)
  return page.locator('.card.pairs-stats').first()
}

/**
 * Measure the card: what a picture of it cannot be trusted to show.
 *
 * Every label in a chart inside the chart's own box and clear of every other
 * label in it; no child of the card wider than the card (a legend or a chip
 * line that did not wrap); and the charts' text and the captions at least
 * 4.5:1 on the card, which is the floor `ui-audit.mjs` holds small text to.
 */
async function audit(page, step) {
  const findings = await page.evaluate(() => {
    const out = []
    const card = document.querySelector('.card.pairs-stats')
    if (card === null) return ['no card']
    const box = card.getBoundingClientRect()
    for (const chart of card.querySelectorAll('svg.pairs-stats-svg')) {
      const frame = chart.getBoundingClientRect()
      const name = chart.getAttribute('class')
      if (frame.right > box.right - 1 || frame.left < box.left + 1) out.push(`${name}: wider than the card`)
      const texts = [...chart.querySelectorAll('text')].map((t) => ({ t: t.textContent, r: t.getBoundingClientRect() }))
      for (const { t, r } of texts) {
        if (r.left < frame.left - 0.5 || r.right > frame.right + 0.5 || r.top < frame.top - 0.5 || r.bottom > frame.bottom + 0.5)
          out.push(`${name}: "${t}" outside its chart`)
      }
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          const a = texts[i].r
          const b = texts[j].r
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)
            out.push(`${name}: "${texts[i].t}" overlaps "${texts[j].t}"`)
        }
      }
      if (chart.querySelector('title') === null || chart.getAttribute('role') !== 'img' || !chart.getAttribute('aria-label'))
        out.push(`${name}: no title, role or label`)
    }
    for (const node of card.querySelectorAll('.pairs-stats-chart, .pairs-stats-legend, .pairs-stats-types, .pairs-stats-caption')) {
      if (node.scrollWidth > node.clientWidth + 1) out.push(`${node.className}: ${node.scrollWidth} wide in ${node.clientWidth}`)
      if (node.getBoundingClientRect().right > box.right + 0.5) out.push(`${node.className}: past the card's edge`)
    }
    const lum = (c) => {
      const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => {
        const x = Number(v) / 255
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const bg = lum(getComputedStyle(card).backgroundColor)
    const seen = new Set()
    for (const node of card.querySelectorAll('svg.pairs-stats-svg text, .pairs-stats-caption, .pairs-stats-key, .pairs-stats-type')) {
      const style = getComputedStyle(node)
      const ink = node instanceof SVGElement ? style.fill : style.color
      const a = lum(ink)
      const ratio = (Math.max(a, bg) + 0.05) / (Math.min(a, bg) + 0.05)
      const key = `${node.getAttribute('class')} ${ink}`
      if (ratio < 4.5 && !seen.has(key)) {
        seen.add(key)
        out.push(`${node.getAttribute('class')}: ${ratio.toFixed(2)}:1 on the card`)
      }
    }
    return out
  })
  console.log(`--- card audit (${step}): ${findings.length === 0 ? 'clean' : `\n${findings.join('\n')}`}`)
  auditFindings.push(...findings.map((f) => `${step}: ${f}`))
}
const auditFindings = []

/** The General column at `px`, as the reader's drag leaves it. */
async function columnWidth(page, px) {
  await page.evaluate((width) => {
    const column = document.querySelector('.card.pairs-stats')?.closest('.panel-column')
    if (column instanceof HTMLElement) column.style.width = `${width}px`
  }, px)
  await sleep(600)
}

const shot = async (page, name, target = null) => {
  await (target ?? page).screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}

{
  const { context, page } = await pageFor()
  await open(page, served(PAIRS))
  const held = await card(page, 'opened')
  await shot(page, 'ps01-general-column')
  await shot(page, 'ps02-card', held)
  await columnWidth(page, 240)
  await shot(page, 'ps02b-card-narrowest', await card(page, 'the column at its narrowest, 240 px'))
  await columnWidth(page, 480)
  await shot(page, 'ps02c-card-wide', await card(page, 'the column at 480 px'))
  await columnWidth(page, 288)

  await held.locator('button.pairs-stats-save').click()
  await page.waitForFunction(() => window.__saved.length > 0, null, { timeout: 10000 })
  const saved = await page.evaluate(() => window.__saved[0])
  writeFileSync(join(FILES, saved.name), saved.text)
  const lines = saved.text.split('\n')
  console.log(`--- saved ${saved.name}: ${lines.length - 1} lines\n${lines.slice(0, 12).join('\n')}\n…`)
  await held.locator('button.pairs-stats-save').hover()
  await sleep(900)
  await shot(page, 'ps03-save-hovered', held)
  await context.close()
}

{
  const { context, page } = await pageFor({ dark: true })
  await open(page, served(PAIRS))
  const held = await card(page, 'dark')
  await shot(page, 'ps04-dark')
  await shot(page, 'ps04b-dark-card', held)
  await context.close()
}

{
  // Dark chosen in the app over a light system: the card's other scope.
  const { context, page } = await pageFor()
  await open(page, served(PAIRS))
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await sleep(400)
  const held = await card(page, 'dark chosen in the app')
  await shot(page, 'ps04c-dark-chosen-card', held)
  await context.close()
}

{
  const { context, page } = await pageFor()
  await open(page, served(untyped))
  const held = await card(page, 'no pair_type column')
  await shot(page, 'ps05-no-pair-type', held)
  await context.close()
}

{
  const { context, page } = await pageFor()
  await open(page, served(unstranded))
  const held = await card(page, 'no strand columns')
  await shot(page, 'ps06-no-strands', held)
  await context.close()
}

if (library !== null) {
  for (const dark of [false, true]) {
    const { context, page } = await pageFor({ dark })
    await open(page, served(library))
    const held = await card(page, `a real library's head${dark ? ', dark' : ''}`)
    await shot(page, dark ? 'ps07b-library-dark' : 'ps07-library', held)
    await context.close()
  }
}

await browser.close()
if (errors.length > 0) console.log(`--- page errors\n${errors.join('\n')}`)
console.log(`--- card audit, every shot: ${auditFindings.length === 0 ? 'clean' : `${auditFindings.length} findings`}`)
