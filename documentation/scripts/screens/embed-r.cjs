/**
 * Pictures for embed/r.md: the R htmlwidget, as the page writes it.
 *
 * The package is this repository's (`widgets/r`), copied into `out-dir` and
 * installed into a library there for the run. Both pictures frame the dev
 * server's build of the viewer, named by CHROMOSOMIX_VIEWER as an address, and
 * read the yeast demo from the lab's bucket.
 *
 * First the page's first chunk, word for word, in an R Markdown document
 * rendered by rmarkdown to HTML and served from this machine by a small HTTP
 * server: the Micro-C map of IV:1.0–1.4 Mb on a log10 scale with its ATAC-seq
 * and gene tracks (r-markdown). Then the page's Shiny app, word for word, run
 * by shiny: the region box, the map, and under it the region the viewer says
 * the reader is on — once as it opens, then after **Go**, with the map gone to
 * the box's region and the line under it following (r-shiny).
 *
 *   apt-get install r-base-core r-cran-htmlwidgets r-cran-httpuv r-cran-jsonlite r-cran-rmarkdown r-cran-shiny   # and pandoc
 *   node documentation/scripts/screens/embed-r.cjs [out-dir]   # r-markdown, r-shiny-open, r-shiny
 */

const { execFileSync, spawn } = require('node:child_process')
const { cpSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { extname, join, resolve } = require('node:path')
const { BASE, sleep, start } = require('./browse-lib.cjs')

const OUT = resolve(process.argv[2] ?? 'screens')
const REPO = resolve(__dirname, '..', '..', '..')
const LIB = join(OUT, 'r-lib')
const SHINY_PORT = Number(process.env.SCREENS_SHINY_PORT ?? 8931)

const RMD = `---
title: "Micro-C of yeast chromosome IV"
output: html_document
---

A map and its tracks, from the lab's bucket.

\`\`\`{r}
library(chromosomix)

yeast <- "https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast"
chromosomix(
  file.path(yeast, "Yeast_microC_G2M_1kb.cool"),
  region = "IV:1000000-1400000",
  tracks = file.path(yeast, c("Yeast_ATAC.bw", "Yeast_annotations.gtf")),
  transform = "log10"
)
\`\`\`
`

const APP = `library(shiny)
library(chromosomix)

map <- "https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool"

ui <- fluidPage(
  textInput("where", "Go to", "IV:1150000-1300000"),
  actionButton("go", "Go"),
  chromosomixOutput("view", height = "800px"),
  verbatimTextOutput("region")
)

server <- function(input, output, session) {
  output$view <- renderChromosomix(chromosomix(map, region = "IV:1000000-1400000"))
  observeEvent(input$go, chromosomix_goto(chromosomixProxy("view"), input$where))
  output$region <- renderText(input$view_state$region)
}

shinyApp(ui, server)
`

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }

;(async () => {
  mkdirSync(LIB, { recursive: true })
  const env = { ...process.env, R_LIBS: LIB, CHROMOSOMIX_VIEWER: `${BASE}/` }
  // Installed from a copy, so that nothing is written beside the package's source.
  cpSync(join(REPO, 'widgets', 'r'), join(OUT, 'r-src'), { recursive: true })
  execFileSync('R', ['CMD', 'INSTALL', '--no-docs', `--library=${LIB}`, join(OUT, 'r-src')], { stdio: 'ignore', env })
  writeFileSync(join(OUT, 'yeast.Rmd'), RMD)
  execFileSync('Rscript', ['-e', `rmarkdown::render(${JSON.stringify(join(OUT, 'yeast.Rmd'))}, quiet = TRUE)`], { stdio: 'inherit', env })
  writeFileSync(join(OUT, 'app.R'), APP)

  // The rendered page, served as a lab's site would serve it.
  const server = createServer((request, response) => {
    const path = join(OUT, decodeURIComponent(new URL(request.url, 'http://x').pathname))
    try {
      const body = readFileSync(path)
      response.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))

  const app = await start(OUT, {
    width: 1440,
    height: 1100,
    // What every frame says: its last finished picture.
    init: () => {
      window.__frameReports = []
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'chromosomix:rendered') window.__frameReports.push(event.data.report)
      })
    },
  })
  const { page } = app
  const drawn = (needles, lanes = 0) =>
    page.waitForFunction(
      ([needles, lanes]) =>
        window.__frameReports.some(
          (r) => r.status === 'drawn' && r.lanes >= lanes && needles.every((needle) => decodeURIComponent(r.state).includes(needle)),
        ),
      [needles, lanes],
      { timeout: 240000 },
    )
  let shiny = null
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/yeast.html`)
    await page.waitForSelector('iframe', { timeout: 60000 })
    await page.locator('iframe').first().scrollIntoViewIfNeeded()
    await drawn(['region=IV:1000000-1400000'], 2)
    await sleep(4000)
    console.log('markdown frame:', JSON.stringify(await page.evaluate(() => window.__frameReports.at(-1))).slice(0, 300))
    await page.mouse.move(4, 4)
    await app.shot('r-markdown', { fullPage: true })

    // The Shiny app.
    shiny = spawn('Rscript', ['-e', `shiny::runApp(${JSON.stringify(join(OUT, 'app.R'))}, port = ${SHINY_PORT}, launch.browser = FALSE)`], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let said = ''
    shiny.stderr.on('data', (chunk) => (said += String(chunk)))
    for (let i = 0; i < 60 && !/Listening on/.test(said); i++) await sleep(1000)
    await page.goto('about:blank')
    await page.goto(`http://127.0.0.1:${SHINY_PORT}/`)
    await drawn(['region=IV:1000000-1400000'])
    await page.waitForFunction(() => /IV:/.test(document.querySelector('#region')?.textContent ?? ''), null, { timeout: 60000 })
    await sleep(3000)
    console.log('shiny, as it opens:', await page.evaluate(() => document.querySelector('#region')?.textContent))
    await page.mouse.move(4, 4)
    await app.shot('r-shiny-open', { fullPage: true })
    await page.click('#go')
    await drawn(['region=IV:1150000-1300000'])
    await page.waitForFunction(() => /1150000/.test(document.querySelector('#region')?.textContent ?? ''), null, { timeout: 60000 })
    await sleep(3000)
    console.log('shiny, after Go:', await page.evaluate(() => document.querySelector('#region')?.textContent))
    await page.mouse.move(4, 4)
    await app.shot('r-shiny', { fullPage: true })
    if (/Error/.test(said)) console.log(said.slice(-1500))
  } finally {
    await app.close()
    server.close()
    if (shiny !== null) shiny.kill('SIGTERM')
  }
})()
