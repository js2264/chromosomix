/**
 * The dev features switch (§29), in headless Chromium: what a reader sees with
 * it off, the switch itself, and what turning it on brings back.
 *
 * Off, the landing page's store has no mock community, *About* says nothing of
 * `.metacool`, and a `.metacool` named by a link is refused in the sentence an
 * unknown file gets. The switch is then pressed — which reloads the window —
 * and the same three are shot again: the mock community back on the landing
 * page, the switch lit, and the `.metacool` opening on its genomes table. It
 * prints what each step found, so a clause that should have gone and did not
 * is a line in the log rather than something to spot in a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-dev-features.mjs [out-dir]     # d01 … d08
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
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  console.log(`wrote ${name}.png`)
}
/** Every word on screen, for the log's assertions. */
const words = () => page.evaluate(() => document.body.innerText)
const METACOOL = `${BASE}/demo/metagenomics/mock-community/Mock_microbial_community.metacool`

async function landing() {
  // The tabs a reload keeps live in `sessionStorage`; without clearing them the
  // landing page would come back as the last file opened rather than as itself.
  await page.evaluate(() => sessionStorage.clear()).catch(() => {})
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
}

async function about() {
  await page.click('button[title="About this viewer"]')
  await page.waitForSelector('.about-body')
  await sleep(400)
}

async function closeModal() {
  await page.keyboard.press('Escape')
  await sleep(300)
}

async function openMetacool() {
  await page.goto(`${BASE}/#uri=${encodeURIComponent(METACOOL)}`, { waitUntil: 'domcontentloaded' })
  // A remote open is a handful of range requests, and a name the router does
  // not know is sniffed first — during which the tab shows its picker. So wait
  // for the outcome itself, a refusal or the genomes table, not for a spinner
  // to go away.
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const now = await words()
    if (/HDF5, but not|Genomes\n/.test(now) || /metator_/.test(now)) break
  }
  await sleep(1000)
}

/** The lab's store, whose figures are where the mock community would be. */
async function labStore() {
  await page.click('text=RSG lab data')
  await sleep(2500)
}

// ── Off ────────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/`)
await page.evaluate(() => localStorage.removeItem('metacooler-viewer:dev-features'))
await landing()
await labStore()
let text = await words()
console.log('off · the lab store names the mock community:', /mock (microbial )?community/i.test(text))
await shot('d01-store-off')
await landing()

await about()
text = await page.evaluate(() => document.querySelector('.about-body')?.innerText ?? '')
// The repository's own address, `metacooler.js`, is the app's name, not the format's.
console.log('off · About names .metacool:', /\.m?metacool\b|multi-genome/i.test(text))
console.log('off · switch pressed:', await page.getAttribute('.about-dev .btn-switch', 'aria-pressed'))
await shot('d02-about-off')
await closeModal()

await openMetacool()
text = await words()
console.log('off · .metacool refused:', /not a contact map this viewer reads/.test(text))
console.log('off · refusal names metacool (outside the file name):',
  /metacool/i.test(text.replaceAll('Mock_microbial_community.metacool', '')))
await shot('d03-metacool-refused')

// ── The switch ─────────────────────────────────────────────────────────────
await landing()
await about()
await page.hover('.about-dev .btn-switch')
await sleep(300)
await shot('d04-about-switch-hover')
await Promise.all([page.waitForEvent('load'), page.click('.about-dev .btn-switch')])
await sleep(2500)

// ── On ─────────────────────────────────────────────────────────────────────
await labStore()
text = await words()
console.log('on · the lab store names the mock community:', /mock (microbial )?community/i.test(text))
await shot('d05-store-on')
await landing()

await about()
console.log('on · switch pressed:', await page.getAttribute('.about-dev .btn-switch', 'aria-pressed'))
text = await page.evaluate(() => document.querySelector('.about-body')?.innerText ?? '')
console.log('on · About names .metacool:', /\.metacool multi-genome/.test(text))
await shot('d06-about-on')
await closeModal()

await openMetacool()
text = await words()
console.log('on · genomes table:', /genomes/i.test(text), '· refused:', /not a contact map this viewer reads/.test(text))
await shot('d07-metacool-on')

// Back off, so a gallery run leaves the browser as it found it.
await landing()
await about()
await Promise.all([page.waitForEvent('load'), page.click('.about-dev .btn-switch')])
await sleep(1500)
console.log('back off · switch:', await page.evaluate(() => localStorage.getItem('metacooler-viewer:dev-features')))
await shot('d08-landing-off-again')

if (errors.length > 0) console.log('page errors:', errors)
await browser.close()
