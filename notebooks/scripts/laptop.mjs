/**
 * The app's half of laptop.qmd: one analysis run in the app, in a headless browser — Chromium,
 * Firefox or WebKit — and what it cost the machine.
 *
 *   node laptop.mjs PLAN.json RESULT.json
 *   node laptop.mjs --version BROWSER [EXECUTABLE]
 *
 * PLAN.json is written by the notebook for one analysis in one browser: which of the three Playwright
 * drives (`browser`, Chromium unless it says), where the app's build is, the folder its files are
 * named from, a folder of the run's own, and the session — a workspace and the files it names, or the
 * files alone, dropped on the landing page as a reader drops them, so the line the console writes
 * names each file as the shell finds it — then the task, opened from the Analysis panel by its title,
 * its form set as the plan says, and run. `--version` names the browser a run would be, for the page
 * to say before it runs any.
 *
 * Each run is a browser of its own, launched for it and closed after it, so that nothing an earlier
 * run read, drew or kept is in what this one is measured to hold. The page is loaded, the files are
 * opened, the form is set, and the page is left until the browser is idle — what the app starts on
 * its own once a map is open is over before the run, and nothing is left focused or under the pointer
 * to be drawn again and again — and then **run** is pressed. From the press to the console's record of
 * the run ending, every process of that browser is sampled every {@link EVERY_MS}, as the operating
 * system counts it, the same way for the three: its CPU time and its resident set, from `/proc` on
 * Linux and from `ps` on macOS. Its processes are the ones this script started, the browser and what
 * it starts in turn, and any that run from the browser's own folder and were not running before it was
 * launched — WebKit's, on macOS, which launchd starts for it. The **page's** are those that render
 * pages: Chromium's renderers, Firefox's web content processes, WebKit's web processes — the page's
 * own, whose threads its workers are, where the app computes and holds what it reads, and any the
 * browser keeps spare (and, on macOS, Firefox's for its add-ons, which nothing there tells apart). Its CPU time is the sum of what each spent across the run, and its peak memory
 * the largest of their summed resident sets — sampled, so a peak that lasts less than a sample can be
 * missed, where the command line's `ru_maxrss` cannot miss one. **All of the browser's** are counted
 * the same way beside them: the browser process, which reads a dropped file for the page, and its GPU,
 * network and storage processes as well. The time is the app's: what its console records, from the
 * job's dispatch to its result; and the opening of the files, which a command-line run does inside its
 * own time, is timed apart, from the drop to the console's record of the last.
 *
 * RESULT.json is written once, at the end, whether the run finished, failed or did not start.
 *
 * **A plan with `steps` is the deep map's** (laptop.qmd, *A deep human map, start to finish*): its map
 * opened once, then each step's task run in turn in the same page, as a reader runs one after another,
 * the map moved to the rung a step names first where it is not on it already (the crumb row's
 * resolution, which reads the map again at that rung). Every process of the browser is weighed every
 * {@link EVERY_MS} from the drop to the last step's end, and three kinds of stretch are measured apart,
 * each with its own account of the page's CPU and memory: the **opening**, from the drop of the files
 * to the map drawn; a **move** to another rung, from the pick to the map drawn at it; and a **run**,
 * from the press to the console's record of its end, its time the console's. What lies between them —
 * the form being set, the wait for the browser to be idle — is the script's, and in no stretch.
 */

import { execFile, execFileSync } from 'node:child_process'
import {
  createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// The Playwright notebooks/viewers pins, or one installed globally.
function playwright() {
  try {
    return createRequire(join(HERE, '..', 'viewers', 'package.json'))('playwright')
  } catch {
    return createRequire(join(process.execPath, '..', '..', 'lib', 'node_modules', 'x'))('playwright')
  }
}

/** The browsers a plan can name, as Playwright names them, and as a reader does. */
const BROWSERS = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' }

const [planPath, resultPath, executable] = process.argv.slice(2)
if (planPath === undefined || (planPath === '--version' ? !(resultPath in BROWSERS) : resultPath === undefined)) {
  console.error('usage: node laptop.mjs PLAN.json RESULT.json\n       node laptop.mjs --version BROWSER [EXECUTABLE]\n' +
    `BROWSER is one of ${Object.keys(BROWSERS).join(', ')}`)
  process.exit(2)
}
const PLAN = planPath === '--version'
  ? { browser: resultPath, executablePath: executable }
  : { browser: 'chromium', ...JSON.parse(readFileSync(planPath, 'utf8')) }
if (!(PLAN.browser in BROWSERS)) {
  console.error(`${planPath} names a browser Playwright does not drive: ${PLAN.browser}`)
  process.exit(2)
}
/** How long the page, the opening of its files or the run may take before it is given up. */
const LIMIT_MS = PLAN.limitMs ?? 3_600_000
/** How often the processes are sampled while the run runs. */
const EVERY_MS = 200
/**
 * Idle: every process together using less than this share of one core over {@link QUIET_MS}. With a
 * map open and nothing running, the page and the browser's own processes keep about 2% of a core busy
 * in Chromium, 5% in Firefox and 6% in WebKit, drawing and answering timers; a job of the app's keeps
 * a whole core or more. A tenth of a core tells the two apart in all three.
 */
const QUIET_SHARE = 0.1
const QUIET_MS = 2_000
/** How long the page is waited on to be idle before the run is started anyway, and said so. */
const SETTLE_LIMIT_MS = 120_000
/** How long a map that has opened may take to be drawn before the run is given up. */
const DRAWN_MS = 600_000
/** How long the app's measure of which sequences are circles is waited for, once the map is drawn. */
const CIRCULARITY_MS = 120_000
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
// What the browser's processes hold and have spent, as the operating system counts them
// ---------------------------------------------------------------------------

/** Linux counts CPU time in clock ticks and a resident set in pages: how long one is, and how large. */
const LINUX = process.platform === 'linux'
  ? Object.fromEntries(['CLK_TCK', 'PAGESIZE'].map((name) => [name, Number(execFileSync('getconf', [name], { encoding: 'utf8' }))]))
  : null

/** `ps`'s CPU time, `[[days-]hours:]minutes:seconds`, in seconds. */
function seconds(time) {
  const [days, clock] = time.includes('-') ? time.split('-') : ['0', time]
  return Number(days) * 86_400 + clock.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}

/**
 * Every process on the machine: its parent, its name and command line, its CPU seconds so far, user
 * and system, and its resident set in MB. On Linux from `/proc`, where a process that ends between
 * the listing and the reading is left out; elsewhere from one `ps`, which leaves itself out.
 */
async function listing() {
  if (LINUX) {
    const out = []
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        // The name is in parentheses and may hold either itself: the fields after the last `)` are the
        // third onwards — the parent the fourth, user and system time the 14th and 15th, the resident
        // set the 24th.
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        const close = stat.lastIndexOf(')')
        const field = stat.slice(close + 2).split(' ')
        out.push({
          pid: Number(entry),
          ppid: Number(field[1]),
          name: stat.slice(stat.indexOf('(') + 1, close),
          command: readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ').trim(),
          cpu: (Number(field[11]) + Number(field[12])) / LINUX.CLK_TCK,
          mb: (Number(field[21]) * LINUX.PAGESIZE) / 2 ** 20,
        })
      } catch {
        // Gone between the listing and the reading.
      }
    }
    return out
  }
  const { stdout, lister } = await new Promise((resolve, reject) => {
    const child = execFile('ps', ['-A', '-ww', '-o', 'pid=,ppid=,rss=,time=,command='], { maxBuffer: 2 ** 26 },
      (error, stdout) => (error ? reject(error) : resolve({ stdout, lister: child.pid })))
  })
  const out = []
  for (const line of stdout.split('\n')) {
    const found = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (found === null || Number(found[1]) === lister) continue
    out.push({ pid: Number(found[1]), ppid: Number(found[2]), name: '', command: found[5].trim(),
      cpu: seconds(found[4]), mb: Number(found[3]) / 1024 })
  }
  return out
}

/**
 * The browser's processes in a listing: those below this script — the browser and every process it
 * starts, and those start — and any run from the browser's own folder that was not running before it
 * was launched, which is how WebKit's are found on macOS, where launchd starts them for it.
 */
function ours(processes, scope) {
  const below = new Map()
  for (const one of processes) below.set(one.ppid, [...(below.get(one.ppid) ?? []), one])
  const found = new Map()
  const take = (one) => {
    if (found.has(one.pid)) return
    found.set(one.pid, one)
    for (const child of below.get(one.pid) ?? []) take(child)
  }
  for (const child of below.get(process.pid) ?? []) take(child)
  if (scope.folder) {
    for (const one of processes) if (!scope.before.has(one.pid) && one.command.startsWith(scope.folder)) take(one)
  }
  return [...found.values()]
}

/** The names Linux gives Firefox's processes that render web pages, its own pages and add-ons apart. */
const PAGE_NAMES = /^(Web Content|Isolated Web Co|file:\/\/ Content)/

/**
 * What a process of the browser is, from its name and command line: `page` for one that renders pages
 * and runs their workers, and otherwise the type the browser gives it, or `browser` for the browser
 * itself and what launched it. Chromium's renderers are `--type=renderer`. Firefox's child processes
 * (Firefox itself on Linux, `plugin-container` on macOS) end their line with their type, and its web
 * content processes are `tab` — as are those for its own pages and add-ons, which Linux tells apart by
 * name and macOS does not, so that there they are the page's too. WebKit's web process is
 * `WPEWebProcess` in Playwright's build for Linux, `WebKitWebProcess` in WebKitGTK and
 * `com.apple.WebKit.WebContent` on macOS.
 */
function kind({ command, name }) {
  const chromium = command.match(/\s--type=([\w-]+)/)
  if (chromium) return chromium[1] === 'renderer' ? 'page' : chromium[1]
  if (/\s-contentproc(\s|$)|\bplugin-container\b|\s-childID\s/.test(command)) {
    const type = command.split(/\s+/).at(-1)
    if (type !== 'tab') return type
    return name === '' || PAGE_NAMES.test(name) ? 'page' : name.toLowerCase().replace(/\W+/g, '-')
  }
  const webkit = command.match(/^\S*?(?:(?:WPE|WebKit)(\w+?)Process|com\.apple\.WebKit\.(\w+))(?:[.\s]|$)/)
  if (webkit) {
    const type = webkit[1] ?? webkit[2]
    return type === 'Web' || type === 'WebContent' ? 'page' : type.toLowerCase()
  }
  return 'browser'
}

/** The browser's processes now, each with what it is. */
async function snapshot(scope) {
  return ours(await listing(), scope).map((one) => ({ ...one, kind: kind(one) }))
}

/**
 * A running account of the processes, the page's and all of them: each one's CPU seconds when it was
 * first seen and when last, so a process that ends during a run keeps what it spent, and the largest
 * summed resident set of each.
 */
class Account {
  constructor() {
    this.first = new Map()
    this.last = new Map()
    this.kinds = new Map()
    this.peak = { page: 0, all: 0 }
    this.atPeak = {}
    this.samples = 0
  }

  sample(processes) {
    const held = { page: 0, all: 0 }
    const byKind = {}
    for (const one of processes) {
      if (!this.first.has(one.pid)) this.first.set(one.pid, this.samples === 0 ? one.cpu : 0)
      this.last.set(one.pid, one.cpu)
      this.kinds.set(one.pid, one.kind)
      held.all += one.mb
      if (one.kind === 'page') held.page += one.mb
      byKind[one.kind] = (byKind[one.kind] ?? 0) + one.mb
    }
    this.peak.page = Math.max(this.peak.page, held.page)
    if (held.all > this.peak.all) {
      this.peak.all = held.all
      this.atPeak = byKind
    }
    this.samples += 1
    return { ...held, byKind, count: processes.length }
  }

  /** Whether a process that renders the page was ever seen: one that never was cannot be measured. */
  get sawPage() {
    return [...this.kinds.values()].includes('page')
  }

  /** The CPU seconds each kind of process took, for a reader asking where they went. */
  get cpuByKind() {
    const out = {}
    for (const [pid, last] of this.last) {
      const kind = this.kinds.get(pid)
      out[kind] = (out[kind] ?? 0) + last - this.first.get(pid)
    }
    return out
  }

  get cpu() {
    const byKind = Object.entries(this.cpuByKind)
    return {
      page: byKind.filter(([kind]) => kind === 'page').reduce((sum, [, cpu]) => sum + cpu, 0),
      all: byKind.reduce((sum, [, cpu]) => sum + cpu, 0),
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** CPU seconds of each kind of process, now. */
async function cpuNow(scope) {
  const out = {}
  for (const one of await snapshot(scope)) out[one.kind] = (out[one.kind] ?? 0) + one.cpu
  return out
}

/**
 * Wait until the browser is idle: how long that took, and, where it never was, what each kind of
 * process was spending in the last stretch waited.
 */
async function settle(scope) {
  const started = Date.now()
  let before = await cpuNow(scope)
  for (;;) {
    await sleep(QUIET_MS)
    const now = await cpuNow(scope)
    const spent = Object.fromEntries(Object.entries(now).map(([kind, cpu]) => [kind, cpu - (before[kind] ?? 0)]))
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

/**
 * Press a panel's fold button until what the panel holds is on screen. The button is looked for again
 * each time: on a machine that is busy the app can have drawn the map before the panel's own button,
 * and a panel looked for once then was left folded, its rows out of reach.
 */
async function show(page, panel, holds) {
  const deadline = Date.now() + 60_000
  while (!(await page.locator(holds).first().isVisible())) {
    if (Date.now() > deadline) throw new Error(`the ${panel} panel did not open`)
    for (const button of await page.$$(`button[title^="Show the ${panel} panel"]`)) {
      if (await button.isVisible()) {
        await button.click()
        break
      }
    }
    await sleep(600)
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
async function prepare(page, result) {
  await show(page, 'Analysis', '.analysis-row-title')
  const row = page.locator('.analysis-row-title', { hasText: PLAN.task }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await page.waitForSelector('.analysis-drawer', { state: 'visible' })
  // A map still being read is not on screen yet, and a task run against it is refused: "this view has no
  // contact map to run against". A page waiting on the disk spends no CPU, so the browser's being idle
  // does not say the map is there; the app's own word that it has drawn one does (`perf/rendered.ts`).
  // Not the drawer's "will run on", which WebKit leaves saying "no contact map" over a map it has drawn.
  if (PLAN.workspace !== undefined) {
    await page.waitForFunction(
      () => performance.getEntriesByName('chromosomix:rendered', 'mark')
        .some((mark) => mark.detail?.status === 'drawn' && mark.detail.maps.length > 0),
      null, { timeout: Math.min(LIMIT_MS, DRAWN_MS), polling: 500 })
      .catch(() => {
        throw new Error(`the map was not drawn within ${DRAWN_MS / 60_000} minutes`)
      })
    // Once a map is drawn the app measures which of its sequences join their own ends (§8.15), reading
    // behind the view at a few percent of a core, too little to keep the browser from looking idle, and
    // a task run before it has answered treats a circle as a line: the yeast's chrM, in Chromium, whose
    // line then lacked `--circular chrM`. It says it has answered by keeping what it measured; a file it
    // does not measure keeps nothing, and the run goes on after {@link CIRCULARITY_MS}, saying so.
    const started = Date.now()
    const measured = await page.waitForFunction(
      () => Object.keys(sessionStorage).some((key) => key.startsWith('chromosomix:ui:') && key.endsWith(':map:circular-evidence')),
      null, { timeout: CIRCULARITY_MS, polling: 500 }).then(() => true, () => false)
    Object.assign(result, { circularity: measured ? 'measured' : 'not seen', circularity_s: (Date.now() - started) / 1000 })
  }
  await sleep(1000)
  for (const setting of PLAN.set ?? []) await set(page, setting)
  // Nothing left focused, whose caret would blink, nor under the pointer, which would be redrawn
  // for it: each is a frame drawn again and again while the page is meant to be idle.
  await page.evaluate(() => document.activeElement?.blur())
  await page.mouse.move(1, 999)
}

/** Run pressed, and the processes sampled until the console records the run's end. */
async function measure(page, scope, result) {
  const account = new Account()
  const before = (await actions(page)).length
  const rest = account.sample(await snapshot(scope))
  Object.assign(result, { rest_mb: rest.page, all_rest_mb: rest.all, rest_by_kind: rest.byKind })
  const started = Date.now()
  await page.locator('.analysis-drawer button', { hasText: /^run( on ★)?$/ }).first().click()
  let entry
  for (;;) {
    const tick = Date.now()
    const { count } = account.sample(await snapshot(scope))
    result.processes = Math.max(result.processes ?? 0, count)
    entry = (await actions(page)).slice(before).find((one) => one.kind === 'run' && one.status !== 'running')
    if (entry !== undefined || Date.now() - started > LIMIT_MS) break
    await sleep(Math.max(0, EVERY_MS - (Date.now() - tick)))
  }
  // One more sample, so a run that ends between two still has one taken after it.
  account.sample(await snapshot(scope))
  const cpu = account.cpu
  Object.assign(result, {
    waited_s: (Date.now() - started) / 1000,
    cpu_s: cpu.page, peak_mb: account.peak.page,
    all_cpu_s: cpu.all, all_peak_mb: account.peak.all,
    cpu_by_kind: account.cpuByKind, peak_by_kind: account.atPeak, samples: account.samples,
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
  if (!account.sawPage) {
    result.error = `no process of ${BROWSERS[PLAN.browser]}'s that renders the page was found to measure`
    return
  }
  result.status = 'ok'
}

// ---------------------------------------------------------------------------
// The deep map: one session, several tasks
// ---------------------------------------------------------------------------

/**
 * The browser's processes weighed every {@link EVERY_MS} for as long as it runs — what the page's held
 * and what all of them did, with when — and every stretch open at the time given the same weighing.
 */
class Weigher {
  constructor(scope) {
    this.scope = scope
    this.trace = []
    this.open = new Set()
    this.running = false
  }

  async weigh() {
    const processes = await snapshot(this.scope)
    const held = { page: 0, all: 0 }
    for (const one of processes) {
      held.all += one.mb
      if (one.kind === 'page') held.page += one.mb
    }
    this.trace.push({ t: Date.now(), page_mb: held.page, all_mb: held.all })
    for (const account of this.open) account.sample(processes)
  }

  start() {
    this.running = true
    this.loop = (async () => {
      while (this.running) {
        const tick = Date.now()
        await this.weigh()
        await sleep(Math.max(0, EVERY_MS - (Date.now() - tick)))
      }
    })()
  }

  async stop() {
    this.running = false
    await this.loop
  }

  /** A stretch begun: weighed now, then with every weighing until it ends. Its clock starts once it is. */
  async begin() {
    const account = new Account()
    account.sample(await snapshot(this.scope))
    this.open.add(account)
    return { account, t0: Date.now() }
  }

  /** A stretch ended: weighed once more, and what its processes spent and held. */
  async end({ account, t0 }) {
    const t1 = Date.now()
    account.sample(await snapshot(this.scope))
    this.open.delete(account)
    const cpu = account.cpu
    return { t0, t1, cpu_s: cpu.page, peak_mb: account.peak.page, all_cpu_s: cpu.all, all_peak_mb: account.peak.all }
  }
}

/** The number of the app's last report of a picture (`perf/rendered.ts`), 0 before its first. */
function lastDrawn(page) {
  return page.evaluate(() => Math.max(0, ...performance.getEntriesByName('chromosomix:rendered', 'mark')
    .map((mark) => mark.detail?.seq ?? 0)))
}

/**
 * Until the crumb row's resolution stands at the rung of `binsize` and the app has reported a map drawn
 * since its `after`th report. Not the report's own bin size: a whole genome is drawn from a coarser rung
 * than the one a task reads (500 kb, for a human map at 10 kb), and the report names the one drawn.
 */
async function drawnAt(page, binsize, after) {
  await unrefused(page, page.waitForFunction(
    ({ binsize, after }) => {
      const size = (text) => {
        const found = (text ?? '').trim().match(/^([\d.]+)\s*(bp|kb|Mb)\b/)
        return found === null ? NaN : Math.round(Number(found[1]) * { bp: 1, kb: 1e3, Mb: 1e6 }[found[2]])
      }
      const standing = document.querySelector('.crumb-res select.res-pick')?.selectedOptions[0]?.text
      return size(standing) === binsize && performance.getEntriesByName('chromosomix:rendered', 'mark').some((mark) =>
        (mark.detail?.seq ?? 0) > after && mark.detail.status === 'drawn' && mark.detail.maps.length > 0)
    },
    { binsize, after }, { timeout: Math.min(LIMIT_MS, DRAWN_MS), polling: 250 },
  )).catch((error) => {
    throw new Error(`the map was not drawn at ${binsize} bp within ${DRAWN_MS / 60_000} minutes: ${String(error).split('\n')[0]}`)
  })
}

/**
 * The rung of `binsize` picked in the crumb row's resolution, as a reader picks it: in the box beside
 * the slider, which lists every rung the file has. A pick wins over *Refine on zoom*, and is the
 * resolution every task reads (SPECS §3.4, §18.4).
 */
async function pickRung(page, binsize) {
  const picked = await page.evaluate((binsize) => {
    const size = (text) => {
      const found = text.trim().match(/^([\d.]+)\s*(bp|kb|Mb)\b/)
      return found === null ? NaN : Math.round(Number(found[1]) * { bp: 1, kb: 1e3, Mb: 1e6 }[found[2]])
    }
    const select = document.querySelector('.crumb-res select.res-pick')
    const option = [...(select?.options ?? [])].find((one) => !one.hidden && size(one.text) === binsize)
    if (select === null || option === undefined) return null
    if (select.value !== option.value) {
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return option.text
  }, binsize)
  if (picked === null) throw new Error(`the resolution offers no rung of ${binsize} bp`)
}

/** The drawer the last task left open closed, as parity.mjs closes it between its tasks. */
async function closeDrawer(page) {
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) {
    await close.click()
    await sleep(600)
  }
}

/**
 * The map opened once and each step run in turn: a stretch for the opening, and for each step a move to
 * its rung where it needs one and its run. Each stretch is what the result's `steps` keeps, with what
 * the console wrote of the run; `trace` is every weighing, the page's processes and all of them.
 */
async function pipeline(page, scope, result) {
  const weigher = new Weigher(scope)
  result.steps = []
  weigher.start()
  try {
    await page.goto(`${PLAN.base}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.dropzone', { timeout: LIMIT_MS })
    const workspace = join(PLAN.out, `${PLAN.name}.chromosomix.json`)
    writeFileSync(workspace, JSON.stringify(PLAN.workspace, null, 1))
    await drop(page, [workspace])
    await sleep(2000)

    let rung = PLAN.steps[0].binsize
    const opening = await weigher.begin()
    const seen = await lastDrawn(page)
    await drop(page, PLAN.files.map((name) => join(PLAN.data, name)))
    const opened = PLAN.files.filter((name) => !INDEX.test(name)).length
    await unrefused(page, page.waitForFunction(
      (count) => JSON.parse(localStorage.getItem('chromosomix:actions') ?? '{"entries":[]}').entries
        .filter((one) => (one.kind === 'open' || one.kind === 'track') && one.status !== 'running').length >= count,
      opened, { timeout: LIMIT_MS, polling: 250 },
    ))
    await drawnAt(page, rung, seen)
    result.steps.push({ step: 'start-up', stretches: [{ kind: 'opening', ...await weigher.end(opening) }] })
    // The app's measure of which sequences are circles, waited for as `prepare` waits for it.
    await page.waitForFunction(
      () => Object.keys(sessionStorage).some((key) => key.startsWith('chromosomix:ui:') && key.endsWith(':map:circular-evidence')),
      null, { timeout: CIRCULARITY_MS, polling: 500 }).catch(() => {})

    for (const step of PLAN.steps) {
      const done = { step: step.step, stretches: [] }
      result.steps.push(done)
      if (step.binsize !== rung) {
        await settle(scope)
        const moving = await weigher.begin()
        const before = await lastDrawn(page)
        await pickRung(page, step.binsize)
        await drawnAt(page, step.binsize, before)
        done.stretches.push({ kind: 'move', ...await weigher.end(moving) })
        rung = step.binsize
      }
      await closeDrawer(page)
      await show(page, 'Analysis', '.analysis-row-title')
      const row = page.locator('.analysis-row-title', { hasText: step.task }).first()
      await row.scrollIntoViewIfNeeded()
      await row.click()
      await page.waitForSelector('.analysis-drawer', { state: 'visible' })
      await sleep(1000)
      for (const setting of step.set ?? []) await set(page, setting)
      await page.evaluate(() => document.activeElement?.blur())
      await page.mouse.move(1, 999)
      await settle(scope)

      const before = (await actions(page)).length
      const running = await weigher.begin()
      await page.locator('.analysis-drawer button', { hasText: /^run( on ★)?$/ }).first().click()
      let entry
      for (;;) {
        entry = (await actions(page)).slice(before).find((one) => one.kind === 'run' && one.status !== 'running')
        if (entry !== undefined || Date.now() - running.t0 > LIMIT_MS) break
        await sleep(100)
      }
      const ran = await weigher.end(running)
      if (entry === undefined) throw new Error(`${step.step}: the run did not finish`)
      done.stretches.push({ kind: 'run', ...ran, wall_s: entry.ms / 1000 })
      Object.assign(done, { line: entry.line, notes: entry.notes })
      if (entry.status !== 'ok') throw new Error(`${step.step}: ${entry.error ?? entry.status}`)
    }
    result.status = 'ok'
  } finally {
    await weigher.stop()
    result.trace = weigher.trace
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Each browser headless, as Playwright launches it, but for what makes its drawing comparable.
 * **Chromium** is Chromium itself in its headless mode, as the timings and the parity run it, or the
 * one named; WebGL in SwiftShader, as theirs, and the page composited in software, which draws again
 * only what changed. Composited through SwiftShader, every frame of the spinner a running job shows
 * was the whole window drawn again, on the processor: three cores' worth beside a 40-second metaplot,
 * which a reader's browser spends on its GPU. **Firefox** may draw WebGL whatever its blocklist says
 * of the machine's graphics, as Chromium may with `--ignore-gpu-blocklist`. **WebKit** is as
 * Playwright launches it.
 */
const LAUNCH = {
  chromium: {
    channel: 'chromium',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-gpu-compositing'],
  },
  firefox: { firefoxUserPrefs: { 'webgl.force-enabled': true } },
  webkit: {},
}

const TYPE = playwright()[PLAN.browser]

function launch() {
  const { channel, ...options } = LAUNCH[PLAN.browser]
  const which = PLAN.executablePath ? { executablePath: PLAN.executablePath } : channel ? { channel } : {}
  return TYPE.launch({ ...which, ...options })
}

/** The folder the browser runs from: the one named, or Playwright's own; none if it cannot be found. */
function folder() {
  try {
    return dirname(realpathSync(PLAN.executablePath || TYPE.executablePath()))
  } catch {
    return undefined
  }
}

// Which browser a run would be, for the page to name before it runs any.
if (planPath === '--version') {
  try {
    const browser = await launch()
    console.log(browser.version())
    await browser.close()
    process.exit(0)
  } catch (error) {
    // Playwright's first line says what is missing and where; the box under it is for its own tests.
    console.error(String(error.message ?? error).split('\n')[0])
    process.exit(1)
  }
}

mkdirSync(PLAN.out, { recursive: true })
const server = await serve()
PLAN.base = `http://127.0.0.1:${server.address().port}`
const scope = { before: new Set((await listing()).map((one) => one.pid)), folder: folder() }
const result = { name: PLAN.name, browser: PLAN.browser, status: 'failed' }
// A browser that will not start for this run is this run's failure, said in its result, rather than
// the end of the render around it.
const browser = await launch().catch((error) => {
  result.error = `${BROWSERS[PLAN.browser]} did not start: ${String(error.message ?? error).split('\n')[0]}`
  writeFileSync(resultPath, JSON.stringify(result, null, 1))
  server.close()
  console.log(`${result.name} in ${BROWSERS[PLAN.browser]}: failed — ${result.error}`)
  process.exit(0)
})
result.version = browser.version()
try {
  // No service worker: a reader's is installed once and then idle, where a first visit's would be
  // fetching the whole build for its cache in the middle of the measurement.
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  try {
    if (PLAN.steps !== undefined) {
      await pipeline(page, scope, result)
    } else {
      await open(page, result)
      await prepare(page, result)
      const settled = await settle(scope)
      result.settle_s = settled.ms / 1000
      if (!settled.quiet) result.busy = settled.spent
      await measure(page, scope, result)
    }
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
console.log(`${result.name} in ${BROWSERS[PLAN.browser]}: ${result.status}${result.error ? ` — ${result.error}` : ''}`)
