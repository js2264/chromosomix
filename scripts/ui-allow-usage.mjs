/**
 * Drive *allow access* (§5.6, §8.6) and the usage counts (§31) in headless
 * Chromium, and shoot both.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-allow-usage.mjs [out-dir]
 *
 * **allow** (on the dev server). A headless browser cannot be restarted with a
 * grant waiting, so two stand-ins, in an init script, as the saves gallery
 * stands in for the save dialog: a dropped file's handle is the real
 * `FileSystemFileHandle` of a copy written to the origin-private file system,
 * and the permission a handle answers with is read from a key this script sets —
 * everything granted while the files are first opened, and after the "restart"
 * each file asks first until its own `requestPermission`, which grants that file
 * alone. So the map's button is pressed, the map opens, and its track — a file of
 * its own, still asking — shows the row's button, which is pressed in turn. The
 * yeast cooler and its ATAC bigWig, from `demo/yeast/`: aa01 … aa04.
 *
 * **usage** (on a build). The counts are sent only by the site's own build at
 * the site's own address, so this builds the site with `USAGE_ENDPOINT` set
 * (into the out-dir, under its policy), serves it as `https://chromosomix.app/`
 * by routing that origin to the files, and catches every request to the
 * endpoint instead of sending it — printing each body and its headers and
 * failing if one carries a file's name or a cookie, or if any arrives after the
 * switch is turned off. The landing page's note, a map and a track dropped, P(s)
 * run, a file refused, About with the switch on and off: uc01 … uc04, and
 * `usage-counts.json` beside them.
 *
 * `GALLERY_ONLY=allow` or `usage` runs one part.
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
const ENDPOINT = 'https://plausible.io/api/event'
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
 * app's prefix: `granted` while the files are first opened, anything else after
 * the "restart", where each file asks until its own request.
 */
const STAND_INS = () => {
  if (typeof window.showOpenFilePicker !== 'function') {
    window.showOpenFilePicker = async () => {
      throw new DOMException('no dialog here', 'AbortError')
    }
  }
  const allowed = new Set()
  const everything = () => window.localStorage.getItem('gallery:permission') === 'granted'
  FileSystemHandle.prototype.queryPermission = async function () {
    return everything() || allowed.has(this.name) ? 'granted' : 'prompt'
  }
  FileSystemHandle.prototype.requestPermission = async function () {
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
  await page
    .waitForFunction(() => document.querySelector('.ann-row.ann-ready') !== null, null, { timeout: 60000 })
    .catch(async (err) => {
      await page.screenshot({ path: `${OUT}/debug-track-drop.png` })
      console.log('page errors:', errors)
      console.log(
        await page.evaluate(() => {
          const hit = [...document.querySelectorAll('*')].filter((node) => /16 sequences/.test(node.textContent ?? '') && node.children.length < 3)
          return hit.map((node) => `${node.tagName}.${node.className} < ${node.parentElement?.className} < ${node.parentElement?.parentElement?.className}`).slice(0, 5)
        }),
      )
      throw err
    })
  await sleep(4000)

  // The restart: a reload with every grant asking first.
  await page.evaluate(() => window.localStorage.setItem('gallery:permission', 'prompt'))
  await page.reload()
  const asked = page.locator('button', { hasText: /^allow access to / })
  await asked.waitFor({ timeout: 60000 })
  await sleep(1500)
  const note = await page.locator('.allow-asked').first().innerText()
  console.log('the picker asks:', JSON.stringify(note))
  if (!/only needs your permission/.test(note)) fail('the picker does not say the browser remembers the file')
  await shot('aa01-asked-after-a-restart')

  await asked.click()
  await mapDrawn(page)
  await sleep(4000)
  await fold(page, 'Show the Annotations panel')
  await sleep(1500)
  const row = await page.evaluate(() => {
    const allow = [...document.querySelectorAll('.ann-detached button')].find((b) => b.textContent === 'allow access')
    return {
      summary: document.body.innerText.match(/remembered file — allow access to draw it again/)?.[0] ?? null,
      button: allow !== undefined,
    }
  })
  console.log('the track, still asking:', JSON.stringify(row))
  if (!row.button) fail('the detached track offers no allow access')
  await shot('aa02-map-allowed-track-asking')
  const card = await page.locator('.ann-detached').first().evaluate((node) => {
    const box = (node.closest('.card') ?? node).getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 420) }
  })
  await shot('aa03-track-row-asking', card)

  await page.locator('.ann-detached button', { hasText: /^allow access$/ }).first().click()
  await page.waitForFunction(() => document.querySelector('.ann-detached') === null, null, { timeout: 60000 })
  await sleep(4000)
  console.log('the track, allowed: detached rows left =', await page.locator('.ann-detached').count())
  await shot('aa04-track-allowed')
  if (errors.length > 0) console.log('page errors:', errors)
  await context.close()
}

// ---------------------------------------------------------------------------
// usage counts
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

async function usagePart() {
  const dist = join(OUT, 'dist-usage')
  console.log('building the site with USAGE_ENDPOINT set…')
  execSync(`npx vite build --outDir ${JSON.stringify(dist)} --emptyOutDir`, {
    stdio: 'inherit',
    env: { ...process.env, USAGE_ENDPOINT: ENDPOINT },
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
  await shot('uc01-landing-note')

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
  await page.waitForSelector('.about-usage')
  await page.locator('.about-usage').scrollIntoViewIfNeeded()
  await sleep(800)
  console.log('About:', JSON.stringify(await page.locator('.about-usage').innerText()))
  // Idle sends: give the page its moment to post what it queued.
  await sleep(12000)
  await shot('uc02-about-counting')
  await page.locator('.about-usage .btn-toggle').click()
  await sleep(500)
  console.log('switch after a press:', await page.locator('.about-usage .btn-toggle').getAttribute('aria-pressed'))
  await shot('uc03-about-off')
  const off = Date.now()
  await page.keyboard.press('Escape')
  await sleep(600)

  // Countable things done with the switch off: none may go out.
  await page.keyboard.press('o')
  await page.waitForSelector('.dropzone')
  await drop(page, `/demo/yeast/${COOLER}`, COOLER, '.dropzone')
  await page.waitForFunction(() => /Yeast_microC_G2M_1kb\.cool/.test(window.location.hash), null, { timeout: 120000 })
  await sleep(13000)
  await shot('uc04-counting-off')

  const bodies = counts.map((count) => count.body)
  writeFileSync(join(OUT, 'usage-counts.json'), `${JSON.stringify(counts, null, 2)}\n`)
  console.log(`${counts.length} counts caught:`)
  for (const count of counts) console.log(' ', JSON.stringify(count.body), '· cookie', count.cookie, '· referer', count.referer)
  const text = JSON.stringify(bodies)
  if (/Yeast|patient|secret|demo|\.cool|\.bw/i.test(text)) fail('a count carries a file name')
  if (counts.some((count) => count.cookie !== null || count.referer !== null)) fail('a count carried a cookie or a referrer')
  if (counts.some((count) => count.at > off + 1000)) fail('a count went out with the switch off')
  for (const name of ['pageview', 'open', 'task', 'error']) {
    if (!bodies.some((body) => body?.name === name)) fail(`no ${name} count was caught`)
  }
  if (refusals.length > 0) console.log('policy refusals:', refusals)
  await context.close()
}

try {
  if (ONLY === '' || ONLY === 'allow') await allowPart()
  if (ONLY === '' || ONLY === 'usage') await usagePart()
} finally {
  await browser.close()
}
if (failed) process.exitCode = 1
