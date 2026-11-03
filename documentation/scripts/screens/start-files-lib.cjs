/**
 * What the capture scripts for the Getting started and Your files pages share
 * (`start-*.cjs`, `files-*.cjs` beside this one): a Chromium that reaches the
 * world through this machine's proxy, a window of 1440 × 900 at twice its
 * density in the light theme, the stores read from the deployed site (the dev
 * server has no `stores/`), and the waits a picture needs before it is taken —
 * the map drawn, the requests landed.
 *
 * Each script drives the real app (`npm run dev -- --host 127.0.0.1 --port
 * 5173`) and writes raw PNGs into the folder named on its command line; the
 * pictures the pages use are made from them by `webp.mjs`.
 */

const { chromium } = require('playwright')
const { existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const SITE = 'https://chromosomix.app/stores/'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Chromium, with the proxy as its own flag so that the dev server stays direct. */
async function launch() {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  const executablePath =
    browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
  return chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    args: [
      ...(proxy === undefined ? [] : [`--proxy-server=${proxy}`]),
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
}

/**
 * The published site's own registrations with Google and Dropbox, read from
 * its page: what its build is given as `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`
 * and `DROPBOX_APP_KEY` (`src/config/siteDefaults.ts`). None is a secret —
 * every visitor's browser is served them — and the dev server is started
 * without them, so its landing page offers two of the four ways to connect a
 * folder that chromosomix.app offers.
 */
async function publishedKeys(context) {
  const page = await (await context.request.get('https://chromosomix.app/')).text()
  const script = page.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1]
  if (script === undefined) throw new Error('no bundle on the published page')
  const bundle = await (await context.request.get(`https://chromosomix.app${script}`)).text()
  const pick = (key) => bundle.match(new RegExp(`${key}:[A-Za-z_$][\\w$]*\\("([^"]*)"\\)`))?.[1] ?? ''
  return {
    __GOOGLE_CLIENT_ID__: pick('googleClientId'),
    __GOOGLE_API_KEY__: pick('googleApiKey'),
    __DROPBOX_APP_KEY__: pick('dropboxAppKey'),
  }
}

/**
 * A fresh window: its own storage, so nothing a previous run kept (a folded
 * panel, a store left open, the dark theme) leaks into the picture. With
 * `published`, the dev build is served the published site's keys, as its
 * build would be given them.
 */
async function newWindow(browser, out, { width = 1440, height = 900, scale = 2, published = false } = {}) {
  mkdirSync(out, { recursive: true })
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: 'light' })
  await context.route(`${BASE}/stores/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.replace(/^.*\/stores\//, '')
    await route.fulfill({ response: await route.fetch({ url: `${SITE}${name}` }) })
  })
  if (published) {
    const keys = await publishedKeys(context)
    // In dev, the build's defines reach the page as globals set by this module.
    await context.route(`${BASE}/@vite/env`, async (route) => {
      const response = await route.fetch()
      let body = await response.text()
      for (const [key, value] of Object.entries(keys)) {
        body = body.replace(`"${key}": ""`, `"${key}": ${JSON.stringify(value)}`)
      }
      await route.fulfill({ response, body })
    })
  }
  // No save dialog: an export arrives as a plain download.
  await context.addInitScript(() => {
    window.showSaveFilePicker = undefined
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300))
  })
  let inFlight = 0
  page.on('request', () => inFlight++)
  page.on('requestfinished', () => inFlight--)
  page.on('requestfailed', () => inFlight--)

  /** No request on its way for a second and a half, or `ms`. */
  const quiet = async (ms = 60000) => {
    let idle = 0
    const until = Date.now() + ms
    while (Date.now() < until && idle < 6) {
      await sleep(250)
      idle = inFlight <= 0 ? idle + 1 : 0
    }
  }
  /** The tab has opened its file: a map, the browser or an error, and nothing still "Opening". */
  const opened = async (ms = 180000) => {
    await page.waitForFunction(
      () =>
        !document.body.textContent.includes('Opening ') &&
        document.querySelector('.heatmap-canvas, .browser-canvas, .view-error, .tviewport') !== null,
      null,
      { timeout: ms },
    )
    await quiet()
    await sleep(1500)
  }
  /** Every row of the Tracks card read: none still reading, loading or reopening. */
  const tracksRead = async (count = 1, ms = 180000) => {
    await page
      .waitForFunction(
        (n) => {
          const rows = [...document.querySelectorAll('.annotation-card .ann-row')]
          return rows.length >= n && rows.every((row) => !/reading|loading|reopening/i.test(row.textContent ?? ''))
        },
        count,
        { timeout: ms },
      )
      .catch(() => console.log('  tracks still reading'))
  }
  /** The first *visible* button whose title starts with `title`. */
  const fold = async (title) => {
    for (const b of await page.$$(`button[title^="${title}"]`)) {
      if (await b.isVisible()) {
        await b.click()
        await sleep(700)
        return true
      }
    }
    return false
  }
  /**
   * Files fetched in the page and dropped on the first `selector` whose text
   * holds `text` (any, without it), as a reader drops them from a file
   * manager: the click road opens a picker the page cannot answer.
   */
  const drop = async (selector, urls, text = '') => {
    await page.evaluate(
      async ({ selector, urls, text }) => {
        const files = []
        for (const url of urls) {
          const bytes = await (await fetch(url)).arrayBuffer()
          files.push(new File([bytes], url.split('/').pop(), { type: 'application/octet-stream' }))
        }
        const target = [...document.querySelectorAll(selector)].find((node) => (node.textContent ?? '').includes(text))
        if (target === undefined) throw new Error(`nothing to drop on: ${selector} ${text}`)
        const transfer = new DataTransfer()
        for (const file of files) transfer.items.add(file)
        for (const type of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
        }
      },
      { selector, urls, text },
    )
  }
  const shot = async (name, options = {}) => {
    await page.mouse.move(2, 450).catch(() => {})
    await sleep(300)
    await page.screenshot({ path: join(out, `${name}.png`), ...options })
    console.log(`shot ${name}`)
  }
  return { context, page, errors, quiet, opened, tracksRead, fold, drop, shot }
}

/** The box of an element, in CSS pixels, or `null`. */
const box = (page, selector) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect()
    return r === undefined ? null : { x: r.left, y: r.top, width: r.width, height: r.height }
  }, selector)

module.exports = { BASE, sleep, launch, newWindow, box }
