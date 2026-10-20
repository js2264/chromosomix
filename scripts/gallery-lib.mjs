/**
 * What the stage's galleries share (`ui-edit*.mjs`): a headless Chromium on the
 * dev server, a screenshot that says it was written, and the stage's own
 * handles — its map's box and axis, a sequence's cells, a drag in steps, the
 * wait for the suggestions to be counted again.
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A path or an address with the dev features asked for (§29): `?config=…` → `?dev&config=…`. */
export function withDev(address) {
  const at = address.indexOf('?')
  if (at === -1) {
    const hash = address.indexOf('#')
    return hash === -1 ? `${address}?dev` : `${address.slice(0, hash)}?dev${address.slice(hash)}`
  }
  return `${address.slice(0, at)}?dev&${address.slice(at + 1)}`
}

/** A browser, a page at the gallery's size, and the helpers bound to it. */
export async function gallery(out, { width = 1600, height = 1000 } = {}) {
  const { chromium } = playwright()
  const base = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
  mkdirSync(out, { recursive: true })
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  const executablePath =
    browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
  const browser = await chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  })
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const shot = async (name) => {
    await page.screenshot({ path: join(out, `${name}.png`) })
    console.log(`wrote ${name}.png`)
  }
  const text = (selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector)
  const history = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.edit-history-row')].map(
        (row) => `${row.classList.contains('is-current') ? '▸' : row.classList.contains('is-undone') ? '·' : ' '} ${row.textContent}`,
      ),
    )
  async function mapBox() {
    return page.evaluate(() => {
      const canvas = document.querySelector('.edit-overlay')
      const r = canvas.getBoundingClientRect()
      const [x0, x1, y0, y1] = (canvas.dataset.view ?? '0 1 0 1').split(' ').map(Number)
      return { left: r.left, top: r.top, width: r.width, height: r.height, x0, x1, y0, y1, n: Number(canvas.dataset.cells) }
    })
  }
  const at = (box, ux, uy) => ({
    x: box.left + ((ux - box.x0) / (box.x1 - box.x0)) * box.width,
    y: box.top + ((uy - box.y0) / (box.y1 - box.y0)) * box.height,
  })
  async function cellsOf(name) {
    return page.evaluate((wanted) => {
      for (const button of document.querySelectorAll('.edit-sequence')) {
        if (button.querySelector('.edit-sequence-name')?.textContent === wanted) return button.dataset.cells.split(' ').map(Number)
      }
      return null
    }, name)
  }
  async function drag(from, to, steps = 12, hold = null) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let k = 1; k <= steps; k++) {
      await page.mouse.move(from.x + ((to.x - from.x) * k) / steps, from.y + ((to.y - from.y) * k) / steps)
      await sleep(25)
    }
    if (hold !== null) await hold()
    await page.mouse.up()
    await sleep(400)
  }
  async function settled() {
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      const weighing = await page.evaluate(() => /weighing|placing/.test(document.querySelector('.edit-suggestions-card .edit-card-head')?.textContent ?? ''))
      if (!weighing) break
    }
    await sleep(300)
  }
  const suggestions = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.edit-suggestion-main')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()),
    )
  async function openStage() {
    await page.click('.crumb-reference-button')
    for (let i = 0; i < 480; i++) {
      await sleep(500)
      if (await page.evaluate(() => document.querySelector('.edit-status')?.classList.contains('hidden'))) break
    }
    await sleep(800)
  }
  /** The app at a config, with the dev features on and no edit kept from before. */
  async function openWithDev(path) {
    await page.goto(`${base}/`)
    await page.evaluate(() => {
      sessionStorage.clear()
      for (const key of Object.keys(localStorage)) if (key.includes(':map:edit')) localStorage.removeItem(key)
    })
    await page.goto(`${base}/${withDev(path)}`)
    await page.reload()
  }
  async function close() {
    if (errors.length > 0) console.log('page errors:', errors)
    await browser.close()
  }
  return { base, browser, page, errors, shot, text, history, mapBox, at, cellsOf, drag, settled, suggestions, openStage, openWithDev, close }
}
