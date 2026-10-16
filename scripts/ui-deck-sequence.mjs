/**
 * A sequence picked on one cell of the deck (§16.3), end to end.
 *
 * On the yeast deck (micro-C beside Hi-C, on IV): the two headings, each with
 * the sequence its map is on; `V` picked on the Hi-C cell — it leaves the
 * chain and reads V for itself while micro-C stays on IV; `XII` picked on the
 * first map — the session goes there and the Hi-C cell stays on V; a reload,
 * the cell still on V; and the window's `×`, the cell back on the deck's
 * sequence. Each step prints what every cell's picker says, its chain, and
 * the hash, so a cell that did not move is a line here as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-deck-sequence.mjs [out-dir]
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })

const cells = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.deck-grid .deck-panel')].map((cell) => {
      const name = cell.querySelector('.deck-name')
      const picker = cell.querySelector('select.deck-seq')
      return {
        name: (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim(),
        sequence:
          picker === null || picker.classList.contains('hidden')
            ? null
            : picker.value === ''
              ? `(${picker.options[0]?.textContent ?? ''})`
              : picker.value,
        chained: cell.querySelector('.deck-lock')?.getAttribute('aria-pressed') ?? null,
        // The pill saying the map reads a window of its own: its locus, or
        // `own` where the window is the whole sequence the picker names.
        window:
          cell.querySelector('.deck-place:not(.hidden)') === null
            ? null
            : (cell.querySelector('.deck-place:not(.hidden) .deck-place-label')?.textContent ?? 'own'),
      }
    }),
  )
const hash = () => page.evaluate(() => decodeURIComponent(location.hash).replace(/https?:\/\/[^/]+\/demo\//g, ''))
const settled = async () => {
  await sleep(1500)
  await page.waitForFunction(
    () => [...document.querySelectorAll('.deck-grid .deck-panel')].every((cell) => !/opening…|reading/.test(cell.textContent ?? '')),
    null,
    { timeout: 120000 },
  ).catch(() => {})
  await sleep(2500)
}
const report = async (step) => console.log(step, JSON.stringify(await cells()), '\n   ', await hash())
const open = async () => {
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelectorAll('.heatmap-canvas').length >= 2, null, { timeout: 180000 })
  await settled()
}

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_deck.chromosomix.json`)
  await open()
  await report('as it opens:')
  await shot('ds01-deck')

  await page.locator('.deck-grid .deck-panel').nth(1).locator('select.deck-seq').selectOption('V')
  await settled()
  await report('V on the Hi-C cell:')
  await shot('ds02-companion-on-V')

  await page.locator('.deck-grid .deck-panel').nth(0).locator('select.deck-seq').selectOption('XII')
  await settled()
  await report('XII on the first map:')
  await shot('ds03-lead-on-XII')

  await page.reload()
  await open()
  await report('after a reload:')
  await shot('ds04-after-reload')

  const clear = page.locator('.deck-grid .deck-panel').nth(1).locator('.deck-place-clear')
  if (await clear.count()) {
    await clear.click()
    await settled()
  }
  await report('the window’s × pressed:')
  await shot('ds05-back-on-deck')

  // The picker open, close up.
  const picker = page.locator('.deck-grid .deck-panel').nth(1).locator('select.deck-seq')
  const box = await picker.boundingBox()
  if (box !== null) {
    await page.screenshot({
      path: `${OUT}/ds06-heading.png`,
      clip: { x: box.x - 420, y: box.y - 12, width: 520, height: 40 },
      scale: 'device',
    })
    console.log('wrote ds06-heading.png')
  }
} finally {
  await close()
}
