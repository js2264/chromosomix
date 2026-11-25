/**
 * The reference editor's clicks and keys (§27.4), in headless Chromium on the
 * yeast micro-C demo: a click's caret and its card, → moving it a cell and C
 * cutting there; a double click's piece and a triple click's whole sequence;
 * a stretch dragged along the diagonal, the hand over it, → → → moving it as
 * one step and ← ← ← taking it back to none; a stretch of VII turned (two
 * cuts) and one of XV taken into VII (two joins), the joins drawn twice
 * as wide as the cuts; a box off the diagonal and its acts on a right click;
 * and the page never scrolled sideways.
 *
 * It prints what each step found — the selection card, the history, the
 * cursor, the page's scroll — so a step that did not happen is a line in the
 * log rather than something to spot in a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-caret.mjs [out-dir]     # ec01 … ec07
 */

import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
// Twice the pixels: a hairline beside a rule twice as wide is the point of one picture.
const g = await gallery(OUT, { scale: 2 })
const { page, history, mapBox, at, cellsOf, drag, openStage, openWithDev } = g

/** The selection card, as words. */
const selectionCard = () =>
  page.evaluate(() => {
    const card = [...document.querySelectorAll('.edit-card')].find((node) => node.querySelector('.edit-card-head')?.textContent === 'selection')
    return card?.textContent?.replace(/\s+/g, ' ').trim() ?? null
  })
const scrolled = () => page.evaluate(() => document.documentElement.scrollLeft)
/** A point on the diagonal, a fraction of the way through a sequence's cells. */
const along = (box, cells, fraction) => {
  const unit = cells[0] + fraction * (cells[1] - cells[0])
  return at(box, unit, unit)
}

await openWithDev(`?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await sleep(8000)
await openStage()
let box = await mapBox()
const II = await cellsOf('II')
const IV = await cellsOf('IV')
const XII = await cellsOf('XII')
console.log('cells: II', II, '· IV', IV, '· XII', XII)

// A click on the diagonal, a third into II: the caret, and its card.
const click = along(box, II, 0.3)
await page.mouse.click(click.x, click.y)
await sleep(400)
console.log('click:', await selectionCard())
await g.shot('ec01-caret')

// → three times: the caret three cells on; the page behind not scrolled.
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
await sleep(300)
console.log('→ ×3:', await selectionCard(), '· page scrolled by', await scrolled())
// C: a cut at the caret.
await page.keyboard.press('c')
await sleep(600)
console.log('C:', await history())
await g.shot('ec02-cut-at-caret')

// A double click: the piece there; a triple click: its whole sequence.
box = await mapBox()
await page.mouse.dblclick(click.x, click.y)
await sleep(400)
console.log('double click:', await selectionCard())
await page.mouse.click(click.x, click.y, { clickCount: 3 })
await sleep(400)
console.log('triple click:', await selectionCard())
await g.shot('ec03-whole-sequence')

// A stretch of IV dragged along the diagonal; the hand over its square.
await page.keyboard.press('Escape')
await drag(along(box, IV, 0.35), along(box, IV, 0.55))
console.log('dragged along:', await selectionCard())
const inside = along(box, IV, 0.45)
await page.mouse.move(inside.x, inside.y)
await sleep(250)
const cursor = () => page.evaluate(() => getComputedStyle(document.querySelector('.edit-overlay')).cursor)
console.log('cursor over it:', await cursor())
const outside = along(box, II, 0.8)
await page.mouse.move(outside.x, outside.y + 40)
await sleep(250)
console.log('cursor off it:', await cursor())

// → three times: one step, the stretch three cells on; ← three times: none.
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
await sleep(700)
console.log('→ ×3 on the stretch:', await history(), '·', await selectionCard())
await g.shot('ec04-nudged')
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
await sleep(700)
console.log('← ×3 back:', await history(), '· page scrolled by', await scrolled())

// Two cuts and two joins in one chromosome: a stretch of VII turned, and a
// stretch of XV taken into VII further on.
const VII = await cellsOf('VII')
const XV = await cellsOf('XV')
box = await mapBox()
await page.keyboard.press('Escape')
await drag(along(box, VII, 0.2), along(box, VII, 0.35))
await page.keyboard.press('i')
await sleep(700)
await page.keyboard.press('Escape')
box = await mapBox()
await drag(along(box, XV, 0.2), along(box, XV, 0.3))
console.log('a stretch of XV:', await selectionCard())
box = await mapBox()
const VIIturned = (await cellsOf('VII_e1')) ?? VII
await drag(along(box, XV, 0.25), along(box, VIIturned, 0.7), 16)
await sleep(900)
console.log('turned in VII, XV taken into it:', await history())
await page.keyboard.press('Escape')
// The method suggests undoing both, its marks on the very junctions: turned
// down, so the rules underneath are what the picture shows.
for (let i = 0; i < 6; i++) {
  const down = await page.$('.edit-suggestions-card button[aria-label^="Turn down"]')
  if (down === null) break
  await down.click()
  await sleep(400)
}
await page.mouse.move(5, 5)
await sleep(600)
await g.shot('ec05-joins-and-cuts')
// Close on VII: the turned stretch's two cuts a hairline, the two joins either
// side of XV's stretch twice as wide.
box = await mapBox()
const VIInow = (await cellsOf('VII_e2')) ?? (await cellsOf('VII_e1')) ?? VII
const centre = along(box, VIInow, 0.5)
await page.mouse.move(centre.x, centre.y)
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, -240)
  await sleep(250)
}
// The pointer off the map: its crosshair is the accent, and would hide a rule.
await page.mouse.move(5, 5)
await sleep(1500)
const plot = await page.$('.edit-overlay')
const r = await plot.boundingBox()
await page.screenshot({ path: join(OUT, 'ec05b-joins-and-cuts-close.png'), clip: { x: r.x - 30, y: r.y - 30, width: r.width + 30, height: r.height + 30 } })
console.log('wrote ec05b-joins-and-cuts-close.png')
await page.keyboard.press('0')
await sleep(800)

// A box off the diagonal, rows of IV and columns of XII; its acts on a right click inside it.
box = await mapBox()
const corner = at(box, XII[0] + 0.1 * (XII[1] - XII[0]), IV[0] + 0.1 * (IV[1] - IV[0]))
const across = at(box, XII[0] + 0.3 * (XII[1] - XII[0]), IV[0] + 0.3 * (IV[1] - IV[0]))
await drag(corner, across)
console.log('box:', await selectionCard())
const middle = { x: (corner.x + across.x) / 2, y: (corner.y + across.y) / 2 }
await page.mouse.click(middle.x, middle.y, { button: 'right' })
await sleep(400)
console.log('right click on the box:', await page.evaluate(() => [...document.querySelectorAll('.context-menu .context-menu-head, .context-menu .crumb-menu-item')].map((node) => `${node.textContent?.replace(/\s+/g, ' ').trim()}${node.classList.contains('disabled') ? ' (held back)' : ''}`)))
await g.shot('ec06-box-menu')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')

// Dark: the caret and the two weights of rule.
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await page.mouse.click(click.x, click.y)
await sleep(600)
await g.shot('ec07-dark')
console.log('page scrolled by', await scrolled(), '· errors:', JSON.stringify(g.errors))
await g.close()
process.exit(0)
