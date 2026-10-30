/**
 * The app's half of laptop.qmd: one analysis run in the app, in headless Chromium, and what it cost
 * the machine.
 *
 *   node laptop.mjs PLAN.json RESULT.json
 *   node laptop.mjs --version [CHROMIUM]
 *
 * PLAN.json is written by the notebook for one analysis: where the app's build is, the folder its
 * files are named from, a folder of the run's own, and the session — a workspace and the files it
 * names, or the files alone, dropped on the landing page as a reader drops them, so the line the
 * console writes names each file as the shell finds it — then the task, opened from the Analysis
 * panel by its title, its form set as the plan says, and run. `--version` names the Chromium a run
 * would be, for the page to say before it runs any.
 *
 * Each run is a Chromium of its own, launched for it and closed after it, so that nothing an
 * earlier run read, drew or kept is in what this one is measured to hold. The page is loaded, the
 * files are opened, the form is set, and the page is left until Chromium is idle — what the app
 * starts on its own once a map is open is over before the run, and nothing is left focused or under
 * the pointer to be drawn again and again — and then **run** is pressed. From the press to the
 * console's record of the run ending, every process of that Chromium is sampled every
 * {@link EVERY_MS}: their CPU times as Chromium counts them (CDP's `SystemInfo.getProcessInfo`,
 * cumulative per process), their resident sets as `ps` gives them, in kilobytes on macOS and Linux
 * alike. The **page's** are its renderers': the page's own, whose threads its workers are, where the
 * app computes and holds what it reads, and any Chromium keeps spare. Its CPU time is the sum of what
 * each spent across the run, and its peak memory the largest of their summed resident sets — sampled,
 * so a peak that lasts less than a sample can be missed, where the command line's `ru_maxrss` cannot
 * miss one. **All of Chromium's** are counted the same way beside them: the browser process, which
 * reads a dropped file for the page, the GPU process and the network and storage services as well.
 * The time is the app's: what its console records, from the job's dispatch to its result; and the
 * opening of the files, which a command-line run does inside its own time, is timed apart, from the
 * drop to the console's record of the last.
 *
 * RESULT.json is written once, at the end, whether the run finished, failed or did not start.
 */

import { execFile } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
// The Playwright the timings pin (notebooks/viewers), or one installed globally.
function playwright() {
  try {
    return createRequire(join(HERE, '..', 'viewers', 'package.json'))('playwright')
  } catch {
    return createRequire(join(process.execPath, '..', '..', 'lib', 'node_modules', 'x'))('playwright')
  }
}
const { chromium } = playwright()

const [planPath, resultPath] = process.argv.slice(2)
if (planPath === undefined || (resultPath === undefined && planPath !== '--version')) {
  console.error('usage: node laptop.mjs PLAN.json RESULT.json\n       node laptop.mjs --version [CHROMIUM]')
  process.exit(2)
}
const PLAN = planPath === '--version' ? { executablePath: resultPath } : JSON.parse(readFileSync(planPath, 'utf8'))
/** How long the page, the opening of its files or the run may take before it is given up. */
const LIMIT_MS = PLAN.limitMs ?? 3_600_000
/** How often the processes are sampled while the run runs. */
const EVERY_MS = 200
/** Idle: every process together using less than this share of one core over {@link QUIET_MS}. */
const QUIET_SHARE = 0.05
const QUIET_MS = 2_000
/** How long the page is waited on to be idle before the run is started anyway, and said so. */
const SETTLE_LIMIT_MS = 120_000
/** Files that are another file's index, opened with it rather than as an entry of their own. */
const INDEX = /\.(fai|tbi|csi|bai)$/i

// ---------------------------------------------------------------------------
// The app, from loopback, as the site serves it
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.woff2': 'font/woff2',
}

function serve() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x')
    let path = join(PLAN.app, normalize(decodeURIComponent(url.pathname)))
    try {
      if (statSync(path).isDirectory()) path = join(path, 'index.html')
    } catch {
      path = ''
    }
    if (path === '' || !existsSync(path)) {
      response.statusCode = 404
      response.end()
      return
    }
    response.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream')
    response.setHeader('Content-Length', statSync(path).size)
    createReadStream(path).pipe(response)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// ---------------------------------------------------------------------------
// What Chromium's processes hold and have spent
// ---------------------------------------------------------------------------

const run = promisify(execFile)

/** Every process of this Chromium, with its type and its CPU seconds so far. */
async function processes(cdp) {
  return (await cdp.send('SystemInfo.getProcessInfo')).processInfo
}

/** The resident set of each process, in MB, from `ps`; a process that has gone is left out. */
async function resident(ids) {
  if (ids.length === 0) return new Map()
  let stdout = ''
  try {
    ;({ stdout } = await run('ps', ['-o', 'pid=,rss=', '-p', ids.join(',')]))
  } catch (error) {
    // `ps` exits 1 when one of the processes has gone, and still prints the others.
    stdout = error.stdout ?? ''
  }
  const out = new Map()
  for (const line of stdout.trim().split('\n')) {
    const [pid, kb] = line.trim().split(/\s+/).map(Number)
    if (Number.isFinite(pid) && Number.isFinite(kb)) out.set(pid, kb / 1024)
  }
  return out
}

/** The page's processes: its renderer, whose threads its workers are, and any renderer kept spare. */
const isPage = (type) => type === 'renderer'

/**
 * A running account of the processes, the page's and all of them: each one's CPU seconds when it was
 * first seen and when last, so a process that ends during a run keeps what it spent, and the largest
 * summed resident set of each.
 */
class Account {
  constructor() {
    this.first = new Map()
    this.last = new Map()
    this.types = new Map()
    this.peak = { page: 0, all: 0 }
    this.atPeak = {}
    this.samples = 0
  }

  async sample(cdp) {
    const info = await processes(cdp)
    for (const one of info) {
      if (!this.first.has(one.id)) this.first.set(one.id, this.samples === 0 ? one.cpuTime : 0)
      this.last.set(one.id, one.cpuTime)
      this.types.set(one.id, one.type)
    }
    const sizes = await resident(info.map((one) => one.id))
    const held = { page: 0, all: 0 }
    const byType = {}
    for (const one of info) {
      const size = sizes.get(one.id) ?? 0
      held.all += size
      if (isPage(one.type)) held.page += size
      byType[one.type] = (byType[one.type] ?? 0) + size
    }
    this.peak.page = Math.max(this.peak.page, held.page)
    if (held.all > this.peak.all) {
      this.peak.all = held.all
      this.atPeak = byType
    }
    this.samples += 1
    return { ...held, byType, count: info.length }
  }

  /** The CPU seconds each type of process took, for a reader asking where they went. */
  get cpuByType() {
    const out = {}
    for (const [id, last] of this.last) {
      const type = this.types.get(id)
      out[type] = (out[type] ?? 0) + last - this.first.get(id)
    }
    return out
  }

  get cpu() {
    const byType = Object.entries(this.cpuByType)
    return {
      page: byType.filter(([type]) => isPage(type)).reduce((sum, [, cpu]) => sum + cpu, 0),
      all: byType.reduce((sum, [, cpu]) => sum + cpu, 0),
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** CPU seconds of each type of process, now. */
async function cpuNow(cdp) {
  const out = {}
  for (const one of await processes(cdp)) out[one.type] = (out[one.type] ?? 0) + one.cpuTime
  return out
}

/**
 * Wait until Chromium is idle: how long that took, and, where it never was, what each type of
 * process was spending in the last stretch waited.
 */
async function settle(cdp) {
  const started = Date.now()
  let before = await cpuNow(cdp)
  for (;;) {
    await sleep(QUIET_MS)
    const now = await cpuNow(cdp)
    const spent = Object.fromEntries(Object.entries(now).map(([type, cpu]) => [type, cpu - (before[type] ?? 0)]))
    const total = Object.values(spent).reduce((sum, cpu) => sum + cpu, 0)
    if (total < (QUIET_SHARE * QUIET_MS) / 1000) return { quiet: true, ms: Date.now() - started }
    if (Date.now() - started > SETTLE_LIMIT_MS) return { quiet: false, ms: Date.now() - started, spent }
    before = now
  }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** A hidden file input of this script's own, its files then dropped on the drop zone on screen. */
async function drop(page, paths) {
  await page.evaluate(() => {
    document.getElementById('laptop-files')?.remove()
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    input.id = 'laptop-files'
    document.body.append(input)
  })
  await page.setInputFiles('#laptop-files', paths)
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    for (const file of document.getElementById('laptop-files').files) transfer.items.add(file)
    const zone = [...document.querySelectorAll('.dropzone')].find((one) => one.offsetParent !== null) ??
      document.querySelector('.dropzone')
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  })
}

/** The console's record (`state/actions.ts`), newest last. */
function actions(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('chromosomix:actions') ?? '{"entries":[]}').entries)
}

/** Press a panel's fold button, if the panel is not already showing. */
async function show(page, panel) {
  for (const button of await page.$$(`button[title^="Show the ${panel} panel"]`)) {
    if (await button.isVisible()) {
      await button.click()
      await sleep(600)
      return
    }
  }
}

/**
 * Wait for `wait`, unless the app puts up a dialog or its error page first: no file of a plan asks
 * a question, so either while a session opens is the app refusing one, and its words are the error
 * rather than a wait that runs out.
 */
async function unrefused(page, wait) {
  const refused = page.waitForSelector('.modal-panel, .error-message', { state: 'visible', timeout: LIMIT_MS })
    .then(async (panel) => {
      throw new Error(`the app said “${(await panel.innerText()).replace(/\s+/g, ' ').trim()}”`)
    })
  // Settled once the wait is, so that its own end — the page closed — is not an error of the run's.
  refused.catch(() => {})
  await Promise.race([wait, refused])
}

/**
 * The workspace, where there is one, then the files; wait until the console has recorded each open,
 * and say how long that took from the drop, to the half second it is looked for.
 */
async function open(page, result) {
  await page.goto(`${PLAN.base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.dropzone', { timeout: LIMIT_MS })
  if (PLAN.workspace !== undefined) {
    const workspace = join(PLAN.out, `${PLAN.name}.chromosomix.json`)
    writeFileSync(workspace, JSON.stringify(PLAN.workspace, null, 1))
    await drop(page, [workspace])
    await sleep(2000)
  }
  const started = Date.now()
  await drop(page, PLAN.files.map((name) => join(PLAN.data, name)))
  const opened = PLAN.files.filter((name) => !INDEX.test(name)).length
  await unrefused(page, page.waitForFunction(
    (count) => JSON.parse(localStorage.getItem('chromosomix:actions') ?? '{"entries":[]}').entries
      .filter((one) => (one.kind === 'open' || one.kind === 'track') && one.status !== 'running').length >= count,
    opened,
    { timeout: LIMIT_MS, polling: 500 },
  ))
  result.open_s = (Date.now() - started) / 1000
  result.opened = (await actions(page)).filter((one) => one.kind === 'open' || one.kind === 'track')
    .map((one) => ({ line: one.line, status: one.status, ...(one.ms === undefined ? {} : { s: one.ms / 1000 }) }))
}

/** The control a parameter is set by: the form names each `pf<n>-<key>`. */
async function control(page, key, selector) {
  const id = await page.evaluate(({ key, selector }) => {
    const pattern = new RegExp(`^pf\\d+-${key}$`)
    return [...document.querySelectorAll(`.analysis-drawer ${selector}`)].find((one) => pattern.test(one.id))?.id
  }, { key, selector })
  if (id === undefined) throw new Error(`the form has no ${selector} for --${key}`)
  return page.locator(`[id="${id}"]`)
}

/** Of the labels a form shows, the one that is `name`, or else the first that holds it. */
function labelled(labels, name) {
  return labels.find((one) => one.trim() === name) ?? labels.find((one) => one.includes(name))
}

/**
 * One setting of the form, by the parameter's key: `option`, a dropdown's entry by its label, which
 * is how a loaded file is chosen; `ticks`, the entries of a list of tick boxes to tick, by their
 * labels, every other unticked; `value`, a dropdown's value or what is typed into a box; `on`, a
 * switch.
 */
async function set(page, { key, value, option, ticks, on }) {
  if (on !== undefined) {
    const button = page.locator(`.analysis-drawer button[aria-labelledby$="-${key}-label"]`).first()
    if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click()
  } else if (ticks !== undefined) {
    const field = page.locator('.analysis-drawer .param-field', { has: page.locator(`[id$="-${key}-label"]`) }).first()
    const boxes = await field.locator('label.param-check').all()
    const labels = await Promise.all(boxes.map((box) => box.innerText()))
    const wanted = ticks.map((name) => labelled(labels, name))
    if (wanted.includes(undefined)) throw new Error(`--${key} offers no “${ticks[wanted.indexOf(undefined)]}”: ${labels.join(', ')}`)
    for (const [at, box] of boxes.entries()) {
      const input = box.locator('input')
      if ((await input.isChecked()) !== wanted.includes(labels[at])) await input.click()
    }
  } else if (option !== undefined) {
    const select = await control(page, key, 'select')
    const labels = await select.locator('option').allTextContents()
    const label = labelled(labels, option)
    if (label === undefined) throw new Error(`--${key} offers no “${option}”: ${labels.join(', ')}`)
    await select.selectOption({ label })
  } else if (await page.locator(`.analysis-drawer select[id$="-${key}"]`).count()) {
    await (await control(page, key, 'select')).selectOption({ value: String(value) })
  } else {
    const input = await control(page, key, 'input')
    await input.fill(String(value))
    await input.press('Enter')
  }
  await sleep(400)
}

/** The task opened from the Analysis panel and its form set. */
async function prepare(page) {
  await show(page, 'Analysis')
  const row = page.locator('.analysis-row-title', { hasText: PLAN.task }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await page.waitForSelector('.analysis-drawer', { state: 'visible' })
  await sleep(1000)
  for (const setting of PLAN.set ?? []) await set(page, setting)
  // Nothing left focused, whose caret would blink, nor under the pointer, which would be redrawn
  // for it: each is a frame drawn again and again while the page is meant to be idle.
  await page.evaluate(() => document.activeElement?.blur())
  await page.mouse.move(1, 999)
}

/** Run pressed, and the processes sampled until the console records the run's end. */
async function measure(page, cdp, result) {
  const account = new Account()
  const before = (await actions(page)).length
  const rest = await account.sample(cdp)
  Object.assign(result, { rest_mb: rest.page, chromium_rest_mb: rest.all, rest_by_type: rest.byType })
  const started = Date.now()
  await page.locator('.analysis-drawer button', { hasText: /^run( on ★)?$/ }).first().click()
  let entry
  for (;;) {
    const tick = Date.now()
    const { count } = await account.sample(cdp)
    result.processes = Math.max(result.processes ?? 0, count)
    entry = (await actions(page)).slice(before).find((one) => one.kind === 'run' && one.status !== 'running')
    if (entry !== undefined || Date.now() - started > LIMIT_MS) break
    await sleep(Math.max(0, EVERY_MS - (Date.now() - tick)))
  }
  // One more sample, so a run that ends between two still has one taken after it.
  await account.sample(cdp)
  const cpu = account.cpu
  Object.assign(result, {
    waited_s: (Date.now() - started) / 1000,
    cpu_s: cpu.page, peak_mb: account.peak.page,
    chromium_cpu_s: cpu.all, chromium_peak_mb: account.peak.all,
    cpu_by_type: account.cpuByType, peak_by_type: account.atPeak, samples: account.samples,
  })
  if (entry === undefined) {
    result.error = 'the run did not finish'
    return
  }
  Object.assign(result, { line: entry.line, notes: entry.notes, wall_s: entry.ms / 1000 })
  if (entry.status !== 'ok') {
    result.error = entry.error ?? entry.status
    return
  }
  result.status = 'ok'
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Chromium itself in its headless mode, as the timings and the parity run it, or the one named;
 * WebGL in SwiftShader, as theirs, and the page composited in software, which draws again only what
 * changed. Composited through SwiftShader, every frame of the spinner a running job shows was the
 * whole window drawn again, on the processor: three cores' worth beside a 40-second metaplot, which
 * a reader's browser spends on its GPU.
 */
function launch() {
  return chromium.launch({
    ...(PLAN.executablePath ? { executablePath: PLAN.executablePath } : { channel: 'chromium' }),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-gpu-compositing'],
  })
}

// Which Chromium a run would be, for the page to name before it runs any.
if (planPath === '--version') {
  const browser = await launch()
  console.log(browser.version())
  await browser.close()
  process.exit(0)
}

mkdirSync(PLAN.out, { recursive: true })
const server = await serve()
PLAN.base = `http://127.0.0.1:${server.address().port}`
const browser = await launch()
const result = { name: PLAN.name, chromium: browser.version(), status: 'failed' }
try {
  const cdp = await browser.newBrowserCDPSession()
  // No service worker: a reader's is installed once and then idle, where a first visit's would be
  // fetching the whole build for its cache in the middle of the measurement.
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  try {
    await open(page, result)
    await prepare(page)
    const settled = await settle(cdp)
    result.settle_s = settled.ms / 1000
    if (!settled.quiet) result.busy = settled.spent
    await measure(page, cdp, result)
  } catch (error) {
    result.error = String(error).split('\n')[0]
  }
  await page.screenshot({ path: join(PLAN.out, 'browser.png') }).catch(() => {})
  result.pageErrors = errors
} finally {
  writeFileSync(resultPath, JSON.stringify(result, null, 1))
  await browser.close()
  server.close()
}
console.log(`${result.name}: ${result.status}${result.error ? ` — ${result.error}` : ''}`)
