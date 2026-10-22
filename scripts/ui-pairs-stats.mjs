/**
 * Drive the General column's *Pairs statistics* card in headless Chromium (§3.7).
 *
 * A `.pairs` opened by its address and binned through the import dialog, then
 * the card the import's counts land in: the column as it opens, the card close
 * up, its *save .stats* through a stand-in save dialog that keeps the bytes
 * (written under `files/`, and its first lines printed — they must be
 * pairtools' own keys), the dark theme, and a file with no `pair_type` column,
 * whose card must say no record was counted as a duplicate.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-pairs-stats.mjs [out-dir]
 *
 * The file is the committed golden's (`test/golden/pairs_stats/sample.pairs.gz`,
 * 30,300 records drawn from the yeast Micro-C cooler), or the one named by
 * `GALLERY_PAIRS` relative to the dev server's root. Its copy without the
 * `pair_type` column is written to `<out-dir>/files/`, which the dev server
 * serves when the out-dir is under the repository (the default, `gallery/`).
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

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
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: dark ? 'dark' : 'light',
  })
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
        }
  })
  console.log(`--- ${step}\n${JSON.stringify(found, null, 1)}`)
  await sleep(400)
  return page.locator('.card.pairs-stats').first()
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
  const { context, page } = await pageFor()
  await open(page, served(untyped))
  const held = await card(page, 'no pair_type column')
  await shot(page, 'ps05-no-pair-type', held)
  await context.close()
}

await browser.close()
if (errors.length > 0) console.log(`--- page errors\n${errors.join('\n')}`)
