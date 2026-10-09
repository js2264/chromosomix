/**
 * Drive the reader's marks off and back on across the map, the lanes, the 1D
 * browser and the 3D model in headless Chromium, and write what each step
 * looks like (§8.1, §25.5).
 *
 * Four marks typed on the yeast demo — a vertical line, a horizontal line, an
 * arrowhead off the diagonal and a domain boxed on it — then: one hidden from
 * its row's eye, every mark hidden with `A` and brought back (the one hidden by
 * hand staying hidden), the map's right-click on the vertical line naming it
 * and hiding it, a double-click on an eye showing one mark alone and a second
 * bringing the rest back, the turned map's menu on a V, the 1D browser's menu
 * on its rule, the model coloured by the marks with a key row clicked (the
 * card's eye going dark with it) and the model's own menu on a marked bead,
 * the palette's `Manual annotations` switch, and the dark theme. Prints the
 * card's rows and eyes, every menu's rows, the model's key, and the pixels of
 * each mark's colour on the map and the browser at the steps that change them,
 * so a mark a surface kept drawing is a count in the log that did not drop.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-marks-hide.mjs [out-dir]
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
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * The pointer off every picture, on the status bar: its guide line is drawn
 * over whatever mark it rests on, which would read as a mark gone, and the
 * hover card would sit in the middle of a picture of marks.
 */
const park = async () => { await page.mouse.move(8, 992); await sleep(400) }
const shot = async (name, target = page) => { await target.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}
const manual = () => page.locator('.annotation-card').filter({ has: page.locator('.card-head', { hasText: /Manual annotations/i }) }).first()
const form = (title) => manual().locator('.manual-form').filter({ has: page.locator('.manual-form-title', { hasText: new RegExp(`^${title}$`) }) }).first()

/** The card as the reader reads it: each row's place and eye, and the heading's. */
const card = () =>
  page.evaluate(() => {
    const host = Array.from(document.querySelectorAll('.annotation-card')).find((c) => /Manual annotations/i.test(c.querySelector('.card-head')?.textContent ?? ''))
    if (host === undefined) return null
    return {
      head: {
        note: host.querySelector('.manual-list-note')?.textContent ?? null,
        eye: host.querySelector('.manual-all-eye')?.getAttribute('aria-pressed') ?? null,
        title: host.querySelector('.manual-all-eye')?.getAttribute('title') ?? null,
      },
      rows: Array.from(host.querySelectorAll('.manual-mark')).map((row) => ({
        where: row.querySelector('.manual-where')?.textContent,
        eye: row.querySelector('.ann-eye')?.getAttribute('aria-pressed'),
      })),
    }
  })

/** The open context menu's rows: headings in capitals, then each row and its hint. */
const menu = () =>
  page.evaluate(() => {
    const host = document.querySelector('.context-menu')
    if (host === null) return null
    return Array.from(host.children).map((node) =>
      node.classList.contains('context-menu-head')
        ? `# ${node.textContent}`
        : `${node.querySelector('.context-menu-label, span')?.textContent ?? node.textContent} | ${node.querySelector('.context-menu-hint')?.textContent ?? ''}`,
    )
  })

/** The first of a canvas's columns whose pixels are mostly one colour, in page coordinates. */
const columnOf = (selector, rgb) =>
  page.evaluate(
    ({ selector, rgb }) => {
      const canvas = Array.from(document.querySelectorAll(selector)).find((c) => c.getBoundingClientRect().width > 0)
      if (canvas === undefined) return null
      const ctx = canvas.getContext('2d')
      if (ctx === null) return null
      const { width, height } = canvas
      const data = ctx.getImageData(0, 0, width, height).data
      let best = { x: -1, count: 0 }
      for (let x = 0; x < width; x++) {
        let count = 0
        for (let y = 0; y < height; y++) {
          const at = (y * width + x) * 4
          if (Math.abs(data[at] - rgb[0]) < 6 && Math.abs(data[at + 1] - rgb[1]) < 6 && Math.abs(data[at + 2] - rgb[2]) < 6) count++
        }
        if (count > best.count) best = { x, count }
      }
      const box = canvas.getBoundingClientRect()
      const scale = box.width / width
      return best.x < 0 ? null : { x: box.left + (best.x + 0.5) * scale, count: best.count, top: box.top, height: box.height }
    },
    { selector, rgb },
  )

/**
 * How many pixels of each mark's colour a canvas holds: the four the card's
 * palette gives four marks, in order. Read off the picture itself, so a mark a
 * surface kept drawing after it was hidden is a count that did not drop — the
 * colormap's own near-matches are the floor every count sits on.
 */
const PALETTE = { black: [17, 19, 24], red: [192, 57, 43], blue: [31, 95, 169], green: [15, 138, 95] }
const ink = (selector) =>
  page.evaluate(
    ({ selector, palette }) => {
      const canvas = Array.from(document.querySelectorAll(selector)).find((c) => c.getBoundingClientRect().width > 0)
      const ctx = canvas?.getContext('2d') ?? null
      if (canvas === undefined || ctx === null) return null
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      const out = {}
      for (const [name, rgb] of Object.entries(palette)) {
        let count = 0
        for (let at = 0; at < data.length; at += 4) {
          if (Math.abs(data[at] - rgb[0]) < 6 && Math.abs(data[at + 1] - rgb[1]) < 6 && Math.abs(data[at + 2] - rgb[2]) < 6) count++
        }
        out[name] = count
      }
      return out
    },
    { selector, palette: PALETTE },
  )

/** A pixel of a canvas in one colour, in its upper half, in page coordinates — the arm of a V. */
const inkOf = (selector, rgb) =>
  page.evaluate(
    ({ selector, rgb }) => {
      const canvas = Array.from(document.querySelectorAll(selector)).find((c) => c.getBoundingClientRect().width > 0)
      const ctx = canvas?.getContext('2d') ?? null
      if (canvas === undefined || ctx === null) return null
      const { width, height } = canvas
      const data = ctx.getImageData(0, 0, width, height).data
      const hits = []
      for (let y = Math.floor(height * 0.2); y < Math.floor(height * 0.6); y++) {
        for (let x = 0; x < width; x++) {
          const at = (y * width + x) * 4
          if (Math.abs(data[at] - rgb[0]) < 6 && Math.abs(data[at + 1] - rgb[1]) < 6 && Math.abs(data[at + 2] - rgb[2]) < 6) hits.push([x, y])
        }
      }
      if (hits.length === 0) return null
      const [x, y] = hits[Math.floor(hits.length / 2)]
      const box = canvas.getBoundingClientRect()
      return { x: box.left + (x + 0.5) * (box.width / width), y: box.top + (y + 0.5) * (box.height / height), hits: hits.length }
    },
    { selector, rgb },
  )

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
  await fold('Fold the General panel')
  await fold('Show the Annotations panel')
  await sleep(600)

  // Four marks, typed: a vertical line, a horizontal one, an arrowhead off the
  // diagonal and a domain on it.
  await form('Lines').locator('input.input').first().fill('IV:1,200,000')
  await form('Lines').locator('button', { hasText: /^add$/ }).click()
  await form('Lines').locator('select').selectOption('horizontal')
  await form('Lines').locator('input.input').first().fill('IV:1,330,000')
  await form('Lines').locator('button', { hasText: /^add$/ }).click()
  await form('Arrowheads').locator('input.input').nth(0).fill('IV:1,140,000')
  await form('Arrowheads').locator('input.input').nth(1).fill('IV:1,262,000')
  await form('Arrowheads').locator('button', { hasText: /^add$/ }).click()
  await form('Rectangles').locator('input.input').first().fill('IV:1,040,000-1,110,000')
  await form('Rectangles').locator('button', { hasText: /^add$/ }).click()
  await sleep(1200)
  // The list in view, under the forms.
  await manual().locator('.manual-list-head').scrollIntoViewIfNeeded()
  console.log('four marks:', JSON.stringify(await card()))
  console.log('  map ink:', JSON.stringify(await ink('.heatmap-canvas')))
  await shot('h01-four-marks')
  await shot('h01b-card', manual())

  // The horizontal line hidden from its own row's eye.
  await manual().locator('.manual-mark').nth(1).locator('.ann-eye').click()
  await sleep(1000)
  console.log('one hidden by hand:', JSON.stringify(await card()))
  console.log('  map ink (red gone):', JSON.stringify(await ink('.heatmap-canvas')))
  await shot('h02-one-hidden-by-its-eye')
  await shot('h02b-card', manual())

  // Every mark off with A, from the map.
  await page.locator('.heatmap-canvas').first().hover()
  await page.keyboard.press('a')
  await park()
  console.log('A, every mark off:', JSON.stringify(await card()))
  console.log('  map ink (the colormap alone):', JSON.stringify(await ink('.heatmap-canvas')))
  await shot('h03-a-hides-every-mark')
  await shot('h03b-card', manual())

  // A again: the three it hid come back, the one hidden by hand does not.
  await page.keyboard.press('a')
  await sleep(1000)
  console.log('A again:', JSON.stringify(await card()))
  console.log('  map ink (red still gone):', JSON.stringify(await ink('.heatmap-canvas')))
  await shot('h04-a-brings-back-what-it-hid')

  // The map's right click on the vertical line, found by its ink.
  const line = await columnOf('.heatmap-canvas', [17, 19, 24])
  console.log('vertical line on the map:', JSON.stringify(line))
  if (line !== null) {
    await page.mouse.click(line.x + 1, line.top + line.height * 0.3, { button: 'right' })
    await sleep(500)
    console.log('map menu on the line:', JSON.stringify(await menu()))
    await shot('h05-map-menu-on-the-line')
    await page.locator('.context-menu button', { hasText: /^Hide this line/ }).first().click()
    await park()
    console.log('after Hide this line:', JSON.stringify(await card()))
    await shot('h06-line-hidden-from-the-map')
  }

  // A double-click on the box's eye: that mark alone; another brings the rest back.
  await manual().locator('.manual-mark').nth(3).locator('.ann-eye').dblclick()
  await sleep(1000)
  console.log('rectangle alone:', JSON.stringify(await card()))
  console.log('  map ink (green alone):', JSON.stringify(await ink('.heatmap-canvas')))
  await shot('h07-rectangle-alone')
  await manual().locator('.manual-mark').nth(3).locator('.ann-eye').dblclick()
  await sleep(1000)
  console.log('alone again, the rest back:', JSON.stringify(await card()))
  await shot('h07b-rest-back')

  // Everything back for the pictures that follow.
  for (const index of [0, 1]) {
    const eye = manual().locator('.manual-mark').nth(index).locator('.ann-eye')
    if ((await eye.getAttribute('aria-pressed')) === 'false') await eye.click()
  }
  await sleep(800)
  console.log('all shown:', JSON.stringify(await card()))

  // Turned: the vertical line is a V, and the menu finds it on either arm.
  await page.locator('button[title^="Turn this map 45"]').first().click()
  await sleep(2500)
  const arm = await inkOf('.heatmap-canvas', [17, 19, 24])
  console.log('the V on the turned map:', JSON.stringify(arm))
  if (arm !== null) {
    await page.mouse.click(arm.x, arm.y, { button: 'right' })
    await sleep(500)
    console.log('turned map menu on the V:', JSON.stringify(await menu()))
    await shot('h08-turned-menu-on-the-v')
    await page.keyboard.press('Escape')
  }
  await page.locator('button[title^="Draw this map square"]').first().click()
  await sleep(2000)

  // The 1D browser: the same marks, its menu on the rule.
  await page.locator('.heatmap-canvas').first().hover()
  await page.keyboard.press('v')
  await page.waitForSelector('.browser-canvas', { timeout: 60000 })
  await sleep(3000)
  const rule = await columnOf('.browser-canvas', [17, 19, 24])
  console.log('the rule in the browser:', JSON.stringify(rule))
  if (rule !== null) {
    await page.mouse.click(rule.x, rule.top + rule.height * 0.35, { button: 'right' })
    await sleep(500)
    console.log('browser menu on the rule:', JSON.stringify(await menu()))
    await shot('h09-browser-menu-on-the-rule')
    await page.keyboard.press('Escape')
  }
  await park()
  console.log('  browser ink, every mark drawn:', JSON.stringify(await ink('.browser-canvas')))
  await page.keyboard.press('a')
  await sleep(1000)
  console.log('  browser ink, every mark off:', JSON.stringify(await ink('.browser-canvas')))
  await shot('h09b-browser-marks-off')
  await page.keyboard.press('a')
  await sleep(800)
  await page.locator('.browser-canvas').first().hover()
  await page.keyboard.press('v')
  await page.waitForSelector('.heatmap-canvas', { timeout: 60000 })
  await sleep(3000)

  // The model, coloured by the marks, with the horizontal line hidden on the card.
  await page.evaluate(async (url) => {
    const target = document.querySelector('.structure-card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await sleep(6000)
  await page.click('.structure-frame').catch(() => {})
  await sleep(1500)
  await fold('Show the Aesthetics panel')
  await sleep(800)
  const colourBy = page.locator('.structure-settings .field').filter({ has: page.locator('.field-label', { hasText: /^colour by$/ }) }).first().locator('select')
  await colourBy.selectOption({ label: 'manual annotations' })
  await sleep(1500)
  await manual().locator('.manual-mark').nth(1).locator('.ann-eye').click()
  await sleep(2000)
  const key = () => page.evaluate(() => Array.from(document.querySelectorAll('.deck-structure .structure-key-mark')).map((row) => `${row.querySelector('.structure-key-name')?.textContent}${row.classList.contains('is-off') ? ' (off)' : ''}`))
  console.log('the key with the horizontal line hidden on the card:', JSON.stringify(await key()))
  await shot('h10-model-key-follows-the-card')

  // A key row clicked: the rectangle off the model, the map and the card's eye.
  await page.locator('.deck-structure .structure-key-mark .structure-key-name').nth(3).click()
  await sleep(2000)
  console.log('rectangle hidden from the key:', JSON.stringify(await key()), JSON.stringify(await card()))
  await shot('h11-key-hides-it-everywhere')

  // A bead marked with Shift, then the model's own menu on it.
  const model = await page.locator('.deck-structure canvas').first().boundingBox()
  if (model !== null) {
    const at = { x: model.x + model.width * 0.5, y: model.y + model.height * 0.5 }
    await page.keyboard.down('Shift')
    await page.mouse.click(at.x, at.y)
    await page.keyboard.up('Shift')
    await sleep(1500)
    console.log('a bead marked:', JSON.stringify(await card()))
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await sleep(600)
    console.log('model menu on the marked bead:', JSON.stringify(await menu()))
    await shot('h12-model-menu-on-a-marked-bead')
    await page.keyboard.press('Escape')
  }

  // The palette's switch, and the dark theme.
  await page.keyboard.press('Control+p')
  await sleep(500)
  await page.keyboard.type('manual')
  await sleep(500)
  await shot('h13-palette-switch')
  await page.keyboard.press('Escape')
  await sleep(300)
  await page.locator('.heatmap-canvas').first().hover()
  await page.keyboard.press('t')
  await sleep(1500)
  await shot('h14-dark')
  await shot('h14b-dark-card', manual())

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
