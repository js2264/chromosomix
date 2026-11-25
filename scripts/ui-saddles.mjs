/**
 * The compartment call's saddles, one over every sequence or one per sequence (§18.8), in headless
 * Chromium.
 *
 * On the yeast micro-C demo, every sequence ticked under *cis only*, phased by gene density: the
 * form's *Saddle* section with *saddles* at its default, *one over every sequence*, and its two
 * options printed; a run, and the drawer on the one saddle, *Saddle · genome-wide*, its corners and
 * how many sequences the phasing left unsigned, the saddle close up; then *one per sequence* and its
 * run, a saddle a sequence, every figure's heading printed; then the row gone where it is no question
 * — one sequence ticked, and under *cis and trans* — and the pooled saddle in the dark theme. Each
 * step prints what the drawer said.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-saddles.mjs [out-dir]
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
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }

const openTask = async (title) => {
  for (const b of await page.$$('button[title^="Show the Analysis panel"]')) {
    if (await b.isVisible()) { await b.click(); await sleep(800); break }
  }
  // By the column's filter box, which leaves the one row whatever is folded.
  const filter = page.locator('input[placeholder^="filter"][placeholder*="tasks"]').first()
  if (await filter.count()) { await filter.fill(title); await sleep(500) }
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
/** The *saddles* row: whether it is on screen, its value and its options. */
const saddlesRow = () => page.evaluate(() => {
  const label = [...document.querySelectorAll('.analysis-drawer .field-label')].find((n) => n.textContent === 'saddles')
  const field = label?.closest('label, .field, .param-row') ?? label?.parentElement ?? null
  const select = field?.querySelector('select') ?? null
  const visible = field !== null && field.getBoundingClientRect().height > 0 && !field.closest('.hidden')
  return {
    shown: visible,
    value: select?.selectedOptions[0]?.textContent ?? null,
    options: select === null ? [] : [...select.options].map((o) => `${o.textContent} — ${o.title}`),
  }
})
/** Every figure's heading in the drawer, in order. */
const headings = () => page.evaluate(() =>
  [...document.querySelectorAll('.analysis-drawer-body .analysis-figure-head')].map((n) => n.innerText.split('\n')[0]))
const notes = () => page.evaluate(() =>
  (document.querySelector('.analysis-drawer-body')?.innerText ?? '').split('\n').filter((line) => /saddle|phased too weakly|Nothing fixed/i.test(line)))
const scrollTo = (needle) => page.evaluate((needle) => {
  const body = document.querySelector('.analysis-drawer-body')
  const hit = [...(body?.querySelectorAll('*') ?? [])].find((el) => el.childElementCount === 0 && (el.textContent ?? '').includes(needle))
  hit?.scrollIntoView({ block: 'start' })
  // Clear of the drawer's sticky heading, which covers the first lines scrolled to its top.
  let box = hit?.parentElement ?? null
  while (box !== null && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement
  if (box !== null) box.scrollTop -= 48
  return hit !== undefined
}, needle)
/** The figure under a heading, as an element to shoot alone. */
const figure = (title) => page.locator('.analysis-drawer-body .analysis-figure', { has: page.locator('.analysis-figure-head', { hasText: title }) }).first()
/** The stats printed under a figure. */
const stats = (title) => figure(title).evaluate((node) => node.innerText.split('\n').filter((l) => /AA|BB|AB|unphased|phasing r/.test(l)).join(' · ')).catch(() => 'no figure')

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)

  await openTask('Compartments')
  await choose('genes')
  const ticked = await page.evaluate(() => document.querySelector('.analysis-drawer .param-check-count')?.textContent ?? '')
  console.log('sequences:', ticked)
  console.log('saddles row:', JSON.stringify(await saddlesRow(), null, 1))
  await scrollTo('draw the saddle')
  await sleep(400)
  await shot('sd01-form-one-saddle')

  await run('Saddle ·')
  console.log('figures:', JSON.stringify(await headings()))
  console.log('notes:', JSON.stringify(await notes(), null, 1))
  console.log('pooled saddle:', await stats('Saddle · genome-wide'))
  await scrollTo('Saddle · genome-wide')
  await sleep(600)
  await shot('sd02-drawer-one-saddle')
  await figure('Saddle · genome-wide').screenshot({ path: `${OUT}/sd03-one-saddle-close.png` }).then(() => console.log('shot sd03-one-saddle-close'), (e) => console.log('no close-up:', String(e).split('\n')[0]))

  await choose('one per sequence')
  console.log('saddles row:', JSON.stringify(await saddlesRow()))
  await run('Saddle · IV')
  const each = await headings()
  console.log('figures:', JSON.stringify(each))
  console.log('saddles:', each.filter((h) => h.startsWith('Saddle')).length)
  console.log('IV:', await stats('Saddle · IV'))
  await scrollTo('Saddle · I')
  await sleep(600)
  await shot('sd04-drawer-one-per-sequence')

  // Where it is no question: one sequence, and the modes that decompose one square.
  await scrollTo('sequences')
  await page.locator('.analysis-drawer .param-check-actions button', { hasText: /^none$/ }).first().click()
  await sleep(300)
  await page.locator('.analysis-drawer .param-sequences label', { hasText: /^IV/ }).first().click()
  await sleep(500)
  console.log('one sequence ticked:', JSON.stringify(await saddlesRow()))
  await scrollTo('draw the saddle')
  await sleep(400)
  await shot('sd05-form-one-sequence')
  await page.locator('.analysis-drawer .param-check-actions button', { hasText: /^all$/ }).first().click()
  await sleep(300)
  await choose('cis and trans')
  console.log('cis and trans:', JSON.stringify(await saddlesRow()))
  await scrollTo('draw the saddle')
  await sleep(400)
  await shot('sd06-form-cis-and-trans')
  await choose('cis only')
  await choose('one over every sequence')
  console.log('back to cis only:', JSON.stringify(await saddlesRow()))

  // The pooled saddle again, in the dark theme.
  await run('Saddle · genome-wide')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await sleep(1000)
  await scrollTo('Saddle · genome-wide')
  await sleep(600)
  await shot('sd07-one-saddle-dark')
} finally {
  console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors')
  await browser.close()
}
