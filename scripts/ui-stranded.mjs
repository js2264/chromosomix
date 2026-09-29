/**
 * Drive P(s)'s four orientations end to end in headless Chromium (§18.8).
 *
 * On the lab's toy *Lachancea kluyveri* library, which sits at the root of the
 * bucket as both a contact list and the map binned from it. Two roads, which
 * are the two a reader takes:
 *
 * - **binned** — the `.pairs` opened and binned on the fly (§3.7). The form asks
 *   for no file at all once *four orientations* is on, the price line says the
 *   four were counted as the file was binned, and the run draws them — through
 *   a plain Run, which used to be refused with *choose a bin size*.
 * - **matrix** — the `.mcool` of the same library. The form asks for the
 *   `.pairs` with a drop area that is also a button: shot empty, lit under a
 *   drag, holding the dropped file, and then the run's figure; and last, the
 *   address box with the bucket's URL typed into it, priced as its pass.
 *
 * Every step prints what the form and the price line said, and each run's
 * notes, so a field that should not be there — or a figure that did not come —
 * is a line here too. The figure itself is shot scrolled to its head: the four
 * curves unbroken, with no notch where they used to fall by half together.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-stranded.mjs [out-dir]
 *
 * The files are read from `GALLERY_DATA` — the bucket's root by default; where
 * the browser cannot reach it, serve a folder holding the two files under their
 * bucket names and name its address there. `GALLERY_ONLY=binned` or `matrix`
 * runs one part. The contact list is 330 MB and is read twice on the binned
 * road — once to draw the map and once by the analysis worker's own mount — so
 * the whole gallery takes a few minutes.
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
const DATA = (process.env.GALLERY_DATA ?? 'https://rsglab-data.s3.eu-west-3.amazonaws.com/').replace(/\/?$/, '/')
const STEM = process.env.GALLERY_STEM ?? 'CG002^mapped_Lachancea_kluyveri^DIHE85'
const PAIRS = `${STEM}.valid_idx_pcrfree.pairs.gz`
const MCOOL = `${STEM}.mcool`
/** The longest chromosome of the library, where P(s) reaches furthest. */
const SEQUENCE = process.env.GALLERY_SEQUENCE ?? 'CM000694.1'
const address = (name) => `${DATA}${encodeURIComponent(name)}`

mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  // A toast about the library's empty scaffolds is the app's, not the form's,
  // and it sits over the price line.
  for (const close of await page.$$('.toast-close')) await close.click().catch(() => {})
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
const drawer = () => page.locator('.analysis-drawer').first()

/** What the *From the .pairs file* card and the price line say now. */
const said = async (step) => {
  const state = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.param-group')].find((group) =>
      group.textContent?.includes('From the .pairs file'),
    )
    const zone = document.querySelector('.param-drop')
    return {
      card: card?.innerText.split('\n').filter((line) => line.trim() !== '') ?? null,
      dropArea: zone === null ? null : { text: zone.textContent, held: zone.classList.contains('is-held'), lit: zone.classList.contains('over') },
      address: document.querySelector('.param-address')?.value ?? null,
      price: document.querySelector('.analysis-drawer .run-note, .analysis-drawer .analysis-estimate')?.textContent ?? null,
    }
  })
  console.log(`--- ${step}\n${JSON.stringify(state, null, 1)}`)
}

/** Every note the drawer printed under the run. */
const notes = async (step) => {
  const text = await page.evaluate(
    () => [...document.querySelectorAll('.analysis-drawer .analysis-notes li, .analysis-drawer .analysis-note')].map((n) => n.textContent),
  )
  console.log(`--- notes, ${step}\n${text.map((line) => `  · ${line}`).join('\n') || '  (none)'}`)
}

/** Open a map (or a `.pairs`, answering the dialog) and stand on the longest chromosome. */
const open = async (url, { pairs }) => {
  await page.goto(`${BASE}/#uri=${url}`)
  if (pairs) {
    await page.waitForSelector('.pairs-base', { timeout: 180000 })
    await sleep(600)
    // The dialog's own suggestion, and no `.mcool` to download.
    await page.locator('.pairs-download input').uncheck()
    await page.locator('button', { hasText: 'build the map' }).click()
  }
  const started = Date.now()
  await page.waitForFunction(
    () =>
      !document.body.textContent.includes('Opening ') &&
      (document.querySelector('.heatmap-canvas') !== null ||
        document.querySelector('.breadcrumb')?.textContent.includes('Chromosomes')),
    null,
    { timeout: 900000 },
  )
  console.log(`opened ${decodeURIComponent(url.split('/').pop())} in ${Math.round((Date.now() - started) / 1000)} s`)
  await sleep(1500)
  for (const b of await page.$$('button')) {
    if ((await b.innerText()).trim() === 'dismiss' && (await b.isVisible())) await b.click()
  }
  const box = page.locator('input[placeholder*="a sequence"]').first()
  await box.fill(SEQUENCE)
  await box.press('Enter')
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(2500)
}

/** The P(s) drawer, with *four orientations* on. */
const stranded = async () => {
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(800)
  await page.locator('text=Contact probability P(s)').first().click()
  await sleep(1200)
  const toggle = page.locator('.param-field', { hasText: 'four orientations' }).locator('button').first()
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await sleep(800)
  // The card the question lives in, at the top of the drawer.
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.param-group')].find((group) =>
      group.textContent?.includes('From the .pairs file'),
    )
    card?.scrollIntoView({ block: 'center' })
  })
  await sleep(500)
}

/** Press Run and wait for the orientation figure, or for a note saying why not. */
const run = async (step) => {
  const started = Date.now()
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page
    .waitForFunction(
      () => {
        const text = document.querySelector('.analysis-drawer')?.textContent ?? ''
        return (
          text.includes('P(s) by pair orientation') ||
          /choose a bin size|none to count|no longer in hand|Could not open/i.test(text)
        )
      },
      null,
      { timeout: 900000 },
    )
    .catch(() => console.log('no orientation figure and no note'))
  console.log(`${step}: ran in ${Math.round((Date.now() - started) / 1000)} s`)
  await sleep(2500)
  await notes(step)
}

/** The orientation figure, its head at the top of the drawer. */
const toFigure = async () => {
  await page.evaluate(() => {
    const block = [...document.querySelectorAll('.figure-block')].find((node) =>
      node.textContent?.includes('by pair orientation'),
    )
    block?.scrollIntoView({ block: 'start' })
  })
  await sleep(1200)
}

/** A file fetched in the page, dragged over the drop area and — unless `hold` — let go. */
const drag = async (url, name, { hold = false } = {}) => {
  await page.evaluate(
    async ({ url, name, hold }) => {
      const blob = await (await fetch(url)).blob()
      const file = new File([blob], name)
      const zone = document.querySelector('.param-drop')
      const transfer = new DataTransfer()
      transfer.items.add(file)
      for (const type of hold ? ['dragenter', 'dragover'] : ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
    },
    { url, name, hold },
  )
  await sleep(800)
}

try {
  if (ONLY === '' || ONLY === 'binned') {
    // ---- the .pairs, binned on the fly -----------------------------------
    await open(address(PAIRS), { pairs: true })
    await shot('st01-binned-map')
    await stranded()
    await said('binned: four orientations on')
    await shot('st02-binned-form')
    await run('binned')
    await shot('st03-binned-ran')
    await toFigure()
    await shot('st04-binned-figure')
  }

  if (ONLY === '' || ONLY === 'matrix') {
    // ---- the .mcool, and the .pairs handed to the form -----------------------
    await open(address(MCOOL), { pairs: false })
    await stranded()
    await said('matrix: four orientations on')
    await shot('st05-matrix-form')
    await drag(address(PAIRS), PAIRS, { hold: true })
    await said('matrix: a .pairs over the drop area')
    await drawer().locator('.param-drop').screenshot({ path: `${OUT}/st06-drop-lit.png` })
    console.log('shot st06-drop-lit')
    await drag(address(PAIRS), PAIRS)
    await said('matrix: the .pairs dropped')
    await shot('st07-matrix-dropped')
    await run('matrix, dropped')
    await toFigure()
    await shot('st08-matrix-figure')

    // The address road: typed over the dropped file, which it replaces.
    await drawer().locator('.param-address').evaluate((node) => node.scrollIntoView({ block: 'center' }))
    await drawer().locator('.param-address').fill(address(PAIRS))
    await drawer().locator('.param-address').press('Enter')
    await sleep(800)
    await said('matrix: the address typed')
    await shot('st09-matrix-address')
  }
} catch (error) {
  console.log('ERROR', error)
  await shot('st-error')
}
console.log('page errors:', errors.length === 0 ? 'none' : errors.slice(0, 8))
await browser.close()
