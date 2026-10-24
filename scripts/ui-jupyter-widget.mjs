/**
 * Drive the Jupyter widget's demo notebook in JupyterLab, in headless Chromium (§21.4).
 *
 * `widgets/python/demo.ipynb`, run whole as a reader runs it: the map and its
 * three tracks in the first widget, the cell that follows where the reader is,
 * `goto` and an O/E `navigate` from Python, a 3D model added beside the map, and
 * a 1D browser moved by `goto`. Every widget is shot once its frame has drawn
 * what was asked of it — waited for by the viewer's own `chromosomix:rendered`,
 * whose report carries the view state — and every message each frame sent is
 * printed, so a frame that never spoke is a line in the log rather than a blank
 * in a picture. The notebook is put back as it was: JupyterLab saves the
 * outputs it ran into it.
 *
 *   npm run build:package            # a viewer with a relative base, in dist/
 *   pip install -e widgets/python
 *   CHROMOSOMIX_VIEWER=$PWD/dist jupyter lab --no-browser --port 8899 --IdentityProvider.token='' &
 *   node scripts/ui-jupyter-widget.mjs [out-dir]
 *
 * `GALLERY_LAB` names another JupyterLab than http://127.0.0.1:8899.
 * `GALLERY_OLD_VIEWER` names a build from before `chromosomix:add` — npm's
 * `chromosomix@0.16.0`, its `package/dist` — and adds one shot: a notebook,
 * written under `gallery/` for the run, framing the map and its tracks in that
 * build, which draws the map alone and says above it what it could not add (jw04).
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

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
// JupyterLab saves the outputs it ran into the notebook; it is put back as it was.
const NOTEBOOK = 'widgets/python/demo.ipynb'
const pristine = readFileSync(NOTEBOOK, 'utf8')
process.on('exit', () => writeFileSync(NOTEBOOK, pristine))
const LAB = (process.env.GALLERY_LAB ?? 'http://127.0.0.1:8899').replace(/\/$/, '')
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// What every frame says, as the widget hears it: each message, and the last
// finished picture each frame reported (§12), its report kept whole.
await context.addInitScript(() => {
  window.__last = new Map()
  window.__heard = []
  window.addEventListener('message', (event) => {
    const type = event.data?.type
    if (typeof type !== 'string' || !type.startsWith('chromosomix:')) return
    const frames = [...document.querySelectorAll('.jp-OutputArea iframe')]
    const at = frames.findIndex((frame) => frame.contentWindow === event.source)
    const report = event.data.report
    window.__heard.push(
      `${(performance.now() / 1000).toFixed(1)}s frame ${at} ${type}` +
        (report ? ` ${report.status}, ${report.maps?.length} map(s), ${report.lanes} lane(s)` : ''),
    )
    if (type === 'chromosomix:rendered' && at >= 0) window.__last.set(frames[at], report)
  })
})

// A kernel left from an earlier run holds the widget's code as it was imported
// then, and Run All does not import it again: every kernel goes first.
for (const kernel of await (await fetch(`${LAB}/api/kernels`)).json()) {
  await fetch(`${LAB}/api/kernels/${kernel.id}`, { method: 'DELETE' })
}

await page.goto(`${LAB}/lab/tree/widgets/python/demo.ipynb`)
await page.waitForSelector('.jp-Notebook', { timeout: 120000 })
await sleep(4000)
// JupyterLab's question about its news feed, which sits over the first frame's corner.
await page
  .locator('.jp-toast-container button, .Toastify button', { hasText: /^No$/ })
  .first()
  .click({ timeout: 5000 })
  .catch(() => {})

// Run → Run All Cells.
await page.locator('.lm-MenuBar-itemLabel', { hasText: /^Run$/ }).click()
await page.locator('.lm-Menu-itemLabel', { hasText: /^Run All Cells$/ }).click()
await page.waitForFunction(
  () => {
    const prompts = [...document.querySelectorAll('.jp-CodeCell .jp-InputArea-prompt')].map((p) => p.textContent ?? '')
    return prompts.length > 0 && prompts.every((p) => /\[\d+\]/.test(p))
  },
  null,
  { timeout: 300000 },
)
console.log('every cell ran')

const frames = page.locator('.jp-OutputArea iframe')
await page.waitForFunction(() => document.querySelectorAll('.jp-OutputArea iframe').length >= 2, null, { timeout: 60000 })

/**
 * Bring the n-th frame on screen and wait for it to report a finished picture
 * of what was asked of it. On screen first: Run All leaves the notebook at its
 * last cell, and Chromium makes no animation frames for a cross-origin frame
 * scrolled out of sight, so a frame up the page never finishes its last paint
 * until it is looked at — as a reader's would not either.
 */
const settle = async (index, wanted, what) => {
  await frames.nth(index).scrollIntoViewIfNeeded()
  const ok = await page
    .waitForFunction(
      ([at, needles]) => {
        const frame = document.querySelectorAll('.jp-OutputArea iframe')[at]
        const report = frame === undefined ? undefined : window.__last.get(frame)
        return report !== undefined && report.status === 'drawn' && needles.every((needle) => report.state.includes(needle))
      },
      [index, wanted],
      { timeout: 90000 },
    )
    .then(
      () => true,
      () => false,
    )
  const report = await page.evaluate((at) => window.__last.get(document.querySelectorAll('.jp-OutputArea iframe')[at]) ?? null, index)
  console.log(`${what}: ${ok ? 'drawn' : 'NOT DRAWN'} —`, report === null ? 'no report' : `${report.lanes} lane(s), ${decodeURIComponent(report.state)}`)
  return ok
}

/** The output area of the n-th frame, shot. */
const shotFrame = async (index, name) => {
  const output = frames.nth(index).locator('xpath=ancestor::div[contains(@class,"jp-OutputArea-output")][1]')
  await output.scrollIntoViewIfNeeded()
  await sleep(1500)
  await output.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}

/** What a cell's output says, found by a piece of its code. */
const cellText = async (match) =>
  page.evaluate((needle) => {
    for (const cell of document.querySelectorAll('.jp-CodeCell')) {
      const code = cell.querySelector('.jp-InputArea-editor')?.textContent ?? ''
      if (code.includes(needle)) return (cell.querySelector('.jp-OutputArea')?.textContent ?? '').trim()
    }
    return null
  }, match)

// The map: framed by `goto`, O/E by `navigate`, its three tracks and the model beside it.
await settle(0, ['region=IV:1150000-1300000', 'oe=true', 'maps='], 'the map')
await shotFrame(0, 'jw01-map-and-tracks')
console.log('the cell that follows the reader says:', await cellText("names='state'"))

// The whole notebook from the top, as a reader scrolls it.
await page.locator('.jp-Cell').first().scrollIntoViewIfNeeded()
await sleep(1000)
await page.screenshot({ path: `${OUT}/jw00-notebook.png` })
console.log('shot jw00-notebook')

// The 1D browser, its three tracks and the locus `goto` gave it.
await settle(1, ['view=browser', 'locus='], 'the browser')
await shotFrame(1, 'jw02-browser')
console.log('the last cell says:', await cellText('view.viewer'))

// What drove it: the cell that follows the reader, and the calls under it.
await page.evaluate(() => {
  for (const cell of document.querySelectorAll('.jp-CodeCell')) {
    if ((cell.querySelector('.jp-InputArea-editor')?.textContent ?? '').includes("names='state'")) {
      cell.scrollIntoView({ block: 'start' })
      return
    }
  }
})
await sleep(1000)
await page.screenshot({ path: `${OUT}/jw03-driven-from-python.png` })
console.log('shot jw03-driven-from-python')

console.log(`--- what the frames said\n${(await page.evaluate(() => window.__heard)).join('\n')}`)

// A viewer from before `add`: the map drawn alone, and the cell saying why.
if (process.env.GALLERY_OLD_VIEWER) {
  const demo = join(process.cwd(), 'demo', 'yeast')
  const notebook = join(OUT, 'old-viewer.ipynb')
  const code = [
    'from chromosomix import Chromosomix',
    `DEMO = ${JSON.stringify(demo)}`,
    'view = Chromosomix(',
    "    f'{DEMO}/Yeast_microC_G2M_1kb.cool',",
    "    region='IV:1000000-1400000',",
    "    tracks=[f'{DEMO}/Yeast_ATAC.bw', f'{DEMO}/Yeast_MNase.bw', f'{DEMO}/Yeast_annotations.gtf'],",
    "    transform='log10',",
    '    height=620,',
    `    viewer=${JSON.stringify(process.env.GALLERY_OLD_VIEWER)},`,
    ')',
    'view',
  ].join('\n')
  writeFileSync(
    notebook,
    JSON.stringify({
      cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: code }],
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
      nbformat: 4,
      nbformat_minor: 5,
    }),
  )
  const old = await context.newPage()
  await old.goto(`${LAB}/lab/tree/${relative(process.cwd(), notebook)}`)
  await old.waitForSelector('.jp-Notebook', { timeout: 120000 })
  await sleep(4000)
  await old.locator('.lm-MenuBar-itemLabel', { hasText: /^Run$/ }).click()
  await old.locator('.lm-Menu-itemLabel', { hasText: /^Run All Cells$/ }).click()
  const said = await old
    .waitForSelector('.jp-OutputArea [role="status"]:not([hidden])', { timeout: 120000 })
    .then((element) => element.textContent())
    .catch(() => null)
  console.log('the old viewer:', said === null ? 'NO NOTICE' : `the cell says: ${said}`)
  await sleep(4000)
  await old.locator('.jp-OutputArea-output').first().screenshot({ path: `${OUT}/jw04-old-viewer-notice.png` })
  console.log('shot jw04-old-viewer-notice')
  rmSync(notebook, { force: true })
}

await browser.close()
if (errors.length > 0) console.log(`--- page errors\n${errors.join('\n')}`)
