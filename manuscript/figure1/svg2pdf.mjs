/**
 * figure1.svg → figure1.pdf (vector, fonts embedded, heatmaps as images) and
 * figure1.png (a 300-dpi preview), through headless Chromium's print path.
 *
 *   node manuscript/figure1/svg2pdf.mjs [figure1.svg]
 *
 * The page is the SVG's own size in millimetres, with no margins, so the PDF's
 * MediaBox is exactly the figure. The preview is drawn from the PDF with
 * poppler's pdftoppm, so it shows what a reader of the PDF sees.
 */

import { createRequire } from 'node:module'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const here = dirname(fileURLToPath(import.meta.url))
const svgPath = resolve(process.argv[2] ?? join(here, 'figure1.svg'))
const pdfPath = svgPath.replace(/\.svg$/, '.pdf')
const pngPath = svgPath.replace(/\.svg$/, '.png')
const svg = readFileSync(svgPath, 'utf8')
const w = Number(/width="([\d.]+)mm"/.exec(svg)[1])
const h = Number(/height="([\d.]+)mm"/.exec(svg)[1])

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const browser = await chromium.launch({ ...(executablePath === undefined ? {} : { executablePath }), args: ['--no-sandbox'] })
const page = await browser.newPage()
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: ${w}mm ${h}mm; margin: 0 }
  html, body { margin: 0; padding: 0; background: #fff }
  img, svg { display: block; width: ${w}mm; height: ${h}mm }
</style></head><body><img src="${pathToFileURL(svgPath).href}"></body></html>`
const htmlPath = join(dirname(svgPath), '.figure-print.html')
writeFileSync(htmlPath, html)
await page.goto(pathToFileURL(htmlPath).href)
await page.waitForLoadState('networkidle')
await page.pdf({ path: pdfPath, width: `${w}mm`, height: `${h}mm`, printBackground: true, pageRanges: '1' })
await browser.close()
execFileSync('rm', ['-f', htmlPath])
execFileSync('pdftoppm', ['-png', '-r', process.env.DPI ?? '300', '-singlefile', pdfPath, pngPath.replace(/\.png$/, '')])
console.log(`wrote ${pdfPath} and ${pngPath}`)
