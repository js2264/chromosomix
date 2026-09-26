/**
 * The Compartments task's table of components, in headless Chromium (§18.8).
 *
 * On yeast chromosome IV from the micro-C demo: three components by cooltools'
 * method, phased by gene density, and the table under them — each component's
 * eigenvalue, how much of the contacts it accounts for, and its r with the
 * phasing; then the same by the correlation, where the correlation matrix's own
 * *variance* stands beside the share of the contacts. Each table is printed as
 * well as shot.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-compartments.mjs [out-dir]
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
const errors = []
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }

const openTask = async (title) => {
  for (const b of await page.$$('button[title^="Show the Analysis panel"]')) {
    if (await b.isVisible()) { await b.click(); await sleep(800); break }
  }
  const row = page.locator('.analysis-row-title', { hasText: title }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await sleep(1200)
}
const choose = async (optionText) => {
  const select = page.locator('.analysis-drawer select').filter({ has: page.locator('option', { hasText: optionText }) }).first()
  if (!(await select.count())) { console.log('no select offers', optionText); return }
  const label = await select.locator('option', { hasText: optionText }).first().textContent()
  await select.selectOption({ label: label ?? optionText })
  await sleep(600)
}
const computed = () =>
  page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
const run = async (marker) => {
  const before = await computed()
  await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(({ before, marker }) => {
    const text = document.querySelector('.analysis-drawer-body')?.innerText ?? ''
    const now = text.match(/computed in [^\n]*/)?.[0] ?? ''
    return now !== '' && now !== before && text.includes(marker)
  }, { before, marker }, { timeout: 300000 }).catch(() => console.log('run did not finish:', marker))
  await sleep(1500)
}
/** The components table on screen: its head, then a row per component. */
const table = async () => {
  const body = page.locator('.analysis-drawer-body')
  const head = page.locator('.analysis-drawer-body', { hasText: 'Components ·' })
  if (!(await head.count())) return 'no components table'
  return body.evaluate((root) => {
    const title = [...root.querySelectorAll('*')].find((node) => node.childElementCount === 0 && /^Components ·/.test(node.textContent ?? ''))
    let box = title?.parentElement ?? null
    while (box !== null && box.querySelector('table') === null) box = box.parentElement
    const grid = box?.querySelector('table')
    if (grid == null) return 'no table under the heading'
    return [...grid.querySelectorAll('tr')].map((tr) => [...tr.children].map((cell) => (cell.textContent ?? '').trim()).join(' | ')).join('\n')
  })
}
const scrollTo = (needle) => page.evaluate((needle) => {
  const body = document.querySelector('.analysis-drawer-body')
  const hit = [...(body?.querySelectorAll('*') ?? [])].find((el) => el.childElementCount === 0 && (el.textContent ?? '').includes(needle))
  hit?.scrollIntoView({ block: 'start' })
}, needle)

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
  await page.evaluate(() => {
    const hash = new URLSearchParams(location.hash.slice(1))
    hash.set('region', 'IV')
    location.hash = hash.toString()
  })
  await page.waitForFunction(() => /1,532 × 1,532 bins/.test(document.body.innerText), null, { timeout: 120000 })
  await sleep(3000)

  await openTask('Compartments')
  console.log('head:', await page.evaluate(() => document.querySelector('.analysis-drawer')?.innerText.split('\n')[0] ?? ''))
  await choose('genes')
  const components = page.locator('.analysis-drawer input[id$="-components"]').first()
  if (await components.count()) {
    await components.fill('3')
    await components.press('Tab')
    await sleep(400)
  }
  await run('Components')
  console.log('by cooltools:\n' + (await table()))
  await scrollTo('Components ·')
  await sleep(500)
  await shot('cp1-components-cooltools')

  await choose('Lieberman-Aiden 2009')
  await run('· correlation')
  console.log('by the correlation:\n' + (await table()))
  await scrollTo('Components ·')
  await sleep(500)
  await shot('cp2-components-correlation')
  // The column's own note, as a reader hovering the heading gets it.
  console.log('of contacts says:', await page.locator('.analysis-drawer th', { hasText: 'of contacts' }).first().getAttribute('title'))
} finally {
  console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors')
  await browser.close()
}
