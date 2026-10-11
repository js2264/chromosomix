/**
 * A stretch set aside, put back (§27.4), in headless Chromium on the yeast
 * micro-C demo: 300 kb of IV selected along the diagonal and set aside as
 * debris from its menu — listed at the foot of the sequences card with *put
 * back* — then put back from its row: a sequence of its own, last, selected and
 * framed, to be moved into place.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-putback.mjs [out-dir]     # p01 … p02
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot, text, openStage, openWithDev, mapBox, at, cellsOf, history } = g

await openWithDev(`?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await sleep(8000)
await openStage()

// 300 kb of IV along the diagonal, set aside as debris from its menu.
const box = await mapBox()
const iv = await cellsOf('IV')
await g.drag(at(box, iv[0] + 500, iv[0] + 500), at(box, iv[0] + 800, iv[0] + 800))
await page.keyboard.press('Delete')
await sleep(300)
await page.click('.crumb-menu-item:has-text("debris")')
await sleep(800)
await page.keyboard.press('Escape')
await page.evaluate(() => document.querySelector('.edit-aside')?.scrollIntoView({ block: 'center' }))
await sleep(300)
console.log('set aside:', await page.evaluate(() => [...document.querySelectorAll('.edit-aside-list li')].map((li) => li.textContent)))
await shot('p01-set-aside')

// Put back from its row: last, selected, framed.
await page.click('.edit-aside-back')
await sleep(900)
console.log('history:', await history())
console.log('selected:', await text('.edit-card .edit-locus'))
console.log('last sequences:', await page.evaluate(() => [...document.querySelectorAll('.edit-sequence-name')].slice(-3).map((node) => node.textContent)))
await page.evaluate(() => document.querySelector('.edit-sequence.is-selected')?.scrollIntoView({ block: 'center' }))
await sleep(300)
await shot('p02-put-back')
await g.close()
