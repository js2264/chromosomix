/**
 * The list of steps back beside the header's back button (§5.5), end to end.
 *
 * On the yeast demo: five steps — a window typed, a zoom, the next sequence, a
 * block of two windows, the O/E — then the chevron pressed, its list shot with
 * every row named, a row three steps back pressed and the map there; a reload,
 * the list still there; Back, the list one shorter; and the dark theme. Every
 * step prints the list's rows and the hash, so a list that lost its place is a
 * line here as well as a picture.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-history-list.mjs [out-dir]
 */

import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page, shot, close, base, browser } = await gallery(OUT, { width: 1600, height: 1000 })

const settled = async () => {
  await sleep(1200)
  await page.waitForFunction(
    () =>
      document.querySelector('.heatmap-canvas') !== null &&
      [...document.querySelectorAll('.panel-overlay')].every((n) => n.classList.contains('hidden')),
    null,
    { timeout: 180000 },
  )
  await sleep(800)
}
const where = () => page.evaluate(() => decodeURIComponent(location.hash).replace(/https?:\/\/[^/]+\/demo\//g, ''))
const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.context-menu .crumb-menu-item')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()),
  )
const openList = async () => {
  await page.locator('.head-history-list').click()
  await page.waitForSelector('.context-menu', { timeout: 5000 })
  await sleep(300)
}
const typeLocus = async (text) => {
  const box = page.locator('.input-region').first()
  await box.click()
  await box.fill(text)
  await box.press('Enter')
  await settled()
}

try {
  await page.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await settled()
  console.log('chevron greyed on arrival:', await page.locator('.head-history-list').isDisabled())

  await typeLocus('IV:1,100,001-1,300,000')
  await page.locator('button[title*="3×" i]').filter({ hasText: '3×' }).nth(1).click().catch(() => {})
  await settled()
  await page.keyboard.press('>')
  await settled()
  await typeLocus('IV:1,000,001-1,200,000 × V:1-200,000')
  await page.locator('button', { hasText: 'O/E' }).first().click()
  await settled()
  console.log('on screen:', await where())

  await openList()
  console.log('the list:', JSON.stringify(await rows(), null, 1))
  await shot('hl01-list')

  await page.locator('.context-menu .crumb-menu-item').nth(2).click()
  await settled()
  console.log('three steps back:', await where())
  await shot('hl02-three-back')

  await page.reload()
  await page.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await settled()
  await openList()
  console.log('after a reload:', JSON.stringify(await rows()))
  await shot('hl03-after-reload')
  await page.keyboard.press('Escape')

  await page.goBack()
  await settled()
  await openList()
  console.log('after Back:', JSON.stringify(await rows()))
  await page.keyboard.press('Escape')

  // The dark theme, for the menu's look there.
  const dark = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await dark.addInitScript(() => localStorage.setItem('chromosomix:theme', 'dark'))
  const night = await dark.newPage()
  await night.goto(`${base}/?config=${base}/demo/yeast/Yeast_microC.chromosomix.json`)
  await night.waitForFunction(() => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null, null, { timeout: 180000 })
  await sleep(3000)
  for (const text of ['IV:1,100,001-1,300,000', 'V']) {
    const box = night.locator('.input-region').first()
    await box.fill(text)
    await box.press('Enter')
    await sleep(3000)
  }
  await night.locator('.head-history-list').click()
  await sleep(500)
  await night.screenshot({ path: `${OUT}/hl04-list-dark.png`, clip: { x: 0, y: 0, width: 900, height: 260 } })
  console.log('wrote hl04-list-dark.png')
  await dark.close()
} finally {
  await close()
}
