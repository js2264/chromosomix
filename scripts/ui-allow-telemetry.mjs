/**
 * Drive *allow access* (§5.6, §8.6) and the telemetry (§31) in headless
 * Chromium, and shoot both.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-allow-telemetry.mjs [out-dir]
 *
 * **allow** (on the dev server). A headless browser cannot be restarted with a
 * grant waiting, so two stand-ins, in an init script, as the saves gallery
 * stands in for the save dialog: a dropped file's handle is the real
 * `FileSystemFileHandle` of a copy written to the origin-private file system,
 * and the permission a handle answers with is read from a key this script sets —
 * everything granted while the files are first opened, and after the "restart"
 * each file asks first until its own `requestPermission`. The yeast cooler and
 * its ATAC bigWig, from `demo/yeast/`. First a browser that grants whatever it is
 * asked: the picker's button counts both files, and one press must bring back
 * the map *and* its track (aa01, aa02). Then a browser that grants one file a
 * click, as one would whose activation is spent by the first prompt: the map
 * back, its track's row still asking, and its own button pressed (aa03 … aa05).
 *
 * **telemetry** (on a build). It is sent only by the site's own build at
 * the site's own address, so this builds the site with `TELEMETRY_ENDPOINT` and
 * `TELEMETRY_WEBSITE` set — Umami Cloud's endpoint and a made-up website id
 * (into the out-dir, under its policy), serves it as `https://chromosomix.app/`
 * by routing that origin to the files, and catches every request to the
 * endpoint instead of sending it — printing each body and its headers and
 * failing if one carries a file's name or a cookie, or if any arrives after the
 * switch is turned off. The landing page's note, a map and a track dropped, P(s)
 * run, a file refused, About with the switch on and off: te01 … te04, and
 * `telemetry.json` beside them.
 *
 * `GALLERY_ONLY=allow` or `telemetry` runs one part.
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

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

const OUT = resolve(process.argv[2] ?? 'gallery')
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const ONLY = process.env.GALLERY_ONLY ?? ''
const SITE = 'https://chromosomix.app'
const ENDPOINT = 'https://cloud.umami.is/api/send'
/** A website id of the right shape, filed nowhere: every request to the endpoint is caught. */
const WEBSITE = '4fb3a1c2-6d0e-4b7a-9c35-1e2f3a4b5c6d'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const fail = (message) => {
  failed = true
  console.log('FAIL', message)
}

/** The first visible button with that title, pressed. */
async function fold(page, title) {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}

/** A file fetched in the page and dropped on the first element matching `selector` (and `text`). */
async function drop(page, url, name, selector, text = null) {
  await page.evaluate(
    async ({ url, name, selector, text }) => {
      const bytes = await (await fetch(url)).arrayBuffer()
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], name))
      const zone = [...document.querySelectorAll(selector)].find(
        (node) => text === null || new RegExp(text).test(node.textContent ?? ''),
      )
      if (zone === undefined) throw new Error(`nothing to drop ${name} on: ${selector}`)
      for (const kind of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
    },
    { url, name, selector, text },
  )
}

const mapDrawn = (page) =>
  page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )

/**
 * A dropped cooler lands on its Chromosomes table; the map is a region of it,
 * asked for through the address as a link would.
 */
async function toRegion(page) {
  await page.waitForFunction(() => /Yeast_microC_G2M_1kb\.cool/.test(window.location.hash), null, { timeout: 120000 })
  await sleep(1000)
  await page.evaluate(() => {
    window.location.hash = '#uri=Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000001-1400000'
  })
  await mapDrawn(page)
}

const COOLER = 'Yeast_microC_G2M_1kb.cool'
const ATAC = 'Yeast_ATAC.bw'

// ---------------------------------------------------------------------------
// allow access
// ---------------------------------------------------------------------------

/**
 * The two stand-ins. `gallery:permission` is this script's own key, outside the
 * app's prefix: `granted` while the files are first opened; after the "restart",
 * `prompt` — each file asks until it is requested, and every request is granted
 * — or `one-per-click`, where a click buys one grant and every further request
 * in it answers `prompt`, as a browser whose activation the first prompt spent.
 */
const STAND_INS = () => {
  if (typeof window.showOpenFilePicker !== 'function') {
    window.showOpenFilePicker = async () => {
      throw new DOMException('no dialog here', 'AbortError')
    }
  }
  const allowed = new Set()
  const mode = () => window.localStorage.getItem('gallery:permission')
  let budget = 0
  document.addEventListener('click', () => (budget = 1), true)
  FileSystemHandle.prototype.queryPermission = async function () {
    return mode() === 'granted' || allowed.has(this.name) ? 'granted' : 'prompt'
  }
  FileSystemHandle.prototype.requestPermission = async function () {
    if (mode() === 'one-per-click') {
      if (budget === 0) return 'prompt'
      budget -= 1
    }
    allowed.add(this.name)
    return 'granted'
  }
  DataTransferItem.prototype.getAsFileSystemHandle = function () {
    const file = this.getAsFile()
    if (file === null) return Promise.resolve(null)
    return navigator.storage.getDirectory().then((root) => root.getFileHandle(file.name))
  }
}

async function allowPart() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  await context.addInitScript(STAND_INS)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const shot = async (name, clip) => {
    await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip === undefined ? {} : { clip }) })
    console.log('shot', name)
  }

  await page.goto(BASE)
  await page.waitForSelector('.dropzone')
  // The copies the handles point at, in the origin-private file system.
  await page.evaluate(
    async (names) => {
      const root = await navigator.storage.getDirectory()
      for (const name of names) {
        const bytes = await (await fetch(`/demo/yeast/${name}`)).arrayBuffer()
        const writable = await (await root.getFileHandle(name, { create: true })).createWritable()
        await writable.write(bytes)
        await writable.close()
      }
      window.localStorage.setItem('gallery:permission', 'granted')
    },
    [COOLER, ATAC],
  )

  // Opened as a reader would: the map dropped, then its track.
  await drop(page, `/demo/yeast/${COOLER}`, COOLER, '.dropzone')
  await toRegion(page)
  await sleep(2000)
  await fold(page, 'Show the Annotations panel')
  await drop(page, `/demo/yeast/${ATAC}`, ATAC, '.ann-drop', 'Load a track')
  await page.waitForFunction(() => document.querySelector('.ann-row.ann-ready') !== null, null, { timeout: 60000 })
  await sleep(4000)

  /** The detached rows on the Tracks card, and whether each offers its own button. */
  const detached = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.ann-detached')].map((node) => ({
        text: node.textContent?.replace(/\s+/g, ' ').trim(),
        allow: [...node.querySelectorAll('button')].some((b) => b.textContent === 'allow access'),
      })),
    )

  // The restart: a reload with every grant asking first, in a browser that
  // grants whatever it is asked.
  await page.evaluate(() => window.localStorage.setItem('gallery:permission', 'prompt'))
  await page.reload()
  const asked = page.locator('button', { hasText: /^allow access to / })
  await asked.waitFor({ timeout: 60000 })
  await sleep(1500)
  const note = await page.locator('.allow-asked').first().innerText()
  console.log('the picker asks:', JSON.stringify(note), '· tooltip:', JSON.stringify(await asked.getAttribute('title')))
  if (!/all 2 files/.test(note)) fail('the button does not count both remembered files')
  await shot('aa01-asked-after-a-restart')

  // One press: the map and its track.
  await asked.click()
  await mapDrawn(page)
  await fold(page, 'Show the Annotations panel')
  await page.waitForFunction(() => document.querySelector('.ann-row.ann-ready') !== null, null, { timeout: 60000 })
  await sleep(4000)
  const afterOne = await detached()
  console.log('after one press, detached rows:', JSON.stringify(afterOne))
  if (afterOne.length !== 0) fail('one press left a track waiting')
  await shot('aa02-one-press-everything-back')

  // Another restart, in a browser that grants one file a click.
  await page.evaluate(() => window.localStorage.setItem('gallery:permission', 'one-per-click'))
  await page.reload()
  await asked.waitFor({ timeout: 60000 })
  await sleep(1000)
  await asked.click()
  await mapDrawn(page)
  await fold(page, 'Show the Annotations panel')
  await page.waitForFunction(() => document.querySelector('.ann-detached') !== null, null, { timeout: 60000 })
  await sleep(2500)
  const still = await detached()
  console.log('one file a click, the track still asking:', JSON.stringify(still))
  if (!still.some((row) => row.allow)) fail('the detached track offers no allow access')
  await shot('aa03-one-per-click-track-asking')
  const card = await page.locator('.ann-detached').first().evaluate((node) => {
    const box = (node.closest('.card') ?? node).getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 420) }
  })
  await shot('aa04-track-row-asking', card)

  await page.locator('.ann-detached button', { hasText: /^allow access$/ }).first().click()
  await page.waitForFunction(() => document.querySelector('.ann-detached') === null, null, { timeout: 60000 })
  await sleep(4000)
  console.log('the track, allowed: detached rows left =', (await detached()).length)
  await shot('aa05-track-allowed')
  if (errors.length > 0) console.log('page errors:', errors)
  await context.close()
}

// ---------------------------------------------------------------------------
// telemetry
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
}

async function telemetryPart() {
  const dist = join(OUT, 'dist-telemetry')
  console.log('building the site with TELEMETRY_ENDPOINT and TELEMETRY_WEBSITE set…')
  execSync(`npx vite build --outDir ${JSON.stringify(dist)} --emptyOutDir`, {
    stdio: 'inherit',
    env: { ...process.env, TELEMETRY_ENDPOINT: ENDPOINT, TELEMETRY_WEBSITE: WEBSITE },
  })

  // Service workers blocked: they would fetch around the routing below.
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  })
  // A real reader's browser says it is not automated; this one has to be told to.
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true })
  })
  const counts = []
  await context.route(`${ENDPOINT}*`, async (route) => {
    const request = route.request()
    const headers = await request.allHeaders()
    counts.push({ at: Date.now(), body: JSON.parse(request.postData() ?? 'null'), cookie: headers.cookie ?? null, referer: headers.referer ?? null })
    await route.fulfill({ status: 202, body: 'ok' })
  })
  await context.route(`${SITE}/**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    const file = path.startsWith('/demo/')
      ? join(process.cwd(), path)
      : join(dist, path === '/' || extname(path) === '' ? 'index.html' : path)
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'not found' })
    await route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } })
  })
  const page = await context.newPage()
  const refusals = []
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) refusals.push(m.text())
  })
  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${name}.png` })
    console.log('shot', name)
  }

  await page.goto(`${SITE}/`)
  await page.waitForSelector('.dropzone')
  await sleep(1500)
  console.log('the privacy note:', JSON.stringify(await page.locator('.privacy-text').first().innerText()))
  await shot('te01-landing-note')

  await drop(page, `/demo/yeast/${COOLER}`, COOLER, '.dropzone')
  await toRegion(page)
  await sleep(2000)
  await fold(page, 'Show the Annotations panel')
  await drop(page, `/demo/yeast/${ATAC}`, ATAC, '.ann-drop', 'Load a track')
  await sleep(4000)
  await fold(page, 'Show the Analysis panel')
  await page.locator('text=Contact probability P(s)').first().click()
  await sleep(1200)
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(() => document.querySelector('.analysis-drawer .figure-chart svg') !== null, null, { timeout: 180000 })
  await sleep(2000)
  // A file refused, in a tab of its own.
  await page.keyboard.press('o')
  await page.waitForSelector('.dropzone')
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['not a contact map at all\n'], 'patient_04_secret.cool'))
    const zone = document.querySelector('.dropzone')
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      zone?.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  })
  await sleep(4000)

  await page.click('button[title="About this viewer"]')
  await page.waitForSelector('.about-telemetry')
  await page.locator('.about-telemetry').scrollIntoViewIfNeeded()
  await sleep(800)
  console.log('About:', JSON.stringify(await page.locator('.about-telemetry').innerText()))
  // Idle sends: give the page its moment to post what it queued.
  await sleep(12000)
  await shot('te02-about-on')
  await page.locator('.about-telemetry .btn-toggle').click()
  await sleep(500)
  console.log('switch after a press:', await page.locator('.about-telemetry .btn-toggle').getAttribute('aria-pressed'))
  await shot('te03-about-off')
  const off = Date.now()
  await page.keyboard.press('Escape')
  await sleep(600)

  // Countable things done with the switch off: none may go out.
  await page.keyboard.press('o')
  await page.waitForSelector('.dropzone')
  await drop(page, `/demo/yeast/${COOLER}`, COOLER, '.dropzone')
  await page.waitForFunction(() => /Yeast_microC_G2M_1kb\.cool/.test(window.location.hash), null, { timeout: 120000 })
  await sleep(13000)
  await shot('te04-sending-nothing')

  const bodies = counts.map((count) => count.body)
  writeFileSync(join(OUT, 'telemetry.json'), `${JSON.stringify(counts, null, 2)}\n`)
  console.log(`${counts.length} counts caught:`)
  for (const count of counts) console.log(' ', JSON.stringify(count.body), '· cookie', count.cookie, '· referer', count.referer)
  const text = JSON.stringify(bodies)
  if (/Yeast|patient|secret|demo|\.cool|\.bw/i.test(text)) fail('a count carries a file name')
  if (counts.some((count) => count.cookie !== null || count.referer !== null)) fail('a count carried a cookie or a referrer')
  if (counts.some((count) => count.at > off + 1000)) fail('a count went out with the switch off')
  // Umami's shape: a nameless payload is the visit, every other count by its name.
  const named = (name) => bodies.some((body) => (name === 'pageview' ? body?.payload?.name === undefined : body?.payload?.name === name))
  for (const name of ['pageview', 'open', 'task', 'error']) {
    if (!named(name)) fail(`no ${name} count was caught`)
  }
  if (bodies.some((body) => body?.type !== 'event' || body?.payload?.website !== WEBSITE || body?.payload?.url !== '/')) {
    fail('a count is not in the shape Umami takes')
  }
  if (refusals.length > 0) console.log('policy refusals:', refusals)
  await context.close()
}

try {
  if (ONLY === '' || ONLY === 'allow') await allowPart()
  if (ONLY === '' || ONLY === 'telemetry') await telemetryPart()
} finally {
  await browser.close()
}
if (failed) process.exitCode = 1
