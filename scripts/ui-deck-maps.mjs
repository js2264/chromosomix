/**
 * A deck of many maps, in headless Chromium: dropped at once, named, run on
 * together, framed on a circle's origin and reordered from the Contact maps card
 * (§16.9, §16.10, §16.11, §18.7, §8.15).
 *
 * Four parts, each printing what it found as well as shooting it, so a map that
 * did not open, a name that did not reach a legend or a row that did not move is
 * a line in the log:
 *
 * - **drop** — eight copies of the yeast cooler, a GTF and a FASTA dropped on the
 *   landing page: every map must open in a cell of its own, none of them a cell
 *   reading *could not be re-opened*.
 * - **maps** — three copies of the *E. coli* demo dropped, its origin typed into
 *   the Chromosomes table, renamed WT, dparAB and 20min on their headings;
 *   Inter-arm alignment and Reproducibility run on all three, with the `all maps`
 *   tab's stacked table and the comparison shown once, every map named by its
 *   name; then, with no map starred, the O/E and `arms` from the first map's card
 *   reaching every map, `ori` framing every map across the junction, and a
 *   starred companion's card carrying `arms` and `ori` of its own.
 * - **order** — four copies of the yeast cooler, rows of the Contact maps card
 *   dragged up and down it (a real HTML5 drag, shot while it is carried) and
 *   moved by the arrow keys: the grid must follow the card.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-deck-maps.mjs [out-dir]
 *
 * `GALLERY_ONLY=drop`, `maps` or `order` runs one part alone.
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
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
const ONLY = process.env.GALLERY_ONLY ?? ''
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
let page = null
const fresh = async () => {
  const next = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return }
  }
}

/** Every cell in reading order: its name, what its key says, and any line under its heading. */
const cells = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.deck-grid > .deck-panel')).map((cell) => {
      const name = cell.querySelector('.deck-name')
      const text = (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim()
      const said = [...cell.querySelectorAll('.deck-note:not(.hidden), .ann-drop-hint')]
        .map((node) => (node.textContent ?? '').trim())
        .filter((line) => line !== '')
      const key = cell.textContent?.includes('arm O/E') ? 'arm O/E' : cell.textContent?.includes('O/E') ? 'O/E' : 'counts'
      return `${cell.classList.contains('is-lead') ? '*' : ''}${text} · ${key}${said.length === 0 ? '' : ` · «${said[0].slice(0, 70)}»`}`
    }),
  )

/** Files fetched from the dev server and dropped on the landing page, as a reader drops them. */
const dropOnLanding = async (files) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120000 })
  await page.waitForSelector('.dropzone')
  await page.evaluate(async (files) => {
    const blobs = new Map()
    const transfer = new DataTransfer()
    for (const { url, name } of files) {
      if (!blobs.has(url)) blobs.set(url, await (await fetch(url)).blob())
      transfer.items.add(new File([blobs.get(url)], name))
    }
    const zone = document.querySelector('.dropzone')
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      zone?.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  }, files)
}

const goTo = async (locus, maps) => {
  const box = page.locator('input[placeholder*="for the whole genome"], input[placeholder*="a sequence"]').first()
  await box.click()
  await box.fill(locus)
  await box.press('Enter')
  await page.waitForFunction((n) => document.querySelectorAll('.heatmap-canvas').length >= n, maps, { timeout: 180000 }).catch(() => console.log('the maps never drew'))
  await sleep(6000)
}

// ---------------------------------------------------------------------------
// The Analysis drawer
// ---------------------------------------------------------------------------

const drawer = () =>
  page.evaluate(() => {
    const body = document.querySelector('.analysis-drawer')
    return {
      tabs: [...(body?.querySelectorAll('.analysis-maps .analysis-map') ?? [])].map((b) => (b.textContent ?? '').trim()),
      figures: [...(body?.querySelectorAll('.analysis-figure-title') ?? [])].map((n) => (n.textContent ?? '').trim()),
      tables: [...(body?.querySelectorAll('table') ?? [])].map((table) =>
        [...table.querySelectorAll('tr')].slice(0, 8).map((tr) => [...tr.children].map((c) => (c.textContent ?? '').trim()).join(' | ')).join('\n'),
      ),
      elsewhere: [...(body?.querySelectorAll('.analysis-elsewhere') ?? [])].map((n) => n.textContent),
    }
  })
const runOnAll = async (title) => {
  await page.keyboard.press('Escape')
  await sleep(600)
  await page.waitForFunction((t) => {
    const hit = [...document.querySelectorAll('.analysis-row')].find((row) => (row.textContent ?? '').includes(t))
    return hit !== undefined && hit.getAttribute('aria-disabled') !== 'true'
  }, title, { timeout: 90000 }).catch(() => console.log('never offered:', title))
  await page.locator('.analysis-row-title', { hasText: title }).first().click()
  await sleep(1500)
  const button = page.locator('.analysis-drawer button', { hasText: /^run on all/ }).first()
  console.log(title, '—', await button.textContent())
  await button.click()
  await page.waitForFunction(() => [...document.querySelectorAll('.analysis-map')].some((b) => /all maps/.test(b.textContent ?? '')), null, { timeout: 300000 }).catch(() => console.log('no all-maps tab'))
  await sleep(5000)
  await page.locator('.analysis-map', { hasText: 'all maps' }).first().click()
  await sleep(2500)
}
const scrollTo = async (pattern) => {
  await page.evaluate((source) => {
    const wanted = new RegExp(source)
    ;[...document.querySelectorAll('.analysis-figure-title, .analysis-maps')].find((node) => wanted.test(node.textContent ?? ''))?.scrollIntoView({ block: 'start' })
  }, pattern)
  await sleep(800)
}

// ---------------------------------------------------------------------------
// The Map card in the Aesthetics column
// ---------------------------------------------------------------------------

/**
 * The picture row's words — O/E, `arms`, `ori` — of the *Map* card on screen,
 * which is the Aesthetics column's: the first map's, or the starred companion's.
 */
const mapCard = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.btn-word')]
      .filter((b) => b instanceof HTMLElement && b.closest('.analysis-drawer') === null && b.offsetParent !== null)
      .map((b) => `${b.textContent?.trim()}${b.getAttribute('aria-pressed') === 'true' || b.classList.contains('is-on') ? ' (on)' : ''}`)
      .join(', '),
  )
const pressOnMapCard = async (word) => {
  await page.evaluate((word) => {
    ;[...document.querySelectorAll('.btn-word')]
      .filter((b) => b instanceof HTMLElement && b.closest('.analysis-drawer') === null && b.offsetParent !== null)
      .find((b) => b.textContent?.trim() === word)
      ?.click()
  }, word)
  await sleep(6000)
}

// ---------------------------------------------------------------------------
// The Contact maps card
// ---------------------------------------------------------------------------

const cardRows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.compare-card .compare-row')].map((row) => {
      const name = row.querySelector('.ann-name')
      return (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim()
    }),
  )
const tagRow = (name, tag) =>
  page.evaluate(({ name, tag }) => {
    for (const row of document.querySelectorAll('.compare-card .compare-row')) {
      const box = row.querySelector('.ann-name')
      if ((box instanceof HTMLInputElement ? box.value : (box?.textContent ?? '')).trim() === name) row.setAttribute('data-gallery', tag)
    }
  }, { name, tag })
const untag = () => page.evaluate(() => document.querySelectorAll('[data-gallery]').forEach((node) => node.removeAttribute('data-gallery')))

try {
  // -------------------------------------------------------------------------
  // Eight maps, a GTF and a FASTA dropped at once.
  // -------------------------------------------------------------------------
  if (ONLY === '' || ONLY === 'drop') {
    page = await fresh()
    await dropOnLanding([
      ...['WT', 'dparAB', '0min', '15min', '20min', '30min', '45min', '60min'].map((name) => ({ url: '/demo/yeast/Yeast_microC_G2M_1kb.cool', name: `${name}.cool` })),
      { url: '/demo/yeast/Yeast_annotations.gtf', name: 'Yeast_annotations.gtf' },
      { url: '/demo/yeast/S288c_syn40-XIII.fa', name: 'S288c_syn40-XIII.fa' },
    ])
    await sleep(8000)
    await goTo('IV:1,000,000-1,400,000', 8)
    const opened = await cells()
    console.log('eight maps dropped:', JSON.stringify(opened))
    console.log('empty cells:', opened.filter((cell) => /could not be re-opened/.test(cell)).length)
    await shot('dm01-drop-eight-maps')
  }

  // -------------------------------------------------------------------------
  // Three maps of one circle: named, run on together, framed on its origin.
  // -------------------------------------------------------------------------
  if (ONLY === '' || ONLY === 'maps') {
    page = await fresh()
    const names = ['WT', 'dparAB', '20min']
    await dropOnLanding(names.map((name) => ({ url: '/demo/ecoli/Ecoli.mcool', name: `Ecoli_${name}.mcool` })))
    await page.waitForSelector('input.tedit', { timeout: 180000 }).catch(() => console.log('no Chromosomes table'))
    await sleep(3000)
    const origin = page.locator('input.tedit').first()
    await origin.click()
    await origin.fill('3,925,744')
    await origin.press('Enter')
    await sleep(800)
    await page.getByText('10 kb', { exact: true }).first().click().catch(() => console.log('no 10 kb rung'))
    await sleep(4000)
    await goTo('NC_000913.3', 3)
    for (const [at, name] of names.entries()) {
      const box = page.locator('.deck-grid > .deck-panel .deck-name').nth(at)
      if ((await box.evaluate((node) => node.tagName)) !== 'INPUT') continue
      await box.click()
      await box.fill(name)
      await box.press('Enter')
      await sleep(400)
    }
    console.log('renamed:', JSON.stringify(await cells()))
    await fold('Fold the General panel')
    await fold('Show the Analysis panel')
    await sleep(800)

    await runOnAll('Inter-arm alignment')
    console.log('inter-arm, all maps:', JSON.stringify(await drawer(), null, 1))
    await scrollTo('^Inter-arm alignment by distance')
    await shot('dm02-interarm-all-maps')
    await scrollTo('per sequence — all maps')
    await shot('dm03-interarm-all-maps-table')

    await runOnAll('Reproducibility')
    console.log('reproducibility, all maps:', JSON.stringify(await drawer(), null, 1))
    await scrollTo('^Pooled over every sequence')
    await shot('dm04-hicrep-all-maps')

    await page.keyboard.press('Escape')
    await sleep(800)
    await fold('Show the Aesthetics panel')
    // No map starred: the first map's card sets every map.
    await page.locator('.deck-panel.is-lead .deck-star').first().click()
    await sleep(1500)
    await pressOnMapCard('O/E')
    await pressOnMapCard('arms')
    console.log('O/E and arms, nothing starred:', JSON.stringify(await cells()), '· card:', await mapCard())
    await shot('dm05-arms-every-map')
    await pressOnMapCard('ori')
    console.log('ori:', await page.evaluate(() => decodeURIComponent(location.hash).match(/region=[^&]*/)?.[0]))
    console.log('framed on the origin:', JSON.stringify(await cells()))
    await shot('dm06-ori-every-map')
    await page.locator('.deck-grid > .deck-panel').nth(1).locator('.deck-star').first().click()
    await sleep(2500)
    console.log('dparAB starred, its card:', await mapCard())
    await pressOnMapCard('arms')
    console.log('arms off on dparAB alone:', JSON.stringify(await cells()))
    await shot('dm07-companion-card-arms')
  }

  // -------------------------------------------------------------------------
  // Four maps, reordered from the Contact maps card.
  // -------------------------------------------------------------------------
  if (ONLY === '' || ONLY === 'order') {
    page = await fresh()
    await dropOnLanding(['WT', '0min', '15min', '20min'].map((name) => ({ url: '/demo/yeast/Yeast_microC_G2M_1kb.cool', name: `${name}.cool` })))
    await sleep(8000)
    await goTo('IV:1,000,000-1,400,000', 4)
    await fold('Fold the General panel')
    await fold('Show the Annotations panel')
    await sleep(1000)
    console.log('start · grid:', JSON.stringify(await cells()), '· card:', JSON.stringify(await cardRows()))

    // Carried, and shot while it is: the line the row will land on.
    await tagRow('20min.cool', 'from')
    await tagRow('WT.cool', 'onto')
    const grip = await page.locator('[data-gallery="from"] .compare-grip').boundingBox()
    const onto = await page.locator('[data-gallery="onto"]').boundingBox()
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(onto.x + 60, onto.y + onto.height / 2, { steps: 8 })
    await page.mouse.move(onto.x + 60, onto.y + 10, { steps: 4 })
    await sleep(600)
    console.log(
      'carried over WT.cool:',
      await page.evaluate(() =>
        [...document.querySelectorAll('.compare-card .compare-row')].map((row) =>
          `${(row.querySelector('.ann-name')?.value ?? row.querySelector('.ann-name')?.textContent ?? '').trim()}${row.classList.contains('is-dragging') ? ' (carried)' : ''}${row.classList.contains('drop-before') ? ' (lands above)' : ''}${row.classList.contains('drop-after') ? ' (lands below)' : ''}`,
        ),
      ),
    )
    await shot('dm08-card-row-carried')
    const card = await page.locator('.compare-card').first().boundingBox()
    if (card !== null) {
      await page.screenshot({ path: `${OUT}/dm08b-card-row-carried-close.png`, clip: { x: card.x - 4, y: card.y - 4, width: card.width + 8, height: Math.min(card.height, 260) + 8 } })
      console.log('shot dm08b-card-row-carried-close')
    }
    await page.mouse.up()
    await untag()
    await sleep(3000)
    console.log('20min above WT · grid:', JSON.stringify(await cells()), '· card:', JSON.stringify(await cardRows()))
    await shot('dm09-card-row-moved')

    await tagRow('WT.cool', 'from')
    await tagRow('15min.cool', 'onto')
    const target = page.locator('[data-gallery="onto"]')
    const box = await target.boundingBox()
    await page.locator('[data-gallery="from"] .compare-grip').dragTo(target, { targetPosition: { x: 60, y: box.height - 4 } })
    await untag()
    await sleep(3000)
    console.log('WT below 15min · grid:', JSON.stringify(await cells()), '· card:', JSON.stringify(await cardRows()))

    await tagRow('0min.cool', 'key')
    await page.locator('[data-gallery="key"] .compare-grip').focus()
    await page.keyboard.press('ArrowUp')
    await untag()
    await sleep(3000)
    console.log('0min up by the keyboard · grid:', JSON.stringify(await cells()), '· card:', JSON.stringify(await cardRows()))
    await shot('dm10-card-first-map-moved')
  }
} finally {
  console.log(errors.length === 0 ? 'no page errors' : `page errors: ${errors.slice(0, 10).join(' | ')}`)
  await browser.close()
}
