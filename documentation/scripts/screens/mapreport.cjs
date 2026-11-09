/**
 * The map report on the yeast Micro-C demo (the picture of
 * `analyses/mapreport.mdx`): a run, its *HTML report* saved — with no save
 * dialog, so it arrives as a download — and the page it saves opened on its
 * own, on its Overview tab.
 *
 *   node documentation/scripts/screens/mapreport.cjs <out-dir>
 *
 * mapreport-01-overview        the saved page, Overview, the window
 * mapreport-01-overview-full   the same, the whole page
 */

const { join, resolve } = require('node:path')
const { mkdirSync } = require('node:fs')
const { DEMO, sleep, start } = require('./analyses-2d-lib.cjs')

const OUT = process.argv[2] ?? 'screens/analyses'

;(async () => {
  const s = await start(OUT)
  const { page, context } = s
  mkdirSync(join(OUT, 'files'), { recursive: true })
  await context.addInitScript(() => {
    window.showSaveFilePicker = undefined
  })
  try {
    await s.open(`#uri=${DEMO}yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000`)
    await s.openTask('Map report')
    console.log('price:', await s.price())
    await s.run('Resolutions, coarsest to finest')
    console.log('notes:', JSON.stringify(await s.notes()))
    const button = page.locator('.analysis-drawer button', { hasText: /^HTML report$/ }).first()
    await button.scrollIntoViewIfNeeded()
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), button.click()])
    const saved = join(OUT, 'files', download.suggestedFilename())
    await download.saveAs(saved)
    console.log('saved', saved)
    const report = await context.newPage()
    await report.goto(`file://${resolve(saved)}`)
    await sleep(800)
    await report.click('#tab-overview').catch(() => console.log('no overview tab'))
    await sleep(800)
    await report.screenshot({ path: join(OUT, 'mapreport-01-overview.png') })
    await report.screenshot({ path: join(OUT, 'mapreport-01-overview-full.png'), fullPage: true })
    console.log('wrote mapreport-01-overview.png and -full')
  } finally {
    await s.close()
  }
})()
