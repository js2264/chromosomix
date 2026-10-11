/**
 * The view's keys, driven in the real app (§5.5, §5.6, §7.2, §8.10, §26.6).
 *
 * `<` and `>` step to the neighbouring sequence and Control with them to the tab
 * beside this one; `0` refits from anywhere and Page Up / Page Down zoom the
 * focused map; `e` is the O/E, `f` the track fill, `m` the breaks, `b` a bookmark
 * and `?` the shortcuts dialog. A screenshot carries no keystroke, so the script
 * prints, after every press, what moved: the region in the hash, the window the
 * heading names, a toggle's state, the open columns.
 *
 * Three keyboards. **QWERTY** is Playwright's own, real key presses through the
 * browser's input. A **French PC** and a **French Mac** are the events those
 * keyboards send, dispatched to whatever has the focus, with the layout map
 * Chromium would hand over stubbed in an init script — and, for the Mac, the
 * platform — since no headless browser can be given a layout of its own. On the
 * Mac the `<` key is the one beside the left Shift, which its ISO keyboard
 * reports as `Backquote`: the key that must step, and must not fold Files.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-view-keys.mjs gallery      # vk01 … vk16
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

/** Yeast Micro-C on IV:1.0–1.4 Mb, with its tracks: III before it, V after. */
const YEAST = `${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.chromosomix.json`

/** A French PC's layout map, as Chromium would return it: each key bare. */
const AZERTY_PC = {
  Backquote: '²', Digit1: '&', Digit2: 'é', Digit3: '"', Digit4: "'", Digit5: '(', Digit6: '-',
  Digit7: 'è', Digit8: '_', Digit9: 'ç', Digit0: 'à', Minus: ')', Equal: '=',
  KeyQ: 'a', KeyW: 'z', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyY: 'y', KeyU: 'u', KeyI: 'i', KeyO: 'o', KeyP: 'p',
  KeyA: 'q', KeyS: 's', KeyD: 'd', KeyF: 'f', KeyG: 'g', KeyH: 'h', KeyJ: 'j', KeyK: 'k', KeyL: 'l', Semicolon: 'm',
  KeyZ: 'w', KeyX: 'x', KeyC: 'c', KeyV: 'v', KeyB: 'b', KeyN: 'n', KeyM: ',', Comma: ';', Period: ':', Slash: '!',
  IntlBackslash: '<', BracketLeft: '^', BracketRight: '$', Quote: 'ù', Backslash: '*',
}

/**
 * A French Mac's: the top-left key, `@`, is `IntlBackslash` to its ISO keyboard,
 * and the `<` beside the left Shift is `Backquote`.
 */
const AZERTY_MAC = {
  ...AZERTY_PC,
  IntlBackslash: '@', Backquote: '<', Digit6: '§', Digit8: '!', Minus: ')', Equal: '-', Slash: '=', Backslash: '`',
}

/** A small folder to connect, so the Files column exists (it is there only while a place is). */
const FOLDER = mkdtempSync(join(tmpdir(), 'view-keys-'))
mkdirSync(join(FOLDER, 'maps'))
writeFileSync(join(FOLDER, 'maps', 'Yeast_G1.mcool'), '')
writeFileSync(join(FOLDER, 'maps', 'notes.txt'), 'one map')

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []

async function scene(name, run, { layout = null, mac = false } = {}) {
  console.log(`\n== ${name}`)
  const context = await browser.newContext({ viewport: { width: 1920, height: 1100 } })
  await context.addInitScript(
    ({ layout, mac }) => {
      // A browser with no directory picker connects a folder as a snapshot,
      // which an input — and so Playwright — can answer.
      delete window.showDirectoryPicker
      if (mac) Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' })
      if (layout === null) return
      const keyboard = { getLayoutMap: () => Promise.resolve(new Map(Object.entries(layout))), lock: () => Promise.resolve(), unlock: () => {} }
      Object.defineProperty(Navigator.prototype, 'keyboard', { configurable: true, get: () => keyboard })
    },
    { layout, mac },
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
    await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {})
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

/** The region in the hash, and the window the line under the heading names. */
const where = (page) =>
  page.evaluate(() => {
    const hash = new URLSearchParams(location.hash.slice(1))
    // The line under the title: `… bins · effective resolution: 1 kb · IV:452,001-1,080,000 · 628.0 kb`,
    // or the span alone where the title already names the window.
    const head = document.querySelector('.view-head')?.innerText.replace(/\s+/g, ' ') ?? ''
    const after = head.split('effective resolution: ')[1] ?? ''
    const window = after.split(' · ').slice(1, 3).join(' · ')
    return `region ${hash.get('region')} · on screen ${window === '' ? '?' : window}`
  })

/** Wait for the hash's region to be something other than `was`, and the map drawn again. */
async function movedFrom(page, was) {
  await page
    .waitForFunction(
      (was) =>
        new URLSearchParams(location.hash.slice(1)).get('region') !== was &&
        document.querySelector('.heatmap-canvas') !== null &&
        !document.body.textContent.includes('Opening '),
      was,
      { timeout: 60000 },
    )
    .catch(() => console.log('  (did not move)'))
  await sleep(2500)
}

const regionNow = (page) => page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('region'))

/** Which columns are open, and what each one's badge says. */
const columns = (page) =>
  page.evaluate(() =>
    ['files', 'general', 'annotations', 'aesthetics', 'analysis']
      .map((name) => {
        const column = document.querySelector(`.panel-${name}`)
        if (column === null) return `${name}: none`
        const state = column.classList.contains('is-absent') ? 'absent' : column.classList.contains('collapsed') ? 'folded' : 'open'
        return `${name}: ${state} [${column.querySelector('.panel-column-key')?.textContent}]`
      })
      .join(' · '),
  )

/** An overlay toggle's state, read off its button's title. */
const toggle = (page, label) =>
  page.evaluate((label) => {
    const button = [...document.querySelectorAll('button[aria-pressed]')].find((node) =>
      (node.getAttribute('title') ?? '').toLowerCase().startsWith(label),
    )
    return button === undefined ? 'none' : `${button.getAttribute('aria-pressed')} — “${button.getAttribute('title')?.slice(0, 70)}”`
  }, label)

/** The O/E toggle's state, and what the legend says the cells are. */
const expected = (page) =>
  page.evaluate(() => {
    const button = [...document.querySelectorAll('button.btn-word')].find((node) => node.textContent === 'O/E')
    return `O/E ${button?.getAttribute('aria-pressed')} · title “${button?.title.slice(0, 40)}…”`
  })

/** A keystroke as a French PC or Mac sends it, to whatever has the focus. */
function send(page, init) {
  return page.evaluate((init) => {
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init }))
  }, init)
}

/** Connect the small folder through the palette's command and the input it opens. */
async function connectFolder(page, palette = 'Control+p') {
  await page.keyboard.press(palette)
  await sleep(400)
  await page.keyboard.type('folder')
  await sleep(400)
  await page.keyboard.press('Enter')
  await sleep(900)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.connect-signin button')])
  await chooser.setFiles(join(FOLDER, 'maps'))
  await sleep(1500)
}

/** The tab strip: how many, and which is in front. */
const tabs = (page) =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll('.tabstrip [role="tab"]')]
    const front = all.findIndex((tab) => tab.getAttribute('aria-selected') === 'true' || tab.classList.contains('active'))
    return `${all.length} tabs, front ${front}`
  })

try {
  // ------------------------------------------------------------ QWERTY
  await scene('QWERTY: < and >, 0, Page Up and Down', async ({ page, shot, shotOf }) => {
    await page.goto(YEAST)
    await opened(page)
    console.log('at rest   ', await where(page))
    console.log('stepper   ', await page.evaluate(() => [...document.querySelectorAll('.stepper button')].map((b) => b.title).join(' | ')))
    await shot('vk01-qwerty-at-rest')
    // The comma and the full stop, bare: the keys `<` and `>` are on.
    let was = await regionNow(page)
    await page.keyboard.press('Comma')
    await movedFrom(page, was)
    console.log(',  (bare) ', await where(page))
    was = await regionNow(page)
    await page.keyboard.press('Period')
    await movedFrom(page, was)
    console.log('.  (bare) ', await where(page))
    was = await regionNow(page)
    await page.keyboard.press('Shift+Period')
    await movedFrom(page, was)
    console.log('>  (⇧.)   ', await where(page))
    await shot('vk02-qwerty-next-is-V')
    was = await regionNow(page)
    await page.keyboard.press('Shift+Comma')
    await movedFrom(page, was)
    console.log('<  (⇧,)   ', await where(page))
    // Page Up and Page Down zoom the focused map about its centre.
    await page.focus('.heatmap-canvas')
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('PageUp')
      await sleep(250)
    }
    await sleep(1500)
    console.log('PgUp ×4   ', await where(page))
    await shot('vk03-qwerty-page-up-x4')
    await page.keyboard.press('PageDown')
    await sleep(1500)
    console.log('PgDn      ', await where(page))
    // `0` from anywhere: the focus on the page rather than the map.
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    await page.keyboard.press('Digit0')
    await sleep(1500)
    console.log('0 (blurred)', await where(page), '· focus on', await page.evaluate(() => document.activeElement?.tagName))
    await shot('vk04-qwerty-zero-refits')
  })

  await scene('QWERTY: e, f, m, b, ? and the tabs', async ({ page, shot, shotOf }) => {
    await page.goto(YEAST)
    await opened(page)
    console.log('before    ', await expected(page))
    await page.keyboard.press('e')
    await sleep(2500)
    console.log('e         ', await expected(page))
    console.log('legend    ', await page.evaluate(() => document.querySelector('.view-sub, .region-sub, .summary-line')?.textContent ?? ''))
    await shot('vk05-qwerty-e-oe-on')
    await shotOf('vk05b-qwerty-oe-button', '.field-block:has(.btn-word)')
    await page.keyboard.press('e')
    await sleep(2000)
    console.log('e again   ', await expected(page))
    console.log('fills     ', await toggle(page, 'track fill'))
    await page.keyboard.press('f')
    await sleep(1200)
    console.log('f         ', await toggle(page, 'track fill'))
    await shot('vk06-qwerty-f-fills-off')
    await page.keyboard.press('f')
    await sleep(600)
    console.log('breaks    ', await toggle(page, 'breaks'))
    await page.keyboard.press('m')
    await sleep(1200)
    console.log('m         ', await toggle(page, 'breaks'))
    await shot('vk07-qwerty-m-breaks-off')
    await page.keyboard.press('m')
    await sleep(600)
    // `b`: a bookmark of the window on screen, on the Annotations column's card.
    await page.keyboard.press('Digit2')
    await sleep(800)
    await page.keyboard.press('b')
    await sleep(1200)
    const rows = await page.evaluate(() => [...document.querySelectorAll('.bookmark-row')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()))
    console.log('b         ', rows)
    console.log('  button  ', await page.evaluate(() => document.querySelector('.region-bar button[title^="Bookmark"]')?.title))
    await shot('vk08-qwerty-b-bookmarked')
    await shotOf('vk08b-qwerty-bookmarks-card', '.annotation-card:has(.bookmark-row)')
    await page.keyboard.press('b')
    await sleep(800)
    console.log('b again   ', await page.evaluate(() => document.querySelector('.annotation-card:has(.bookmark-row) .ann-note, .annotation-card:has(.bookmark-row) [class*="note"]')?.textContent))
    // `?`: the shortcuts dialog.
    await page.keyboard.press('?')
    await sleep(900)
    console.log('dialog    ', await page.evaluate(() =>
      [...document.querySelectorAll('.shortcut-grid:not(.shortcut-gestures) .shortcut-row')]
        .map((row) => `${row.querySelector('kbd')?.textContent}=${row.querySelector('.shortcut-text')?.textContent}`)
        .filter((row) => /^(<|>|0|\?|E|F|M|B|Ctrl\+[<>])=/.test(row))
        .join(' | ')))
    console.log('gestures  ', await page.evaluate(() =>
      [...document.querySelectorAll('.shortcut-gestures .shortcut-row')]
        .map((row) => row.textContent?.replace(/\s+/g, ' ').trim())
        .filter((row) => /Page|Home|^0|\+ \/ −/.test(row))
        .join(' | ')))
    await shot('vk09-qwerty-shortcuts-dialog')
    await shotOf('vk09b-qwerty-dialog-go', '.shortcut-group:has(.shortcut-row .shortcut-text:text-is("Bookmark this view"))')
    await shotOf('vk09c-qwerty-dialog-map-gestures', '.shortcut-gestures .shortcut-group')
    await page.keyboard.press('Escape')
    await sleep(500)
    // Control with them: the tabs.
    await page.keyboard.press('o')
    await sleep(1200)
    console.log('o         ', await tabs(page))
    await page.keyboard.press('Control+Comma')
    await sleep(1500)
    console.log('ctrl+,    ', await tabs(page))
    await page.keyboard.press('Control+Shift+Period')
    await sleep(1500)
    console.log('ctrl+>    ', await tabs(page))
  })

  // ------------------------------------------------------------ a French PC
  await scene('French PC: < and > on their own key, à for 0', async ({ page, shot }) => {
    await page.goto(YEAST)
    await opened(page)
    console.log('at rest   ', await where(page))
    let was = await regionNow(page)
    await send(page, { key: '<', code: 'IntlBackslash' })
    await movedFrom(page, was)
    console.log('<         ', await where(page))
    was = await regionNow(page)
    await send(page, { key: '>', code: 'IntlBackslash', shiftKey: true })
    await movedFrom(page, was)
    console.log('⇧< (>)    ', await where(page))
    // Its comma (the M key) and its `;` (where QWERTY's comma is) carry no mark.
    was = await regionNow(page)
    await send(page, { key: ',', code: 'KeyM' })
    await send(page, { key: ';', code: 'Comma' })
    await sleep(2500)
    console.log(', ;       ', await where(page), (await regionNow(page)) === was ? '(unchanged)' : '(MOVED)')
    await page.focus('.heatmap-canvas')
    for (let i = 0; i < 3; i++) await page.keyboard.press('PageUp')
    await sleep(1500)
    console.log('PgUp ×3   ', await where(page))
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    await send(page, { key: 'à', code: 'Digit0' })
    await sleep(1500)
    console.log('à         ', await where(page))
    await shot('vk10-azerty-pc-a-grave-refits')
  }, { layout: AZERTY_PC })

  // ------------------------------------------------------------ a French Mac
  await scene('French Mac: < beside the left Shift steps, @ folds Files', async ({ page, shot, shotOf }) => {
    await page.goto(YEAST)
    await opened(page)
    await connectFolder(page, 'Meta+p')
    console.log('connected ', await columns(page))
    await shotOf('vk11-mac-fr-files-heading', '.panel-files .panel-column-head')
    let was = await regionNow(page)
    await send(page, { key: '<', code: 'Backquote' })
    await movedFrom(page, was)
    console.log('<         ', await where(page))
    console.log('          ', await columns(page))
    was = await regionNow(page)
    await send(page, { key: '>', code: 'Backquote', shiftKey: true })
    await movedFrom(page, was)
    console.log('⇧< (>)    ', await where(page))
    console.log('          ', await columns(page))
    await shot('vk12-mac-fr-stepped-files-open')
    // The key left of 1, `@`: Files.
    await send(page, { key: '@', code: 'IntlBackslash' })
    await sleep(900)
    console.log('@         ', await columns(page))
    await shot('vk13-mac-fr-at-folds-files')
    // Control and `<`: the tab before this one, Control on a Mac too.
    await send(page, { key: 'o', code: 'KeyO' })
    await sleep(1200)
    console.log('o         ', await tabs(page))
    await send(page, { key: '<', code: 'Backquote', ctrlKey: true })
    await sleep(1500)
    console.log('⌃<        ', await tabs(page))
    await send(page, { key: '?', code: 'KeyM', shiftKey: true })
    await sleep(900)
    console.log('dialog    ', await page.evaluate(() =>
      [...document.querySelectorAll('.shortcut-grid:not(.shortcut-gestures) .shortcut-row')]
        .map((row) => `${row.querySelector('kbd')?.textContent}=${row.querySelector('.shortcut-text')?.textContent}`)
        .filter((row) => /tab|sequence|Files|shortcuts/i.test(row))
        .join(' | ')))
    await shot('vk14-mac-fr-shortcuts-dialog')
    await shotOf('vk14b-mac-fr-dialog-go', '.shortcut-group:has(.shortcut-row .shortcut-text:text-is("Previous tab"))')
  }, { layout: AZERTY_MAC, mac: true })
} finally {
  await browser.close()
  console.log(errors.length === 0 ? '\nno page errors' : `\npage errors:\n${errors.join('\n')}`)
}
