/**
 * What the capture scripts of the 2D analysis pages share: a headless Chromium
 * on the dev server at 1440 × 900 and twice the pixel density, in the light
 * theme, and the handles the repository's own galleries (`scripts/ui-*.mjs`)
 * drive a task by — the Analysis column, a task's row, its form, **run** and the
 * wait for what it returns.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/<task>.cjs <out-dir>
 *
 * The demo maps are read from the dev server, which serves the repository's
 * `demo/` folder; the maps only the lab's bucket holds are read from it, the
 * browser sent through `HTTPS_PROXY` where one is set (the dev server, on the
 * loopback, never is). The pictures are written as PNGs into `<out-dir>`; turn
 * one into a page's picture with `webp.mjs` beside this file.
 */

const { chromium } = require('playwright')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

const BASE = process.env.SCREENS_BASE ?? 'http://127.0.0.1:5173'
/** The repository's `demo/` folder, as the dev server serves it. */
const DEMO = `${BASE}/demo/`
/** The lab's bucket, which holds the demo folder and the maps too big to ship. */
const BUCKET = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A workspace (or any small file) served from this process on a port of its
 * own, with CORS, so a link can open it as `?config=…` — a session that says
 * what a reader would have set by hand (a circle and its origin, a track
 * loaded beside the map) without writing into the repository the dev server
 * serves. Resolves to the server and the address of each path.
 */
function serveFiles(files) {
  const http = require('node:http')
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const body = files[decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\//, ''))]
    if (body === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'application/json')
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range !== null && !(range[1] === '' && range[2] === '')) {
      const start = range[1] === '' ? Math.max(0, bytes.length - Number(range[2])) : Number(range[1])
      const end = range[1] === '' || range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1)
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 })
      res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
      return
    }
    res.writeHead(200, { 'Content-Length': bytes.length })
    res.end(req.method === 'HEAD' ? undefined : bytes)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const urls = Object.fromEntries(Object.keys(files).map((path) => [path, `http://127.0.0.1:${port}/${path}`]))
      resolve({ server, urls })
    })
  })
}

/**
 * A browser and a page, and the helpers bound to them.
 *
 * `drawer` is the analysis drawer's width in CSS pixels, written where the app
 * keeps the width a reader dragged it to, so that a map can be seen beside it;
 * without it the drawer opens at its default, three quarters of the window.
 */
async function start(out, { width = 1440, height = 900, drawer = null } = {}) {
  mkdirSync(out, { recursive: true })
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      // Chromium's own flag rather than Playwright's `proxy`, which would send
      // the loopback, and so the dev server, through the proxy too.
      ...(proxy ? [`--proxy-server=${proxy}`] : []),
    ],
  })
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    acceptDownloads: true,
  })
  if (drawer !== null) {
    await context.addInitScript((px) => {
      try {
        localStorage.setItem('chromosomix:analysis-drawer:width', String(px))
      } catch {
        /* no storage: the default width */
      }
    }, drawer)
  }
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  /** The whole window, or `clip` of it (CSS pixels), as `<out>/<name>.png`. */
  const shot = async (name, clip) => {
    await page.screenshot({ path: join(out, `${name}.png`), ...(clip ? { clip } : {}) })
    console.log(`wrote ${name}.png`)
  }

  /** Every map's veil down, after a draw has had time to start. */
  const settled = async (timeout = 240000) => {
    await sleep(1500)
    await page
      .waitForFunction(
        () => [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
        null,
        { timeout },
      )
      .catch(() => console.log('a map was still veiled'))
    await sleep(1500)
  }

  /** Open an address of the app and wait for its first map to be drawn. */
  const open = async (address, { wait = 6000 } = {}) => {
    await page.goto(address.startsWith('http') ? address : `${BASE}/${address}`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    })
    await page.waitForSelector('.heatmap-canvas', { timeout: 240000 })
    await settled()
    await sleep(wait)
  }

  /** Press the first visible button whose title starts with `title`. */
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

  /** The drawer put away, if it is open. */
  const closeDrawer = async () => {
    const close = page.locator('.analysis-drawer:not(.collapsed) .analysis-drawer-head .btn-close').first()
    if (await close.isVisible().catch(() => false)) {
      await close.click()
      await sleep(1000)
    }
  }

  /** A task's drawer, by its row's title. */
  const openTask = async (title) => {
    await closeDrawer()
    await fold('Show the Analysis panel')
    const row = page.locator('.analysis-row-title', { hasText: new RegExp(`^${title}$`) }).first()
    await row.scrollIntoViewIfNeeded({ timeout: 15000 })
    await row.click()
    await sleep(1500)
  }

  const computed = () =>
    page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')

  /**
   * Press **run** (or **run on ★** on a deck) and wait for the record line to
   * change and the drawer to hold `marker`.
   */
  const run = async (marker, { timeout = 900000 } = {}) => {
    const before = await computed()
    await page.locator('.analysis-drawer button', { hasText: /^run(\s+on)?\s*$/i }).first().click()
    const done = await page
      .waitForFunction(
        ({ before, marker }) => {
          const text = document.querySelector('.analysis-drawer-body')?.innerText ?? ''
          const now = text.match(/computed in [^\n]*/)?.[0] ?? ''
          return now !== '' && now !== before && text.includes(marker)
        },
        { before, marker },
        { timeout },
      )
      .then(() => true)
      .catch(() => false)
    if (!done) console.log('the run did not finish:', marker)
    await sleep(2500)
    return done
  }

  /** Type a locus into the breadcrumb's box and wait for the map. */
  const goTo = async (locus) => {
    const box = page.locator('input.input-region').first()
    await box.fill(locus)
    await box.press('Enter')
    await settled()
    await sleep(1500)
  }

  /** Choose the option whose words include `text` in the drawer's select that offers it. */
  const choose = async (text) => {
    const select = page
      .locator('.analysis-drawer select')
      .filter({ has: page.locator('option', { hasText: text }) })
      .first()
    if (!(await select.count())) {
      console.log('no select offers', text)
      return false
    }
    const label = await select.locator('option', { hasText: text }).first().textContent()
    await select.selectOption({ label: label ?? text })
    await sleep(700)
    return true
  }

  /** The form's field whose label is `label`. */
  const field = (label) =>
    page
      .locator('.analysis-form .field')
      .filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) })
      .first()

  /** A number typed into the field whose label holds `label`. */
  const setNumber = async (label, value) => {
    const box = page.locator('.analysis-form .field', { hasText: label }).locator('input[type=number]').first()
    await box.fill(String(value))
    await box.press('Enter')
    await sleep(700)
  }

  /**
   * Scroll the drawer's body so the element holding `text` (in `selector`)
   * stands at its top. Asked again until it stays there: the figures lay
   * themselves out once they are near the screen, and a body scrolled before
   * they have grown is clamped short of where they end up.
   */
  const scrollDrawerTo = async (selector, text, offset = 8) => {
    let ok = false
    for (let attempt = 0; attempt < 8; attempt++) {
      const off = await page.evaluate(
        ({ selector, text, offset }) => {
          const body = document.querySelector('.analysis-drawer-body')
          const target = [...document.querySelectorAll(`.analysis-drawer ${selector}`)].find((n) =>
            (n.textContent ?? '').includes(text),
          )
          if (!body || !target) return null
          const delta = target.getBoundingClientRect().top - body.getBoundingClientRect().top - offset
          body.scrollTop += delta
          return Math.abs(delta)
        },
        { selector, text, offset },
      )
      if (off === null) break
      ok = true
      await sleep(700)
      if (off < 2) break
    }
    await sleep(600)
    return ok
  }

  /** The bounding box of the first element matching `selector`, in CSS pixels. */
  const box = (selector) =>
    page.evaluate((s) => {
      const node = document.querySelector(s)
      if (!node) return null
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }, selector)

  /**
   * The box round each map on screen and the lanes beside it, with its heading
   * when `title` is set, grown by `pad` and kept inside the window: the clip of
   * a picture about a map and what a task put beside it.
   */
  const mapClip = async ({ pad = 10, title = true, index = 0 } = {}) =>
    page.evaluate(
      ({ pad, title, index }) => {
        const canvases = [...document.querySelectorAll('.heatmap-canvas')].filter((c) => c.offsetParent !== null)
        const canvas = canvases[index]
        if (!canvas) return null
        const panel = canvas.closest('.panel') ?? canvas.parentElement
        const parts = [canvas, ...panel.querySelectorAll('.lane-canvas')].filter(
          (n) => n.offsetParent !== null && n.getBoundingClientRect().width > 0,
        )
        if (title) {
          const head = panel.querySelector('.panel-title')
          if (head && head.offsetParent !== null) parts.push(head)
        }
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
        for (const n of parts) {
          const r = n.getBoundingClientRect()
          x0 = Math.min(x0, r.left)
          y0 = Math.min(y0, r.top)
          x1 = Math.max(x1, r.right)
          y1 = Math.max(y1, r.bottom)
        }
        x0 = Math.max(0, Math.floor(x0 - pad))
        y0 = Math.max(0, Math.floor(y0 - pad))
        x1 = Math.min(window.innerWidth, Math.ceil(x1 + pad))
        y1 = Math.min(window.innerHeight, Math.ceil(y1 + pad))
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      },
      { pad, title, index },
    )

  /** Every side column folded but the ones named, so the map has the room. */
  const foldColumns = async (keep = []) => {
    for (const name of ['General', 'Annotations', 'Aesthetics', 'Analysis']) {
      if (!keep.includes(name)) await fold(`Fold the ${name} panel`)
    }
    await settled()
  }

  /**
   * In the form's list of sequences, only `names` ticked: its *none* pressed,
   * then each name's box.
   */
  const tickOnly = async (names, label = 'sequences') => {
    const list = field(label)
    const none = list.locator('button', { hasText: /^none$/ }).first()
    if (await none.count()) {
      await none.click()
      await sleep(400)
    }
    for (const name of names) {
      const ok = await list.evaluate((node, name) => {
        for (const row of node.querySelectorAll('label.param-check')) {
          const box = row.querySelector('input[type=checkbox]')
          if (box && row.querySelector('span')?.textContent === name) {
            if (!box.checked) box.click()
            return true
          }
        }
        return false
      }, name)
      if (!ok) console.log('no box for', name)
      await sleep(300)
    }
    await sleep(500)
  }

  /**
   * Every lane the same size, `px` across, from the Aesthetics column's Tracks
   * card (its *track height*), as a reader widens a lane to read it.
   */
  const trackHeight = async (px) => {
    await fold('Show the Aesthetics panel')
    const box = page.locator('.field', { hasText: 'track height' }).locator('input.input-step').first()
    await box.scrollIntoViewIfNeeded()
    await box.fill(String(px))
    await box.press('Enter')
    await sleep(1200)
    await settled()
  }

  /** The price beside run, or the refusal in its place. */
  const price = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.analysis-drawer .analysis-cost, .analysis-drawer .analysis-refusal')]
        .map((n) => n.textContent.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .join(' | '),
    )

  /** The drawer's notes, as printed under the run. */
  const notes = () =>
    page.$$eval('.analysis-drawer .analysis-notes li', (all) => all.map((n) => n.textContent.trim()))

  /** The headings of the drawer's figures. */
  const figures = () =>
    page.$$eval('.analysis-drawer .analysis-figure-head', (all) => all.map((n) => n.textContent.trim()))

  const close = async () => {
    console.log(errors.length ? `page errors:\n${errors.slice(0, 20).join('\n')}` : 'no page errors')
    await browser.close()
  }

  return {
    browser,
    context,
    page,
    errors,
    shot,
    settled,
    open,
    fold,
    closeDrawer,
    openTask,
    run,
    goTo,
    choose,
    field,
    setNumber,
    scrollDrawerTo,
    box,
    mapClip,
    foldColumns,
    tickOnly,
    trackHeight,
    price,
    notes,
    figures,
    close,
  }
}

module.exports = { BASE, DEMO, BUCKET, sleep, serveFiles, start }
