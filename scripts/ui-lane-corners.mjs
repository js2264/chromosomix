/**
 * The tracks' names beside the map, in its corners (§8.8), end to end.
 *
 * On the yeast demo: the map with its bottom and right stacks, each stack's
 * names in the corner that follows it clockwise — left of the bottom stack,
 * below the right one — and both corners close up; the same demo with a track
 * on every edge (ATAC above the map as well as below it, Pol II / input left of
 * it as well as right), so all four corners hold names; a name and an end of a
 * range pressed in a corner, each opening its caret there; the map's PNG and
 * PDF, the PDF rendered with poppler's `pdftoppm`; the dark theme; and the
 * yeast deck, two maps each with its corners. Every step prints the corners'
 * sizes, so a corner that did not open is a line here as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-lane-corners.mjs [out-dir]
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const FILES = join(OUT, 'files')
mkdirSync(FILES, { recursive: true })
const { page, shot, close, base, browser } = await gallery(OUT, { width: 1600, height: 1000 })
await page.context().addInitScript(() => {
  window.showSaveFilePicker = undefined
})

const DEMO = `${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`
const corners = (target = page) =>
  target.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.lane-labels')].map((canvas) => [
        canvas.className.replace(/.*lane-labels-(\w+).*/, '$1'),
        canvas.classList.contains('hidden') ? null : `${canvas.style.width} × ${canvas.style.height}`,
      ]),
    ),
  )
const opened = async (target = page, maps = 1) => {
  await target.waitForFunction(
    (n) => !document.body.textContent.includes('Opening ') && document.querySelectorAll('.heatmap-canvas').length >= n,
    maps,
    { timeout: 180000 },
  )
  await sleep(5000)
}
const clip = async (name, box) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: box, scale: 'device' })
  console.log('wrote', `${name}.png`)
}
const boxOf = (selector) =>
  page.evaluate((s) => {
    const node = document.querySelector(s)
    if (node === null || node.classList.contains('hidden')) return null
    const r = node.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, selector)

try {
  await page.goto(DEMO)
  await opened()
  console.log('corners:', JSON.stringify(await corners()))
  await shot('lc01-map')
  const bl = await boxOf('.lane-labels-bottom')
  if (bl !== null) await clip('lc02-bottom-left', { x: bl.x - 8, y: bl.y - 8, width: bl.width + 220, height: bl.height + 16 })
  const br = await boxOf('.lane-labels-right')
  if (br !== null) await clip('lc03-bottom-right', { x: br.x - 8, y: br.y - 120, width: br.width + 16, height: br.height + 128 })

  // A press on a name in the corner, and on the bottom end of a range.
  const name = await page.evaluate(() => {
    const canvas = document.querySelector('.lane-labels-bottom')
    const r = canvas.getBoundingClientRect()
    return { x: r.right - 30, y: r.top }
  })
  const atac = await page.evaluate(() => {
    // The ATAC lane's band of the bottom stack: the third lane, under the genes.
    const canvas = document.querySelector('.lane-canvas.lane-bottom')
    return canvas.getBoundingClientRect().top
  })
  console.log('name press at', JSON.stringify(name), atac)
  // Walk the corner's right edge down until a caret opens over a name.
  let caret = null
  for (let y = Math.round(name.y) + 4; y < Math.round(name.y) + 200 && caret === null; y += 3) {
    await page.mouse.move(name.x, y)
    const text = await page.evaluate(() => document.querySelector('.lane-labels-bottom')?.classList.contains('is-text'))
    if (!text) continue
    await page.mouse.down()
    await page.mouse.up()
    await sleep(300)
    caret = await page.evaluate(() => {
      const input = document.querySelector('.lane-edit')
      return input === null ? null : { name: input.classList.contains('lane-edit-name'), value: input.value }
    })
  }
  console.log('a press in the corner opened:', JSON.stringify(caret))
  await shot('lc04-caret-in-corner')
  await page.keyboard.press('Escape')
  await sleep(300)

  // The figure, from the Export card.
  const card = page.locator('.controls-card').filter({ has: page.locator('.controls-title', { hasText: /^Export$/ }) }).first()
  const save = async (format, file) => {
    await card.locator('select.select-format').selectOption(format)
    if (format === 'png') await card.locator('select.select-dpi').selectOption('96').catch(() => {})
    const arriving = page.waitForEvent('download', { timeout: 120000 })
    await card.locator('.export-acts button').first().click()
    const done = await arriving
    copyFileSync(await done.path(), join(FILES, file))
    console.log('saved', file)
    return join(FILES, file)
  }
  await save('png', 'lc05-map.png')
  const pdf = await save('pdf', 'lc06-map.pdf')
  try {
    execFileSync('pdftoppm', ['-png', '-r', '72', '-singlefile', pdf, join(FILES, 'lc06-map-page')])
    console.log('rendered lc06-map-page.png')
  } catch (err) {
    console.log('(no pdftoppm:', String(err).split('\n')[0], ')')
  }

  // A track on every edge: ATAC above the map too, Pol II / input left of it too.
  const four = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const other = await four.newPage()
  await other.route((url) => url.pathname.endsWith('/Yeast_microC.chromosomix.json'), async (route) => {
    const response = await route.fetch()
    const config = await response.json()
    for (const tab of config.tabs ?? [config]) {
      for (const track of tab.tracks ?? []) {
        if (track.label === 'ATAC') track.placement = { top: true, bottom: true }
        if (track.label === 'Pol II / input') track.placement = { left: true, right: true }
      }
    }
    await route.fulfill({ response, json: config })
  })
  await other.goto(DEMO)
  await opened(other)
  console.log('four stacks, corners:', JSON.stringify(await corners(other)))
  await other.screenshot({ path: `${OUT}/lc07-four-corners.png` })
  console.log('wrote lc07-four-corners.png')
  await four.close()

  // The dark theme.
  const dark = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await dark.addInitScript(() => localStorage.setItem('chromosomix:theme', 'dark'))
  const night = await dark.newPage()
  await night.goto(DEMO)
  await opened(night)
  await night.screenshot({ path: `${OUT}/lc08-dark.png` })
  console.log('wrote lc08-dark.png')
  await dark.close()

  // The deck: two maps, each with its corners.
  const decked = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const deck = await decked.newPage()
  await deck.goto(`${base}/?config=${base}/demo/yeast/Yeast_deck.chromosomix.json`)
  await opened(deck, 2)
  console.log('deck, corners:', JSON.stringify(await corners(deck)))
  await deck.screenshot({ path: `${OUT}/lc09-deck.png` })
  console.log('wrote lc09-deck.png')
  await decked.close()
} finally {
  await close()
}
