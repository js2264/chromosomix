/**
 * What the capture scripts for the Browse, Command line, Embed and Advanced
 * pages share: a headless Chromium on the dev server at 1440 × 900 and twice
 * the density, in the light theme, and the waits that make a picture a
 * finished one.
 *
 * The wait is the app's own: every finished picture is announced on `window`
 * as `chromosomix:rendered` (src/perf/rendered.ts), counted from 1, so a step
 * that changes the picture waits for a report after the last one it saw.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/<page>.cjs [out-dir]
 *
 * Each script writes raw PNGs to `out-dir`; `webp.mjs` beside this file turns
 * the chosen ones into the pages' pictures.
 */

const { chromium } = require('playwright')
const { mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const BASE = (process.env.SCREENS_BASE ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
const BUCKET = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * A browser and a page. `mac` makes the page read as a Mac's (`navigator.platform`),
 * so the keys it names are the ones the pages name first (⌥, ⌘).
 */
async function start(out, { width = 1440, height = 900, mac = false, init = null } = {}) {
  const dir = resolve(out ?? 'screens')
  mkdirSync(dir, { recursive: true })
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  })
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    acceptDownloads: true,
  })
  await context.addInitScript((mac) => {
    window.__reports = []
    window.addEventListener('chromosomix:rendered', (event) => window.__reports.push(event.detail))
    if (mac) Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' })
  }, mac)
  if (init !== null) await context.addInitScript(init)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300))
  })

  /** The last report's number, 0 before the first. */
  const seen = () => page.evaluate(() => window.__reports.at(-1)?.seq ?? 0)

  /** Wait for a finished picture after report `after`, then let the paint settle. */
  async function rendered(after = 0, { timeout = 180000, settle = 1200 } = {}) {
    await page.waitForFunction((after) => window.__reports.some((r) => r.seq > after), after, { timeout })
    // A report can be followed by another as a lane lands; take the quiet one.
    for (let i = 0; i < 20; i++) {
      const n = await seen()
      await sleep(500)
      if ((await seen()) === n) break
    }
    await sleep(settle)
    return page.evaluate(() => window.__reports.at(-1))
  }

  /** Go to an address of the app and wait for its picture. */
  async function open(address, options = {}) {
    await page.goto(address.startsWith('http') ? address : `${BASE}/${address.replace(/^\//, '')}`)
    return rendered(0, options)
  }

  /** Do something that changes the picture, and wait for it to be drawn again. */
  async function redraw(action, options = {}) {
    const before = await seen()
    await action()
    return rendered(before, options)
  }

  async function shot(name, options = {}) {
    const path = join(dir, `${name}.png`)
    await page.screenshot({ path, ...options })
    console.log('shot', name)
    return path
  }

  /** The first visible button whose title starts so: a folded column's button and its strip's are two. */
  async function press(title) {
    for (const b of await page.$$(`button[title^="${title}"]`)) {
      if (await b.isVisible()) {
        await b.click()
        await sleep(600)
        return true
      }
    }
    console.log('  (no visible button titled', title, ')')
    return false
  }

  /** A command from the palette, by the words typed into it. */
  async function palette(words) {
    await page.keyboard.press(mac ? 'Meta+p' : 'Control+p')
    await sleep(400)
    await page.keyboard.type(words)
    await sleep(500)
    await page.keyboard.press('Enter')
    await sleep(900)
  }

  /** A box round an element, in CSS pixels, widened by `pad` and kept inside the window. */
  async function around(selector, pad = 0) {
    const box = await page.locator(selector).first().boundingBox()
    if (box === null) throw new Error(`nothing at ${selector}`)
    const x = Math.max(0, box.x - pad)
    const y = Math.max(0, box.y - pad)
    return {
      x,
      y,
      width: Math.min(width - x, box.width + 2 * pad),
      height: Math.min(height - y, box.height + 2 * pad),
    }
  }

  async function close() {
    if (errors.length > 0) console.log('page errors:\n  ' + errors.slice(0, 12).join('\n  '))
    await browser.close()
  }

  return { browser, context, page, dir, errors, seen, rendered, open, redraw, shot, press, palette, around, close }
}

module.exports = { BASE, BUCKET, sleep, start }
