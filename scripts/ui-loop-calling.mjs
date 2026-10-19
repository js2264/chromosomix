/**
 * Loop calling (§18.8) in headless Chromium, on the yeast micro-C demo.
 *
 * The 2D card with *Loop calling* just above *Pattern detection*; the filter
 * box finding both under `loop`; the form on the demo's own 1 kb, which has no
 * kernel of its own — the two half-widths empty and the run refused beside
 * **Run**, saying why — then the half-widths typed, the price line, a run and
 * its drawer: the notes, the loops as a table, the loop spectrum and the
 * contacts each λ-chunk asked of a pixel; then the loops on the map as rings on
 * chromosome IV, and close up. Last, a 5 kb rung added with the `+` beside the
 * resolution: after the run, the typed kernel kept and the scan's reach and the
 * clustering radius following the rung; then on a fresh session, the form
 * arriving with the kernel for 5 kb bins already in its boxes. Prints the
 * form's fields, the price and refusal lines and each run's notes, so a box
 * that showed `NaN` or a run that said something unexpected is a line in the
 * log as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-loop-calling.mjs [out-dir]
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page, shot, close, base } = await gallery(OUT, { width: 1600, height: 1000 })

const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}
const shotOf = async (selector, name) => {
  await page.locator(selector).first().screenshot({ path: `${OUT}/${name}.png` })
  console.log(`wrote ${name}.png`)
}
const figureTitles = () =>
  page.$$eval('.analysis-figure-head', (all) => all.map((one) => one.textContent.trim()).join(' | '))
const notes = () => page.$$eval('.analysis-drawer .analysis-notes li', (all) => all.map((n) => n.textContent.trim()))
const fields = () =>
  page.$$eval('.analysis-form .field', (all) => all.map((f) => f.textContent.trim().replace(/\s+/g, ' ').slice(0, 140)))
const boxes = () =>
  page.$$eval('.analysis-form .field', (all) =>
    all
      .filter((field) => field.querySelector('input[type=number]') !== null)
      .map((field) => `${field.textContent.trim().split(/bins|$/)[0].trim()} = “${field.querySelector('input[type=number]').value}”`),
  )
const priceLine = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.analysis-drawer .analysis-cost, .analysis-drawer .analysis-refusal')]
      .map((n) => `${n.className}: ${n.textContent.trim().replace(/\s+/g, ' ')}`)
      .filter(Boolean),
  )
const openTask = async (title) => {
  await page.keyboard.press('Escape')
  await sleep(600)
  await page.locator('.analysis-row-title', { hasText: new RegExp(`^${title}$`) }).first().click()
  await sleep(1200)
}
const setNumber = async (label, value) => {
  const field = page.locator('.analysis-form .field', { hasText: label })
  const box = field.locator('input[type=number]').first()
  await box.fill(String(value))
  await box.press('Enter')
  await sleep(700)
}
const run = async () => {
  const before = await figureTitles()
  await page.locator('.analysis-drawer button', { hasText: /^run(\s+on)?\s*$/i }).first().click()
  await page
    .waitForFunction(
      (prior) => {
        const now = [...document.querySelectorAll('.analysis-figure-head')].map((one) => one.textContent.trim()).join(' | ')
        return now !== prior && now.includes('Contacts needed')
      },
      before,
      { timeout: 300000 },
    )
    .catch(() => console.log('no output within five minutes'))
  await sleep(2500)
}

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(3000)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.analysis-row-title')].some(
        (node) => node.textContent.trim() === 'Loop calling' && node.offsetParent !== null,
      ),
    null,
    { timeout: 60000 },
  )
  await sleep(800)

  // ---- the row, before Pattern detection ------------------------------------
  const rowTitles = await page.$$eval('.analysis-row-title', (all) => all.map((n) => n.textContent.trim()))
  const at = rowTitles.indexOf('Loop calling')
  console.log('2D rows around it:', JSON.stringify(rowTitles.slice(Math.max(0, at - 2), at + 3)))
  await page.locator('.analysis-row-title', { hasText: /^Loop calling$/ }).first().scrollIntoViewIfNeeded()
  await sleep(500)
  await shot('lo01-analysis-column')
  await page.locator('input.analysis-filter').fill('loop')
  await sleep(700)
  console.log(
    'filtered by “loop”:',
    JSON.stringify(
      await page.$$eval('.analysis-row:not(.hidden) .analysis-row-title', (all) =>
        all.filter((n) => n.offsetParent !== null).map((n) => n.textContent.trim()),
      ),
    ),
  )
  await shot('lo02-filter-loop')
  await page.locator('input.analysis-filter').fill('')
  await sleep(500)

  // ---- the form at 1 kb: no kernel of its own ---------------------------------
  await openTask('Loop calling')
  console.log('form fields:', JSON.stringify(await fields()))
  console.log('boxes at 1 kb:', JSON.stringify(await boxes()))
  console.log('price at 1 kb:', JSON.stringify(await priceLine()))
  await shot('lo03-form-1kb-refused')
  await shotOf('.analysis-form', 'lo04-form-1kb-alone')

  // ---- the half-widths typed, and a run --------------------------------------
  await setNumber('outer half-width', 5)
  await setNumber('inner half-width', 2)
  console.log('boxes typed:', JSON.stringify(await boxes()))
  console.log('price typed:', JSON.stringify(await priceLine()))
  await shot('lo05-form-1kb-typed')
  await run()
  console.log('figures:', await figureTitles())
  console.log('notes:', JSON.stringify(await notes()))
  await shot('lo06-ran')
  const drawer = page.locator('.analysis-drawer').first()
  for (let i = 0; i < 4; i++) {
    await drawer.evaluate((node, i) => {
      const scroller = node.querySelector('.analysis-drawer-body') ?? node
      scroller.scrollTo({ top: (scroller.scrollHeight / 4) * i })
    }, i)
    await sleep(800)
    await shotOf('.analysis-drawer', `lo${String(7 + i).padStart(2, '0')}-drawer-${i + 1}`)
  }

  // ---- the loops on the map ---------------------------------------------------
  await page.keyboard.press('Escape')
  await sleep(1500)
  await shot('lo11-loops-on-the-map')
  const region = page.locator('.input-region').first()
  await region.fill('IV:1,030,000-1,140,000')
  await region.press('Enter')
  await sleep(3500)
  await shot('lo12-loops-close-up')

  // ---- a 5 kb rung after the run: the typed kernel kept, the rest following ---
  const addRung = async (kb) => {
    await page.locator('[aria-label="Add a resolution"]').first().click()
    await sleep(600)
    await page.locator('.res-ask').fill(String(kb))
    await page.locator('.res-unit-radio[value="kb"]').check()
    await sleep(300)
    await page.locator('button.btn-primary', { hasText: /^add$/ }).first().click()
    await sleep(1500)
    // The ladder lands on a rung it has just been given; its chip is clicked
    // only where it did not.
    const wanted = `coarsen=${kb * 1000}`
    const chip = page.locator('button', { hasText: new RegExp(`^${kb} kb\\*`) }).first()
    if (!(await page.evaluate((w) => location.hash.includes(w), wanted)) && (await chip.isVisible().catch(() => false))) {
      await chip.click()
    }
    await page.waitForFunction((w) => location.hash.includes(w), wanted, { timeout: 30000 })
    await sleep(3500)
  }
  await addRung(5)
  await openTask('Loop calling')
  console.log('boxes at 5 kb, after the 1 kb run:', JSON.stringify(await boxes()))
  console.log('price at 5 kb, after the 1 kb run:', JSON.stringify(await priceLine()))
  await shotOf('.analysis-form', 'lo13-form-5kb-after-the-run')

  // ---- the same rung on a fresh session: the kernel for 5 kb bins, seeded ----
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.goto('about:blank')
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(3000)
  await addRung(5)
  console.log('hash on the fresh session:', await page.evaluate(() => decodeURIComponent(location.hash)))
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(800)
  await openTask('Loop calling')
  console.log('boxes at 5 kb, fresh:', JSON.stringify(await boxes()))
  console.log('price at 5 kb, fresh:', JSON.stringify(await priceLine()))
  await shot('lo14-form-5kb-seeded')
  await shotOf('.analysis-form', 'lo15-form-5kb-seeded-alone')
} finally {
  await close()
}
