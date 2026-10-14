/**
 * Drive a built page under its Content-Security-Policy, and refuse it if the
 * policy refused anything.
 *
 * The build checks hold the policy to the page that carries it (`csp.mjs`,
 * `*-shape.mjs`): one policy, ahead of what it governs, and no inline script or
 * `style=` for it to refuse. What they cannot see is what the page does once it
 * runs. A chart library that writes its tooltip with `style=` attributes passes
 * every one of them, and then has its styling refused seven hundred times a
 * hover — with nothing on screen to say so but a box of bare text. A browser is
 * the only place that shows, so this drives one:
 *
 *   npx vite build && node scripts/ui-csp.mjs site [out-dir]
 *   npm run build:standalone && node scripts/ui-csp.mjs standalone [out-dir]
 *
 * **The site** is served the way GitHub Pages serves it — static files, byte
 * ranges, no header of ours — with `demo/` beside it, and `demo/` once more on a
 * second origin with a bucket's CORS headers. It opens the yeast micro-C map
 * from its URL hash, runs P(s) and the cis/trans task and hovers every chart
 * they draw, and opens the 1D browser on the ATAC bigWig through `?config=`
 * from the second origin, which is the page's own `connect-src` to the loopback
 * at work. Then three controls, so that a pass means the policy is there and
 * not merely that nothing was tried: Google's sign-in script is let through, a
 * stranger's is refused, and an inline event handler injected into the page is
 * refused before it runs.
 *
 * **The single file** is opened from the disk (`file://`), has the same map
 * and bigWig dropped on it — it has no network, and its policy says so — and is
 * put through the same map, figures and hovers. Its controls are the ones its
 * own policy is for: an injected inline handler is refused, and a fetch to the
 * loopback is refused both in the page and in a worker built from a blob, which
 * inherits the page's policy where the site's workers, being files, have none —
 * refused before it leaves the browser, which a server counting what reaches it
 * is the witness to.
 *
 * Either way it fails on any violation the controls did not cause — in the page
 * or in any of its workers, which raise their own — on any console error or
 * page error, and on a map or a track canvas left without its data: a policy
 * that refused the reader would pass the first two and fail the third.
 * Screenshots go to `out-dir` (default `gallery-csp/`), one per step.
 *
 * Playwright is resolved from the global install when it is not a dev
 * dependency (`npm root -g`), and Chromium from PLAYWRIGHT_BROWSERS_PATH, as
 * the galleries do (`ui-gallery.mjs`).
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WEB_CSP, cspOf } from './csp.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODE = process.argv[2]
const OUT = process.argv[3] ?? 'gallery-csp'
if (MODE !== 'site' && MODE !== 'standalone') {
  console.error('usage: node scripts/ui-csp.mjs site|standalone [out-dir]')
  process.exit(2)
}

const require = createRequire(import.meta.url)
function playwright() {
  try {
    return require('playwright')
  } catch {
    return require(join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
}

// ---------------------------------------------------------------------------
// A static host, as Pages is one
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/**
 * Serve directories under URL prefixes, with byte ranges and nothing else.
 *
 * No header of ours on any response, which is the point: the page's meta is
 * the only policy there is, as on Pages. A `.gz` goes out as the bytes it is,
 * since that is what the site does and what a bgzipped track needs.
 */
function serve(mounts, { cors = false } = {}) {
  const ordered = Object.entries(mounts).sort(([a], [b]) => b.length - a.length)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://host')
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Range, Authorization, Content-Type')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
      if (req.method === 'OPTIONS') return void res.writeHead(204).end()
    }
    const mount = ordered.find(([prefix]) => url.pathname.startsWith(prefix))
    if (mount === undefined) return void res.writeHead(404).end()
    const [prefix, dir] = mount
    let file = normalize(join(dir, decodeURIComponent(url.pathname.slice(prefix.length))))
    if (relative(dir, file).startsWith('..')) return void res.writeHead(403).end()
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html')
      statSync(file)
    } catch {
      return void res.writeHead(404).end()
    }
    const size = statSync(file).size
    res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
    res.setHeader('Accept-Ranges', 'bytes')
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range !== null) {
      const start = range[1] === '' ? size - Number(range[2]) : Number(range[1])
      const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)
      if (start > end || start >= size) return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
      if (req.method === 'HEAD') return void res.end()
      return void createReadStream(file, { start, end }).pipe(res)
    }
    res.writeHead(200, { 'Content-Length': size })
    if (req.method === 'HEAD') return void res.end()
    createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

// ---------------------------------------------------------------------------
// The browser, and what it is listened to for
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true })
const { chromium } = playwright()
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Everything a page said that a reader would not see. */
const heard = { console: [], pageErrors: [] }

/**
 * The workers each page has running, each listened to for its own refusals.
 *
 * A refusal inside a worker is fired at the worker, not at the document, so
 * the page's listener never hears it, and nothing reaches the page's console
 * either. In the single file that is where the policy matters most — a worker
 * built from a blob inherits it — and where it was first wrong: the bigWig
 * reader fetches its own wasm from a `data:` URL, the first standalone policy
 * refused that, and the lane said "fetching…" for good with no error anywhere.
 * The listener goes in as soon as the worker exists, through the DevTools
 * protocol rather than the page; a refusal raised before it is in, or in a
 * worker that ends before it is read, is left to the drawing checks below.
 */
const workersOf = new WeakMap()

/**
 * A page that records every policy violation it raises, from its first byte.
 *
 * The listener is an init script so that a refusal during the parse — a
 * misplaced meta, a refused stylesheet — is heard, not only those after load.
 */
async function newPage() {
  const page = await context.newPage()
  const workers = new Set()
  workersOf.set(page, workers)
  await page.addInitScript(() => {
    window.__violations = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__violations.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        source: event.sourceFile,
        line: event.lineNumber,
      })
    })
  })
  page.on('console', (message) => {
    if (message.type() === 'error') heard.console.push(message.text())
  })
  page.on('pageerror', (error) => heard.pageErrors.push(String(error)))
  page.on('worker', (worker) => {
    workers.add(worker)
    worker.on('close', () => workers.delete(worker))
    worker
      .evaluate(() => {
        self.__violations = []
        self.addEventListener('securitypolicyviolation', (event) => {
          self.__violations.push({
            directive: event.effectiveDirective,
            blocked: event.blockedURI,
            source: event.sourceFile,
            line: event.lineNumber,
          })
        })
      })
      .catch(() => {})
    worker.on('console', (message) => {
      if (message.type() === 'error') heard.console.push(`worker: ${message.text()}`)
    })
  })
  return page
}

const violationsOf = (page) => page.evaluate(() => window.__violations ?? [])

/** The refusals each running worker has heard since it was last asked, marked as a worker's. */
async function workerViolationsOf(page) {
  const found = []
  for (const worker of workersOf.get(page) ?? []) {
    const held = await worker.evaluate(() => (self.__violations ?? []).splice(0)).catch(() => [])
    found.push(...held.map((one) => ({ ...one, inWorker: true })))
  }
  return found
}

const shot = async (page, name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  console.log(`  wrote ${name}.png`)
}

/**
 * Pixels on the first sized canvas that are neither blank nor white — or, with
 * `coloured`, that carry a colour rather than a grey.
 *
 * Read off a copy, because the app's canvases are 2D and same-origin and a
 * copy is the one read that works on all of them. A map the reader never
 * filled is white throughout; a refused worker leaves exactly that. The track
 * canvas is not white when its data is missing: the ruler, the ideogram, the
 * lane names and their "fetching…" are drawn first, in greys, and come to
 * thirty thousand inked pixels with not one lane drawn. The data is drawn in
 * each lane's colour, so that is what is counted there.
 */
function inkOn(page, selector, coloured) {
  return page.evaluate(
    ([wanted, chroma]) => {
      const canvas = [...document.querySelectorAll(wanted)].find((one) => one.width > 0 && one.height > 0)
      if (canvas === undefined) return 0
      const copy = document.createElement('canvas')
      copy.width = canvas.width
      copy.height = canvas.height
      const ctx = copy.getContext('2d')
      ctx.drawImage(canvas, 0, 0)
      const data = ctx.getImageData(0, 0, copy.width, copy.height).data
      let inked = 0
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
        if (data[i + 3] === 0 || (r > 250 && g > 250 && b > 250)) continue
        if (chroma && Math.max(r, g, b) - Math.min(r, g, b) <= 60) continue
        inked++
      }
      return inked
    },
    [selector, coloured === true],
  )
}

/** The steps, and what each found. */
const report = []
const problems = []

async function step(page, name, run) {
  const before = (await violationsOf(page)).length
  let found
  try {
    found = await run()
  } catch (error) {
    problems.push(`${name}: ${String(error).split('\n')[0]}`)
    found = { error: String(error).split('\n')[0] }
  }
  // A worker's are read whenever a step ends, and so belong to the step in
  // which they were raised or to the next one, never to none.
  const raised = [...(await violationsOf(page)).slice(before), ...(await workerViolationsOf(page))]
  report.push({ name, found, violations: raised.length })
  console.log(`${name}: ${JSON.stringify(found)} — ${raised.length} violation(s)`)
  for (const violation of raised) {
    const where = violation.inWorker ? ' in a worker' : ''
    problems.push(
      `${name}: the policy refused ${violation.directive} ${violation.blocked}${where} (${violation.source}:${violation.line})`,
    )
  }
  return found
}

// ---------------------------------------------------------------------------
// What both targets do
// ---------------------------------------------------------------------------

/**
 * Wait until a canvas carries at least `enough` inked pixels, and say how many.
 *
 * Polled rather than read once: a map's blocks arrive one read at a time, and
 * the moment its view mounts is not the moment it is drawn. A canvas still
 * without its data after the wait is the failure this looks for.
 */
async function drawn(page, selector, enough, what, coloured = false) {
  await page.waitForFunction((wanted) => document.querySelector(wanted) !== null, selector, { timeout: 180_000 })
  let ink = 0
  for (const started = Date.now(); Date.now() - started < 90_000; await sleep(1000)) {
    ink = await inkOn(page, selector, coloured)
    if (ink >= enough) return { [coloured ? 'coloured' : 'inked']: ink }
  }
  throw new Error(`${what} ${coloured ? 'have no data drawn' : 'is blank'} (${ink} ${coloured ? 'coloured' : 'inked'} pixels)`)
}

const mapDrawn = (page) => drawn(page, '.heatmap-canvas', 10_000, 'the map')
/**
 * The tracks, by the colour their data is drawn in. `enough` sits between what
 * each case draws with every lane in and with its bigWig lanes refused, as
 * measured in this viewport. The yeast tracks workspace: some 50,000 coloured
 * pixels with the Analysis column open and 79,000 with it shut, against 16,000
 * refused — the intervals and the names' swatches — at the wider of the two.
 * One bigWig dropped alone: 2,600 and 3,700, against 144 refused, which is its
 * name's swatch.
 */
const tracksDrawn = (page, enough) => drawn(page, 'canvas.browser-canvas', enough, 'the tracks', true)

/** Show the Analysis column, if it is folded. */
async function analysisOpen(page) {
  for (const button of await page.$$('button[title^="Show the Analysis panel"]')) {
    if (await button.isVisible()) {
      await button.click()
      await sleep(800)
      return
    }
  }
}

/** Run a task by its title and wait for a chart to land. */
async function runTask(page, title, landed) {
  await page.keyboard.press('Escape')
  await sleep(500)
  await page.locator(`text=${title}`).first().click()
  await sleep(900)
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(landed, null, { timeout: 180_000 })
  await sleep(2500)
}

/**
 * Hover every chart on the page, and say what each tooltip read.
 *
 * The reason this script exists: the tooltip is the one markup the page hands
 * to another library's `innerHTML`, and the one place a `style=` crept in.
 */
async function hoverCharts(page, name) {
  const charts = page.locator('.figure-chart')
  const count = await charts.count()
  const said = []
  for (let at = 0; at < count; at++) {
    const chart = charts.nth(at)
    await chart.scrollIntoViewIfNeeded()
    await sleep(400)
    const box = await chart.boundingBox()
    if (box === null) continue
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45, { steps: 8 })
    await sleep(900)
    // The library's box is a child of the chart it belongs to; the last chart's
    // may still be fading out, so it is looked for in this one alone.
    said.push(
      await chart.evaluate((node) => {
        const tip = [...node.querySelectorAll(':scope > div')].find(
          (div) => div.style.zIndex === '9999999' && getComputedStyle(div).display !== 'none',
        )
        return tip?.textContent?.slice(0, 80) ?? null
      }),
    )
    await shot(page, `${name}-${at + 1}`)
  }
  if (!said.some((text) => text !== null && text !== '')) throw new Error('no tooltip showed on any chart')
  return { charts: count, tooltips: said }
}

async function figures(page, prefix) {
  await analysisOpen(page)
  await step(page, 'P(s), hovered', async () => {
    await runTask(page, 'Contact probability P(s)', () => document.querySelector('.figure-chart svg') !== null)
    return hoverCharts(page, `${prefix}-ps`)
  })
  await step(page, 'cis and trans, every chart hovered', async () => {
    await runTask(page, 'Cis and trans per sequence', () => document.querySelectorAll('.figure-chart svg').length >= 2)
    return hoverCharts(page, `${prefix}-cistrans`)
  })
}

// ---------------------------------------------------------------------------
// The site
// ---------------------------------------------------------------------------

async function site() {
  const dist = join(ROOT, 'dist')
  const index = readFileSync(join(dist, 'index.html'), 'utf8')
  if (cspOf(index)[0] !== WEB_CSP) throw new Error('dist/index.html does not carry the web policy — run `npx vite build`')
  const host = await serve({ '/': dist, '/demo/': join(ROOT, 'demo') })
  const bucket = await serve({ '/demo/': join(ROOT, 'demo') }, { cors: true })
  try {
    const page = await newPage()
    const demo = `${host.origin}/demo`

    await step(page, 'the map, from its hash', async () => {
      await page.goto(`${host.origin}/#uri=${demo}/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000`)
      const carried = await page.evaluate(
        () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null,
      )
      if (carried !== WEB_CSP) throw new Error('the page in the browser carries no policy, or another one')
      const drawn = await mapDrawn(page)
      await shot(page, 'site-map')
      return drawn
    })
    await figures(page, 'site')

    await step(page, 'the service worker, registered from the page', async () => {
      const scope = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration()
        return registration?.scope ?? null
      })
      if (scope === null) throw new Error('no service worker registered')
      return { scope }
    })

    const tracks = await newPage()
    await step(tracks, 'the 1D browser, from a workspace on a second origin', async () => {
      // `?config=` is fetched by the page itself, so this is its `connect-src`
      // reaching the loopback on another port; the files the workspace names
      // are read by the workers, from the same second origin.
      await tracks.goto(`${host.origin}/?config=${bucket.origin}/demo/yeast/Yeast_tracks.chromosomix.json`)
      const drawn = await tracksDrawn(tracks, 25_000)
      await shot(tracks, 'site-browser')
      return drawn
    })

    const consoleBefore = heard.console.length
    await step(tracks, 'the controls', async () => {
      const found = await tracks.evaluate(async () => {
        const load = (src) =>
          new Promise((resolve) => {
            const script = document.createElement('script')
            script.src = src
            script.onload = () => resolve('loaded')
            script.onerror = () => resolve('failed')
            document.head.appendChild(script)
            setTimeout(() => resolve('timed out'), 10_000)
          })
        const google = await load('https://accounts.google.com/gsi/client')
        const stranger = await load('https://example.invalid/x.js')
        const host = document.createElement('div')
        host.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="window.__ran = 1" onerror="window.__ran = 1">'
        document.body.appendChild(host)
        await new Promise((resolve) => setTimeout(resolve, 600))
        host.remove()
        return { google, stranger, handlerRan: window.__ran === 1 }
      })
      const raised = (await violationsOf(tracks)).slice(-8)
      const refused = (pattern, directive) =>
        raised.some((one) => one.directive === directive && pattern.test(`${one.blocked} ${one.source}`))
      if (refused(/accounts\.google\.com\/gsi\/client$/, 'script-src-elem')) throw new Error('Google’s sign-in script was refused')
      if (!refused(/example\.invalid/, 'script-src-elem')) throw new Error('a stranger’s script was not refused')
      if (found.handlerRan || !refused(/inline/, 'script-src-attr')) throw new Error('an injected inline handler ran')
      return found
    })
    // The controls raise their refusals on purpose — the stranger, the handler,
    // and the button styles Google's script writes inline when it loads (see
    // `csp.mjs`) — so they are taken off the books here, once the console has
    // caught up with them.
    await sleep(1500)
    problems.splice(0, problems.length, ...problems.filter((one) => !one.startsWith('the controls: the policy refused')))
    heard.console.splice(consoleBefore)
  } finally {
    host.close()
    bucket.close()
  }
}

// ---------------------------------------------------------------------------
// The single file
// ---------------------------------------------------------------------------

/**
 * Drop files on the landing page's drop zone, as a reader drags them there.
 *
 * Not through a file input: Chromium has the picker that yields a grant, so
 * the page never builds one (`ui/chooseFiles.ts`). An input of this script's
 * own is filled instead — Playwright hands it paths, not megabytes — and the
 * `File`s it holds are dropped where a reader would drop them. Hidden by its
 * attribute rather than a `style=`, which this page's policy would refuse.
 */
async function dropFiles(page, paths) {
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    input.id = 'ui-csp-files'
    document.body.append(input)
  })
  await page.setInputFiles('#ui-csp-files', paths)
  await page.evaluate(() => {
    const input = document.getElementById('ui-csp-files')
    const transfer = new DataTransfer()
    for (const file of input.files) transfer.items.add(file)
    const zone = document.querySelector('.dropzone')
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    input.remove()
  })
}

async function standalone() {
  const file = join(ROOT, 'dist-standalone', 'index.html')
  if (!existsSync(file)) throw new Error('dist-standalone/index.html is missing — run `npm run build:standalone`')
  const demo = join(ROOT, 'demo', 'yeast')

  const page = await newPage()
  await step(page, 'the map, dropped on the page', async () => {
    await page.goto(`file://${file}`)
    await page.waitForSelector('.dropzone', { timeout: 30_000 })
    await dropFiles(page, [join(demo, 'Yeast_microC_G2M_1kb.cool')])
    await page.waitForFunction(() => /uri=/.test(location.hash), null, { timeout: 60_000 })
    // The same region the site opens, by the hash a dropped file is named in.
    await page.evaluate(() => {
      const uri = new URLSearchParams(location.hash.slice(1)).get('uri')
      location.hash = `#uri=${encodeURIComponent(uri)}&view=region&region=IV:1000000-1400000`
    })
    const drawn = await mapDrawn(page)
    await shot(page, 'standalone-map')
    return drawn
  })
  await figures(page, 'standalone')

  const tracks = await newPage()
  await step(tracks, 'the 1D browser, a bigWig dropped on the page', async () => {
    await tracks.goto(`file://${file}`)
    await tracks.waitForSelector('.dropzone', { timeout: 30_000 })
    await dropFiles(tracks, [join(demo, 'Yeast_ATAC.bw')])
    const drawn = await tracksDrawn(tracks, 1_000)
    await shot(tracks, 'standalone-browser')
    return drawn
  })

  // A server that counts what reaches it, and answers with CORS, so that a
  // fetch the policy let through would arrive here and even succeed. A fetch
  // can fail for many reasons; a request that never arrived failed for this one.
  let arrived = 0
  const witness = createServer((req, res) => {
    arrived++
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end()
  })
  await new Promise((resolve) => witness.listen(0, '127.0.0.1', resolve))
  const loopback = `http://127.0.0.1:${witness.address().port}/`

  const consoleBefore = heard.console.length
  try {
    await step(tracks, 'the controls', async () => {
      // On the page, and in a worker built from a blob, which inherits the
      // page's policy rather than having none — the difference from the site,
      // whose workers are files.
      const found = await tracks.evaluate(async (to) => {
        const page = await fetch(`${to}page`).then(() => 'fetched', () => 'refused')
        const source = `fetch('${to}worker').then(() => postMessage('fetched'), () => postMessage('refused'))`
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
        const inWorker = await new Promise((resolve) => {
          worker.onmessage = (event) => resolve(event.data)
          setTimeout(() => resolve('silent'), 5000)
        })
        worker.terminate()
        const host = document.createElement('div')
        host.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="window.__ran = 1" onerror="window.__ran = 1">'
        document.body.appendChild(host)
        await new Promise((resolve) => setTimeout(resolve, 600))
        host.remove()
        return { page, inWorker, handlerRan: window.__ran === 1 }
      }, loopback)
      if (found.page !== 'refused' || found.inWorker !== 'refused' || arrived > 0) {
        throw new Error(`a fetch got past connect-src (${arrived} request(s) arrived)`)
      }
      if (found.handlerRan) throw new Error('an injected inline handler ran')
      return { ...found, arrived }
    })
  } finally {
    witness.close()
  }
  await sleep(1500)
  problems.splice(0, problems.length, ...problems.filter((one) => !one.startsWith('the controls: the policy refused')))
  heard.console.splice(consoleBefore)
}

try {
  await (MODE === 'site' ? site() : standalone())
} catch (error) {
  problems.push(String(error).split('\n')[0])
} finally {
  await browser.close()
}

for (const text of heard.console) problems.push(`console error: ${text.slice(0, 240)}`)
for (const text of heard.pageErrors) problems.push(`page error: ${text.slice(0, 240)}`)
const total = report.reduce((sum, one) => sum + one.violations, 0)
if (problems.length > 0) {
  console.error(`ui-csp (${MODE}): ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(
  `ui-csp (${MODE}): ${report.length} steps, no violation outside the controls (${total} raised in all), ` +
    'no console or page error, every canvas drawn',
)
