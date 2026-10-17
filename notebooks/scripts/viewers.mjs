/**
 * The time to a picture, in three viewers: what timing.qmd's first section runs.
 *
 *   node viewers.mjs PLAN.json RESULTS.jsonl
 *
 * PLAN.json is written by the notebook: where the app's build and the two viewers' pages are,
 * how to start HiGlass's server, and the runs, in the order to make them. Each run is one viewer
 * showing one map and one track at one resolution, from files on this machine or from a bucket,
 * timed in a fresh browser context — nothing cached — from the moment the viewer is handed the
 * data and the view to the moment the viewer itself says the picture is finished:
 *
 * - **chromosomix**: its own `chromosomix:rendered` report (`src/perf/rendered.ts`), for a
 *   workspace dropped on its landing page — the map at the resolution named, the track beside it.
 *   From a bucket the workspace names the files' addresses; from disk it names the files, and they
 *   are dropped on the page that asks for them.
 * - **juicebox.js**: the map's last repaint covering the state asked for and the track's two views
 *   holding their tiles (`notebooks/viewers/juicebox.html`).
 * - **HiGlass**: every tile of both tracks in view fetched and drawn
 *   (`notebooks/viewers/higlass.html`), from higlass-python's server, started for the run.
 *
 * Each viewer is first loaded empty — its page, its code, its workers — and that time is kept
 * apart (`app_ms`), so what is compared is the data's road to the screen. Each answers with the
 * resolution it drew, and a run whose viewer drew another resolution, or part of the window, is
 * kept as what it was and not as a time for the one asked for.
 *
 * RESULTS.jsonl gets one line a run, written as the run ends, so a stopped benchmark keeps the runs
 * it finished. Its requests and bytes are those the page asked for between the two moments; its
 * `clip` is where the map and its track are on the first run's screenshot.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VIEWERS = join(HERE, '..', 'viewers')
const require = createRequire(join(VIEWERS, 'package.json'))
const { chromium } = require('playwright')

const [planPath, resultsPath] = process.argv.slice(2)
if (planPath === undefined || resultsPath === undefined) {
  console.error('usage: node viewers.mjs PLAN.json RESULTS.jsonl')
  process.exit(2)
}
const PLAN = JSON.parse(readFileSync(planPath, 'utf8'))
/** How long a run may take before it is given up as not drawn. */
const LIMIT_MS = PLAN.limitMs ?? 300_000
/** The window: wide enough that every viewer's map is about 600 pixels square. */
const VIEWPORT = { width: 1600, height: 1000 }
/** juicebox's container, and the HiGlass map's side; see their pages. */
const JUICEBOX_BOX = { width: 700, height: 760 }
const HIGLASS_BOX = 600
const HIGLASS_TRACK = 60

// ---------------------------------------------------------------------------
// What the pages are served from
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.woff2': 'font/woff2',
}

/**
 * The viewers' pages at `/viewers/` and the app's build at the root, which is where its build
 * expects to be, with byte ranges, from loopback.
 */
function serve() {
  const mounts = { '/viewers/': VIEWERS, '/': PLAN.app }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x')
    const mount = Object.keys(mounts).find((prefix) => url.pathname.startsWith(prefix))
    if (mount === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    let path = join(mounts[mount], normalize(decodeURIComponent(url.pathname.slice(mount.length))))
    try {
      if (statSync(path).isDirectory()) path = join(path, 'index.html')
    } catch {
      response.statusCode = 404
      response.end()
      return
    }
    if (!existsSync(path)) {
      response.statusCode = 404
      response.end()
      return
    }
    const size = statSync(path).size
    response.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream')
    response.setHeader('Accept-Ranges', 'bytes')
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '')
    if (range !== null) {
      const start = Number(range[1])
      const end = Math.min(range[2] === '' ? size - 1 : Number(range[2]), size - 1)
      response.statusCode = 206
      response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      response.setHeader('Content-Length', end - start + 1)
      createReadStream(path, { start, end }).pipe(response)
      return
    }
    response.setHeader('Content-Length', size)
    createReadStream(path).pipe(response)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// ---------------------------------------------------------------------------
// The machine between runs
// ---------------------------------------------------------------------------

/**
 * Empty the kernel's page cache, so a file on disk is read from the disk: what a first open is.
 * Only where the user may do so without a password, as on a CI runner; elsewhere the cache is kept,
 * and every run says which.
 */
function dropCaches() {
  if (PLAN.dropCaches === false) return 'kept'
  spawnSync('sync')
  const run = spawnSync('sudo', ['-n', 'sh', '-c', 'echo 3 > /proc/sys/vm/drop_caches'], { stdio: 'ignore' })
  return run.status === 0 ? 'dropped' : 'kept'
}

/** HiGlass's server for one run, from nothing; its address and tileset ids, and how to stop it. */
async function startHiGlass(run) {
  const fuse = run.location === 'cloud' ? join(tmpdir(), `higlass-fuse-${process.pid}`) : null
  if (fuse !== null) {
    unmount(fuse)
    rmSync(fuse, { recursive: true, force: true })
    mkdirSync(fuse, { recursive: true })
  }
  const args = [PLAN.higlass.server, run.map, run.track, run.higlass.chromsizes, ...(fuse === null ? [] : ['--fuse', fuse])]
  const child = spawn(PLAN.higlass.python, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.on('data', (chunk) => {
    errors = (errors + chunk).slice(-4000)
  })
  const line = await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
      const newline = out.indexOf('\n')
      if (newline >= 0) resolve(out.slice(0, newline))
    })
    child.on('exit', (code) => reject(new Error(`HiGlass's server stopped (${code}): ${errors}`)))
    setTimeout(() => reject(new Error(`HiGlass's server did not start: ${errors}`)), 120_000)
  })
  const served = JSON.parse(line)
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Gone already.
    }
    if (fuse !== null) {
      unmount(fuse)
      rmSync(fuse, { recursive: true, force: true })
    }
  }
  return { ...served, stop }
}

/** Take a FUSE mount down, if there is one. */
function unmount(dir) {
  const mount = join(dir, 'schemas')
  for (const tool of ['fusermount3', 'fusermount']) {
    if (spawnSync(tool, ['-u', '-z', mount], { stdio: 'ignore' }).status === 0) return
  }
  spawnSync('umount', ['-l', mount], { stdio: 'ignore' })
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

const proxy = process.env.HTTPS_PROXY
const browser = await chromium.launch({
  // Chromium itself, in its headless mode, rather than Playwright's headless shell: the browser a
  // reader would open the viewers in.
  channel: 'chromium',
  args: [
    '--no-sandbox',
    // HiGlass draws through WebGL; a runner has no GPU, so it is drawn by SwiftShader, as every
    // other picture here is drawn by the CPU.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=127.0.0.1;localhost'] : []),
  ],
})
const version = browser.version()

/**
 * A fresh context and page, whose requests are kept with the time each began — on the epoch, so
 * they can be cut at the picture's own moment — except those for the pages and their code.
 */
async function fresh(base) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  const reports = []
  await context.exposeBinding('__rendered', (_source, report) => reports.push(report))
  await context.addInitScript(() => {
    window.addEventListener('chromosomix:rendered', (event) => window.__rendered(event.detail))
  })
  const requests = []
  context.on('requestfinished', async (request) => {
    if (request.url().startsWith(base) || request.url().startsWith('data:') || request.url().startsWith('blob:')) return
    let bytes = 0
    try {
      bytes = (await request.sizes()).responseBodySize
    } catch {
      // A request whose sizes are no longer to be had counts for no bytes.
    }
    requests.push({ at: request.timing().startTime, bytes })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)))
  return { context, page, reports, requests, errors }
}

/** The first report after `after` that `wanted` accepts, or `null` past the limit. */
async function report(reports, after, wanted) {
  const started = Date.now()
  for (;;) {
    const hit = reports.slice(after).find(wanted)
    if (hit !== undefined) return hit
    if (Date.now() - started > LIMIT_MS) return null
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Hand files to a page's own file input, which nothing on the page shows. */
async function give(page, selector, paths) {
  await page.setInputFiles(selector, paths)
}

/** Drop the files in `selector`'s input on chromosomix's drop zone, the one on screen; the page's clock then. */
function dropOn(page, selector) {
  return page.evaluate((wanted) => {
    const input = document.querySelector(wanted)
    const transfer = new DataTransfer()
    for (const file of input.files) transfer.items.add(file)
    const zone = [...document.querySelectorAll('.dropzone')].find((one) => one.offsetParent !== null) ?? document.querySelector('.dropzone')
    const at = performance.now()
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    return at
  }, selector)
}

/** A hidden file input of this script's own on chromosomix's page — it builds none (`ui/chooseFiles.ts`). */
function addInput(page, id) {
  return page.evaluate((name) => {
    document.getElementById(name)?.remove()
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    input.id = name
    document.body.append(input)
  }, id)
}

// ---------------------------------------------------------------------------
// One run in each viewer
// ---------------------------------------------------------------------------

/** chromosomix: a workspace dropped on the landing page; its report of the finished picture. */
async function chromosomix(run, base, scratch) {
  const { context, page, reports, requests, errors } = await fresh(base)
  try {
    await page.goto(`${base}/`)
    const landed = await report(reports, 0, () => true)
    if (landed === null) return { status: 'error', note: 'the app did not finish its landing page' }
    const appMs = landed.at
    const workspace = join(scratch, `${run.id}.chromosomix.json`)
    writeFileSync(workspace, JSON.stringify(run.chromosomix.workspace))
    await addInput(page, 'timed-files')
    let t0
    let before
    if (run.location === 'local') {
      // The workspace names the files, and asks for them; they are then dropped on the page that
      // asks, which is the drop that is timed.
      await give(page, '#timed-files', [workspace])
      before = reports.length
      await dropOn(page, '#timed-files')
      if ((await report(reports, before, () => true)) === null) return { status: 'error', note: 'the workspace did not open' }
      await addInput(page, 'timed-files')
      await give(page, '#timed-files', [run.map, run.track])
    } else {
      await give(page, '#timed-files', [workspace])
    }
    before = reports.length
    t0 = await dropOn(page, '#timed-files')
    const drawn = await report(
      reports,
      before,
      (one) => one.status !== 'drawn' || (one.maps.length > 0 && one.lanes > 0),
    )
    if (drawn === null) return { status: 'error', note: 'no report of a finished picture', appMs, errors }
    const map = drawn.maps[0]
    await screenshot(page, run)
    // The map's canvas and the lanes drawn beside it, without the panel's margins.
    const clip = await page.evaluate(() => {
      const body = document.querySelector('section.panel .panel-body')
      if (body === null) return null
      const drawn = [...body.querySelectorAll('canvas')]
        .map((canvas) => canvas.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
      const boxes = drawn.length > 0 ? drawn : [body.getBoundingClientRect()]
      const left = Math.min(...boxes.map((box) => box.left))
      const top = Math.min(...boxes.map((box) => box.top))
      const right = Math.max(...boxes.map((box) => box.right))
      const bottom = Math.max(...boxes.map((box) => box.bottom))
      return { x: left, y: top, width: right - left, height: bottom - top }
    })
    const bins = map === undefined ? null : Math.max(map.rows, map.cols)
    const status =
      drawn.status !== 'drawn' ? drawn.status : map.resolution !== run.resolution ? 'other resolution' : 'drawn'
    return {
      ...tally(requests, await origin(page), t0, drawn.at),
      status,
      ms: drawn.at - t0,
      appMs,
      resolution: map?.resolution ?? null,
      bins,
      note: drawn.note ?? (status === 'other resolution' ? `drawn at ${map.resolution} bp` : ''),
      clip,
      errors,
    }
  } finally {
    await context.close()
  }
}

/** juicebox.js: an empty browser, then the map at an explicit state and its track. */
async function juicebox(run, base, juiceboxWidth) {
  const { context, page, requests, errors } = await fresh(base)
  try {
    await page.goto(`${base}/viewers/juicebox.html`)
    await page.waitForFunction(() => window.ready === true)
    await page.evaluate((plan) => window.prepare(plan), JUICEBOX_BOX)
    const appMs = await page.evaluate(() => performance.now())
    if (run.location === 'local') await give(page, '#files', [run.map, run.track])
    const plan = {
      map: run.location === 'local' ? basename(run.map) : run.map,
      track: run.location === 'local' ? basename(run.track) : run.track,
      name: run.genome,
      trackName: 'track',
      limit: LIMIT_MS,
      state: {
        chr1: run.juicebox.chr,
        chr2: run.juicebox.chr,
        zoom: run.juicebox.zoom,
        x: run.juicebox.x,
        y: run.juicebox.x,
        pixelSize: juiceboxWidth / run.bins,
        normalization: 'NONE',
      },
    }
    const answer = await page.evaluate((one) => window.time(one), plan)
    if (answer.at === null) return { status: 'error', note: answer.note, appMs, errors }
    await screenshot(page, run)
    const whole = Math.abs(answer.bins - run.bins) <= 1
    return {
      ...tally(requests, await origin(page), answer.t0, answer.at),
      status: answer.resolution !== run.resolution ? 'other resolution' : whole ? 'drawn' : 'in part',
      ms: answer.at - answer.t0,
      appMs,
      resolution: answer.resolution,
      bins: Math.round(answer.bins),
      note: whole ? '' : `${Math.round(answer.bins)} of the window's ${run.bins} bins`,
      clip: answer.clip,
      errors,
    }
  } finally {
    await context.close()
  }
}

/** HiGlass: higlass-python's server for this run, and a viewer of the map and the track over it. */
async function higlass(run, base) {
  const served = await startHiGlass(run)
  const { context, page, requests, errors } = await fresh(base)
  try {
    await page.goto(`${base}/viewers/higlass.html`)
    await page.waitForFunction(() => window.ready === true)
    const appMs = await page.evaluate(() => performance.now())
    const answer = await page.evaluate((plan) => window.time(plan), {
      server: served.server,
      map: served.map,
      track: served.track,
      domain: run.higlass.domain,
      maxZoom: run.higlass.maxZoom,
      box: HIGLASS_BOX,
      trackHeight: HIGLASS_TRACK,
      limit: LIMIT_MS,
    })
    if (answer.at === null) return { status: 'error', note: answer.note, appMs, errors }
    await screenshot(page, run)
    return {
      ...tally(requests, await origin(page), answer.t0, answer.at),
      status: answer.resolution === run.resolution ? 'drawn' : 'other resolution',
      ms: answer.at - answer.t0,
      appMs,
      resolution: answer.resolution,
      bins: run.bins,
      note: answer.resolution === run.resolution ? '' : `drawn at ${answer.resolution} bp in a ${answer.box}-pixel map`,
      clip: answer.clip,
      errors,
    }
  } finally {
    await context.close()
    served.stop()
  }
}

/** The page's time origin, on the epoch: what a request's start is compared with. */
function origin(page) {
  return page.evaluate(() => performance.timeOrigin)
}

/** Requests begun between the viewer's being handed the data (`t0`) and the picture's being finished, and their bytes. */
function tally(requests, timeOrigin, t0, at) {
  const from = timeOrigin + t0
  const until = timeOrigin + at
  const timed = requests.filter((one) => one.at >= from && one.at <= until)
  return { requests: timed.length, bytes: timed.reduce((sum, one) => sum + one.bytes, 0) }
}

/** The first run of each picture, as it was when it was called finished. */
async function screenshot(page, run) {
  if (run.run !== 1 || PLAN.screenshots === undefined) return
  mkdirSync(PLAN.screenshots, { recursive: true })
  await page.screenshot({ path: join(PLAN.screenshots, `${run.picture}.png`) })
}

/**
 * juicebox's map width once a track is beside it, read once from a small load: the pixel size a
 * window is asked for at is that width over the window's bins. The empty browser is wider than
 * the map ends up, because the track takes its room when it arrives.
 */
async function juiceboxWidth(base) {
  const probe = PLAN.juiceboxProbe
  const { context, page } = await fresh(base)
  try {
    await page.goto(`${base}/viewers/juicebox.html`)
    await page.waitForFunction(() => window.ready === true)
    await page.evaluate((plan) => window.prepare(plan), JUICEBOX_BOX)
    await give(page, '#files', [probe.map, probe.track])
    const answer = await page.evaluate((plan) => window.time(plan), {
      map: basename(probe.map),
      track: basename(probe.track),
      name: 'probe',
      trackName: 'probe',
      state: { chr1: probe.chr, chr2: probe.chr, zoom: probe.zoom, x: 0, y: 0, pixelSize: 1, normalization: 'NONE' },
    })
    return answer.box
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// The runs
// ---------------------------------------------------------------------------

const server = await serve()
const base = `http://127.0.0.1:${server.address().port}`
const scratch = join(tmpdir(), `viewers-${process.pid}`)
mkdirSync(scratch, { recursive: true })
try {
  const width = await juiceboxWidth(base)
  console.log(`juicebox's map, with a track beside it: ${width} pixels`)
  for (const run of PLAN.runs) {
    const cache = run.location === 'local' ? dropCaches() : 'n/a'
    const started = new Date().toISOString().slice(0, 19)
    let result
    try {
      if (run.tool === 'chromosomix') result = await chromosomix(run, base, scratch)
      else if (run.tool === 'juicebox') result = await juicebox(run, base, width)
      else result = await higlass(run, base)
    } catch (error) {
      result = { status: 'error', note: String(error).slice(0, 500) }
    }
    const line = { id: run.id, run: run.run, started, page_cache: cache, chromium: version, ...result }
    appendFileSync(resultsPath, `${JSON.stringify(line)}\n`)
    console.log(`${run.id} #${run.run}: ${line.status}${line.ms === undefined ? '' : ` ${Math.round(line.ms)} ms`}${line.note ? ` (${line.note})` : ''}`)
  }
} finally {
  await browser.close()
  server.close()
  rmSync(scratch, { recursive: true, force: true })
}
