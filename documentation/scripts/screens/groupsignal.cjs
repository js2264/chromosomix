/**
 * Signal by group (analyses/groupsignal.mdx): GC content compared between the
 * A and B compartments of the P. aeruginosa PAK chromosome, as the repository's
 * `scripts/ui-bacteria.mjs` (GALLERY_ONLY=groups) drives it — the map at 8 kb
 * from the DNA Bacterial Zoo on the lab's bucket, the origin typed into the
 * Chromosomes table, Base composition run for the GC content, Compartments
 * read along both arms and phased by GC content, then Signal by group on the
 * GC content split by the A/B call's names: the drawer's violins, the Groups
 * table and the Between groups table.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/groupsignal.cjs <out-dir>
 *
 * The window is 1440 × 1180, as in metaplot.cjs: the violins and both tables
 * under them need more than a 900 px window. The picture is the drawer alone.
 */
const { open, sleep, BASE } = require('./lib-1d3d.cjs')

const OUT = process.argv[2] ?? 'screens'
const DATA = process.env.GALLERY_DATA ?? 'https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/PAK_MM142'
const MAP = `${DATA}/PAK_MM142.mcool::/resolutions/8000`
const FASTA = `${DATA}/PAK.fa`
const HEIGHT = Number(process.env.SCREENS_HEIGHT ?? 1180)

;(async () => {
  const s = await open(OUT, { height: HEIGHT, drawer: Number(process.env.SCREENS_DRAWER ?? 880) })
  const { page } = s
  // A select of the drawer offering `text`, set to it.
  const choose = async (text) => {
    const select = page.locator('.analysis-drawer select').filter({ has: page.locator('option', { hasText: text }) }).first()
    if (!(await select.count())) { console.log('no select offers', text); return }
    const label = await select.locator('option', { hasText: text }).first().textContent()
    await select.selectOption({ label: label ?? text })
    await sleep(700)
  }
  try {
    await page.goto(`${BASE}/#uri=${encodeURIComponent(MAP)}&view=contigs`)
    await s.until('reads as circular')
    await sleep(1500)
    const origin = page.locator('input.tedit').first()
    await origin.click()
    await origin.fill('6,374,501')
    await origin.press('Enter')
    await sleep(600)
    await s.fold('Show the Annotations panel')
    await page.waitForSelector('.ann-drop', { timeout: 30000 })
    await s.dropTrack(FASTA, 'PAK.fa')
    await sleep(5000)
    await page.evaluate((hash) => { location.hash = hash }, `#uri=${encodeURIComponent(MAP)}&view=region&region=LR657304.1`)
    await sleep(6000)
    await s.fold('Fold the Annotations panel')
    await s.fold('Fold the General panel')
    await s.fold('Fold the Aesthetics panel')
    await s.openTask('Base composition')
    await s.run('Cumulative GC skew')
    await s.openTask('Compartments')
    await choose('decay along both arms')
    await choose('GC content')
    await s.run('Components')
    await s.openTask('Signal by group')
    await page.locator('.analysis-drawer label.param-check', { hasText: 'GC content · PAK' }).locator('input').check()
    await sleep(500)
    await choose('A/B compartments')
    await s.shot('groupsignal-form')
    await s.run('Between groups')
    console.log('notes:\n' + (await s.notes()))
    await s.scrollDrawerToBlock('^GC content')
    await sleep(2000)
    console.log('blocks:', JSON.stringify(await s.blocks()))
    await s.shot('groupsignal-result')
  } catch (e) {
    console.log('FAILED', e)
    await s.shot('groupsignal-failure')
  } finally {
    await s.close()
  }
})()
