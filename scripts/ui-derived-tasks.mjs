/**
 * Every task at a resolution the reader added (§3.4, §18.4), end to end.
 *
 * On the yeast demo, a 1 kb cooler: 3 kb added with the `+` beside the
 * resolution and stood on, then Diamond insulation run — the drawer's framing
 * line reading `3 kb* bins`, the track beside the map one value per 3 kb bin,
 * and the console's command carrying `--coarsen 3000` — then Contact
 * probability P(s), its first separation one summed bin. Back on the file's own
 * 1 kb, the insulation result is of another resolution and the drawer says it
 * is out of date. Each step prints what the page says.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-derived-tasks.mjs [out-dir]
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
const framing = () => page.evaluate(() => document.querySelector('.analysis-framing')?.textContent?.trim() ?? null)
const run = async (title) => {
  await page.locator('.analysis-row-title', { hasText: new RegExp(`^${title.replace(/[()]/g, '\\$&')}$`) }).first().click()
  await sleep(1200)
  await page.locator('button', { hasText: /^run$/i }).first().click()
  // Done when the task's own row says so, in the Analysis column.
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('.analysis-row-title')].some(
        (node) => node.textContent === name && /done in/.test(node.closest('button, li, .analysis-row')?.textContent ?? ''),
      ),
    title,
    { timeout: 300000 },
  )
  await sleep(3000)
}

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(2500)

  // 3 kb, added with the `+` and stood on.
  await page.locator('[aria-label="Add a resolution"]').first().click()
  await sleep(600)
  await page.locator('.res-ask').fill('3')
  await page.locator('.res-unit-radio[value="kb"]').check()
  await sleep(300)
  await page.locator('button.btn-primary', { hasText: /^add$/ }).first().click()
  await sleep(1500)
  const chip = page.locator('button', { hasText: /^3 kb\*/ }).first()
  if (await chip.isVisible().catch(() => false)) await chip.click()
  await page.waitForFunction(() => location.hash.includes('coarsen=3000'), null, { timeout: 30000 })
  await sleep(4000)
  console.log('hash:', await page.evaluate(() => decodeURIComponent(location.hash)))

  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Analysis panel')
  await run('Diamond insulation')
  console.log('insulation framing:', await framing())
  await shot('dt01-insulation-drawer')
  await page.keyboard.press('Escape')
  await sleep(2500)
  const lane = await page.evaluate(() =>
    [...document.querySelectorAll('.ann-name, .track-name')]
      .map((n) => (n instanceof HTMLInputElement ? n.value : n.textContent))
      .filter((name) => /insulation/i.test(name ?? '')),
  )
  console.log('insulation lanes:', JSON.stringify(lane))
  await shot('dt02-insulation-lane')

  // The command the console wrote for it.
  await page.locator('button[aria-label="console"]').first().click()
  await sleep(1500)
  const command = await page.evaluate(
    () => [...document.querySelectorAll('.console-list *')].map((n) => n.textContent ?? '').find((t) => t.includes('chromosomix insulation')) ?? null,
  )
  console.log('console command:', command?.replace(/\s+/g, ' ').slice(0, 240) ?? null)
  await shot('dt03-console-command')
  await page.locator('button[aria-label="console"]').first().click()
  await sleep(800)

  await run('Contact probability P(s)')
  console.log('P(s) framing:', await framing())
  // The curve, under the form: its first separation is one summed bin.
  await page
    .locator('button', { hasText: /^TSV$/ })
    .first()
    .evaluate((button) => button.parentElement?.parentElement?.scrollIntoView({ block: 'start' }))
  await sleep(1200)
  await shot('dt04-ps-drawer')
  await page.keyboard.press('Escape')
  await sleep(1500)

  // Back on the file's own 1 kb: the insulation run is of another resolution.
  await page.evaluate(() => {
    const hash = new URLSearchParams(location.hash.slice(1))
    hash.delete('coarsen')
    location.hash = hash.toString()
  })
  await sleep(5000)
  await page.locator('.analysis-row-title', { hasText: /^Diamond insulation$/ }).first().click()
  await sleep(1500)
  console.log('at 1 kb, framing:', await framing())
  console.log(
    'at 1 kb, the drawer says:',
    await page.evaluate(() => {
      const text = document.querySelector('.analysis-drawer')?.textContent ?? ''
      const at = text.search(/out of date|stale|different|another framing|no longer/i)
      return at < 0 ? null : text.slice(Math.max(0, at - 60), at + 120)
    }),
  )
  await shot('dt05-own-rung-stale')
} finally {
  await close()
}
