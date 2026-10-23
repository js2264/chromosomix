/**
 * *About*'s three tabs, in headless Chromium: Overview, Notebooks and Licences,
 * with the build stamp under all three.
 *
 * The Notebooks tab reads each page's `rendered.json` from the deployed site
 * (`src/notebooks.ts`). The browser is not sent there: this script reads the
 * four stamps itself, from Node, and hands them to the page as the site's
 * answers — so the pictures show what the published pages say today, and a
 * machine whose browser cannot reach the site still draws them. It then shoots
 * the tab mid-read, one page whose stamp is missing, the dark theme, a laptop's
 * window on the Licences tab, and a phone's, and prints what each step found.
 *
 * The laptop's page is rendered by hand and committed (SPECS §18.10), so its
 * stamp is the one the deploy will unpack from `notebooks/laptop.html` when
 * that is committed — or from the render `LAPTOP_HTML` names, to see one
 * before committing it — and the site's otherwise.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-about.mjs [out-dir]     # ab01 … ab09
 */

import { createRequire } from 'node:module'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const SITE = process.env.NOTEBOOKS_SITE ?? 'https://chromosomix.app/'
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

/** The published stamps, by page; a page whose stamp could not be read is missing. */
const STAMPS = {}
for (const path of ['validation', 'timings', 'parity', 'laptop']) {
  try {
    const response = await fetch(new URL(`${path}/rendered.json`, SITE))
    if (response.ok) STAMPS[path] = await response.text()
  } catch (error) {
    console.log(`${path}: no stamp read (${error.cause?.code ?? error.message})`)
  }
}

// The laptop's, as the deploy will publish it: unpacked from the page by `pages.py committed`.
const LAPTOP = process.env.LAPTOP_HTML ?? 'notebooks/laptop.html'
if (existsSync(LAPTOP)) {
  const scratch = mkdtempSync(join(tmpdir(), 'ui-about-'))
  mkdirSync(join(scratch, 'source'))
  copyFileSync(LAPTOP, join(scratch, 'source', 'laptop.html'))
  const run = spawnSync('python3', ['notebooks/scripts/pages.py', 'committed', join(scratch, 'site'), join(scratch, 'source')], {
    encoding: 'utf8',
  })
  const stamp = join(scratch, 'site', 'laptop', 'rendered.json')
  if (run.status === 0 && existsSync(stamp)) {
    STAMPS.laptop = readFileSync(stamp, 'utf8')
    console.log(`laptop: the stamp ${LAPTOP} carries`)
  } else {
    console.log(`laptop: ${LAPTOP} carries no stamp; ${run.stderr.trim()}`)
  }
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`stamps read: ${Object.keys(STAMPS).join(', ') || 'none'}`)

/**
 * One window: its own context, its theme, and the site's stamps answered from
 * what was read above — late by `delay`, and refused for the pages in `missing`.
 */
async function scene(name, fn, { width = 1440, height = 900, dark = false, delay = 0, missing = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e).slice(0, 200)}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text().slice(0, 200)}`)
  })
  await page.route(/\/rendered\.json$/, async (route) => {
    const path = new URL(route.request().url()).pathname.split('/').at(-2)
    if (delay > 0) await sleep(delay)
    const body = STAMPS[path]
    if (body === undefined || missing.includes(path)) await route.fulfill({ status: 404, body: 'Not Found' })
    else await route.fulfill({ status: 200, contentType: 'application/json', body, headers: { 'access-control-allow-origin': '*' } })
  })
  const shot = async (id) => {
    await page.screenshot({ path: join(OUT, `${id}.png`) })
    console.log(`wrote ${id}.png`)
  }
  const about = async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.view-picker', { timeout: 60000 })
    await sleep(1200)
    await page.click('button[title="About this viewer"]')
    await page.waitForSelector('.about-tabs')
    await sleep(300)
  }
  const tab = async (id) => {
    await page.click(`.about-tab[data-tab="${id}"]`)
    await sleep(300)
  }
  /** What the step found, for the log. */
  const report = async (label) => {
    const found = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll('.about-tab')].map((b) => `${b.textContent}${b.getAttribute('aria-selected') === 'true' ? '*' : ''}`),
      focused: document.activeElement?.closest('.about-tab')?.textContent ?? document.activeElement?.tagName ?? null,
      stamp: document.querySelector('.about-foot .about-build')?.textContent ?? null,
      stampOnScreen: (() => {
        const node = document.querySelector('.about-foot .about-build')
        if (node === null) return false
        const box = node.getBoundingClientRect()
        return box.bottom <= window.innerHeight && box.top >= 0
      })(),
      notebooks: [...document.querySelectorAll('.about-panel-notebooks:not([hidden]) .about-notebook')].map((row) => ({
        page: row.getAttribute('data-notebook'),
        href: row.querySelector('.about-notebook-title')?.getAttribute('href'),
        found: row.querySelector('.about-notebook-found:not(.hidden)')?.textContent ?? null,
        stamp: row.querySelector('.about-notebook-stamp')?.textContent ?? null,
      })),
      licences: document.querySelectorAll('.about-panel-licences:not([hidden]) .about-licence-row').length,
    }))
    console.log(`${label}: ${JSON.stringify(found, null, 1).replace(/\n\s*/g, ' ')}`)
  }
  try {
    await fn({ page, shot, about, tab, report })
  } catch (error) {
    console.log('FAILED', name, String(error).slice(0, 300))
    await shot(`${name}-failure`).catch(() => {})
  }
  await context.close()
}

await scene('light', async ({ page, shot, about, tab, report }) => {
  await about()
  await report('ab01 overview')
  await shot('ab01-overview')
  await tab('notebooks')
  await page.waitForFunction(() => document.querySelectorAll('.about-notebook-stamp').length === 0 ||
    [...document.querySelectorAll('.about-notebook-stamp')].every((p) => !p.textContent.startsWith('Reading')))
  await sleep(200)
  await report('ab03 notebooks')
  await shot('ab03-notebooks')
  await tab('licences')
  await report('ab04 licences')
  await shot('ab04-licences')
  // The keyboard: back to the first tab, then End and ← along the row.
  await page.focus('.about-tab[data-tab="licences"]')
  await page.keyboard.press('Home')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await sleep(300)
  await report('ab05 keyboard, Home End ←')
  await shot('ab05-keyboard')
})

// Mid-read: every stamp held back for a few seconds.
await scene('reading', async ({ page, shot, about, tab, report }) => {
  await about()
  await tab('notebooks')
  await report('ab02 reading')
  await shot('ab02-notebooks-reading')
}, { delay: 6000 })

// One page with no stamp to read: its row keeps the link and loses the lines.
await scene('missing', async ({ page, shot, about, tab, report }) => {
  await about()
  await tab('notebooks')
  await sleep(800)
  await report('ab06 timings missing')
  await shot('ab06-notebooks-one-missing')
}, { missing: ['timings'] })

await scene('dark', async ({ page, shot, about, tab, report }) => {
  await about()
  await tab('notebooks')
  await sleep(800)
  await report('ab07 dark')
  await shot('ab07-notebooks-dark')
}, { dark: true })

// A laptop's window: the longest tab scrolls, and the stamp under it stays.
await scene('laptop', async ({ page, shot, about, tab, report }) => {
  await about()
  await tab('licences')
  await report('ab08 laptop licences')
  await shot('ab08-laptop-licences')
}, { width: 1280, height: 720 })

await scene('phone', async ({ page, shot, about, tab, report }) => {
  await about()
  await tab('notebooks')
  await sleep(800)
  await report('ab09 phone notebooks')
  await shot('ab09-phone-notebooks')
}, { width: 390, height: 844 })

await browser.close()
console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
