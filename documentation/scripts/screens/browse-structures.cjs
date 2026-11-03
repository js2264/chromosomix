/**
 * Pictures for browse/structures.md: the yeast Micro-C demo with its 3D model
 * dropped on the Structures card, so that it opens in a cell beside the map,
 * framed on the map's window, and a bead pointed at — the status bar naming it
 * and each map drawing a dashed line down and across the heatmap at its place.
 *
 *   node documentation/scripts/screens/browse-structures.cjs [out-dir]   # st-model, st-bead
 */

const { BASE, sleep, start } = require('./browse-lib.cjs')

;(async () => {
  const app = await start(process.argv[2])
  const { page } = app
  try {
    await app.open('?config=/demo/yeast/Yeast_microC.chromosomix.json')
    await app.press('Fold the General panel')
    await app.press('Show the Annotations panel')
    // Dropped on the card, as a reader drops it: the click road opens the
    // browser's own file picker, which a page cannot answer.
    await page.evaluate(async (url) => {
      const card = document.querySelector('.structure-card')
      const bytes = await (await fetch(url)).arrayBuffer()
      const file = new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      for (const kind of ['dragenter', 'dragover', 'drop']) {
        card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
    }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
    await page.waitForSelector('.deck-structure', { timeout: 60000 })
    await page
      .waitForFunction(() => {
        const note = document.querySelector('.structure-note')
        return note === null || note.classList.contains('hidden')
      }, null, { timeout: 90000 })
      .catch(() => {})
    await sleep(3000)
    await app.press('Fold the Annotations panel')
    await app.press('Fold the Aesthetics panel')
    await app.rendered(0)
    await page.mouse.move(5, 450)
    await app.shot('st-model')

    // A bead under the pointer: swept for until the status bar names one.
    const canvas = await page.locator('.structure-wrap canvas').first().boundingBox()
    const readout = () => page.evaluate(() => document.querySelector('.status-coords')?.textContent ?? '')
    let found = ''
    for (let j = 6; j < 58 && found === ''; j += 1) {
      for (let i = 6; i < 58 && found === ''; i += 1) {
        await page.mouse.move(canvas.x + (canvas.width * i) / 64, canvas.y + (canvas.height * j) / 64)
        await sleep(25)
        const said = await readout()
        if (/bead \d+ of/.test(said) && /IV:1,[0-3]/.test(said)) found = said
      }
    }
    console.log('bead:', found)
    await sleep(900)
    await app.shot('st-bead')
  } finally {
    await app.close()
  }
})()
