/**
 * The two methods of *Model from the map*, side by side (§25.6).
 *
 * `ui-gallery.mjs` runs the reconstruction once, with whatever the form
 * defaults to, and its screenshot stops where the drawer's table runs past the
 * window. What a reviewer of the **Method** control wants is the part that
 * differs: the form under each method — the weighting control is ShRec3D's
 * question and is not asked under a likelihood — and the whole of each fit
 * table, scrolled to, including the row that says what the negative binomial
 * found that a Poisson could not.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-methods.mjs [out-dir]
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
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: 1 })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
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

/** The fit table's rows, as the reader sees them. */
const fitRows = () =>
  page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find((t) => /Method/.test(t.textContent ?? ''))
    if (table == null) return []
    return [...table.querySelectorAll('tr')]
      .map((tr) => [...tr.querySelectorAll('td, th')].map((c) => (c.textContent ?? '').trim()).join(' · '))
      .filter((line) => line !== '')
  })

/** Press Run and wait for the table to carry this method's name. */
const runAnd = async (name) => {
  await page.locator('button', { hasText: /^run$/i }).first().click()
  await page.waitForFunction(
    (want) => new RegExp(want).test(document.body.textContent ?? ''),
    name,
    { timeout: 120000 },
  )
  await sleep(1500)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(2500)
  await fold('Show the Annotations panel')
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await sleep(800)
  await page.locator('text=Model from the map').first().click()
  await sleep(900)

  // The control itself, and what it offers.
  const methods = await page.evaluate(() => {
    const select = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => /pastis-NB/.test(o.textContent ?? '')),
    )
    return select === undefined ? [] : [...select.options].map((o) => o.textContent?.trim())
  })
  console.log('methods offered:', methods.join(' | '))

  await shot('m1-method-nb-form')
  await runAnd('negative binomial')
  console.log('\n--- pastis-NB ---')
  for (const line of await fitRows()) console.log(' ', line)
  // The table runs past the window, so it is scrolled to rather than hoped for.
  await page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find((t) => /Overdispersion/.test(t.textContent ?? ''))
    table?.scrollIntoView({ block: 'center' })
  })
  await sleep(700)
  await shot('m2-method-nb-table')

  // …and the other method, on the same block, from the same form.
  await page.evaluate(() => {
    const select = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => /ShRec3D/.test(o.textContent ?? '')),
    )
    if (select === undefined) throw new Error('no method control')
    select.value = [...select.options].find((o) => /ShRec3D/.test(o.textContent ?? '')).value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(900)
  // Case-insensitive: §26.4 spells field labels lowercase, and a probe that
  // hard-codes the capital reports a control missing when it was only renamed.
  const weighting = await page.evaluate(() => /weight pairs by/i.test(document.body.textContent ?? ''))
  console.log('weighting control shown under ShRec3D:', weighting)
  await shot('m3-method-shrec3d-form')
  await runAnd('ShRec3D')
  console.log('\n--- ShRec3D ---')
  for (const line of await fitRows()) console.log(' ', line)
  await page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find((t) => /Weighted stress/.test(t.textContent ?? ''))
    table?.scrollIntoView({ block: 'center' })
  })
  await sleep(700)
  await shot('m4-method-shrec3d-table')
} catch (e) {
  console.log('FAILED', e)
  await shot('m9-failure')
} finally {
  console.log('page errors:', errors.length === 0 ? 'none' : errors.join('\n'))
  await browser.close()
}
