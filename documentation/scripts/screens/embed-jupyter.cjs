/**
 * Pictures for embed/jupyter.md: the Python widget in a JupyterLab cell — the
 * page's first cell, word for word, run: the yeast Micro-C demo on the lab's
 * bucket framed on IV:1.0–1.4 Mb on a log10 scale, with its ATAC-seq and gene
 * tracks put beside it once it is drawn.
 *
 * The script writes the notebook into `out-dir`, starts a JupyterLab on it, runs
 * the cell and waits for the frame's own `chromosomix:rendered` to report the
 * map drawn with its two lanes — then shuts the JupyterLab down. The widget is
 * this repository's (`widgets/python/src`, put on the kernel's PYTHONPATH rather
 * than installed), and it frames the dev server's build of the viewer, named by
 * CHROMOSOMIX_VIEWER as an address.
 *
 *   python3 -m venv <venv> && <venv>/bin/pip install jupyterlab anywidget traitlets
 *   JUPYTER=<venv>/bin/jupyter node documentation/scripts/screens/embed-jupyter.cjs [out-dir]   # jp-cell
 */

const { spawn } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { BASE, sleep, start } = require('./browse-lib.cjs')

const OUT = resolve(process.argv[2] ?? 'screens')
const REPO = resolve(__dirname, '..', '..', '..')
const PORT = Number(process.env.SCREENS_LAB_PORT ?? 8911)
const LAB = `http://127.0.0.1:${PORT}`

const CELL = [
  'from chromosomix import Chromosomix',
  '',
  "yeast = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/'",
  'view = Chromosomix(',
  "    yeast + 'Yeast_microC_G2M_1kb.cool',",
  "    region='IV:1000000-1400000',",
  "    tracks=[yeast + 'Yeast_ATAC.bw', yeast + 'Yeast_annotations.gtf'],",
  "    transform='log10',",
  ')',
  'view',
]

const notebook = {
  cells: [
    {
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      outputs: [],
      source: CELL.map((line, i) => (i < CELL.length - 1 ? `${line}\n` : line)),
    },
  ],
  metadata: {
    kernelspec: { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' },
    language_info: { name: 'python' },
  },
  nbformat: 4,
  nbformat_minor: 5,
}

;(async () => {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'yeast.ipynb'), JSON.stringify(notebook, null, 1))
  // JupyterLab's own settings, kept with the run: no question about its news feed.
  const settings = join(OUT, 'lab-settings', '@jupyterlab', 'apputils-extension')
  mkdirSync(settings, { recursive: true })
  writeFileSync(join(settings, 'notification.jupyterlab-settings'), JSON.stringify({ fetchNews: 'false', checkForUpdates: false }))
  const lab = spawn(
    process.env.JUPYTER ?? 'jupyter',
    ['lab', '--no-browser', '--allow-root', `--port=${PORT}`, '--IdentityProvider.token=', `--ServerApp.root_dir=${OUT}`],
    {
      env: {
        ...process.env,
        CHROMOSOMIX_VIEWER: `${BASE}/`,
        PYTHONPATH: join(REPO, 'widgets', 'python', 'src'),
        JUPYTERLAB_SETTINGS_DIR: join(OUT, 'lab-settings'),
        JUPYTERLAB_WORKSPACES_DIR: join(OUT, 'lab-workspaces'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let said = ''
  lab.stderr.on('data', (chunk) => (said += String(chunk)))
  const app = await start(OUT, {
    width: 1440,
    height: 1000,
    // What every frame says, as the widget hears it: the last finished picture.
    init: () => {
      window.__frameReports = []
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'chromosomix:rendered') window.__frameReports.push(event.data.report)
      })
    },
  })
  const { page } = app
  try {
    for (let i = 0; i < 120; i++) {
      if (await fetch(`${LAB}/api/status`).then((r) => r.ok, () => false)) break
      await sleep(1000)
    }
    await page.goto(`${LAB}/lab/tree/yeast.ipynb`)
    await page.waitForSelector('.jp-Notebook .jp-CodeCell', { timeout: 120000 })
    await sleep(5000)
    await page
      .locator('.jp-toast-container button, .Toastify button', { hasText: /^No$/ })
      .first()
      .click({ timeout: 3000 })
      .catch(() => {})
    // The file browser folded, so that the cell has the width: a press on the
    // left sidebar's open tab puts its panel away.
    await page.locator('.jp-SideBar.jp-mod-left .lm-TabBar-tab.lm-mod-current').first().click()
    await sleep(800)
    await page.locator('.lm-MenuBar-itemLabel', { hasText: /^Run$/ }).click()
    await page.locator('.lm-Menu-itemLabel', { hasText: /^Run All Cells$/ }).click()
    await page.waitForSelector('.jp-OutputArea iframe', { timeout: 180000 })
    await page.waitForFunction(
      () => window.__frameReports.some((r) => r.status === 'drawn' && r.lanes >= 2),
      null,
      { timeout: 240000 },
    )
    await sleep(4000)
    console.log('frame reported:', JSON.stringify(await page.evaluate(() => window.__frameReports.at(-1))).slice(0, 400))
    await page.mouse.move(8, 990)
    await sleep(500)
    await app.shot('jp-cell')
  } finally {
    await app.close()
    lab.kill('SIGTERM')
    if (said.includes('Traceback')) console.log(said.slice(-1500))
  }
})()
