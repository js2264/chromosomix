/**
 * The pictures of Getting started → Your first map (`start/first-map.md`),
 * taken along the page's own steps, on 4DN's in situ Hi-C of K562
 * (4DNESC23ZYOF), read from 4DN's open-data bucket:
 *
 * - **landing** the landing page, the pointer on *4DN open data* under
 *   *Connect to a data store* (served the published site's keys, so the folder
 *   row shows the four buttons chromosomix.app shows: `publishedKeys`);
 * - **chromosomes** the set opened from the store with its tracks, on the
 *   map's Chromosomes table, the General panel beside it;
 * - **chr15-5kb** 250 kb, chr15, then chr15:30,000,001-60,000,000, 5 kb and
 *   chr15:38,100,001-50,025,000: the domains at 5 kb with 4DN's tracks under
 *   the map;
 * - **insulation** ENCODE's CTCF ChIP-seq of K562 added by its address, then
 *   Diamond insulation run on chr15 alone with its defaults and its drawer
 *   closed: the score and the boundaries left of the map, the domains on the
 *   diagonal, the Analysis panel open with the row saying *done*
 *   (`insulation-analysis-folded`: the same with that panel folded).
 *
 * Network: the stores are read from the deployed site and the data from 4DN's
 * and ENCODE's buckets, so `HTTPS_PROXY` is handed to Chromium (see the lib).
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/start-first-map.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/start-first-map'
const SET = '4DNESC23ZYOF'
const CTCF = 'https://encode-public.s3.amazonaws.com/2020/09/26/85161a5a-d6b5-49d2-bc0a-db0b217ff0d5/ENCFF979PWH.bigWig'

;(async () => {
  const browser = await launch()
  const w = await newWindow(browser, OUT, { published: true })
  const { page } = w
  const go = async (locus) => {
    const box = page.locator('.search-box-go input.search-input').first()
    await box.click()
    await box.fill(locus)
    await box.press('Enter')
    await sleep(2500)
    await w.quiet(120000)
    await sleep(1500)
  }
  const drawn = async () => {
    await page.waitForSelector('.heatmap-canvas', { timeout: 180000 })
    await w.quiet(180000)
    await w.tracksRead(1)
    await sleep(2500)
  }

  // The landing page, the hand on the 4DN tile.
  await page.goto(`${BASE}/`)
  await page.waitForSelector('.picker-stores .store-tile[data-store="4dn"]', { timeout: 60000 })
  await w.quiet()
  await sleep(1000)
  await page.hover('.picker-stores .store-tile[data-store="4dn"]')
  await sleep(800)
  await w.shot('landing', {}, { keepPointer: true })

  // The store, the set's accession, *open with its tracks*.
  await page.click('.picker-stores .store-tile[data-store="4dn"]')
  const search = page.locator('.store-drawer .portal-search')
  await search.waitFor({ timeout: 120000 })
  await search.fill(SET)
  await page.waitForFunction(
    (set) => [...document.querySelectorAll('.store-drawer .portal-group-key')].some((n) => n.textContent?.includes(set)),
    SET,
    { timeout: 120000 },
  )
  await sleep(1000)
  await page.locator('.store-drawer .portal-group', { hasText: SET }).locator('.portal-session').first().click()
  await page.waitForSelector('.content .tviewport .tbody .tr', { timeout: 180000 })
  await w.quiet(120000)
  await sleep(2500)
  console.log('  file card:', (await page.locator('.panel-general').first().innerText()).replace(/\s+/g, ' ').slice(0, 300))
  await w.shot('chromosomes')

  // 250 kb, chr15.
  await page.selectOption('select.res-pick', { label: '250 kb' })
  await sleep(1500)
  await page.click('.content .tviewport .tr .td[title="chr15"]')
  await drawn()
  // 30–60 Mb, 5 kb, then the domains.
  await go('chr15:30,000,001-60,000,000')
  await page.selectOption('select.res-pick', { label: '5 kb' })
  await sleep(2500)
  await w.quiet(180000)
  await go('chr15:38,100,001-50,025,000')
  await drawn()
  console.log('  heading:', (await page.locator('.content').first().innerText()).replace(/\s+/g, ' ').slice(0, 160))
  await w.shot('chr15-5kb')

  // ENCODE's CTCF, added by its address from the header's +.
  await page.click('button[title^="Add a file to this tab"]')
  const url = page.locator('.modal-panel input[type="url"], .modal-panel input.input-url, .modal-panel input[placeholder^="https"]').first()
  await url.waitFor({ timeout: 20000 })
  await url.fill(CTCF)
  await page.locator('.modal-panel button', { hasText: /^open$/ }).first().click()
  await page.waitForSelector('.modal-backdrop', { state: 'detached', timeout: 20000 }).catch(() => {})
  await w.tracksRead(4)
  await w.quiet(120000)

  // Diamond insulation on chr15 alone, with its defaults.
  await w.fold('Show the Analysis panel')
  await page
    .locator('.analysis-row', { has: page.locator('.analysis-row-title', { hasText: /^Diamond insulation$/ }) })
    .first()
    .click()
  await page.click('.analysis-drawer button[title="Untick every sequence"]')
  await page
    .locator('.analysis-drawer .param-sequences label.param-check', { has: page.locator('span', { hasText: /^chr15$/ }) })
    .first()
    .click()
  await sleep(500)
  await page.click('.analysis-drawer .analysis-run > button')
  // The row's chip reads a percentage while it runs and `done in …` after.
  const chip = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('.analysis-row')]
          .find((row) => row.querySelector('.analysis-row-title')?.textContent === 'Diamond insulation')
          ?.querySelector('.analysis-chip')?.textContent ?? '',
    )
  const until = Date.now() + 1200000
  let said = ''
  for (;;) {
    const now = await chip()
    if (now !== said) console.log(`  insulation: ${now}`)
    said = now
    if (/^done/.test(now)) break
    if (/^(failed|cancelled)/.test(now)) throw new Error(`insulation ${now}`)
    if (Date.now() > until) throw new Error(`insulation still ${now} after twenty minutes`)
    await sleep(2000)
  }
  await sleep(1500)
  await page.keyboard.press('Escape')
  await sleep(1500)
  await w.tracksRead(6)
  await w.quiet(120000)
  await sleep(2500)
  for (const row of await page.$$eval('.annotation-card .ann-row', (rows) =>
    rows.map((r) => `${r.querySelector('input.ann-name')?.value} · ${r.textContent?.replace(/\s+/g, ' ').trim().slice(0, 70)}`),
  ))
    console.log('  row:', row)
  await w.shot('insulation')
  await w.fold('Fold the Analysis panel')
  await sleep(2500)
  await w.shot('insulation-analysis-folded')
  console.log('  errors:', w.errors.slice(0, 6))
  await browser.close()
})()
