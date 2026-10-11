/**
 * The 1D browser's stack bar (§5.8), in headless Chromium on the yeast tracks
 * demo: the bar under the last track, a drag down that makes every track taller
 * in proportion, Escape mid-drag putting them back, a double click filling the
 * column, and the bar absent beside a map, with the browser as a deck's lead,
 * and in a deck's tracks cell.
 *
 * The log prints every track's height (read from the session's own record of
 * the tracks) and their ratio to the first, after each gesture — which is how
 * "in proportion" is checked, since a screenshot shows heights and not ratios.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-stack-bar.mjs [out-dir]     # sb01 … sb07, sb05b
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page } = g

/** Every track's height, from the session's record, as `label height`. */
const sizes = () =>
  page.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i) ?? ''
      let rows = null
      try {
        rows = JSON.parse(sessionStorage.getItem(key) ?? 'null')
      } catch {
        continue
      }
      if (!Array.isArray(rows) || rows.length < 2 || !rows.every((row) => typeof row?.style?.size === 'number')) continue
      return rows.map((row) => ({ label: row.label, size: row.style.size }))
    }
    return []
  })

const show = async (what) => {
  const rows = await sizes()
  const first = rows[0]?.size ?? 1
  console.log(
    what.padEnd(14),
    rows.map((row) => `${row.label} ${row.size}`).join(' · '),
    '\n'.padEnd(16),
    'ratios',
    rows.map((row) => (row.size / first).toFixed(2)).join(' '),
  )
}

/** The bar's box, scrolled into view first — under eleven tracks it is below the window — or null. */
const barBox = async () => {
  const bar = page.locator('.browser-stack-resize:not(.hidden)').first()
  if ((await bar.count()) === 0) return null
  await bar.scrollIntoViewIfNeeded()
  await sleep(300)
  return bar.boundingBox()
}

/** How many stack bars and deck cell bars are on screen — displayed, not merely built. */
const barsShown = (on) =>
  on.evaluate(() => {
    const shown = (bar) => getComputedStyle(bar).display !== 'none' && bar.getBoundingClientRect().height > 0
    const bars = [...document.querySelectorAll('.cell-resize')].filter(shown)
    const stack = bars.filter((bar) => bar.classList.contains('browser-stack-resize')).length
    return `${stack} stack bars · ${bars.length - stack} cell bars`
  })

/** The scrolling column at its foot, where a stack bar would be under the last track. */
const toFoot = async (on) => {
  await on.evaluate(() => {
    const column = document.querySelector('.content')
    if (column !== null) column.scrollTop = column.scrollHeight
  })
  await sleep(800)
}

/** Press the first button on screen whose title starts with `title`. */
const press = async (on, title) => {
  for (const button of await on.$$(`button[title^="${title}"]`)) {
    if (await button.isVisible()) {
      await button.click()
      await sleep(600)
      return
    }
  }
}

await page.goto(`${g.base}/?config=${g.base}/demo/yeast/Yeast_tracks.chromosomix.json`)
await page.waitForSelector('.browser-canvas', { timeout: 120000 })
await sleep(8000)
await show('at rest')
let bar = await barBox()
console.log('bar           ', bar === null ? 'none' : `at y ${Math.round(bar.y)}, ${Math.round(bar.width)} wide`)
await g.shot('sb01-at-rest')

// Hovered: the bar lights, as the deck cell's does.
await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
await sleep(400)
await page.screenshot({ path: `${OUT}/sb02-bar-hovered.png`, clip: { x: bar.x + bar.width / 2 - 260, y: bar.y - 120, width: 520, height: 170 } })
console.log('wrote sb02-bar-hovered.png')

// Down by 150 pixels: every track taller, each in proportion.
const start = { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 }
await page.mouse.down()
for (let k = 1; k <= 10; k++) {
  await page.mouse.move(start.x, start.y + k * 15)
  await sleep(30)
}
await page.mouse.up()
await sleep(1200)
await show('dragged +150')
bar = await barBox()
console.log('bar now       ', bar === null ? 'none' : `at y ${Math.round(bar.y)}`)
await g.shot('sb03-dragged-down')

// Up past where it started, then Escape before letting go: back as it was.
await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
await page.mouse.down()
for (let k = 1; k <= 8; k++) {
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2 - k * 30)
  await sleep(30)
}
await sleep(500)
await show('mid-drag up')
await g.shot('sb04-mid-drag-up')
await page.keyboard.press('Escape')
await page.mouse.up()
await sleep(1000)
await show('Escape')

// A double click: the stack to the foot of the column, still in proportion.
bar = await barBox()
await page.mouse.dblclick(bar.x + bar.width / 2, bar.y + bar.height / 2)
await sleep(1500)
await show('double click')
await g.shot('sb05-double-click-fills')

// The browser as a deck's lead, with a row of cells under it: the bar goes,
// as it does everywhere in a deck. Shot at the column's foot, where it was.
await page.locator('.deck-grow.is-below').first().click()
await sleep(3000)
await toFoot(page)
console.log('browser leads ', await barsShown(page))
await g.shot('sb05b-browser-as-deck-lead-no-bar')

/** A fresh window at a config, so nothing this one remembers comes with it. */
async function fresh(config) {
  const context = await g.browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const other = await context.newPage()
  await other.goto(`${g.base}/?config=${g.base}/demo/yeast/${config}`)
  await other.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(10000)
  return { other, context }
}

// Beside a map there is no such bar: the lanes are the map's. Shot at the
// foot of the lanes under it.
const map = await fresh('Yeast_microC.chromosomix.json')
await toFoot(map.other)
console.log('beside a map  ', await barsShown(map.other), '·', await map.other.locator('.browser-stack-resize').count(), 'built')
await map.other.screenshot({ path: `${OUT}/sb06-map-no-bar.png` })
console.log('wrote sb06-map-no-bar.png')
await map.context.close()

// …nor in a deck's tracks cell, which has the cell's own bar under it: one
// added to the two maps' deck, with two of the session's tracks on it.
const deck = await fresh('Yeast_deck.chromosomix.json')
await deck.other.click('.deck-add-toggle')
await deck.other.click('.deck-add-tracks')
await deck.other.waitForSelector('.deck-tracks', { timeout: 20000 })
await press(deck.other, 'Show the Annotations panel')
for (const id of ['demo-genes', 'demo-atac']) {
  const more = await deck.other.$(`.ann-row[data-id="${id}"] .ann-more`)
  if (more !== null) {
    await more.click()
    await sleep(300)
  }
}
await deck.other.evaluate(() => {
  for (const row of document.querySelectorAll('.annotation-card .ann-place-map')) {
    if (row.querySelector('.ann-place-name')?.textContent !== 'tracks') continue
    const bottom = [...row.querySelectorAll('button.ann-place')].find((button) => button.dataset.edge === 'bottom')
    if (bottom !== undefined && !bottom.disabled && bottom.getAttribute('aria-pressed') !== 'true') bottom.click()
  }
})
await sleep(2000)
await press(deck.other, 'Fold the Annotations panel')
await sleep(3000)
await toFoot(deck.other)
console.log(
  'in a deck     ',
  await barsShown(deck.other),
  '·',
  await deck.other.locator('.deck-tracks .browser-stack-resize').count(),
  'built in the tracks cell',
)
await deck.other.screenshot({ path: `${OUT}/sb07-deck-cell-bars-only.png` })
console.log('wrote sb07-deck-cell-bars-only.png')
await deck.context.close()
await g.close()
