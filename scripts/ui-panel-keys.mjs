/**
 * The digit row and the resolution keys, driven in the real app (§5.5, §26.6).
 *
 * The key left of 1 folds Files, then 1 General, 2 Annotations, 3 Aesthetics and
 * 4 Analysis, in the order the columns stand; Control on the key left of 1 is the
 * console; − and + walk the resolution bar. A screenshot carries no keystroke, so
 * the script prints, after every press, which columns are open, which stop of the
 * resolution bar is lit, the map's window and the console's state — a key that
 * fired twice, or not at all, is a line in the log.
 *
 * Two keyboards. **QWERTY** is Playwright's own, real key presses through the
 * browser's input. **AZERTY** is a French PC's: the layout map Chromium would
 * hand over is stubbed in an init script (so the Files badge reads `²`), and each
 * press is dispatched as the event that keyboard sends — `&` from `Digit1` bare,
 * `6` from `Digit6` under Shift or Caps Lock — since no headless browser can be
 * given a layout of its own.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-panel-keys.mjs gallery      # pk01 … pk21
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
function playwright() {
  try {
    return require('playwright')
  } catch {
    const root = execSync('npm root -g').toString().trim()
    return require(join(root, 'playwright'))
  }
}
const { chromium } = playwright()

const OUT = process.argv[2] ?? 'gallery'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const YEAST = `${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`
const ECOLI = `${BASE}/#uri=${BASE}/demo/ecoli/Ecoli.mcool::/resolutions/1000&view=region&region=NC_000913.3:1000000-2000000&transform=log10`

/** What an AZERTY PC's layout map says, as Chromium would return it: each key bare. */
const AZERTY = {
  Backquote: '²', Digit1: '&', Digit2: 'é', Digit3: '"', Digit4: "'", Digit5: '(', Digit6: '-',
  Digit7: 'è', Digit8: '_', Digit9: 'ç', Digit0: 'à', Minus: ')', Equal: '=',
  KeyQ: 'a', KeyW: 'z', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyY: 'y', KeyU: 'u', KeyI: 'i', KeyO: 'o', KeyP: 'p',
  KeyA: 'q', KeyS: 's', KeyD: 'd', KeyF: 'f', KeyG: 'g', KeyH: 'h', KeyJ: 'j', KeyK: 'k', KeyL: 'l', Semicolon: 'm',
  KeyZ: 'w', KeyX: 'x', KeyC: 'c', KeyV: 'v', KeyB: 'b', KeyN: 'n', KeyM: ',', Comma: ';', Period: ':', Slash: '!',
  IntlBackslash: '<', BracketLeft: '^', BracketRight: '$', Quote: 'ù', Backslash: '*',
}

/** A small folder to connect, so the Files column exists (it is there only while a place is). */
const FOLDER = mkdtempSync(join(tmpdir(), 'keys-'))
mkdirSync(join(FOLDER, 'maps'))
writeFileSync(join(FOLDER, 'maps', 'Yeast_G1.mcool'), '')
writeFileSync(join(FOLDER, 'maps', 'Yeast_G2M.mcool'), '')
writeFileSync(join(FOLDER, 'maps', 'notes.txt'), 'two maps')

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []

async function scene(name, run, { azerty = false, scale = 1 } = {}) {
  console.log(`\n== ${name}`)
  const context = await browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: scale })
  await context.addInitScript(
    ({ azerty, map }) => {
      // A browser with no directory picker connects a folder as a snapshot,
      // which an input — and so Playwright — can answer.
      delete window.showDirectoryPicker
      if (!azerty) return
      const keyboard = { getLayoutMap: () => Promise.resolve(new Map(Object.entries(map))), lock: () => Promise.resolve(), unlock: () => {} }
      Object.defineProperty(Navigator.prototype, 'keyboard', { configurable: true, get: () => keyboard })
    },
    { azerty, map: AZERTY },
  )
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`) })
  const shot = async (file, options = {}) => {
    await page.screenshot({ path: `${OUT}/${file}.png`, ...options })
    console.log('shot', file)
  }
  /** A close-up round one element, at the page's own pixels. */
  const shotOf = async (file, selector, pad = 8) => {
    const box = await page.locator(selector).first().boundingBox()
    if (box === null) return console.log('  (nothing to shoot for', selector, ')')
    await shot(file, { clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } })
  }
  try {
    await run({ page, shot, shotOf })
  } finally {
    await context.close()
  }
}

/**
 * Wait for a map to be drawn, its loading screen gone and its columns built —
 * and still so a moment later: a dev server's first visit is reloaded under the
 * page once Vite has optimised its dependencies, which a single wait passes
 * straight through.
 */
async function opened(page) {
  const ready = () =>
    !document.body.textContent.includes('Opening ') &&
    document.querySelector('.heatmap-canvas') !== null &&
    document.querySelector('.panel-general:not(.is-absent)') !== null
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForFunction(ready, null, { timeout: 180000 })
    await sleep(2500)
    if (await page.evaluate(ready)) return
  }
}

/** Which columns are open, and what each one's badge says. */
function columns(page) {
  return page.evaluate(() =>
    ['files', 'general', 'annotations', 'aesthetics', 'analysis']
      .map((name) => {
        const column = document.querySelector(`.panel-${name}`)
        if (column === null) return `${name}: none`
        const state = column.classList.contains('is-absent') ? 'absent' : column.classList.contains('collapsed') ? 'folded' : 'open'
        const key = column.querySelector('.panel-column-key')?.textContent
        return `${name}: ${state} [${key}]`
      })
      .join(' · '),
  )
}

/** The lit stop of the resolution bar, the file's entry in the hash, and the map's window. */
function where(page) {
  return page.evaluate(() => {
    const lit = document.querySelector('.res-stop.current span')?.textContent ?? document.querySelector('.res-pick')?.selectedOptions?.[0]?.textContent
    const hash = decodeURIComponent(location.hash)
    const entry = /resolutions\/(\d+)/.exec(hash)?.[1]
    const coarsen = /coarsen=(\d+)/.exec(hash)?.[1]
    const region = /region=([^&]+)/.exec(hash)?.[1]
    return `lit ${lit} · entry ${entry}${coarsen === undefined ? '' : ` · coarsen ${coarsen}`} · region ${region}`
  })
}

/** A keystroke as an AZERTY PC sends it, to whatever has the focus. */
function azerty(page, init) {
  return page.evaluate((init) => {
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init }))
  }, init)
}

/** Connect the small folder through the palette's command and the input it opens. */
async function connectFolder(page) {
  await page.keyboard.press('Control+p')
  await sleep(400)
  await page.keyboard.type('folder')
  await sleep(400)
  await page.keyboard.press('Enter')
  await sleep(900)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.connect-signin button')])
  await chooser.setFiles(join(FOLDER, 'maps'))
  await sleep(1500)
}

/** Wait for the resolution bar to light a stop other than `was`. */
async function steppedFrom(page, was) {
  await page
    .waitForFunction(
      (was) => {
        const lit = document.querySelector('.res-stop.current span')?.textContent ?? document.querySelector('.res-pick')?.selectedOptions?.[0]?.textContent
        return lit !== undefined && lit !== was && document.querySelector('.heatmap-canvas') !== null && !document.body.textContent.includes('Opening ')
      },
      was,
      { timeout: 60000 },
    )
    .catch(() => console.log('  (no step)'))
  await sleep(2000)
}

/** The rung the bar has lit: a stop, or the dropdown's choice on a ladder past nine rungs. */
const litStop = (page) =>
  page.evaluate(() => document.querySelector('.res-stop.current span')?.textContent ?? document.querySelector('.res-pick')?.selectedOptions?.[0]?.textContent)

/** Add a resolution through the bar's `+`, as a reader types one. */
async function addRung(page, kb) {
  await page.click('.res-add')
  await sleep(400)
  const box = page.locator('.modal-panel .res-ask')
  await box.fill(String(kb))
  await box.dispatchEvent('input')
  await page.locator('.modal-panel input.res-unit-radio[value="kb"]').check().catch(() => {})
  await sleep(150)
  await page.locator('.modal-panel .modal-actions button', { hasText: /^add$/ }).click()
  await sleep(900)
}

try {
  // ------------------------------------------------------------ QWERTY
  await scene('QWERTY: the digit row', async ({ page, shot, shotOf }) => {
    await page.goto(YEAST)
    await opened(page)
    console.log('layout map:', await page.evaluate(async () => (await navigator.keyboard?.getLayoutMap?.())?.get('Backquote') ?? 'none'))
    console.log('at rest   ', await columns(page))
    await shot('pk01-qwerty-at-rest')
    await shotOf('pk01b-general-heading', '.panel-general .panel-column-head')
    await shotOf('pk01c-annotations-tab', '.panel-annotations .panel-tab')
    for (const key of ['Digit2', 'Digit4']) await page.keyboard.press(key)
    await sleep(900)
    console.log('2, 4      ', await columns(page))
    await shot('pk02-qwerty-2-4-open')
    for (const key of ['Digit1', 'Digit3']) await page.keyboard.press(key)
    await sleep(900)
    console.log('1, 3      ', await columns(page))
    await shot('pk03-qwerty-1-3-folded')
    // Shift is no different: `!` and `#` are the 1 and the 3.
    await page.keyboard.press('Shift+Digit1')
    await page.keyboard.press('Shift+Digit3')
    await sleep(900)
    console.log('⇧1, ⇧3    ', await columns(page))
    // The console on Control and the key left of 1.
    await page.keyboard.press('Control+Backquote')
    await sleep(900)
    console.log('ctrl+`     console', await page.evaluate(() => !document.querySelector('.console-drawer')?.classList.contains('collapsed')))
    await shot('pk04-qwerty-console')
    await page.keyboard.press('Control+Backquote')
    await sleep(500)
    await page.keyboard.press('?')
    await sleep(900)
    console.log('dialog View rows:', await page.evaluate(() =>
      [...document.querySelectorAll('.shortcut-group')]
        .filter((group) => group.querySelector('h3')?.textContent === 'View')
        .flatMap((group) => [...group.querySelectorAll('.shortcut-row')].map((row) => `${row.querySelector('kbd')?.textContent}=${row.querySelector('.shortcut-text')?.textContent}`))
        .filter((row) => /panel|resolution|Console/.test(row))
        .join(' | ')))
    await shot('pk05-qwerty-shortcuts-dialog')
    await shotOf('pk05b-dialog-view-keys', '.shortcut-group:has(.shortcut-row .shortcut-text:text-is("Console"))')
    await page.keyboard.press('Escape')
    await sleep(500)
    // A place connected, so the Files column is there — its key a word on a
    // QWERTY keyboard, which reads along its tab's spine once it is folded.
    await connectFolder(page)
    console.log('connected ', await columns(page))
    await shotOf('pk05c-files-heading', '.panel-files .panel-column-head')
    await page.keyboard.press('Backquote')
    await sleep(900)
    console.log('`         ', await columns(page))
    await shotOf('pk05d-files-tab', '.panel-files .panel-tab', 4)
    await page.keyboard.press('Shift+Backquote')
    await sleep(900)
    console.log('⇧` (~)    ', await columns(page))
  })

  await scene('QWERTY: − and + on a ladder', async ({ page, shot, shotOf }) => {
    await page.goto(ECOLI)
    await opened(page)
    await page.keyboard.press('Digit1')
    await sleep(800)
    console.log('at rest   ', await where(page))
    await shot('pk06-ecoli-1kb')
    await shotOf('pk06b-ecoli-resolution-bar', '.crumb-res')
    // The map's canvas holds the focus — as it does after any press on it —
    // which is the case where `−` used to zoom it as well. Focused rather than
    // clicked: a click on a cell opens what the cell refers to.
    await page.focus('.heatmap-canvas')
    await sleep(500)
    const zoomBefore = await page.evaluate(() => document.querySelector('.view-head')?.innerText.replace(/\s+/g, ' ').slice(0, 140))
    console.log('focus on  ', await page.evaluate(() => document.activeElement?.className), '· window', zoomBefore)
    let was = await litStop(page)
    await page.keyboard.press('Minus')
    await steppedFrom(page, was)
    console.log('−         ', await where(page))
    await shotOf('pk07b-ecoli-resolution-bar', '.crumb-res')
    // The same window at a coarser grid: no zoom came with the step.
    console.log('window now', await page.evaluate(() => document.querySelector('.view-head')?.innerText.replace(/\s+/g, ' ').slice(0, 140)))
    await shot('pk07-ecoli-minus')
    was = await litStop(page)
    await page.keyboard.press('Shift+Minus')
    await steppedFrom(page, was)
    console.log('⇧− (_)    ', await where(page))
    await shot('pk08-ecoli-shift-minus')
    was = await litStop(page)
    await page.keyboard.press('Equal')
    await steppedFrom(page, was)
    console.log('= (bare +)', await where(page))
    was = await litStop(page)
    await page.keyboard.press('Shift+Equal')
    await steppedFrom(page, was)
    console.log('⇧= (+)    ', await where(page))
    await shot('pk09-ecoli-back-to-1kb')
    // This ladder goes on below 1 kb, to 500 bp, which is its end.
    was = await litStop(page)
    await page.keyboard.press('Shift+Equal')
    await steppedFrom(page, was)
    console.log('+         ', await where(page))
    await page.keyboard.press('Shift+Equal')
    await sleep(2500)
    console.log('+ at end  ', await where(page), '(the finest: nothing to step to)')
    console.log('window now', await page.evaluate(() => document.querySelector('.view-head')?.innerText.replace(/\s+/g, ' ').slice(0, 140)))
    await page.keyboard.press('Control+p')
    await sleep(400)
    await page.keyboard.type('resolution')
    await sleep(600)
    console.log('palette:', await page.evaluate(() =>
      [...document.querySelectorAll('.palette-row, .cmd-row, [role="option"]')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()).slice(0, 6).join(' | ')))
    await shot('pk10-ecoli-palette')
  })

  await scene('QWERTY: − and + over rungs the reader added', async ({ page, shot, shotOf }) => {
    // The yeast cooler stores one resolution, so the two keys start greyed;
    // each rung added through the `+` is one more stop for them to walk.
    await page.goto(YEAST)
    await opened(page)
    console.log('one rung  ', await litStop(page), await page.evaluate(() => document.querySelector('.res-stop')?.textContent))
    // Each rung added is stood on as it is added, so the walk starts back at the file's own.
    for (const kb of [2, 5]) await addRung(page, kb)
    let was = await litStop(page)
    await page.keyboard.press('Equal')
    await steppedFrom(page, was)
    was = await litStop(page)
    await page.keyboard.press('Equal')
    await steppedFrom(page, was)
    console.log('back at   ', await litStop(page))
    await shotOf('pk19-yeast-added-1kb', '.crumb-res')
    for (const step of ['first', 'second']) {
      was = await litStop(page)
      await page.keyboard.press('Minus')
      await steppedFrom(page, was)
      console.log(`− (${step})`, await litStop(page), '·', await page.evaluate(() => /coarsen=(\d+)/.exec(decodeURIComponent(location.hash))?.[1]))
    }
    await shot('pk20-yeast-added-5kb')
    await shotOf('pk20b-yeast-added-5kb-bar', '.crumb-res')
    // Past nine rungs the bar is a dropdown; the keys walk it the same way.
    for (const kb of [3, 4, 6, 8, 10, 16, 20]) await addRung(page, kb)
    console.log('dropdown  ', await page.evaluate(() => [...(document.querySelector('.res-pick')?.options ?? [])].map((o) => o.textContent).join(' ')))
    was = await litStop(page)
    await page.keyboard.press('Shift+Equal')
    await steppedFrom(page, was)
    console.log('+         ', await litStop(page))
    await shotOf('pk21-yeast-dropdown-bar', '.crumb-res')
  })

  // ------------------------------------------------------------ AZERTY
  await scene('AZERTY: the row and the key left of 1', async ({ page, shot, shotOf }) => {
    await page.goto(YEAST)
    await opened(page)
    console.log('layout map:', await page.evaluate(async () => (await navigator.keyboard?.getLayoutMap?.())?.get('Backquote') ?? 'none'))
    await connectFolder(page)
    console.log('connected ', await columns(page))
    await shot('pk11-azerty-files-open')
    await shotOf('pk11b-azerty-files-heading', '.panel-files .panel-column-head')
    // The key left of 1, bare: `²`.
    await azerty(page, { key: '²', code: 'Backquote' })
    await sleep(900)
    console.log('²         ', await columns(page))
    await shotOf('pk11c-azerty-files-tab', '.panel-files .panel-tab', 4)
    // The row bare — `&` `é` `"` `'` — folds or opens each in turn.
    for (const [key, code] of [['&', 'Digit1'], ['é', 'Digit2'], ['"', 'Digit3'], ["'", 'Digit4']]) await azerty(page, { key, code })
    await sleep(900)
    console.log('& é " \'   ', await columns(page))
    await shot('pk12-azerty-bare-row')
    // The same keys under Shift, and under Caps Lock: the digits themselves.
    await azerty(page, { key: '1', code: 'Digit1', shiftKey: true })
    await azerty(page, { key: '3', code: 'Digit3', modifierCapsLock: true })
    await azerty(page, { key: '²', code: 'Backquote', shiftKey: true })
    await sleep(900)
    console.log('⇧1 ⇪3 ⇧²  ', await columns(page))
    await shot('pk13-azerty-shift-caps')
    // Ctrl-²: the console.
    await azerty(page, { key: '²', code: 'Backquote', ctrlKey: true })
    await sleep(900)
    console.log('ctrl+²     console', await page.evaluate(() => !document.querySelector('.console-drawer')?.classList.contains('collapsed')))
    console.log('  its button:', await page.evaluate(() => document.querySelector('button[aria-label="console"]')?.title))
    console.log('  Files tab :', await page.evaluate(() => document.querySelector('.panel-files .panel-tab')?.title))
    await shot('pk14-azerty-console')
    await azerty(page, { key: '²', code: 'Backquote', ctrlKey: true })
    await page.keyboard.press('?')
    await sleep(900)
    await shot('pk15-azerty-shortcuts-dialog')
    await shotOf('pk15b-azerty-dialog-view-keys', '.shortcut-group:has(.shortcut-row .shortcut-text:text-is("Console"))')
  }, { azerty: true })

  await scene('AZERTY: the minus on the 6 key', async ({ page, shot }) => {
    await page.goto(ECOLI)
    await opened(page)
    console.log('at rest   ', await where(page))
    for (const [label, init] of [
      ['6 under ⇧', { key: '6', code: 'Digit6', shiftKey: true }],
      ['6 under ⇪', { key: '6', code: 'Digit6', modifierCapsLock: true }],
      ['- bare   ', { key: '-', code: 'Digit6' }],
    ]) {
      const was = await litStop(page)
      await azerty(page, init)
      await steppedFrom(page, was)
      console.log(label, ' ', await where(page))
    }
    await shot('pk16-azerty-minus-thrice')
    // `_` bare is AZERTY's 8, not a minus; `=` bare and `+` shifted are the plus.
    let was = await litStop(page)
    await azerty(page, { key: '_', code: 'Digit8' })
    await sleep(1500)
    console.log('_ (the 8)  ', await where(page), '(unchanged)')
    await azerty(page, { key: '=', code: 'Equal' })
    await steppedFrom(page, was)
    console.log('= bare    ', await where(page))
    was = await litStop(page)
    await azerty(page, { key: '+', code: 'Equal', shiftKey: true })
    await steppedFrom(page, was)
    console.log('+ ⇧       ', await where(page))
  }, { azerty: true })
  // ------------------------------------------------------------ close-ups
  // The badges at three times their size, where a superscript `²` can be told
  // from the `2` of the column beside it: the Files and General headings, and
  // three folded tabs as the strip at the left edge stands them.
  await scene('AZERTY: the caps, close', async ({ page, shotOf }) => {
    await page.goto(YEAST)
    await opened(page)
    await page.evaluate(() => {
      const strip = (id) => {
        const node = document.createElement('div')
        node.id = id
        node.style.cssText = 'position:fixed;left:20px;z-index:99;background:var(--bg);padding:10px;display:flex;gap:18px;align-items:center'
        document.body.append(node)
        return node
      }
      const heads = strip('pk-heads')
      heads.style.top = '140px'
      for (const name of ['files', 'general', 'annotations']) heads.append(document.querySelector(`.panel-${name} .panel-column-head`).cloneNode(true))
      const tabs = strip('pk-tabs')
      tabs.style.top = '220px'
      for (const name of ['files', 'general', 'annotations']) {
        const column = document.querySelector(`.panel-${name}`).cloneNode(true)
        column.className = 'panel-column panel-column-left collapsed'
        column.style.cssText = 'position:relative;height:220px;width:auto;order:0'
        tabs.append(column)
      }
    })
    await shotOf('pk17-azerty-heading-caps-3x', '#pk-heads', 0)
    await shotOf('pk18-azerty-tab-caps-3x', '#pk-tabs', 0)
  }, { azerty: true, scale: 3 })
} finally {
  await browser.close()
  console.log(errors.length === 0 ? '\nno page errors' : `\npage errors:\n${errors.join('\n')}`)
}
