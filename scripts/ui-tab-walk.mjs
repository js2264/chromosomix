/**
 * Tab between the fields of one kind (§26.8), end to end.
 *
 * On the yeast demo: a caret in the first track name under the map, then Tab
 * after Tab — the names under the map in order, one renamed on the way, then
 * on into the stack beside the map; a caret in a range, Tab from its bottom to
 * its top and on to the next track's bottom; the colour key's low end, Tab to
 * its high end — left alone, then typed, the caret kept through the repaint;
 * a name on the Tracks card, Tab to the next row's name; the 1D browser's
 * names and ranges, down its lanes. Then the yeast deck:
 * a cell's heading, Tab to the next cell's; the first map's colour key's high
 * end, Tab to the next map's low end, and typed. Then a 3D model coloured by a
 * track: its key's bottom typed, Tab to its top, typed, Tab to let go. Each
 * step prints where the caret is and what it holds, so a Tab that went astray
 * is a line here too.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-tab-walk.mjs [out-dir]
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
// A browser for each config: the app reopens the tab it remembers before it
// reads `?config=`, so a second config in the same browser would never open.
let { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })

const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
const opened = () =>
  page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )

/**
 * The caret over a lane's small print: what it holds, which kind, which stack
 * it stands by — the corner whose names it is laid over — and what its title
 * says it is, which for an end of a range names the track and the end.
 */
const caret = () =>
  page.evaluate(() => {
    const input = document.querySelector('.lane-edit')
    if (input === null) return null
    const r = input.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    // The corner nearest the caret's middle: a box can be wider than the text
    // it was laid over and reach past its corner onto the lane.
    let stack = '?'
    let best = Infinity
    for (const edge of ['bottom', 'right', 'top', 'left']) {
      const corner = document.querySelector(`.lane-labels-${edge}:not(.hidden)`)?.getBoundingClientRect()
      if (corner === undefined) continue
      const dx = Math.max(corner.left - cx, 0, cx - corner.right)
      const dy = Math.max(corner.top - cy, 0, cy - corner.bottom)
      if (dx + dy < best && dx + dy < 60) {
        best = dx + dy
        stack = edge
      }
    }
    const kind = input.classList.contains('lane-edit-name') ? 'name' : 'range'
    const end = kind === 'range' ? (/^Top/.test(input.title) ? 'top' : /^Bottom/.test(input.title) ? 'bottom' : '?') : undefined
    const of = kind === 'range' ? (/^\w+ of (.+)’s value axis/.exec(input.title)?.[1] ?? '?') : undefined
    return { value: input.value, kind, stack, ...(of === undefined ? {} : { of, end }) }
  })

/**
 * Press on the corner beside a stack until a caret of `kind` opens: the
 * names and ranges are painted text, found by the pointer the way a reader
 * finds them — the canvas says when one is under it.
 */
async function openIn(corner, kind) {
  const r = await page.evaluate((selector) => {
    const box = document.querySelector(selector)?.getBoundingClientRect()
    return box === undefined ? null : { left: box.left, top: box.top, width: box.width, height: box.height }
  }, corner)
  if (r === null) return null
  for (let y = Math.round(r.top) + 3; y < r.top + r.height; y += 3) {
    for (let x = Math.round(r.left + r.width) - 6; x > r.left + 4; x -= 10) {
      await page.mouse.move(x, y)
      const text = await page.evaluate((selector) => document.querySelector(selector)?.classList.contains('is-text'), corner)
      if (!text) continue
      await page.mouse.down()
      await page.mouse.up()
      await sleep(250)
      const at = await caret()
      if (at !== null && at.kind === kind) return at
      await page.keyboard.press('Escape')
      await sleep(150)
      break
    }
  }
  return null
}

const tab = async (shift = false) => {
  await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab')
  await sleep(350)
}

try {
  // --- one map ---------------------------------------------------------------
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await opened()
  await sleep(2500)
  await fold('Fold the General panel')

  // The names, under the map and on into the stack beside it: Tab after Tab
  // to past the last, one renamed on the way, and at the step that crosses
  // into the stack on the right a Shift+Tab back over the crossing and a Tab
  // on again. The peaks lanes are too short to give their names a caret, so
  // they are not stops.
  const first = await openIn('.lane-labels-bottom', 'name')
  console.log('first name:', JSON.stringify(first))
  await shot('tw01-first-name')
  const walk = [first]
  let crossed = false
  for (let step = 0; step < 12; step++) {
    if (step === 1) {
      // Renamed on the way: Tab takes it, as Enter would.
      await page.keyboard.press('Control+A')
      await page.keyboard.type('genes (SGD)')
    }
    await tab()
    const now = await caret()
    walk.push(now)
    if (now === null) break
    if (!crossed && now.stack === 'right' && walk[walk.length - 2]?.stack === 'bottom') {
      crossed = true
      await shot('tw02-on-into-the-right-stack')
      await tab(true)
      console.log('Shift+Tab back over the crossing:', JSON.stringify(await caret()))
      await tab()
      console.log('and Tab on again:', JSON.stringify(await caret()))
    }
  }
  console.log('Tab through the names:', JSON.stringify(walk))
  console.log(
    'renamed on the way:',
    await page.evaluate(() => [...document.querySelectorAll('.ann-name')].map((n) => n.value).includes('genes (SGD)')),
  )

  // A range: an end of one, then on through the ends — a bottom to its top,
  // a top to the next track's bottom — and on into the stack on the right, to
  // past the last.
  const range = await openIn('.lane-labels-bottom', 'range')
  console.log('a range:', JSON.stringify(range))
  const ends = [range]
  for (let step = 0; step < 10; step++) {
    await tab()
    const now = await caret()
    ends.push(now)
    if (step === 0) await shot('tw03-range-next-end')
    if (now === null) break
  }
  console.log('Tab through the ranges:', JSON.stringify(ends))
  await page.keyboard.press('Escape')
  await sleep(300)

  // The colour key: low, then high, then let go.
  await page.locator('.map-key-value.is-lo').first().click()
  await sleep(300)
  await tab()
  const hi = await page.evaluate(() => ({
    end: document.activeElement?.closest('.map-key-value')?.className ?? null,
    // The number the key prints, not the float behind it.
    box: document.activeElement?.value ?? null,
    shown: document.querySelector('.map-key-value.is-lo')?.textContent ?? null,
  }))
  console.log('colour key, after Tab from the low end:', JSON.stringify(hi))
  await shot('tw04-key-high')
  await tab()
  console.log('and past the high end, a caret in the key:', await page.evaluate(() => document.querySelector('.map-key-input') !== null))
  console.log('both ends still auto:', await page.evaluate(() => document.querySelector('.map-key')?.textContent ?? null))
  // Typed: the low end set, Tab, and the caret still in the high end once the
  // map has been repainted at the new clip; that set too, Tab, let go.
  await page.locator('.map-key-value.is-lo').first().click()
  await sleep(300)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('-4')
  await tab()
  await sleep(1500)
  console.log(
    'low end typed -4, then Tab — a repaint later the caret is in:',
    await page.evaluate(() => {
      const active = document.activeElement
      return active?.classList.contains('map-key-input') ? active.closest('.map-key-value')?.className ?? '?' : null
    }),
  )
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('-1.5')
  await tab()
  await sleep(1500)
  console.log('high end typed -1.5, then Tab — the key reads:', await page.evaluate(() => document.querySelector('.map-key')?.textContent ?? null))
  await shot('tw04b-key-set')

  // The Tracks card: a row's name, then the next row's.
  await fold('Show the Annotations panel')
  const names = page.locator('.annotation-card input.ann-name')
  await names.first().click()
  await tab()
  console.log(
    'Tracks card, after Tab:',
    await page.evaluate(() => {
      const all = [...document.querySelectorAll('.annotation-card input.ann-name')]
      return { at: all.indexOf(document.activeElement), value: document.activeElement?.value ?? null }
    }),
  )
  await shot('tw05-tracks-card')
  await page.keyboard.press('Escape')
  await sleep(300)

  // The 1D browser: its lanes top to bottom, a name to the next, a range's
  // ends on to the next lane's — found by the pointer as on the map.
  await fold('Fold the Annotations panel')
  await page.evaluate(() => {
    const hash = new URLSearchParams(location.hash.slice(1))
    hash.set('view', 'browser')
    hash.delete('region')
    hash.set('locus', 'IV:1,000,001-1,400,000')
    location.hash = hash.toString()
  })
  await page.waitForSelector('.browser-canvas', { timeout: 60000 })
  await sleep(4000)
  const inBrowser = async (kind) => {
    const r = await page.evaluate(() => {
      const box = document.querySelector('.browser-canvas')?.getBoundingClientRect()
      return box === undefined ? null : { left: box.left, top: box.top, height: box.height }
    })
    if (r === null) return null
    for (let y = Math.round(r.top) + 40; y < r.top + r.height; y += 3) {
      for (let x = Math.round(r.left) + 8; x < r.left + 160; x += 8) {
        await page.mouse.move(x, y)
        if (!(await page.evaluate(() => document.querySelector('.browser-canvas')?.classList.contains('is-text')))) continue
        await page.mouse.down()
        await page.mouse.up()
        await sleep(250)
        const at = await caret()
        if (at !== null && at.kind === kind) return at
        await page.keyboard.press('Escape')
        await sleep(150)
        break
      }
    }
    return null
  }
  const browserWalk = [await inBrowser('name')]
  await shot('tw05b-browser-first-name')
  for (let step = 0; step < 12 && browserWalk[browserWalk.length - 1] !== null; step++) {
    await tab()
    browserWalk.push(await caret())
  }
  console.log('browser, Tab through the names:', JSON.stringify(browserWalk.map((at) => at?.value ?? null)))
  const browserEnds = [await inBrowser('range')]
  for (let step = 0; step < 12 && browserEnds[browserEnds.length - 1] !== null; step++) {
    await tab()
    browserEnds.push(await caret())
    if (step === 1) await shot('tw05c-browser-range')
  }
  console.log(
    'browser, Tab through the ranges:',
    JSON.stringify(browserEnds.map((at) => (at === null ? null : `${at.of} ${at.end} ${at.value}`))),
  )
  await page.keyboard.press('Escape')
  await sleep(300)

  // --- a deck ----------------------------------------------------------------
  await close()
  ;({ page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 }))
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_deck.chromosomix.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.deck-grid .heatmap-canvas').length >= 2, null, { timeout: 240000 })
  await sleep(6000)
  await fold('Fold the General panel')
  const headings = () =>
    page.evaluate(() => {
      const all = [...document.querySelectorAll('.deck-grid input.deck-name')]
      return { names: all.map((n) => n.value), at: all.indexOf(document.activeElement) }
    })
  await page.locator('.deck-grid input.deck-name').first().click()
  await tab()
  console.log('deck headings, after Tab from the first:', JSON.stringify(await headings()))
  await shot('tw06-deck-heading')
  await page.keyboard.press('Escape')
  await sleep(300)

  await page.locator('.deck-grid .map-key-value.is-hi').first().click()
  await sleep(300)
  await tab()
  const keyAt = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.deck-grid > .deck-panel')]
    const active = document.activeElement
    const cell = cells.findIndex((one) => one.contains(active))
    return {
      cell,
      name: cells[cell]?.querySelector('.deck-name')?.value ?? null,
      end: active?.closest('.map-key-value')?.classList.contains('is-lo') ? 'lo' : 'hi',
      box: active?.value ?? null,
    }
  })
  console.log('deck colour keys, after Tab from the first map’s high end:', JSON.stringify(keyAt))
  await shot('tw07-deck-next-key')
  await page.keyboard.press('Escape')
  await sleep(300)
  // Typed this time: the first map's top set, Tab, and a repaint later the
  // caret still in the next map's bottom.
  await page.locator('.deck-grid .map-key-value.is-hi').first().click()
  await sleep(300)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('-1.2')
  await tab()
  await sleep(2000)
  console.log(
    'first map’s top typed -1.2, then Tab — a repaint later:',
    await page.evaluate(() => {
      const cells = [...document.querySelectorAll('.deck-grid > .deck-panel')]
      const active = document.activeElement
      return {
        cell: cells.findIndex((one) => one.contains(active)),
        end: active?.closest('.map-key-value')?.classList.contains('is-lo') ? 'lo' : 'hi',
        keys: cells.map((one) => one.querySelector('.map-key')?.textContent ?? null),
      }
    }),
  )
  await tab(true)
  console.log(
    'and Shift+Tab back:',
    await page.evaluate(() => {
      const cells = [...document.querySelectorAll('.deck-grid > .deck-panel')]
      const active = document.activeElement
      return { cell: cells.findIndex((one) => one.contains(active)), end: active?.closest('.map-key-value')?.classList.contains('is-lo') ? 'lo' : 'hi' }
    }),
  )

  // --- a structure's key -----------------------------------------------------
  // The model coloured by a track: its key's two ends, the bottom typed and
  // Tab to the top, the top typed and Tab to let go — and Shift+Tab back.
  await close()
  ;({ page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 }))
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await opened()
  await sleep(2500)
  await fold('Fold the General panel')
  await fold('Show the Annotations panel')
  await page.evaluate(async (url) => {
    const card = document.querySelector('.structure-card')
    if (card === null) throw new Error('no Structures card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const file = new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  }, `${base}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await page
    .waitForFunction(() => { const n = document.querySelector('.structure-note'); return n === null || n.classList.contains('hidden') }, null, { timeout: 90000 })
    .catch(() => {})
  await sleep(4000)
  await fold('Fold the Annotations panel')
  await fold('Show the Aesthetics panel')
  const row = (label) =>
    page.locator('.structure-settings .field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) }).first()
  const colourings = await page.evaluate(() =>
    [...document.querySelectorAll('.structure-settings select option')].map((o) => [o.value, o.textContent]),
  )
  const atac = colourings.find(([value, text]) => value.startsWith('track:') && /ATAC$/.test(text ?? '')) ?? colourings.find(([value]) => value.startsWith('track:'))
  await row('colour by').locator('select').selectOption(atac[0])
  await sleep(3500)
  const key = page.locator('.deck-structure .structure-key')
  const keyEnds = () =>
    page.evaluate(() => {
      const box = document.querySelector('.deck-structure .structure-key-edit')
      return {
        key: document.querySelector('.deck-structure .structure-key')?.textContent ?? null,
        caret: box === null ? null : { value: box.value, end: /^Bottom/.test(box.title) ? 'bottom' : 'top' },
      }
    })
  console.log('structure key:', JSON.stringify(await keyEnds()))
  await key.locator('.structure-key-limit').first().click()
  await sleep(250)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('5')
  await tab()
  console.log('bottom typed 5, then Tab:', JSON.stringify(await keyEnds()))
  await key.screenshot({ path: `${OUT}/tw08-structure-key-top.png` })
  console.log('wrote tw08-structure-key-top.png')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('60')
  await tab()
  await sleep(1500)
  console.log('top typed 60, then Tab:', JSON.stringify(await keyEnds()))
  await key.locator('.structure-key-limit').nth(1).click()
  await sleep(250)
  await tab(true)
  console.log('Shift+Tab from the top:', JSON.stringify(await keyEnds()))
  await page.keyboard.press('Escape')
  await sleep(1500)
  await shot('tw09-structure-key-set')
} finally {
  await close()
}
