/**
 * An edit of the reference sent in a link (§27.2, §27.7), in headless Chromium
 * on the yeast micro-C demo: a stretch of IV turned on the stage, the session
 * drawn through it, the share dialog's link — and that link opened in another
 * browser with nothing kept, which draws the same map through the same edit.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-edit-share.mjs [out-dir]     # s01 … s03
 */

import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const g = await gallery(OUT)
const { page, shot, text, history, mapBox, at, cellsOf, drag, openStage, openWithDev } = g

await openWithDev(`?config=${g.base}/demo/yeast/Yeast_microC.chromosomix.json`)
await sleep(8000)

// A stretch of IV turned on the stage, and the stage closed on it.
await openStage()
const box = await mapBox()
const iv = await cellsOf('IV')
await drag(at(box, iv[0] + 400, iv[0] + 400), at(box, iv[0] + 900, iv[0] + 900))
await page.keyboard.press('i')
await sleep(500)
console.log('history:', await history())
await page.click('.modal-panel .btn-close')
for (let i = 0; i < 60; i++) {
  await sleep(500)
  if (/IV_e1/.test((await text('.breadcrumb')) ?? '')) break
}
await sleep(3000)
const heading = async (p) => (await p.evaluate(() => document.querySelector('.crumb-reference')?.textContent ?? ''))?.trim()
console.log('sender:', await heading(page), '·', (await text('.breadcrumb'))?.replace(/\s+/g, ' '))
await shot('s01-edited')

// The link, from the share dialog.
await page.click('button[title="Share this tab as a link"]')
await sleep(1500)
const link = await page.evaluate(() => document.querySelector('.share-link')?.textContent ?? '')
console.log('link:', link.length, 'characters')
await shot('s02-share')

// Opened in another browser that has never seen the file or the edit.
const other = await g.browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
const recipient = await other.newPage()
recipient.on('pageerror', (e) => console.log('recipient error:', String(e)))
await recipient.goto(`${g.base}/`)
await recipient.evaluate(() => localStorage.setItem('chromosomix:dev-features', 'on'))
await recipient.goto(link)
for (let i = 0; i < 60; i++) {
  await sleep(500)
  if (/IV_e1/.test((await recipient.evaluate(() => document.querySelector('.breadcrumb')?.textContent ?? '')) ?? '')) break
}
await sleep(3000)
console.log('recipient:', await heading(recipient), '·', (await recipient.evaluate(() => document.querySelector('.breadcrumb')?.textContent ?? '')).replace(/\s+/g, ' '))
await recipient.screenshot({ path: join(OUT, 's03-recipient.png') })
console.log('wrote s03-recipient.png')
await other.close()
await g.close()
