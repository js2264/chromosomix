/**
 * The picture of Getting started → The guided tutorial (`start/tutorial.md`):
 *
 * - **step-resolution** the tutorial played from the landing page's *play the
 *   tutorial* — its first steps answered as a reader answers them: *next* on
 *   the welcome, the header's stores button, the 4DN tile, the accession typed
 *   into the store's search, *open with its tracks*, *next* on the General
 *   panel — and shot on the step after: the window greyed, the resolution
 *   control lit through the grey, and the card beside it asking for 250 kb.
 *
 * The full walk, every step shot, is `scripts/ui-tutorial.mjs`; this stops at
 * the one step the page shows. Network: the 4DN store from the deployed site
 * and the map from 4DN's bucket, so `HTTPS_PROXY` is handed to Chromium.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node documentation/scripts/screens/start-tutorial.cjs [out-dir]
 */

const { BASE, sleep, launch, newWindow } = require('./start-files-lib.cjs')

const OUT = process.argv[2] ?? 'screens/start-tutorial'
const SET = '4DNESC23ZYOF'

;(async () => {
  const browser = await launch()
  const w = await newWindow(browser, OUT)
  const { page } = w
  /** The step on screen, or `null` with no tour. */
  const card = () =>
    page.evaluate(() => {
      const node = document.querySelector('.tour-card')
      if (node === null || !node.isConnected) return null
      return {
        id: node.dataset.step ?? '',
        count: node.querySelector('.tour-count')?.textContent ?? '',
        title: node.querySelector('.tour-title')?.textContent ?? '',
      }
    })
  /** The ring and the card still: two readings 200 ms apart that agree. */
  const still = async () => {
    const boxes = () =>
      page.evaluate(() =>
        ['.tour-ring', '.tour-card']
          .map((s) => {
            const r = document.querySelector(s)?.getBoundingClientRect()
            return r === undefined ? '-' : [r.left, r.top, r.width, r.height].map(Math.round).join(',')
          })
          .join(' '),
      )
    let last = await boxes()
    for (let k = 0; k < 20; k++) {
      await sleep(200)
      const now = await boxes()
      if (now === last) return
      last = now
    }
  }
  /** What a reader does at each step before the one shot. */
  const ACT = {
    welcome: () => page.click('.tour-card .tour-next'),
    stores: () => page.click('.head-files button[aria-label="stores"]'),
    store: () => page.click('.store-drawer .store-tile[data-store="4dn"]'),
    search: () => page.locator('.store-drawer .portal-search').fill(SET),
    'open-set': () => page.click('.store-drawer .portal-session'),
    'look-general': () => page.click('.tour-card .tour-next'),
    'refine-off': () => page.click('.crumb-res .res-refine input'),
  }

  await page.goto(`${BASE}/`)
  await page.waitForSelector('.picker-tutorial-play', { timeout: 60000 })
  await page.click('.picker-tutorial-play')
  await page.waitForSelector('.tour-card[data-step]', { timeout: 60000 })
  for (let guard = 0; guard < 30; guard++) {
    await sleep(500)
    await w.quiet(120000)
    await still()
    const now = await card()
    if (now === null) throw new Error('the tutorial ended before the resolution step')
    console.log(`  ${now.count.padEnd(14)} ${now.id.padEnd(16)} ${now.title}`)
    if (now.id === 'resolution-250') break
    const act = ACT[now.id]
    if (act === undefined) throw new Error(`no answer for the step ${now.id}`)
    await act()
    // Wait for the card to leave the step.
    const until = Date.now() + 180000
    while (Date.now() < until && (await card())?.id === now.id) await sleep(250)
  }
  // The map's table under the grey arrives from 4DN's bucket; then the card settles.
  await w.quiet(120000)
  await sleep(2000)
  await still()
  await page.screenshot({ path: `${OUT}/step-resolution.png` })
  console.log('shot step-resolution')
  await browser.close()
})()
