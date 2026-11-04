/**
 * Pictures for browse/comparing.md, from links to the lab's bucket.
 *
 * Two maps that share a grid: the G1 and G2/M Hi-C of the yeast strain that
 * carries an M. pneumoniae genome (Meneu et al. 2025), whose sixteen yeast
 * chromosomes are spelt and sized alike in both files. First the whole of
 * chromosome IV at 4 kb in one square, G1 above the diagonal and G2/M below,
 * with the Annotations panel open on the Contact maps card's two rows; then the
 * same chromosome at 8 kb as the log2 ratio of G2/M over G1, on RdBu_r. Last,
 * one file read two ways: the yeast Micro-C demo on IV:1.0–1.4 Mb, its 1 kb
 * bins summed to 2 kb, balanced above the diagonal and its O/E below, each
 * with its key, and the Map card open on its second tab.
 *
 *   node documentation/scripts/screens/browse-comparing.cjs [out-dir]   # cp-split, cp-ratio, cp-lower
 */

const { BUCKET, sleep, start } = require('./browse-lib.cjs')

const G1 = `${BUCKET}/meneu/HiC/HiC_Mpneumo_G1.mcool`
const G2M = `${BUCKET}/meneu/HiC/HiC_Mpneumo_G2M.mcool`
const MICROC = `${BUCKET}/yeast/Yeast_microC_G2M_1kb.cool`
const at = (file, bin) => `${file}::/resolutions/${bin}`

/** The keys on screen, as the reader reads them. */
const keys = () =>
  [...document.querySelectorAll('.map-key')]
    .filter((key) => key.offsetParent !== null)
    .map((key) => key.textContent.replace(/\s+/g, ' ').trim())
    .filter((text) => text !== '')

;(async () => {
  const app = await start(process.argv[2])
  const { page } = app
  const park = async () => {
    await page.mouse.move(8, 892)
    await sleep(600)
  }
  const shown = (title) =>
    page.evaluate((title) => [...document.querySelectorAll(`button[title^="${title}"]`)].some((b) => b.offsetParent !== null), title)
  try {
    // Two files in one square.
    await app.open(`#uri=${at(G1, 4000)}&uri2=${at(G2M, 4000)}&view=region&region=IV&balance=true&transform=log10`)
    await app.until(new Function(`return (${keys})().some((k) => k.includes('◣'))`))
    await app.press('Fold the General panel')
    await app.press('Show the Annotations panel')
    await park()
    console.log('split keys:', await page.evaluate(keys))
    await app.shot('cp-split')

    // Their ratio, over the whole square.
    await app.open(`#uri=${at(G2M, 8000)}&uri2=${at(G1, 8000)}&view=region&region=IV&balance=true&op=ratio&transform=log2&colormap=RdBu_r`)
    await app.until(() => /Mpneumo/.test(document.querySelector('.map-key-title')?.textContent ?? ''))
    if (await shown('Fold the Annotations panel')) await app.press('Fold the Annotations panel')
    await park()
    console.log('ratio key:', await page.evaluate(() => document.querySelector('.map-key-title')?.getAttribute('title') ?? document.querySelector('.map-key-title')?.textContent))
    await app.shot('cp-ratio')

    // One file read two ways.
    await app.open(
      `#uri=${MICROC}&view=region&region=IV:1000000-1400000&coarsen=2000&balance=true&transform=log10` +
        `&lower=true&oe2=true&transform2=log2&colormap2=RdBu_r`,
    )
    await app.until(new Function(`return (${keys})().some((k) => k.includes('◣') && k.includes('O/E'))`))
    if (await shown('Fold the Annotations panel')) await app.press('Fold the Annotations panel')
    // The Map card on its second tab, where the lower reading is set.
    await page.locator('.panel-aesthetics button, .panel-aesthetics [role="tab"]', { hasText: /lower/ }).first().click()
    await sleep(800)
    await park()
    console.log('lower keys:', await page.evaluate(keys))
    await app.shot('cp-lower')
  } finally {
    await app.close()
  }
})()
