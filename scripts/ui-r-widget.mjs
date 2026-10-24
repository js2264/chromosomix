/**
 * Drive the R htmlwidget's two demos in headless Chromium (§21.5).
 *
 * `widgets/r/inst/examples/demo.Rmd`, rendered by R Markdown with the repository's
 * yeast demo from this disk and the package build in `dist/`, then served from
 * the R session that rendered it — its file server is what the frames read —
 * and shot widget by widget: the map and its three tracks; the same map moved
 * before it was drawn by `chromosomix_goto()`, `chromosomix_navigate()` and
 * `chromosomix_add()`; a 1D browser placed by `chromosomix_goto()`. Then
 * `widgets/r/inst/examples/app.R` in Shiny, driven through its own controls — a
 * region typed and gone to, observed / expected ticked, the 3D model added —
 * with the state the viewer sent back to R printed under them.
 *
 * Every widget is shot once its frame has reported a finished picture of what
 * was asked of it (`chromosomix:rendered`, whose report carries the view state),
 * after it is scrolled into view: Chromium makes no animation frames for a
 * cross-origin frame out of sight, so a frame down the page never finishes its
 * last paint until it is looked at.
 *
 *   npm run build:package            # a viewer with a relative base, in dist/
 *   node scripts/ui-r-widget.mjs [out-dir]
 *
 * Needs R with htmlwidgets, httpuv, jsonlite, rmarkdown and shiny, and pandoc;
 * the package is installed into `<out-dir>/r-lib/` for the run.
 *
 * `GALLERY_OLD_VIEWER` names a build from before `chromosomix:add` — npm's
 * `chromosomix@0.16.0`, its `package/dist` — and adds one shot: the map and its
 * tracks in that frame, which draws the map alone and says above it what it
 * could not add (rw06).
 */

import { createRequire } from 'node:module'
import { execFileSync, execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
const REPO = resolve('.')
const WORK = join(OUT, 'r-widget')
const LIB = join(WORK, 'r-lib')
mkdirSync(LIB, { recursive: true })
if (!existsSync(join(REPO, 'dist', 'index.html'))) throw new Error('No dist/: run `npm run build:package` first.')

execFileSync('R', ['CMD', 'INSTALL', '--no-docs', `--library=${LIB}`, join(REPO, 'widgets', 'r')], { stdio: 'ignore' })
const env = { ...process.env, R_LIBS: LIB, CHROMOSOMIX_VIEWER: join(REPO, 'dist') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** An R process that prints one line — an address — once it is serving, and keeps serving. */
const serving = (code, extra = {}) =>
  new Promise((done, fail) => {
    const child = spawn('Rscript', ['-e', code], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    let said = ''
    child.stdout.on('data', (chunk) => {
      said += String(chunk)
      const found = /SERVING (\S+)/.exec(said)
      if (found !== null) done({ child, url: found[1] })
    })
    let err = ''
    child.stderr.on('data', (chunk) => (err += String(chunk)))
    child.on('exit', (code) => {
      // Before it served, a failure; after, what it said, for the log.
      fail(new Error(`R exited (${code}) before serving:\n${err.slice(-2000)}`))
      if (code !== null && code !== 0) console.log(`--- R exited (${code})\n${err.slice(-2000)}`)
    })
  })

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 })
const errors = []

// What every frame says, as the widget hears it: the last finished picture each reported.
await context.addInitScript(() => {
  window.__last = new Map()
  window.__heard = []
  window.addEventListener('message', (event) => {
    const type = event.data?.type
    if (typeof type !== 'string' || !type.startsWith('chromosomix:')) return
    const frames = [...document.querySelectorAll('.html-widget iframe')]
    const at = frames.findIndex((frame) => frame.contentWindow === event.source)
    const report = event.data.report
    window.__heard.push(
      `${(performance.now() / 1000).toFixed(1)}s frame ${at} ${type}` +
        (report ? ` ${report.status}, ${report.maps?.length} map(s), ${report.lanes} lane(s)` : ''),
    )
    if (type === 'chromosomix:rendered' && at >= 0) window.__last.set(frames[at], report)
  })
})

/** Bring the n-th widget's frame on screen and wait for a report of what was asked of it. */
const settle = async (page, index, wanted, what, lanes = 0) => {
  const frame = page.locator('.html-widget iframe').nth(index)
  await frame.scrollIntoViewIfNeeded()
  const ok = await page
    .waitForFunction(
      ([at, needles, least]) => {
        const element = document.querySelectorAll('.html-widget iframe')[at]
        const report = element === undefined ? undefined : window.__last.get(element)
        return (
          report !== undefined &&
          report.status === 'drawn' &&
          report.lanes >= least &&
          needles.every((needle) => report.state.includes(needle))
        )
      },
      [index, wanted, lanes],
      { timeout: 90000 },
    )
    .then(
      () => true,
      () => false,
    )
  const report = await page.evaluate(
    (at) => window.__last.get(document.querySelectorAll('.html-widget iframe')[at]) ?? null,
    index,
  )
  console.log(`${what}: ${ok ? 'drawn' : 'NOT DRAWN'} —`, report === null ? 'no report' : `${report.lanes} lane(s), ${decodeURIComponent(report.state)}`)
  return ok
}

const shoot = async (locator, name) => {
  await locator.scrollIntoViewIfNeeded()
  await sleep(1500)
  await locator.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}

// --- R Markdown -------------------------------------------------------------

const rendered = await serving(`
  html <- rmarkdown::render(
    ${JSON.stringify(join(REPO, 'widgets', 'r', 'inst', 'examples', 'demo.Rmd'))},
    output_dir = ${JSON.stringify(WORK)},
    params = list(data = ${JSON.stringify(join(REPO, 'demo', 'yeast'))}),
    quiet = TRUE
  )
  cat("SERVING", chromosomix::serve(html), "\\n")
  repeat httpuv::service(100)
`)
console.log('rendered and served at', rendered.url)
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(rendered.url)
await page.waitForSelector('.html-widget iframe')

const widget = (index) => page.locator('.html-widget').nth(index)
await settle(page, 0, ['region=IV:1000000-1400000', 'transform=log10'], 'the map', 3)
// The page from its top, its first widget drawn.
await page.evaluate(() => window.scrollTo(0, 0))
await sleep(1000)
await page.screenshot({ path: `${OUT}/rw00-rmarkdown-page.png` })
console.log('shot rw00-rmarkdown-page')
await shoot(widget(0), 'rw01-rmarkdown-map')
await settle(page, 1, ['region=IV:1150000-1300000', 'oe=true', 'maps='], 'the map moved before it was drawn', 3)
await shoot(widget(1), 'rw02-rmarkdown-moved')
await settle(page, 2, ['view=browser', 'locus='], 'the browser', 3)
await shoot(widget(2), 'rw03-rmarkdown-browser')
console.log(`--- what the frames said\n${(await page.evaluate(() => window.__heard)).join('\n')}`)
await page.close()
rendered.child.kill()

// --- Shiny ------------------------------------------------------------------

const port = 8700 + Math.floor(Math.random() * 200)
const shiny = await serving(
  `
  app <- shiny::shinyAppFile(${JSON.stringify(join(REPO, 'widgets', 'r', 'inst', 'examples', 'app.R'))})
  cat("SERVING", "http://127.0.0.1:${port}/", "\\n")
  shiny::runApp(app, port = ${port}, launch.browser = FALSE, host = "127.0.0.1")
`,
  { CHROMOSOMIX_DEMO: join(REPO, 'demo', 'yeast') },
)
// Listening once it answers: R loads its packages first.
for (let tries = 0; tries < 120; tries += 1) {
  const up = await fetch(shiny.url).then(
    (response) => response.ok,
    () => false,
  )
  if (up) break
  await sleep(500)
}
const app = await context.newPage()
app.on('pageerror', (e) => errors.push(String(e)))
await app.goto(shiny.url)
await app.waitForSelector('.html-widget iframe', { state: 'attached', timeout: 60000 })
const stateText = async () => (await app.locator('#state').textContent())?.trim()

await settle(app, 0, ['region=IV:1000000-1400000', 'transform=log10'], 'the Shiny map', 3)
await app.waitForFunction(() => (document.querySelector('#state')?.textContent ?? '').includes('region'), null, { timeout: 30000 })
console.log(`R was told:\n${await stateText()}`)
await app.screenshot({ path: `${OUT}/rw04-shiny.png` })
console.log('shot rw04-shiny')

// The controls, each a request through the proxy: a region, O/E, the model.
await app.locator('#where').fill('IV:1150000-1300000')
await app.locator('#go').click()
await settle(app, 0, ['region=IV:1150000-1300000'], 'gone to')
await app.locator('#oe').check()
await settle(app, 0, ['oe=true'], 'observed / expected')
// The viewer put the map on a log2 scale for O/E, and the sidebar follows it.
await app
  .waitForFunction(() => document.querySelector('input[name="transform"]:checked')?.value === 'log2', null, { timeout: 15000 })
  .then(
    () => console.log('the scale buttons follow the viewer: log2'),
    () => console.log('the scale buttons DID NOT follow the viewer'),
  )
await app.locator('#model').click()
await settle(app, 0, ['maps=', 'oe=true', 'region=IV:1150000-1300000'], 'the model added')
// R hears the frame's last state a moment after the frame said it.
await app.waitForFunction(
  () => {
    const said = document.querySelector('#state')?.textContent ?? ''
    return said.includes('1150000') && said.includes('3d')
  },
  null,
  { timeout: 30000 },
)
console.log(`R was told:\n${await stateText()}`)
await sleep(1500)
await app.screenshot({ path: `${OUT}/rw05-shiny-driven.png` })
console.log('shot rw05-shiny-driven')
console.log(`--- what the frame said\n${(await app.evaluate(() => window.__heard)).join('\n')}`)

shiny.child.kill()

// --- A viewer from before `add` --------------------------------------------

if (process.env.GALLERY_OLD_VIEWER) {
  const old = await serving(`
    library(chromosomix)
    view <- suppressWarnings(chromosomix(
      ${JSON.stringify(join(REPO, 'demo', 'yeast', 'Yeast_microC_G2M_1kb.cool'))},
      region = "IV:1000000-1400000",
      tracks = file.path(${JSON.stringify(join(REPO, 'demo', 'yeast'))}, c("Yeast_ATAC.bw", "Yeast_MNase.bw", "Yeast_annotations.gtf")),
      transform = "log10", height = 620, viewer = ${JSON.stringify(process.env.GALLERY_OLD_VIEWER)}
    ))
    page <- file.path(${JSON.stringify(WORK)}, "old-viewer.html")
    htmlwidgets::saveWidget(view, page, selfcontained = FALSE)
    cat("SERVING", serve(page), "\\n")
    repeat httpuv::service(100)
  `)
  const before = await context.newPage()
  await before.goto(old.url)
  await before.waitForSelector('.html-widget [role="status"]:not([hidden])', { timeout: 60000 }).then(
    () => console.log('the old viewer: the notice is shown'),
    () => console.log('the old viewer: NO NOTICE'),
  )
  console.log('it says:', (await before.locator('.html-widget [role="status"]').textContent())?.trim())
  await sleep(4000)
  await before.screenshot({ path: `${OUT}/rw06-old-viewer-notice.png` })
  console.log('shot rw06-old-viewer-notice')
  old.child.kill()
}

await browser.close()
if (errors.length > 0) console.log(`--- page errors\n${errors.join('\n')}`)
