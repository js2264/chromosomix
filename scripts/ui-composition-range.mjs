/**
 * Drive *Base composition* over a FASTA dropped with its `.fai` on a new tab,
 * in headless Chromium, and write one screenshot a step (§8.8, §18.8).
 *
 * The genome is past the whole-read line: 80 Mb of three sequences with its
 * index, written by this script under `out/composition-range/` (git-ignored)
 * and dropped together on the landing page, as a reader drops hg38 and its
 * `.fai` — so it is read by range, never held. Its GC content swings in waves
 * and each sequence's G/C skew changes sign at its middle, so the lanes have a
 * shape to show. The row says *read by range from its index*; the form prices
 * the run as a scan of every base, in bytes; the run makes the four lanes; the
 * drawer's TSV button saves the GC skew, whose head and size are printed. It
 * declined such a reference in a note, after a form that called the run free.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-composition-range.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeSync, closeSync, writeFileSync, readFileSync } from 'node:fs'
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
const DATA = 'out/composition-range'
mkdirSync(OUT, { recursive: true })
mkdirSync(DATA, { recursive: true })

// ---------------------------------------------------------------------------
// The data: a genome past the whole-read line, with its index
// ---------------------------------------------------------------------------

const SEQUENCES = [
  ['chr1', 40_000_000],
  ['chr2', 25_000_000],
  ['chr3', 15_000_000],
]
const FASTA = join(DATA, 'waves.fa')
if (!existsSync(`${FASTA}.fai`)) {
  let seed = 7
  const random = () => {
    // `Math.imul`, not `*`: the product of two 32-bit numbers is past what a
    // double holds exactly, and the low bits a base is cut from go first.
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return (seed >>> 8) / 2 ** 24
  }
  const fd = openSync(FASTA, 'w')
  const fai = []
  let at = 0
  for (const [name, length] of SEQUENCES) {
    const head = `>${name}\n`
    writeSync(fd, head)
    at += head.length
    fai.push(`${name}\t${length}\t${at}\t60\t61`)
    // A megabyte of lines at a time, rather than a write a line.
    const chunk = Buffer.alloc(61 * 16_384)
    let used = 0
    for (let done = 0; done < length; done += 60) {
      const n = Math.min(60, length - done)
      for (let i = 0; i < n; i++) {
        const pos = done + i
        // GC between 30 and 60 % in waves of 6 Mb; G over C before the
        // middle and C over G after it, as a replichore's skew runs.
        const gc = 0.45 + 0.15 * Math.sin((2 * Math.PI * pos) / 6_000_000)
        const g = pos < length / 2 ? 0.56 : 0.44
        const r = random()
        chunk[used + i] =
          r < gc ? (random() < g ? 71 : 67) : random() < 0.5 ? 65 : 84
      }
      chunk[used + n] = 10
      used += n + 1
      if (used + 61 > chunk.length) {
        writeSync(fd, chunk, 0, used)
        at += used
        used = 0
      }
    }
    writeSync(fd, chunk, 0, used)
    at += used
  }
  closeSync(fd)
  writeFileSync(`${FASTA}.fai`, fai.join('\n') + '\n')
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const errors = []
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
// No save dialog a headless page could answer: a save falls back to a download.
await context.addInitScript(() => {
  window.showSaveFilePicker = undefined
})
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return true }
  }
  return false
}
const cost = () => page.evaluate(() => document.querySelector('.analysis-drawer .analysis-cost')?.textContent ?? '')
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
const notes = () => page.evaluate(() => [...document.querySelectorAll('.analysis-drawer-body li')].map((li) => li.innerText).join('\n'))
const rows = () => page.evaluate(() =>
  [...document.querySelectorAll('.annotation-card .ann-row')].map((row) => row.innerText.replace(/\s+/g, ' ').trim()),
)

try {
  // Twice: a cold dev server reloads the page once its dependencies are
  // optimised, and a drop made before that reload is lost with the page.
  await page.goto(`${BASE}/`)
  await sleep(6000)
  await page.goto(`${BASE}/`)
  await page.waitForSelector('.dropzone')
  await sleep(2000)

  // --- The FASTA and its .fai, dropped together on a new tab ------------------
  await page.evaluate(async (files) => {
    const transfer = new DataTransfer()
    for (const [url, name] of files) transfer.items.add(new File([await (await fetch(url)).arrayBuffer()], name))
    document.querySelector('.dropzone')?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  }, [[`${BASE}/${FASTA}`, 'waves.fa'], [`${BASE}/${FASTA}.fai`, 'waves.fa.fai']])
  await page.waitForFunction(() => /the sequences/.test(document.body.innerText ?? ''), null, { timeout: 180000 })
  await sleep(4000)
  await fold('Show the Annotations panel')
  await sleep(1500)
  console.log('rows:\n' + (await rows()).join('\n'))
  await shot('cr01-dropped-with-its-index')

  // --- The form, priced as a read ---------------------------------------------
  await fold('Show the Analysis panel')
  await sleep(1000)
  const row = page.locator('.analysis-row-title', { hasText: 'Base composition' }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1500)
  const box = page.locator('.analysis-drawer input[id$="-resolution"]').first()
  await box.fill('100000')
  await box.press('Tab')
  await sleep(800)
  console.log('cost:', await cost())
  await shot('cr02-form-priced-as-a-read')

  // --- The run, and its lanes -------------------------------------------------
  const before = await computed()
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction((before) => {
    const now = document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? ''
    return now !== '' && now !== before
  }, before, { timeout: 300000 }).catch(() => console.log('the run did not finish'))
  await sleep(1500)
  console.log('notes:\n' + (await notes()) + '\n' + (await computed()))
  await shot('cr03-run')

  // The drawer's TSV for the GC skew: its pieces made one Blob (§18.7).
  const tsv = page.locator('.analysis-drawer-body button', { hasText: /^TSV$/ }).nth(1)
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), tsv.click()])
  const saved = join(OUT, 'cr-gcskew.tsv')
  await download.saveAs(saved)
  const text = readFileSync(saved, 'utf8')
  const lines = text.split('\n')
  console.log(`TSV ${download.suggestedFilename()}: ${lines.length - 1} lines, ${text.length} characters`)
  console.log(lines.filter((line) => !line.startsWith('# param')).slice(0, 10).join('\n'))

  const shut = page.locator('.analysis-drawer-head button').last()
  if (await shut.isVisible().catch(() => false)) await shut.click()
  await sleep(2500)
  console.log('rows:\n' + (await rows()).join('\n'))
  await shot('cr04-lanes')
} finally {
  if (errors.length > 0) console.log('page errors:\n' + errors.join('\n'))
  await browser.close()
}
