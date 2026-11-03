/**
 * What the capture scripts beside this one share (the 1D and 3D task pages of
 * `documentation/src/content/docs/analyses/`): a headless Chromium on the dev
 * server at 1440 × 900 and twice the density, in the light theme, and the
 * handles the repository's own galleries (`scripts/ui-*.mjs`) drive a task
 * with — a panel folded, a task's row opened, its form set, **run** pressed and
 * this run's result waited for, a file dropped on a card.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/<task>.cjs <out-dir>
 *
 * Files on the lab's bucket are read through HTTPS_PROXY when one is set,
 * handed to Chromium as its own flag so the dev server stays direct.
 */
const { chromium } = require('playwright')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

const BASE = process.env.SCREENS_BASE ?? 'http://127.0.0.1:5173'
const BUCKET = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A page at the documentation's size. `drawer` is the analysis drawer's width
 * in CSS pixels, kept where the app keeps a width the reader dragged it to.
 */
async function open(out, { width = 1440, height = 900, drawer = null } = {}) {
  mkdirSync(out, { recursive: true })
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
  const browser = await chromium.launch({
    args: [
      ...(proxy ? [`--proxy-server=${proxy}`] : []),
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: 'light' })
  if (drawer !== null) {
    await context.addInitScript((px) => {
      try { localStorage.setItem('chromosomix:analysis-drawer:width', String(px)) } catch {}
    }, drawer)
  }
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  const shot = async (name, clip) => {
    await page.mouse.move(2, height - 2)
    await sleep(300)
    await page.screenshot({ path: join(out, `${name}.png`), ...(clip ? { clip } : {}) })
    console.log('shot', name)
  }
  const fold = async (title) => {
    for (const b of await page.$$(`button[title^="${title}"]`)) {
      if (await b.isVisible()) { await b.click(); await sleep(700); return true }
    }
    return false
  }
  /** The map drawn and nothing still opening. */
  const mapDrawn = (timeout = 180000) =>
    page.waitForFunction(
      () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
      null,
      { timeout },
    )
  const until = (text, timeout = 180000) =>
    page.waitForFunction((t) => (document.body.innerText ?? '').includes(t), text, { timeout })
      .catch(() => console.log('never saw:', text))
  const closeDrawer = async () => {
    const close = page.locator('.analysis-drawer-head button').last()
    if (await close.isVisible().catch(() => false)) { await close.click(); await sleep(1200) }
  }
  /** A task's row, pressed once it can be: a task waiting for its inputs is drawn disabled. */
  const openTask = async (title) => {
    await closeDrawer()
    const row = page.locator('.analysis-row-title', { hasText: title }).first()
    for (let tries = 0; tries < 6 && !(await row.isVisible().catch(() => false)); tries++) {
      await fold('Show the Analysis panel')
      await sleep(1200)
    }
    await page.waitForFunction(
      (t) => {
        const head = [...document.querySelectorAll('.analysis-row-title')].find((n) => (n.textContent ?? '').trim() === t)
        const r = head?.closest('button, [role="button"], .analysis-row')
        return r != null && !r.matches(':disabled, [aria-disabled="true"], .disabled, .is-disabled')
      },
      title,
      { timeout: 180000 },
    ).catch(() => console.log('row never enabled:', title))
    await row.scrollIntoViewIfNeeded()
    await row.click()
    await sleep(1400)
  }
  /** The form's field whose label reads `label`. */
  const field = (label) =>
    page.locator('.analysis-drawer .field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`, 'i') }) }).first()
  /** A select of the field `label` set to the option containing `wanted`, or a checkbox row of it ticked. */
  const pick = async (label, wanted) => {
    const control = field(label)
    if ((await control.count()) === 0) { console.log('no field', label); return false }
    const select = control.locator('select').first()
    if (await select.count()) {
      const options = await select.locator('option').evaluateAll((all) => all.map((o) => ({ value: o.value, text: o.textContent ?? '' })))
      const match = options.find((o) => o.text.includes(wanted) || o.value === wanted)
      if (match === undefined) { console.log('no option', wanted, 'in', label, options.map((o) => o.text)); return false }
      await select.selectOption(match.value)
      await sleep(600)
      return true
    }
    const row = control.locator('label', { hasText: wanted }).first()
    if ((await row.count()) === 0) { console.log('no row', wanted, 'in', label); return false }
    await row.locator('input[type="checkbox"]').check()
    await sleep(500)
    return true
  }
  /** Untick every checkbox of the field `label` but those whose row contains one of `keep`. */
  const only = async (label, keep) => {
    const rows = field(label).locator('label')
    for (let i = 0; i < (await rows.count()); i++) {
      const text = (await rows.nth(i).innerText()).trim()
      const box = rows.nth(i).locator('input[type="checkbox"]')
      if ((await box.count()) === 0) continue
      if (keep.some((k) => text.includes(k))) await box.check()
      else await box.uncheck()
    }
    await sleep(500)
  }
  /** The text, number or region box of the field `label`, typed into and entered. */
  const type = async (label, value) => {
    const box = field(label).locator('input:not([type="checkbox"])').first()
    await box.fill(String(value))
    await box.press('Enter')
    await sleep(600)
  }
  /** A toggle of the form set on or off. */
  const toggle = async (label, on) => {
    const control = field(label)
    const pressed = control.locator(`button[aria-pressed="${on ? 'false' : 'true'}"]`).first()
    if (await pressed.count()) { await pressed.click(); await sleep(500); return true }
    const box = control.locator('input[type="checkbox"]').first()
    if (await box.count()) { if (on) await box.check(); else await box.uncheck(); await sleep(500); return true }
    return false
  }
  const computed = () =>
    page.evaluate(() => document.querySelector('.analysis-drawer-body')?.innerText.match(/computed in [^\n]*/)?.[0] ?? '')
  /** Press run and wait for *this* run's line and `marker` in the drawer. */
  const run = async (marker, timeout = 600000) => {
    const before = await computed()
    await page.locator('.analysis-drawer button', { hasText: /^run$/i }).first().click()
    await page.waitForFunction(({ before, marker }) => {
      const text = document.querySelector('.analysis-drawer-body')?.innerText ?? ''
      const now = text.match(/computed in [^\n]*/)?.[0] ?? ''
      return now !== '' && now !== before && text.includes(marker)
    }, { before, marker }, { timeout }).catch(() => console.log('run did not finish:', marker))
    await sleep(2500)
  }
  const notes = () => page.evaluate(() => [...document.querySelectorAll('.analysis-drawer-body li')].map((li) => li.innerText).join('\n'))
  /** Scroll the drawer so the leaf reading `needle` is `offset` pixels under its top. */
  const scrollDrawerTo = (needle, offset = 12) => page.evaluate(({ needle, offset }) => {
    const body = document.querySelector('.analysis-drawer-body')
    const hit = [...(body?.querySelectorAll('*') ?? [])].find((el) => el.childElementCount === 0 && (el.textContent ?? '').includes(needle))
    if (hit === undefined) return false
    let scroller = hit.parentElement
    while (scroller !== null && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
    if (scroller === null) { hit.scrollIntoView({ block: 'start' }); return true }
    scroller.scrollTop += hit.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset
    return true
  }, { needle, offset })
  /** Scroll the drawer so the figure block whose heading matches `head` starts `offset` pixels under its top. */
  const scrollDrawerToBlock = (head, offset = 6) => page.evaluate(({ head, offset }) => {
    const re = new RegExp(head)
    const block = [...document.querySelectorAll('.analysis-drawer .figure-block')].find((b) => re.test(b.querySelector('.analysis-figure-head')?.textContent ?? ''))
    if (block === undefined) return false
    let scroller = block.parentElement
    while (scroller !== null && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
    if (scroller === null) { block.scrollIntoView({ block: 'start' }); return true }
    scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset
    return true
  }, { head, offset })
  /** Where every figure block of the drawer is, in CSS pixels, with its heading. */
  const blocks = () => page.evaluate(() => [...document.querySelectorAll('.analysis-drawer .figure-block')].map((b) => {
    const r = b.getBoundingClientRect()
    return { head: (b.querySelector('.analysis-figure-head')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }))
  /** A file fetched in the page and dropped on the card's drop zone reading `zone`. */
  const drop = (url, name, zone) => page.evaluate(async ({ url, name, zone }) => {
    const target = [...document.querySelectorAll('.ann-drop')].find((el) => new RegExp(zone).test(el.textContent ?? ''))
    if (target === undefined) throw new Error(`no drop zone ${zone}`)
    const file = new File([await (await fetch(url)).arrayBuffer()], name)
    const transfer = new DataTransfer()
    transfer.items.add(file)
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  }, { url, name, zone })
  const dropTrack = (url, name) => drop(url, name, 'Load a track')
  /** An address typed into the header's `+` and opened: a map beside, a track under, read by range. */
  const addByUrl = async (url) => {
    await page.locator('.app-head .head-add').click()
    await sleep(700)
    await page.locator('.modal-panel input.input-url').fill(url)
    await page.locator('.modal-panel button', { hasText: /^open$/ }).click()
    await sleep(1500)
  }
  /** Every sequence of a `sequences` field ticked, from its own `all`. */
  const tickAll = async (label = 'sequences') => {
    const all = field(label).locator('button, a, span', { hasText: /^all$/ }).first()
    if (await all.count()) { await all.click(); await sleep(600); return true }
    return false
  }
  /** A model dropped on the Structures card, as `scripts/ui-gallery.mjs` drops it. */
  const dropStructure = (url, name) => page.evaluate(async ({ url, name }) => {
    const card = document.querySelector('.structure-card')
    if (card === null) throw new Error('no Structures card')
    const file = new File([await (await fetch(url)).arrayBuffer()], name, { type: 'application/gzip' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  }, { url, name })
  /** Where an element is, in CSS pixels, for a crop. */
  const box = (selector) => page.evaluate((s) => {
    const el = document.querySelector(s)
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, selector)
  const close = async () => {
    console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
    await browser.close()
  }
  return { page, errors, shot, fold, mapDrawn, until, openTask, closeDrawer, field, pick, only, type, toggle, run, notes, scrollDrawerTo, scrollDrawerToBlock, blocks, drop, dropTrack, addByUrl, tickAll, dropStructure, box, close }
}

module.exports = { open, sleep, BASE, BUCKET }
