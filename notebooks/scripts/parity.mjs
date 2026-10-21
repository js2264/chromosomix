/**
 * The browser's half of parity.qmd: every task of the plan run in the app, in headless Chromium,
 * and every file it offers for each run saved.
 *
 *   node parity.mjs PLAN.json RESULTS.json
 *
 * PLAN.json is written by the notebook: where the app's build is, the folder the data are in, the
 * folder to save into, and the sessions, in order. A session is a workspace and the files it
 * names, or the files alone, dropped on the landing page as a reader drops them — so every path
 * the app writes, in a file's provenance or on the console's line, is the file's own name — and
 * then its cases, one
 * task each: the task opened from the Analysis panel by its title, its form set as the plan says,
 * run, and every output saved through the buttons a reader presses: the drawer's TSV, BED and
 * BEDPE under each result, and the bigWig and the bedGraph of each track a run adds, from its row
 * on the Tracks card, where the app offers them. A file is saved as `<output>.<format>`, the
 * output's id and the format, under `<out>/<case>/browser/`, which is how the command line names
 * the same file after its stem and the task.
 *
 * What the run's line on the console says (§23) is read from the record the console is drawn
 * from, the line a reader copies to repeat the run in a shell, with the notes above it.
 *
 * A case may take its input from an earlier case: `inputs` copies a file the browser saved for it
 * into the data folder under a name of its own, before the session that names it is opened — the
 * loops called in one session are the loops aggregated in the next.
 *
 * RESULTS.json is written once, at the end: one entry a case, failed ones included.
 */

import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const [planPath, resultsPath] = process.argv.slice(2)
if (planPath === undefined || resultsPath === undefined) {
  console.error('usage: node parity.mjs PLAN.json RESULTS.json')
  process.exit(2)
}
const PLAN = JSON.parse(readFileSync(planPath, 'utf8'))
/** How long a page, a run or a save may take before it is given up. */
const LIMIT_MS = PLAN.limitMs ?? 600_000
/** The buttons that save an output as a file, as they read. */
const DRAWER_FORMATS = { TSV: 'tsv', BED: 'bed', BEDPE: 'bedpe' }
const TRACK_FORMATS = { bigWig: 'bw', bedGraph: 'bedGraph' }

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
// One page
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A hidden file input of this script's own, its files then dropped on the drop zone on screen. */
async function drop(page, paths) {
  await page.evaluate(() => {
    document.getElementById('parity-files')?.remove()
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    input.id = 'parity-files'
    document.body.append(input)
  })
  await page.setInputFiles('#parity-files', paths)
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    for (const file of document.getElementById('parity-files').files) transfer.items.add(file)
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

async function closeDrawer(page) {
  const close = page.locator('.analysis-drawer-head button').last()
  if (await close.isVisible().catch(() => false)) {
    await close.click()
    await sleep(600)
  }
}

/**
 * One setting of the form, by the parameter's key, which the form puts at the end of each control's
 * id: an `option` of a dropdown, by its label, or a `value` typed into a box.
 */
async function set(page, { key, value, option }) {
  const drawer = page.locator('.analysis-drawer')
  if (option !== undefined) {
    const select = drawer.locator(`select[id$="-${key}"]`).first()
    const labels = await select.locator('option').allTextContents()
    // The option of that name, or else the first that holds it.
    const label = labels.find((one) => one.trim() === option) ?? labels.find((one) => one.includes(option))
    if (label === undefined) throw new Error(`--${key} offers no “${option}”: ${labels.join(', ')}`)
    await select.selectOption({ label })
  } else {
    const input = drawer.locator(`input[id$="-${key}"]`).first()
    await input.fill(String(value))
    await input.press('Enter')
  }
  await sleep(400)
}

/** Save what one button writes, under the name `named` gives the name the app suggests, and say what it was. */
async function save(page, button, folder, named, via) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), button.click()])
  const name = named(download.suggestedFilename())
  const path = join(folder, name)
  await download.saveAs(path)
  return { name, via, suggested: download.suggestedFilename(), bytes: statSync(path).size }
}

/** An output's id from the name the drawer suggests for it: `<task>-<output>-<yyyymmdd>-<hhmmss>.<ext>`. */
function outputOf(task, suggested) {
  const match = /^(.*)-\d{8}-\d{6}(?:-\d+)?\.[^.]+$/.exec(suggested)
  const stem = match === null ? suggested.replace(/\.[^.]+$/, '') : match[1]
  return stem.startsWith(`${task}-`) ? stem.slice(task.length + 1) : stem
}

/** One case: the task opened, set, run and every output saved. */
async function runCase(page, session, spec) {
  const folder = join(PLAN.out, spec.id, 'browser')
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  const result = { id: spec.id, session: session.id, title: spec.title, status: 'failed', files: [] }

  await closeDrawer(page)
  await show(page, 'Analysis')
  const row = page.locator('.analysis-row-title', { hasText: spec.title }).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await page.waitForSelector('.analysis-drawer', { state: 'visible' })
  await sleep(1000)
  for (const setting of spec.set ?? []) await set(page, setting)

  const before = (await actions(page)).length
  const rowsBefore = new Set(await page.evaluate(() =>
    [...document.querySelectorAll('.annotation-card .ann-row[data-id^="analysis:"]')].map((one) => one.dataset.id)))
  const started = Date.now()
  await page.locator('.analysis-drawer button', { hasText: /^run( on ★)?$/ }).first().click()
  let entry
  for (;;) {
    entry = (await actions(page)).slice(before).find((one) => one.kind === 'run' && one.status !== 'running')
    if (entry !== undefined || Date.now() - started > LIMIT_MS) break
    await sleep(250)
  }
  await sleep(1000)
  await page.screenshot({ path: join(PLAN.out, spec.id, 'browser.png') })
  if (entry === undefined) {
    result.error = 'the run did not finish'
    return result
  }
  Object.assign(result, { line: entry.line, notes: entry.notes, provenance: entry.detail, ms: entry.ms })
  if (entry.status !== 'ok') {
    result.error = entry.error ?? entry.status
    return result
  }
  const task = entry.line.split(' ')[1]
  result.task = task

  // Under the result, a TSV for every output and a BED or a BEDPE for every called set.
  for (const button of await page.locator('.analysis-drawer-body button').all()) {
    const text = (await button.innerText()).trim()
    if (!(text in DRAWER_FORMATS) || !(await button.isVisible())) continue
    await button.scrollIntoViewIfNeeded()
    const named = (suggested) => `${outputOf(task, suggested)}.${DRAWER_FORMATS[text]}`
    result.files.push(await save(page, button, folder, named, 'drawer'))
  }

  // And on the Tracks card, a track's bigWig and bedGraph, from the row the run added.
  await closeDrawer(page)
  await show(page, 'Annotations')
  const rows = (await page.evaluate(() =>
    [...document.querySelectorAll('.annotation-card .ann-row[data-id^="analysis:"]')].map((one) => one.dataset.id)))
    .filter((id) => !rowsBefore.has(id))
  for (const id of rows) {
    const row = page.locator(`.annotation-card .ann-row[data-id="${id}"]`).first()
    await row.scrollIntoViewIfNeeded()
    const buttons = row.locator('.ann-exports button')
    if ((await buttons.count()) === 0) {
      await row.locator('.ann-more').first().click()
      await sleep(500)
    }
    const output = id.split(':').at(-1)
    for (const button of await buttons.all()) {
      const text = (await button.innerText()).trim()
      if (!(text in TRACK_FORMATS)) continue
      result.files.push(await save(page, button, folder, () => `${output}.${TRACK_FORMATS[text]}`, 'track'))
    }
  }
  result.status = 'ok'
  return result
}

/** Every case of a session, failed for one reason: a session that did not open runs none of them. */
function failAll(session, results, error) {
  for (const spec of session.cases) {
    if (results.some((one) => one.id === spec.id)) continue
    results.push({ id: spec.id, session: session.id, title: spec.title, status: 'failed', files: [], error })
    console.log(`${spec.id}: failed — ${error}`)
  }
}

/**
 * Wait for `wait`, unless the app puts a dialog up first: no file of a plan asks a question, so a
 * dialog while a session opens is the app refusing one, and its words are the error rather than a
 * wait that runs out.
 */
async function unrefused(page, wait) {
  const refused = page.waitForSelector('.modal-panel', { state: 'visible', timeout: LIMIT_MS }).then(async (panel) => {
    throw new Error(`the app said “${(await panel.innerText()).replace(/\s+/g, ' ').trim()}”`)
  })
  await Promise.race([wait, refused])
}

/** Drop the session's workspace, where it has one, and then its files; wait for what the app says once they are open. */
async function open(page, session) {
  await page.goto(`${PLAN.base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.dropzone', { timeout: LIMIT_MS })
  // A workspace first, and then the files it asks for; without one, the files alone, which is how a
  // reader opens tracks with no map.
  if (session.workspace !== undefined) {
    const workspace = join(PLAN.out, `${session.id}.chromosomix.json`)
    writeFileSync(workspace, JSON.stringify(session.workspace, null, 1))
    await drop(page, [workspace])
    await sleep(2000)
  }
  await drop(page, session.files.map((name) => join(PLAN.data, name)))
  await unrefused(page, page.waitForFunction(
    (opened) => JSON.parse(localStorage.getItem('chromosomix:actions') ?? '{"entries":[]}').entries
      .filter((one) => one.kind === 'open' || one.kind === 'track').length >= opened,
    session.files.length,
    { timeout: LIMIT_MS },
  ))
  // What the app measures once a file is open and says in a notice — that a sequence reads as
  // circular — is a fact of the framing every run records, so the runs wait for it.
  if (session.waitFor !== undefined) {
    await unrefused(page, page.waitForFunction((text) => document.body.innerText.includes(text), session.waitFor,
      { timeout: LIMIT_MS }))
  }
  await sleep(3000)
}

/** One session: opened, then each of its cases. */
async function runSession(browser, session, results) {
  for (const input of session.inputs ?? []) {
    const from = join(PLAN.out, input.from)
    if (!existsSync(from)) {
      failAll(session, results, `${input.from} was not saved, and this session opens it`)
      return
    }
    copyFileSync(from, join(PLAN.data, input.as))
  }
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
  // No save dialog: an export arrives as the plain download it is where the browser has none.
  await context.addInitScript(() => {
    delete window.showSaveFilePicker
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  try {
    try {
      await open(page, session)
    } catch (error) {
      await page.screenshot({ path: join(PLAN.out, `${session.id}.png`) }).catch(() => {})
      failAll(session, results, `the session did not open: ${error}`)
      return
    }
    for (const spec of session.cases) {
      let result
      try {
        result = await runCase(page, session, spec)
      } catch (error) {
        result = { id: spec.id, session: session.id, title: spec.title, status: 'failed', files: [], error: String(error) }
      }
      result.pageErrors = errors.splice(0)
      results.push(result)
      console.log(`${spec.id}: ${result.status}, ${result.files.length} files${result.error ? ` — ${result.error}` : ''}`)
    }
  } finally {
    await context.close()
  }
}

const server = await serve()
PLAN.base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({
  // Chromium itself in its headless mode, as the timings run it, or the one the plan names.
  ...(PLAN.executablePath ? { executablePath: PLAN.executablePath } : { channel: 'chromium' }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const results = []
try {
  for (const session of PLAN.sessions) await runSession(browser, session, results)
} finally {
  writeFileSync(resultsPath, JSON.stringify({ chromium: browser.version(), cases: results }, null, 1))
  await browser.close()
  server.close()
}
