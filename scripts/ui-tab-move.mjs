/**
 * Carry tabs along the strip in headless Chromium, and write what each step
 * looks like (§5.6).
 *
 * Four tabs — the yeast micro-C demo, its Hi-C, the E. coli map and an empty
 * one, the second in front — then: the first carried and held past the third,
 * the row closed up behind it and a gap where it would land; let go there, the
 * tab in front still in front; one carried and Escape pressed, the strip as it
 * was; the palette's *Move this tab* pair, *left* greyed on the first tab, and
 * *right* run; a reload, the order kept and the empty tab, which names no
 * file, not remembered; the dark theme, mid-carry; a phone's width with tabs
 * enough to overflow the strip, which scrolls as a tab is held at its end. Prints
 * the strip's order after each step, with the tab in front marked ▸ and a tab
 * remembered but not read marked ~, so a tab that went the wrong way is a line
 * in the log.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-tab-move.mjs [out-dir]
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
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })
const errors = []
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The header and the strip, which is what this is about, down to a little past
 * the strip's foot wherever a narrow window's header has pushed it; `whole` for
 * the window.
 */
const shot = async (name, whole = false) => {
  const viewport = page.viewportSize()
  const foot = (await page.locator('.tabstrip').boundingBox()).y + 70
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    ...(whole ? {} : { clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, foot) } }),
  })
  console.log('shot', name)
}
const strip = () =>
  page.$$eval('.tabstrip .tab', (nodes) =>
    nodes.map((node) =>
      (node.getAttribute('aria-selected') === 'true' ? '▸' : '') +
      (node.classList.contains('is-pending') ? '~' : '') +
      (node.querySelector('.tab-label')?.textContent ?? ''),
    ),
  )
const log = async (what) => console.log(`${what}:`, (await strip()).join(' | '))
const tabBox = async (index) => (await page.locator('.tabstrip .tab').nth(index).boundingBox())

/** Press tab `index` by its label, carry it in steps to `x`, and — unless told to hold — let go. */
const carry = async (index, x, { hold = false } = {}) => {
  // By the label, which is the tab: on a tab squeezed to a letter its middle
  // is the ×, which closes rather than carries.
  const box = await page.locator('.tabstrip .tab-label').nth(index).boundingBox()
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  const from = box.x + box.width / 2
  for (let step = 1; step <= 16; step++) {
    await page.mouse.move(from + ((x - from) * step) / 16, y)
    await sleep(15)
  }
  if (!hold) await page.mouse.up()
  await sleep(200)
}

const openByUrl = async (url) => {
  await page.keyboard.press('o')
  await sleep(400)
  await page.fill('input.input-url', url)
  await page.press('input.input-url', 'Enter')
  await sleep(2500)
}

await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`)
await page.waitForSelector('.tabstrip .tab', { timeout: 30000 })
await sleep(5000)
await openByUrl(`${BASE}/demo/yeast/Yeast_hic.hic`)
await openByUrl(`${BASE}/demo/ecoli/Ecoli.mcool`)
await page.keyboard.press('o')
await sleep(600)
// The Hi-C tab in front: the second of four.
await page.locator('.tabstrip .tab-label').nth(1).click()
await sleep(2500)
await log('four tabs')
console.log('tooltip:', JSON.stringify(await page.locator('.tabstrip .tab-label').nth(0).getAttribute('title')))
await shot('tm01-four-tabs', true)

// The first carried past the third's middle and held: the row closes up
// behind it, and the gap ahead of the empty tab is where it will land.
const third = await tabBox(2)
await carry(0, third.x + third.width * 0.75, { hold: true })
await log('held past the third')
await shot('tm02-held')
await page.mouse.up()
await sleep(400)
await log('let go')
await shot('tm03-dropped')

// One carried to the start and Escape pressed before letting go.
const first = await tabBox(0)
await carry(3, first.x + 5, { hold: true })
await log('the empty tab held at the start')
await shot('tm04-held-to-start')
await page.keyboard.press('Escape')
await sleep(200)
await page.mouse.up()
await sleep(300)
await log('Escape')
await shot('tm05-escape')

// The palette's pair, the keyboard's road.
await page.keyboard.press('Control+p')
await sleep(400)
await page.keyboard.type('move this tab')
await sleep(400)
await shot('tm06-palette', true)
// The tab in front is first, so *left* is greyed and *right* is the one to run.
await page.keyboard.press('Backspace')
await page.keyboard.type('b right')
await sleep(300)
await page.keyboard.press('Enter')
await sleep(400)
await log('palette: Move this tab right')
await shot('tm07-palette-moved')

// A reload brings the strip back in the order it was left in.
await page.reload()
await page.waitForSelector('.tabstrip .tab', { timeout: 30000 })
await sleep(3500)
await log('after a reload')
await shot('tm08-reloaded')

// Dark, mid-carry.
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await sleep(300)
const last = await tabBox((await page.locator('.tabstrip .tab').count()) - 1)
await carry(0, last.x + last.width * 0.6, { hold: true })
await shot('tm09-dark-held')
await page.mouse.up()
await sleep(300)
await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
await log('dark, let go at the end')

// A phone's width and as many tabs as it takes for the strip to be longer
// than the row — tabs shrink to a letter before they overflow, so it takes
// most of the twelve: a tab held near the row's end scrolls it.
await page.setViewportSize({ width: 400, height: 700 })
await sleep(600)
const overflows = () => page.$eval('.tabstrip .tabs', (node) => node.scrollWidth > node.clientWidth)
for (let more = 0; more < 9 && !(await overflows()); more++) {
  await page.keyboard.press('o')
  await sleep(300)
}
await page.locator('.tabstrip .tabs').evaluate((node) => { node.scrollLeft = 0 })
await sleep(200)
const row = await page.locator('.tabstrip .tabs').boundingBox()
const scroll = () => page.$eval('.tabstrip .tabs', (node) => `${node.scrollLeft}/${node.scrollWidth - node.clientWidth}`)
console.log('narrow: scroll before', await scroll())
await shot('tm10-narrow')
await carry(0, row.x + row.width - 4, { hold: true })
await sleep(900)
console.log('narrow: scroll while held at the end', await scroll())
await shot('tm11-narrow-held-at-end')
await page.mouse.up()
await sleep(300)
await log('narrow, let go at the end')

console.log(errors.length === 0 ? 'no page errors' : `errors:\n${errors.join('\n')}`)
await browser.close()
