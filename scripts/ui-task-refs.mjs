/**
 * The `?` on the Analysis column's rows (`ui/taskReference.ts`, its tip `ui/questionMark.ts`'s), in headless
 * Chromium on the yeast demo: the column with its marks, green and the text's
 * own colour; a green mark's tip, and an untested one's; the pointer carried
 * from a `?` into its tip, which stays for the DOI; a click on the `?`, which
 * opens no task; the 1D card's rows; the dark theme; and Pairs QC's and
 * Restriction sites' tips. It prints every row's mark and colour, so a task
 * that lost or gained one is a line in the log.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-task-refs.mjs [out-dir]     # tr01 … tr09
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
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errors = []

async function scene(name, fn, { dark = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e).slice(0, 200)}`))
  const shot = async (id) => {
    await page.screenshot({ path: join(OUT, `${id}.png`) })
    console.log(`wrote ${id}.png`)
  }
  const fold = async (title) => {
    for (const b of await page.$$(`button[title^="${title}"]`)) {
      if (await b.isVisible()) { await b.click(); await sleep(600); return }
    }
  }
  const row = (title) =>
    page.locator('.analysis-row', { has: page.locator('.analysis-row-title', { hasText: new RegExp(`^${title}$`) }) }).first()
  const tipText = () => page.evaluate(() => {
    const tip = document.querySelector('.question-tip:not(.hidden)')
    return tip === null ? null : { text: tip.innerText.replace(/\n/g, ' / '), href: tip.querySelector('a')?.href ?? null }
  })
  try {
    await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
    await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
    await sleep(2500)
    await fold('Fold the General panel')
    await fold('Fold the Aesthetics panel')
    await fold('Show the Analysis panel')
    await sleep(800)
    await fn({ page, shot, row, tipText })
  } catch (error) {
    console.log('FAILED', name, String(error).slice(0, 300))
    await shot(`${name}-failure`).catch(() => {})
  }
  await context.close()
}

await scene('light', async ({ page, shot, row, tipText }) => {
  const marks = await page.$$eval('.analysis-row', (rows) =>
    rows.map((r) => {
      const mark = r.querySelector('.task-ref')
      return `${r.querySelector('.analysis-row-title')?.textContent}: ${mark === null ? '—' : `${mark.classList.contains('is-validated') ? 'green' : 'black'} ${getComputedStyle(mark).color} ${mark.tagName}`}`
    }),
  )
  console.log(marks.join('\n'))
  await shot('tr01-column')

  await row('Diamond insulation').locator('.task-ref').hover()
  await sleep(300)
  console.log('tr02 insulation tip:', JSON.stringify(await tipText()))
  await shot('tr02-insulation-tip')

  await row('Scalogram').locator('.task-ref').hover()
  await sleep(300)
  console.log('tr03 scalogram tip:', JSON.stringify(await tipText()))
  await shot('tr03-scalogram-untested')

  // From the `?` down into the tip, where the DOI is: it stays.
  const mark = await row('Directionality index').locator('.task-ref').boundingBox()
  await page.mouse.move(mark.x + mark.width / 2, mark.y + mark.height / 2)
  await sleep(250)
  const tip = await page.locator('.question-tip').boundingBox()
  await page.mouse.move(tip.x + tip.width - 20, tip.y + tip.height - 6, { steps: 6 })
  await sleep(400)
  console.log('tr04 pointer in the tip:', JSON.stringify(await tipText()))
  await shot('tr04-pointer-in-tip')

  // A click on the `?` opens no task. The row is brought into view first: a
  // scroll puts the tip away, as it should, and Playwright's own scroll before
  // a click would land after it.
  await page.mouse.move(5, 500)
  await row('Compartments').scrollIntoViewIfNeeded()
  await sleep(500)
  await row('Compartments').locator('.task-ref').click()
  await sleep(600)
  const drawer = await page.evaluate(() => document.querySelector('.analysis-row.is-active .analysis-row-title')?.textContent ?? null)
  console.log('tr05 after a click on the ?: tip', JSON.stringify(await tipText()), '· task opened:', drawer)
  await shot('tr05-click-opens-nothing')
  await page.mouse.click(5, 500)
  await sleep(300)
  console.log('after a click elsewhere: tip', JSON.stringify(await tipText()))

  // The 1D card's rows.
  await row('Metaplot over a feature set').scrollIntoViewIfNeeded()
  await row('Metaplot over a feature set').locator('.task-ref').hover()
  await sleep(300)
  console.log('tr06 metaplot tip:', JSON.stringify(await tipText()))
  await shot('tr06-1d-card')

  // The digest and what Pairs QC counts from it: two tasks, two sections of the validation.
  for (const [id, title] of [['tr08-pairsqc-tip', 'Pairs QC'], ['tr09-restriction-tip', 'Restriction sites']]) {
    await page.mouse.move(5, 500)
    await row(title).scrollIntoViewIfNeeded()
    await sleep(400)
    await row(title).locator('.task-ref').hover()
    await sleep(300)
    console.log(`${id.slice(0, 4)} ${title} tip:`, JSON.stringify(await tipText()))
    await shot(id)
  }
})

await scene('dark', async ({ page, shot, row, tipText }) => {
  await row('Contact probability P\\(s\\)').locator('.task-ref').hover()
  await sleep(300)
  console.log('tr07 dark P(s) tip:', JSON.stringify(await tipText()))
  await shot('tr07-dark')
}, { dark: true })

await browser.close()
console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
